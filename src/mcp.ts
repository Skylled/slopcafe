// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP transport mount for /mcp — transport, the Apps resource, and the
 * registration ORCHESTRATION. No tool is registered inline here: each of the
 * eleven lives in its own `src/mcp-tools/<tool>.ts` module exporting a
 * `register<Tool>Tool(server, ctx)` registrar, and `handleMcp` calls them in
 * wire order (MCP_TOOL_NAMES in src/mcp-toolset.ts records it).
 *
 * Streamable HTTP via the Cloudflare Agents SDK's stateless
 * `createMcpHandler` (the `agents/mcp/server` entry), with a per-request
 * `McpServer` served through the handler's factory — stateless per MCP
 * 2026-07-28 (`server/discover` + automatic legacy `initialize` fallback:
 * ONE factory serves both protocol eras, so 2025-era connectors keep
 * working through the SDK's compatibility lane with no client action).
 * The 0.20 wrapper also validates Origin/Host: server-side connectors
 * (Claude web/ChatGPT/Claude Code) send no Origin header and pass
 * untouched; if a browser-resident MCP client ever calls /mcp directly,
 * set `allowedOriginHostnames` — documented here, deliberately not
 * configured. Eleven agent-scoped tools:
 *   publish_document            update_document
 *   edit_document               set_document_tags
 *   set_document_status         read_document
 *   view_document               list_documents
 *   search_documents            load_context_pack
 *   create_publish_credential
 * `view_document` is the MCP Apps (SEP-1865) presentation read — it links to
 * the ui://slopcafe/document-view.html app template via tool `_meta` so an
 * Apps-capable host renders the document inline for the HUMAN; on any other
 * host it degrades to an ordinary structured result. The extension wiring
 * (UI_RESOURCE_*, DOC_VIEW_TOOL_META, the cache hint) lives in
 * src/mcp-apps.ts.
 * HTML vs Markdown is a `format` parameter on the write tools and an output
 * `format` knob on read_document — not separate tools (an earlier revision
 * had publish/update/read twins; the format enum replaced six tools with
 * three). read_document ALSO has a `representation` axis (rendered | source)
 * orthogonal to `format`: "source" returns the retained pre-sanitization
 * bytes (agent-key gated, never operator-only — see the gating note in the
 * handler) so edit_document can match the source it stores. Provenance is
 * stamped from the resolved `agentId` handed to every registrar in the
 * McpToolContext (src/mcp-tool-context.ts). (`create_publish_credential` is
 * the one tool that doesn't touch a document — it mints a short-lived `awh_`
 * key for the byte-exact curl publish path; see mintPublishCredential in
 * src/publish-credential.ts.)
 * `edit_document` is the server-side find/replace surface — a small-diff
 * alternative to update_document that has NO HTTP equivalent (MCP-only).
 * `set_document_tags` / `set_document_status` are the two CLASSIFICATION
 * writes: they change no bytes and bump no version, and they are agent-
 * reachable for the reason spelled out at their registration — neither field
 * reaches an anonymous surface, unlike visibility and publication. Their HTTP
 * twins are PUT /d/:id/tags and PUT /d/:id/status.
 * Slug lookup is not a dedicated tool — every document-addressing tool takes
 * EITHER `public_id` OR `slug` (exactly one, resolved by the shared resolvers
 * in src/mcp-document-target.ts); on update_document / edit_document the
 * separate `new_slug` field renames or clears the document.
 * findDocumentBySlugCore still backs GET /s/:slug.
 *
 * VISIBILITY IS ECHOED, NEVER SETTABLE. Every write and read envelope carries
 * the document's `visibility` (migration 0011) because documents are born at
 * DEFAULT_DOCUMENT_VISIBILITY — `private` on this deployment — while an agent
 * key reads everything: without the echo an agent cannot tell that the URL it
 * is about to hand a human 404s for them. Flipping a document public is
 * OPERATOR-ONLY by deliberate decision (Manage page, or
 * POST /admin/documents/:id/visibility) — do NOT add a `visibility` input to a
 * tool or thread publishDocumentCore's `visibilityOverride` from a tool module.
 *
 * APPLICATION ERRORS ARE CODE-PREFIXED AND STRUCTURED. Every failure returned
 * by a Slopcafe tool handler goes through
 * `textError(code, text)` and emits the legacy `"<code>: <prose>"` text plus
 * `structuredContent: { error: code }`, so both plain and structured clients
 * can branch without pattern-matching prose. SDK-generated errors (including
 * input-schema rejection before a handler runs) keep the SDK's native shape
 * and may not carry structuredContent. isError results skip the success outputSchema
 * validation; test/mcp-errors.test.mjs pins both handler representations.
 * The core-failure → prose mappers live in src/mcp-write-errors.ts.
 *
 * The three WRITE tools (publish_document / update_document / edit_document)
 * accept optional metadata with publish-vs-update inheritance semantics — see
 * the shared field constants in src/mcp-tool-fields.ts. Publish calls an
 * initial slug claim `slug`; update/edit call the rename-or-clear mutation
 * `new_slug`, while their plain `slug` is consistently an identity field.
 * src/metadata.ts still receives both forms as DocumentMetadataInput.slug
 * internally.
 *
 * Auth (Door A OAuth or Door B static bearer) is resolved upstream in
 * src/mcp-auth.ts and passed in as `props`. Tools see the agent identity
 * via the McpToolContext — they never re-validate.
 *
 * Every tool registers an `outputSchema` (the MCP envelope schemas in
 * src/contract.ts — design §7, the outputSchema convergence) and returns the
 * same payload twice: a JSON text block for clients that only read `content`,
 * plus `structuredContent`, which the SDK validates against the schema before
 * the response leaves the server. Shape guarantees live in those schemas (the
 * field .describe()s a client surfaces from tools/list); the prose
 * descriptions carry only the BEHAVIORAL contract (inheritance-on-omit, the
 * edit-against-source rule, slug permanence, budget semantics).
 *
 * Every tool also registers `annotations` — the spec-track ToolAnnotations
 * hints (readOnlyHint / destructiveHint / idempotentHint / openWorldHint;
 * see ToolAnnotationsSchema's doc comment in the MCP SDK for the canonical
 * field semantics) — so a host can reason about risk from tools/list alone,
 * without parsing description prose: auto-approve a read, prompt before a
 * write. They are advisory HINTS a client must not trust blindly from an
 * untrusted server (the schema's own doc comment says exactly that); the
 * legitimate use is a server declaring its own semantics, which is this
 * case. The five read tools (read_document, view_document, list_documents,
 * search_documents, load_context_pack) carry `readOnlyHint: true` and
 * nothing else — destructiveHint/idempotentHint are spec-documented as
 * "meaningful only when readOnlyHint == false", so a read tool omits them
 * rather than assert a value the spec says has no meaning there. Every
 * write tool's destructiveHint/idempotentHint is chosen per its actual
 * semantics — see the one-line reasoning at each registration in
 * src/mcp-tools/, and GitHub issue #51 for the full tiering table this was
 * built against. openWorldHint is `false` on all eleven: this server's
 * domain is its own corpus, never an open world of external entities. WRONG
 * hints are a real risk in the other direction too — a false `readOnlyHint`
 * on a write tool could get a host to auto-approve a mutation — so every
 * choice here is conservative on purpose. test/mcp-errors.test.mjs pins the
 * exact readOnlyHint set (and that no write tool carries it), so a new tool
 * can't land un-tiered.
 *
 * Logging discipline: console.error tool-name + error-code only. Never
 * args (may contain user HTML), never the Request headers (may contain
 * the bearer), never the OAuth token.
 */

// SDK v2 (`@modelcontextprotocol/server`, the 2026-07-28 line) — NOT the old
// `@modelcontextprotocol/sdk`, which remains in the tree only as the agents
// package's exact v1 peer. `agents/mcp/server` is the stateless entry that
// doesn't retain SDK v1 modules in the bundle (`agents/mcp` would still
// type-check via a deprecated overload but serves the 2025 protocol only).
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env.js";
import {
  DOCUMENT_VIEW_TEMPLATE,
  STATIC_SURFACE_CACHE_HINT,
  UI_RESOURCE_MIME,
  UI_RESOURCE_URI,
} from "./mcp-apps.js";
import type { AwhProps } from "./mcp-auth.js";
import type { McpToolContext, ToolRegistrar } from "./mcp-tool-context.js";
import { registerCreatePublishCredentialTool } from "./mcp-tools/create-publish-credential.js";
import { registerEditDocumentTool } from "./mcp-tools/edit-document.js";
import { registerListDocumentsTool } from "./mcp-tools/list-documents.js";
import { registerLoadContextPackTool } from "./mcp-tools/load-context-pack.js";
import { registerPublishDocumentTool } from "./mcp-tools/publish-document.js";
import { registerReadDocumentTool } from "./mcp-tools/read-document.js";
import { registerSearchDocumentsTool } from "./mcp-tools/search-documents.js";
import { registerSetDocumentStatusTool } from "./mcp-tools/set-document-status.js";
import { registerSetDocumentTagsTool } from "./mcp-tools/set-document-tags.js";
import { registerUpdateDocumentTool } from "./mcp-tools/update-document.js";
import { registerViewDocumentTool } from "./mcp-tools/view-document.js";

/**
 * Build the MCP server and dispatch a single request. Called from the
 * worker's main fetch handler once auth has resolved.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  props: AwhProps,
  /**
   * The `?tools=` allowlist for THIS connection, already parsed and validated
   * upstream (`parseToolsetParam` in src/mcp-toolset.ts, called from the /mcp
   * dispatch in src/index.ts — an unknown name 400s there, before any of this
   * runs). `null` means no narrowing: all eleven tools, exactly as before the
   * parameter existed.
   */
  allowedTools: ReadonlySet<string> | null = null,
): Promise<Response> {
  const origin = new URL(request.url).origin;

  // PER-REQUEST. Do not hoist. The SDK-v2 factory model is the formal
  // version of this rule: createMcpHandler takes a factory precisely so a
  // fresh server backs each request (instances are still single-connect),
  // and sharing across requests would bleed state (e.g. an in-flight
  // tool's args/results) between concurrent isolates.
  const mcpServer = new McpServer(
    { name: "slopcafe", version: "0.6.0" },
    {
      // `resources` + the `io.modelcontextprotocol/ui` extension key are the
      // MCP Apps advertisement (SEP-1865): an Apps-capable host sees them and
      // fetches the ui:// template; every other client ignores unknown
      // capability keys by construction, so 2025-era connectors are unmoved.
      capabilities: {
        tools: {},
        resources: {},
        extensions: { "io.modelcontextprotocol/ui": {} },
      },
      cacheHints: {
        "tools/list": STATIC_SURFACE_CACHE_HINT,
        "server/discover": STATIC_SURFACE_CACHE_HINT,
        "resources/list": STATIC_SURFACE_CACHE_HINT,
      },
    },
  );

  // NOTE: the full authoring contract (allowlist, SVG subset, URL schemes,
  // stripped table) is NOT an MCP resource — it's an on-platform DOCUMENT
  // (slug `slopcafe-docs-publishing-guide`), readable with the same document
  // tools an agent already uses, in ONE call:
  // read_document slug:"slopcafe-docs-publishing-guide" (or load_context_pack
  // from:"slopcafe-docs-publishing-guide").
  //
  // THE SLUG IS GUARANTEED TO RESOLVE ON THIS INSTANCE (issue #4). It used to
  // name a document in one operator's corpus, so this description could tell a
  // model to make a call that returned `not_found` on any other deployment —
  // and the model had no way to tell "I malformed the call" from "this instance
  // is incomplete". The doc is now bundled with the Worker and seeded into the
  // corpus under the reserved `slopcafe-docs-` namespace (src/seed-docs.ts), so
  // an instruction issued by the server is one its own tools can satisfy. A
  // human reading along can also fetch it at /docs/publishing-guide.
  // It used to be served as the awh://publishing-guide MCP resource, but
  // resources are a human-attach affordance most autonomous clients (Claude
  // web/mobile connectors, ChatGPT) never surface to the model — so neither
  // Claude nor ChatGPT could actually read it (GitHub issue #38). The tool
  // descriptions carry the non-negotiables inline and now point agents at the
  // on-platform doc for the long tail. Single source of truth: the published
  // bytes derive from skills/publishing.md via scripts/build-docs.mjs
  // (bundled) + src/seed-docs.ts (seeded into the corpus).
  //
  // The ONE resource registered below does NOT reopen issue #38's problem:
  // the ui:// app template is a HOST-fetched artifact (an MCP Apps host reads
  // it via resources/read to render view_document inline), not a human-attach
  // resource anything expects a model to be shown — a connector that never
  // surfaces resources simply never fetches it, and view_document still
  // returns its ordinary structured envelope there.

  // The MCP Apps document-viewer template (see the UI_RESOURCE_* constants
  // in src/mcp-apps.ts for the extension wiring and the self-containment
  // constraint).
  // Static per deploy and identical for every principal — the same cache
  // rationale as tools/list, hence the same hint, here per-registration so it
  // covers this resource's `resources/read`. `prefersBorder` asks the host
  // for a visible frame around the view (document-shaped content reads better
  // boxed); it rides both the listing `_meta` and the read content item
  // because SEP-1865 lets the content-item value take precedence.
  mcpServer.registerResource(
    "document-view",
    UI_RESOURCE_URI,
    {
      mimeType: UI_RESOURCE_MIME,
      cacheHint: STATIC_SURFACE_CACHE_HINT,
      _meta: { ui: { prefersBorder: true } },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: UI_RESOURCE_MIME,
          text: DOCUMENT_VIEW_TEMPLATE,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  );

  // ---- toolset gate (issue #59) --------------------------------------------
  //
  // `server` below is NOT the McpServer — it is a registration gate over it.
  // Every tool registrar receives `server`, so each registration passes
  // through `toolsetGate`, which forwards when the connection's allowlist
  // admits that tool and does nothing when it doesn't. Gating at REGISTRATION
  // (rather than registering all eleven and disabling some) is what makes this
  // cheap: the server is built per request, so an excluded tool costs no zod →
  // JSON-Schema conversion, and it is absent from `tools/list` and unknown to
  // `tools/call` because it genuinely was never registered.
  //
  // Why the indirection instead of an `if` around each registration: the
  // registration call sites are read as SOURCE TEXT by the MCP contract tests
  // (annotations, the `_meta` template link, error codes, and keep-list prose).
  // `test/support/mcp-source.mjs` assembles this transport file, shared MCP
  // support, and `src/mcp-tools/*.ts`, keeping those guards pointed at the real
  // registrations as tools move into focused modules.
  //
  // With no `?tools=` this is the McpServer itself — zero indirection, and
  // the served surface is byte-identical to a build without this feature.
  const server = toolsetGate(mcpServer, allowedTools);

  // Registration order IS the wire order (tools/list) and is recorded by
  // MCP_TOOL_NAMES in src/mcp-toolset.ts — keep the two in lockstep. Each
  // registrar receives the gate, never the McpServer, so ?tools= narrowing
  // applies uniformly; the Apps resource above deliberately bypasses it.
  const toolContext: McpToolContext = {
    env,
    agentId: props.agentId,
    clientId: props.clientId,
    origin,
    waitUntil: ctx.waitUntil.bind(ctx), // schedule vector syncs after the D1 batch
  };
  registerPublishDocumentTool(server, toolContext);
  registerUpdateDocumentTool(server, toolContext);
  registerEditDocumentTool(server, toolContext);
  registerSetDocumentTagsTool(server, toolContext);
  registerSetDocumentStatusTool(server, toolContext);
  registerReadDocumentTool(server, toolContext);
  registerViewDocumentTool(server, toolContext);
  registerListDocumentsTool(server, toolContext);
  registerSearchDocumentsTool(server, toolContext);
  registerLoadContextPackTool(server, toolContext);
  registerCreatePublishCredentialTool(server, toolContext);

  // Mount on /mcp, SDK-v2 factory form. The stateless handler invokes the
  // factory at most once per HTTP request (handleMcp itself runs per
  // request, so returning the server built above keeps construction
  // per-request) and serves BOTH protocol eras from it: modern 2026-07-28
  // traffic directly, 2025-era initialize-handshake traffic through the
  // SDK's legacy compatibility lane (the default `legacy: "stateless"`).
  // `authContext` carries `props` to anything in the SDK that calls
  // getMcpAuthContext() — our tool handlers don't need it
  // (they read the McpToolContext), but we set it for consistency.
  const handler = createMcpHandler(() => mcpServer, {
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

/**
 * Wrap a server so `registerTool` is a no-op for any tool the connection's
 * `?tools=` allowlist excludes (issue #59; full rationale in
 * src/mcp-toolset.ts).
 *
 * With `allowed === null` this returns the server unchanged, so the default
 * path adds no wrapper and no per-call test.
 */
function toolsetGate(server: McpServer, allowed: ReadonlySet<string> | null): ToolRegistrar {
  if (allowed === null) return server;
  // The cast is contained here. Every registrar ignores the returned
  // RegisteredTool, so the skip branch has nothing meaningful to return; the
  // alternative — fabricating a RegisteredTool — would be a worse lie.
  const forward = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  const gated = (name: string, ...rest: unknown[]): unknown =>
    allowed.has(name) ? forward(name, ...rest) : undefined;
  return { registerTool: gated as unknown as McpServer["registerTool"] };
}
