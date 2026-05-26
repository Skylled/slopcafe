/**
 * Web serve path for `GET /d/:public_id`.
 *
 * Split across two URLs because the action plan's strict CSP includes
 * `frame-ancestors`, which is header-only — there's no `<meta>` equivalent.
 * So the iframe content must come from an HTTP response, not from `srcdoc`.
 *
 *   GET /d/:public_id           → tiny HTML shell with <iframe sandbox src=…/raw>
 *   GET /d/:public_id/raw       → sanitized bytes streamed from R2, locked-down CSP
 *
 * Both 404 if the document is missing or `revoked_at` is set. Both send
 * `Cache-Control: no-store` so a revoke really is the kill switch the
 * action plan promises.
 */

import { authenticateAgent } from "./auth.js";
import type { Env } from "./env.js";

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
 * GET /d/:public_id — the URL humans click. Returns the iframe shell.
 *
 * Validates the id format before touching D1 so we don't burn a query on
 * obvious junk. The id is regex-checked, so it's safe to interpolate into
 * the HTML template without escaping.
 */
export async function serveShell(publicId: string, env: Env): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  const row = await env.META.prepare(
    "select revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ revoked_at: string | null }>();
  if (!row || row.revoked_at) return notFound();

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-web-host</title>
<style>html,body{margin:0;padding:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head>
<body>
<iframe sandbox="${SANDBOX}" src="/d/${publicId}/raw" referrerpolicy="no-referrer"></iframe>
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
