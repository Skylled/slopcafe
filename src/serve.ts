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
 *   GET /d/:public_id/revoke    → operator-token confirmation page (form to POST below)
 *   POST /d/:public_id/revoke   → verifies operator_token and calls revokeDocumentCore
 *
 * Shell + raw 404 if the document is missing or `revoked_at` is set. All
 * routes send `Cache-Control: no-store` so a revoke really is the kill
 * switch the action plan promises.
 */

import { canRead, type Principal, resolvePrincipal, type Visibility } from "./access.js";
import { authenticateAgent, authenticateOperator } from "./auth.js";
import { etagForVersion, ifNoneMatchSatisfied } from "./conditional.js";
import {
  findDocumentBySlugCore,
  findSlugTombstoneCore,
  listVersionsCore,
  readDocumentSourceCore,
  readDocumentTextCore,
  type RedirectTarget,
  resolvePublicIdBySlug,
  resolveRedirectTarget,
  restoreVersionCore,
  revokeDocumentCore,
  type SetSlugOk,
  setDocumentSlugCore,
  setDocumentVisibilityCore,
  type VersionListing,
} from "./core.js";
import type { Env } from "./env.js";
import { authenticateOperatorRequest, csrfMatches } from "./session.js";
import {
  formatPageTitle,
  formatSlugReject,
  SITE_BRAND,
  validateSlugInput,
  normalizeTitleForDisplay,
  normalizeDescriptionForDisplay,
} from "./metadata.js";

/** Format of values produced by `newPublicId()` — 22 chars of URL-safe base64. */
export const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Headers shared by both routes. Browsers see HTML, no leaks, no caching. */
const COMMON_HEADERS: Record<string, string> = {
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
 * Rendered-document CSP. The load-bearing wall from action-plan-v1.md.
 *   - `script-src` is covered by `default-src 'none'`
 *   - `style-src 'unsafe-inline'` so inline `style="…"` attributes work
 *     (the sanitizer strips `<style>` blocks; only attribute styles flow)
 *   - `img/style/font` allow `data:` for inlined assets
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
 * CSP for the revoke confirmation + result pages. Identical to SHELL_CSP
 * except `form-action 'self'` so the confirmation form can POST same-origin.
 * No iframe is loaded from these pages, so `frame-src` is irrelevant.
 */
const REVOKE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/**
 * CSP for the HTML 404 page (browser document routes). It hosts only links (the
 * sign-in link + a home link) — no forms, no scripts — so `form-action 'none'`.
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

/** Prepended to Markdown-doc bodies at serve time. See READER_THEME_CSS. */
const READER_THEME_PREFIX = `<!doctype html>\n<style>${READER_THEME_CSS}</style>\n`;

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
 */
function notFound(): Response {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", ...COMMON_HEADERS },
  });
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
    headers: { "content-type": "text/html; charset=utf-8", ...COMMON_HEADERS },
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
    headers: { "content-type": "text/html; charset=utf-8", ...COMMON_HEADERS },
  });
}

/**
 * Resolve a retired slug to a Response for the shell surface (`GET /s/:slug`).
 * Called only after the live lookup misses. Three outcomes:
 *   - tombstone with a LIVE redirect target → forward loudly: a browser gets the
 *     click-through interstitial; an agent (Authorization header) gets
 *     `409 slug_redirected`, or is served the target's bytes when it passed
 *     `?follow_redirects=true` (re-checking the agent key first, like the live
 *     bytes branch);
 *   - plain tombstone (no redirect, or a dangling/revoked target) → 410 Gone;
 *   - no tombstone → opaque 404.
 */
async function serveRetiredSlug(
  slug: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const tomb = await findSlugTombstoneCore(env, slug);
  // Never-claimed slug. Browser → the login-link 404 (so a private slugged doc's
  // 404 and a never-claimed slug's 404 stay byte-identical — no oracle); agent
  // (Authorization header) → the plain body.
  if (!tomb) return req.headers.has("authorization") ? notFound() : notFoundBrowser(req);

  const isAgent = req.headers.has("authorization");

  if (tomb.redirect_to) {
    const target = await resolveRedirectTarget(env, tomb.redirect_to);
    if (target) {
      if (isAgent) {
        const agent = await authenticateAgent(req, env);
        if (!agent) return unauthorizedJson("invalid agent key");
        const follow =
          new URL(req.url).searchParams.get("follow_redirects") === "true";
        return follow ? serveRaw(target.public_id, req, env) : slugRedirectedJson(slug, target);
      }
      return redirectInterstitial(target);
    }
    // Dangling target (revoked/unknown) → fall through to a plain 410.
  }

  return isAgent ? goneJson() : goneHtml();
}

/**
 * 401 JSON for the agent-auth read surfaces (serveDocument's bytes branch,
 * serveBySlug's bytes branch, and both `/text` endpoints). Message varies:
 * "invalid agent key" where a header was definitely present (content
 * negotiation only reaches auth when `Authorization` is set), "valid agent key
 * required" on the gated `/text` endpoints where the key may be absent entirely.
 */
function unauthorizedJson(message: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", message }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/** HTML-escape minimal entity set for safe interpolation into element text. */
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Render a `documents.created_at` ISO timestamp as `YYYY-MM-DD HH:MM UTC`.
 * Server-rendered because the shell CSP forbids JS (no `Intl` in the page).
 * Slicing — not parsing — because D1 always emits the canonical strftime
 * shape `YYYY-MM-DDTHH:MM:SS.sssZ` (see migrations/0001_init.sql defaults).
 */
function formatCreatedAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * GET /d/:public_id — the URL agents share with humans. Content-negotiates
 * via `Authorization`:
 *
 *   - No header  → shell page (the browser case).
 *   - Valid key  → raw sanitized HTML, same bytes as `/raw`.
 *   - Bad key    → 401 (don't silently downgrade to shell — surface broken keys).
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
    const agent = await authenticateAgent(req, env);
    if (!agent) return unauthorizedJson("invalid agent key");
    return serveRaw(publicId, req, env);
  }
  const origin = new URL(req.url).origin;
  return serveShell(publicId, req, env, origin);
}

/**
 * Build the toolbar + iframe shell Response from a document's current-version
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
  },
  links: { iframeSrc: string; manageHref: string; canonicalUrl: string; pagePath: string },
  authenticated: boolean,
): Response {
  const createdAt = escapeHtml(formatCreatedAt(meta.createdAtIso));
  const version = meta.version;
  const author = meta.agentName ? escapeHtml(meta.agentName) : "[deleted agent]";

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
</div>
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
  // current version; LEFT so a revoked doc (current_ver = null) still returns
  // a row and falls through to the 404 below.
  const row = await env.META.prepare(
    `select d.revoked_at, d.created_at, d.current_ver, d.visibility, a.name as agent_name,
       v.title as doc_title, v.description as doc_description
     from documents d
     left join agents a on a.id = d.created_by
     left join versions v on v.document_id = d.id and v.version_no = d.current_ver
     where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      revoked_at: string | null;
      created_at: string;
      current_ver: number | null;
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
      version: row.current_ver ?? 0, // not reachable when null (revoked → 404 above)
      agentName: row.agent_name,
      title: row.doc_title,
      description: row.doc_description,
      visibility: row.visibility,
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
 * The document rendered at `/` (the public landing page). Deploy-time
 * constant: to repoint the homepage at a different document, change this and
 * redeploy. Must match PUBLIC_ID_RE — it's interpolated into the shell HTML
 * and the iframe `src` without escaping, exactly like the regex-checked ids
 * elsewhere in this file.
 */
const HOMEPAGE_PUBLIC_ID = "hdbOcFnhL1y9fe0tWpBvXA";

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
 * Missing or revoked homepage doc → the same opaque 404 as everywhere else.
 */
export async function serveHomepage(env: Env, origin: string): Promise<Response> {
  // Same LEFT JOIN shape as serveShell, trimmed to what a toolbar-less page
  // needs: existence/kill check + current-version title/description for <head>.
  const row = await env.META.prepare(
    `select d.revoked_at, d.visibility, v.title as doc_title, v.description as doc_description
     from documents d
     left join versions v on v.document_id = d.id and v.version_no = d.current_ver
     where d.public_id = ?`,
  )
    .bind(HOMEPAGE_PUBLIC_ID)
    .first<{
      revoked_at: string | null;
      visibility: Visibility;
      doc_title: string | null;
      doc_description: string | null;
    }>();
  if (!row || row.revoked_at) return notFound();

  // The homepage is the public face by definition, so it's gated as an
  // anonymous read: if the operator ever points HOMEPAGE_PUBLIC_ID at a private
  // doc (a misconfig), `/` 404s cleanly rather than rendering a shell whose
  // iframe (`/d/HOMEPAGE/raw`, itself gated in serveRaw) would 404. A public
  // homepage doc passes; this is the expected steady state.
  if (!canRead({ kind: "anonymous" }, { visibility: row.visibility, revoked: false })) {
    return notFound();
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
<iframe sandbox="${SANDBOX}" src="/d/${HOMEPAGE_PUBLIC_ID}/raw" referrerpolicy="no-referrer"></iframe>
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

  // Single join to get document state + the R2 key for the current version.
  // `source_format` decides whether to inject the reading theme (Markdown) or
  // serve the stored bytes verbatim (HTML — author owns presentation).
  // `visibility` drives the access gate below.
  const row = await env.META.prepare(
    `select d.revoked_at, d.visibility, v.r2_key, v.version_no, v.source_format
     from documents d
     join versions v on v.document_id = d.id and v.version_no = d.current_ver
     where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      revoked_at: string | null;
      visibility: Visibility;
      r2_key: string;
      version_no: number;
      source_format: string;
    }>();
  if (!row || row.revoked_at) return notFound();

  // Access gate: operator/agent read everything; anonymous reads only public.
  const principal = await resolvePrincipal(req, env);
  if (!canRead(principal, { visibility: row.visibility, revoked: false })) return notFound();

  // Conditional GET: if the client already holds this version, answer a bodyless
  // 304 and skip the R2 GET + body transfer. MUST stay AFTER the revoke +
  // visibility gate above — a 304 confirms existence + version, so emitting one
  // earlier would turn a private/revoked doc's opaque 404 into an oracle.
  if (ifNoneMatchSatisfied(req.headers.get("if-none-match"), row.version_no)) {
    return new Response(null, {
      status: 304,
      headers: { etag: etagForVersion(row.version_no), ...COMMON_HEADERS },
    });
  }

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return notFound(); // shouldn't happen — D1 says it should exist

  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": RAW_CSP,
    etag: etagForVersion(row.version_no),
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
 * Build the Markdown-derivation response for an already-resolved public_id.
 * No auth, no id-shape check — callers (`serveText`, `serveTextBySlug`) own
 * those gates; this is the single place the conversion + headers (`text/markdown`,
 * ETag, sanitizer/converter version tags, no-store) are produced.
 *
 * Conversion runs on every request (no per-version cache in v1); the underlying
 * bytes come from R2 via `readDocumentTextCore`, so a revoked doc still 404s.
 */
async function renderTextResponse(publicId: string, env: Env): Promise<Response> {
  const result = await readDocumentTextCore(env, publicId);
  // The read core's error union includes `version_not_found`, but this caller
  // never passes a versionNo (always the current version), so only `not_found`
  // can arise here — the catch-all is intentional. If a versioned text route is
  // ever added, distinguish version_not_found the way the MCP layer does.
  if (!result.ok) return notFound();

  return new Response(result.text, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      etag: `"v${result.version_no}"`,
      "x-sanitizer-version": result.sanitizer_v,
      "x-converter-version": result.converter_v,
      ...COMMON_HEADERS,
    },
  });
}

/**
 * GET /d/:public_id/text — Markdown derivation of the sanitized HTML, for an
 * agent or tooling that wants to ingest the document as context rather than
 * render it.
 *
 * **Requires a valid agent key** (401 otherwise). The two `/text` endpoints are
 * agent-facing ingestion channels, not public surfaces — both this and
 * `/s/:slug/text` are gated identically. (Note: the rendered bytes themselves
 * stay publicly reachable at `/d/:public_id/raw`, which the sandboxed iframe
 * loads uncredentialed, so this gate keeps a clean public Markdown API from
 * existing rather than enforcing confidentiality of the content.) The auth
 * check runs before the id-shape check, matching `/s/:slug/text`.
 *
 * Response carries the sanitizer + converter version tags as headers so a
 * caller can detect policy changes without parsing the body.
 */
export async function serveText(publicId: string, req: Request, env: Env): Promise<Response> {
  const agent = await authenticateAgent(req, env);
  if (!agent) return unauthorizedJson("valid agent key required");

  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  return renderTextResponse(publicId, env);
}

/**
 * GET /s/:slug/text — the slug-addressed twin of `/d/:public_id/text`. Resolves
 * the slug to its live document, then delegates to `renderTextResponse` so the
 * Markdown derivation + headers are produced by exactly one code path.
 *
 * **Requires a valid agent key** (401 otherwise), identical to
 * `/d/:public_id/text`. On the slug surface the only public variant is the
 * browser-friendly shell at `/s/:slug`; every machine-readable form by slug (the
 * raw bytes via content negotiation on `/s/:slug`, and this Markdown form) is
 * gated. The auth check runs FIRST, before slug validation or any DB hit, so an
 * unauthenticated caller can't use this as a slug-existence oracle.
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
  const agent = await authenticateAgent(req, env);
  if (!agent) return unauthorizedJson("valid agent key required");

  const v = validateSlugInput(slug);
  if (!v.ok) return notFound();
  const publicId = await resolvePublicIdBySlug(env, v.slug);
  if (!publicId) {
    // This endpoint is agent-gated (auth checked above), so responses are always
    // machine JSON. A retired slug with a live redirect target → 409
    // slug_redirected, or the target's Markdown when ?follow_redirects=true; a
    // plain/dangling tombstone → 410 Gone; never-claimed → opaque 404.
    const tomb = await findSlugTombstoneCore(env, v.slug);
    if (!tomb) return notFound();
    if (tomb.redirect_to) {
      const target = await resolveRedirectTarget(env, tomb.redirect_to);
      if (target) {
        const follow = new URL(req.url).searchParams.get("follow_redirects") === "true";
        return follow ? renderTextResponse(target.public_id, env) : slugRedirectedJson(v.slug, target);
      }
    }
    return goneJson();
  }
  return renderTextResponse(publicId, env);
}

/**
 * GET /d/:public_id/source — the RETAINED, UNSANITIZED source S of the current
 * version, in its authored language (Markdown for a Markdown doc, original HTML
 * for an HTML doc). The HTTP twin of MCP `read_document representation:"source"`.
 * The read an agent does *before* `edit_document`, whose match runs against S.
 *
 * **Requires a valid agent key** (401 otherwise) — this is the FIRST
 * authenticated GET on the `/d/:id` namespace. `/d/:id`, `/d/:id/raw`, and
 * `/s/:slug` are PUBLIC capability URLs that serve only the sanitized H; this
 * one is NOT public, because S is the pre-sanitization bytes (it may contain
 * markup the renderer would have stripped — treat it as untrusted input). The
 * auth check runs before the id-shape check, matching `/d/:public_id/text`.
 *
 * Agent-key gating is DELIBERATE — do NOT "harden" this to operator-only out of
 * caution. In the single-tenant whole-fleet trust model any active agent key
 * already reads and overwrites every document (core.ts does not scope by
 * created_by), so a source-read discloses NO authority the caller lacks; it only
 * exposes the unsanitized bytes of a doc the caller can already fully read and
 * control. Operator-only would break the only consumer this exists for
 * (read-source → edit → republish) for zero real security. (Same guardrail
 * discipline as src/session.ts's "don't fix the session signing key to the
 * pepper" note.)
 *
 * Returns the ReadSourceOk JSON shape plus an explicit `unsanitized: true`
 * provenance marker so a consuming agent can never silently treat S as the
 * safe/rendered view. `stripped[]` / `will_not_render[]` are re-derived from S
 * at read time (in core), surfacing where the live render diverges from this
 * source. Status codes:
 *   200  source returned
 *   401  bad/missing agent auth
 *   404  missing / revoked / malformed public_id
 *   409  source_unavailable — the doc is live but its current version has no
 *        retained source (un-backfilled/legacy row, or the .src blob is gone).
 *        Distinct from 404 ON PURPOSE: it's a LOUD signal the §7 backfill
 *        missed this doc, not "no such document."
 */
export async function serveSource(publicId: string, req: Request, env: Env): Promise<Response> {
  const agent = await authenticateAgent(req, env);
  if (!agent) return unauthorizedJson("valid agent key required");

  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

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
    return notFound();
  }

  return new Response(
    JSON.stringify({
      source: result.source,
      source_format: result.source_format,
      version_no: result.version_no,
      sanitizer_v: result.sanitizer_v,
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
 * GET /s/:slug — content-negotiates exactly like `serveDocument` does on
 * `/d/:public_id`, just resolved through the slug first:
 *
 *   - No `Authorization`  → shell page, with the pretty slug URL kept in the
 *                           address bar (no redirect). The browser case.
 *   - Valid agent key     → raw sanitized bytes — the non-browser "bytes by
 *                           slug" API path (parity with `/d/:public_id`).
 *   - Bad key             → 401 (don't silently downgrade to shell — surface
 *                           broken keys, matching serveDocument).
 *
 * The auth'd-bytes path is the one a programmatic consumer (e.g. the Flutter
 * app) uses to fetch a document it only knows by slug. It used to work via the
 * old 302 → `/d/:public_id` redirect (curl preserves the Authorization header
 * across a same-host redirect, and serveDocument then content-negotiated to the
 * bytes); serving the shell directly would have removed it, so we negotiate
 * here instead — same contract, one fewer hop, slug stays in the bar for
 * browsers. (For the Markdown derivation by slug use `GET /s/:slug/text` — same
 * agent-key gate as the bytes branch here; or the MCP `read_document` slug+format
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
 * the Revoke link still targets `/d/:public_id/revoke`, so the `public_id`
 * appears in the page's HTML source. That is NOT a privilege leak — the slug
 * already grants full read access to the same document, and revoke stays
 * operator-gated — but it means "view source" reveals the capability id. (A
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

  // Content negotiation, mirroring serveDocument: an agent key takes the
  // bytes-by-slug path (serveRaw re-checks revoked + streams from R2 by
  // public_id), no header takes the shell. A present-but-invalid key 401s
  // rather than downgrading, so a broken integration is loud, not silent.
  if (req.headers.has("authorization")) {
    const agent = await authenticateAgent(req, env);
    if (!agent) return unauthorizedJson("invalid agent key");
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

  const origin = new URL(req.url).origin;
  return renderShell(
    {
      createdAtIso: d.created_at,
      version: d.current_ver ?? 0, // live doc (revoked excluded by the lookup) → non-null
      agentName: d.created_by_name,
      title: d.title,
      description: d.description,
      visibility: d.visibility,
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

/**
 * GET /d/:public_id/revoke — confirmation page for an operator about to
 * revoke a document. Mirrors the /authorize consent shape: card layout,
 * Confirm/Cancel.
 *
 * Session-aware: if the operator already has a valid browser session cookie,
 * the form is a plain Revoke button carrying a hidden CSRF token (the *verified*
 * session nonce — no token paste). Otherwise it falls back to the operator-token
 * password field. `Vary: Cookie` because the rendered body now depends on the
 * cookie (already `no-store`, so this is belt-and-suspenders).
 *
 * Returns the same opaque 404 as the shell for missing/revoked docs so
 * direct navigation can't probe whether an id ever existed.
 */
export async function serveRevokeConfirm(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  const row = await env.META.prepare(
    "select revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ revoked_at: string | null }>();
  if (!row || row.revoked_at) return notFound();

  // A live browser session lets the operator confirm without re-pasting the
  // token; the hidden field carries the session-bound CSRF nonce.
  const auth = await authenticateOperatorRequest(req, env);
  const csrfToken = auth.ok && auth.via === "cookie" ? auth.csrf : null;

  return new Response(renderRevokePage("confirm", publicId, undefined, false, undefined, csrfToken), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": REVOKE_CSP,
      vary: "Cookie",
      ...COMMON_HEADERS,
    },
  });
}

/**
 * POST /d/:public_id/revoke — authorizes via EITHER path, then forwards to
 * `revokeDocumentCore`:
 *
 *   - Pasted token: a non-empty `operator_token` form field is validated via
 *     `authenticateOperator` (synthetic Bearer header, the same primitive that
 *     gates the JSON DELETE route and the OAuth consent flow). No CSRF token is
 *     required — the pasted token IS the inline credential, not an ambient one.
 *   - Browser session: if no token was pasted, a valid session cookie plus a
 *     matching `csrf_token` form field authorizes the revoke. CSRF is required
 *     here precisely because the cookie is ambient.
 *
 * Returns terminal HTML — never 302s, since the underlying doc is gone.
 * Result pages share REVOKE_CSP even though they host no form; cheaper
 * than authoring a third CSP for a one-shot screen.
 */
export async function handleRevokeForm(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) {
    return revokeResultResponse(
      404,
      renderRevokePage("error", publicId, "Document not found or already revoked."),
    );
  }

  const form = await req.formData();
  const operatorToken = String(form.get("operator_token") ?? "");

  if (operatorToken) {
    // Pasted-token path. Mirror authorize.ts: build a synthetic Bearer request
    // so the same operator-auth primitive backs every operator-facing surface.
    const synth = new Request(req.url, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    if (!authenticateOperator(synth, env)) {
      return revokeResultResponse(
        401,
        renderRevokePage("error", publicId, "Operator token incorrect.", true),
      );
    }
  } else {
    // Browser-session path: valid cookie + matching CSRF token.
    const auth = await authenticateOperatorRequest(req, env);
    if (!auth.ok || auth.via !== "cookie") {
      return revokeResultResponse(
        401,
        renderRevokePage("error", publicId, "Sign in or paste the operator token to revoke.", true),
      );
    }
    if (!csrfMatches(String(form.get("csrf_token") ?? ""), auth.csrf)) {
      return revokeResultResponse(
        403,
        renderRevokePage("error", publicId, "CSRF check failed — reload and try again.", true),
      );
    }
  }

  const result = await revokeDocumentCore(env, publicId);
  if (!result.ok) {
    return revokeResultResponse(
      404,
      renderRevokePage("error", publicId, "Document not found or already revoked."),
    );
  }

  return revokeResultResponse(
    200,
    renderRevokePage("success", publicId, undefined, false, result.r2_objects_purged),
  );
}

function revokeResultResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": REVOKE_CSP,
      ...COMMON_HEADERS,
    },
  });
}

/**
 * Single template for the confirm page and the two result pages — they all
 * share the same card chrome from /authorize. `mode` picks the body.
 *
 *  - `confirm`: warning + form. `error`/`success`: terminal screens.
 *  - `retryLink` (error only): link target is the confirmation page so the
 *    operator can re-paste the token; omit for definitive errors (bad id,
 *    already-revoked) where retrying makes no sense.
 *  - `purged` (success only): number of R2 objects deleted.
 *  - `csrfToken` (confirm only): when set, the operator has a live browser
 *    session, so the form is a plain Revoke button carrying this hidden CSRF
 *    token — no password field. When null, fall back to the token-paste field.
 */
function renderRevokePage(
  mode: "confirm" | "error" | "success",
  publicId: string,
  errorMessage?: string,
  retryLink?: boolean,
  purged?: number,
  csrfToken?: string | null,
): string {
  const safeId = escapeHtml(publicId);
  let body: string;
  if (mode === "confirm") {
    const formInner = csrfToken
      ? `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
<p class="note">Signed in as operator — no token needed.</p>`
      : `<label for="operator_token">Operator token</label>
<input id="operator_token" name="operator_token" type="password" required autocomplete="off">`;
    body = `<h1>Revoke <span class="mono">${safeId}</span>?</h1>
<p>Bytes are purged from R2 immediately and the URL will <b>404 forever</b>. The <code>versions</code> audit trail is kept; only the rendered HTML is destroyed. This cannot be undone.</p>
<form method="POST" action="/d/${publicId}/revoke">
${formInner}
<div class="row">
<a class="cancel" href="/d/${publicId}">Cancel</a>
<button type="submit">Revoke</button>
</div>
</form>`;
  } else if (mode === "error") {
    const retry = retryLink
      ? `<p class="note"><a href="/d/${publicId}/revoke">Try again</a></p>`
      : "";
    body = `<h1>Revoke failed</h1>
<p>${escapeHtml(errorMessage ?? "Unknown error.")}</p>
${retry}`;
  } else {
    const n = purged ?? 0;
    body = `<h1>Document revoked</h1>
<p><span class="mono">${safeId}</span> is gone. <b>${n}</b> R2 object${n === 1 ? "" : "s"} purged. This URL will now 404.</p>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Revoke document | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 12px;font-weight:600}
p{margin:0 0 16px;color:#555}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#222}
label{display:block;margin:18px 0 6px;font-size:13px;color:#555}
input[type=password]{width:100%;box-sizing:border-box;padding:9px 10px;font:13px/1.4 system-ui,sans-serif;border:1px solid #ccc;border-radius:4px}
.row{display:flex;gap:8px;margin-top:18px}
button,a.cancel{flex:1;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;cursor:pointer;text-align:center;text-decoration:none;box-sizing:border-box}
button{background:#a00;color:#fff;border-color:#a00}
a.cancel{background:#fff;color:#222}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>
`;
}

/* ------------------------------------------------------------------------- *
 * Operator document-management page (`/d/:public_id/manage`).
 *
 * One page, three operator actions folded together (the "Manage…" toolbar
 * item replaces the old standalone "Revoke…"): toggle visibility, add/rename/
 * clear the slug, and revoke. All three are operator-only and reversible
 * EXCEPT revoke. The page renders its CONTROLS only for a live browser SESSION
 * (cookie) — the CSRF nonce the forms echo comes from that session, and this is
 * browser-only UI; a Bearer-only or anonymous caller gets a sign-in prompt
 * instead. The POST handlers still accept a pasted operator token too (parity
 * with handleRevokeForm), so a hand-built curl form works.
 *
 * Shares REVOKE_CSP (`form-action 'self'`) so the page's POST forms submit
 * same-origin. The revoke form posts to the EXISTING `/d/:id/revoke`
 * (handleRevokeForm) verbatim — no new revoke code.
 * ------------------------------------------------------------------------- */

/** Current state the manage page renders. */
type ManageState = {
  publicId: string;
  visibility: Visibility;
  slug: string | null;
  title: string | null;
  /** Full version history, newest first (listVersionsCore). */
  versions: VersionListing[];
};

/** A one-line banner above the manage sections after a POST. */
type ManageNotice = { kind: "ok" | "err"; message: string };

/**
 * Load the live document's management-relevant state. Returns null for a
 * missing or revoked document (callers map that to the opaque 404 / a
 * "not found" notice). Same LEFT JOIN shape as serveShell, trimmed.
 */
async function loadManageState(env: Env, publicId: string): Promise<ManageState | null> {
  const row = await env.META.prepare(
    `select d.revoked_at, d.visibility, d.slug, v.title as doc_title
       from documents d
       left join versions v on v.document_id = d.id and v.version_no = d.current_ver
      where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      revoked_at: string | null;
      visibility: Visibility;
      slug: string | null;
      doc_title: string | null;
    }>();
  if (!row || row.revoked_at) return null;
  // History is cheap (D1-only). listVersionsCore re-checks liveness; on the rare
  // race where the doc revokes between the two reads it returns [], which the
  // page renders as "no history" rather than throwing.
  const history = await listVersionsCore(env, publicId);
  return {
    publicId,
    visibility: row.visibility,
    slug: row.slug,
    title: row.doc_title,
    versions: history.ok ? history.versions : [],
  };
}

/** Standard manage-surface Response: HTML, REVOKE_CSP, Vary: Cookie, no-store. */
function manageResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": REVOKE_CSP,
      vary: "Cookie",
      ...COMMON_HEADERS,
    },
  });
}

/**
 * Operator-auth ladder for the manage page's POST forms (visibility / slug),
 * mirroring handleRevokeForm: a non-empty pasted `operator_token` authorizes
 * outright (synthetic Bearer, CSRF-exempt — the token IS the inline
 * credential); otherwise a valid session cookie plus a matching `csrf_token`
 * form field. On the cookie path the verified nonce is returned so a
 * re-rendered manage page's forms can carry it.
 */
type FormAuthz =
  | { ok: true; via: "bearer" }
  | { ok: true; via: "cookie"; csrf: string }
  | { ok: false; status: number; message: string };

async function authorizeOperatorForm(
  req: Request,
  env: Env,
  form: FormData,
): Promise<FormAuthz> {
  const operatorToken = String(form.get("operator_token") ?? "");
  if (operatorToken) {
    const synth = new Request(req.url, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    if (!authenticateOperator(synth, env)) {
      return { ok: false, status: 401, message: "Operator token incorrect." };
    }
    return { ok: true, via: "bearer" };
  }
  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok || auth.via !== "cookie") {
    return { ok: false, status: 401, message: "Sign in or paste the operator token to make changes." };
  }
  if (!csrfMatches(String(form.get("csrf_token") ?? ""), auth.csrf)) {
    return { ok: false, status: 403, message: "CSRF check failed — reload and try again." };
  }
  return { ok: true, via: "cookie", csrf: auth.csrf };
}

/**
 * GET /d/:public_id/manage — the operator management page. Cookie session
 * required to see the controls; a non-cookie caller gets a sign-in prompt
 * rendered WITHOUT a DB hit, so it discloses nothing about whether the id
 * exists (no existence oracle for a guessed public_id — the public_id is
 * already the read capability, so this adds nothing the shell doesn't).
 */
export async function serveManagePage(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok || auth.via !== "cookie") {
    return manageResponse(renderManageSignin(publicId));
  }

  const state = await loadManageState(env, publicId);
  if (!state) return notFound();
  return manageResponse(renderManagePage(state, auth.csrf));
}

/**
 * POST /d/:public_id/visibility — operator flips a live doc public/private via
 * the manage page's toggle form. No version bump. On the cookie path the page
 * re-renders with a notice; on the pasted-token path a terminal result card.
 */
export async function handleVisibilityForm(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) return manageResultCard(publicId, authz.status, { kind: "err", message: authz.message });

  const target = String(form.get("visibility") ?? "");
  const result = await setDocumentVisibilityCore(env, publicId, target);
  if (!result.ok) {
    const msg =
      result.code === "invalid_visibility"
        ? "Invalid visibility value."
        : "Document not found.";
    const status = result.code === "not_found" ? 404 : 400;
    return finishManage(publicId, env, authz, { kind: "err", message: msg }, status);
  }
  const msg =
    result.visibility === "public"
      ? "Document is now public — anyone with the link can view it."
      : "Document is now private — hidden from the open web (you and your agents still see it).";
  return finishManage(publicId, env, authz, { kind: "ok", message: msg });
}

/**
 * POST /d/:public_id/slug — operator add/rename/clear a live doc's slug via the
 * manage page's slug form. No version bump; a rename auto-forwards the old name
 * (setDocumentSlugCore). On the cookie path the page re-renders with a notice;
 * on the pasted-token path a terminal result card.
 */
export async function handleSlugForm(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) return manageResultCard(publicId, authz.status, { kind: "err", message: authz.message });

  const slug = String(form.get("slug") ?? "");
  const result = await setDocumentSlugCore(env, publicId, slug);
  if (!result.ok) {
    let msg: string;
    let status: number;
    switch (result.code) {
      case "not_found":
        msg = "Document not found.";
        status = 404;
        break;
      case "invalid_slug":
        msg = formatSlugReject(result.reason);
        status = 422;
        break;
      case "slug_taken":
        msg = `That link (/s/${result.slug}) is already in use by another live document.`;
        status = 409;
        break;
      case "slug_retired":
        msg =
          `That link (/s/${result.slug}) was used before and is retired — links are never ` +
          `reused. (Free it with DELETE /admin/slugs/${result.slug} only if you really mean to.)`;
        status = 409;
        break;
    }
    return finishManage(publicId, env, authz, { kind: "err", message: msg }, status);
  }
  return finishManage(publicId, env, authz, { kind: "ok", message: slugSuccessMessage(result) });
}

/**
 * POST /d/:public_id/restore — operator restores a historical version via the
 * manage page's history table. restoreVersionCore re-publishes that version's
 * content + metadata as a NEW version (never a current_ver rewind). Same auth
 * ladder as the other manage forms. The writer is the `{ kind: "operator" }`
 * principal (migration 0013) — the restored version records author_kind
 * "operator"; documents.created_by is untouched, exactly like any update.
 */
export async function handleRestoreForm(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) return manageResultCard(publicId, authz.status, { kind: "err", message: authz.message });

  const verStr = String(form.get("version") ?? "");
  if (!/^[1-9][0-9]*$/.test(verStr)) {
    return finishManage(publicId, env, authz, { kind: "err", message: "Invalid version number." }, 400);
  }
  const versionNo = Number(verStr);
  const origin = new URL(req.url).origin;
  const result = await restoreVersionCore(env, publicId, versionNo, { kind: "operator" }, origin);
  if (!result.ok) {
    let msg: string;
    let status: number;
    switch (result.code) {
      case "not_found":
        msg = "Document not found.";
        status = 404;
        break;
      case "version_not_found":
        msg = `Version v${versionNo} does not exist.`;
        status = 404;
        break;
      case "source_unavailable":
        msg =
          `Version v${versionNo} predates source retention, so it can't be restored. ` +
          `Revoke and republish the document to refresh it.`;
        status = 409;
        break;
      case "version_conflict":
        msg = "The document changed while restoring — reload and try again.";
        status = 409;
        break;
      case "empty_body":
        msg = "That version has no content to restore.";
        status = 400;
        break;
      case "too_large":
        msg = "That version exceeds the size limit and can't be restored.";
        status = 413;
        break;
      case "storage_cap_exceeded":
        msg = "Storage cap exceeded — restoring would push the fleet over its budget.";
        status = 507;
        break;
      default:
        // slug_taken / slug_retired / invalid_slug — restore never touches the
        // slug, so these shouldn't occur; map defensively rather than leak codes.
        msg = "Could not restore that version.";
        status = 400;
    }
    return finishManage(publicId, env, authz, { kind: "err", message: msg }, status);
  }
  return finishManage(
    publicId,
    env,
    authz,
    { kind: "ok", message: `Restored v${versionNo} as new version v${result.version}.` },
  );
}

/** Human-readable success line for a slug change, by which transition occurred. */
function slugSuccessMessage(r: SetSlugOk): string {
  if (r.slug === null) {
    return r.retired
      ? `Link removed. The old link /s/${r.retired} is retired and will not forward.`
      : "No custom link is set.";
  }
  if (r.redirected && r.retired) {
    return `Link changed to /s/${r.slug}. The old link /s/${r.retired} now forwards here.`;
  }
  return `Link set to /s/${r.slug}.`;
}

/**
 * After a POST: re-render the manage page with a notice (cookie path, where we
 * have a CSRF nonce to put back into the forms), or fall back to a terminal
 * result card (pasted-token path — no session nonce to embed). A doc revoked
 * out from under a cookie-path re-render falls back to the result card too.
 */
async function finishManage(
  publicId: string,
  env: Env,
  authz: { ok: true; via: "bearer" } | { ok: true; via: "cookie"; csrf: string },
  notice: ManageNotice,
  status = 200,
): Promise<Response> {
  if (authz.via === "cookie") {
    const state = await loadManageState(env, publicId);
    if (!state) return manageResultCard(publicId, 404, { kind: "err", message: "Document not found." });
    return manageResponse(renderManagePage(state, authz.csrf, notice), status);
  }
  return manageResultCard(publicId, status, notice);
}

/** Shared doctype/head/styles for the manage page and its sign-in/result cards. */
function manageHtmlDoc(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 4px;font-weight:600}
.sub{font-size:13px;color:#777;margin:0 0 8px;word-break:break-word}
h2{font-size:14px;margin:0 0 8px;font-weight:600}
p{margin:0 0 14px;color:#555}
section{padding:20px 0;border-top:1px solid #eee}
section:first-of-type{border-top:0}
section.danger h2{color:#a00}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#222;word-break:break-all}
.mono{text-decoration:none}
a.mono:hover{text-decoration:underline}
label{display:block;margin:0 0 6px;font-size:13px;color:#555}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:9px 10px;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid #ccc;border-radius:4px}
.hint{font-size:12px;color:#888;margin:8px 0 14px}
.hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
button{padding:9px 16px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;cursor:pointer}
button.danger-btn{background:#a00;border-color:#a00}
a.btn{display:inline-block;padding:9px 16px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;text-decoration:none}
.notice{padding:9px 12px;border-radius:4px;font-size:13px;margin:0 0 16px}
.notice.ok{background:#eef7ee;border:1px solid #cfe6cf;color:#256029}
.notice.err{background:#fdecec;border:1px solid #f3c2c2;color:#a02020}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
.vers-wrap{max-height:340px;overflow:auto;border:1px solid #eee;border-radius:4px}
table.vers{width:100%;border-collapse:collapse;font-size:13px}
table.vers th,table.vers td{text-align:left;padding:6px 9px;border-bottom:1px solid #eee;vertical-align:middle;white-space:nowrap}
table.vers tr:last-child td{border-bottom:0}
table.vers th{position:sticky;top:0;background:#fafafa;color:#888;font-weight:600;font-size:12px}
table.vers td:nth-child(3){white-space:normal;max-width:180px;overflow:hidden;text-overflow:ellipsis}
table.vers .cur{color:#256029;font-weight:600;font-size:12px}
table.vers .nosrc{color:#999;font-size:12px}
table.vers form{display:inline;margin:0}
button.link-restore{padding:4px 11px;font-size:12px}
</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>
`;
}

/**
 * The Version history section of the manage page: a newest-first table with a
 * View link (→ the operator version shell) per version and a Restore button on
 * every non-current row. Restore POSTs to /d/:id/restore with the session CSRF
 * nonce (`csrf` is already escaped by the caller). publicId is PUBLIC_ID_RE-
 * checked and version_no is an integer, so both interpolate safely.
 */
function renderVersionHistory(state: ManageState, csrf: string): string {
  const rows = state.versions
    .map((ver) => {
      const when = escapeHtml(formatCreatedAt(ver.created_at));
      const tRaw = ver.title ? normalizeTitleForDisplay(ver.title) : "";
      const t = escapeHtml(tRaw.length > 0 ? tRaw : "(untitled)");
      const sizeKb = `${(ver.size_bytes / 1024).toFixed(1)} KB`;
      const viewHref = `/d/${state.publicId}/v/${ver.version_no}`;
      // Restore needs the retained source. Pre-0008 versions (no `.src`) can't be
      // restored — restoreVersionCore hard-fails source_unavailable, so don't offer
      // the button; show a muted note instead (those docs are revoke-and-republished).
      const action = ver.is_current
        ? `<span class="cur">current</span>`
        : ver.source_present
          ? `<form method="POST" action="/d/${state.publicId}/restore"><input type="hidden" name="csrf_token" value="${csrf}"><input type="hidden" name="version" value="${ver.version_no}"><button type="submit" class="link-restore">Restore</button></form>`
          : `<span class="nosrc" title="Predates source retention — can't be restored; revoke &amp; republish instead.">no source</span>`;
      return `<tr><td><a class="mono" href="${viewHref}">v${ver.version_no}</a></td><td>${when}</td><td>${t}</td><td>${sizeKb}</td><td>${action}</td></tr>`;
    })
    .join("");
  const count = state.versions.length;
  const plural = count === 1 ? "" : "s";
  return `<section>
<h2>Version history</h2>
<p>${count} version${plural}. <b>View</b> opens that version (operator-only). <b>Restore</b> re-publishes that version's content and title/description as a NEW version — the current custom link and tags are kept. Older bytes stay in R2 until the document is revoked.</p>
<div class="vers-wrap"><table class="vers"><thead><tr><th>Version</th><th>When</th><th>Title</th><th>Size</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

/** The full management page: visibility toggle, slug editor, version history, revoke. */
function renderManagePage(state: ManageState, csrfToken: string, notice?: ManageNotice): string {
  const safeId = escapeHtml(state.publicId);
  const titleRaw = state.title ? normalizeTitleForDisplay(state.title) : "";
  const subtitle = escapeHtml(titleRaw.length > 0 ? titleRaw : "(untitled)");
  const csrf = escapeHtml(csrfToken);
  const isPrivate = state.visibility === "private";

  const noticeHtml = notice
    ? `<p class="notice ${notice.kind === "err" ? "err" : "ok"}">${escapeHtml(notice.message)}</p>`
    : "";

  // Visibility: current state + a single button that flips to the other value.
  const visTarget = isPrivate ? "public" : "private";
  const visButton = isPrivate ? "Make public" : "Make private";
  const visState = isPrivate
    ? "<b>Private</b> — hidden from the open web. You and your agents can open it; the public URL returns 404 to anyone else."
    : "<b>Public</b> — anyone with the link can view it on the open web.";

  // Slug: current link + a text field (prefilled). The HTML pattern mirrors the
  // server SLUG_RE; an empty field clears (pattern is not checked when empty).
  const slugVal = state.slug ? escapeHtml(state.slug) : "";
  const slugCurrent = state.slug
    ? `Current link: <a class="mono" href="/s/${state.slug}">/s/${escapeHtml(state.slug)}</a>`
    : `No custom link — this document is reachable only by its <span class="mono">/d/${safeId}</span> capability URL.`;

  const body = `<h1>Manage <span class="mono">${safeId}</span></h1>
<p class="sub">${subtitle}</p>
${noticeHtml}
<section>
<h2>Visibility</h2>
<p>${visState}</p>
<form method="POST" action="/d/${state.publicId}/visibility">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="visibility" value="${visTarget}">
<button type="submit">${visButton}</button>
</form>
</section>
<section>
<h2>Custom link</h2>
<p>${slugCurrent}</p>
<form method="POST" action="/d/${state.publicId}/slug">
<input type="hidden" name="csrf_token" value="${csrf}">
<label for="slug">Slug</label>
<input id="slug" name="slug" type="text" value="${slugVal}" autocomplete="off" spellcheck="false" placeholder="e.g. north-island-report" pattern="[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?" title="Lowercase letters, digits, - and _; 1–64 chars; must start and end alphanumeric. Leave empty to clear.">
<p class="hint">Lowercase letters, digits, <code>-</code>, <code>_</code>; 1–64 chars. Renaming <b>retires</b> the old link and auto-forwards it here. Clear the field to remove the link (the old name is retired but won't forward). Links are never reused.</p>
<button type="submit">Save link</button>
</form>
</section>
${renderVersionHistory(state, csrf)}
<section class="danger">
<h2>Revoke</h2>
<p>Permanently destroy this document. Bytes are purged from R2, the URL will <b>404 forever</b>, and any slug is retired. This cannot be undone.</p>
<form method="POST" action="/d/${state.publicId}/revoke">
<input type="hidden" name="csrf_token" value="${csrf}">
<button type="submit" class="danger-btn">Revoke document</button>
</form>
</section>
<p class="note"><a href="/d/${state.publicId}">← Back to document</a></p>`;

  return manageHtmlDoc("Manage document", body);
}

/** Sign-in prompt for a non-cookie caller of the manage page. Discloses no
 *  document state (rendered without a DB hit). */
function renderManageSignin(publicId: string): string {
  const loginHref = escapeHtml(`/login?next=${encodeURIComponent(`/d/${publicId}/manage`)}`);
  const body = `<h1>Sign in to manage</h1>
<p>Managing a document (visibility, custom link, revoke) needs an operator browser session.</p>
<p><a class="btn" href="${loginHref}">Sign in</a></p>
<p class="note"><a href="/d/${escapeHtml(publicId)}">← Back to document</a></p>`;
  return manageHtmlDoc("Manage document", body);
}

/**
 * Terminal result card for the manage POST handlers' non-re-render paths: an
 * auth failure, or a pasted-token (no-session) success/error where there's no
 * CSRF nonce to seed a fresh form. Links back to the manage page to retry.
 * `publicId` is PUBLIC_ID_RE-validated by every caller, so it's safe to
 * interpolate into the link.
 */
function manageResultCard(publicId: string, status: number, notice: ManageNotice): Response {
  const body = `<h1>Manage document</h1>
<p class="notice ${notice.kind === "err" ? "err" : "ok"}">${escapeHtml(notice.message)}</p>
<p class="note"><a href="/d/${publicId}/manage">← Back to manage <span class="mono">${escapeHtml(publicId)}</span></a></p>`;
  return manageResponse(manageHtmlDoc("Manage document", body), status);
}
