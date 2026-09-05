// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** MCP registration for `set_document_status` — The lifecycle status classification write (no bytes, no version bump). */

import { z } from "zod";

import { McpSetStatusResponseSchema } from "../contract.js";
import { setDocumentStatusCore } from "../document-lifecycle.js";
import { currentEcho, resolveWriteTarget } from "../mcp-document-target.js";
import { textError } from "../mcp-error-result.js";
import { leanOutputSchema } from "../mcp-lean-schema.js";
import { PUBLIC_ID_IDENTITY_FIELD, SLUG_IDENTITY_FIELD } from "../mcp-tool-fields.js";
import { logUnexpectedMcpThrow, structuredOk } from "../mcp-tool-result.js";
import { translateSetStatusError } from "../mcp-write-errors.js";
import type { McpToolContext, ToolRegistrar } from "../mcp-tool-context.js";

/** Register `set_document_status` on the request's gated server. */
export function registerSetDocumentStatusTool(
  server: ToolRegistrar,
  { env }: McpToolContext,
): void {
  server.registerTool(
    "set_document_status",
    {
      description:
        "Mark a document current (\"active\") or superseded (\"deprecated\"), " +
        "optionally naming its replacement. Use it instead of leaving stale guidance to " +
        "be found and trusted (revoking is operator-only and irreversible). " +
        "DEPRECATED still renders, reads and ranks in search, marked so a reader can " +
        "discount it; the one behavioral effect is that context packs skip it by " +
        "default. It NEVER gates " +
        "access — this is a trust signal, not a boundary. " +
        "NO VERSION IS CREATED — status is document-level classification; the bytes and " +
        "version number are untouched. " +
        "`superseded_by` takes the replacement's PUBLIC_ID ONLY (a slug is not " +
        "accepted — resolve one with list_documents first). It must name a live " +
        "document and cannot be this document. It is a signal, never a redirect: no " +
        "reader auto-follows it. Setting status back to \"active\" clears the pointer " +
        "regardless of what you pass. " +
        "ERRORS are code-prefixed (\"<code>: <message>\"): not_found (no such LIVE " +
        "document); bad_target (`superseded_by` names nothing live, or names this " +
        "same document); invalid_slug; bad_request (both or neither of " +
        "public_id/slug).",
      inputSchema: z.strictObject({
        public_id: PUBLIC_ID_IDENTITY_FIELD,
        slug: SLUG_IDENTITY_FIELD,
        status: z
          .enum(["active", "deprecated"])
          .describe(
            "\"deprecated\" marks the document superseded — still readable and " +
              "searchable, excluded from context packs by default. \"active\" is the " +
              "default and clears any `superseded_by`.",
          ),
        superseded_by: z
          .string()
          .optional()
          .describe(
            "Optional replacement document's public_id (22 chars) — NOT a slug. " +
              "Only meaningful with status:\"deprecated\"; forced null on \"active\". " +
              "Omit for \"superseded, no replacement\".",
          ),
      }),
      outputSchema: leanOutputSchema(McpSetStatusResponseSchema),
      annotations: {
        title: "Set Document Status",
        readOnlyHint: false,
        // Replaces status/superseded_by outright — e.g. "active"
        // unconditionally clears any prior superseded_by — a destructive
        // update to classification state even though no document bytes move.
        destructiveHint: true,
        idempotentHint: true, // same status/superseded_by in -> same result
        openWorldHint: false,
      },
    },
    async ({ public_id, slug, status, superseded_by }) => {
      try {
        const target = await resolveWriteTarget(env, public_id, slug);
        if (!target.ok) return target.error;
        const result = await setDocumentStatusCore(env, target.publicId, status, superseded_by);
        if (!result.ok) {
          return textError(result.code, translateSetStatusError(result));
        }
        return structuredOk({
          public_id: result.public_id,
          status: result.status,
          superseded_by: result.superseded_by,
          visibility: (await currentEcho(env, result.public_id)).visibility,
        });
      } catch (err) {
        logUnexpectedMcpThrow("set_document_status", err);
        return textError("internal", "internal error setting status");
      }
    },
  );
}
