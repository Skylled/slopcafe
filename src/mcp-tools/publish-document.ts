// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** MCP registration for `publish_document` — Publish a new document (born private) and echo its URL/visibility/publication. */

import { McpWriteResponseSchema } from "../contract.js";
import { publishDocumentCore } from "../document-write.js";
import { currentEcho } from "../mcp-document-target.js";
import { textError } from "../mcp-error-result.js";
import { leanOutputSchema } from "../mcp-lean-schema.js";
import {
  CONTENT_FIELD,
  DESCRIPTION_FIELD,
  metadataInputFromArgs,
  SLUG_FIELD,
  TAGS_FIELD,
  TITLE_FIELD,
  WRITE_FORMAT_FIELD,
} from "../mcp-tool-fields.js";
import { logUnexpectedMcpThrow, structuredOk } from "../mcp-tool-result.js";
import { translatePublishError } from "../mcp-write-errors.js";
import { toWriteResponse } from "../wire.js";
import type { McpToolContext, ToolRegistrar } from "../mcp-tool-context.js";

/** Register `publish_document` on the request's gated server. */
export function registerPublishDocumentTool(
  server: ToolRegistrar,
  { env, agentId, clientId, origin, waitUntil }: McpToolContext,
): void {
  server.registerTool(
    "publish_document",
    {
      // The positive contract — what to MAKE, not just what gets stripped.
      // Ordered by priority so a length-trimmed render still carries the
      // three non-negotiables (born-private, static/no-JS, SVG-not-images): a
      // cold agent never reads the publishing skill, so this description is the
      // only behavioral contract it sees at call time. Shape guarantees
      // (response fields, metadata constraints) live in the input/output
      // schemas, not here — don't restate them in prose.
      //
      // BORN PRIVATE LEADS. It used to open "get back an unguessable URL a
      // human can open", which is false on a private-default deployment: the
      // agent read the doc back fine (agent keys read everything), handed the
      // user the link, and the user got a 404 card. Naming the OPERATOR action
      // is the load-bearing half — without it an agent hunts for a tool
      // parameter that deliberately does not exist.
      description:
        "Publish a new document and get back its URL. FIRST: documents are born PRIVATE " +
        "here — the URL opens for you and for the operator, but a logged-out human gets " +
        "a 404. The response echoes `visibility`; when it is \"private\", don't just hand " +
        "the link over — tell the user only the OPERATOR can publish it (Manage page at " +
        "/d/<public_id>/manage, or POST /admin/documents/:id/visibility). No tool sets " +
        "it; asking IS the next step. A private doc is still fully readable by you and " +
        "other agents. " +
        "The response also echoes `published_version` — which version a PUBLIC document " +
        "RENDERS. Treat a URL as live only when it matches `version` (on a brand-new " +
        "doc it always does; from your next write on, see update_document). " +
        "ONE CONTRACT, BOTH FORMATS — everything is stored as " +
        "sanitized STATIC HTML: no JavaScript runs (<script>, on*= handlers, " +
        "javascript:/data:/vbscript: URLs are stripped); style inline or with " +
        "<style> blocks, but keep CSS SELF-CONTAINED " +
        "(no <link>, @import, url(http...), external fonts). For any visual use " +
        "INLINE SVG — <img> does not work in v1. " +
        "Your SOURCE IS RETAINED per version — read it back with " +
        "representation:\"source\" and patch it with edit_document. " +
        "Full allowlist: read_document slug:\"slopcafe-docs-publishing-guide\" " +
        "(§publish_document). " +
        "Optional `title`/`description`/`tags`/`slug` (constraints on each field); " +
        "claiming a `slug` is PERMANENT, so read that field first. " +
        "ERRORS are code-prefixed (\"<code>: <message>\"): invalid_slug, slug_taken, " +
        "slug_retired, too_large, too_deep, storage_cap_exceeded. " +
        "LARGE EXISTING FILES already on disk (and you have a shell): don't regenerate " +
        "here — mint a key with create_publish_credential and " +
        "`curl --data-binary @file` to POST /d. " +
        "On an MCP Apps host the result renders inline for the user; no " +
        "view_document call needed.",
      inputSchema: {
        content: CONTENT_FIELD,
        format: WRITE_FORMAT_FIELD,
        title: TITLE_FIELD,
        description: DESCRIPTION_FIELD,
        tags: TAGS_FIELD,
        slug: SLUG_FIELD,
      },
      outputSchema: leanOutputSchema(McpWriteResponseSchema),
      annotations: {
        title: "Publish Document",
        readOnlyHint: false,
        destructiveHint: false, // additive only — always creates a brand-new doc
        idempotentHint: false, // mints a new document/public_id every call
        openWorldHint: false,
      },
    },
    async ({ content, format, title, description, tags, slug }) => {
      try {
        const result = await publishDocumentCore(
          env,
          content,
          { kind: "agent", agentId, clientId },
          origin,
          format,
          metadataInputFromArgs(title, description, tags, slug),
          // visibilityOverride — agents NEVER set birth visibility. This stays
          // undefined by operator decision: only the operator publishes a
          // document to the world. Don't plumb an input through here.
          undefined,
          waitUntil, // schedule the vector sync after the D1 batch
        );
        if (!result.ok) {
          return textError(result.code, translatePublishError(result));
        }
        const { visibility, published_version } = await currentEcho(env, result.public_id);
        return structuredOk({
          ...toWriteResponse(result),
          visibility,
          published_version,
        });
      } catch (err) {
        logUnexpectedMcpThrow("publish_document", err);
        return textError("internal", "internal error publishing document");
      }
    },
  );
}
