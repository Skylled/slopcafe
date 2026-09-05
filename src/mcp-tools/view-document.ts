// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** MCP registration for `view_document` — The MCP Apps presentation read (SEP-1865) — show to the human. */

import { z } from "zod";

import { McpViewDocumentResponseSchema } from "../contract.js";
import {
  findSlugTombstoneCore,
  readDocumentCore,
  resolvePublicIdBySlug,
  resolveRedirectTarget,
} from "../core.js";
import { DOC_VIEW_TOOL_META } from "../mcp-apps.js";
import { currentEcho } from "../mcp-document-target.js";
import { textError } from "../mcp-error-result.js";
import { leanOutputSchema } from "../mcp-lean-schema.js";
import { coerceInt } from "../mcp-tool-input.js";
import { logUnexpectedMcpThrow, structuredOkAppSummary } from "../mcp-tool-result.js";
import { DOC_NOT_FOUND_TEXT, slugReasonText } from "../mcp-write-errors.js";
import { validateSlugInput } from "../metadata.js";
import type { McpToolContext, ToolRegistrar } from "../mcp-tool-context.js";

/** Register `view_document` on the request's gated server. */
export function registerViewDocumentTool(
  server: ToolRegistrar,
  { env, origin }: McpToolContext,
): void {
  server.registerTool(
    "view_document",
    {
      // The MCP Apps presentation read (SEP-1865). Lead with the read/view
      // split — the names are close enough that a cold agent could pick either
      // — then the degradation story, then the two human-facing caveats
      // (visibility, publication) this surface exists to get right. The
      // `_meta` below (NOT the description) is what makes an Apps host render
      // it inline; the envelope is ordinary structured output either way.
      description:
        "SHOW a document to the human as an inline interactive view in the chat. On an " +
        "MCP Apps host it renders in an embedded viewer; elsewhere it degrades to a " +
        "metadata result. " +
        "USE THIS to PRESENT a document to the user; read_document is for INGESTING " +
        "content as context — don't view when you mean read. The result's TEXT block " +
        "carries METADATA ONLY — the sanitized HTML rides the structured result " +
        "for the viewer, deliberately out of your context; to read it, call " +
        "read_document. " +
        "Identify the document by EITHER `public_id` OR `slug` — exactly one. " +
        "VISIBILITY: the in-app view is authenticated through this connector, so a " +
        "PRIVATE document renders fine for the user HERE while its URL still 404s for " +
        "them logged-out — check the echoed `visibility` before telling them to open " +
        "the link. PUBLICATION: `published_version` matches read_document's semantics — " +
        "the view can differ from what the live /d/<id> page shows. " +
        "ERRORS are code-prefixed (\"<code>: <message>\"): not_found; " +
        "version_not_found; slug_retired (incl. a retired slug that redirects — the " +
        "target's public_id is named in the message; re-call with it, the hop is never " +
        "silent); invalid_slug; bad_request (both or neither of public_id/slug).",
      inputSchema: {
        public_id: z
          .string()
          .optional()
          .describe(
            "22-char public_id of the document to show. Pass EITHER this or `slug` " +
              "(exactly one).",
          ),
        slug: z
          .string()
          .optional()
          .describe(
            "The document's slug. Pass EITHER this or `public_id` (exactly one). A " +
              "retired slug errors slug_retired (if it redirects, the message names " +
              "the target public_id); a never-claimed one is not_found.",
          ),
        version: coerceInt(
          z.number().int().positive().optional(),
          "Optional. Show a SPECIFIC historical version (1-based) instead of the " +
            "current one. A version that doesn't exist → `version_not_found`.",
        ),
      },
      outputSchema: leanOutputSchema(McpViewDocumentResponseSchema),
      annotations: {
        title: "View Document",
        readOnlyHint: true,
        openWorldHint: false,
      },
      // The tool→template link, both spellings — see DOC_VIEW_TOOL_META.
      _meta: DOC_VIEW_TOOL_META,
    },
    async ({ public_id, slug, version }) => {
      try {
        // Identity resolution mirrors read_document (two params, not one
        // polymorphic id — PUBLIC_ID_RE and the slug charset overlap on
        // 22-char all-lowercase strings; JSON Schema can't express the XOR).
        if (public_id !== undefined && slug !== undefined) {
          return textError("bad_request", "pass exactly one of `public_id` or `slug`, not both");
        }
        let resolvedId: string;
        if (slug !== undefined) {
          const v = validateSlugInput(slug);
          if (!v.ok) return textError("invalid_slug", slugReasonText(v.reason));
          const bySlug = await resolvePublicIdBySlug(env, v.slug);
          if (bySlug === null) {
            const tomb = await findSlugTombstoneCore(env, v.slug);
            if (!tomb) {
              return textError(
                "not_found",
                "no document has ever claimed that slug. Check the spelling, or find " +
                  "the document with search_documents (by content) or list_documents.",
              );
            }
            if (tomb.redirect_to) {
              const target = await resolveRedirectTarget(env, tomb.redirect_to);
              if (target) {
                // NO redirect envelope on this tool, unlike read_document: a
                // viewer wants ONE envelope shape, so the hop stays explicit
                // as an error that names the target instead of a second shape.
                return textError(
                  "slug_retired",
                  `this slug is retired and now redirects to the document ${target.public_id}; ` +
                    `re-call view_document with public_id:"${target.public_id}" to show ` +
                    "that document (the redirect is never followed silently).",
                );
              }
              return textError(
                "slug_retired",
                "this slug is retired and its redirect target is no longer available, " +
                  "so it will not resolve. Find the current document with " +
                  "search_documents (by content) or list_documents.",
              );
            }
            return textError(
              "slug_retired",
              "this slug is retired (its document was revoked, or the slug was renamed " +
                "or released) and is not reused, so it will not resolve again. Show the " +
                "current document by its public_id, or find it with search_documents / " +
                "list_documents.",
            );
          }
          resolvedId = bySlug;
        } else if (public_id !== undefined) {
          resolvedId = public_id;
        } else {
          return textError("bad_request", "pass exactly one of `public_id` or `slug`");
        }

        const result = await readDocumentCore(env, resolvedId, version ?? null);
        if (!result.ok) {
          return textError(
            result.code,
            result.code === "version_not_found"
              ? "no such version of this document — call read_document with " +
                  "include_history:true to list the versions that exist, then re-call " +
                  "view_document with one of them"
              : DOC_NOT_FOUND_TEXT,
          );
        }
        const { visibility, published_version } = await currentEcho(env, resolvedId);
        // Full envelope (with the document body) for the APP via
        // structuredContent; the model-facing text block gets the envelope
        // MINUS content/sanitizer_v plus a note pointing at read_document —
        // see structuredOkAppSummary for why the mirror deliberately slims.
        const envelope = {
          public_id: resolvedId,
          url: `${origin}/d/${resolvedId}`,
          title: result.title,
          description: result.description,
          tags: result.tags,
          slug: result.slug,
          status: result.status,
          superseded_by: result.superseded_by,
          visibility,
          published_version,
          version: result.version_no,
          content: new TextDecoder().decode(result.bytes),
          format: "html" as const,
          sanitizer_v: result.sanitizer_v,
        };
        const { content: _content, sanitizer_v: _sanitizerV, ...summary } = envelope;
        return structuredOkAppSummary(envelope, {
          ...summary,
          note:
            "the document body was delivered to the inline viewer and is not " +
            "included here — call read_document to read the content",
        });
      } catch (err) {
        logUnexpectedMcpThrow("view_document", err);
        return textError("internal", "internal error viewing document");
      }
    },
  );
}
