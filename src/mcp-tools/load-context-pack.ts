// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** MCP registration for `load_context_pack` — Document/manifest-rooted budgeted bulk read (context pack). */

import { z } from "zod";

import { PackResponseSchema } from "../contract.js";
import { textError } from "../mcp-error-result.js";
import { leanOutputSchema } from "../mcp-lean-schema.js";
import { coerceBool, coerceInt } from "../mcp-tool-input.js";
import { logUnexpectedMcpThrow, structuredOk } from "../mcp-tool-result.js";
import { loadContextPackCore } from "../pack-core.js";
import {
  clampPackKnobs,
  DEFAULT_BUDGET_BYTES,
  DEFAULT_MAX_DOCUMENTS,
  MAX_BUDGET_BYTES,
  MAX_MAX_DOCUMENTS,
} from "../pack.js";
import type { McpToolContext, ToolRegistrar } from "../mcp-tool-context.js";

/** Register `load_context_pack` on the request's gated server. */
export function registerLoadContextPackTool(
  server: ToolRegistrar,
  { env, origin }: McpToolContext,
): void {
  server.registerTool(
    "load_context_pack",
    {
      // The curated/ad-hoc pack — the browse-axis sibling of search's
      // include_bodies (which is the query-rooted automatic pack). Lead with
      // the one-call use case and the two member-derivation modes; the budget
      // contract mirrors search's and is restated compactly (a cold agent may
      // see only this description).
      description:
        "Load a CONTEXT PACK rooted at a document: the root's own prose PLUS the " +
        "full bodies (markdown) of the documents it references, budget-filled in one " +
        "call. USE THIS when told to \"load the context pack <name>\" or to get up " +
        "to speed from a known starting doc. (With no starting doc, use " +
        "search_documents include_bodies instead.) " +
        "MEMBERS come from the root, two ways — a manifest, when present, always " +
        "wins: (1) MANIFEST — a fenced ```pack block in the root's source lists members, " +
        "one slug/public_id per line. (2) LINKS — no manifest: the root's " +
        "outbound /d/ and /s/ links in order of appearance, so any hub page is " +
        "instantly a pack. " +
        "BUDGET (same contract as search_documents include_bodies): bodies included " +
        "WHOLE, best-first, until budget_bytes/max_documents binds; NEVER truncated " +
        "— what doesn't fit is reported in `omitted[]` so you can fetch it " +
        "deliberately. The root's own prose rides free. Deprecated " +
        "members are excluded from the fill unless include_deprecated:true; " +
        "follow_redirects:true packs a deprecated member's REPLACEMENT instead (the " +
        "original stays in omitted[]; single-hop). " +
        "Authoring a curated pack: the publishing guide §load_context_pack. " +
        "ERRORS are code-prefixed (\"<code>: <message>\"): not_found (no live doc " +
        "matches `from`); slug_retired (the root slug was used and retired — slugs are " +
        "never reused).",
      inputSchema: {
        from: z
          .string()
          .describe(
            "The root document: its slug (preferred — curated packs use " +
              "`pack-<name>`) or its 22-char public_id. A string that could be " +
              "either resolves as a live slug first, then a public_id.",
          ),
        budget_bytes: coerceInt(
          z.number().int().optional(),
          `Optional. Byte budget for member bodies, counted on STORED document ` +
            `sizes (~4 chars/token). Default ${DEFAULT_BUDGET_BYTES} (~16K tokens), ` +
            `max ${MAX_BUDGET_BYTES}. Clamped, not rejected. The root's own prose ` +
            "is not counted.",
        ),
        max_documents: coerceInt(
          z.number().int().optional(),
          `Optional. Cap on included member bodies. Default ${DEFAULT_MAX_DOCUMENTS}, ` +
            `max ${MAX_MAX_DOCUMENTS}. Clamped, not rejected.`,
        ),
        include_deprecated: coerceBool(
          z.boolean().optional(),
          "Optional, default false. Deprecated members are normally omitted from " +
            "the fill (reported with their `superseded_by`); set true to include " +
            "their bodies anyway.",
        ),
        follow_redirects: coerceBool(
          z.boolean().optional(),
          "Optional, default false. When a deprecated member names a replacement " +
            "(`superseded_by`), include the REPLACEMENT's body in its place. Never " +
            "silent — the original still appears in `omitted[]`. Single-hop.",
        ),
      },
      outputSchema: leanOutputSchema(PackResponseSchema),
      annotations: {
        title: "Load Context Pack",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ from, budget_bytes, max_documents, include_deprecated, follow_redirects }) => {
      try {
        const knobs = clampPackKnobs({ budget_bytes, max_documents });
        const result = await loadContextPackCore(
          env,
          from,
          {
            budgetBytes: knobs.budgetBytes,
            maxDocuments: knobs.maxDocuments,
            includeDeprecated: include_deprecated ?? false,
            followRedirects: follow_redirects ?? false,
          },
          // Same-host absolute links count as members; cross-site ones don't.
          new URL(origin).host,
        );
        if (!result.ok) {
          // `root_retired` is core's internal name for the condition every other
          // MCP surface reports as `slug_retired` — one token per condition, so
          // an agent's branch works whichever tool hit it.
          return textError(
            result.code === "root_retired" ? "slug_retired" : "not_found",
            result.code === "root_retired"
              ? `the slug "${result.slug}" is retired (its document was revoked, or the ` +
                  "slug was renamed/released) and will not resolve again. Find the " +
                  "current document via search_documents or list_documents."
              : "no live document matches `from` (pass a live slug or a 22-char public_id)",
          );
        }
        const { ok: _ok, ...envelope } = result;
        return structuredOk(envelope);
      } catch (err) {
        logUnexpectedMcpThrow("load_context_pack", err);
        return textError("internal", "internal error loading context pack");
      }
    },
  );
}
