/**
 * Operator-only endpoints for managing per-agent OAuth clients.
 *
 *   POST   /admin/agents/:agent_id/oauth-clients   mint OAuth client + pin to agent
 *   DELETE /admin/oauth-clients/:client_id          revoke OAuth client (cascades to live tokens)
 *
 * One OAuth client per agent: the POST 409s if the agent already has one.
 * To rotate, DELETE then re-POST. To kill the whole agent (every key AND
 * every OAuth client in one call), use DELETE /admin/agents/:id from
 * src/admin.ts.
 *
 * The OAuthProvider holds the canonical client record in OAUTH_KV; we
 * persist the (client_id ↔ agent_id) join in D1's oauth_clients table so
 * `/authorize` can resolve client_id → agent_id when stamping props.
 */

import { authenticateOperator } from "./auth.js";
import type { Env } from "./env.js";

/** Anthropic's hosted-Claude callback. Single URL for all surfaces (web/mobile/Cowork). */
const ANTHROPIC_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** Loose v4-ish UUID matcher — version nibble unconstrained. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error: code, message, ...extra }, { status });
}

function requireOperator(req: Request, env: Env): Response | null {
  if (!authenticateOperator(req, env)) {
    return jsonError(401, "unauthorized", "operator token required");
  }
  return null;
}

/**
 * POST /admin/agents/:agent_id/oauth-clients  →  201 { client_id, client_secret, mcp_url }
 *
 * Creates an OAuth client in OAUTH_KV (via OAUTH_PROVIDER.createClient) and
 * pins it to the given agents row. The plaintext client_secret is shown
 * exactly once — store it in the connector's config.
 */
export async function createOAuthClient(
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

  // One client per agent (UNIQUE constraint in oauth_clients enforces this,
  // but checking up front gives a friendly 409).
  const existing = await env.META.prepare(
    "select client_id from oauth_clients where agent_id = ?",
  )
    .bind(agentId)
    .first<{ client_id: string }>();
  if (existing) {
    return jsonError(409, "client_exists", "agent already has an OAuth client", {
      client_id: existing.client_id,
      hint: "DELETE /admin/oauth-clients/<client_id> to rotate, or DELETE /admin/agents/<id> to kill the whole agent",
    });
  }

  // Provider auto-generates client_id and client_secret; we capture both
  // and persist only the mapping in D1.
  const client = await env.OAUTH_PROVIDER.createClient({
    clientName: agent.name,
    redirectUris: [ANTHROPIC_CALLBACK],
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });

  await env.META.prepare(
    "insert into oauth_clients (client_id, agent_id) values (?, ?)",
  )
    .bind(client.clientId, agentId)
    .run();

  const origin = new URL(req.url).origin;
  return Response.json(
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      mcp_url: `${origin}/mcp`,
      agent_id: agentId,
      agent_name: agent.name,
      note: "store client_secret now — it is never returned again. Paste mcp_url + client_id + client_secret into Cowork → Customize → Connectors → '+' → Add custom connector.",
    },
    { status: 201 },
  );
}

/**
 * DELETE /admin/oauth-clients/:client_id  →  200 { revoked, client_id }
 *
 * Cascading revoke: OAUTH_PROVIDER.deleteClient invalidates every grant
 * and live token for this client in OAUTH_KV immediately, so the next
 * /mcp request bearing one of those tokens 401s. We then drop the D1
 * mapping row.
 *
 * Use this for rotation (mint a fresh client for the same agent). To
 * decommission the agent entirely, prefer DELETE /admin/agents/:id which
 * also revokes every awh_ key.
 */
export async function deleteOAuthClient(
  clientId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = requireOperator(req, env);
  if (denied) return denied;

  const row = await env.META.prepare(
    "select client_id, agent_id from oauth_clients where client_id = ?",
  )
    .bind(clientId)
    .first<{ client_id: string; agent_id: string }>();
  if (!row) return jsonError(404, "not_found", "no such OAuth client");

  // KV first — that's the cascading invalidation of live tokens. If this
  // throws we leave the D1 row in place so the operator can retry.
  await env.OAUTH_PROVIDER.deleteClient(clientId);
  await env.META.prepare("delete from oauth_clients where client_id = ?")
    .bind(clientId)
    .run();

  return Response.json({ revoked: true, client_id: clientId, agent_id: row.agent_id });
}
