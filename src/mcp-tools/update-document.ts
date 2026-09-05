// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** MCP registration for `update_document` — Replace a document's body (+ optional rename) as a new version. */

import { z } from "zod";

import { McpWriteResponseSchema } from "../contract.js";
import { updateDocumentCore } from "../core.js";
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
  WRITE_FORMAT_FIELD,
} from "../mcp-tool-fields.js";
import { coerceInt } from "../mcp-tool-input.js";
import { logUnexpectedMcpThrow, structuredOk } from "../mcp-tool-result.js";
import { translateUpdateError } from "../mcp-write-errors.js";
import { toWriteResponse } from "../wire.js";
import type { McpToolContext, ToolRegistrar } from "../mcp-tool-context.js";

/** Register `update_document` on the request's gated server. */
export function registerUpdateDocumentTool(
  server: ToolRegistrar,
  { env, agentId, clientId, origin, waitUntil }: McpToolContext,
): void {
  server.registerTool(
    "update_document",
    {
      // Restates the publish contract only at headline level (a cold agent
      // may call update_ before publish_ in the same session); the
      // replace-not-merge point IS restated because patch/merge is the
      // natural assumption from other CRUD APIs. The inheritance rules are
      // this tool's genuinely behavioral content — they stay in full.
      description:
        "Append a new version to an existing document. Identify it by EITHER " +
        "`public_id` OR `slug` — exactly one. The separate `new_slug` field " +
        "renames or clears the document. " +
        "The body REPLACES the prior " +
        "version — it does not merge or patch. Same static-HTML contract and `format` " +
        "semantics as publish_document; each version retains its OWN source. " +
        "VISIBILITY (echoed, unchanged by this call): documents are " +
        "born PRIVATE — a \"private\" doc's URL 404s for a logged-out human. Updating " +
        "it does not publish it; only the OPERATOR can (Manage page at " +
        "/d/<public_id>/manage, or POST /admin/documents/:id/visibility). Say so " +
        "rather than handing over a link that won't open. " +
        "PUBLICATION (also echoed, also unchanged): a PUBLIC document " +
        "renders the version the operator PROMOTED — not automatically your newest one. " +
        "Compare the response's `published_version` to `version`: equal means readers " +
        "have your bytes; LOWER means the write landed but the page a logged-out human " +
        "opens is still the older version, and only the OPERATOR can promote it. " +
        "Report it as pending — never say a URL is live without checking those two match. A " +
        "private doc always renders your newest version, so this only bites once it is " +
        "public. " +
        "CONCURRENCY: pass the version you last saw as " +
        "`expected_version` to get a version conflict (with the actual current " +
        "version) instead of clobbering a doc that changed under you; omit or pass " +
        "null for last-write-wins. " +
        "IDENTICAL RE-WRITES COLLAPSE: if content AND metadata all match what is stored, " +
        "nothing is written — `unchanged: true` at the existing version. A retry is " +
        "safe; a version number that did not advance is a successful no-op, NOT a " +
        "failure to retry. " +
        "METADATA INHERITANCE (where update differs from publish): `title`/" +
        "`description` are PER-VERSION — omitted = inherited from the prior version " +
        "unchanged; \"\" clears (title \"\" re-derives from the new content's first " +
        "<h1>). `tags`/`new_slug` are DOCUMENT-LEVEL — omitted = left untouched; an " +
        "explicit value REPLACES (tags) or atomically RENAMES (new_slug: claims the new, " +
        "retires the old FOREVER — retired slugs are never freed); \"\" / [] clears. " +
        "Constraints and ERRORS match publish_document; every error is code-prefixed " +
        "(\"<code>: <message>\") — also not_found, version_conflict, and slug_locked " +
        "(a PUBLIC document's slug is a reader-facing address, so only the operator may " +
        "change or clear it; the whole update is refused, content included — re-send " +
        "without `new_slug`). " +
        "LARGE EXISTING FILES: prefer the byte-exact HTTP path — " +
        "create_publish_credential, then `curl --data-binary @file` to PUT /d/:id " +
        "with If-Match; see the publishing guide §update_document. " +
        "On an MCP Apps host the result renders inline for the user; no " +
        "view_document call needed.",
      // Strict at runtime, not only in the advertised JSON Schema. This is a
      // safety boundary for the 3.0 field rename: Zod's default object parser
      // strips unknown keys, which could otherwise turn the stale 2.x payload
      // { document_slug: "old", slug: "rename-target" } into a write to the
      // document named "rename-target". Rejecting unknown `document_slug`
      // keeps that payload from ever reaching the handler.
      inputSchema: z.strictObject({
        public_id: PUBLIC_ID_IDENTITY_FIELD,
        slug: SLUG_IDENTITY_FIELD,
        content: z
          .string()
          .describe(
            "The new content. REPLACES the prior version (no merge/patch). Interpreted " +
            "per `format`, then sanitized to the static-HTML contract.",
          ),
        format: WRITE_FORMAT_FIELD,
        expected_version: coerceInt(
          z.number().int().min(1).nullable().optional(),
          "The version number you believe is current. Omit or pass null to overwrite without a version check.",
        ),
        title: TITLE_FIELD_UPDATE,
        description: DESCRIPTION_FIELD_UPDATE,
        tags: TAGS_FIELD_UPDATE,
        new_slug: NEW_SLUG_FIELD_UPDATE,
      }),
      outputSchema: leanOutputSchema(McpWriteResponseSchema),
      annotations: {
        title: "Update Document",
        readOnlyHint: false,
        destructiveHint: true, // whole-body REPLACE, not a merge/patch
        // Genuinely idempotent since the 2.1.0 identical-write collapse
        // (updateDocumentCore, src/core.ts): re-sending content/title/
        // description/tags/new_slug that all match what's already stored writes
        // nothing and reports `unchanged: true` at the same version.
        idempotentHint: true,
        openWorldHint: false,
      },
      // Post-publish inline preview (MCP Apps) — see DOC_VIEW_TOOL_META.
      _meta: DOC_VIEW_TOOL_META,
    },
    async ({ public_id, slug, content, format, expected_version, title, description, tags, new_slug }) => {
      try {
        const target = await resolveWriteTarget(env, public_id, slug);
        if (!target.ok) return target.error;
        const result = await updateDocumentCore(
          env,
          target.publicId,
          content,
          expected_version ?? null,
          { kind: "agent", agentId, clientId },
          origin,
          format,
          metadataInputFromArgs(title, description, tags, new_slug),
          waitUntil, // re-embed after the D1 batch commits
        );
        if (!result.ok) {
          return textError(result.code, translateUpdateError(result));
        }
        const { visibility, published_version } = await currentEcho(env, result.public_id);
        return structuredOk({
          ...toWriteResponse(result),
          visibility,
          published_version,
        });
      } catch (err) {
        logUnexpectedMcpThrow("update_document", err);
        return textError("internal", "internal error updating document");
      }
    },
  );
}
