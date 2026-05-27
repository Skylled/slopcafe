/**
 * Web serve path for `GET /d/:public_id`.
 *
 * Split across two URLs because the action plan's strict CSP includes
 * `frame-ancestors`, which is header-only — there's no `<meta>` equivalent.
 * So the iframe content must come from an HTTP response, not from `srcdoc`.
 *
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
import { readDocumentTextCore, revokeDocumentCore } from "./core.js";
import type { Env } from "./env.js";
import { formatPageTitle, SITE_BRAND } from "./metadata.js";

/** Format of values produced by `newPublicId()` — 22 chars of URL-safe base64. */
export const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Headers shared by both routes. Browsers see HTML, no leaks, no caching. */
const COMMON_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  // Strip Referer so the secret URL doesn't leak to outbound link destinations.
  "referrer-policy": "no-referrer",
  // Defense-in-depth against MIME sniffing inside the rendered doc.
  "x-content-type-options": "nosniff",
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

/** Iframe sandbox flags. No `allow-scripts`, no `allow-same-origin`,
 *  no `allow-top-navigation` — maximum isolation. */
const SANDBOX = ""; // empty string = all restrictions enabled

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
  return serveShell(publicId, env);
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
export async function serveShell(publicId: string, env: Env): Promise<Response> {
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

  const createdAt = escapeHtml(formatCreatedAt(row.created_at));
  const version = row.current_ver ?? 0; // not reachable when null (revoked → 404 above)
  const author = row.agent_name ? escapeHtml(row.agent_name) : "[deleted agent]";

  // formatPageTitle applies anti-phishing normalization (bidi/control/zero-
  // width stripping + length cap) before adding the brand suffix. escapeHtml
  // is still the final encoding-layer step. A null/empty title falls back to
  // bare brand so the tab still shows something usable.
  const pageTitle = escapeHtml(formatPageTitle(row.doc_title));

  // <meta name=description> renders in link previews (Slack, Twitter, etc.)
  // and search engines. Author-supplied — escape for HTML, but don't apply
  // the bidi strip we use for <title> (description isn't a phishing surface;
  // see src/metadata.ts validateDescriptionInput).
  const metaDescriptionTag = row.doc_description
    ? `<meta name="description" content="${escapeHtml(row.doc_description)}">`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
${metaDescriptionTag}
<style>
html,body{margin:0;padding:0;height:100%;background:#fff;font:13px/1.4 system-ui,sans-serif;color:#222}
.app{display:flex;flex-direction:column;height:100vh}
.bar{flex:0 0 auto;display:flex;align-items:center;gap:16px;padding:8px 14px;border-bottom:1px solid #e5e5e5;background:#fafafa;font-size:12px;color:#555}
.bar .meta{display:flex;gap:14px;flex:1 1 auto;min-width:0;flex-wrap:wrap}
.bar .meta span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar .meta b{color:#222;font-weight:600}
.bar a.revoke{padding:5px 10px;border:1px solid #a00;color:#a00;border-radius:4px;text-decoration:none;background:#fff;font-weight:600}
.bar a.revoke:hover{background:#a00;color:#fff}
iframe{border:0;width:100%;flex:1 1 auto;display:block;background:#fff}
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
<a class="revoke" href="/d/${publicId}/revoke">Revoke…</a>
</div>
<iframe sandbox="${SANDBOX}" src="/d/${publicId}/raw" referrerpolicy="no-referrer"></iframe>
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
 * GET /d/:public_id/raw — what the iframe loads. Streams sanitized bytes
 * from R2 under the locked-down CSP. `frame-ancestors 'self'` ensures
 * only our own shell can embed it; direct navigation works (browsers
 * tolerate the bare HTML fragment), but third-party iframes are refused.
 */
export async function serveRaw(publicId: string, env: Env): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  // Single join to get document state + the R2 key for the current version.
  const row = await env.META.prepare(
    `select d.revoked_at, v.r2_key, v.version_no
     from documents d
     join versions v on v.document_id = d.id and v.version_no = d.current_ver
     where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{ revoked_at: string | null; r2_key: string; version_no: number }>();
  if (!row || row.revoked_at) return notFound();

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return notFound(); // shouldn't happen — D1 says it should exist

  // Pass R2's body stream straight through; no need to buffer in the Worker.
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": RAW_CSP,
      etag: `"v${row.version_no}"`,
      ...COMMON_HEADERS,
    },
  });
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
 * GET /d/:public_id/revoke — confirmation page for an operator about to
 * revoke a document. Mirrors the /authorize consent shape: card layout,
 * password field, paste the operator token, Confirm/Cancel.
 *
 * Returns the same opaque 404 as the shell for missing/revoked docs so
 * direct navigation can't probe whether an id ever existed.
 */
export async function serveRevokeConfirm(
  publicId: string,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  const row = await env.META.prepare(
    "select revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ revoked_at: string | null }>();
  if (!row || row.revoked_at) return notFound();

  return new Response(renderRevokePage("confirm", publicId), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": REVOKE_CSP,
      ...COMMON_HEADERS,
    },
  });
}

/**
 * POST /d/:public_id/revoke — form-encoded `operator_token`. Validates via
 * `authenticateOperator` (synthesizes a Bearer header to reuse the same
 * primitive that gates the JSON DELETE route and the OAuth consent flow),
 * then forwards to `revokeDocumentCore`.
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
  // Mirror authorize.ts: build a synthetic Bearer request so the same
  // operator-auth primitive backs every operator-facing surface.
  const synth = new Request(req.url, {
    headers: { authorization: `Bearer ${operatorToken}` },
  });
  if (!authenticateOperator(synth, env)) {
    return revokeResultResponse(
      401,
      renderRevokePage("error", publicId, "Operator token incorrect.", true),
    );
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
 */
function renderRevokePage(
  mode: "confirm" | "error" | "success",
  publicId: string,
  errorMessage?: string,
  retryLink?: boolean,
  purged?: number,
): string {
  const safeId = escapeHtml(publicId);
  let body: string;
  if (mode === "confirm") {
    body = `<h1>Revoke <span class="mono">${safeId}</span>?</h1>
<p>Bytes are purged from R2 immediately and the URL will <b>404 forever</b>. The <code>versions</code> audit trail is kept; only the rendered HTML is destroyed. This cannot be undone.</p>
<form method="POST" action="/d/${publicId}/revoke">
<label for="operator_token">Operator token</label>
<input id="operator_token" name="operator_token" type="password" required autocomplete="off">
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
