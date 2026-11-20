// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-only endpoints for managing OAuth clients.
 *
 *   GET    /admin/oauth-clients                    list bound + unbound clients with KV/grant liveness
 *   POST   /admin/oauth-clients                    mint an UNBOUND OAuth client (agent chosen at consent)
 *   POST   /admin/oauth-clients/prune              prune stale unbound KV clients or expired D1 ghost rows
 *   POST   /admin/agents/:agent_id/oauth-clients   mint OAuth client + pin to agent (multiple per agent)
 *   DELETE /admin/oauth-clients/:client_id          revoke OAuth client (cascades to live tokens)
 *
 * Migration 0021 dropped UNIQUE(agent_id) on `oauth_clients` (unblocked by
 * migration 0019 `versions.author_client_id`), so one agent can hold multiple
 * bound OAuth clients (e.g. Claude Web + Desktop + CLI) while each version
 * stays individually attributable and each client individually revocable. To
 * kill the whole agent (every key AND every OAuth client in one call), use
 * DELETE /admin/agents/:id from src/admin-agents.ts.
 *
 * The OAuthProvider holds the canonical client record in OAUTH_KV; we
 * persist the (client_id ↔ agent_id) join in D1's oauth_clients table so
 * `/authorize` can resolve client_id → agent_id when stamping props.
 */

import type { ClientInfo, GrantSummary } from "@cloudflare/workers-oauth-provider";
import { jsonError } from "./admin-response.js";
import { recordAudit } from "./audit.js";
import type { OAuthClientSummary } from "./contract.js";
import type { Env } from "./env.js";
import { UUID_RE } from "./ids.js";
import { requireOperator } from "./session.js";
import type { WaitUntil } from "./vector-io.js";

/** Anthropic's hosted-Claude callback. Single URL for all surfaces (web/mobile/Cowork). */
const ANTHROPIC_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** Maximum redirect URIs accepted on a manual operator client mint. */
const MAX_MINT_REDIRECT_URIS = 20;
const MAX_MINT_REDIRECT_URI_CHARS = 2048;
const MAX_MINT_CLIENT_NAME_CHARS = 200;

/** Default age gate for pruning unbound DCR clients (in days). */
export const DEFAULT_UNBOUND_PRUNE_DAYS = 7;

/** Defensive page ceiling when enumerating KV clients/grants in a single Worker request. */
const MAX_KV_LIST_PAGES = 10;

/**
 * The post-grant redirect hosts the worker will allow as inline TOFU callbacks
 * at /authorize. Operator-curated: TOFU lets the operator approve new *paths*
 * on these hosts inline, while adding a *host* is a deliberate per-vendor trust
 * decision made here (it lets that host receive OAuth authorization codes).
 */
export const APPROVABLE_CALLBACK_HOSTS: ReadonlySet<string> = new Set([
  "claude.ai",
  "claude.com",
  "chatgpt.com",
]);

/** IDE custom schemes permitted on manual operator mint (mirrors authorize.ts). */
const MINT_IDE_SCHEMES: ReadonlySet<string> = new Set([
  "vscode:",
  "vscode-insiders:",
  "cursor:",
  "windsurf:",
]);

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Validate a callback URI passed to manual operator mint (`POST /admin/oauth-clients`
 * or `POST /admin/agents/:id/oauth-clients`). Accepts the exact callback shapes
 * permitted by the consent screen's CSP `form-action`:
 *   - any `https:` URL (no userinfo, no fragment, no control chars)
 *   - loopback `http:` (`localhost`, `127.x.y.z`, `[::1]`; no userinfo/fragment)
 *   - recognized IDE custom schemes (`vscode:`, `vscode-insiders:`, `cursor:`, `windsurf:`)
 *
 * Pure (no env) so it is unit-testable.
 */
export function validateMintRedirectUri(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_MINT_REDIRECT_URI_CHARS) {
    return null;
  }
  // Reject C0/C1 control characters and DEL.
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return null;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username !== "" || u.password !== "") return null;
  if (u.hash !== "") return null;
  if (u.protocol === "https:") {
    return u.hostname ? u.toString() : null;
  }
  if (u.protocol === "http:") {
    return isLoopbackHost(u.hostname) ? u.toString() : null;
  }
  if (MINT_IDE_SCHEMES.has(u.protocol)) {
    return u.toString();
  }
  return null;
}

export type MintClientOptions = {
  redirectUris?: string[];
  clientName?: string;
};

/**
 * Parse an optional JSON body for manual OAuth-client minting. An empty body
 * (legacy callers) succeeds with defaults; invalid JSON or malformed fields
 * return a structured 400 error.
 */
async function parseOptionalMintBody(
  req: Request,
): Promise<
  | { ok: true; opts: MintClientOptions }
  | { ok: false; code: "bad_json" | "bad_request"; message: string }
> {
  const text = await req.text();
  if (text.trim() === "") return { ok: true, opts: {} };

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: "bad_json", message: "invalid JSON body" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "bad_request", message: "request body must be a JSON object" };
  }

  const b = body as { redirect_uris?: unknown; client_name?: unknown };
  const opts: MintClientOptions = {};

  if (b.redirect_uris !== undefined) {
    if (!Array.isArray(b.redirect_uris) || b.redirect_uris.length === 0) {
      return {
        ok: false,
        code: "bad_request",
        message: "'redirect_uris' must be a non-empty array of callback URLs",
      };
    }
    if (b.redirect_uris.length > MAX_MINT_REDIRECT_URIS) {
      return {
        ok: false,
        code: "bad_request",
        message: `'redirect_uris' may contain at most ${MAX_MINT_REDIRECT_URIS} URLs`,
      };
    }
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of b.redirect_uris) {
      if (typeof item !== "string") {
        return { ok: false, code: "bad_request", message: "every 'redirect_uris' entry must be a string" };
      }
      const norm = validateMintRedirectUri(item.trim());
      if (!norm) {
        return {
          ok: false,
          code: "bad_request",
          message:
            "invalid redirect_uri — must be https, loopback http, or a supported IDE scheme with no embedded credentials or fragment",
        };
      }
      if (!seen.has(norm)) {
        seen.add(norm);
        deduped.push(norm);
      }
    }
    opts.redirectUris = deduped;
  }

  if (b.client_name !== undefined) {
    if (typeof b.client_name !== "string") {
      return { ok: false, code: "bad_request", message: "'client_name' must be a string" };
    }
    const trimmed = b.client_name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_MINT_CLIENT_NAME_CHARS) {
      return {
        ok: false,
        code: "bad_request",
        message: `'client_name' must be 1–${MAX_MINT_CLIENT_NAME_CHARS} characters`,
      };
    }
    opts.clientName = trimmed;
  }

  return { ok: true, opts };
}

/**
 * POST /admin/agents/:agent_id/oauth-clients  →  201 { client_id, client_secret, mcp_url, ... }
 *
 * Creates an OAuth client in OAUTH_KV (via OAUTH_PROVIDER.createClient) and
 * pins it to the given agents row. Accepts an optional JSON body with
 * `redirect_uris` and/or `client_name`. The plaintext client_secret is shown
 * exactly once — store it in the connector's config.
 */
export async function createOAuthClient(
  agentId: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  if (!UUID_RE.test(agentId)) return jsonError(404, "not_found", "no such agent");

  const parsed = await parseOptionalMintBody(req);
  if (!parsed.ok) return jsonError(400, parsed.code, parsed.message);

  const origin = new URL(req.url).origin;
  const result = await createOAuthClientCore(env, agentId, origin, waitUntil, parsed.opts);
  if (!result.ok) {
    return jsonError(404, "not_found", "no such agent");
  }

  return Response.json(
    {
      client_id: result.client_id,
      client_secret: result.client_secret,
      mcp_url: result.mcp_url,
      agent_id: result.agent_id,
      agent_name: result.agent_name,
      redirect_uris: result.redirect_uris,
      note: "store client_secret now — it is never returned again. Paste mcp_url + client_id + client_secret into your connector settings.",
    },
    { status: 201 },
  );
}

/**
 * Mint a bound OAuth client (KV record + `oauth_clients` D1 join row) for one
 * agent. Multiple OAuth clients may bind to the same agent (migration 0021);
 * each version records `author_client_id` (migration 0019) and each client is
 * individually revocable. The plaintext `client_secret` is returned once —
 * never recoverable after.
 */
export async function createOAuthClientCore(
  env: Env,
  agentId: string,
  origin: string,
  waitUntil?: WaitUntil,
  opts: MintClientOptions = {},
): Promise<
  | {
      ok: true;
      client_id: string;
      client_secret: string;
      mcp_url: string;
      agent_id: string;
      agent_name: string;
      redirect_uris: string[];
    }
  | { ok: false; code: "not_found" }
> {
  const agent = await env.META.prepare("select id, name from agents where id = ?")
    .bind(agentId)
    .first<{ id: string; name: string }>();
  if (!agent) return { ok: false, code: "not_found" };

  const redirectUris = opts.redirectUris && opts.redirectUris.length > 0
    ? opts.redirectUris
    : [ANTHROPIC_CALLBACK];

  // Provider auto-generates client_id and client_secret; we capture both
  // and persist only the mapping in D1.
  const client = await env.OAUTH_PROVIDER.createClient({
    clientName: opts.clientName ?? agent.name,
    redirectUris,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });

  try {
    await env.META.prepare(
      "insert into oauth_clients (client_id, agent_id) values (?, ?)",
    )
      .bind(client.clientId, agentId)
      .run();
  } catch (err) {
    // Roll back the just-created KV client so a failed D1 insert never leaks
    // an orphan client record in OAUTH_KV (QL-808 / Q6).
    await env.OAUTH_PROVIDER.deleteClient(client.clientId).catch(() => {
      /* best effort rollback */
    });
    throw err;
  }

  // Ledger (0020): `bound: true` — this client arrives already pinned to an
  // agent, so unlike the unbound mint below it never passes through
  // `oauth_client_bound` at consent. The client_secret is disclosed once to the
  // operator and recorded nowhere.
  recordAudit(env, waitUntil, {
    kind: "oauth_client_minted",
    principal_kind: "operator",
    client_id: client.clientId,
    agent_id: agentId,
    bound: true,
  });

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
    redirect_uris: client.redirectUris,
  };
}

/**
 * POST /admin/oauth-clients  →  201 { client_id, client_secret, mcp_url, redirect_uris, note }
 *
 * Mints an UNBOUND OAuth client: a KV client record with NO `oauth_clients` D1
 * row. The agent identity is chosen later, at /authorize (bind-or-mint at
 * consent). Accepts an optional JSON body with `redirect_uris` and/or
 * `client_name`. The plaintext client_secret is shown once.
 */
export async function createUnboundOAuthClient(
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const parsed = await parseOptionalMintBody(req);
  if (!parsed.ok) return jsonError(400, parsed.code, parsed.message);

  const origin = new URL(req.url).origin;
  const result = await createUnboundOAuthClientCore(env, origin, waitUntil, parsed.opts);
  return Response.json(
    {
      client_id: result.client_id,
      client_secret: result.client_secret,
      mcp_url: result.mcp_url,
      redirect_uris: result.redirect_uris,
      note: "unbound client — pick or mint an agent at /authorize on first connect. Store client_secret now; it is never returned again.",
    },
    { status: 201 },
  );
}

/**
 * Mint an UNBOUND OAuth client: a KV client record with NO `oauth_clients` D1
 * row (absence of the row IS "unbound"; the agent is chosen at /authorize on
 * first connect). Lifted from `createUnboundOAuthClient` so a console form mints
 * through the same path. `client_secret` is returned once.
 */
export async function createUnboundOAuthClientCore(
  env: Env,
  origin: string,
  waitUntil?: WaitUntil,
  opts: MintClientOptions = {},
): Promise<{ client_id: string; client_secret: string; mcp_url: string; redirect_uris: string[] }> {
  const redirectUris = opts.redirectUris && opts.redirectUris.length > 0
    ? opts.redirectUris
    : [ANTHROPIC_CALLBACK];

  const client = await env.OAUTH_PROVIDER.createClient({
    clientName: opts.clientName ?? "(unbound)",
    redirectUris,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  // Deliberately NO oauth_clients INSERT — absence of the row IS "unbound".

  // Ledger (0020): `bound: false` is the meaningful half — this client can
  // reach the consent screen and be bound to ANY agent later, so the mint and
  // the binding are two separate events (see `oauth_client_bound`, filed by
  // src/authorize.ts). The client_secret is returned to the operator once and
  // recorded nowhere.
  recordAudit(env, waitUntil, {
    kind: "oauth_client_minted",
    principal_kind: "operator",
    client_id: client.clientId,
    bound: false,
  });

  return {
    client_id: client.clientId,
    // createClient always returns a secret — see the assert note in
    // createOAuthClientCore.
    client_secret: client.clientSecret!,
    mcp_url: `${origin}/mcp`,
    redirect_uris: client.redirectUris,
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
 */
export async function deleteOAuthClient(
  clientId: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const result = await deleteOAuthClientCore(env, clientId, waitUntil);
  if (!result.ok) {
    if (result.code === "provider_error") {
      throw new Error("OAuth client deletion failed");
    }
    return jsonError(404, "not_found", "no such OAuth client");
  }

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
 */
export async function deleteOAuthClientCore(
  env: Env,
  clientId: string,
  waitUntil?: WaitUntil,
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
    recordAudit(env, waitUntil, {
      kind: "oauth_client_deleted",
      principal_kind: "operator",
      client_id: clientId,
      agent_id: row.agent_id,
    });
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
  recordAudit(env, waitUntil, {
    kind: "oauth_client_deleted",
    principal_kind: "operator",
    client_id: clientId,
  });
  return { ok: true, unbound: true };
}

// -- listing + KV/grant liveness ----------------------------------------------

async function listAllKvClients(env: Env): Promise<{ clients: Map<string, ClientInfo>; truncated: boolean }> {
  const clients = new Map<string, ClientInfo>();
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_KV_LIST_PAGES; page++) {
    const res = await env.OAUTH_PROVIDER.listClients({ limit: 1000, cursor });
    for (const item of res.items) {
      clients.set(item.clientId, item);
    }
    if (!res.cursor) return { clients, truncated: false };
    cursor = res.cursor;
  }
  truncated = true;
  return { clients, truncated };
}

async function listAllUserGrants(env: Env, userId: string): Promise<GrantSummary[]> {
  const out: GrantSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_KV_LIST_PAGES; page++) {
    const res = await env.OAUTH_PROVIDER.listUserGrants(userId, { limit: 1000, cursor });
    for (const g of res.items) out.push(g);
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

function summarizeGrants(grants: readonly GrantSummary[]): {
  active_grants: number;
  earliest_grant_expires_at: string | null;
  has_non_expiring_grant: boolean;
} {
  let earliestSec: number | null = null;
  let hasNonExpiring = false;
  for (const g of grants) {
    if (typeof g.expiresAt === "number" && Number.isFinite(g.expiresAt)) {
      if (earliestSec === null || g.expiresAt < earliestSec) earliestSec = g.expiresAt;
    } else {
      hasNonExpiring = true;
    }
  }
  return {
    active_grants: grants.length,
    earliest_grant_expires_at: earliestSec !== null ? new Date(earliestSec * 1000).toISOString() : null,
    has_non_expiring_grant: hasNonExpiring,
  };
}

function registrationIso(registrationDate: number | undefined): string | null {
  if (typeof registrationDate !== "number" || !Number.isFinite(registrationDate)) return null;
  return new Date(registrationDate * 1000).toISOString();
}

export type ListOAuthClientsFilter = {
  status?: "bound" | "unbound" | "expired_in_kv";
  agentId?: string;
};

/**
 * GET /admin/oauth-clients?status=bound|unbound|expired_in_kv&agent_id=<uuid>
 *   →  200 { clients: OAuthClientSummary[], counts: { total, bound, unbound, expired_in_kv } }
 *
 * Joins D1 `oauth_clients` with `OAUTH_PROVIDER.listClients()` and
 * `listUserGrants()` so the operator can inspect bound vs. unbound clients,
 * KV liveness (`alive` / `expired_in_kv`), redirect URIs, registration timestamps,
 * and active grant expiration dates. Never returns client secrets.
 */
export async function listOAuthClients(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const url = new URL(req.url);
  const statusRaw = url.searchParams.get("status");
  let status: ListOAuthClientsFilter["status"];
  if (statusRaw !== null && statusRaw !== "") {
    if (statusRaw !== "bound" && statusRaw !== "unbound" && statusRaw !== "expired_in_kv") {
      return jsonError(
        400,
        "bad_request",
        `'status' must be "bound", "unbound", or "expired_in_kv"`,
      );
    }
    status = statusRaw;
  }

  const agentIdRaw = url.searchParams.get("agent_id");
  let agentId: string | undefined;
  if (agentIdRaw !== null && agentIdRaw !== "") {
    if (!UUID_RE.test(agentIdRaw)) {
      return jsonError(400, "bad_request", "'agent_id' must be a valid UUID");
    }
    agentId = agentIdRaw;
  }

  const result = await listOAuthClientsCore(env, { status, agentId });
  return Response.json(result);
}

/**
 * Fleet-wide OAuth client inventory joining D1 `oauth_clients` with `OAUTH_KV`
 * clients and per-agent grants. `counts` always reflects the full fleet; `clients`
 * is narrowed by optional `status` / `agentId` filters.
 */
export async function listOAuthClientsCore(
  env: Env,
  filter: ListOAuthClientsFilter = {},
): Promise<{
  clients: OAuthClientSummary[];
  counts: { total: number; bound: number; unbound: number; expired_in_kv: number };
}> {
  const [boundRowsRes, kvListing] = await Promise.all([
    env.META.prepare(
      `select oc.client_id, oc.agent_id, a.name as agent_name, oc.created_at
       from oauth_clients oc
       join agents a on a.id = oc.agent_id
       order by oc.created_at desc, oc.client_id desc`,
    ).all<{ client_id: string; agent_id: string; agent_name: string; created_at: string }>(),
    listAllKvClients(env),
  ]);

  const boundRows = boundRowsRes.results ?? [];
  const kvMap = kvListing.clients;
  const boundIdSet = new Set(boundRows.map((r) => r.client_id));

  // Resolve any bound row missing from a truncated KV listing via point lookup.
  if (kvListing.truncated) {
    const missing = boundRows.filter((r) => !kvMap.has(r.client_id));
    const lookedUp = await Promise.all(
      missing.map((r) => env.OAUTH_PROVIDER.lookupClient(r.client_id)),
    );
    for (let i = 0; i < missing.length; i++) {
      const info = lookedUp[i];
      if (info) kvMap.set(missing[i]!.client_id, info);
    }
  }

  // Fetch active grants once per distinct bound agent.
  const distinctAgentIds = [...new Set(boundRows.map((r) => r.agent_id))];
  const grantsByAgent = new Map<string, GrantSummary[]>();
  const grantLists = await Promise.all(
    distinctAgentIds.map((id) => listAllUserGrants(env, id)),
  );
  for (let i = 0; i < distinctAgentIds.length; i++) {
    grantsByAgent.set(distinctAgentIds[i]!, grantLists[i] ?? []);
  }

  const all: OAuthClientSummary[] = [];
  let boundCount = 0;
  let expiredGhostCount = 0;

  for (const row of boundRows) {
    boundCount++;
    const info = kvMap.get(row.client_id) ?? null;
    const alive = info !== null;
    if (!alive) expiredGhostCount++;
    const clientGrants = (grantsByAgent.get(row.agent_id) ?? []).filter(
      (g) => g.clientId === row.client_id,
    );
    const grantStats = summarizeGrants(clientGrants);
    all.push({
      client_id: row.client_id,
      bound: true,
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      bound_at: row.created_at,
      kv_status: alive ? "alive" : "expired_in_kv",
      client_name: info?.clientName ?? null,
      redirect_uris: info?.redirectUris ?? [],
      token_endpoint_auth_method: info?.tokenEndpointAuthMethod ?? null,
      registered_at: registrationIso(info?.registrationDate),
      ...grantStats,
    });
  }

  // Unbound KV clients (DCR self-registrations or unbound operator mints),
  // newest registrationDate first.
  const unboundInfos = [...kvMap.values()]
    .filter((c) => !boundIdSet.has(c.clientId))
    .sort((a, b) => (b.registrationDate ?? 0) - (a.registrationDate ?? 0));

  for (const info of unboundInfos) {
    all.push({
      client_id: info.clientId,
      bound: false,
      agent_id: null,
      agent_name: null,
      bound_at: null,
      kv_status: "alive",
      client_name: info.clientName ?? null,
      redirect_uris: info.redirectUris ?? [],
      token_endpoint_auth_method: info.tokenEndpointAuthMethod ?? null,
      registered_at: registrationIso(info.registrationDate),
      active_grants: 0,
      earliest_grant_expires_at: null,
      has_non_expiring_grant: false,
    });
  }

  const counts = {
    total: all.length,
    bound: boundCount,
    unbound: unboundInfos.length,
    expired_in_kv: expiredGhostCount,
  };

  let filtered = all;
  if (filter.status === "bound") {
    filtered = filtered.filter((c) => c.bound);
  } else if (filter.status === "unbound") {
    filtered = filtered.filter((c) => !c.bound);
  } else if (filter.status === "expired_in_kv") {
    filtered = filtered.filter((c) => c.kv_status === "expired_in_kv");
  }
  if (filter.agentId) {
    filtered = filtered.filter((c) => c.agent_id === filter.agentId);
  }

  return { clients: filtered, counts };
}

/**
 * The bound OAuth clients pinned to one agent, newest-first (D1 rows only).
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

export type BoundClientLiveness = {
  client_id: string;
  created_at: string;
  kv_status: "alive" | "expired_in_kv";
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string | null;
  registered_at: string | null;
  active_grants: number;
  earliest_grant_expires_at: string | null;
  has_non_expiring_grant: boolean;
};

/**
 * Bound OAuth clients for one agent enriched with `OAUTH_KV` liveness and
 * active grant summaries — backing `/admin/console/agents/:id`.
 */
export async function listBoundClientsWithLivenessCore(
  env: Env,
  agentId: string,
): Promise<BoundClientLiveness[]> {
  const rows = await listBoundClientsCore(env, agentId);
  if (rows.length === 0) return [];

  const [infos, grants] = await Promise.all([
    Promise.all(rows.map((r) => env.OAUTH_PROVIDER.lookupClient(r.client_id))),
    listAllUserGrants(env, agentId),
  ]);

  return rows.map((row, i) => {
    const info = infos[i] ?? null;
    const clientGrants = grants.filter((g) => g.clientId === row.client_id);
    const grantStats = summarizeGrants(clientGrants);
    return {
      client_id: row.client_id,
      created_at: row.created_at,
      kv_status: info ? "alive" : "expired_in_kv",
      client_name: info?.clientName ?? null,
      redirect_uris: info?.redirectUris ?? [],
      token_endpoint_auth_method: info?.tokenEndpointAuthMethod ?? null,
      registered_at: registrationIso(info?.registrationDate),
      ...grantStats,
    };
  });
}

// -- pruning (unbound KV clients + expired D1 ghosts) -------------------------

export type PruneOAuthClientsMode = "unbound" | "expired_ghosts";

export type PruneOAuthClientsResult =
  | {
      ok: true;
      mode: PruneOAuthClientsMode;
      dryRun: boolean;
      matched: number;
      deleted: number;
      grantsPurged: number;
      tokensPurged: number;
    }
  | { ok: false; code: "bad_request"; message: string };

/**
 * Prune stale OAuth clients (companion to `DCR_CLIENT_TTL_SECONDS = undefined`
 * and migration `0021`, matching `POST /admin/keys/prune`'s shape):
 *
 *   - `"unbound"`: deletes KV client records that have NO D1 `oauth_clients`
 *     binding row and whose `registrationDate` is older than `olderThanDays`
 *     (default 7, integer >= 0; 0 prunes every unbound client immediately). On a
 *     real run also calls `OAUTH_PROVIDER.purgeExpiredData()` to sweep orphaned
 *     or expired grants/tokens in KV.
 *   - `"expired_ghosts"`: deletes D1 `oauth_clients` rows whose KV client record
 *     is missing (`lookupClient === null` — dead rows left behind by prior
 *     90-day KV expiries). Rejects `olderThanDays` (no grace window for a row
 *     pointing at a nonexistent KV client).
 */
export async function pruneOAuthClientsCore(
  env: Env,
  mode: PruneOAuthClientsMode,
  opts: { dryRun?: boolean; olderThanDays?: number } = {},
  nowMs: number = Date.now(),
  waitUntil?: WaitUntil,
): Promise<PruneOAuthClientsResult> {
  const dryRun = opts.dryRun ?? false;

  if (mode === "expired_ghosts") {
    if (opts.olderThanDays !== undefined) {
      return {
        ok: false,
        code: "bad_request",
        message:
          `'older_than_days' is not accepted for mode "expired_ghosts" — a D1 row whose KV client ` +
          `already expired is inert immediately, with no age gate`,
      };
    }
    const [boundRowsRes, kvListing] = await Promise.all([
      env.META.prepare("select client_id, agent_id from oauth_clients").all<{
        client_id: string;
        agent_id: string;
      }>(),
      listAllKvClients(env),
    ]);
    const boundRows = boundRowsRes.results ?? [];
    const ghosts: Array<{ client_id: string; agent_id: string }> = [];
    for (const row of boundRows) {
      if (kvListing.clients.has(row.client_id)) continue;
      if (kvListing.truncated) {
        const info = await env.OAUTH_PROVIDER.lookupClient(row.client_id);
        if (info) continue;
      }
      ghosts.push(row);
    }

    if (dryRun) {
      return {
        ok: true,
        mode,
        dryRun: true,
        matched: ghosts.length,
        deleted: 0,
        grantsPurged: 0,
        tokensPurged: 0,
      };
    }

    let deleted = 0;
    for (const ghost of ghosts) {
      const res = await env.META.prepare("delete from oauth_clients where client_id = ?")
        .bind(ghost.client_id)
        .run();
      if ((res.meta?.changes ?? 0) > 0) {
        deleted++;
        recordAudit(env, waitUntil, {
          kind: "oauth_client_deleted",
          principal_kind: "operator",
          client_id: ghost.client_id,
          agent_id: ghost.agent_id,
        });
      }
    }
    return {
      ok: true,
      mode,
      dryRun: false,
      matched: ghosts.length,
      deleted,
      grantsPurged: 0,
      tokensPurged: 0,
    };
  }

  // mode === "unbound"
  const olderThanDays = opts.olderThanDays ?? DEFAULT_UNBOUND_PRUNE_DAYS;
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    return {
      ok: false,
      code: "bad_request",
      message: `'older_than_days' for mode "unbound" must be an integer >= 0`,
    };
  }

  const [boundRowsRes, kvListing] = await Promise.all([
    env.META.prepare("select client_id from oauth_clients").all<{ client_id: string }>(),
    listAllKvClients(env),
  ]);
  const boundIds = new Set((boundRowsRes.results ?? []).map((r) => r.client_id));
  const cutoffSec = Math.floor(nowMs / 1000) - olderThanDays * 86_400;

  const candidates: ClientInfo[] = [];
  for (const client of kvListing.clients.values()) {
    if (boundIds.has(client.clientId)) continue;
    const regSec = client.registrationDate;
    if (olderThanDays === 0) {
      candidates.push(client);
    } else if (typeof regSec === "number" && Number.isFinite(regSec) && regSec <= cutoffSec) {
      candidates.push(client);
    }
  }

  if (dryRun) {
    return {
      ok: true,
      mode,
      dryRun: true,
      matched: candidates.length,
      deleted: 0,
      grantsPurged: 0,
      tokensPurged: 0,
    };
  }

  let deleted = 0;
  for (const client of candidates) {
    await env.OAUTH_PROVIDER.deleteClient(client.clientId);
    deleted++;
    recordAudit(env, waitUntil, {
      kind: "oauth_client_deleted",
      principal_kind: "operator",
      client_id: client.clientId,
    });
  }

  let grantsPurged = 0;
  let tokensPurged = 0;
  if (typeof env.OAUTH_PROVIDER.purgeExpiredData === "function") {
    try {
      const purged = await env.OAUTH_PROVIDER.purgeExpiredData();
      grantsPurged = purged.grantsPurged;
      tokensPurged = purged.tokensPurged;
    } catch {
      // Best-effort KV sweep; client deletions above already succeeded.
    }
  }

  return {
    ok: true,
    mode,
    dryRun: false,
    matched: candidates.length,
    deleted,
    grantsPurged,
    tokensPurged,
  };
}

/**
 * POST /admin/oauth-clients/prune  { "mode": "unbound" | "expired_ghosts",
 *                                    "dry_run"?: boolean, "older_than_days"?: number }
 *   →  200 { mode, dry_run, matched, deleted, grants_purged, tokens_purged }
 */
export async function pruneOAuthClients(
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const b = body as { mode?: unknown; dry_run?: unknown; older_than_days?: unknown };
  if (b?.mode !== "unbound" && b?.mode !== "expired_ghosts") {
    return jsonError(
      400,
      "bad_request",
      `missing or invalid 'mode' ("unbound" | "expired_ghosts")`,
    );
  }
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") {
    return jsonError(400, "bad_request", "'dry_run' must be a boolean when present");
  }
  if (
    b.older_than_days !== undefined &&
    (typeof b.older_than_days !== "number" || !Number.isInteger(b.older_than_days))
  ) {
    return jsonError(400, "bad_request", "'older_than_days' must be an integer when present");
  }

  const result = await pruneOAuthClientsCore(
    env,
    b.mode,
    { dryRun: b.dry_run === true, olderThanDays: b.older_than_days as number | undefined },
    Date.now(),
    waitUntil,
  );
  if (!result.ok) {
    return jsonError(400, "bad_request", result.message);
  }
  return Response.json({
    mode: result.mode,
    dry_run: result.dryRun,
    matched: result.matched,
    deleted: result.deleted,
    grants_purged: result.grantsPurged,
    tokens_purged: result.tokensPurged,
  });
}
