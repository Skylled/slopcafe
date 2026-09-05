// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** MCP registration for `edit_document` — Server-side find/replace against retained source (MCP-only). */

import { z } from "zod";

import { McpEditResponseSchema } from "../contract.js";
import { editDocumentCore } from "../core.js";
import { DOC_VIEW_TOOL_META } from "../mcp-apps.js";
import { currentEcho, resolveWriteTarget } from "../mcp-document-target.js";
import { textError } from "../mcp-error-result.js";
import { leanOutputSchema } from "../mcp-lean-schema.js";
import {
  DESCRIPTION_FIELD_UPDATE,
  metadataInputFromArgs,
  NEW_SLUG_FIELD_UPDATE,
  PUBLIC_ID_IDENTITY_FIELD,
  SLUG_IDENTITY_FIELD,
  TAGS_FIELD_UPDATE,
  TITLE_FIELD_UPDATE,
} from "../mcp-tool-fields.js";
import { coerceBool, coerceInt } from "../mcp-tool-input.js";
import { logUnexpectedMcpThrow, structuredOk } from "../mcp-tool-result.js";
import { translateEditError } from "../mcp-write-errors.js";
import { toEditResponse } from "../wire.js";
import type { McpToolContext, ToolRegistrar } from "../mcp-tool-context.js";

/** Register `edit_document` on the request's gated server. */
export function registerEditDocumentTool(
  server: ToolRegistrar,
  { env, agentId, clientId, origin, waitUntil }: McpToolContext,
): void {
  server.registerTool(
    "edit_document",
    {
      // The small-diff alternative to update_document. Lead with the use case
      // (don't re-send the whole body) and the one rule that makes edits
      // actually land: match against the RETAINED SOURCE, not the render and
      // not your original input. The uniqueness/replace_all contract and the
      // expected_version contract come next; metadata is tail-priority.
      description:
        "Change part of an existing document by find-and-replace, WITHOUT re-sending " +
        "the whole body — prefer this over update_document for a small change to a " +
        "larger doc. Identify the doc by EITHER `public_id` OR `slug` — exactly one. " +
        "The separate `new_slug` field renames or clears the document. " +
        "MATCH AGAINST THE RETAINED SOURCE, NOT THE RENDER: `old_string` must come from " +
        "the doc's SOURCE (an old_string taken from a rendered read, or from your " +
        "original input, can fail to match). Read with representation:\"source\" first " +
        "(the publishing guide §edit_document has the sha256 shortcut that skips the " +
        "re-read). An edit keeps the doc's format: a Markdown doc stays Markdown. " +
        "UNIQUENESS: each old_string must match EXACTLY ONCE — multiple matches → " +
        "`edit_not_unique` with the count (add surrounding context, or set " +
        "replace_all:true); zero matches → `edit_no_match`, never a silent no-op. " +
        "CONCURRENCY DIFFERS FROM update_document: an explicit `expected_version` " +
        "behaves the same, but OMITTING it is NOT a clobber here — the edit is guarded " +
        "against the version whose source it matched, so a concurrent write surfaces as " +
        "`version_conflict` instead of silently reverting it. On conflict, re-read with " +
        "representation:\"source\", re-apply, retry. " +
        "Optional metadata behaves exactly as in update_document. In the response, " +
        "`replacements` is the patch-landed signal; `unchanged: true` means the edit " +
        "was a byte-identical no-op, not a failure; `visibility` echoes anonymous " +
        "readability (born private — only the operator can publish " +
        "it); `published_version` " +
        "echoes which version a PUBLIC doc RENDERS — below `version` means the patch " +
        "landed on bytes readers are not seeing yet, pending an operator promote, so " +
        "report it as pending instead of calling the page updated. " +
        "ERRORS are code-prefixed (\"<code>: <message>\"); also `source_unavailable` " +
        "(a doc predating source retention — recover with read_document format:\"html\" " +
        "→ update_document format:\"html\") and `slug_locked` (only " +
        "the operator may change a PUBLIC doc's slug — re-send without `new_slug`). " +
        "MCP-ONLY: no HTTP PATCH exists — over HTTP, read, edit locally, PUT with " +
        "If-Match. " +
        "On an MCP Apps host the result renders inline for the user; no " +
        "view_document call needed.",
      // See update_document: strict parsing makes stale `document_slug`
      // payloads fail closed instead of being reinterpreted under 3.0.
      inputSchema: z.strictObject({
        public_id: PUBLIC_ID_IDENTITY_FIELD,
        slug: SLUG_IDENTITY_FIELD,
        edits: z
          .array(
            z.object({
              old_string: z
                .string()
                .describe(
                  "Exact text to find in the RETAINED SOURCE — what read_document with " +
                  "representation:\"source\" returns, NOT the rendered output. Must " +
                  "match exactly once unless replace_all is set.",
                ),
              new_string: z
                .string()
                .describe(
                  "Replacement text, inserted verbatim into the source and authored in " +
                  "the doc's SOURCE LANGUAGE. Must differ from old_string: in a Markdown " +
                  "doc write Markdown (raw HTML pasted here is re-parsed, not emitted " +
                  "as-is); in an HTML doc, HTML.",
                ),
            }),
          )
          .min(1)
          .describe(
            "One or more find-and-replace operations, applied in order (each runs " +
            "against the result of the previous).",
          ),
        expected_version: coerceInt(
          z.number().int().min(1).nullable().optional(),
          "The version number you believe is current. Unlike update_document, omitting " +
            "it is NOT a clobber: the edit is guarded against the version whose source " +
            "it matched, so a write that landed in between fails with " +
            "`version_conflict`. Pass an explicit number to guard a version you chose.",
        ),
        replace_all: coerceBool(
          z.boolean().optional(),
          "When true, every occurrence of each `old_string` is replaced (and a " +
            "multi-match old_string is allowed). Default false: each old_string must " +
            "match exactly once.",
        ),
        title: TITLE_FIELD_UPDATE,
        description: DESCRIPTION_FIELD_UPDATE,
        tags: TAGS_FIELD_UPDATE,
        new_slug: NEW_SLUG_FIELD_UPDATE,
      }),
      outputSchema: leanOutputSchema(McpEditResponseSchema),
      annotations: {
        title: "Edit Document",
        readOnlyHint: false,
        destructiveHint: true, // patches live content in place
        // NOT idempotent: re-applying the same { old_string, new_string }
        // finds old_string already replaced (edit_no_match), or, with
        // replace_all, replaces it again wherever it now recurs — repeating
        // the call is not a no-op.
        idempotentHint: false,
        openWorldHint: false,
      },
      // Post-publish inline preview (MCP Apps) — see DOC_VIEW_TOOL_META.
      _meta: DOC_VIEW_TOOL_META,
    },
    async ({ public_id, slug, edits, expected_version, replace_all, title, description, tags, new_slug }) => {
      try {
        const target = await resolveWriteTarget(env, public_id, slug);
        if (!target.ok) return target.error;
        const result = await editDocumentCore(
          env,
          target.publicId,
          edits,
          expected_version ?? null,
          { kind: "agent", agentId, clientId },
          origin,
          replace_all ?? false,
          metadataInputFromArgs(title, description, tags, new_slug),
          waitUntil, // re-embed after the delegated update's batch
        );
        if (!result.ok) {
          return textError(result.code, translateEditError(result));
        }
        const { visibility, published_version } = await currentEcho(env, result.public_id);
        return structuredOk({
          ...toEditResponse(result),
          visibility,
          published_version,
        });
      } catch (err) {
        logUnexpectedMcpThrow("edit_document", err);
        return textError("internal", "internal error editing document");
      }
    },
  );
}
