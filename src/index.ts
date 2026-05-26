/**
 * agent-web-host — one Worker in front of D1 (metadata) + R2 (bytes).
 *
 * Step 1 of action-plan-v1.md: skeleton with bindings wired and a hello
 * route that proves the plumbing reaches both stores.
 */

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
