// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The bundled platform-documentation surface: `GET /docs` and `/docs/<name>`
 * (GitHub issue #4).
 *
 * WHY THIS IS NOT A DOCUMENT. The reference corpus used to live in D1/R2 as
 * ordinary Documents, mirrored onto the running platform by hand. That made
 * every runtime pointer at a doc — `/healthz`'s `docs` field, the MCP tool
 * descriptions that tell a model what to read — a claim about whether somebody
 * had run a publish script on THIS instance, and made documentation drift a
 * live state a checker had to detect. Documentation ABOUT THE CODE is a build
 * artifact of the code, exactly like `openapi.json`: `scripts/build-docs.mjs`
 * renders it at build time and `predeploy` runs it, so an instance serves the
 * documentation matching its own deployed build, on a fresh fork, with no
 * credentials and no ritual. Drift stops being monitored and becomes
 * unrepresentable.
 *
 * TWO RESPONSES, LIKE A DOCUMENT. `/docs/<name>` is a shell whose iframe loads
 * `/docs/<name>/raw` — the same two-URL split `serve.ts` uses, for the same
 * reason: `frame-ancestors` is header-only, so the framed bytes must come from
 * a real HTTP response rather than a `srcdoc`. The bundled HTML was sanitized
 * at BUILD time by the same WASM allowlist the write path runs, so it arrives
 * under the same wall as any published document.
 *
 * ANONYMOUS BY DESIGN. There is no `canRead` call anywhere in this file and
 * none should be added. These bytes are the repo's public documentation; they
 * carry no per-instance content, so there is nothing here to gate and no
 * existence oracle to protect — an unknown name is a plain 404 because it names
 * a route that does not exist in THIS BUILD, a fact already visible in the
 * index and in the open-source repo.
 */

import { escapeHtml } from "./html.js";
import { READER_THEME_PREFIX, SERVICE_DESC_LINK } from "./serve.js";
import { SITE_BRAND } from "./metadata.js";
import {
  DOCS_SANITIZER_VERSION,
  PLATFORM_DOCS,
  PLATFORM_DOCS_BY_NAME,
  type PlatformDoc,
} from "./generated/platform-docs.js";

/** Route root. Kept in one place — the sanitizer's new-tab pass (v1.7) hard-codes
 *  the same prefix in Rust, so the two must be changed together. */
export const PLATFORM_DOCS_PREFIX = "/docs";

/**
 * Headers for every bundled-doc response.
 *
 * Deliberately NOT `serve.ts`'s `COMMON_HEADERS`, which is built for capability
 * URLs: that set sends `no-store` (right for a secret document URL, wasteful
 * for immutable build output) and `x-robots-tag: noindex` (right for a doc
 * nobody should find by search, exactly wrong for public documentation whose
 * whole job is to be found). Bundled docs are public, immutable per deploy, and
 * SHOULD be indexed.
 *
 * Cache policy is per-route below, because one of these routes is content-
 * negotiated and one is not.
 */
const DOC_HEADERS: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * Shared cache policy — for the routes that serve ONE representation.
 *
 * `max-age=300` rather than a long immutable cache: the bytes change on every
 * deploy and the point of this route is that it tells the truth about the build
 * behind it. Five minutes of post-deploy staleness self-heals; a day of it would
 * re-create, in a CDN, the drift this change removed. The strong ETag makes
 * revalidation a 304.
 */
const CACHE_SHARED = "public, max-age=300";

/**
 * Cache policy for `/docs/<name>`, which is CONTENT-NEGOTIATED (HTML shell vs
 * Markdown source, on `Accept`).
 *
 * `private`, deliberately, even though the bytes are public and identical for
 * every caller. Cloudflare's cache — and plenty of other intermediaries —
 * honours no `Vary` header except `Accept-Encoding`. A shared cache in front of
 * a negotiated URL therefore stores whichever variant it saw first under the
 * bare URL and serves it to everyone: browsers get raw Markdown, or agents get
 * an HTML shell. `private` keeps the response in the requesting browser's own
 * cache, where there is only one caller to confuse.
 *
 * This is why `/docs/<name>/raw` is a separate route rather than another
 * `Accept` branch: it serves exactly one representation, so it can be shared-
 * cached safely, and it is the URL that actually carries the bytes.
 */
const CACHE_NEGOTIATED = "private, max-age=300";

/**
 * Shell CSP. Same shape as `serve.ts`'s SHELL_CSP and for the same reasons —
 * `frame-src 'self'` for the raw view, `frame-ancestors 'none'` because the
 * shell is always top-level — but tighter on script, since this page has none.
 * A separate constant rather than an import because the two surfaces are free
 * to diverge (this one hosts no forms and no per-document controls) and the
 * house rule is that every HTML response names its own CSP.
 */
const DOCS_SHELL_CSP = [
  "default-src 'none'",
  // 'none', not serve.ts's 'self': that shell loads /shell.js for its toolbar
  // menu; this one has no script at all, so admitting same-origin script would
  // grant a capability the page does not use.
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Rendered-documentation CSP — byte-identical in intent to `serve.ts`'s
 * RAW_CSP: `default-src 'none'` is the load-bearing wall, `style-src
 * 'unsafe-inline'` admits the `<style>` blocks the sanitizer allows through
 * (v1.4), and `frame-ancestors 'self'` lets only our own shell embed it.
 */
const DOCS_RAW_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline' data:",
  "font-src 'self' data:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Index page CSP: static links only, no frame, no script. */
const DOCS_INDEX_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The iframe sandbox for the raw view — identical to `serve.ts`'s SANDBOX:
 *  every restriction on, with popups allowed so a cross-document link can open
 *  a new tab (the sanitizer's v1.7 new-tab pass now covers `/docs/…` links for
 *  exactly this reason). Notably NO `allow-scripts`. */
const DOCS_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/**
 * Strong ETag for a bundled doc.
 *
 * Keyed on the source hash AND the sanitizer version: the rendered HTML is a
 * pure function of those two, so a sanitizer change that re-renders identical
 * Markdown into different bytes still moves the tag. Keying on the source hash
 * alone would serve a stale render from a browser cache across exactly the kind
 * of allowlist change that motivates a re-render.
 */
function docEtag(doc: PlatformDoc, kind: "html" | "md"): string {
  return `"${kind}-${DOCS_SANITIZER_VERSION}-${doc.sourceSha256.slice(0, 32)}"`;
}

/** Exact / `*` / comma-list `If-None-Match` match against one strong tag. */
function etagMatches(header: string | null, tag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === tag || (t.startsWith("W/") && t.slice(2) === tag));
}

/**
 * The one JSON error this module emits.
 *
 * Carries `Link: </openapi.json>; rel="service-desc"` like every other JSON
 * error in the codebase — the house rule is that even a failed request teaches
 * a client where the contract lives, and a new emitter that quietly drops it
 * makes the rule a little less true. (CLAUDE.md counts the copies and says a
 * fourth should be promoted to a leaf module; this is the fifth, so if a sixth
 * appears, do that instead of copying again.)
 *
 * Not `notFoundBrowser`: that renders a sign-in card for an operator who hit a
 * capability URL logged out, which has no meaning here — there is nothing to
 * sign in to and nothing gated. A mistyped doc name is a mistyped route.
 */
function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found", message: "no such documentation page" }), {
    status: 404,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      link: SERVICE_DESC_LINK,
      ...DOC_HEADERS,
    },
  });
}

/** Shared page chrome. The palette matches the document shell so the two
 *  surfaces read as one site. */
const PAGE_CSS = `
:root{color-scheme:light dark}
html,body{margin:0;padding:0;height:100%;background:#f4f2ee;font:13px/1.4 system-ui,sans-serif;color:#2c2a27}
.app{display:flex;flex-direction:column;height:100vh}
.bar{flex:0 0 auto;display:flex;align-items:center;gap:16px;padding:8px 14px;border-bottom:1px solid #e3ddd2;background:#fbfaf7;font-size:12px;color:#6b655c}
.bar .meta{display:flex;gap:14px;flex:1 1 auto;min-width:0;flex-wrap:wrap;align-items:baseline}
.bar .meta span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar .meta b{color:#1b1a17;font-weight:600}
.bar a{color:#3a6ea5;text-decoration:none}
.bar a:hover{text-decoration:underline}
iframe{border:0;width:100%;flex:1 1 auto;display:block;background:#fbfaf7}
.wrap{max-width:760px;margin:0 auto;padding:38px 22px 60px}
h1{font-size:22px;margin:0 0 6px}
.sub{color:#6b655c;margin:0 0 26px}
ul.docs{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:2px}
ul.docs li{padding:11px 13px;border:1px solid #e3ddd2;border-radius:8px;background:#fbfaf7}
ul.docs a{font-weight:600;color:#2c2a27;text-decoration:none;font-size:14px}
ul.docs a:hover{color:#3a6ea5}
ul.docs .d{color:#6b655c;margin-top:3px}
ul.docs .p{color:#8a8378;margin-top:5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.foot{margin-top:30px;color:#8a8378;font-size:11px}
@media (prefers-color-scheme:dark){
html,body{background:#1a1917;color:#d8d4cd}
.bar{border-bottom-color:#33302b;background:#201f1c;color:#9a948a}
.bar .meta b{color:#ededea}
.bar a{color:#7aa8d8}
iframe{background:#201f1c}
.sub,.foot{color:#9a948a}
ul.docs li{border-color:#33302b;background:#201f1c}
ul.docs a{color:#d8d4cd}
ul.docs a:hover{color:#7aa8d8}
ul.docs .d{color:#9a948a}
ul.docs .p{color:#7d766c}
}`;

/**
 * `GET /docs` — the index. Lists every bundled doc with its title, description
 * and the repo path it is generated from. Naming the source path is the point:
 * it says out loud that this page is built from that file, so a reader who
 * wants to change the docs knows exactly what to edit.
 */
export function servePlatformDocsIndex(): Response {
  const rows = PLATFORM_DOCS.map((d) => {
    const desc = d.description ? `\n<div class="d">${escapeHtml(d.description)}</div>` : "";
    return `<li><a href="${PLATFORM_DOCS_PREFIX}/${d.name}">${escapeHtml(d.title)}</a>${desc}
<div class="p">${escapeHtml(d.path)}</div></li>`;
  }).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Documentation | ${SITE_BRAND}</title>
<meta name="description" content="Reference documentation for this ${SITE_BRAND} deployment, built from the source of the running build.">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
<h1>Documentation</h1>
<p class="sub">Built from the source of the running build, so these pages describe
<em>this</em> deployment — not a mainline instance. The machine-readable contract is at
<a href="/openapi.json">/openapi.json</a>.</p>
<ul class="docs">
${rows}
</ul>
<p class="foot">${PLATFORM_DOCS.length} documents · rendered with ${escapeHtml(DOCS_SANITIZER_VERSION)}</p>
</div>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": DOCS_INDEX_CSP,
      "cache-control": CACHE_SHARED,
      ...DOC_HEADERS,
    },
  });
}

/**
 * `GET /docs/<name>` — the shell, or the Markdown source when the caller asks
 * for it.
 *
 * CONTENT NEGOTIATION rather than a `.md` route, matching how `/d/:id/text`
 * already negotiates: an agent sends `Accept: text/markdown` and gets the
 * source it wants to ingest; a browser sends its usual `text/html` and gets the
 * page. Both are the same document, so they are the same URL.
 */
export function servePlatformDoc(name: string, req: Request): Response {
  const doc = PLATFORM_DOCS_BY_NAME.get(name);
  if (!doc) return notFound();

  const accept = req.headers.get("accept") ?? "";
  if (/\btext\/(?:x-)?markdown\b/i.test(accept)) return servePlatformDocMarkdown(doc, req);

  const tag = docEtag(doc, "html");
  const title = escapeHtml(`${doc.title} | ${SITE_BRAND}`);
  const desc = doc.description ? escapeHtml(doc.description) : "";
  const descTag = desc ? `\n<meta name="description" content="${desc}">` : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>${descTag}
<meta property="og:type" content="article">
<meta property="og:site_name" content="${SITE_BRAND}">
<meta property="og:title" content="${escapeHtml(doc.title)}">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="app">
<div class="bar">
<div class="meta">
<span><a href="${PLATFORM_DOCS_PREFIX}">Documentation</a></span>
<span><b>${escapeHtml(doc.title)}</b></span>
<span>Source <b>${escapeHtml(doc.path)}</b></span>
</div>
</div>
<iframe sandbox="${DOCS_SANDBOX}" src="${PLATFORM_DOCS_PREFIX}/${doc.name}/raw" referrerpolicy="no-referrer"></iframe>
</div>
</body>
</html>
`;
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": DOCS_SHELL_CSP,
    etag: tag,
    vary: "Accept",
    "cache-control": CACHE_NEGOTIATED,
    ...DOC_HEADERS,
  };
  // Honour the ETag we just emitted. Emitting one and then always answering 200
  // makes the tag decorative and the documented caching behaviour a lie.
  if (etagMatches(req.headers.get("if-none-match"), tag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(html, { status: 200, headers });
}

/**
 * Themed body cache.
 *
 * Every bundled doc is Markdown-sourced, so each gets the same reading theme
 * `serveRaw` splices ahead of a published Markdown document — otherwise the
 * platform's own documentation would render in browser-default serif while
 * every user document renders themed. Concatenated once per doc per isolate
 * rather than per request: the largest render is ~270 KB and rebuilding that
 * string on every read would be pure waste for a value that never changes.
 */
const themedHtml = new Map<string, string>();
function themed(doc: PlatformDoc): string {
  let out = themedHtml.get(doc.name);
  if (out === undefined) {
    out = READER_THEME_PREFIX + doc.html;
    themedHtml.set(doc.name, out);
  }
  return out;
}

/** `GET /docs/<name>/raw` — the framed bytes, sanitized at build time. */
export function servePlatformDocRaw(name: string, req: Request): Response {
  const doc = PLATFORM_DOCS_BY_NAME.get(name);
  if (!doc) return notFound();

  const tag = docEtag(doc, "html");
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": DOCS_RAW_CSP,
    etag: tag,
    "cache-control": CACHE_SHARED,
    ...DOC_HEADERS,
  };
  if (etagMatches(req.headers.get("if-none-match"), tag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(themed(doc), { status: 200, headers });
}

/** The Markdown source, for an agent ingesting the doc as context. */
function servePlatformDocMarkdown(doc: PlatformDoc, req: Request): Response {
  const tag = docEtag(doc, "md");
  const headers: Record<string, string> = {
    "content-type": "text/markdown; charset=utf-8",
    etag: tag,
    vary: "Accept",
    "cache-control": CACHE_NEGOTIATED,
    ...DOC_HEADERS,
  };
  if (etagMatches(req.headers.get("if-none-match"), tag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(doc.markdown, { status: 200, headers });
}
