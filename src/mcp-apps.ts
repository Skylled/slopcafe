// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/** The MCP Apps (SEP-1865) wiring constants: ui:// template, tool _meta link, cache hint. */

// The MCP Apps document-viewer template, bundled as a string by wrangler's
// `[[rules]] type = "Text"` rule (the *.html twin of the CompiledWasm rule).
import DOCUMENT_VIEW_TEMPLATE from "./mcp-app-template.html";

export { DOCUMENT_VIEW_TEMPLATE };

/**
 * SEP-2549 cache hint for the static-per-deploy result surfaces
 * (`tools/list`, `server/discover`, `resources/list`, and — via the
 * per-registration `cacheHint` on the ui:// template below — that resource's
 * `resources/read`). All of them change only on deploy and are identical for
 * every principal — no tool, description, schema, or the app template varies
 * by agent — so `public` scope is honest and the one-hour TTL bounds
 * post-deploy staleness ("a redeploy edited a description") while stopping
 * the per-session refetch churn that destabilizes connector prompt caches.
 * 2026-07-28-era responses only: the 2025 codec has no cache path, so legacy
 * clients' bytes are unchanged (verified — the hint rides a symbol-keyed
 * property the legacy encoder never reads). `prompts/list` stays N/A (no
 * prompts registered).
 */
export const STATIC_SURFACE_CACHE_HINT = {
  ttlMs: 3_600_000,
  cacheScope: "public",
} as const;

// ---- MCP Apps (SEP-1865, extension id `io.modelcontextprotocol/ui`) --------
//
// The document-viewer app: `view_document` links (via tool `_meta`) to an
// HTML template the HOST fetches through ordinary `resources/read` and
// renders in ITS sandboxed iframe under ITS default deny-all CSP. Because the
// host applies that CSP (no network, no external scripts/styles/fonts), the
// template MUST stay fully self-contained — inline CSS + JS only — and we
// declare no `csp` domains in the resource meta on purpose: asking for none
// keeps the strongest sandbox and there is nothing to fetch anyway.
//
// Registration is UNCONDITIONAL on every per-request server instance: the
// factory is stateless, `resources/read` arrives as its own authenticated
// POST, and an Apps-capable host may PREFETCH the template before any tool
// call — so there is no request on which the resource may be absent. Hosts
// that don't know the extension simply ignore `_meta.ui` and the ui://
// resource, and render the tool's structured result normally.
export const UI_RESOURCE_URI = "ui://slopcafe/document-view.html";
/** The MCP Apps template MIME type — exact per SEP-1865; hosts key on it. */
export const UI_RESOURCE_MIME = "text/html;profile=mcp-app";
/**
 * The tool→template link, in BOTH spellings — the nested `ui.resourceUri`
 * (current) and the deprecated flat `"ui/resourceUri"` (what older hosts
 * read) — exactly what the official `registerAppTool` helper emits after its
 * normalization pass. Don't drop either: each generation of host reads only
 * its own key.
 *
 * SHARED by view_document AND the three content-write tools
 * (publish_document / update_document / edit_document): on an Apps host a
 * write result renders the just-published document inline (the post-publish
 * preview). The write envelopes carry NO body, so on a write result the
 * template fetches the document itself via the bridge's proxied
 * `tools/call view_document` (see mcp-app-template.html's envelope
 * discrimination); on a non-Apps host the `_meta` is inert and the writes
 * behave exactly as before. The classification/list/search/pack/credential
 * tools deliberately get NO `_meta` — nothing visual to show.
 */
export const DOC_VIEW_TOOL_META = {
  ui: { resourceUri: UI_RESOURCE_URI },
  "ui/resourceUri": UI_RESOURCE_URI,
} as const;
