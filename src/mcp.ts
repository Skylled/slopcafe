/**
 * MCP transport mount for /mcp.
 *
 * Streamable HTTP via the Cloudflare Agents SDK's `createMcpHandler`,
 * with a per-request `McpServer` (MCP SDK ≥1.26 forbids reuse — cross-
 * request state would leak otherwise). Four agent-scoped tools mirror
 * the existing HTTP verbs; provenance is stamped from the resolved
 * `agentId` closure-captured at registration time.
 *
 * Auth (Door A OAuth or Door B static bearer) is resolved upstream in
 * src/mcp-auth.ts and passed in as `props`. Tools see the agent identity
 * via that closure — they never re-validate.
 *
 * Logging discipline: console.error tool-name + error-code only. Never
 * args (may contain user HTML), never the Request headers (may contain
 * the bearer), never the OAuth token.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

import {
  listDocumentsCore,
  publishDocumentCore,
  readDocumentCore,
  updateDocumentCore,
} from "./core.js";
import type { Env } from "./env.js";
import type { AwhProps } from "./mcp-auth.js";

/**
 * Build the MCP server and dispatch a single request. Called from the
 * worker's main fetch handler once auth has resolved.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  props: AwhProps,
): Promise<Response> {
  const origin = new URL(request.url).origin;

  // PER-REQUEST. Do not hoist. The MCP SDK ≥1.26 throws on reused server
  // instances; sharing across requests would also bleed state (e.g. an
  // in-flight tool's args/results) between concurrent isolates.
  const server = new McpServer(
    { name: "agent-web-host", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "publish_document",
    {
      description:
        "Publish a new HTML document and get back an unguessable URL a human can open. " +
        "The HTML is sanitized server-side; <script>, <style>, <iframe>, inline event " +
        "handlers, and javascript:/data:/vbscript: URLs are stripped. Returns the " +
        "public_id, the URL to share, the assigned version (always 1 for a new " +
        "document), and a `modified` flag indicating whether sanitization changed " +
        "the input.",
      inputSchema: {
        html: z
          .string()
          .describe("The HTML document body. See the publishing skill for the allowed tag/attribute/URL list."),
      },
    },
    async ({ html }) => {
      try {
        const result = await publishDocumentCore(env, html, props.agentId, origin);
        if (!result.ok) {
          return textError(translatePublishError(result));
        }
        return textOk(
          JSON.stringify({
            public_id: result.public_id,
            url: result.url,
            version: result.version,
            size_bytes: result.size_bytes,
            sanitizer_v: result.sanitizer_v,
            modified: result.modified,
          }),
        );
      } catch (err) {
        console.error("mcp.publish_document.threw", String(err));
        return textError("internal error publishing document");
      }
    },
  );

  server.registerTool(
    "update_document",
    {
      description:
        "Append a new version to an existing document. Requires the current version " +
        "number for optimistic concurrency. If the document has been updated since " +
        "you last saw it, this returns a version conflict with the actual current " +
        "version; refetch and retry. Omit expected_version (or pass null) to clobber " +
        "without a version check (last-write-wins).",
      inputSchema: {
        public_id: z.string().describe("22-char public_id from a prior publish_document call."),
        html: z.string().describe("The new HTML content (replaces, not merges)."),
        expected_version: z
          .number()
          .int()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "The version number you believe is current. Omit or pass null to overwrite without a version check.",
          ),
      },
    },
    async ({ public_id, html, expected_version }) => {
      try {
        const result = await updateDocumentCore(
          env,
          public_id,
          html,
          expected_version ?? null,
          props.agentId,
          origin,
        );
        if (!result.ok) {
          return textError(translateUpdateError(result));
        }
        return textOk(
          JSON.stringify({
            public_id: result.public_id,
            url: result.url,
            version: result.version,
            size_bytes: result.size_bytes,
            sanitizer_v: result.sanitizer_v,
            modified: result.modified,
          }),
        );
      } catch (err) {
        console.error("mcp.update_document.threw", String(err));
        return textError("internal error updating document");
      }
    },
  );

  server.registerTool(
    "read_document",
    {
      description:
        "Fetch the sanitized HTML of a previously published document. Returns the " +
        "raw bytes (no shell, no iframe wrapper) suitable for further processing.",
      inputSchema: {
        public_id: z.string().describe("22-char public_id."),
      },
    },
    async ({ public_id }) => {
      try {
        const result = await readDocumentCore(env, public_id);
        if (!result.ok) {
          return textError("no such document");
        }
        return textOk(new TextDecoder().decode(result.bytes));
      } catch (err) {
        console.error("mcp.read_document.threw", String(err));
        return textError("internal error reading document");
      }
    },
  );

  server.registerTool(
    "list_documents",
    {
      description:
        "List every document this operator's fleet has published, newest first. " +
        "Includes revoked documents (with revoked_at set). v1 is single-tenant — " +
        "all agents under one operator share visibility, matching the cross-agent " +
        "update semantics.",
      // No inputSchema → zero-arg tool.
    },
    async () => {
      try {
        const result = await listDocumentsCore(env);
        return textOk(JSON.stringify(result));
      } catch (err) {
        console.error("mcp.list_documents.threw", String(err));
        return textError("internal error listing documents");
      }
    },
  );

  // Mount on /mcp. `authContext` carries `props` to anything in the SDK
  // that calls getMcpAuthContext() — our tool handlers don't need it
  // (closure-captured above), but we set it for consistency.
  const handler = createMcpHandler(server, {
    route: "/mcp",
    authContext: { props: props as unknown as Record<string, unknown> },
  });

  const response = await handler(request, env, ctx);

  // /mcp is JSON-RPC over HTTP; never cache responses.
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// -- helpers ------------------------------------------------------------------

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textOk(text: string): ToolText {
  return { content: [{ type: "text", text }] };
}

function textError(text: string): ToolText {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Map a publishDocumentCore failure into model-readable text. See
 * skills/connector-guide.md "Error mapping" for the canonical translations.
 */
function translatePublishError(
  err: Extract<Awaited<ReturnType<typeof publishDocumentCore>>, { ok: false }>,
): string {
  switch (err.code) {
    case "empty_body":
      return "connector bug: empty html argument";
    case "too_large":
      return `document too large: ${err.size} bytes exceeds limit of ${err.limit}`;
    case "storage_cap_exceeded":
      return `fleet storage cap exceeded: ${err.used}/${err.cap} bytes used, this write would add ${err.this_write}`;
  }
}

function translateUpdateError(
  err: Extract<Awaited<ReturnType<typeof updateDocumentCore>>, { ok: false }>,
): string {
  switch (err.code) {
    case "not_found":
      return "no such document";
    case "version_conflict":
      return `version conflict, current is v${err.current_version} (you sent v${err.expected}); refetch and retry`;
    case "empty_body":
      return "connector bug: empty html argument";
    case "too_large":
      return `document too large: ${err.size} bytes exceeds limit of ${err.limit}`;
    case "storage_cap_exceeded":
      return `fleet storage cap exceeded: ${err.used}/${err.cap} bytes used, this write would add ${err.this_write}`;
  }
}
