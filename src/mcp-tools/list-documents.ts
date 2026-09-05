// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** MCP registration for `list_documents` — Cursor-paginated fleet listing with the classification filters. */

import { z } from "zod";

import { ListDocumentsResponseSchema } from "../contract.js";
import { listDocumentsCore } from "../document-query.js";
import { textError } from "../mcp-error-result.js";
import { leanOutputSchema } from "../mcp-lean-schema.js";
import { PUBLICATION_FILTER_FIELD, STATUS_FILTER_FIELD, VISIBILITY_FILTER_FIELD } from "../mcp-tool-fields.js";
import { coerceInt } from "../mcp-tool-input.js";
import { logUnexpectedMcpThrow, structuredOk } from "../mcp-tool-result.js";
import { LIST_ORDERS, MAX_LIMIT, MCP_DEFAULT_LIMIT, parseMcpListArgs } from "../pagination.js";
import type { McpToolContext, ToolRegistrar } from "../mcp-tool-context.js";

/** Register `list_documents` on the request's gated server. */
export function registerListDocumentsTool(
  server: ToolRegistrar,
  { env }: McpToolContext,
): void {
  server.registerTool(
    "list_documents",
    {
      description:
        "List every document this operator's fleet has published, newest first — " +
        "including revoked rows (revoked_at set). For CONTENT discovery use " +
        "search_documents instead — this is for browsing newest-first or narrow " +
        "filters. " +
        "SLUG LOOKUP: pass `slug` for 0 or 1 rows (`documents[0]`); to READ or WRITE a " +
        "doc you know by name, those tools take the slug directly. " +
        "FILTERS compose with each other and the cursor: `tags` (AND), " +
        "`slug`, `status`, `visibility`, `publication`. " +
        "`visibility:\"public\", " +
        "publication:\"pending\"` is the REVIEW QUEUE — public docs whose readers " +
        "are still seeing older bytes because the newest version hasn't been " +
        "promoted. Filtering never grants: " +
        "publishing and promoting stay operator-only. " +
        "CHANGE FEED: `order:\"updated\"` plus `updated_since` answer \"what moved since " +
        "I last looked\" (a change is a new version, a classification edit, or a " +
        "revoke). " +
        "Each row carries `visibility`: a \"private\" doc is invisible to " +
        "logged-out humans (operator-only to change). " +
        "CURSOR-PAGINATED: pass `next_cursor` back unchanged until it is null.",
      inputSchema: {
        limit: coerceInt(
          z.number().int().min(1).max(MAX_LIMIT).optional(),
          `Optional. Page size, 1..${MAX_LIMIT} (default ${MCP_DEFAULT_LIMIT}). Smaller pages keep ` +
            "response context cheap when you only need the top of the list.",
        ),
        cursor: z
          .string()
          .optional()
          .describe(
            "Optional. Opaque cursor from a prior response's `next_cursor`; omit on " +
            "the first call, pass back verbatim. It encodes the position AND the " +
            "`order` it was minted under — keep passing the same `order` (a mismatch " +
            "is a hard `bad_cursor`).",
          ),
        order: z
          .enum(LIST_ORDERS)
          .optional()
          .describe(
            "Optional, default \"created\" (newest-published first). \"updated\" walks " +
            "most-recently-CHANGED first — a new version, a classification edit " +
            "(tags/slug/visibility/status), or a revoke. Compare each " +
            "row's `updated_at` against `current_version_at` to tell a content write " +
            "from a reclassification.",
          ),
        updated_since: z
          .string()
          .optional()
          .describe(
            "Optional. Only documents changed at or after this ISO-8601 instant " +
            "(normalized server-side). INCLUSIVE, so a resuming consumer re-sees " +
            "the boundary row rather than risking a skip. Revoked docs DO appear " +
            "(revoke is a change) — check `revoked_at`.",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Optional. Tag filter, AND semantics — only documents whose stored tags " +
            "include EVERY tag in this array. Each tag is silently sanitized to " +
            "[A-Za-z0-9_-]; a filter that sanitizes to empty is treated as no filter.",
          ),
        slug: z
          .string()
          .optional()
          .describe(
            "Optional. Exact-match filter on the document slug — the slug-lookup " +
            "path (0 or 1 documents; the row is `documents[0]`). Validated with the " +
            "same rule as the write path; invalid input → `bad_slug`. Matches only " +
            "the LIVE slug: a revoked or renamed doc's slug is retired and returns 0 " +
            "rows.",
          ),
        status: STATUS_FILTER_FIELD,
        visibility: VISIBILITY_FILTER_FIELD,
        publication: PUBLICATION_FILTER_FIELD,
      },
      outputSchema: leanOutputSchema(ListDocumentsResponseSchema),
      annotations: {
        title: "List Documents",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, cursor, order, updated_since, tags, slug, status, visibility, publication }) => {
      try {
        const parsed = parseMcpListArgs({
          limit,
          cursor,
          order,
          updated_since,
          tags,
          slug,
          status,
          visibility,
          publication,
        });
        if (!parsed.ok) {
          return textError(parsed.code, parsed.message);
        }
        const result = await listDocumentsCore(env, parsed);
        return structuredOk(result);
      } catch (err) {
        logUnexpectedMcpThrow("list_documents", err);
        return textError("internal", "internal error listing documents");
      }
    },
  );
}
