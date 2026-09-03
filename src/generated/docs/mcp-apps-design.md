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
  parsing the JSON text block — which for `view_document` is the *slim* model-facing summary
  (no body), so the fallback routes through the same envelope discrimination as a write result
  (see the post-publish preview section) and still ends in a rendered document.
- **Render**: compact chrome bar (title, `v<n>`, visibility badge, "Open on the web" via
  `ui/open-link`) above the document HTML rendered in a **nested sandboxed `srcdoc` iframe**
  (`sandbox="allow-same-origin"` exactly — script execution stays off). A real child document
  gives the sanitized H an html/body of its own, so the document's `:root`/`body`/`<style>`
  rules apply exactly as on the web without reaching the app chrome. The frame is sized from
  its content, **measured at height 0** (the child's `100vh`/`min-height:100vh` rules resolve
  against the frame viewport, so measuring at the current height ratchets and never shrinks);
  when the host caps our height the child scrolls inside the frame. A shadow-root injection is
  kept as the degraded fallback (next section).
- **Links**: clicks inside the child document are intercepted (re-attached per load — each
  `srcdoc` assignment is a fresh document, so listeners never stack) and routed through
  `ui/open-link` as absolute URLs (the iframe must not navigate; on-platform `/d/`/`/s/` hrefs
  resolve against the envelope's `url`); pure-fragment hrefs scroll within the child.
- **Sizing/theme**: `size-changed` notifications capped at the host's
  `containerDimensions.maxHeight`; the frame is re-measured on load (plus two short-delay
  re-measures — data:-only assets settle fast), on host-context changes, and on outer resizes
  via the existing ResizeObserver (deliberately no cross-document ResizeObserver). Host style
  variables + `theme` applied to the chrome, with a `prefers-color-scheme` fallback. The
  document itself stays theme-naive, exactly as on the web.

**Why a nested iframe (and not the v1 shadow root).** The first build injected the document into
a shadow root for style isolation, and the live Claude host exposed the fidelity gap (confirmed
against a real doc): real-world documents style `:root` (their CSS variables) and `body`
(background, `min-height:100vh`, flex centering) — a shadow tree contains no html/body and
`:root` matches nothing inside one, so those rules silently dropped and the doc rendered with no
dark background and unset variables. Shadow DOM was the wrong isolation primitive for full-page
documents. Empirically (tested in Chrome against the exact Apps default CSP served as a real
header — `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'
'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'`), an
`<iframe srcdoc>` renders fully under that policy: load fires, `contentDocument` is reachable
with `allow-same-origin`, body-scoped styles apply — Chromium treats `about:srcdoc` as
inheriting the parent's policy, not as a `frame-src` fetch, so no `frameDomains` declaration is
needed. The extension schema's reading (omitted `frameDomains` ⇒ `frame-src 'none'`) could bind
on a non-Chromium host, so the template keeps the shadow-root injection as a fallback — engaged
when the load event doesn't fire within a short watchdog window or `contentDocument` is
inaccessible after load, sticky once engaged, with the known selector limitation documented in
place. Partial fidelity beats a blank frame.

## The post-publish preview (writes share the template)

The three content-write tools (`publish_document` / `update_document` / `edit_document`) carry
the SAME `_meta` template link as `view_document` (one shared constant, `DOC_VIEW_TOOL_META` in
`src/mcp.ts`), so on an Apps host a successful write renders the just-published document inline
— the natural "here's what you made" moment — with no extra model call. The write envelopes
deliberately carry no body, so the template discriminates in `onToolResult`:

- envelope has `content` (a view envelope) → render directly;
- envelope has `public_id` but no `content` (a write envelope — or `view_document`'s slim text
  block on a host that strips `structuredContent`) → show a "Rendering published document…"
  state and fetch the body itself via the bridge's **proxied
  `tools/call view_document`**, *version-pinned to the version just written* so a concurrent
  write can't race the preview (the fetched envelope still reports document-level metadata for
  the header).

Degradation is deliberate and never an error card, because the WRITE succeeded — the preview is
the nicety: a JSON-RPC error, an `isError` result, a missing/empty body, or a host that never
answers proxied calls (a ~3 s watchdog, same style as the srcdoc watchdog) all fall back to a
**metadata card** — the header bar populated from the write envelope plus "Published vN — use
Open on the web to view". A generation counter guards re-entrancy: any newer tool-result
supersedes an in-flight fetch, so a stale fetch response can never clobber a newer render. On a
non-Apps host the `_meta` is inert and the writes behave exactly as before. The
classification/list/search/pack/credential tools carry no `_meta` — nothing visual to show.

## Keeping the body out of model context

`view_document`'s success result no longer mirrors its envelope into the model-facing text
block. Hosts feed `content` text blocks to the MODEL and `structuredContent` to the APP (the
build guide calls `structuredContent` "structured data optimized for UI rendering (not added to
model context)") — that **field-level split is the extension's actual lever** for rendering
without burning model context. So `structuredOkAppSummary` (a sibling of `structuredOk`,
`src/mcp.ts`) sends the full envelope — body included — as `structuredContent` for the viewer,
while the text block carries the envelope MINUS `content`/`sanitizer_v` plus a `note` pointing
the model at `read_document`. SDK `outputSchema` validation runs on `structuredContent`, so the
envelope contract (`McpViewDocumentResponseSchema`) is unchanged.

Two guardrails worth stating so they aren't re-litigated:

- **Do NOT use `_meta.ui.visibility: ["app"]` for this.** An earlier draft of this note read
  that field as a result-payload knob. Per the shipped ext-apps schema, `visibility` governs
  who may SEE/CALL the **tool** (`"model"`: visible to and callable by the agent; `"app"`:
  callable by the app from this server only) — `["app"]` would remove `view_document` from the
  model's `tools/list` entirely and break the tool.
- **Only `view_document` slims.** The three write tools keep `structuredOk`'s mirror-both
  convention: their envelopes are small and agents parse the text block. The deliberate break
  from that convention is scoped to the one tool whose payload (a whole document body) is
  exactly the cost it exists to avoid; `test/mcp-errors.test.mjs` pins both sides.

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
  chrome, never `eval`'d, clicks intercepted — and renders it in a nested iframe **sandboxed
  without `allow-scripts`**, which MIRRORS the production render wall (the shell iframe's empty
  sandbox): even a hypothetical sanitizer bypass cannot execute there, in either render context.
  `allow-same-origin` is the one flag granted, justified by exactly that script-free property —
  the parent must reach into a passive document to measure it and intercept its links, and there
  is no script inside to abuse the origin. (The degraded shadow-root fallback has no frame
  boundary, so there its safety rests on script-free H + the host CSP alone — the same posture
  the v1 build shipped for every render.)
- Claude renders apps from a dedicated sandbox origin (`claudemcpcontent.com` subdomains);
  corporate networks must allowlist it — a host-side concern, noted in the connector guide.
- The bridge's proxied `tools/call` rides the host's existing authenticated connection: the
  Worker sees ordinary authenticated MCP requests, `props.agentId` plumbing untouched. No new
  auth door.

## Deliberate v1 choices (and the follow-ups they imply)

- **The document HTML stays out of model context** — BUILT, via the `content`/
  `structuredContent` field split (see "Keeping the body out of model context" above). An
  earlier draft of this bullet proposed `_meta.ui.visibility: ["app"]` for this; that was a
  misreading (it governs tool visibility, not result routing) and is called out above so it
  isn't re-introduced.
- **App-side data fetching exists, narrowly.** The template `tools/call`s back into the server
  in exactly one case: fetching the body a write envelope doesn't carry (the post-publish
  preview), version-pinned and watchdog-guarded, degrading to a metadata card where host
  proxy-call support is absent. A "refresh"/browse UI remains unbuilt.
- **One template, four tools.** The write tools now share the viewer template (post-publish
  preview). A search-results browser on `search_documents` and version-history navigation in
  the viewer remain natural extensions — deferred until the viewer proves out.
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
