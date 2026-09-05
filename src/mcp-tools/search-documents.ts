// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** MCP registration for `search_documents` — Hybrid keyword+semantic search, optionally packed with bodies. */

import { z } from "zod";

import { McpSearchDocumentsResponseSchema } from "../contract.js";
import { textError } from "../mcp-error-result.js";
import { leanOutputSchema } from "../mcp-lean-schema.js";
import { STATUS_FILTER_FIELD } from "../mcp-tool-fields.js";
import { coerceBool, coerceInt } from "../mcp-tool-input.js";
import { logUnexpectedMcpThrow, structuredOk } from "../mcp-tool-result.js";
import { packSearchHitsCore } from "../pack-core.js";
import {
  clampPackKnobs,
  DEFAULT_BUDGET_BYTES,
  DEFAULT_MAX_DOCUMENTS,
  MAX_BUDGET_BYTES,
  MAX_MAX_DOCUMENTS,
} from "../pack.js";
import { MAX_LIMIT, MCP_DEFAULT_LIMIT, parseMcpListArgs } from "../pagination.js";
import { searchDocumentsCore } from "../search-core.js";
import type { McpToolContext, ToolRegistrar } from "../mcp-tool-context.js";

/** Register `search_documents` on the request's gated server. */
export function registerSearchDocumentsTool(
  server: ToolRegistrar,
  { env }: McpToolContext,
): void {
  server.registerTool(
    "search_documents",
    {
      // Lead with the use-case distinction from list_documents — the names
      // are similar enough that a cold agent could pick either by default.
      // Score/matched_field/snippet semantics live in the output schema; the
      // query-syntax + prefix-vs-stemming guidance stays here (behavioral —
      // it changes what the agent TYPES, not what it reads back).
      description:
        "Find documents by content. HYBRID by default — fuses keyword (BM25) with " +
        "SEMANTIC (embedding) search, matching exact terms AND concepts. USE THIS when " +
        "you know roughly WHAT a document says. Tags are NOT indexed — scope by the " +
        "`tags` filter. " +
        "QUERY SYNTAX (keyword leg): space-separated terms 2+ chars, implicit AND, " +
        "trailing `*` for prefix; diacritics folded; light-English stemming. " +
        "PREFIX-VS-STEMMING GOTCHA: prefixes match the STEMMED form — `engin*` " +
        "matches \"engineering\" but `enginee*` does not; keep prefixes short. " +
        "Phrases, OR/NOT/NEAR, and column:term " +
        "filters are NOT supported (silently stripped). " +
        "FILTERS `tags`/`slug`/`status` compose with the query and apply to both legs. " +
        "Revoked docs are never returned. In default hybrid search, deprecated docs " +
        "receive a modest score penalty but remain discoverable; they carry " +
        "status/superseded_by — prefer the replacement, or pass status:\"active\" " +
        "to exclude. An explicit status filter disables the penalty. " +
        "Results cap at `limit`; NO cursor — refine the query instead of paging. " +
        "CONTEXT PACK (`include_bodies:true`) turns the search into a BUDGETED " +
        "BULK READ — \"bring me up to speed on X\" in ONE call: packed " +
        "best-first, each body included WHOLE (markdown) until budget_bytes/" +
        "max_documents binds; NEVER truncated — what doesn't fit is reported in " +
        "`omitted[]` and the walk continues so smaller docs still fill the room. " +
        "ERRORS are code-prefixed (\"<code>: <message>\"): bad_query only if NO leg can " +
        "run; bad_slug / bad_status on a malformed filter.",
      inputSchema: {
        q: z
          .string()
          .describe(
            "The search query. The keyword leg is word-based (space-separated terms, " +
            "2+ chars, AND-joined, trailing `*` for prefix; quotes and Boolean " +
            "operators are dropped). The semantic leg embeds your RAW query, so " +
            "natural-language phrasing helps recall.",
          ),
        mode: z
          .enum(["hybrid", "keyword", "semantic"])
          .optional()
          .describe(
            "Optional. \"hybrid\" (default) fuses keyword + semantic for best " +
            "recall; \"keyword\" is FTS-only (deterministic); \"semantic\" is " +
            "vector-only (ignores query syntax). Hybrid/semantic fall back to " +
            "keyword if embedding is temporarily unavailable.",
          ),
        limit: coerceInt(
          z.number().int().min(1).max(MAX_LIMIT).optional(),
          `Optional. Cap on result count, 1..${MAX_LIMIT} (default ${MCP_DEFAULT_LIMIT}). ` +
            "There's no cursor for search — refine the query if you want " +
            "results beyond the top N.",
        ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Optional. AND-style tag filter, same semantics as list_documents: " +
            "results must MATCH the query AND carry every tag in this array.",
          ),
        slug: z
          .string()
          .optional()
          .describe(
            "Optional. Exact-slug filter, scoping a search to a single document " +
            "(mostly a sanity check that it would surface for the query).",
          ),
        status: STATUS_FILTER_FIELD,
        include_bodies: coerceBool(
          z.boolean().optional(),
          "Optional, default false. When true the response becomes a CONTEXT " +
            "PACK: full bodies (markdown) included best-first under " +
            "`budget_bytes`/`max_documents`, everything that didn't fit reported " +
            "in `omitted[]` (never truncated).",
        ),
        budget_bytes: coerceInt(
          z.number().int().optional(),
          `Optional (with include_bodies). Byte budget for included bodies, ` +
            `counted on STORED document sizes (~4 chars/token). Default ` +
            `${DEFAULT_BUDGET_BYTES} (~16K tokens), max ${MAX_BUDGET_BYTES}. ` +
            "Out-of-range values are clamped, not rejected.",
        ),
        max_documents: coerceInt(
          z.number().int().optional(),
          `Optional (with include_bodies). Cap on included bodies. Default ` +
            `${DEFAULT_MAX_DOCUMENTS}, max ${MAX_MAX_DOCUMENTS}. Clamped, not rejected.`,
        ),
        include_deprecated: coerceBool(
          z.boolean().optional(),
          "Optional (with include_bodies), default false. Deprecated docs are " +
            "normally omitted from the pack fill (reported in `omitted[]` with " +
            "their `superseded_by`); set true to include their bodies anyway.",
        ),
      },
      outputSchema: leanOutputSchema(McpSearchDocumentsResponseSchema),
      annotations: {
        title: "Search Documents",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ q, mode, limit, tags, slug, status, include_bodies, budget_bytes, max_documents, include_deprecated }) => {
      try {
        // `cursor` is intentionally not in the input schema — search has
        // no cursor model. The filter parser still runs to validate
        // tags/slug/limit; we ignore its `cursor` field.
        const parsed = parseMcpListArgs({ limit, tags, slug, status });
        if (!parsed.ok) {
          return textError(parsed.code, parsed.message);
        }
        // Pass the RAW query: core tokenizes internally for the keyword leg and
        // embeds the un-tokenized query for the semantic leg. `mode` undefined →
        // hybrid (the core default).
        const result = await searchDocumentsCore(env, q, parsed, mode);
        if (!result.ok) {
          // bad_query — no leg could run (keyword mode w/ no usable terms, or
          // unusable query + embedding unavailable).
          return textError(
            "bad_query",
            "no usable search terms (keyword search needs at least one 2+ " +
            "character word; operators and punctuation are dropped) — re-issue with " +
            "a plain word or two from the topic",
          );
        }
        // include_bodies → the AUTOMATIC context pack (context-packs-design
        // §3.1): budgeted best-first body fill over the ranked hits, with
        // omit-and-report. Same searchDocumentsCore hits either way — the pack
        // is pure amplification of this search, not a different search.
        if (include_bodies) {
          const knobs = clampPackKnobs({ budget_bytes, max_documents });
          const packed = await packSearchHitsCore(env, q, result.documents, {
            budgetBytes: knobs.budgetBytes,
            maxDocuments: knobs.maxDocuments,
            includeDeprecated: include_deprecated ?? false,
          });
          return structuredOk(packed);
        }
        return structuredOk({ documents: result.documents });
      } catch (err) {
        logUnexpectedMcpThrow("search_documents", err);
        return textError("internal", "internal error searching documents");
      }
    },
  );
}
