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
  readDocumentTextCore,
  updateDocumentCore,
} from "./core.js";
import type { Env } from "./env.js";
import type { AwhProps } from "./mcp-auth.js";
// Bundled via wrangler's `type = "Text"` rule (see wrangler.toml). Imported
// here so the awh://publishing-guide resource serves the same bytes the
// repo maintains for human readers — no second copy to drift.
import publishingGuideMd from "../skills/publishing.md";

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
    { name: "agent-web-host", version: "0.4.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // awh://publishing-guide — the full authoring contract (allowlist, SVG
  // subset, URL schemes, stripped table). The tool descriptions carry the
  // non-negotiables; this resource carries the long detail an agent only
  // needs on demand (e.g. when modified: true is unexpected, or when
  // authoring a non-trivial SVG). Sourced from skills/publishing.md so the
  // bytes can't drift from the doc the repo maintains for human readers.
  //
  // Resource-surfacing varies by client. If a given client doesn't expose
  // resources to the model automatically, the tool descriptions still
  // stand alone — that's why Level 1 of the addendum came first.
  server.registerResource(
    "publishing-guide",
    "awh://publishing-guide",
    {
      title: "agent-web-host publishing guide",
      description:
        "The full HTML/CSS/SVG authoring contract for agent-web-host: allowed " +
        "tag list, SVG drawing-primitive subset, URL-scheme allowlist, and the " +
        "table of constructs that get silently stripped or CSP-blocked at " +
        "render. Read this when a publish_document/update_document response " +
        "has modified: true and you need to know which categories of content " +
        "to avoid, or when authoring non-trivial inline SVG. The HTTP/Bearer " +
        "sections at the top describe the direct-HTTP API (not the MCP path " +
        "you're already on) — skip them; the allowlist sections are the " +
        "authoritative part for MCP callers too.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: publishingGuideMd,
        },
      ],
    }),
  );

  server.registerTool(
    "publish_document",
    {
      // The positive contract — what to MAKE, not just what gets stripped.
      // Ordered by priority so a length-trimmed render still carries the
      // two non-negotiables (static/no-JS, SVG-not-images). See the addendum
      // "Level 1" rationale: a cold agent never reads the publishing skill,
      // so this description is the only contract it sees at call time.
      description:
        "Publish a new HTML document and get back an unguessable URL a human can open. " +
        "STATIC HTML SURFACE — no JavaScript runs (<script>, on*= handlers, and " +
        "javascript:/data:/vbscript: URLs are stripped). For any visual (chart, " +
        "diagram, icon) use INLINE SVG — <img> does not work in v1 (external src is " +
        "CSP-blocked at render; data: src is sanitizer-stripped). All styling must be " +
        "INLINE style=\"...\" attributes — <style> blocks and <link rel=stylesheet> are " +
        "dropped. NO EXTERNAL RESOURCES — images, fonts, and stylesheets must be " +
        "inline or absent. Allowed: standard text/structure/list/table tags, inline " +
        "SVG drawing primitives, role/aria-*, and inline styles. For the full allowlist " +
        "(every allowed tag/attribute, the SVG subset, URL-scheme list, and the " +
        "stripped table), read the awh://publishing-guide MCP resource. Returns " +
        "public_id, the shareable url, version (1 for new), size_bytes, sanitizer_v, " +
        "a `modified` flag (true = the sanitizer changed your input), `stripped[]` " +
        "summarizing what was removed (best-effort), and `will_not_render[]` for " +
        "elements that survived the sanitizer but the iframe CSP will block — most " +
        "importantly external <img src>, which would otherwise render as a broken " +
        "image with no other signal.",
      inputSchema: {
        html: z
          .string()
          .describe(
            "The HTML document body. Static HTML only (no JS), inline styles, " +
            "inline SVG for visuals (no <img>), no external resources.",
          ),
      },
    },
    async ({ html }) => {
      try {
        const result = await publishDocumentCore(env, html, props.agentId, origin, "html");
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
            stripped: result.stripped,
            will_not_render: result.will_not_render,
          }),
        );
      } catch (err) {
        console.error("mcp.publish_document.threw", String(err));
        return textError("internal error publishing document");
      }
    },
  );

  server.registerTool(
    "publish_document_markdown",
    {
      // Sibling to publish_document for agents that find it easier to author
      // in Markdown than HTML. Lead with what's different from the HTML tool
      // (the parser + the GFM features); leave the long allowlist talk in the
      // publishing-guide resource. The note about inline HTML being sanitized
      // is the most important line — it answers "what if I include raw HTML?"
      // before the agent has to ask.
      description:
        "Publish a new document authored in Markdown and get back an unguessable URL " +
        "a human can open. The Markdown is parsed (CommonMark + GFM: tables, " +
        "strikethrough, task lists, footnotes) into HTML, then run through the same " +
        "sanitizer as publish_document — so the rules about NO JavaScript, NO " +
        "external resources, and NO <style> blocks still apply to any inline HTML " +
        "you include in the Markdown. Pure-Markdown content (headings, lists, " +
        "tables, code, links, emphasis) passes through cleanly; raw <script> or " +
        "<style> blocks in your Markdown source get stripped exactly as they would " +
        "from a publish_document call. GFM task list checkboxes (`- [ ]`) emit " +
        "<input type=checkbox>, which the sanitizer strips (form controls aren't " +
        "in the allowlist) — the surrounding text survives, but the checkbox is " +
        "gone; use a plain bullet or unicode ☐/☑ if you need the visual marker. " +
        "Stored as sanitized HTML (the Markdown source is not retained — read_document " +
        "returns HTML; read_document_text re-derives Markdown from it, which may not " +
        "match your input exactly). Returns the same shape as publish_document: " +
        "public_id, url, version (1 for new), size_bytes, sanitizer_v, `modified` " +
        "(true = the sanitizer changed something the parser produced), `stripped[]`, " +
        "and `will_not_render[]`.",
      inputSchema: {
        markdown: z
          .string()
          .describe(
            "The Markdown document. CommonMark + GFM features (tables, strikethrough, " +
            "task lists, footnotes). Inline HTML is allowed but gets sanitized — same " +
            "rules as publish_document. No frontmatter is parsed; YAML front-matter " +
            "would appear as a literal paragraph at the top.",
          ),
      },
    },
    async ({ markdown }) => {
      try {
        const result = await publishDocumentCore(env, markdown, props.agentId, origin, "markdown");
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
            stripped: result.stripped,
            will_not_render: result.will_not_render,
          }),
        );
      } catch (err) {
        console.error("mcp.publish_document_markdown.threw", String(err));
        return textError("internal error publishing document");
      }
    },
  );

  server.registerTool(
    "update_document",
    {
      // Same HTML rules as publish_document, restated for cold agents that
      // call update_ before publish_ in the same session and never see the
      // publish description. The replace-not-merge point is also restated
      // because patch/merge is the natural assumption from other CRUD APIs.
      description:
        "Append a new version to an existing document. Requires the current version " +
        "number for optimistic concurrency. If the document has been updated since " +
        "you last saw it, this returns a version conflict with the actual current " +
        "version; refetch and retry. Omit expected_version (or pass null) to clobber " +
        "without a version check (last-write-wins). Same HTML rules as " +
        "publish_document: STATIC ONLY (no JavaScript), INLINE STYLES (no <style> " +
        "blocks), INLINE SVG for visuals (no <img>), no external resources. The body " +
        "REPLACES the prior version — it does not merge or patch. For the full " +
        "allowlist (tags, SVG subset, URL schemes, stripped table), read the " +
        "awh://publishing-guide MCP resource. Returns the same shape as " +
        "publish_document, including `modified`, `stripped[]` (what the sanitizer " +
        "removed, best-effort), and `will_not_render[]` (constructs that survived " +
        "sanitize but the iframe CSP will block — notably external <img src>).",
      inputSchema: {
        public_id: z.string().describe("22-char public_id from a prior publish_document call."),
        html: z
          .string()
          .describe(
            "The new HTML content. REPLACES the prior version (no merge/patch). " +
            "Static HTML only, inline styles, inline SVG for visuals, no external resources.",
          ),
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
          "html",
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
            stripped: result.stripped,
            will_not_render: result.will_not_render,
          }),
        );
      } catch (err) {
        console.error("mcp.update_document.threw", String(err));
        return textError("internal error updating document");
      }
    },
  );

  server.registerTool(
    "update_document_markdown",
    {
      // Markdown sibling to update_document. Same conventions as
      // publish_document_markdown above (GFM features, inline HTML gets
      // sanitized) plus the same If-Match-style optimistic-concurrency
      // contract as update_document. Cross-format updates are allowed —
      // a document published as HTML can be updated with Markdown and
      // vice versa; versions.source_format records which path each
      // version took.
      description:
        "Append a new Markdown-authored version to an existing document. Same " +
        "optimistic-concurrency contract as update_document — pass the current " +
        "version number for expected_version (returns version_conflict if the " +
        "document has been updated since), or omit/null to clobber. The Markdown " +
        "(CommonMark + GFM) is parsed to HTML, then run through the same sanitizer " +
        "as update_document — NO JavaScript, NO external resources, NO <style> " +
        "blocks, even for inline HTML embedded in the Markdown source. Cross-format " +
        "updates work: a document originally published as HTML can be updated with " +
        "Markdown and vice versa. The body REPLACES the prior version (no merge or " +
        "patch). Returns the same shape as update_document: public_id, url, version, " +
        "size_bytes, sanitizer_v, `modified`, `stripped[]`, `will_not_render[]`.",
      inputSchema: {
        public_id: z.string().describe("22-char public_id from a prior publish call."),
        markdown: z
          .string()
          .describe(
            "The new Markdown content. REPLACES the prior version (no merge/patch). " +
            "CommonMark + GFM (tables, strikethrough, task lists, footnotes). Inline " +
            "HTML allowed but sanitized (same rules as update_document).",
          ),
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
    async ({ public_id, markdown, expected_version }) => {
      try {
        const result = await updateDocumentCore(
          env,
          public_id,
          markdown,
          expected_version ?? null,
          props.agentId,
          origin,
          "markdown",
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
            stripped: result.stripped,
            will_not_render: result.will_not_render,
          }),
        );
      } catch (err) {
        console.error("mcp.update_document_markdown.threw", String(err));
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
    "read_document_text",
    {
      // Sibling to read_document for the case where the agent is going to
      // INGEST a doc as context rather than RENDER it. Lead with that use
      // case in the description — the names are similar enough that a cold
      // agent could pick read_document by default. Calling out "no scripts/
      // styles/inline-SVG path data" is the concrete pitch: typical sanitized
      // HTML drops to 20–40% of its size in this form.
      description:
        "Fetch a previously published document as Markdown text — same content " +
        "as read_document, but with HTML structure converted to GFM Markdown and " +
        "all visual/styling overhead removed (inline styles, SVG path data, " +
        "container divs). USE THIS when you want to READ the document as context " +
        "for further reasoning, not when you need the raw HTML to render or " +
        "re-publish. Typical size is 20-40% of the HTML form. Inline SVGs collapse " +
        "to [Image: <alt>] placeholders using <title>/<desc>/aria-label when " +
        "present, so any visual content authored without alt text shows up as a " +
        "bare [Image] marker (consider adding <title> when publishing if the " +
        "image carries meaning). Returns the markdown text plus version, " +
        "sanitizer_v, and converter_v so you can detect when the conversion " +
        "policy has changed between reads.",
      inputSchema: {
        public_id: z.string().describe("22-char public_id."),
      },
    },
    async ({ public_id }) => {
      try {
        const result = await readDocumentTextCore(env, public_id);
        if (!result.ok) {
          return textError("no such document");
        }
        return textOk(
          JSON.stringify({
            text: result.text,
            version: result.version_no,
            sanitizer_v: result.sanitizer_v,
            converter_v: result.converter_v,
          }),
        );
      } catch (err) {
        console.error("mcp.read_document_text.threw", String(err));
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
