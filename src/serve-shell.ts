// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Shell rendering for the document-serving surface (issue #72 phase 4: moved
 * verbatim out of src/serve.ts): the top-level HTML pages a BROWSER lands on,
 * never the framed bytes.
 *
 *   GET /                       → public landing page: homepage doc in a toolbar-less shell
 *   GET /d/:public_id           → tiny HTML shell with toolbar + <iframe sandbox src=…/raw>
 *   GET /d/:public_id/v/:n      → operator-only framed shell for a historical version
 *   GET /shell.js               → the toolbar enhancement script (`script-src 'self'`)
 *
 * Also owns the reading theme (`READER_THEME_PREFIX` + `streamWithPrefix`)
 * that serve.ts splices ahead of Markdown-sourced bytes and platform-docs.ts
 * reuses — one theme, one definition — and the operator-only divergence
 * banner (`publishNoticeFor` / `renderPublishNotice`), which the slug shell in
 * serve.ts consumes too.
 *
 * Every shell query resolves its version through `SERVED_VER_SQL` /
 * `servedVersion` (src/served-version.ts) — a public document renders the
 * PROMOTED version, never what an agent last wrote (issue #43, migration
 * 0018). The toolbar names the served version for everyone; the existence of
 * an unpublished newer version reaches an operator's markup only.
 *
 * Every response here carries a CSP (`SHELL_CSP` / `NOTFOUND_CSP` from
 * src/serve-policy.ts) and the shared `COMMON_HEADERS`. Imports serve-policy
 * only; serve.ts imports this module (one-way).
 */

import {
  canRead,
  type Principal,
  type Visibility,
} from "./access.js";
import type { Env } from "./env.js";
import { escapeHtml, formatCreatedAt } from "./html.js";
import { PUBLIC_ID_RE } from "./ids.js";
import {
  formatPageTitle,
  normalizeDescriptionForDisplay,
  normalizeTitleForDisplay,
  SITE_BRAND,
} from "./metadata.js";
import {
  COMMON_HEADERS,
  NOTFOUND_CSP,
  notFoundBrowser,
  SANDBOX,
  SHELL_CSP,
} from "./serve-policy.js";
import { SERVED_VER_SQL, servedVersion } from "./served-version.js";
import { authenticateOperatorRequest } from "./session.js";

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
export function streamWithPrefix(
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
export function publishNoticeFor(
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
export function renderShell(
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
