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

import { authenticateAgent, authenticateOperator } from "./auth.js";
import {
  findDocumentBySlugCore,
  readDocumentTextCore,
  resolvePublicIdBySlug,
  revokeDocumentCore,
} from "./core.js";
import type { Env } from "./env.js";
import { authenticateOperatorRequest, csrfMatches } from "./session.js";
import {
  formatPageTitle,
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
 * Shell page CSP. Tight: we author this HTML, so it needs only inline
 * styles for layout and a frame source pointing at our own origin.
 * `frame-ancestors 'none'` — the shell is the top-level page, never embedded.
 * `form-action 'none'` — the shell intentionally hosts no forms; the revoke
 * link navigates to a dedicated confirmation page that has its own CSP.
 */
const SHELL_CSP = [
  "default-src 'none'",
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
    if (!agent) {
      return new Response(
        JSON.stringify({ error: "unauthorized", message: "invalid agent key" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    return serveRaw(publicId, env);
  }
  const origin = new URL(req.url).origin;
  return serveShell(publicId, env, origin);
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
 * validated slug or request origin is safe to pass raw.
 */
function renderShell(
  meta: {
    createdAtIso: string;
    version: number;
    agentName: string | null;
    title: string | null;
    description: string | null;
  },
  links: { iframeSrc: string; revokeHref: string; canonicalUrl: string },
): Response {
  const createdAt = escapeHtml(formatCreatedAt(meta.createdAtIso));
  const version = meta.version;
  const author = meta.agentName ? escapeHtml(meta.agentName) : "[deleted agent]";

  // formatPageTitle applies anti-phishing normalization (bidi/control/zero-
  // width stripping + length cap) before adding the brand suffix. escapeHtml
  // is still the final encoding-layer step. A null/empty title falls back to
  // bare brand so the tab still shows something usable.
  const pageTitle = escapeHtml(formatPageTitle(meta.title));

  const ogTitleRaw = meta.title ? normalizeTitleForDisplay(meta.title) : "";
  const ogTitle = escapeHtml(ogTitleRaw.length > 0 ? ogTitleRaw : SITE_BRAND);
  const canonicalUrl = escapeHtml(links.canonicalUrl);

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
.bar a.revoke{padding:5px 10px;border:1px solid #a00;color:#a00;border-radius:4px;text-decoration:none;background:transparent;font-weight:600}
.bar a.revoke:hover{background:#a00;color:#fff}
iframe{border:0;width:100%;flex:1 1 auto;display:block;background:#fbfaf7}
@media (prefers-color-scheme:dark){
html,body{background:#1a1917;color:#d8d4cd}
.bar{border-bottom-color:#33302b;background:#201f1c;color:#9a948a}
.bar .meta b{color:#ededea}
.bar a.revoke{border-color:#e07a7a;color:#e07a7a}
.bar a.revoke:hover{background:#e07a7a;color:#1a1917}
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
</div>
<a class="revoke" href="${links.revokeHref}">Revoke…</a>
</div>
<iframe sandbox="${SANDBOX}" src="${links.iframeSrc}" referrerpolicy="no-referrer"></iframe>
</div>
</body>
</html>
`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": SHELL_CSP,
      ...COMMON_HEADERS,
    },
  });
}

/**
 * GET /d/:public_id — the URL humans click. Returns a toolbar (creation
 * time, version, author agent, Revoke link) above the iframe shell.
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
  env: Env,
  origin: string,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  // Single LEFT JOIN: `documents.created_by` is `ON DELETE SET NULL`, so a
  // cascaded-away agent leaves `agent_name` as NULL — handled in the template.
  // The versions JOIN pulls per-version metadata (title, description) for the
  // current version; LEFT so a revoked doc (current_ver = null) still returns
  // a row and falls through to the 404 below.
  const row = await env.META.prepare(
    `select d.revoked_at, d.created_at, d.current_ver, a.name as agent_name,
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
      agent_name: string | null;
      doc_title: string | null;
      doc_description: string | null;
    }>();
  if (!row || row.revoked_at) return notFound();

  return renderShell(
    {
      createdAtIso: row.created_at,
      version: row.current_ver ?? 0, // not reachable when null (revoked → 404 above)
      agentName: row.agent_name,
      title: row.doc_title,
      description: row.doc_description,
    },
    {
      iframeSrc: `/d/${publicId}/raw`,
      revokeHref: `/d/${publicId}/revoke`,
      canonicalUrl: `${origin}/d/${publicId}`,
    },
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
    `select d.revoked_at, v.title as doc_title, v.description as doc_description
     from documents d
     left join versions v on v.document_id = d.id and v.version_no = d.current_ver
     where d.public_id = ?`,
  )
    .bind(HOMEPAGE_PUBLIC_ID)
    .first<{
      revoked_at: string | null;
      doc_title: string | null;
      doc_description: string | null;
    }>();
  if (!row || row.revoked_at) return notFound();

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
 */
export async function serveRaw(publicId: string, env: Env): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  // Single join to get document state + the R2 key for the current version.
  // `source_format` decides whether to inject the reading theme (Markdown) or
  // serve the stored bytes verbatim (HTML — author owns presentation).
  const row = await env.META.prepare(
    `select d.revoked_at, v.r2_key, v.version_no, v.source_format
     from documents d
     join versions v on v.document_id = d.id and v.version_no = d.current_ver
     where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      revoked_at: string | null;
      r2_key: string;
      version_no: number;
      source_format: string;
    }>();
  if (!row || row.revoked_at) return notFound();

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return notFound(); // shouldn't happen — D1 says it should exist

  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": RAW_CSP,
    etag: `"v${row.version_no}"`,
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

/**
 * GET /d/:public_id/text — Markdown derivation of the sanitized HTML, for
 * agents or tooling that wants to ingest the document as context rather
 * than render it. Parity with `/raw`: same trust model (the public_id is
 * the capability), same no-store caching, just a different shape.
 *
 * Conversion runs on every request (no per-version cache in v1); the
 * underlying bytes still come from R2 via `readDocumentTextCore`, so a
 * revoked doc still 404s instantly.
 *
 * Response carries the sanitizer + converter version tags as headers so a
 * caller can detect policy changes without parsing the body.
 */
export async function serveText(publicId: string, env: Env): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  const result = await readDocumentTextCore(env, publicId);
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
 * GET /s/:slug/text — the slug-addressed twin of `/d/:public_id/text`. Resolves
 * the slug to its live document, then delegates to `serveText` so the Markdown
 * derivation, headers (`text/markdown`, ETag, sanitizer/converter version tags),
 * and no-store caching are produced by exactly one code path.
 *
 * Public, no auth — same as `/d/:public_id/text` (a slug is itself a public,
 * opt-in capability). Validates the slug shape first so junk 404s without a DB
 * hit. Resolution and the R2 fetch are two separate reads; `readDocumentTextCore`
 * (inside `serveText`) re-checks existence/revoked, so a revoke landing between
 * them still 404s rather than serving stale bytes.
 *
 * No-consumer-yet ergonomics: it rounds out the slug surface so a caller that
 * only knows a slug can fetch the Markdown form in one hop (the HTTP analogue of
 * the MCP `read_document` slug + `format:"markdown"` route), instead of having
 * to recover the `public_id` first.
 */
export async function serveTextBySlug(slug: string, env: Env): Promise<Response> {
  const v = validateSlugInput(slug);
  if (!v.ok) return notFound();
  const publicId = await resolvePublicIdBySlug(env, v.slug);
  if (!publicId) return notFound();
  return serveText(publicId, env);
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
 * browsers. (For the Markdown derivation by slug use `GET /s/:slug/text`, the
 * slug twin of `/d/:public_id/text`; or the MCP `read_document` slug+format route.)
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
 * (COMMON_HEADERS, via renderShell / serveRaw) forbids caching, so a released-
 * then-reclaimed slug serves the right document (or 404s) on each hit.
 *
 * Validates the slug shape before hitting D1 so malformed input (`/s/Foo`,
 * `/s/`, trailing slash, etc.) 404s without burning a query — matching how
 * PUBLIC_ID_RE gates serveDocument upstream of the DB.
 */
export async function serveBySlug(slug: string, req: Request, env: Env): Promise<Response> {
  const v = validateSlugInput(slug);
  if (!v.ok) return notFound();
  const result = await findDocumentBySlugCore(env, v.slug);
  if (!result.ok) return notFound();

  const d = result.document;

  // Content negotiation, mirroring serveDocument: an agent key takes the
  // bytes-by-slug path (serveRaw re-checks revoked + streams from R2 by
  // public_id), no header takes the shell. A present-but-invalid key 401s
  // rather than downgrading, so a broken integration is loud, not silent.
  if (req.headers.has("authorization")) {
    const agent = await authenticateAgent(req, env);
    if (!agent) {
      return new Response(
        JSON.stringify({ error: "unauthorized", message: "invalid agent key" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    return serveRaw(d.public_id, env);
  }

  const origin = new URL(req.url).origin;
  return renderShell(
    {
      createdAtIso: d.created_at,
      version: d.current_ver ?? 0, // live doc (revoked excluded by the lookup) → non-null
      agentName: d.created_by_name,
      title: d.title,
      description: d.description,
    },
    {
      // Package A: iframe + revoke reuse the public_id surface; canonical is the
      // slug so the shared/unfurled URL stays pretty. See the doc comment above.
      iframeSrc: `/d/${d.public_id}/raw`,
      revokeHref: `/d/${d.public_id}/revoke`,
      canonicalUrl: `${origin}/s/${v.slug}`,
    },
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
