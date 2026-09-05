// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** MCP registration for `set_document_tags` — The tags classification write (no bytes, no version bump). */

import { z } from "zod";

import { McpSetTagsResponseSchema } from "../contract.js";
import { setDocumentTagsCore } from "../core.js";
import { currentEcho, resolveWriteTarget } from "../mcp-document-target.js";
import { textError } from "../mcp-error-result.js";
import { leanOutputSchema } from "../mcp-lean-schema.js";
import { PUBLIC_ID_IDENTITY_FIELD, SLUG_IDENTITY_FIELD } from "../mcp-tool-fields.js";
import { logUnexpectedMcpThrow, structuredOk } from "../mcp-tool-result.js";
import { DOC_NOT_FOUND_TEXT } from "../mcp-write-errors.js";
import type { McpToolContext, ToolRegistrar } from "../mcp-tool-context.js";

/** Register `set_document_tags` on the request's gated server. */
export function registerSetDocumentTagsTool(
  server: ToolRegistrar,
  { env }: McpToolContext,
): void {
  // -- curation: the two classification writes that never touch a byte ---------
  //
  // TWO TOOLS, NOT ONE `curate_document`. The format-enum precedent collapsed
  // tools performing the SAME operation with a different encoding of one
  // argument; tags and status are independent columns with separate cores,
  // separate UPDATE statements, different validation and different error unions.
  // A combined tool has no atomic path — tags applied, status rejected on a bad
  // `superseded_by`, both hidden behind a single isError result — and would need
  // an "at least one of" input schema that JSON Schema cannot express.
  //
  // AGENT-REACHABLE ON PURPOSE, and the line is drawn where issue #43 drew it:
  // neither field reaches an anonymous surface. Tags are a fleet-internal
  // filter; status marks currency and gates only pack fills. An agent key can
  // already replace a document's entire CONTENT, so re-tagging or deprecating it
  // grants strictly less. `visibility` and publication are the other side of
  // that line — they decide what the anonymous internet sees — so no tool here
  // takes them as an input, and none may be added by analogy from these two.
  server.registerTool(
    "set_document_tags",
    {
      description:
        "Replace a document's tags — the corpus's filing system. Keep them consistent " +
        "with tags already in use (list_documents shows what exists). " +
        "FULL REPLACEMENT, not a merge: the array you send becomes the complete " +
        "tag set, so read the current tags first and send them back plus your " +
        "addition. Send [] to clear. " +
        "NO VERSION IS CREATED — tags are document-level classification: the bytes and " +
        "version number are untouched, and the tags survive later content updates. " +
        "Use this instead of update_document when only the filing changes. " +
        "TAGS ARE SANITIZED, NEVER REJECTED: characters outside [A-Za-z0-9_-] are " +
        "stripped; max 10 tags, 32 chars each. The response echoes what was actually " +
        "STORED — diff it against what you sent instead of assuming it landed. " +
        "Identify the doc by EITHER `public_id` OR `slug` — exactly one. " +
        "ERRORS are code-prefixed (\"<code>: <message>\"): not_found (no such LIVE " +
        "document — a revoked one cannot be re-tagged); invalid_slug; bad_request " +
        "(both or neither of public_id/slug).",
      inputSchema: z.strictObject({
        public_id: PUBLIC_ID_IDENTITY_FIELD,
        slug: SLUG_IDENTITY_FIELD,
        tags: z
          .array(z.string())
          .describe(
            "The COMPLETE tag list after this call — not additions. Send [] to clear. " +
              "Sanitized server-side; the response echoes what was stored.",
          ),
      }),
      outputSchema: leanOutputSchema(McpSetTagsResponseSchema),
      annotations: {
        title: "Set Document Tags",
        readOnlyHint: false,
        // Full REPLACE, not a merge — can drop tags the caller didn't
        // resend, so it's a destructive update to classification state even
        // though no document bytes move.
        destructiveHint: true,
        idempotentHint: true, // same array in -> same stored set, every time
        openWorldHint: false,
      },
    },
    async ({ public_id, slug, tags }) => {
      try {
        const target = await resolveWriteTarget(env, public_id, slug);
        if (!target.ok) return target.error;
        const result = await setDocumentTagsCore(env, target.publicId, tags);
        if (!result.ok) {
          return textError(result.code, DOC_NOT_FOUND_TEXT);
        }
        return structuredOk({
          public_id: result.public_id,
          tags: result.tags,
          // Visibility only — no published_version echo: nothing about the
          // document's bytes moved, so there is no "stored but not live yet"
          // gap for a promote to close.
          visibility: (await currentEcho(env, result.public_id)).visibility,
        });
      } catch (err) {
        logUnexpectedMcpThrow("set_document_tags", err);
        return textError("internal", "internal error setting tags");
      }
    },
  );
}
