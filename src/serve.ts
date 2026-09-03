// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Web serve path for `GET /d/:public_id`.
 *
 * Split across two URLs because the action plan's strict CSP includes
 * `frame-ancestors`, which is header-only — there's no `<meta>` equivalent.
 * So the iframe content must come from an HTTP response, not from `srcdoc`.
 *
 *   GET /                       → public landing page: homepage doc in a toolbar-less shell
 *   GET /d/:public_id           → tiny HTML shell with toolbar + <iframe sandbox src=…/raw>
 *   GET /d/:public_id/raw       → sanitized bytes streamed from R2, locked-down CSP
 *   (The operator plane — GET/POST /d/:public_id/revoke, GET /d/:public_id/manage
 *   and its form POSTs — lives in manage.ts, which imports FROM this file; the
 *   edge is one-way.)
 *
 * Shell + raw 404 if the document is missing or `revoked_at` is set. All
 * routes send `Cache-Control: no-store` so a revoke really is the kill
 * switch the action plan promises.
 *
 * PUBLISHED-VERSION PINNING (issue #43, migration 0018) — the load-bearing rule
 * of this file. A public document does NOT render whatever an agent wrote last;
 * it renders the version an operator PROMOTED. Any active agent key can
 * overwrite any live document (single-tenant trust), so without this the
 * open-web surface of every public document is agent-writable: overwrite a
 * public doc with a private one's contents and it is exfiltrated to anonymous
 * readers. Decoupling "which bytes are published" from "which bytes are
 * current" closes that:
 *
 *   served version = (visibility === 'public' && published_ver !== null)
 *                      ? published_ver : current_ver
 *
 * `SERVED_VER_SQL` / `servedVersion` below are the ONE copy of that rule, and
 * every HTML byte-path query in this file resolves through it — the shell, the
 * homepage, `/raw`, and the slug shell. Two families deliberately stay on
 * `current_ver`: the credentialed machine surfaces (`/text`, `/source`,
 * `/links`, and everything behind MCP / search / packs), which are the writing
 * fleet's own view of its own corpus and must show an agent what it last wrote;
 * and the operator's explicit version reads (`/d/:id/v/:n`), which name a
 * version outright, so there is nothing to resolve. Adding a new HTML render
 * site means joining through SERVED_VER_SQL — a site left on `current_ver` is
 * a hole in the wall, not a cosmetic inconsistency.
 */

import { canRead, type Principal, resolvePrincipal, type Visibility } from "./access.js";
import { etagForVersion, ifNoneMatchSatisfied } from "./conditional.js";
import { SERVED_VER_SQL, servedVersion } from "./served-version.js";
import {
  findDocumentBySlugCore,
  findSlugTombstoneCore,
  readDocumentSourceCore,
  readDocumentTextCore,
  type RedirectTarget,
  resolvePublicIdBySlug,
  resolveRedirectTarget,
} from "./core.js";
import type { Env } from "./env.js";
import { escapeHtml, formatCreatedAt } from "./html.js";
import { PUBLIC_ID_RE } from "./ids.js";
import { documentLinksCore } from "./links-core.js";
import { authenticateOperatorRequest } from "./session.js";
import {
  formatPageTitle,
  SITE_BRAND,
  validateSlugInput,
  normalizeTitleForDisplay,
  normalizeDescriptionForDisplay,
} from "./metadata.js";

/** Headers shared by both routes. Browsers see HTML, no leaks, no caching.
 *  Exported for manage.ts (the operator manage/revoke pages) so its responses
 *  carry the identical set. */
export const COMMON_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  // Strip Referer so the secret URL doesn't leak to outbound link destinations.
  "referrer-policy": "no-referrer",
  // Defense-in-depth against MIME sniffing inside the rendered doc.
  "x-content-type-options": "nosniff",
  // noindex belt-and-suspenders: instruct search engines not to index these capability URLs
  "x-robots-tag": "noindex",
};

/**
 * Shell page CSP. Tight: we author this HTML, so it needs only inline styles
 * for layout, a frame source pointing at our own origin, and our own toolbar
 * script.
 *
 * `script-src 'self'` admits ONLY same-origin scripts (the toolbar enhancement
 * at `/shell.js`). This is safe and does NOT weaken the document sandbox, which
 * lives in a *separate* response: the framed bytes at `/d/:id/raw` are governed
 * by RAW_CSP (`default-src 'none'`, no script) AND by the `<iframe sandbox>`
 * attribute (no `allow-scripts`) — neither is touched here. Crucially we use
 * `'self'`, never `'unsafe-inline'`: the shell interpolates escaped document
 * metadata (title/description/author), and `'self'` means an injected inline
 * `<script>` (or `<script src>` pointing at a doc, which `nosniff` blocks from
 * executing) still can't run even if escaping ever failed. `base-uri 'none'`
 * keeps a `<base>` from repointing the relative script URL.
 *
 * `frame-ancestors 'none'` — the shell is the top-level page, never embedded.
 * `form-action 'none'` — the shell intentionally hosts no forms; the toolbar
 * menu items are links to dedicated pages (revoke confirm, login, logout) that
 * have their own CSP.
 */
const SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Rendered-document CSP. The load-bearing wall from docs/design/action-plan-v1.md.
 *   - `script-src` is covered by `default-src 'none'`
 *   - `style-src 'unsafe-inline'` covers BOTH inline `style="…"` attributes
 *     AND `<style>` blocks — both are allowed through the sanitizer as of
 *     v1.4, and `'unsafe-inline'` permits each (CSS is inert under the
 *     no-`allow-scripts` sandbox; external CSS stays blocked by `default-src`)
 *   - `img/style/font` allow `data:` for inlined assets (e.g. `@font-face`
 *     with a `data:` font, `data:`-URI backgrounds)
 *   - `frame-ancestors 'self'` so only our shell may embed this URL
 */
const RAW_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline' data:",
  "font-src 'self' data:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * CSP for the static link-only cards: the HTML 404 page (browser document
 * routes), the retired-slug 410 card, and the redirect interstitial. Each
 * hosts only links (sign-in / home / continue) — no forms, no scripts — so
 * `form-action 'none'`. Today these pages interpolate nothing or only
 * escaped+normalized values, so the CSP is defense-in-depth, not the wall —
 * but EVERY server-rendered HTML response must carry one (see the CLAUDE.md
 * convention) so a future edit can't silently ship an unprotected page.
 */
const NOTFOUND_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Iframe sandbox flags. The two most dangerous capabilities stay OFF:
 *   - no `allow-scripts`     — the document can never run JavaScript
 *   - no `allow-same-origin` — it can never act as our origin / read storage
 * (and with both off it can't lift its own sandbox, either).
 *
 * We DO grant popups so external links can open in a new browser tab.
 * In-frame navigation to any off-origin URL is blocked by the shell's own
 * `frame-src 'self'` (and most sites also send frame-ancestors / XFO), so a
 * plain external link otherwise dead-ends. `allow-popups` lets a clicked
 * `<a target="_blank">` open a tab; `allow-popups-to-escape-sandbox` makes
 * that tab a normal, non-sandboxed top-level context so the destination
 * actually renders (without it the popup inherits the sandbox and loads
 * scriptless/broken).
 *
 * Why this is safe:
 *   - No `allow-scripts` ⇒ no programmatic `window.open`; the ONLY way to
 *     spawn a popup is a real user click on an anchor (forms are dead via
 *     CSP `form-action 'none'`).
 *   - The sanitizer forces `rel="noopener noreferrer"` on every link, so
 *     the escaped tab can't reach `window.opener`.
 *   - `Referrer-Policy: no-referrer` (COMMON_HEADERS) + the iframe's
 *     `referrerpolicy="no-referrer"` keep the secret `/raw` URL — the
 *     document capability — from leaking to the destination.
 *
 * Still OFF: `allow-top-navigation*` — a link must never replace the shell
 * itself; new tab only.
 */
const SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/**
 * Toolbar enhancement script, served at `GET /shell.js` and loaded by the shell
 * under `script-src 'self'` (see SHELL_CSP). It is PURE PROGRESSIVE ENHANCEMENT
 * over the native `<details>` kebab menu: with JS disabled (or this fetch
 * blocked) the menu still opens/closes via the `<summary>` toggle and every item
 * is a plain link. The script only adds the niceties `<details>` can't do
 * itself — close on Escape (returning focus to the trigger), close on an
 * outside click, and keep `aria-expanded` in sync for assistive tech.
 *
 * It runs ONLY in the top-level shell document, never in the sandboxed iframe
 * (that frame has no `allow-scripts` and loads under `default-src 'none'`), so
 * it can't touch untrusted document bytes. It's a fixed server-side constant —
 * no document/user data is interpolated — and references nothing global beyond
 * the standard DOM. Keep it dependency-free and inert when the menu is absent.
 */
const SHELL_SCRIPT = `(function(){
  var d=document.querySelector("details.menu");
  if(!d)return;
  var s=d.querySelector("summary");
  function syncAria(){if(s)s.setAttribute("aria-expanded",d.open?"true":"false");}
  function close(){d.removeAttribute("open");}
  syncAria();
  d.addEventListener("toggle",syncAria);
  document.addEventListener("pointerdown",function(e){
    if(d.open&&!d.contains(e.target))close();
  });
  document.addEventListener("keydown",function(e){
    if(e.key==="Escape"&&d.open){close();if(s)s.focus();}
  });
})();
`;

/**
 * GET /shell.js — the toolbar enhancement script (see SHELL_SCRIPT). `nosniff` +
 * an explicit JS content-type are what let `script-src 'self'` admit it: a
 * `text/html` response could never be coerced into executing as a script.
 *
 * `no-store`, matching the shell HTML that loads it. The script URL is NOT
 * content-hashed, so a long cache would let a deployed change sit stale in
 * browsers for the TTL while the always-fresh (`no-store`) shell HTML already
 * references the new behavior — an HTML-fresh/script-stale skew. The payload is
 * a few hundred bytes, so refetching per shell load is negligible; freshness
 * wins. (If this ever grows, switch to a content-hashed URL + immutable cache.)
 */
export function serveShellScript(): Response {
  return new Response(SHELL_SCRIPT, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Reading theme injected into Markdown-sourced documents at serve time.
 *
 * A Markdown doc is stored as a bare sanitized HTML fragment with no author
 * styling — the Markdown→HTML parse emits plain `<h1>/<p>/<ul>/…`, and the
 * sanitizer would strip a `<style>` block (and `<link>`/external CSS is off the
 * allowlist) even if we tried to store one. So without this the page renders
 * with the browser's stark, full-width defaults. The theme therefore lives
 * HERE, in serving code the sanitizer never touches.
 *
 * Why this is safe and needs no security change:
 *   - It's a fixed server-side constant. No document/user data is interpolated,
 *     and the document bytes always follow the closing `</style>`, so there is
 *     no CSS-injection surface.
 *   - It sits entirely inside RAW_CSP's existing `style-src 'unsafe-inline'`
 *     allowance — no CSP edit.
 *   - The dark theme is a pure `prefers-color-scheme` media query: no JS, which
 *     is exactly why it works inside the scriptless `<iframe sandbox>`.
 *   - Stored R2 bytes are untouched; the `/text` (Markdown) derivation and the
 *     FTS index read the stored bytes, never this served-with-prefix form.
 *
 * Selectors are low-specificity (bare element selectors + `:root` custom
 * properties), so any inline `style=` the author embedded via raw HTML in their
 * Markdown still wins. HTML-authored documents do NOT get this — serveRaw
 * passes those through byte-for-byte, because their author owns presentation.
 *
 * The leading `<!doctype html>` flips the iframe out of quirks mode (a bare
 * fragment has no doctype) into standards mode. The reading column is the
 * implicit `<body>` (`max-width` + auto margins) with the page backdrop on
 * `<html>`, so no wrapper element is needed and the whole thing is a
 * prepend-only splice ahead of the streamed R2 bytes.
 */
const READER_THEME_CSS = `
:root{color-scheme:light dark;--bg:#f4f2ee;--surface:#fbfaf7;--text:#2c2a27;--muted:#6b655c;--heading:#1b1a17;--link:#3a6ea5;--link-hover:#2c5580;--rule:#e6e1d7;--code-bg:#efece4;--quote:#d8d2c6;--mark:#f6e6a8;--thead:#efece4}
@media (prefers-color-scheme:dark){:root{--bg:#1a1917;--surface:#201f1c;--text:#d8d4cd;--muted:#9a948a;--heading:#ededea;--link:#8ab4e8;--link-hover:#a9c8ef;--rule:#33302b;--code-bg:#2a2825;--quote:#3a3631;--mark:#5c4a1f;--thead:#262420}}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--bg);-webkit-text-size-adjust:100%}
body{max-width:44rem;margin:0 auto;padding:3.5rem 1.5rem 6rem;background:var(--surface);color:var(--text);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:17px;line-height:1.7;min-height:100vh;overflow-wrap:break-word}
@media (max-width:34rem){body{padding:2rem 1.1rem 4rem;font-size:16px}}
h1,h2,h3,h4,h5,h6{color:var(--heading);line-height:1.25;font-weight:650;letter-spacing:-.01em;margin:2.4em 0 .8em}
h1{font-size:2rem;margin-top:0}
h2{font-size:1.45rem;padding-bottom:.3em;border-bottom:1px solid var(--rule)}
h3{font-size:1.2rem}h4{font-size:1.05rem}h5,h6{font-size:1rem}h6{color:var(--muted)}
p,ul,ol,dl,blockquote,table,pre,figure,hr{margin:0 0 1.15em}
a{color:var(--link);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:.07em}
a:hover{color:var(--link-hover);text-decoration-thickness:.14em}
strong,b{font-weight:650;color:var(--heading)}
ul,ol{padding-left:1.5em}
li{margin:.3em 0}
li::marker{color:var(--muted)}
li>ul,li>ol{margin:.3em 0}
dt{font-weight:650;color:var(--heading)}
dd{margin:0 0 .5em 1.2em;color:var(--muted)}
blockquote{padding:.2em 0 .2em 1.2em;border-left:3px solid var(--quote);color:var(--muted)}
blockquote>:last-child{margin-bottom:0}
code,kbd,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
code{font-size:.9em;background:var(--code-bg);padding:.12em .38em;border-radius:4px}
pre{background:var(--code-bg);padding:1em 1.15em;border-radius:8px;overflow-x:auto;line-height:1.5}
pre code{background:none;padding:0;font-size:.86em}
kbd{font-size:.85em;background:var(--code-bg);border:1px solid var(--rule);border-bottom-width:2px;border-radius:4px;padding:.1em .4em}
hr{border:0;border-top:1px solid var(--rule);margin:2.4em 0}
table{border-collapse:collapse;width:100%;font-size:.95em}
th,td{border:1px solid var(--rule);padding:.5em .7em;text-align:left;vertical-align:top}
thead th{background:var(--thead)}
img,svg{max-width:100%;height:auto}
figure{text-align:center}
figcaption{color:var(--muted);font-size:.9em;margin-top:.5em}
mark{background:var(--mark);color:inherit;padding:.05em .2em;border-radius:3px}
del{color:var(--muted)}
sub,sup{font-size:.75em}
abbr[title]{text-decoration:underline dotted;cursor:help}
`;

/** Prepended to Markdown-doc bodies at serve time. See READER_THEME_CSS.
 *  Exported for the bundled platform docs (src/platform-docs.ts), which are all
 *  Markdown-sourced and must read identically to a published Markdown document
 *  — one theme, one definition. */
export const READER_THEME_PREFIX = `<!doctype html>\n<style>${READER_THEME_CSS}</style>\n`;

/**
 * Wrap an R2 body stream so `prefix` is emitted first, then the body bytes,
 * without buffering the body in the Worker — keeps serveRaw's streaming
 * pass-through for the (potentially large) document bytes while letting us
 * splice the reading theme ahead of them.
 */
function streamWithPrefix(
  prefix: string,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * 404 used for both missing rows and revoked documents. Indistinguishable
 * by design — we don't want to confirm that an id ever existed.
 *
 * This is the BYTE/HTML-surface 404 (`/raw`, the version-raw route, the shells
 * that fall back from `notFoundBrowser`). The machine-readable routes use
 * `notFoundJson` below; the two must stay equally uninformative. Exported for
 * manage.ts, whose operator pages 404 with these exact bytes.
 */
export function notFound(): Response {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", ...COMMON_HEADERS },
  });
}

/**
 * `Link` header pointing at the generated OpenAPI document, using the IANA
 * `service-desc` relation (RFC 8631) — the standard "here is this API's machine
 * description" affordance. Attached to the JSON error responses an agent is
 * likeliest to hit while lost, so a caller holding nothing but a base URL and a
 * key can bootstrap from any failed probe. `/healthz` carries the same pointer
 * in its body. Relative-ref on purpose: it resolves against whatever origin
 * answered, so dev/staging/production each self-describe without a baked host.
 *
 * Exported because `admin.ts` (the JSON admin + reader surfaces) and `index.ts`
 * (the agent write door + the catch-all) attach the same header. `session.ts`
 * keeps its own copy rather than importing this — `serve.ts` imports `session.ts`,
 * so the reverse edge would be a module cycle.
 */
export const SERVICE_DESC_LINK = '</openapi.json>; rel="service-desc"';

/**
 * The tail every credentialed-route 401 carries, so an unauthenticated probe
 * teaches instead of just refusing. Same reasoning as SERVICE_DESC_LINK: the
 * only in-band path from "I have a key and a base URL" to "I know the routes"
 * used to be guessing.
 */
export const API_DISCOVERY_HINT =
  " — see /openapi.json for the routes and auth scheme, or /healthz for the API map";

/** The body of an opaque JSON 404 when the caller's own request gives us
 *  nothing safe to add. */
const NOT_FOUND_MESSAGE =
  "no such document — it may never have existed, or it may have been revoked";

/**
 * Opaque JSON 404 for the CREDENTIALED, machine-readable routes: `/text`,
 * `/source`, `/links`.
 *
 * Same opacity contract as `notFound()` — missing, revoked, and malformed-id
 * all answer identically — but in the shape those routes' OTHER failures
 * already use. `unauthorizedJson`'s 401 and `/source`'s `source_unavailable`
 * 409 are both `{ error, message }`, so a bare `text/plain` body made the most
 * common failure ("that document isn't there") the one case a JSON client
 * couldn't parse; docs/http-api.md has documented these 404s as a `not_found`
 * error code all along. This is the code catching up to the contract.
 *
 * `message` is the only thing that varies, and callers derive it ONLY from the
 * caller's own path segment (see `idShapeHint`) — never from anything we looked
 * up. A private or revoked document's 404 stays byte-identical to a
 * nonexistent one's for the same URL.
 */
function notFoundJson(message: string = NOT_FOUND_MESSAGE): Response {
  return new Response(JSON.stringify({ error: "not_found", message }), {
    status: 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
      link: SERVICE_DESC_LINK,
      ...COMMON_HEADERS,
    },
  });
}

/**
 * The one hint an id-shaped 404 may carry — built PURELY from the caller's own
 * path segment, with no DB read, so it can never become an existence oracle.
 *
 * The `/d/:public_id/*` routes take the 22-char capability id, but every
 * document in this corpus is *named* by its slug: `/s/<slug>` is the shareable
 * handle and every cross-document link uses it. So "I only know this doc as
 * `slopcafe-http-api`" is the overwhelmingly likely reason a segment fails
 * PUBLIC_ID_RE, and `GET /d?slug=…` exists precisely to close that gap (see
 * `listDocumentsForReader`). Naming it turns a dead end into the next call.
 * It has already bitten at the 22-char boundary, where a slug is
 * indistinguishable from an id by length alone.
 *
 * We deliberately do NOT auto-resolve a slug in the id slot: the two address
 * different things (a capability vs a public name), and silently accepting
 * either would make the distinction mushy — the caller would stop knowing which
 * one it holds, which is exactly how a shared `/s/<slug>` ends up treated as an
 * unguessable URL.
 *
 * `slugRoute` names the slug-addressed twin when one exists — `/text` has
 * `/s/:slug/text`; `/source`, `/links` and `PUT /d/:id` have none, so they
 * point only at the resolver. The echoed value is the slug-VALIDATED,
 * normalized form (≤64 chars of `[a-z0-9_-]`), so it is charset-safe and
 * length-bounded in both a URL and a JSON string — a segment that fails
 * validation is never echoed at all.
 *
 * Exported for `PUT /d/:public_id` (index.ts) and the `/admin/documents/:id/*`
 * mutators (admin.ts), whose `not_found`s hit the same dead end for the same
 * reason. Those call sites reach here AFTER a DB miss rather than after a
 * shape check, so the PUBLIC_ID_RE guard below is load-bearing: a well-formed
 * lowercase public_id also satisfies the slug charset, and telling its owner
 * "that isn't a public_id" would be actively wrong.
 */
export function idShapeHint(id: string, slugRoute: (slug: string) => string | null): string {
  if (PUBLIC_ID_RE.test(id)) return NOT_FOUND_MESSAGE;
  const v = validateSlugInput(id);
  if (!v.ok) return NOT_FOUND_MESSAGE;
  const direct = slugRoute(v.slug);
  return (
    `"${v.slug}" is not a 22-character public_id. If it is a slug, resolve it with ` +
    `GET /d?slug=${v.slug} and use the row's public_id here` +
    (direct ? `, or read it directly at GET ${direct}` : "") +
    "."
  );
}

/**
 * HTML 404 for BROWSER document navigations (the `/d/:id` shell + the `/s/:slug`
 * shell surfaces). Carries a **Sign in** link that round-trips back to the
 * current URL via `/login?next=…`. The motivation: now that documents can be
 * `private` (migration 0011), a perfectly valid URL returns `404` to a
 * logged-out operator — signing in (`canRead(operator) == true`) then renders
 * the document, and the `next` lands them right back here.
 *
 * Shown UNIFORMLY on every browser doc 404 — nonexistent, revoked, malformed
 * id/slug, OR private-to-anonymous alike — so it is **not an existence oracle**:
 * a private document's 404 stays byte-identical to a nonexistent one. The copy
 * says a private document *can* read as "not found" here, never that THIS URL is
 * one. Agent/API 404s keep the plain `notFound()` body (they authenticate and
 * never want HTML); the dual-use slug sites choose by the `Authorization` header.
 */
function notFoundBrowser(req: Request): Response {
  const url = new URL(req.url);
  const next = `${url.pathname}${url.search}`;
  // encodeURIComponent already yields no HTML-special chars for a path; escape is
  // belt-and-suspenders, matching renderShell's loginHref. /login re-validates
  // `next` via validateNext, so a hostile value can't survive to the redirect.
  const loginHref = escapeHtml(`/login?next=${encodeURIComponent(next)}`);
  return new Response(renderNotFoundPage(loginHref), {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": NOTFOUND_CSP,
      ...COMMON_HEADERS,
    },
  });
}

/** The 404 card (reuses the gone/revoke page chrome). Static copy — no per-URL
 *  detail — so it discloses nothing about whether the target exists. */
function renderNotFoundPage(loginHref: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Not found | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 12px;font-weight:600}
p{margin:0 0 16px;color:#555}
a.btn{display:inline-block;padding:9px 16px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;text-decoration:none}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
</style>
</head>
<body>
<div class="card">
<h1>Not found</h1>
<p>This link doesn't point to anything we can show you. It may never have existed, or it may have been removed.</p>
<p>If you're the operator: a valid link can read as "not found" when its document is <b>private</b>. Sign in to check.</p>
<p><a class="btn" href="${loginHref}">Sign in</a></p>
<p class="note"><a href="/">Go to ${SITE_BRAND}</a></p>
</div>
</body>
</html>
`;
}

/**
 * 410 Gone for a RETIRED slug — a slug some document once carried that is now
 * permanently reserved (migration 0009): the doc was revoked, or the slug was
 * renamed/released. Distinct from notFound()'s 404 (a slug no document ever
 * claimed), and the distinction is intentional: a slug is a PUBLIC, shareable
 * handle, so "this was removed" is honest UX worth disclosing — unlike a
 * capability `public_id`, where existence itself is the secret.
 *
 * Two bodies, chosen by the caller from the request's `Authorization` header so
 * the slug surface's content-negotiation contract is preserved: a friendly HTML
 * card for browsers, machine-readable JSON for agent-key callers. (Chunk 2 will
 * branch earlier on a tombstone that carries a redirect — this is the
 * no-redirect terminal case.)
 */
function goneHtml(): Response {
  const html = renderGonePage();
  return new Response(html, {
    status: 410,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": NOTFOUND_CSP,
      ...COMMON_HEADERS,
    },
  });
}

function goneJson(): Response {
  return new Response(
    JSON.stringify({
      error: "gone",
      message:
        "this slug is retired: the document it pointed to was revoked, or the slug was " +
        "renamed or released. Slugs are not reused, so this handle will not resolve again.",
    }),
    { status: 410, headers: { "content-type": "application/json", ...COMMON_HEADERS } },
  );
}

/**
 * Friendly 410 card for a retired slug, reusing the revoke page's card chrome.
 * No per-slug detail (no title, no origin doc) — a retired slug discloses only
 * that it once existed, not what it pointed to. Static, so no escaping needed.
 */
function renderGonePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Link retired | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 12px;font-weight:600}
p{margin:0 0 16px;color:#555}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
</style>
</head>
<body>
<div class="card">
<h1>This link is retired</h1>
<p>The document that lived at this address was removed, or its handle was changed. This link will not be reused for a different document, so it won't start pointing somewhere unexpected.</p>
<p class="note"><a href="/">Go to ${SITE_BRAND}</a></p>
</div>
</body>
</html>
`;
}

/**
 * Canonical same-origin path for a redirect target: its pretty `/s/<slug>` if it
 * still carries a slug, else the capability `/d/<public_id>`. Both components
 * are charset-validated at the source (slug regex / PUBLIC_ID_RE), so the path
 * is safe to build; callers still escape it before putting it in HTML.
 */
function targetCanonicalPath(target: RedirectTarget): string {
  return target.slug ? `/s/${target.slug}` : `/d/${target.public_id}`;
}

/**
 * Machine-readable response for a retired slug that carries a redirect, when the
 * caller has NOT opted into following it. `409 slug_redirected`, deliberately
 * NOT a 3xx: curl `-L` and most HTTP libraries auto-follow 3xx silently, which
 * is the opposite of the loud, opt-in behavior we want. A 4xx makes the client
 * stop and read the body; 409 (vs 410's terminal "gone") signals "recoverable —
 * opt in to follow." The agent follows by re-requesting with
 * `?follow_redirects=true` (HTTP) or reading the target's public_id directly.
 */
function slugRedirectedJson(slug: string, target: RedirectTarget): Response {
  return new Response(
    JSON.stringify({
      error: "slug_redirected",
      message: `this slug now redirects to another document; it is not served here`,
      slug,
      redirect_to: {
        public_id: target.public_id,
        slug: target.slug,
        title: target.title,
      },
      hint: "retry with ?follow_redirects=true to be served the target, or read it by its public_id",
    }),
    { status: 409, headers: { "content-type": "application/json", ...COMMON_HEADERS } },
  );
}

/**
 * Loud browser interstitial for a retired slug that redirects: a card the human
 * must click through, never an automatic 3xx. This is the deliberate "this name
 * moved — go there?" gate (operator branding/consolidation, or a rename's
 * auto-forward). The link points at the target's current canonical URL.
 */
function redirectInterstitial(target: RedirectTarget): Response {
  const href = escapeHtml(targetCanonicalPath(target));
  const titleRaw = target.title ? normalizeTitleForDisplay(target.title) : "";
  const label = escapeHtml(titleRaw.length > 0 ? titleRaw : targetCanonicalPath(target));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Link moved | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 12px;font-weight:600}
p{margin:0 0 16px;color:#555}
.row{display:flex;gap:8px;margin-top:18px}
a.go{flex:1;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;text-align:center;text-decoration:none;box-sizing:border-box}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
</style>
</head>
<body>
<div class="card">
<h1>This link has moved</h1>
<p>The document that used to live here now points to <b>${label}</b>. Continue to follow the redirect.</p>
<div class="row"><a class="go" href="${href}">Continue →</a></div>
<p class="note"><a href="/">Go to ${SITE_BRAND} instead</a></p>
</div>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": NOTFOUND_CSP,
      ...COMMON_HEADERS,
    },
  });
}

/**
 * May THIS caller be told anything about a resolved redirect target?
 *
 * `resolveRedirectTarget` filters on `revoked_at` but NOT on `visibility` — it
 * predates migration 0011 — so on its own it will happily hand a target's title
 * and canonical path (`/s/<slug>`, or the bare capability `/d/<public_id>` when
 * the target carries no slug) to an anonymous browser. That is a real leak, and
 * an easily-armed one: every rename tombstones the OLD slug with `redirect_to`
 * pointing at the doc's own `public_id` (core.ts `tombstoneSlug`), and new docs
 * are born private — so renaming a private doc's slug would otherwise turn the
 * old, low-entropy, probably-already-shared handle into a title-and-address
 * oracle for a document whose `/d/:id` and `/s/:new-slug` both 404 to that same
 * caller.
 *
 * The gate is `canRead`, exactly as on every other metadata-serving surface.
 * Operator and agent read the whole fleet (single-tenant trust), so they short-
 * circuit without the extra query and their branches — the `409 slug_redirected`
 * JSON, the `?follow_redirects=true` follow — behave exactly as before; the
 * check lives on ONE path rather than being a browser-branch special case, so a
 * future credentialed surface can't reintroduce the leak by forgetting it.
 *
 * `false` is deliberately indistinguishable from a dangling target: the caller
 * falls through to the plain 410, the same answer a revoked target gives, so
 * refusing to name the target doesn't itself become an oracle.
 *
 * (Fixing this inside `resolveRedirectTarget` would be tidier, but `visibility`
 * is not part of the wire `RedirectTarget` shape and shouldn't be — see the
 * follow-up note in the design docs.)
 */
async function redirectTargetReadableBy(
  env: Env,
  req: Request,
  target: RedirectTarget,
): Promise<boolean> {
  const principal = await resolvePrincipal(req, env);
  if (principal.kind !== "anonymous") return true;
  const row = await env.META.prepare(
    "select visibility, revoked_at from documents where public_id = ?",
  )
    .bind(target.public_id)
    .first<{ visibility: Visibility; revoked_at: string | null }>();
  // No row at all means the id never existed — revoke TOMBSTONES the `documents`
  // row (sets `revoked_at`), it never deletes it — so this is belt-and-suspenders
  // after `resolveRedirectTarget` just matched the same id. `revoked` is READ
  // rather than hardcoded false so the predicate is correct standing alone:
  // `resolveRedirectTarget` filters revoked rows today, but a revoke landing
  // between the two reads must still resolve to "don't name it."
  if (!row) return false;
  return canRead(principal, { visibility: row.visibility, revoked: row.revoked_at !== null });
}

/**
 * Resolve a retired slug to a Response for the shell surface (`GET /s/:slug`).
 * Called only after the live lookup misses. Three outcomes:
 *   - tombstone with a LIVE, READABLE redirect target → forward loudly: a
 *     browser gets the click-through interstitial; a credentialed caller
 *     (Authorization header) gets `409 slug_redirected`, or is served the
 *     target's bytes when it passed `?follow_redirects=true`;
 *   - plain tombstone (no redirect, or a dangling/revoked/unreadable target)
 *     → 410 Gone;
 *   - no tombstone → opaque 404.
 */
async function serveRetiredSlug(
  slug: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const tomb = await findSlugTombstoneCore(env, slug);
  // Never-claimed slug. Browser → the login-link 404 (so a private slugged doc's
  // 404 and a never-claimed slug's 404 stay byte-identical — no oracle); a
  // credentialed caller (Authorization header) → the plain body.
  if (!tomb) return req.headers.has("authorization") ? notFound() : notFoundBrowser(req);

  // "Authorization header present" == machine/credentialed caller (agent key or
  // operator token) → JSON/bytes; absent == browser → HTML interstitial/card.
  const hasAuthHeader = req.headers.has("authorization");

  if (tomb.redirect_to) {
    // Credential check FIRST, like the live-bytes branch: a present-but-invalid
    // key must stay loud (401) rather than degrading into the 410 below, which
    // is now also what an unreadable target produces.
    if (hasAuthHeader) {
      const denied = await requireReader(req, env, "invalid credentials — provide a valid agent key or operator token");
      if (denied) return denied;
    }
    const target = await resolveRedirectTarget(env, tomb.redirect_to);
    // Disclosure gate: a target this caller can't read is treated exactly like a
    // dangling one — we never name it, in HTML or in JSON.
    if (target && (await redirectTargetReadableBy(env, req, target))) {
      if (hasAuthHeader) {
        const follow =
          new URL(req.url).searchParams.get("follow_redirects") === "true";
        return follow ? serveRaw(target.public_id, req, env) : slugRedirectedJson(slug, target);
      }
      return redirectInterstitial(target);
    }
    // Dangling (revoked/unknown) or unreadable target → fall through to a 410.
  }

  return hasAuthHeader ? goneJson() : goneHtml();
}

/**
 * 401 JSON for the agent-auth read surfaces (serveDocument's bytes branch,
 * serveBySlug's bytes branch, and both `/text` endpoints). Message varies:
 * "invalid agent key" where a header was definitely present (content
 * negotiation only reaches auth when `Authorization` is set), "valid agent key
 * required" on the gated `/text` endpoints where the key may be absent entirely.
 *
 * Every message gets `API_DISCOVERY_HINT` appended HERE rather than at the
 * ~10 call sites, and the response carries the `service-desc` link header: a
 * 401 is the single most likely first response an agent that was handed only a
 * base URL and a key will ever see, so it is the cheapest place to teach it
 * where the routes are documented.
 */
function unauthorizedJson(message: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", message: message + API_DISCOVERY_HINT }), {
    status: 401,
    headers: { "content-type": "application/json", link: SERVICE_DESC_LINK },
  });
}

/**
 * Gate the non-public read surfaces on "any authenticated principal" — operator
 * OR agent — refusing only anonymous. This is `canRead`'s hierarchy
 * (operator ≥ agent ≥ anonymous) minus the public-visibility branch: the
 * `/text`, `/source`, and slug-text channels, plus the content-negotiated bytes
 * branch of `/d/:id` + `/s/:slug`, are ingestion surfaces that always require a
 * credential (even for a public doc), but the OPERATOR must never rank below an
 * agent. These endpoints used to call `authenticateAgent` directly, which the
 * operator token can't satisfy (it isn't an `awh_` key) — so an operator was
 * refused outright (strictly worse than anonymous on the content-negotiation
 * branch, which downgrades a no-credential caller to the shell). Resolving the
 * full principal restores the hierarchy and lets the operator in via either door
 * (cookie or Bearer), since `resolvePrincipal` checks the operator first.
 *
 * Returns null when a credential resolved (operator or agent); otherwise a
 * ready-to-send 401 carrying the caller's message.
 *
 * ALSO gates the two agent-door classification WRITES (`PUT /d/:id/tags` and
 * `PUT /d/:id/status` in admin.ts) despite the read-flavored name. That is not
 * a widening of authority: in the single-tenant whole-fleet model any active
 * agent key already overwrites every document's CONTENT through `PUT /d/:id`,
 * so letting it retag or deprecate one grants nothing it lacked — and the
 * operator-≥-agent hierarchy this helper exists to preserve is exactly what a
 * write surface needs too. What it deliberately does NOT gate is
 * `setDocumentVisibilityCore` or revoke: those stay `requireOperator`, because
 * visibility is the boundary between "private to the fleet" and "readable by
 * the anonymous internet" and revoke is irreversible. Adding a third surface
 * here means asking whether it belongs on the agent side of THAT line.
 */
export async function requireReader(req: Request, env: Env, message: string): Promise<Response | null> {
  const principal = await resolvePrincipal(req, env);
  return principal.kind === "anonymous" ? unauthorizedJson(message) : null;
}

/**
 * GET /d/:public_id — the URL agents share with humans. Content-negotiates
 * via `Authorization`:
 *
 *   - No header        → shell page (the browser case).
 *   - Valid credential → raw sanitized HTML, same bytes as `/raw`. Any
 *                        non-anonymous principal: an agent key OR the operator
 *                        token (operator ≥ agent — see `requireReader`).
 *   - Bad credential   → 401 (don't silently downgrade to shell — surface broken
 *                        keys/tokens).
 *
 * `/raw` is already publicly fetchable (the iframe needs it), so this auth
 * check isn't access control — it's the "one URL for agents and humans"
 * UX promise from the action plan.
 */
export async function serveDocument(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.has("authorization")) {
    // A credential was presented — accept any non-anonymous principal (agent key
    // or operator token) and serve the bytes (serveRaw re-gates on visibility).
    // A present-but-invalid credential 401s rather than downgrading to the shell.
    const denied = await requireReader(req, env, "invalid credentials — provide a valid agent key or operator token");
    if (denied) return denied;
    return serveRaw(publicId, req, env);
  }
  const origin = new URL(req.url).origin;
  return serveShell(publicId, req, env, origin);
}

/* ------------------------------------------------------------------------- *
 * Served-version resolution (issue #43, migration 0018) — see the file header
 * for WHY the render path is pinned. The rule itself lives in the leaf module
 * `served-version.ts` (`SERVED_VER_SQL` + `servedVersion`, imported above)
 * because `core.ts` needs it too and cannot import this file.
 * ------------------------------------------------------------------------- */

/**
 * Operator-only description of a published/current divergence, rendered as a
 * banner under the shell toolbar. Null whenever the two pointers agree (the
 * steady state) — and null for every non-operator, unconditionally.
 */
type PublishNotice = {
  /** The version whose bytes this page renders (`servedVersion`). */
  servedVer: number;
  /** The document's newest version (`documents.current_ver`). */
  currentVer: number;
  /** The promoted pointer (`documents.published_ver`); non-null by construction. */
  publishedVer: number;
  /** `/d/:public_id` — built from a PUBLIC_ID_RE-checked id, so safe to interpolate. */
  docPath: string;
};

/**
 * Decide whether the shell shows the divergence banner. Shared by the two shell
 * surfaces (`serveShell`, `serveBySlug`) so they can't disagree about when it
 * appears.
 *
 * `isOperator` is the caller's already-resolved session state, and a false value
 * short-circuits to null: the existence of an unpublished newer version is
 * PRECISELY what the pinning withholds from readers, so it must never reach a
 * non-operator's markup — not as a banner, not as a version number in the
 * toolbar (which names the served version for everyone).
 */
function publishNoticeFor(
  isOperator: boolean,
  doc: { visibility: Visibility; published_ver: number | null; current_ver: number | null },
  publicId: string,
): PublishNotice | null {
  if (!isOperator) return null;
  const served = servedVersion(doc);
  if (served === null || doc.current_ver === null) return null;
  // No pointer, or a pointer that agrees with current: nothing to warn about.
  if (doc.published_ver === null || doc.published_ver === doc.current_ver) return null;
  return {
    servedVer: served,
    currentVer: doc.current_ver,
    publishedVer: doc.published_ver,
    docPath: `/d/${publicId}`,
  };
}

/**
 * The divergence banner itself. Two shapes, chosen by which pointer the page is
 * actually serving:
 *
 *   - serving the PUBLISHED version — a public document whose newest version
 *     hasn't been promoted. Readers are seeing older bytes, and the operator
 *     needs to know the update they just made is staged, not live. This is the
 *     case the whole feature exists to create, so it must be visible rather
 *     than silently surprising.
 *   - serving the CURRENT version — a private document that nonetheless carries
 *     a promoted pointer. Nothing is on the open web yet, but `published_ver`
 *     decides what WILL be when the door opens (`setDocumentVisibilityCore`
 *     preserves an explicit choice with `coalesce`), so the version on screen
 *     is not the version that goes public.
 *
 * Caller-gated to the operator via `publishNoticeFor`. `docPath` is built from a
 * PUBLIC_ID_RE-checked id and both version numbers are integers, so everything
 * here interpolates safely.
 */
function renderPublishNotice(n: PublishNotice | null): string {
  if (!n) return "";
  const text =
    n.servedVer === n.publishedVer
      ? `Showing published <b>v${n.publishedVer}</b>. <a href="${n.docPath}/v/${n.currentVer}">v${n.currentVer}</a> is newer and <b>not visible to readers</b> — publish it from <a href="${n.docPath}/manage">Manage</a>.`
      : `Showing current <b>v${n.currentVer}</b>. <a href="${n.docPath}/v/${n.publishedVer}">v${n.publishedVer}</a> is the published version — that's what the open web gets when this document is made public.`;
  return `\n<div class="pubbar">${text}</div>`;
}

/**
 * Build the toolbar + iframe shell Response from a document's served-version
 * metadata. Shared by `serveShell` (keyed on public_id, canonical `/d/:id`) and
 * `serveBySlug` (keyed on slug, canonical `/s/:slug` so the pretty URL stays in
 * the address bar and link-unfurls point back at itself).
 *
 * `links.iframeSrc` and `links.revokeHref` are interpolated into the HTML
 * WITHOUT escaping, so callers MUST build them from a PUBLIC_ID_RE-checked id
 * (every stored `public_id` is one). `links.canonicalUrl` IS escaped here, so a
 * validated slug or request origin is safe to pass raw. `links.pagePath` is the
 * same-origin path of THIS page (`/d/:id` or `/s/:slug`); it's URL-encoded into
 * the login `next`, so a validated id/slug is safe to pass raw too.
 *
 * `authenticated` is the operator's browser-session state (cookie), resolved by
 * the caller. It chooses the toolbar menu's items — Revoke… + Sign out when
 * signed in, Sign in when not. It's display-only: the linked pages each enforce
 * their own auth, so the response also carries `Vary: Cookie`.
 */
function renderShell(
  meta: {
    createdAtIso: string;
    /**
     * The SERVED version (issue #43) — what the iframe at `links.iframeSrc` will
     * actually render, NOT necessarily `documents.current_ver`. The toolbar must
     * name the bytes on screen; a public document serving an older promoted
     * version would otherwise report a version nobody is looking at.
     */
    version: number;
    agentName: string | null;
    title: string | null;
    description: string | null;
    // Rendered as a topbar badge ("Public" / "Private") ONLY when the operator
    // is signed in (the `authenticated` flag) — surfacing the current
    // open-web-exposure state at a glance. Anonymous viewers never see it (and a
    // private doc never reaches an anonymous shell at all). The CONTROL that
    // changes it lives on the Manage page (`links.manageHref`), which re-reads
    // the value itself; this badge is display-only.
    visibility: Visibility;
    /**
     * Published/current divergence banner (issue #43), or null when the two
     * pointers agree. Built by `publishNoticeFor`, which returns null for every
     * non-operator — so this field can never disclose staged work to a reader.
     */
    publishNotice: PublishNotice | null;
  },
  links: { iframeSrc: string; manageHref: string; canonicalUrl: string; pagePath: string },
  authenticated: boolean,
): Response {
  const createdAt = escapeHtml(formatCreatedAt(meta.createdAtIso));
  const version = meta.version;
  const author = meta.agentName ? escapeHtml(meta.agentName) : "[deleted agent]";
  const publishBanner = renderPublishNotice(meta.publishNotice);

  // Operator-only visibility badge in the meta bar. "Private" gets a distinct
  // class so the not-on-the-open-web state reads at a glance. Anonymous viewers
  // never get this (and never reach a private doc's shell at all).
  const visibilityBadge = authenticated
    ? `<span class="vis ${meta.visibility === "private" ? "priv" : "pub"}">Visibility <b>${meta.visibility === "private" ? "Private" : "Public"}</b></span>`
    : "";

  // formatPageTitle applies anti-phishing normalization (bidi/control/zero-
  // width stripping + length cap) before adding the brand suffix. escapeHtml
  // is still the final encoding-layer step. A null/empty title falls back to
  // bare brand so the tab still shows something usable.
  const pageTitle = escapeHtml(formatPageTitle(meta.title));

  const ogTitleRaw = meta.title ? normalizeTitleForDisplay(meta.title) : "";
  const ogTitle = escapeHtml(ogTitleRaw.length > 0 ? ogTitleRaw : SITE_BRAND);
  const canonicalUrl = escapeHtml(links.canonicalUrl);

  // Toolbar action menu items, chosen by operator session state. Signed in →
  // Manage… (the document-management page: visibility toggle, slug editor, and
  // the revoke kill switch — all folded into one page) + Sign out. Signed out →
  // Sign in, round-tripping back to this page via a validated, URL-encoded
  // `next`. manageHref/logout/login are server-built from a regex-checked id or
  // static paths; loginHref is escaped belt-and-suspenders (encodeURIComponent
  // already yields no HTML-special chars for our id/slug charsets). The menu is
  // cosmetic — every target re-checks auth (the Manage page requires a cookie
  // session for the controls).
  const loginHref = escapeHtml(`/login?next=${encodeURIComponent(links.pagePath)}`);
  const menuItems = authenticated
    ? `<a class="item" role="menuitem" href="${links.manageHref}">Manage…</a>
<a class="item" role="menuitem" href="/logout">Sign out</a>`
    : `<a class="item" role="menuitem" href="${loginHref}">Sign in</a>`;

  // <meta name=description> and social card metas render in link previews
  // (Slack, Twitter, etc.) and search engines. Because the Open Graph/Twitter
  // card is an external rendering surface that reaches the user, the original
  // assumption that description isn't a phishing surface is now false.
  // We apply the same display-time anti-phishing normalization that title gets.
  let metaDescriptionTag = "";
  let ogDescriptionTag = "";
  let twitterDescriptionTag = "";

  if (meta.description) {
    const normalizedDesc = normalizeDescriptionForDisplay(meta.description);
    if (normalizedDesc.length > 0) {
      const escapedDesc = escapeHtml(normalizedDesc);
      metaDescriptionTag = `\n<meta name="description" content="${escapedDesc}">`;
      ogDescriptionTag = `\n<meta property="og:description" content="${escapedDesc}">`;
      twitterDescriptionTag = `\n<meta name="twitter:description" content="${escapedDesc}">`;
    }
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>${metaDescriptionTag}
<meta name="robots" content="noindex">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${SITE_BRAND}">
<meta property="og:title" content="${ogTitle}">
<meta property="og:url" content="${canonicalUrl}">${ogDescriptionTag}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${ogTitle}">${twitterDescriptionTag}
<!-- TODO: add og:image + twitter:image (and switch twitter:card to
     summary_large_image) once a static brand card or per-doc dynamic
     render exists. -->
<style>
:root{color-scheme:light dark}
html,body{margin:0;padding:0;height:100%;background:#f4f2ee;font:13px/1.4 system-ui,sans-serif;color:#2c2a27}
.app{display:flex;flex-direction:column;height:100vh}
.bar{flex:0 0 auto;display:flex;align-items:center;gap:16px;padding:8px 14px;border-bottom:1px solid #e3ddd2;background:#fbfaf7;font-size:12px;color:#6b655c}
.bar .meta{display:flex;gap:14px;flex:1 1 auto;min-width:0;flex-wrap:wrap}
.bar .meta span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar .meta b{color:#1b1a17;font-weight:600}
.bar .meta .vis.priv b{color:#a0541b}
.bar .menu{position:relative;flex:0 0 auto}
.bar summary{list-style:none;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;cursor:pointer;color:#6b655c}
.bar summary::-webkit-details-marker{display:none}
.bar summary:hover,.bar details[open] summary{background:#efece4;color:#1b1a17}
.bar summary:focus-visible{outline:2px solid #3a6ea5;outline-offset:1px}
.bar .kebab{display:block;fill:currentColor}
.bar .menu-items{position:absolute;right:0;top:calc(100% + 6px);min-width:150px;background:#fbfaf7;border:1px solid #e3ddd2;border-radius:8px;box-shadow:0 6px 22px rgba(0,0,0,.13);padding:5px;display:flex;flex-direction:column;gap:1px;z-index:10}
.bar .menu-items .item{padding:8px 11px;border-radius:5px;text-decoration:none;color:#2c2a27;white-space:nowrap}
.bar .menu-items .item:hover{background:#efece4}
.bar .menu-items .item.danger{color:#a00}
.bar .menu-items .item.danger:hover{background:#a00;color:#fff}
.pubbar{flex:0 0 auto;padding:7px 14px;border-bottom:1px solid #e8d4a8;background:#fdf4e6;color:#8a5a00;font-size:12px}
.pubbar b{color:#6d4700;font-weight:600}
.pubbar a{color:#8a5a00}
iframe{border:0;width:100%;flex:1 1 auto;display:block;background:#fbfaf7}
@media (prefers-color-scheme:dark){
html,body{background:#1a1917;color:#d8d4cd}
.bar{border-bottom-color:#33302b;background:#201f1c;color:#9a948a}
.bar .meta b{color:#ededea}
.bar .meta .vis.priv b{color:#e0a060}
.bar summary{color:#9a948a}
.bar summary:hover,.bar details[open] summary{background:#2a2825;color:#ededea}
.bar .menu-items{background:#26241f;border-color:#33302b;box-shadow:0 6px 22px rgba(0,0,0,.5)}
.bar .menu-items .item{color:#d8d4cd}
.bar .menu-items .item:hover{background:#33302b}
.bar .menu-items .item.danger{color:#e07a7a}
.bar .menu-items .item.danger:hover{background:#e07a7a;color:#1a1917}
.pubbar{background:#2e2715;border-bottom-color:#5a4a1e;color:#e0a850}
.pubbar b{color:#f0c87a}
.pubbar a{color:#e0a850}
iframe{background:#201f1c}
}
</style>
</head>
<body>
<div class="app">
<div class="bar">
<div class="meta">
<span>Created <b>${createdAt}</b></span>
<span>Version <b>v${version}</b></span>
<span>Author <b>${author}</b></span>
${visibilityBadge}
</div>
<details class="menu">
<summary aria-haspopup="menu" aria-label="Document actions" title="Document actions"><svg class="kebab" width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3" r="1.5"></circle><circle cx="8" cy="8" r="1.5"></circle><circle cx="8" cy="13" r="1.5"></circle></svg></summary>
<div class="menu-items" role="menu">
${menuItems}
</div>
</details>
</div>${publishBanner}
<iframe sandbox="${SANDBOX}" src="${links.iframeSrc}" referrerpolicy="no-referrer"></iframe>
</div>
<script src="/shell.js" defer></script>
</body>
</html>
`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": SHELL_CSP,
      // The toolbar menu varies with the operator session cookie. Already
      // `no-store` (COMMON_HEADERS), so this is belt-and-suspenders, matching
      // serveRevokeConfirm.
      vary: "Cookie",
      ...COMMON_HEADERS,
    },
  });
}

/**
 * GET /d/:public_id — the URL humans click. Returns a toolbar (creation time,
 * version, author agent, and a kebab actions menu) above the iframe shell.
 *
 * Metadata shown on the toolbar is the same trust level as the document
 * bytes themselves — anyone with the URL can already read the content.
 * `listDocumentsCore` likewise exposes the fleet to any agent key.
 *
 * Validates the id format before touching D1 so we don't burn a query on
 * obvious junk. The id is regex-checked, so it's safe to interpolate into
 * the HTML template without escaping.
 */
export async function serveShell(
  publicId: string,
  req: Request,
  env: Env,
  origin: string,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFoundBrowser(req);

  // Single LEFT JOIN: `documents.created_by` is `ON DELETE SET NULL`, so a
  // cascaded-away agent leaves `agent_name` as NULL — handled in the template.
  // The versions JOIN pulls per-version metadata (title, description) for the
  // SERVED version (SERVED_VER_SQL — the promoted one on a public doc, else
  // current), because the `<title>`/OG tags this shell emits are a link-unfurl
  // surface and must describe the bytes the iframe will load, not a newer
  // version the visitor can't see. LEFT so a revoked doc (current_ver = null)
  // still returns a row and falls through to the 404 below.
  const row = await env.META.prepare(
    `select d.revoked_at, d.created_at, d.current_ver, d.published_ver, d.visibility, a.name as agent_name,
       v.title as doc_title, v.description as doc_description
     from documents d
     left join agents a on a.id = d.created_by
     left join versions v on v.document_id = d.id and v.version_no = ${SERVED_VER_SQL}
     where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      revoked_at: string | null;
      created_at: string;
      current_ver: number | null;
      published_ver: number | null;
      visibility: Visibility;
      agent_name: string | null;
      doc_title: string | null;
      doc_description: string | null;
    }>();
  if (!row || row.revoked_at) return notFoundBrowser(req);

  // No `Authorization` header reaches here (serveDocument routes the bytes case
  // away), so the principal is operator-via-cookie OR anonymous — no agent case.
  // We derive it from the operator-session check we already need for the toolbar
  // rather than re-running resolvePrincipal.
  const op = await authenticateOperatorRequest(req, env);

  // Visibility gate (migration 0011). A private doc is invisible to an
  // anonymous browser — same opaque 404 as missing/revoked (revoked already
  // 404'd above), so it can't be told apart from a nonexistent id. The operator
  // (cookie) reads it. This also hides the title/description/author/OG metadata
  // below, since the whole shell is withheld.
  const principal: Principal = op.ok ? { kind: "operator" } : { kind: "anonymous" };
  if (!canRead(principal, { visibility: row.visibility, revoked: false })) return notFoundBrowser(req);

  return renderShell(
    {
      createdAtIso: row.created_at,
      // The version the iframe will render — `/d/:id/raw` resolves the same
      // SERVED_VER_SQL rule, so the toolbar and the bytes always agree.
      version: servedVersion(row) ?? 0, // not reachable when null (revoked → 404 above)
      agentName: row.agent_name,
      title: row.doc_title,
      description: row.doc_description,
      visibility: row.visibility,
      publishNotice: publishNoticeFor(op.ok, row, publicId),
    },
    {
      iframeSrc: `/d/${publicId}/raw`,
      manageHref: `/d/${publicId}/manage`,
      canonicalUrl: `${origin}/d/${publicId}`,
      pagePath: `/d/${publicId}`,
    },
    op.ok,
  );
}

/**
 * The document rendered at `/` (the public landing page), as a `[var]` rather
 * than a source constant (issue #55). A fork's D1 holds none of THIS
 * deployment's documents, so a baked-in id made `/` a permanent 404 that only
 * a source edit + redeploy could clear — and `GET /d` is `requireReader`-gated,
 * so a fresh operator had no anonymous way to discover an id to point it at
 * either. The id is per-deployment state; it belongs in the gitignored
 * `wrangler.toml`, not in tracked source.
 *
 * Unset/empty is a FIRST-CLASS state meaning "no homepage configured yet"
 * (the same empty-is-off precedent as `CORS_ALLOWED_ORIGINS`), rendering the
 * placeholder below instead of a 404.
 *
 * This is the SINGLE reader of the var (same discipline as `storageCapBytes`
 * for `STORAGE_CAP_BYTES` and `corsAllowedOrigins` for `CORS_ALLOWED_ORIGINS`).
 * The `PUBLIC_ID_RE` check is load-bearing, not defensive: the returned value
 * is interpolated into the shell HTML and the iframe `src` WITHOUT escaping,
 * exactly like the regex-checked ids elsewhere in this file. A malformed var
 * degrades to the placeholder and logs rather than reaching the template. The
 * log is deliberately value-free — a `public_id` is the capability component
 * of an unguessable URL, and logs are a lower-trust sink than this module.
 */
function homepagePublicId(env: Env): string | null {
  const raw = (env.HOMEPAGE_PUBLIC_ID ?? "").trim();
  if (raw.length === 0) return null;
  if (!PUBLIC_ID_RE.test(raw)) {
    console.warn("HOMEPAGE_PUBLIC_ID is set but is not a valid public_id — serving the unconfigured placeholder");
    return null;
  }
  return raw;
}

/**
 * `GET /` when no homepage document resolves: the var is unset or malformed,
 * or the id it names is missing, revoked, or not anonymously readable.
 *
 * A 200 placeholder rather than the opaque 404 this used to serve (issue #55) —
 * a fresh fork's first `wrangler deploy` should not look broken. Deliberately
 * ONE page for every unresolvable case: the detail that would help the operator
 * (unset vs. malformed vs. unreadable) goes to the server log, never to an
 * anonymous visitor. That costs no security either way — unlike every other
 * 404 in this file, the id here is operator-configured and never
 * caller-supplied, so there is nothing a visitor could probe and no existence
 * oracle to protect.
 *
 * Carries `noindex` via COMMON_HEADERS — the exact opposite of the real
 * homepage below, which deliberately omits it. A placeholder must never become
 * the indexed public face of a deployment.
 */
function homepageUnconfigured(): Response {
  return new Response(renderHomepageUnconfiguredPage(), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": NOTFOUND_CSP,
      ...COMMON_HEADERS,
    },
  });
}

/** The "no homepage yet" card (reuses the 404/gone page chrome). Static copy —
 *  no per-request or per-deployment detail — so it discloses nothing. */
function renderHomepageUnconfiguredPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 12px;font-weight:600}
p{margin:0 0 16px;color:#555}
code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f4f4;padding:1px 5px;border-radius:3px}
a.btn{display:inline-block;padding:9px 16px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;text-decoration:none}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
</style>
</head>
<body>
<div class="card">
<h1>${SITE_BRAND} is running</h1>
<p>This deployment doesn't have a homepage document configured yet, so there's nothing to show here.</p>
<p>If you're the operator: publish a document, make it public, then set <code>HOMEPAGE_PUBLIC_ID</code> in <code>wrangler.toml</code> to its <code>public_id</code> and redeploy. The setup runbook walks through it.</p>
<p><a class="btn" href="/login">Sign in</a></p>
<p class="note"><a href="/healthz">Service status</a></p>
</div>
</body>
</html>
`;
}

/**
 * GET / — public landing page. Renders HOMEPAGE_PUBLIC_ID with the SAME
 * security model as serveShell (the bytes load inside the sandboxed iframe at
 * `/d/:id/raw` under RAW_CSP, never inline at top level), minus the toolbar:
 * no created/version/author bar, no Revoke link, full-viewport iframe.
 *
 * Two intentional differences from serveShell, both because `/` is a public
 * landing page rather than a capability URL:
 *   - No `noindex` (neither the `x-robots-tag` header nor the meta) — we WANT
 *     search engines to index the homepage. (The framed bytes at `/d/:id/raw`
 *     still carry noindex via COMMON_HEADERS, and iframe content isn't indexed
 *     as part of the parent anyway — so the indexable surface is the shell's
 *     <title>/description/OG tags here. If real content-SEO is needed later,
 *     serve the bytes inline at top level instead of framed — but that gives
 *     up the sandbox, so it's a deliberate call, not a default.)
 *   - Title is the doc's own (anti-phishing normalized), with no "| {brand}"
 *     suffix — on the landing page the title *is* the brand.
 *
 * Unconfigured, missing, revoked, or non-public homepage doc → the placeholder
 * above, NOT a 404 (issue #55). See `homepageUnconfigured` for why relaxing the
 * usual opacity is safe on exactly this route.
 */
export async function serveHomepage(env: Env, origin: string): Promise<Response> {
  const homepageId = homepagePublicId(env);
  if (!homepageId) return homepageUnconfigured();

  // Same LEFT JOIN shape as serveShell, trimmed to what a toolbar-less page
  // needs: existence/kill check + SERVED-version title/description for <head>.
  // The homepage is public by definition, so the served version is normally the
  // promoted one — and the framed `/d/HOMEPAGE/raw` below resolves the same
  // rule, so `<title>`/OG here describe exactly the bytes in the frame. (No
  // divergence banner: this page has no toolbar and is gated as an anonymous
  // read, and an anonymous reader must not learn a newer version is staged.)
  const row = await env.META.prepare(
    `select d.revoked_at, d.visibility, v.title as doc_title, v.description as doc_description
     from documents d
     left join versions v on v.document_id = d.id and v.version_no = ${SERVED_VER_SQL}
     where d.public_id = ?`,
  )
    .bind(homepageId)
    .first<{
      revoked_at: string | null;
      visibility: Visibility;
      doc_title: string | null;
      doc_description: string | null;
    }>();
  if (!row || row.revoked_at) return homepageUnconfigured();

  // The homepage is the public face by definition, so it's gated as an
  // anonymous read: if the operator ever points HOMEPAGE_PUBLIC_ID at a private
  // doc (a misconfig), `/` degrades cleanly rather than rendering a shell whose
  // iframe (`/d/HOMEPAGE/raw`, itself gated in serveRaw) would 404. A public
  // homepage doc passes; this is the expected steady state.
  if (!canRead({ kind: "anonymous" }, { visibility: row.visibility, revoked: false })) {
    return homepageUnconfigured();
  }

  const titleRaw = row.doc_title ? normalizeTitleForDisplay(row.doc_title) : "";
  const visibleTitle = escapeHtml(titleRaw.length > 0 ? titleRaw : SITE_BRAND);
  const canonicalUrl = escapeHtml(`${origin}/`);

  let metaDescriptionTag = "";
  let ogDescriptionTag = "";
  let twitterDescriptionTag = "";
  if (row.doc_description) {
    const normalizedDesc = normalizeDescriptionForDisplay(row.doc_description);
    if (normalizedDesc.length > 0) {
      const escapedDesc = escapeHtml(normalizedDesc);
      metaDescriptionTag = `\n<meta name="description" content="${escapedDesc}">`;
      ogDescriptionTag = `\n<meta property="og:description" content="${escapedDesc}">`;
      twitterDescriptionTag = `\n<meta name="twitter:description" content="${escapedDesc}">`;
    }
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${visibleTitle}</title>${metaDescriptionTag}
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_BRAND}">
<meta property="og:title" content="${visibleTitle}">
<meta property="og:url" content="${canonicalUrl}">${ogDescriptionTag}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${visibleTitle}">${twitterDescriptionTag}
<style>
:root{color-scheme:light dark}
html,body{margin:0;padding:0;height:100%;background:#f4f2ee}
iframe{border:0;display:block;width:100%;height:100vh;background:#f4f2ee}
@media (prefers-color-scheme:dark){html,body,iframe{background:#1a1917}}
</style>
</head>
<body>
<iframe sandbox="${SANDBOX}" src="/d/${homepageId}/raw" referrerpolicy="no-referrer"></iframe>
</body>
</html>
`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": SHELL_CSP,
      // Landing page, not a capability URL: no `x-robots-tag: noindex`, so
      // this intentionally does NOT spread COMMON_HEADERS.
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * GET /d/:public_id/raw — what the iframe loads. Streams sanitized bytes
 * from R2 under the locked-down CSP. `frame-ancestors 'self'` ensures
 * only our own shell can embed it; direct navigation works (browsers
 * tolerate the bare HTML fragment), but third-party iframes are refused.
 *
 * VERSION PIN (issue #43) — this is the single chokepoint for the rendered
 * BYTES, so it is also where the published-version rule is enforced: a public
 * document serves `published_ver`, to EVERY caller, operator and agent
 * included. That uniformity is the point. A rule that served current bytes to
 * whoever held a credential would leave the operator reviewing a page no
 * visitor can see, and would put the decision of "what is published" back in
 * the hands of any key that can write. An agent that wants its own newest bytes
 * has `/text`, `/source` and the MCP reads, which all stay on `current_ver`.
 *
 * VISIBILITY GATE (migration 0011) — this is the single chokepoint for the
 * rendered bytes. Both the `/d/:id` shell AND the homepage embed
 * `/d/:id/raw` as an HTTP subresource, so gating HERE (not just at the shell)
 * is what actually withholds a private doc's bytes. We resolve the full
 * principal because this is reached uncredentialed by the iframe, by an agent
 * Bearer directly, and (via serveDocument/serveBySlug) after an agent already
 * authed — the redundant re-resolve in that last case is cheap and keeps one
 * gate. A private doc denies to anonymous with the SAME opaque 404 as
 * missing/revoked (no oracle).
 *
 * The operator-in-browser case works because the `awh_session` cookie reaches
 * this SAME-ORIGIN subresource request (SameSite=Lax only strips cross-SITE
 * requests). That property depends on `/d/:id/raw` staying same-origin — today
 * guaranteed by the shell's `frame-src 'self'` / RAW_CSP `frame-ancestors
 * 'self'`. If raw bytes ever move to a separate content domain, Lax would strip
 * the cookie and break the operator render — revisit the gate then.
 */
export async function serveRaw(publicId: string, req: Request, env: Env): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  // Single join to get document state + the R2 key for the SERVED version
  // (SERVED_VER_SQL — issue #43). This join is THE pin: it is the only place the
  // rendered bytes of a public document are chosen, so a public doc physically
  // cannot serve an unpromoted version, whoever asks. `r2_key` is read back from
  // the joined row rather than derived from (doc, version) — the key carries a
  // per-write nonce and is opaque by design. `source_format` decides whether to
  // inject the reading theme (Markdown) or serve the stored bytes verbatim
  // (HTML — author owns presentation), and is read from the SAME row, so a
  // document that changed format between versions renders under the format its
  // served version was written in. `visibility` drives the access gate below;
  // `current_ver` feeds the writer preflight header.
  const row = await env.META.prepare(
    `select d.revoked_at, d.visibility, d.current_ver, v.r2_key, v.version_no, v.source_format
     from documents d
     join versions v on v.document_id = d.id and v.version_no = ${SERVED_VER_SQL}
     where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      revoked_at: string | null;
      visibility: Visibility;
      current_ver: number | null;
      r2_key: string;
      version_no: number;
      source_format: string;
    }>();
  // The `revoked_at` half of this guard is now SOLELY load-bearing, where it used
  // to be doubly covered. `revokeDocumentCore` nulls `current_ver` but leaves
  // `published_ver` standing, so on a revoked public document SERVED_VER_SQL still
  // resolves to that stale pointer and this INNER join MATCHES — whereas joining
  // on the nulled `current_ver` used to miss and 404 via `!row` on its own. The
  // kill switch is unaffected (the check runs before anything reads the row), but
  // do not reorder or weaken it on the theory that a dead document can't join.
  if (!row || row.revoked_at) return notFound();

  // Access gate: operator/agent read everything; anonymous reads only public.
  const principal = await resolvePrincipal(req, env);
  if (!canRead(principal, { visibility: row.visibility, revoked: false })) return notFound();

  // Writer preflight (issue #43): the document's NEWEST version, which on a
  // public doc can be ahead of the bytes we just served. A writer running
  // `--if-match auto` reads a document and needs the version to send back on the
  // next PUT — and the ETag now names the SERVED version, so the two genuinely
  // differ and the ETag alone would make it write against a stale expectation.
  //
  // Emitted ONLY to a credentialed principal. That an unpublished newer version
  // exists is exactly what the pinning withholds from readers, so for an
  // anonymous caller the header is ABSENT rather than clamped to the served
  // number: an absent header discloses nothing, a wrong number would be a lie
  // to any tool that later gains a credential. (`current_ver` is non-null on a
  // live document — revoke nulls it and 404s above — but the column is nullable,
  // so fall back to the served version rather than emit "null".)
  const writerHeaders: Record<string, string> =
    principal.kind === "anonymous"
      ? {}
      : { "x-doc-current-version": String(row.current_ver ?? row.version_no) };

  // Conditional GET: if the client already holds this version, answer a bodyless
  // 304 and skip the R2 GET + body transfer. MUST stay AFTER the revoke +
  // visibility gate above — a 304 confirms existence + version, so emitting one
  // earlier would turn a private/revoked doc's opaque 404 into an oracle.
  //
  // The tag validates the SERVED version, which is what makes it still correct
  // under publishing: promoting a different version changes these bytes without
  // writing a new one, and the tag moves with it; conversely a new UNpublished
  // version leaves the tag alone, because the bytes at this URL didn't change.
  // The preflight header rides the 304 too — a preflight is exactly the request
  // most likely to carry `If-None-Match`, and withholding it there would break
  // the caller it exists for (the 304 already discloses the served version via
  // the ETag, so this adds nothing beyond what the 200 does).
  if (ifNoneMatchSatisfied(req.headers.get("if-none-match"), row.version_no)) {
    return new Response(null, {
      status: 304,
      headers: { etag: etagForVersion(row.version_no), ...writerHeaders, ...COMMON_HEADERS },
    });
  }

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return notFound(); // shouldn't happen — D1 says it should exist

  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": RAW_CSP,
    etag: etagForVersion(row.version_no),
    ...writerHeaders,
    ...COMMON_HEADERS,
  };

  // Markdown docs get the reading theme + doctype spliced ahead of their bytes
  // (presentation only — never stored, never seen by the sanitizer or the
  // /text derivation; see READER_THEME_CSS). HTML docs pass through byte-for-
  // byte. Either way the document body streams straight from R2 — no buffering.
  const body =
    row.source_format === "markdown"
      ? streamWithPrefix(READER_THEME_PREFIX, obj.body)
      : obj.body;

  return new Response(body, { status: 200, headers });
}

/* ------------------------------------------------------------------------- *
 * Operator-only version history view (`/d/:public_id/v/:n` + `/v/:n/raw`).
 *
 * History is an OPERATOR surface, distinct from the public visibility axis:
 * these routes are gated by the operator check (Bearer OR cookie session), NOT
 * by canRead — a public doc's history and a private doc's history are equally
 * operator-only, and an agent reads old versions through MCP, never here. A
 * non-operator gets the same opaque 404 as a missing route (no oracle).
 *
 * The split mirrors the live shell/raw split: `/v/:n` is the framed shell with a
 * "historical version" banner; `/v/:n/raw` is the bytes the iframe loads under
 * RAW_CSP. The operator's awh_session cookie reaches the same-origin /raw
 * subresource (SameSite=Lax only strips cross-SITE), so the framed render works
 * for a cookie operator exactly like the live one.
 * ------------------------------------------------------------------------- */

/**
 * GET /d/:public_id/v/:n/raw — operator-only sanitized bytes of a specific
 * historical version, streamed straight from that version's retained R2 key.
 */
export async function serveVersionRaw(
  publicId: string,
  versionNo: number,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok) return notFound(); // opaque — no version oracle for non-operators

  const row = await env.META.prepare(
    `select v.r2_key, v.version_no, v.source_format
       from documents d
       join versions v on v.document_id = d.id and v.version_no = ?
      where d.public_id = ? and d.revoked_at is null`,
  )
    .bind(versionNo, publicId)
    .first<{ r2_key: string; version_no: number; source_format: string }>();
  if (!row) return notFound();

  // Conditional GET (see serveRaw). Operator-gated + row-resolved above, so a
  // non-operator or an absent version still 404s opaquely before this point.
  // Historical versions are immutable, so a cached client always 304s here.
  if (ifNoneMatchSatisfied(req.headers.get("if-none-match"), row.version_no)) {
    return new Response(null, {
      status: 304,
      headers: { etag: etagForVersion(row.version_no), ...COMMON_HEADERS },
    });
  }

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return notFound();

  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": RAW_CSP,
    etag: etagForVersion(row.version_no),
    ...COMMON_HEADERS,
  };
  // Same reader-theme injection as serveRaw, keyed on THIS version's format.
  const body =
    row.source_format === "markdown"
      ? streamWithPrefix(READER_THEME_PREFIX, obj.body)
      : obj.body;
  return new Response(body, { status: 200, headers });
}

/**
 * GET /d/:public_id/v/:n — operator-only framed shell for a historical version,
 * with a banner distinguishing it from the live document and links back to the
 * current version + the manage page. A non-operator gets the browser 404 (with
 * its sign-in affordance), which discloses nothing about the doc.
 */
export async function serveVersionShell(
  publicId: string,
  versionNo: number,
  req: Request,
  env: Env,
  origin: string,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFoundBrowser(req);

  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok) return notFoundBrowser(req); // sign-in round-trip; no oracle

  const row = await env.META.prepare(
    `select d.current_ver, v.version_no, v.created_at, v.title
       from documents d
       join versions v on v.document_id = d.id and v.version_no = ?
      where d.public_id = ? and d.revoked_at is null`,
  )
    .bind(versionNo, publicId)
    .first<{ current_ver: number | null; version_no: number; created_at: string; title: string | null }>();
  if (!row || row.current_ver === null) return notFoundBrowser(req);

  return renderVersionShell(
    {
      publicId,
      versionNo: row.version_no,
      currentVer: row.current_ver,
      createdAtIso: row.created_at,
      title: row.title,
    },
    origin,
  );
}

/**
 * The historical-version shell HTML. Compact operator chrome (no kebab menu, no
 * OG tags — it's noindex operator-only) wrapping the same sandboxed iframe as
 * the live shell. `publicId` is PUBLIC_ID_RE-checked and `versionNo` is an
 * integer, so both are safe to interpolate into the template unescaped.
 */
function renderVersionShell(
  v: { publicId: string; versionNo: number; currentVer: number; createdAtIso: string; title: string | null },
  _origin: string,
): Response {
  const createdAt = escapeHtml(formatCreatedAt(v.createdAtIso));
  const titleRaw = v.title ? normalizeTitleForDisplay(v.title) : "";
  const visibleTitle = escapeHtml(titleRaw.length > 0 ? titleRaw : "(untitled)");
  const pageTitle = escapeHtml(`v${v.versionNo} · ${titleRaw.length > 0 ? titleRaw : v.publicId} | ${SITE_BRAND}`);
  const isCurrent = v.versionNo === v.currentVer;
  const iframeSrc = `/d/${v.publicId}/v/${v.versionNo}/raw`;

  const bannerClass = isCurrent ? "cur" : "hist";
  const bannerText = isCurrent
    ? `Version <b>v${v.versionNo}</b> — this is the current live version.`
    : `Version <b>v${v.versionNo}</b> of v${v.currentVer} — <b>historical</b>, not the live document.`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
<meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark}
html,body{margin:0;padding:0;height:100%;background:#f4f2ee;font:13px/1.4 system-ui,sans-serif;color:#2c2a27}
.app{display:flex;flex-direction:column;height:100vh}
.bar{flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:8px 14px;border-bottom:1px solid #e3ddd2;background:#fbfaf7;font-size:12px;color:#6b655c;flex-wrap:wrap}
.bar .who{flex:1 1 auto;min-width:0}
.bar b{color:#1b1a17;font-weight:600}
.bar.hist{background:#fdf4e6;border-bottom-color:#e8d4a8}
.bar.hist b{color:#8a5a00}
.bar a{color:#3a6ea5;text-decoration:none;white-space:nowrap}
.bar a:hover{text-decoration:underline}
.bar .sub{color:#8a857c}
iframe{border:0;width:100%;flex:1 1 auto;display:block;background:#fbfaf7}
@media (prefers-color-scheme:dark){
html,body{background:#1a1917;color:#d8d4cd}
.bar{border-bottom-color:#33302b;background:#201f1c;color:#9a948a}
.bar b{color:#ededea}
.bar.hist{background:#2e2715;border-bottom-color:#5a4a1e}
.bar.hist b{color:#e0a850}
.bar a{color:#7aa7d6}
iframe{background:#201f1c}
}
</style>
</head>
<body>
<div class="app">
<div class="bar ${bannerClass}">
<span class="who">${bannerText} <span class="sub">· ${visibleTitle} · ${createdAt}</span></span>
<a href="/d/${v.publicId}">View current</a>
<a href="/d/${v.publicId}/manage">Manage…</a>
</div>
<iframe sandbox="${SANDBOX}" src="${iframeSrc}" referrerpolicy="no-referrer"></iframe>
</div>
</body>
</html>
`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": SHELL_CSP,
      vary: "Cookie",
      ...COMMON_HEADERS,
    },
  });
}

/**
 * Does this caller want the JSON read envelope instead of the raw Markdown?
 *
 * True ONLY for an explicit `application/json` media type in `Accept`. A
 * wildcard Accept (curl's default, and what the Dart clients send so
 * Cloudflare doesn't strip the ETag) and an absent header BOTH keep the
 * historical `text/markdown` body, so the negotiation adds a shape without
 * moving a single existing caller onto it. Quality values are ignored: this is
 * a two-way switch, not a preference ranking, and a caller that names JSON at
 * all wants JSON.
 */
function wantsJsonEnvelope(req: Request): boolean {
  const accept = req.headers.get("accept");
  if (!accept) return false;
  return accept
    .split(",")
    .some((part) => part.split(";")[0]!.trim().toLowerCase() === "application/json");
}

/**
 * Build the Markdown-derivation response for an already-resolved public_id.
 * No auth, no id-shape check — callers (`serveText`, `serveTextBySlug`) own
 * those gates; this is the single place the conversion + headers (ETag,
 * sanitizer/converter version tags, no-store) are produced.
 *
 * Conversion runs on every request (no per-version cache in v1); the underlying
 * bytes come from R2 via `readDocumentTextCore`, so a revoked doc still 404s.
 *
 * DELIBERATELY UNPINNED (issue #43): this reads `current_ver`, not the published
 * version the HTML byte path serves. `/text` is a credentialed ingestion channel
 * — the writing fleet's view of its own corpus — and an agent that just wrote a
 * version must be able to read it back. The pin exists to stop an agent
 * REACHING THE ANONYMOUS INTERNET through a public document, not to hide the
 * fleet's own writes from the fleet. Don't "align" this with `serveRaw`.
 *
 * TWO representations of the same read, chosen by `Accept` (`wantsJsonEnvelope`):
 *
 *   - `text/markdown` (default) — the body alone. What every existing caller
 *     gets, unchanged.
 *   - `application/json` — the `ReadTextResponse` envelope from src/contract.ts:
 *     body PLUS title/description/tags/slug/status/superseded_by, which
 *     `readDocumentTextCore` already returns and this route used to discard.
 *
 * The envelope exists because the metadata-less body pushed a caller that
 * wanted "body + is it deprecated?" toward one of two bad answers: two round
 * trips (`GET /d?slug=` then `/text`), or the shortcut to `/source` — which
 * hands back UNSANITIZED bytes to ingest as context. Rewarding that instinct is
 * the real cost, so the safe channel now answers in one call, exactly as MCP
 * `read_document` always has.
 *
 * Content negotiation rather than a new `/text.json` route: `/d/:id` and
 * `/s/:slug` already negotiate (on `Authorization`), the response shape already
 * existed in contract.ts, and `Accept` is where a client expresses this. A new
 * route would have added a name, a spec entry, and a second thing to keep in
 * sync for zero added expressiveness. `Vary: Accept` rides both branches so a
 * cache can never serve one shape for the other's request.
 */
async function renderTextResponse(publicId: string, env: Env, asJson: boolean): Promise<Response> {
  const result = await readDocumentTextCore(env, publicId);
  // The read core's error union includes `version_not_found`, but this caller
  // never passes a versionNo (always the current version), so only `not_found`
  // can arise here — the catch-all is intentional. If a versioned text route is
  // ever added, distinguish version_not_found the way the MCP layer and the
  // operator restore/promote routes do — but ONLY behind `requireReader`. On an
  // anonymous-reachable surface that code separates a live document from a
  // missing one, which is precisely the existence oracle this file works to
  // avoid everywhere else.
  if (!result.ok) return notFoundJson();

  const headers: Record<string, string> = {
    "content-type": asJson ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
    etag: `"v${result.version_no}"`,
    "x-sanitizer-version": result.sanitizer_v,
    "x-converter-version": result.converter_v,
    vary: "Accept",
    ...COMMON_HEADERS,
  };
  if (!asJson) return new Response(result.text, { status: 200, headers });

  // ReadTextResponse = the core Result minus its internal `ok` tag. Spelled out
  // rather than spread-minus-ok so a field added to the core Result can't leak
  // onto the wire without a decision here (the same discipline src/wire.ts
  // applies to the write responses).
  return new Response(
    JSON.stringify({
      text: result.text,
      version_no: result.version_no,
      sanitizer_v: result.sanitizer_v,
      converter_v: result.converter_v,
      title: result.title,
      description: result.description,
      tags: result.tags,
      slug: result.slug,
      status: result.status,
      superseded_by: result.superseded_by,
    }),
    { status: 200, headers },
  );
}

/**
 * GET /d/:public_id/text — Markdown derivation of the sanitized HTML, for an
 * agent or tooling that wants to ingest the document as context rather than
 * render it.
 *
 * **Requires a credential — an agent key OR operator (token/session)** (401 to
 * anonymous). The two `/text` endpoints are credentialed ingestion channels, not
 * public surfaces — both this and `/s/:slug/text` are gated identically, and
 * both honor the operator ≥ agent hierarchy (see `requireReader`). (Note: the
 * rendered bytes themselves stay publicly reachable at `/d/:public_id/raw`,
 * which the sandboxed iframe loads uncredentialed, so this gate keeps a clean
 * public Markdown API from existing rather than enforcing confidentiality of the
 * content.) The auth check runs before the id-shape check, matching
 * `/s/:slug/text`.
 *
 * Response carries the sanitizer + converter version tags as headers so a
 * caller can detect policy changes without parsing the body.
 *
 * `Accept: application/json` switches the body to the one-call read envelope
 * (body + title/tags/status/…) — see `renderTextResponse`. Anything else, or no
 * `Accept` at all, is unchanged.
 */
export async function serveText(publicId: string, req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator credentials required");
  if (denied) return denied;

  // Purely syntactic, so the hint costs no DB read and reveals nothing: a
  // slug in the id slot is the likeliest reason to land here.
  if (!PUBLIC_ID_RE.test(publicId)) {
    return notFoundJson(idShapeHint(publicId, (slug) => `/s/${slug}/text`));
  }
  return renderTextResponse(publicId, env, wantsJsonEnvelope(req));
}

/**
 * GET /s/:slug/text — the slug-addressed twin of `/d/:public_id/text`. Resolves
 * the slug to its live document, then delegates to `renderTextResponse` so the
 * Markdown derivation + headers are produced by exactly one code path.
 *
 * **Requires a credential — an agent key OR operator (token/session)** (401 to
 * anonymous), identical to `/d/:public_id/text`. On the slug surface the only
 * public variant is the browser-friendly shell at `/s/:slug`; every
 * machine-readable form by slug (the raw bytes via content negotiation on
 * `/s/:slug`, and this Markdown form) is gated. The auth check runs FIRST, before
 * slug validation or any DB hit, so an unauthenticated caller can't use this as a
 * slug-existence oracle.
 *
 * Resolution and the R2 fetch are two separate reads; `readDocumentTextCore`
 * (inside `renderTextResponse`) re-checks existence/revoked, so a revoke landing
 * between them still 404s rather than serving stale bytes.
 *
 * For an authenticated caller it rounds out the slug surface: fetch the Markdown
 * form in one hop (the HTTP analogue of the MCP `read_document` slug +
 * `format:"markdown"` route) instead of recovering the `public_id` first.
 */
export async function serveTextBySlug(slug: string, req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator credentials required");
  if (denied) return denied;

  const asJson = wantsJsonEnvelope(req);
  const v = validateSlugInput(slug);
  if (!v.ok) return notFoundJson();
  const publicId = await resolvePublicIdBySlug(env, v.slug);
  if (!publicId) {
    // This endpoint is credential-gated (auth checked above), so responses are
    // always machine JSON. A retired slug with a live redirect target → 409
    // slug_redirected, or the target's Markdown when ?follow_redirects=true; a
    // plain/dangling tombstone → 410 Gone; never-claimed → opaque 404.
    const tomb = await findSlugTombstoneCore(env, v.slug);
    if (!tomb) return notFoundJson();
    if (tomb.redirect_to) {
      const target = await resolveRedirectTarget(env, tomb.redirect_to);
      // Same disclosure gate as serveRetiredSlug, deliberately not skipped here
      // even though `requireReader` above already guarantees a non-anonymous
      // principal (so it always passes): the gate belongs on every path that
      // names a target, or the next surface added here inherits the leak.
      if (target && (await redirectTargetReadableBy(env, req, target))) {
        const follow = new URL(req.url).searchParams.get("follow_redirects") === "true";
        return follow
          ? renderTextResponse(target.public_id, env, asJson)
          : slugRedirectedJson(v.slug, target);
      }
    }
    return goneJson();
  }
  return renderTextResponse(publicId, env, asJson);
}

/**
 * GET /d/:public_id/source — the RETAINED, UNSANITIZED source S of the current
 * version, in its authored language (Markdown for a Markdown doc, original HTML
 * for an HTML doc). The HTTP twin of MCP `read_document representation:"source"`.
 * The read an agent does *before* `edit_document`, whose match runs against S.
 *
 * CURRENT version, deliberately — not the published one (issue #43). `edit_document`
 * patches the source it was handed and writes it forward from that base, so a
 * source-read pinned to an older published version would silently revert every
 * unpublished revision on the next edit. Same reasoning as `/text`: the pin
 * governs what the anonymous internet renders, not what the fleet reads back.
 *
 * **Requires a credential — an agent key OR operator (token/session)** (401 to
 * anonymous) — this is the FIRST credentialed GET on the `/d/:id` namespace.
 * `/d/:id`, `/d/:id/raw`, and `/s/:slug` are PUBLIC capability URLs that serve
 * only the sanitized H; this one is NOT public, because S is the pre-sanitization
 * bytes (it may contain markup the renderer would have stripped — treat it as
 * untrusted input). The auth check runs before the id-shape check, matching
 * `/d/:public_id/text`.
 *
 * Gated to ANY authenticated principal (operator ≥ agent, via `requireReader`),
 * NOT to agents only. Two guardrails, in tension, both deliberate:
 *   - Do NOT make it operator-only. In the single-tenant whole-fleet trust model
 *     any active agent key already reads and overwrites every document (core.ts
 *     does not scope by created_by), so a source-read discloses NO authority the
 *     caller lacks; narrowing to operator-only would break the only consumer this
 *     exists for (read-source → edit → republish) for zero real security.
 *   - Do NOT make it agent-only either (the bug this had at first): the operator
 *     is the apex principal and must never rank below an agent. Gating on
 *     `authenticateAgent` directly refused the operator token (it isn't an `awh_`
 *     key), so the operator couldn't read source over HTTP at all.
 * (Same guardrail discipline as src/session.ts's "don't fix the session signing
 * key to the pepper" note.)
 *
 * Returns the ReadSourceOk JSON shape plus an explicit `unsanitized: true`
 * provenance marker so a consuming agent can never silently treat S as the
 * safe/rendered view. `stripped[]` / `will_not_render[]` are re-derived from S
 * at read time (in core), surfacing where the live render diverges from this
 * source. Status codes (every error is the `{ error, message }` JSON envelope —
 * this route never emits a plain-text body):
 *   200  source returned
 *   401  anonymous / bad credential (neither a valid agent key nor operator)
 *   404  not_found — missing / revoked / malformed public_id (opaque; a
 *        slug-shaped id gets a hint naming `GET /d?slug=`, derived from the
 *        request alone)
 *   409  source_unavailable — the doc is live but its current version has no
 *        retained source (un-backfilled/legacy row, or the .src blob is gone).
 *        Distinct from 404 ON PURPOSE: it's a LOUD signal the §7 backfill
 *        missed this doc, not "no such document."
 */
export async function serveSource(publicId: string, req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator credentials required");
  if (denied) return denied;

  // No slug-addressed twin exists for /source (index.ts routes only /s/:slug and
  // /s/:slug/text), so the hint points at the resolver only.
  if (!PUBLIC_ID_RE.test(publicId)) return notFoundJson(idShapeHint(publicId, () => null));

  const result = await readDocumentSourceCore(env, publicId);
  if (!result.ok) {
    // No versionNo passed (current version only), so `version_not_found` from
    // the widened union can't occur here — `source_unavailable` and `not_found`
    // are the only reachable codes; everything else folds to the opaque 404.
    if (result.code === "source_unavailable") {
      return new Response(
        JSON.stringify({
          error: "source_unavailable",
          message:
            "document is live but its current version has no retained source — " +
            "it predates source retention and has not been backfilled",
        }),
        { status: 409, headers: { "content-type": "application/json", ...COMMON_HEADERS } },
      );
    }
    return notFoundJson();
  }

  return new Response(
    JSON.stringify({
      source: result.source,
      source_format: result.source_format,
      version_no: result.version_no,
      sanitizer_v: result.sanitizer_v,
      // SHA-256 of these source bytes (migration 0015) — the currency token an
      // agent caches for the cheap list-based "is my local copy current?" check (#35).
      source_sha256: result.source_sha256,
      stripped: result.stripped,
      will_not_render: result.will_not_render,
      // Explicit provenance: S is the pre-sanitization original. A consuming
      // agent must treat it as untrusted input (it may carry markup the
      // sanitizer would have stripped). See readDocumentSourceCore.
      unsanitized: true,
      title: result.title,
      description: result.description,
      tags: result.tags,
      slug: result.slug,
      status: result.status,
      superseded_by: result.superseded_by,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: `"v${result.version_no}"`,
        "x-sanitizer-version": result.sanitizer_v,
        ...COMMON_HEADERS,
      },
    },
  );
}

/**
 * GET /d/:public_id/links — the document's link-graph neighborhood (migration
 * 0016 / GitHub issue #40): `backlinks` (live docs whose bodies link here, as
 * full DocumentListing rows) + `outbound` (this doc's on-platform links with
 * their resolution state — the broken-link report). JSON only; the shape is
 * `DocumentLinksResponse` in src/contract.ts.
 *
 * Credential-gated like `/text` and `/source` (operator ≥ agent via
 * `requireReader`), NOT public: backlink rows are listing rows for OTHER
 * documents — including private ones — and the whole-fleet listing surface has
 * always been credentialed. Visibility never gates a credentialed read
 * (src/access.ts), so a private doc's neighborhood reads the same as a public
 * one's. Anonymous → 401; missing/revoked/malformed id → the opaque 404.
 *
 * Status codes (JSON envelope on every one — no plain-text bodies here):
 *   200  links returned
 *   401  anonymous / bad credential
 *   404  not_found — missing / revoked / malformed public_id (opaque; a
 *        slug-shaped id gets the `GET /d?slug=` hint)
 */
export async function serveLinks(publicId: string, req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator credentials required");
  if (denied) return denied;

  // Like /source: no slug-addressed twin, so the hint names only the resolver.
  if (!PUBLIC_ID_RE.test(publicId)) return notFoundJson(idShapeHint(publicId, () => null));

  const result = await documentLinksCore(env, publicId);
  if (!result.ok) return notFoundJson();

  return new Response(
    JSON.stringify({
      public_id: result.public_id,
      backlinks: result.backlinks,
      outbound: result.outbound,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", ...COMMON_HEADERS },
    },
  );
}

/**
 * GET /s/:slug — content-negotiates exactly like `serveDocument` does on
 * `/d/:public_id`, just resolved through the slug first:
 *
 *   - No `Authorization`  → shell page, with the pretty slug URL kept in the
 *                           address bar (no redirect). The browser case.
 *   - Valid credential    → raw sanitized bytes — the non-browser "bytes by
 *                           slug" API path (parity with `/d/:public_id`). Any
 *                           non-anonymous principal: an agent key OR the operator
 *                           token (operator ≥ agent — see `requireReader`).
 *   - Bad credential      → 401 (don't silently downgrade to shell — surface
 *                           broken keys/tokens, matching serveDocument).
 *
 * The auth'd-bytes path is the one a programmatic consumer (e.g. the Flutter
 * app) uses to fetch a document it only knows by slug. It used to work via the
 * old 302 → `/d/:public_id` redirect (curl preserves the Authorization header
 * across a same-host redirect, and serveDocument then content-negotiated to the
 * bytes); serving the shell directly would have removed it, so we negotiate
 * here instead — same contract, one fewer hop, slug stays in the bar for
 * browsers. (For the Markdown derivation by slug use `GET /s/:slug/text` — same
 * credential gate as the bytes branch here; or the MCP `read_document` slug+format
 * route. Only the no-auth shell above is public on the slug surface.)
 *
 * Slugs are agent/human-typeable handles, distinct from the unguessable
 * `public_id` capability. The endpoint is intentionally public: a slug is a
 * deliberate, lower-entropy capability — an opt-in to discoverability. A
 * document that carries one is, by design, reachable by anyone who can guess
 * or type the slug; one that omits a slug stays behind its unguessable
 * `public_id` alone. Most documents should NOT carry a slug — it's reserved
 * for content meant to be found by name or linked to from another document.
 * That matches the model documented in skills/publishing.md + the SOLO spec.
 *
 * On the shell branch the canonical / OG `og:url` point back at the slug — so a
 * re-shared link stays pretty and unfurls (Slack, Twitter) link to the slug,
 * not the capability id. This stable `/s/:slug` URL is also the cross-reference
 * mechanism: an agent can author `<a href="/s/other-doc">` in one document
 * before the other exists, and the link resolves at click/read time.
 *
 * Package A (deliberate): the shell's iframe still loads `/d/:public_id/raw` and
 * the toolbar's Manage link still targets `/d/:public_id/manage`, so the
 * `public_id` appears in the page's HTML source. That is NOT a privilege leak —
 * the slug already grants full read access to the same document, and manage/
 * revoke stay operator-gated — but it means "view source" reveals the id. (A
 * fully slug-native render with no public_id in the markup would need a
 * `/s/:slug/raw` endpoint; left out by choice.)
 *
 * Freshness is preserved without the redirect: `findDocumentBySlugCore`
 * re-resolves the slug on every request and `Cache-Control: no-store`
 * (COMMON_HEADERS, via renderShell / serveRaw) forbids caching, so a slug that
 * was live and then revoked serves the document while live and 410s once
 * retired, on each hit. (Slugs are no longer reusable — migration 0009 — so a
 * retired slug never starts resolving to a *different* document.)
 *
 * Validates the slug shape before hitting D1 so malformed input (`/s/Foo`,
 * `/s/`, trailing slash, etc.) 404s without burning a query — matching how
 * PUBLIC_ID_RE gates serveDocument upstream of the DB.
 */
export async function serveBySlug(slug: string, req: Request, env: Env): Promise<Response> {
  const v = validateSlugInput(slug);
  // A malformed slug is never a real doc, so it's outside the private-vs-absent
  // oracle set — but a human typo deserves the same browser 404 as a valid-shape
  // miss. Agents (Authorization header present) keep the plain body.
  if (!v.ok) return req.headers.has("authorization") ? notFound() : notFoundBrowser(req);
  const result = await findDocumentBySlugCore(env, v.slug);
  if (!result.ok) {
    // Live miss → a RETIRED slug (migration 0009/0010) forwards loudly if it
    // carries a redirect, else 410 Gone; a never-claimed slug stays an opaque
    // 404. serveRetiredSlug content-negotiates the same way as a live hit:
    // interstitial/JSON for browsers/agents respectively.
    return await serveRetiredSlug(v.slug, req, env);
  }

  const d = result.document;

  // Content negotiation, mirroring serveDocument: a credential (agent key or
  // operator token) takes the bytes-by-slug path (serveRaw re-checks revoked +
  // visibility and streams from R2 by public_id), no header takes the shell. A
  // present-but-invalid credential 401s rather than downgrading, so a broken
  // integration is loud, not silent.
  if (req.headers.has("authorization")) {
    const denied = await requireReader(req, env, "invalid credentials — provide a valid agent key or operator token");
    if (denied) return denied;
    return serveRaw(d.public_id, req, env);
  }

  // Shell branch (no Authorization header) → operator auth is cookie-only, same
  // as serveShell. Drives the toolbar menu's signed-in/out items.
  const op = await authenticateOperatorRequest(req, env);

  // Visibility gate (migration 0011), same shape as serveShell. A private doc
  // with a slug returns the opaque 404 here — NOT serveRetiredSlug's 410/redirect
  // (the slug is live, not retired; we mask discovery, not announce removal). The
  // slug stays claimed; making the doc public again relights it. Agent/operator
  // bytes already passed via the branch above (agent) or `op.ok` (operator).
  const principal: Principal = op.ok ? { kind: "operator" } : { kind: "anonymous" };
  if (!canRead(principal, { visibility: d.visibility, revoked: false })) return notFoundBrowser(req);

  // The iframe below loads `/d/:public_id/raw`, which pins to the SERVED version
  // (issue #43), so this shell's metadata has to resolve the same rule or the
  // page would describe bytes the visitor isn't seeing — and `<title>`/`og:title`
  // /`og:description` are a link-unfurl surface, so that's a correctness bug,
  // not a cosmetic one. The listing row carries the CURRENT version's
  // title/description (`LISTING_JOINS` pins `v.version_no = d.current_ver`),
  // which is already right whenever the served version IS current: every private
  // document, and every public one whose promoted pointer is caught up. Only a
  // public document serving an older promoted version costs the extra read.
  const servedVer = servedVersion(d) ?? 0; // live doc (revoked excluded by the lookup) → non-null
  let servedTitle = d.title;
  let servedDescription = d.description;
  if (d.current_ver !== null && servedVer !== d.current_ver) {
    const sv = await env.META.prepare(
      `select v.title, v.description
         from documents dd
         join versions v on v.document_id = dd.id and v.version_no = ?
        where dd.public_id = ?`,
    )
      .bind(servedVer, d.public_id)
      .first<{ title: string | null; description: string | null }>();
    // A miss is not reachable (the pointer is verified at promote time and
    // version rows survive until revoke), but fall back to the listing row's
    // metadata rather than blanking the page if it ever happens.
    if (sv) {
      servedTitle = sv.title;
      servedDescription = sv.description;
    }
  }

  const origin = new URL(req.url).origin;
  return renderShell(
    {
      createdAtIso: d.created_at,
      version: servedVer,
      agentName: d.created_by_name,
      title: servedTitle,
      description: servedDescription,
      visibility: d.visibility,
      publishNotice: publishNoticeFor(op.ok, d, d.public_id),
    },
    {
      // Package A: iframe + manage reuse the public_id surface (the management
      // endpoints are public_id-addressed); canonical + pagePath are the slug so
      // the shared/unfurled URL — and the post-login landing — stay pretty. See
      // the doc comment above.
      iframeSrc: `/d/${d.public_id}/raw`,
      manageHref: `/d/${d.public_id}/manage`,
      canonicalUrl: `${origin}/s/${v.slug}`,
      pagePath: `/s/${v.slug}`,
    },
    op.ok,
  );
}
