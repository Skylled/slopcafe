/**
 * Operator-only admin endpoints. All gated by `OPERATOR_TOKEN` — for v1
 * we use a single shared secret (no Google OAuth yet); each handler
 * checks via `authenticateOperator` and 401s on failure before doing any
 * other work, so unauthenticated probes can't even fingerprint the
 * UUID validation paths.
 *
 *   GET    /admin/agents                       list agents
 *   POST   /admin/agents                       mint agent + initial key
 *   GET    /admin/agents/:agent_id/keys        list keys for an agent
 *   POST   /admin/agents/:agent_id/keys        mint an additional key for an agent
 *   DELETE /admin/keys/:key_id                 revoke a single key
 *   GET    /admin/documents                    list documents (incl. revoked)
 *
 * Revoking a *document* lives on the public route (`DELETE /d/:public_id`)
 * since it shares the path with the resource. That endpoint is also
 * operator-auth.
 */

import { authenticateOperator, hmacSha256Hex } from "./auth.js";
import type { Env } from "./env.js";
import { newApiKey, newUuid } from "./ids.js";

/** Loose v4-ish UUID matcher — version nibble unconstrained. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Hard cap on rows per list response. v1 has no pagination; if you hit
 * this in practice the list is sorted newest-first, so the older items
 * are what gets clipped.
 */
const LIST_LIMIT = 200;

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error: code, message, ...extra }, { status });
}

/** Returns a 401 Response if the operator check fails, else null. */
function requireOperator(req: Request, env: Env): Response | null {
  if (!authenticateOperator(req, env)) {
    return jsonError(401, "unauthorized", "operator token required");
  }
  return null;
}

// -- agents -------------------------------------------------------------------

export async function listAgents(req: Request, env: Env): Promise<Response> {
  const denied = requireOperator(req, env);
  if (denied) return denied;

  const rows = await env.META.prepare(
    `select a.id, a.name, a.created_at,
       (select count(*) from agent_keys k
          where k.agent_id = a.id and k.revoked_at is null) as active_keys,
       (select count(*) from agent_keys k
          where k.agent_id = a.id) as total_keys,
       (select count(*) from documents d
          where d.created_by = a.id and d.revoked_at is null) as live_docs
     from agents a
     order by a.created_at desc
     limit ?`,
  )
    .bind(LIST_LIMIT)
    .all();
  return Response.json({ agents: rows.results ?? [] });
}

/**
 * POST /admin/agents  { "name": "<label>" }  →  201 { agent_id, key_id, key, ... }
 *
 * Mints an agent and its initial API key in one D1 transaction. The
 * plaintext key is returned exactly once.
 */
export async function mintAgent(req: Request, env: Env): Promise<Response> {
  const denied = requireOperator(req, env);
  if (denied) return denied;
  if (!env.HMAC_PEPPER) {
    return jsonError(500, "misconfigured", "HMAC_PEPPER not set");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const name = (body as { name?: unknown })?.name;
  if (typeof name !== "string" || name.length === 0 || name.length > 200) {
    return jsonError(400, "bad_request", "missing or invalid 'name' (string, 1-200 chars)");
  }

  const agentId = newUuid();
  const keyId = newUuid();
  const key = newApiKey();
  const keyHash = await hmacSha256Hex(key.secret, env.HMAC_PEPPER);

  await env.META.batch([
    env.META.prepare("insert into agents (id, name) values (?, ?)").bind(agentId, name),
    env.META.prepare(
      "insert into agent_keys (id, agent_id, key_prefix, key_hash) values (?, ?, ?, ?)",
    ).bind(keyId, agentId, key.prefix, keyHash),
  ]);

  return Response.json(
    {
      agent_id: agentId,
      key_id: keyId,
      key: key.plaintext,
      note: "store this key now — the secret half is never returned again",
    },
    { status: 201 },
  );
}

// -- keys ---------------------------------------------------------------------

export async function listAgentKeys(
  agentId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = requireOperator(req, env);
  if (denied) return denied;
  if (!UUID_RE.test(agentId)) return jsonError(404, "not_found", "no such agent");

  const agent = await env.META.prepare("select id, name from agents where id = ?")
    .bind(agentId)
    .first<{ id: string; name: string }>();
  if (!agent) return jsonError(404, "not_found", "no such agent");

  const keys = await env.META.prepare(
    `select id, key_prefix, created_at, revoked_at
     from agent_keys
     where agent_id = ?
     order by created_at desc`,
  )
    .bind(agentId)
    .all();
  return Response.json({
    agent_id: agentId,
    name: agent.name,
    keys: keys.results ?? [],
  });
}

/**
 * POST /admin/agents/:agent_id/keys  →  201 { key_id, key, ... }
 *
 * Adds a key to an existing agent (rotation, or scoping multiple workers
 * to one logical agent). Same one-shot plaintext contract as the initial
 * mint.
 */
export async function mintAgentKey(
  agentId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = requireOperator(req, env);
  if (denied) return denied;
  if (!UUID_RE.test(agentId)) return jsonError(404, "not_found", "no such agent");
  if (!env.HMAC_PEPPER) {
    return jsonError(500, "misconfigured", "HMAC_PEPPER not set");
  }

  const agent = await env.META.prepare("select id from agents where id = ?")
    .bind(agentId)
    .first<{ id: string }>();
  if (!agent) return jsonError(404, "not_found", "no such agent");

  const keyId = newUuid();
  const key = newApiKey();
  const keyHash = await hmacSha256Hex(key.secret, env.HMAC_PEPPER);

  await env.META.prepare(
    "insert into agent_keys (id, agent_id, key_prefix, key_hash) values (?, ?, ?, ?)",
  )
    .bind(keyId, agentId, key.prefix, keyHash)
    .run();

  return Response.json(
    {
      agent_id: agentId,
      key_id: keyId,
      key: key.plaintext,
      note: "store this key now — the secret half is never returned again",
    },
    { status: 201 },
  );
}

/**
 * DELETE /admin/keys/:key_id   →  200 { revoked, key_id, agent_id, key_prefix }
 *
 * The rogue-key kill switch. Sets `revoked_at` to now; the `authenticateAgent`
 * lookup checks this column and treats revoked keys as no-auth.
 *
 * Idempotent-ish: a second DELETE on an already-revoked key returns 404,
 * matching how `DELETE /d/:public_id` handles its already-revoked case.
 */
export async function revokeKey(
  keyId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = requireOperator(req, env);
  if (denied) return denied;
  if (!UUID_RE.test(keyId)) return jsonError(404, "not_found", "no such active key");

  const row = await env.META.prepare(
    "select id, agent_id, key_prefix, revoked_at from agent_keys where id = ?",
  )
    .bind(keyId)
    .first<{ id: string; agent_id: string; key_prefix: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) {
    return jsonError(404, "not_found", "no such active key");
  }

  await env.META.prepare(
    "update agent_keys set revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = ?",
  )
    .bind(keyId)
    .run();

  return Response.json({
    revoked: true,
    key_id: keyId,
    agent_id: row.agent_id,
    key_prefix: row.key_prefix,
  });
}

// -- documents ----------------------------------------------------------------

/**
 * GET /admin/documents   →  { documents: [...] }
 *
 * Includes revoked documents (with `revoked_at` set) so the operator can
 * audit the history. `current_size` is the size of the live version; null
 * for revoked docs (bytes were purged at revoke time).
 */
export async function listDocuments(req: Request, env: Env): Promise<Response> {
  const denied = requireOperator(req, env);
  if (denied) return denied;

  const rows = await env.META.prepare(
    `select d.public_id, d.current_ver, d.created_at, d.revoked_at,
       a.name as created_by_name, d.created_by as created_by_id,
       (select size_bytes from versions
          where document_id = d.id and version_no = d.current_ver) as current_size
     from documents d
     left join agents a on a.id = d.created_by
     order by d.created_at desc
     limit ?`,
  )
    .bind(LIST_LIMIT)
    .all();
  return Response.json({ documents: rows.results ?? [] });
}
