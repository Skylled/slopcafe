// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

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

import type { Env } from "./env.js";
import { UUID_RE } from "./ids.js";
import { requireOperator } from "./session.js";

/** Anthropic's hosted-Claude callback. Single URL for all surfaces (web/mobile/Cowork). */
const ANTHROPIC_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/**
 * The post-grant redirect hosts the worker will both (a) allow as inline TOFU
 * callbacks at /authorize and (b) permit in AUTHORIZE_CSP `form-action`. SINGLE
 * SOURCE OF TRUTH — approving a host not listed here would be CSP-blocked on the
 * post-grant 302, so `validateCallbackUri` and the CSP derive from this one set
 * (see src/authorize.ts). Operator-curated: TOFU lets the operator approve new
 * *paths* on these hosts inline, but adding a *host* is a deliberate per-vendor
 * trust decision made here (it lets that host receive OAuth authorization codes).
 */
export const APPROVABLE_CALLBACK_HOSTS: ReadonlySet<string> = new Set([
  "claude.ai",
  "claude.com",
  "chatgpt.com",
]);

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error: code, message, ...extra }, { status });
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
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  if (!UUID_RE.test(agentId)) return jsonError(404, "not_found", "no such agent");

  const origin = new URL(req.url).origin;
  const result = await createOAuthClientCore(env, agentId, origin);
  if (!result.ok) {
    if (result.code === "client_exists") {
      return jsonError(409, "client_exists", "agent already has an OAuth client", {
        client_id: result.client_id,
        hint: "DELETE /admin/oauth-clients/<client_id> to rotate, or DELETE /admin/agents/<id> to kill the whole agent",
      });
    }
    return jsonError(404, "not_found", "no such agent");
  }

  return Response.json(
    {
      client_id: result.client_id,
      client_secret: result.client_secret,
      mcp_url: result.mcp_url,
      agent_id: result.agent_id,
      agent_name: result.agent_name,
      note: "store client_secret now — it is never returned again. Paste mcp_url + client_id + client_secret into Cowork → Customize → Connectors → '+' → Add custom connector.",
    },
    { status: 201 },
  );
}

/**
 * Mint a bound OAuth client (KV record + the `oauth_clients` D1 join row) for one
 * agent. Lifted from `createOAuthClient` so a console form mints through the same
 * path. The caller pre-validates the id format (the JSON handler's leading
 * UUID_RE 404); core re-checks existence and the one-client-per-agent rule. The
 * plaintext `client_secret` is returned once — never recoverable after. `origin`
 * comes from the request URL and feeds `mcp_url` (the connector endpoint).
 */
export async function createOAuthClientCore(
  env: Env,
  agentId: string,
  origin: string,
): Promise<
  | {
      ok: true;
      client_id: string;
      client_secret: string;
      mcp_url: string;
      agent_id: string;
      agent_name: string;
    }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "client_exists"; client_id: string }
> {
  const agent = await env.META.prepare("select id, name from agents where id = ?")
    .bind(agentId)
    .first<{ id: string; name: string }>();
  if (!agent) return { ok: false, code: "not_found" };

  // One client per agent (UNIQUE constraint in oauth_clients enforces this,
  // but checking up front gives a friendly 409).
  const existing = await env.META.prepare(
    "select client_id from oauth_clients where agent_id = ?",
  )
    .bind(agentId)
    .first<{ client_id: string }>();
  if (existing) {
    return { ok: false, code: "client_exists", client_id: existing.client_id };
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

  return {
    ok: true,
    client_id: client.clientId,
    // createClient always returns a secret (clientSecret is only optional on the
    // shared ClientInfo type because lookups omit it); assert to keep the spec's
    // `string` contract without coalescing to a wrong-but-non-undefined value.
    client_secret: client.clientSecret!,
    mcp_url: `${origin}/mcp`,
    agent_id: agentId,
    agent_name: agent.name,
  };
}

/**
 * POST /admin/oauth-clients  →  201 { client_id, client_secret, mcp_url, note }
 *
 * Mints an UNBOUND OAuth client: a KV client record with NO `oauth_clients` D1
 * row. The agent identity is chosen later, at /authorize (bind-or-mint at
 * consent) — `lookupAgentForClient` returning null is exactly "unbound" and
 * triggers the bind-or-mint card for an authed operator. Kept separate from
 * `createOAuthClient` (the bound mint) so the bound path's 404/409 semantics and
 * the route table stay explicit. The plaintext client_secret is shown once.
 */
export async function createUnboundOAuthClient(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const origin = new URL(req.url).origin;
  const result = await createUnboundOAuthClientCore(env, origin);
  return Response.json(
    {
      client_id: result.client_id,
      client_secret: result.client_secret,
      mcp_url: result.mcp_url,
      note: "unbound client — pick or mint an agent at /authorize on first connect. Store client_secret now; it is never returned again.",
    },
    { status: 201 },
  );
}

/**
 * Mint an UNBOUND OAuth client: a KV client record with NO `oauth_clients` D1
 * row (absence of the row IS "unbound"; the agent is chosen at /authorize on
 * first connect). Lifted from `createUnboundOAuthClient` so a console form mints
 * through the same path. No failure mode beyond a thrown provider call — there's
 * nothing to validate. `client_secret` is returned once.
 */
export async function createUnboundOAuthClientCore(
  env: Env,
  origin: string,
): Promise<{ client_id: string; client_secret: string; mcp_url: string }> {
  const client = await env.OAUTH_PROVIDER.createClient({
    clientName: "(unbound)",
    redirectUris: [ANTHROPIC_CALLBACK],
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  // Deliberately NO oauth_clients INSERT — absence of the row IS "unbound".

  return {
    client_id: client.clientId,
    // createClient always returns a secret — see the assert note in
    // createOAuthClientCore.
    client_secret: client.clientSecret!,
    mcp_url: `${origin}/mcp`,
  };
}

/**
 * DELETE /admin/oauth-clients/:client_id  →  200 { revoked, client_id }
 *
 * Cascading revoke: OAUTH_PROVIDER.deleteClient invalidates every grant
 * and live token for this client in OAUTH_KV immediately, so the next
 * /mcp request bearing one of those tokens 401s. We then drop the D1
 * mapping row (when there is one).
 *
 * Three cases, so an UNBOUND client (KV record, no D1 row) is still
 * tear-down-able instead of stranding an orphan in KV:
 *   - D1 row present  → today's cascade: deleteClient + delete the row.
 *   - no D1 row, but the client exists in KV (unbound) → KV-only deleteClient.
 *   - no D1 row and not in KV → 404.
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
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const result = await deleteOAuthClientCore(env, clientId);
  if (!result.ok) {
    if (result.code === "provider_error") {
      // The KV deleteClient threw; on the bound path the D1 row is intact so a
      // retry is safe. Re-throw so this stays the generic 500 the original
      // handler produced — the structured provider_error variant is the core's
      // typed return for non-HTTP callers, not a new HTTP error code.
      throw new Error("OAuth client deletion failed");
    }
    return jsonError(404, "not_found", "no such OAuth client");
  }

  // Bound teardown carries agent_id; unbound carries unbound:true. The wire is
  // the union of the two original literals (extra keys are undefined-elided by
  // Response.json — a bound result has no `unbound`, an unbound one no `agent_id`).
  if (result.unbound) {
    return Response.json({ revoked: true, client_id: clientId, unbound: true });
  }
  return Response.json({ revoked: true, client_id: clientId, agent_id: result.agent_id });
}

/**
 * Cascading OAuth-client revoke. Three cases, so an UNBOUND client (KV record,
 * no D1 row) is still tear-down-able instead of stranding a KV orphan:
 *   - D1 row present  → deleteClient (cascades live tokens) + drop the join row;
 *     returns `agent_id`.
 *   - no D1 row, KV present (unbound) → KV-only deleteClient; returns `unbound`.
 *   - no D1 row, not in KV → `not_found`.
 *
 * Lifted from `deleteOAuthClient` so a console form revokes through the same
 * path. KV is deleted FIRST (the cascading invalidation of live tokens); on the
 * bound path the D1 row is left in place if deleteClient throws so the operator
 * can retry — that throw surfaces as `provider_error` (code-only message, never
 * the error object, to keep the secret-disclosure discipline).
 */
export async function deleteOAuthClientCore(
  env: Env,
  clientId: string,
): Promise<
  | { ok: true; agent_id?: string; unbound?: boolean }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "provider_error"; message: string }
> {
  const row = await env.META.prepare(
    "select client_id, agent_id from oauth_clients where client_id = ?",
  )
    .bind(clientId)
    .first<{ client_id: string; agent_id: string }>();

  if (row) {
    // Bound: KV first — that's the cascading invalidation of live tokens. If
    // this throws we leave the D1 row in place so the operator can retry.
    try {
      await env.OAUTH_PROVIDER.deleteClient(clientId);
    } catch {
      return {
        ok: false,
        code: "provider_error",
        message: "OAuth client deletion failed — the mapping is intact; retry",
      };
    }
    await env.META.prepare("delete from oauth_clients where client_id = ?")
      .bind(clientId)
      .run();
    return { ok: true, agent_id: row.agent_id };
  }

  // No D1 row — distinguish an unbound client (KV present) from a truly unknown one.
  const clientInfo = await env.OAUTH_PROVIDER.lookupClient(clientId);
  if (!clientInfo) return { ok: false, code: "not_found" };
  try {
    await env.OAUTH_PROVIDER.deleteClient(clientId);
  } catch {
    return {
      ok: false,
      code: "provider_error",
      message: "OAuth client deletion failed — retry",
    };
  }
  return { ok: true, unbound: true };
}

/**
 * The bound OAuth clients pinned to one agent, newest-first. The simple join-row
 * read (no OAUTH_PROVIDER enrichment in v1 — the console only needs client_id +
 * created_at to render the row and offer a revoke button). Returns `[]` for an
 * agent with no clients (or an unknown one — the caller has already validated the
 * agent exists when it cares).
 */
export async function listBoundClientsCore(
  env: Env,
  agentId: string,
): Promise<Array<{ client_id: string; created_at: string }>> {
  const result = await env.META.prepare(
    "select client_id, created_at from oauth_clients where agent_id = ? order by created_at desc",
  )
    .bind(agentId)
    .all<{ client_id: string; created_at: string }>();
  return result.results ?? [];
}
