/**
 * agent-web-host — one Worker in front of D1 (metadata) + R2 (bytes).
 *
 * Step 1 of action-plan-v1.md: skeleton with bindings wired and a hello
 * route that proves the plumbing reaches both stores.
 */

import { sanitize, sanitizerVersion } from "./sanitizer.js";

export interface Env {
  // R2 bucket holding sanitized HTML bytes (one object per version).
  DOCS: R2Bucket;
  // D1 database holding documents, versions, agents, agent_keys.
  META: D1Database;

  // Non-secret config from [vars] in wrangler.toml.
  SANITIZER_VERSION: string;
  STORAGE_CAP_BYTES: string;

  // Secrets — set via `wrangler secret put`. Not used yet in step 1.
  HMAC_PEPPER?: string;
  OPERATOR_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return hello(env);
    }

    // Step-2 smoke test for the Ammonia-WASM sanitizer. Goes away in step 3
    // when /d takes over as the real write path.
    if (url.pathname === "/sanitize-test" && request.method === "GET") {
      return sanitizeTest();
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Smoke-test endpoint: confirms the Worker can reach both stores. Returns
 * JSON with the D1 SQLite version and the R2 bucket name so a successful
 * 200 means bindings, account, and routing are all wired correctly.
 */
async function hello(env: Env): Promise<Response> {
  // Cheap query that proves the schema migration ran (counts the empty tables).
  // D1 blocks sqlite_version(), so we exercise our own tables instead.
  const d1 = await env.META.prepare(
    "select (select count(*) from documents) as documents, " +
      "(select count(*) from agents) as agents"
  ).first<{ documents: number; agents: number }>();
  // Cheap R2 round-trip: list with limit=1 just to prove the binding works.
  const r2 = await env.DOCS.list({ limit: 1 });

  return Response.json({
    ok: true,
    service: "agent-web-host",
    sanitizer_version: env.SANITIZER_VERSION,
    storage_cap_bytes: Number(env.STORAGE_CAP_BYTES),
    d1: { documents: d1?.documents ?? null, agents: d1?.agents ?? null },
    r2: { bucket_reachable: true, sample_object_count: r2.objects.length },
  });
}

/**
 * Step-2 verification: feed a deliberately hostile HTML string through the
 * sanitizer and return both halves so we can eyeball the diff. The asserts
 * below are not a substitute for real tests — they're a fast tripwire that
 * fails the request loudly if a known-bad pattern survives a deploy.
 */
function sanitizeTest(): Response {
  const hostile = [
    `<!doctype html>`,
    `<html><head>`,
    `<title>hello</title>`,
    `<meta http-equiv="refresh" content="0;url=https://evil.example/">`,
    `<style>body { background: url("javascript:alert(1)") }</style>`,
    `</head><body>`,
    `<h1>Hi <script>alert('xss')</script></h1>`,
    `<p>Click <a href="javascript:alert(1)" target="_blank">me</a></p>`,
    `<p>Or <a href="https://example.com" target="_blank">this</a></p>`,
    `<img src="x" onerror="alert(1)">`,
    `<iframe src="https://evil.example"></iframe>`,
    `<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/>`,
    `<script>alert('svg-xss')</script></svg>`,
    `<p style="color: green">styled paragraph</p>`,
    `</body></html>`,
  ].join("\n");

  const cleaned = sanitize(hostile);

  // Tripwires — anything that survives here is a regression in the allowlist.
  const checks = {
    no_script: !/<script/i.test(cleaned),
    no_meta_refresh: !/<meta[^>]+http-equiv/i.test(cleaned),
    no_iframe: !/<iframe/i.test(cleaned),
    no_onerror: !/onerror=/i.test(cleaned),
    no_javascript_url: !/javascript:/i.test(cleaned),
    safe_link_rel: !/<a[^>]+target=/i.test(cleaned) || /rel="noopener noreferrer"/i.test(cleaned),
    kept_svg_circle: /<circle\b/i.test(cleaned),
    kept_inline_style: /style="color/.test(cleaned),
  };
  const all_ok = Object.values(checks).every(Boolean);

  return Response.json(
    {
      ok: all_ok,
      sanitizer_version: sanitizerVersion(),
      checks,
      input: hostile,
      output: cleaned,
    },
    { status: all_ok ? 200 : 500 },
  );
}
