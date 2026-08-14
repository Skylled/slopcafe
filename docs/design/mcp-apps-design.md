# MCP Apps (SEP-1865) — design note

**Status: BUILT (mcp-2026-07-28 branch).** Slopcafe documents can render as an inline
interactive view inside MCP Apps-capable hosts (Claude web/desktop, ChatGPT, and the rest of
the [client matrix](https://modelcontextprotocol.io/extensions/client-matrix)) via the official
MCP **Apps extension** (`io.modelcontextprotocol/ui`, ratified as
[SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp),
extension spec revision `2026-01-26`). One new MCP tool (`view_document`, the eleventh), one
`ui://` template resource, zero new dependencies, zero HTTP wire change.

## What this is

The Apps extension lets an MCP server attach a sandboxed HTML "app" to a tool: the host fetches
a **template resource** (`ui://` scheme, mimeType `text/html;profile=mcp-app`) via ordinary
`resources/read`, renders it in an iframe it controls, and pushes each linked tool call's result
into the iframe over a postMessage JSON-RPC bridge (its own dialect, version `"2026-01-26"`).
For Slopcafe that means: when an agent calls `view_document`, the Claude app renders the
document — our sanitized HTML, styles and all — inline in the conversation, instead of the user
squinting at a JSON envelope or clicking out to a URL that may 404 for them (born-private docs).

Three moving parts, all in `src/mcp.ts` + `src/mcp-app-template.html`:

1. **The template resource** — `ui://slopcafe/document-view.html`, registered on every
   per-request `McpServer` instance (stateless factory: the host's `resources/read` arrives as
   its own authenticated POST, possibly *before* any tool call — hosts MAY prefetch). Static
   per deploy and identical for every principal, so it carries the same SEP-2549 `public`/1 h
   cache hint as `tools/list`.
2. **The tool link** — `view_document` declares
   `_meta: { ui: { resourceUri } , "ui/resourceUri": … }` (both the spec's nested spelling and
   the deprecated flat key, matching what the official `registerAppTool` helper emits, for host
   compatibility).
3. **The capability declaration** — the server constructor adds `resources: {}` and
   `extensions: { "io.modelcontextprotocol/ui": {} }`, surfaced through `server/discover`
   (2026-07-28) and the legacy `initialize` lane alike.

## The tool: `view_document`, not a UI on `read_document`

`read_document` is the fleet's ingestion verb — packs, edit round-trips, context loading. Hanging
an app on it would render an iframe on every context read, and its default output is markdown
(the app wants HTML). So the display verb is separate, mirroring the repo's existing
read-vs-render distinctions (`format` html-for-render / markdown-for-ingest):

- `view_document {public_id XOR slug, version?}` → the standard read resolution
  (live slug → tombstone check; a retired-but-redirecting slug returns a `slug_retired` error
  *naming the target* rather than a second envelope shape — a viewer wants one shape; the hop
  stays explicit), then `readDocumentCore` (sanitized H) and an envelope:
  `{public_id, url, title, description, tags, slug, status, superseded_by, visibility,
  published_version, version, content, format:"html", sanitizer_v}`.
- The description draws the line for cold agents: **view = show the human; read = ingest as
  context**. `read_document` gains a one-line cross-reference tail.
- Agent-scoped like every tool; no new authority (an agent key already reads everything — this
  is a presentation affordance, not a new read surface).

## The template: hand-rolled bridge, not the official bundle

The official iframe SDK (`@modelcontextprotocol/ext-apps`) ships `app-with-deps.js` at
**337 KB** (zod bundled in) and peers on MCP SDK **v1** — while our server is SDK v2 with no
front-end build pipeline at all. The bridge surface we actually need is small and stable
(`ui/initialize` handshake → `initialized` → listen for `tool-input`/`tool-result`/
`tool-cancelled`/`host-context-changed`; answer `ping` and `ui/resource-teardown`; emit
`size-changed` and `ui/open-link`), so the template hand-rolls it in ~150 lines of inline JS,
with message shapes taken from the extension's authoritative `schema.json` — the same posture as
the rest of this repo (hand-rolled session crypto, no framework). If the dialect grows past us,
inlining the official bundle is the documented fallback; it is a template-content swap, not an
architecture change.

Template behavior:
- **States**: loading placeholder → (optional) tool-input echo → rendered document, error card
  (`isError` results), or cancelled note. Renders from `structuredContent`, falling back to
  parsing the mirrored JSON text block.
- **Render**: compact chrome bar (title, `v<n>`, visibility badge, "Open on the web" via
  `ui/open-link`) above the document HTML injected into a **shadow root** — the document's own
  `<style>` blocks (allowed since sanitizer v1.4) style the document without reaching the app
  chrome, and vice versa.
- **Links**: clicks inside the document are intercepted and routed through `ui/open-link` as
  absolute URLs (the iframe must not navigate; on-platform `/d/`/`/s/` hrefs resolve against the
  envelope's `url`).
- **Sizing/theme**: `size-changed` notifications via ResizeObserver, capped at the host's
  `containerDimensions.maxHeight`; host style variables + `theme` applied to the chrome, with a
  `prefers-color-scheme` fallback. The document itself stays theme-naive, exactly as on the web.

## Security posture

This is a **third render context** for sanitized H (after our own shell iframe and the raw
route), and it is *stricter* than our wall, not looser:

- The HTML travels as a JSON string inside `resources/read`/tool results — nothing loads from
  our origin, and our CSP headers are irrelevant here. The **host** builds the iframe CSP; with
  no `_meta.ui.csp` domains declared (we declare none) the default is deny-all/self-contained
  (`default-src 'none'; connect-src 'none'; img/media 'self' data:` …). External CSS/font/image
  references inside a document's `<style>` are blocked by the host exactly as our render wall
  blocks them.
- The app iframe holds a tool-calling bridge (`ui/open-link`, proxied `tools/call`), so
  injecting *user* HTML next to it deserves scrutiny. The load-bearing property is the same one
  the whole platform rests on: **sanitized H is script-free by construction** (no `<script>`, no
  `on*=`, no scriptable URL schemes survive ammonia), so injected document content cannot reach
  `postMessage` or the bridge. The template treats it as content only — never interpolated into
  chrome, never `eval`'d, clicks intercepted.
- Claude renders apps from a dedicated sandbox origin (`claudemcpcontent.com` subdomains);
  corporate networks must allowlist it — a host-side concern, noted in the connector guide.
- The bridge's proxied `tools/call` rides the host's existing authenticated connection: the
  Worker sees ordinary authenticated MCP requests, `props.agentId` plumbing untouched. No new
  auth door.

## Deliberate v1 choices (and the follow-ups they imply)

- **The document HTML rides in the tool result** (model context included). The spec's
  `_meta.ui.visibility: ["app"]` could hide the payload from the model — the ideal shape for a
  pure viewer (an 80 KB doc rendered without burning model context) — but host handling of
  app-only results is young; v1 ships the default (`["model","app"]`) and the knob is the
  first follow-up once verified against the live Claude host.
- **No app-side data fetching.** The template renders what the tool result pushes; it does not
  `tools/call` back into the server (spec-legal, and the road to a "refresh"/browse UI), keeping
  v1 independent of host proxy-call support.
- **One template, one tool.** A search-results browser on `search_documents`, a post-publish
  preview on the write tools, and version-history navigation in the viewer are all natural
  extensions — deferred until the viewer proves out.
- **Unconditional registration.** The spec says servers SHOULD check client capabilities before
  registering UI-enabled tools; stateless per-request capability sniffing would mean parsing
  `_meta` out of every request body ourselves. Degradation is graceful by design (a non-Apps
  host sees a normal tool returning a JSON envelope), so we register unconditionally — also the
  reason `view_document`'s result stays model-meaningful.
- **Claude mobile is unconfirmed** as an Apps host (absent from the client matrix); Claude Code
  is not a host. The tool still degrades to a plain read there.

## Compatibility

Additive by construction: 2025-era connectors ignore the extra capability keys and `_meta`;
non-Apps hosts render `view_document` results as ordinary JSON; the legacy `initialize`
compatibility lane is untouched. No HTTP route, no OpenAPI change (`/mcp` is JSON-RPC — MCP
envelopes are deliberately not OpenAPI components), no migration, no new dependency.

## Testing

- `test/contract.test.mjs` round-trips `McpViewDocumentResponseSchema`.
- `test/mcp-errors.test.mjs` pins: both `_meta` spellings on `view_document`, the
  `registerResource` call + exact mime string, the visibility echo on the view envelope, and the
  existing guards (no `visibility` input on any tool) over the enlarged tool set.
- `test/e2e/mcp-apps.sh` drives a running `wrangler dev`: `tools/list` carries the `_meta` link,
  `resources/list`/`resources/read` serve the template, `tools/call view_document` by id and by
  slug returns the envelope, error paths are code-prefixed, and discovery advertises the
  extension.
- Live-host verification (tunnel + Claude custom connector) is a manual step, per the build
  guide: `npx cloudflared tunnel --url http://localhost:8787`, add as a custom connector, ask
  Claude to view a document.
