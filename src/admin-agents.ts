// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-only agent + credential endpoints (issue #72 phase 4: moved
 * verbatim out of the former src/admin.ts; the OAuth-client twins stay in
 * src/admin-oauth.ts). Every handler awaits the shared `requireOperator`
 * (src/session.ts) and 401s/403s on failure before doing any other work, so
 * unauthenticated probes can't even fingerprint the UUID validation paths.
 * That guard accepts EITHER a Bearer token (curl/scripts) OR a browser session
 * cookie; cookie-authed mutating requests additionally need an `X-CSRF-Token`
 * header.
 *
 *   GET    /admin/agents                       list agents
 *   POST   /admin/agents                       mint agent + initial key
 *   GET    /admin/agents/:agent_id/keys        list keys for an agent
 *   POST   /admin/agents/:agent_id/keys        mint an additional key for an agent
 *   DELETE /admin/agents/:agent_id             revoke an agent (cascades keys AND OAuth clients)
 *   DELETE /admin/keys/:key_id                 revoke a single key
 *   POST   /admin/keys/prune                   hard-delete expired/long-revoked agent_keys rows (issue #13)
 *
 * The `*Core` workers are shared with the no-JS operator console
 * (src/console.ts) — wire bytes unchanged, secrets surfaced once, never logged.
 * Minted keys are the deliberate disclosure surface; the ledger (0020) records
 * the act, never the value.
 */

import { jsonError } from "./admin-response.js";
import { recordAudit } from "./audit.js";
import { hmacSha256Hex, isKeyExpired } from "./auth.js";
import type { Env } from "./env.js";
import { newApiKey, newUuid, UUID_RE } from "./ids.js";
import { type ListParams, paginate, parseHttpListParams } from "./pagination.js";
import { requireOperator } from "./session.js";
import type { WaitUntil } from "./vector-io.js";


// Operator gating (Bearer token OR browser session cookie + CSRF) lives in the
// shared `requireOperator` from src/session.ts. Every handler awaits it first
// and 401s/403s before doing any other work, so unauthenticated probes can't
// even fingerprint the UUID validation paths.

// -- agents -------------------------------------------------------------------

export async function listAgents(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  const params = parseHttpListParams(new URL(req.url));
  if (!params.ok) {
    return jsonError(400, params.code, params.message);
  }
  return Response.json(await listAgentsCore(env, params));
}

/** One row of the agents-list rollup. */
export type AgentListRow = {
  id: string;
  name: string;
  created_at: string;
  active_keys: number;
  total_keys: number;
  live_docs: number;
};

/**
 * The cursor-paginated agents list with the per-agent key/doc rollups. Lifted
 * out of `listAgents` so a browser console page can render the same data without
 * re-deriving the SQL. `params` is the validated success shape of
 * parseHttpListParams (the JSON handler parses + 400s on bad params, then calls
 * here). `active_keys` mirrors the `isKeyExpired` rule (revoked_at is null AND
 * not-expired) — keep it in lockstep with listAgentKeysCore's `expired` flag.
 */
export async function listAgentsCore(
  env: Env,
  params: ListParams,
): Promise<{ agents: AgentListRow[]; next_cursor: string | null }> {
  // (created_at DESC, id DESC) — id is the cursor tiebreaker; see document-query.ts
  // listDocumentsCore for the rationale.
  const peek = params.limit + 1;
  const stmt = params.cursor
    ? env.META
        .prepare(
          `select a.id, a.name, a.created_at,
             (select count(*) from agent_keys k
                where k.agent_id = a.id and k.revoked_at is null
                  and (k.expires_at is null
                       or k.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) as active_keys,
             (select count(*) from agent_keys k
                where k.agent_id = a.id) as total_keys,
             (select count(*) from documents d
                where d.created_by = a.id and d.revoked_at is null) as live_docs
           from agents a
           where a.created_at < ? or (a.created_at = ? and a.id < ?)
           order by a.created_at desc, a.id desc
           limit ?`,
        )
        .bind(params.cursor.ts, params.cursor.ts, params.cursor.id, peek)
    : env.META
        .prepare(
          `select a.id, a.name, a.created_at,
             (select count(*) from agent_keys k
                where k.agent_id = a.id and k.revoked_at is null
                  and (k.expires_at is null
                       or k.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) as active_keys,
             (select count(*) from agent_keys k
                where k.agent_id = a.id) as total_keys,
             (select count(*) from documents d
                where d.created_by = a.id and d.revoked_at is null) as live_docs
           from agents a
           order by a.created_at desc, a.id desc
           limit ?`,
        )
        .bind(peek);

  const result = await stmt.all<AgentListRow>();
  const { items: agents, next_cursor } = paginate(
    result.results ?? [],
    params.limit,
    (r) => r,
    (r) => ({ ts: r.created_at, id: r.id }),
  );
  return { agents, next_cursor };
}

/**
 * POST /admin/agents  { "name": "<label>" }  →  201 { agent_id, key_id, key, ... }
 *
 * Mints an agent and its initial API key in one D1 transaction. The
 * plaintext key is returned exactly once.
 */
export async function mintAgent(req: Request, env: Env, waitUntil?: WaitUntil): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  // Pepper check BEFORE body parse — preserves the original handler's
  // misconfigured-501-vs-bad_json ordering byte-for-byte (mintAgentCore re-checks
  // defensively for non-HTTP callers).
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

  const result = await mintAgentCore(env, name, waitUntil);
  if (!result.ok) {
    return jsonError(500, "misconfigured", "HMAC_PEPPER not set");
  }

  return Response.json(
    {
      agent_id: result.agentId,
      key_id: result.keyId,
      key: result.key,
      note: "store this key now — the secret half is never returned again",
    },
    { status: 201 },
  );
}

/**
 * Mint an agent + its initial key in one D1 transaction; returns the plaintext
 * key once. The caller validates `name` (1–200 chars) — core assumes it's already
 * good. `code:"misconfigured"` mirrors the `HMAC_PEPPER not set` 500 the JSON
 * handler returns (the secret HMAC pepper is required to derive the key hash).
 * Lifted from `mintAgent` so a browser console form mints through the same path.
 */
export async function mintAgentCore(
  env: Env,
  name: string,
  waitUntil?: WaitUntil,
): Promise<{ ok: true; agentId: string; keyId: string; key: string } | { ok: false; code: "misconfigured" }> {
  if (!env.HMAC_PEPPER) return { ok: false, code: "misconfigured" };

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

  // Ledger (0020): the key ID and the agent, never the key. Recorded after the
  // batch commits — an event describing a write that did not happen is a lie
  // the ledger can never correct.
  recordAudit(env, waitUntil, {
    kind: "agent_key_minted",
    principal_kind: "operator",
    agent_id: agentId,
    key_id: keyId,
  });

  return { ok: true, agentId, keyId, key: key.plaintext };
}

// -- keys ---------------------------------------------------------------------

export async function listAgentKeys(
  agentId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  if (!UUID_RE.test(agentId)) return jsonError(404, "not_found", "no such agent");
  const params = parseHttpListParams(new URL(req.url));
  if (!params.ok) {
    return jsonError(400, params.code, params.message);
  }

  const result = await listAgentKeysCore(env, agentId, params);
  if (!result.ok) return jsonError(404, "not_found", "no such agent");

  return Response.json({
    agent_id: agentId,
    name: result.name,
    keys: result.keys,
    next_cursor: result.next_cursor,
  });
}

/** One row of the per-agent key list, with the computed `expired` flag. */
export type AgentKeyListRow = {
  id: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
  expired: boolean;
};

/**
 * The cursor-paginated key list for one agent, plus the agent's name (so a
 * console page can title the table without a second query). `not_found` covers
 * both a malformed agent id (the JSON handler pre-checks UUID_RE, but a console
 * caller may not) and an unknown agent. The caller validates list `params` and
 * 400s on bad ones, then calls here. `expired` is computed against the same
 * `isKeyExpired` rule authenticateAgent uses (auth.ts), so the list agrees with
 * what actually authenticates — keep it in lockstep with listAgentsCore's
 * `active_keys` SQL rollup (revoked_at is null AND not-expired).
 */
export async function listAgentKeysCore(
  env: Env,
  agentId: string,
  params: ListParams,
): Promise<
  | { ok: true; name: string; keys: AgentKeyListRow[]; next_cursor: string | null }
  | { ok: false; code: "not_found" }
> {
  if (!UUID_RE.test(agentId)) return { ok: false, code: "not_found" };

  const agent = await env.META.prepare("select id, name from agents where id = ?")
    .bind(agentId)
    .first<{ id: string; name: string }>();
  if (!agent) return { ok: false, code: "not_found" };

  type Row = {
    id: string;
    key_prefix: string;
    created_at: string;
    revoked_at: string | null;
    expires_at: string | null;
  };
  const peek = params.limit + 1;
  const stmt = params.cursor
    ? env.META
        .prepare(
          `select id, key_prefix, created_at, revoked_at, expires_at
           from agent_keys
           where agent_id = ?
             and (created_at < ? or (created_at = ? and id < ?))
           order by created_at desc, id desc
           limit ?`,
        )
        .bind(agentId, params.cursor.ts, params.cursor.ts, params.cursor.id, peek)
    : env.META
        .prepare(
          `select id, key_prefix, created_at, revoked_at, expires_at
           from agent_keys
           where agent_id = ?
           order by created_at desc, id desc
           limit ?`,
        )
        .bind(agentId, peek);

  const result = await stmt.all<Row>();
  const now = Date.now();
  const { items: keys, next_cursor } = paginate(
    result.results ?? [],
    params.limit,
    (r) => ({
      id: r.id,
      key_prefix: r.key_prefix,
      created_at: r.created_at,
      revoked_at: r.revoked_at,
      expires_at: r.expires_at,
      expired: isKeyExpired(r.expires_at, now),
    }),
    (r) => ({ ts: r.created_at, id: r.id }),
  );
  return { ok: true, name: agent.name, keys, next_cursor };
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
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const result = await mintAgentKeyCore(env, agentId, waitUntil);
  if (!result.ok) {
    if (result.code === "misconfigured") {
      return jsonError(500, "misconfigured", "HMAC_PEPPER not set");
    }
    return jsonError(404, "not_found", "no such agent");
  }

  return Response.json(
    {
      agent_id: agentId,
      key_id: result.keyId,
      key: result.key,
      note: "store this key now — the secret half is never returned again",
    },
    { status: 201 },
  );
}

/**
 * Add a key to an existing agent (rotation, or scoping multiple workers to one
 * logical agent); returns the plaintext once. Self-contained id + pepper +
 * existence validation so a console form can mint without re-deriving the checks.
 * The code order — `not_found` (bad id) then `misconfigured` (no pepper) then
 * `not_found` (unknown agent) — matches the JSON handler's original 404/500/404
 * sequence so its wire is unchanged.
 */
export async function mintAgentKeyCore(
  env: Env,
  agentId: string,
  waitUntil?: WaitUntil,
): Promise<
  { ok: true; keyId: string; key: string } | { ok: false; code: "not_found" | "misconfigured" }
> {
  if (!UUID_RE.test(agentId)) return { ok: false, code: "not_found" };
  if (!env.HMAC_PEPPER) return { ok: false, code: "misconfigured" };

  const agent = await env.META.prepare("select id from agents where id = ?")
    .bind(agentId)
    .first<{ id: string }>();
  if (!agent) return { ok: false, code: "not_found" };

  const keyId = newUuid();
  const key = newApiKey();
  const keyHash = await hmacSha256Hex(key.secret, env.HMAC_PEPPER);

  await env.META.prepare(
    "insert into agent_keys (id, agent_id, key_prefix, key_hash) values (?, ?, ?, ?)",
  )
    .bind(keyId, agentId, key.prefix, keyHash)
    .run();

  recordAudit(env, waitUntil, {
    kind: "agent_key_minted",
    principal_kind: "operator",
    agent_id: agentId,
    key_id: keyId,
  });

  return { ok: true, keyId, key: key.plaintext };
}

/**
 * DELETE /admin/agents/:agent_id  →  200 { revoked, agent_id, keys_revoked, oauth_clients_deleted }
 *
 * The unified agent kill switch. Closes BOTH auth doors in one call:
 *   - Bearer (Door B): marks every agent_keys row revoked. The next
 *     authenticateAgent call returns null → 401.
 *   - OAuth (Door A): deletes every OAuth client for the agent via
 *     OAUTH_PROVIDER.deleteClient, which cascades to grants and live
 *     tokens in OAUTH_KV — the next /mcp request bearing one of those
 *     tokens 401s.
 *
 * Order: D1 first (bias toward more-revoked if KV calls partial-fail).
 * If a deleteClient call throws, we return 500 with what was done so
 * the operator can retry — the agent_keys are already revoked at that
 * point.
 *
 * Use per-key revoke (DELETE /admin/keys/:id) for rotation, which keeps
 * the agent alive. This endpoint is for "this agent is compromised or
 * decommissioned, kill everything."
 */
export async function revokeAgent(
  agentId: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  if (!UUID_RE.test(agentId)) return jsonError(404, "not_found", "no such agent");

  const result = await revokeAgentCore(env, agentId, waitUntil);
  if (!result.ok) {
    if (result.code === "partial") {
      // A deleteClient call threw mid-cascade. The agent_keys are already
      // revoked (the bearer door is shut); some OAuth clients may survive.
      // Re-throw so this surfaces as the generic 500 the original handler
      // produced — keeping the wire byte-identical (the structured partial
      // body is the core's typed return for non-HTTP callers, not a new HTTP
      // error code). Re-running the revoke is idempotent (already-revoked keys
      // are a no-op, already-deleted clients 404 harmlessly).
      throw new Error("agent revoke partially failed during OAuth client teardown");
    }
    return jsonError(404, "not_found", "no such agent");
  }

  return Response.json({
    revoked: true,
    agent_id: agentId,
    keys_revoked: result.keysRevoked,
    oauth_clients_deleted: result.oauthClientsDeleted,
  });
}

/**
 * The unified agent kill switch (revoke every key AND delete every OAuth client).
 * Lifted from `revokeAgent` so a console "kill agent" form runs the identical
 * cascade. The caller pre-validates the id format (the JSON handler's leading
 * UUID_RE 404); core re-checks existence.
 *
 * Order: D1 first (bias toward more-revoked if the KV calls partial-fail), then
 * KV deleteClient per pinned client, then drop the join rows. If a deleteClient
 * throws mid-loop we stop and return `partial` with the counts done so far — the
 * keys are already revoked, so the bearer door is shut even on a partial KV
 * failure; the operator retries to finish the OAuth teardown.
 */
export async function revokeAgentCore(
  env: Env,
  agentId: string,
  waitUntil?: WaitUntil,
): Promise<
  | { ok: true; keysRevoked: number; oauthClientsDeleted: number }
  | { ok: false; code: "not_found" }
  | {
      ok: false;
      code: "partial";
      keysRevoked: number;
      oauthClientsDeleted: number;
      message: string;
    }
> {
  const agent = await env.META.prepare("select id from agents where id = ?")
    .bind(agentId)
    .first<{ id: string }>();
  if (!agent) return { ok: false, code: "not_found" };

  // D1 first: kill the bearer door.
  const keysResult = await env.META.prepare(
    `update agent_keys
     set revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where agent_id = ? and revoked_at is null`,
  )
    .bind(agentId)
    .run();
  const keysRevoked = keysResult.meta?.changes ?? 0;

  // Then KV: kill the OAuth door for every client pinned to this agent.
  const clients = await env.META.prepare(
    "select client_id from oauth_clients where agent_id = ?",
  )
    .bind(agentId)
    .all<{ client_id: string }>();
  const clientIds = (clients.results ?? []).map((c) => c.client_id);
  let oauthClientsDeleted = 0;
  for (const clientId of clientIds) {
    try {
      await env.OAUTH_PROVIDER.deleteClient(clientId);
    } catch {
      // KV cascade hiccupped — return what's done so the operator can retry.
      // Never include the error object (it could carry a token); a code-only
      // message keeps the secret-disclosure discipline.
      return {
        ok: false,
        code: "partial",
        keysRevoked,
        oauthClientsDeleted,
        message: "agent keys revoked, but an OAuth client deletion failed — retry to finish",
      };
    }
    oauthClientsDeleted++;
  }
  if (clientIds.length > 0) {
    await env.META.prepare("delete from oauth_clients where agent_id = ?")
      .bind(agentId)
      .run();
  }

  // Only the fully-successful cascade files a row. The `partial` return above
  // exits early and deliberately records nothing: it means "the bearer door is
  // shut but OAuth teardown is unfinished", and the retry that completes it is
  // what belongs in the ledger as the revoke.
  recordAudit(env, waitUntil, {
    kind: "agent_revoked",
    principal_kind: "operator",
    agent_id: agentId,
    credentials_revoked: keysRevoked,
    oauth_clients_deleted: oauthClientsDeleted,
  });

  return { ok: true, keysRevoked, oauthClientsDeleted };
}

/**
 * DELETE /admin/keys/:key_id   →  200 { revoked, key_id, agent_id, key_prefix }
 *
 * The rogue-key kill switch. Sets `revoked_at` to now; the `authenticateAgent`
 * lookup checks this column and treats revoked keys as no-auth.
 *
 * Idempotent-ish: a second DELETE on an already-revoked key returns 404,
 * matching how `DELETE /d/:public_id` handles its already-revoked case.
 *
 * Per-key — for rotation. For the unified "kill this agent everywhere"
 * cascade (revoke every key AND every OAuth client for the agent), use
 * DELETE /admin/agents/:id (revokeAgent above).
 */
export async function revokeKey(
  keyId: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const result = await revokeKeyCore(env, keyId, waitUntil);
  if (!result.ok) return jsonError(404, "not_found", "no such active key");

  return Response.json({
    revoked: true,
    key_id: keyId,
    agent_id: result.agentId,
    key_prefix: result.keyPrefix,
  });
}

/**
 * The single-key kill switch. Sets `revoked_at` to now; `authenticateAgent`
 * treats a revoked key as no-auth. Returns the owning agent + prefix so the
 * caller can render a confirmation. `not_found` covers a malformed id (the JSON
 * handler's leading UUID_RE 404), an unknown key, AND an already-revoked one
 * (idempotent-ish — a second revoke 404s, matching DELETE /d/:public_id).
 */
export async function revokeKeyCore(
  env: Env,
  keyId: string,
  waitUntil?: WaitUntil,
): Promise<{ ok: true; agentId: string; keyPrefix: string } | { ok: false; code: "not_found" }> {
  if (!UUID_RE.test(keyId)) return { ok: false, code: "not_found" };

  const row = await env.META.prepare(
    "select id, agent_id, key_prefix, revoked_at from agent_keys where id = ?",
  )
    .bind(keyId)
    .first<{ id: string; agent_id: string; key_prefix: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) {
    return { ok: false, code: "not_found" };
  }

  await env.META.prepare(
    "update agent_keys set revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = ?",
  )
    .bind(keyId)
    .run();

  recordAudit(env, waitUntil, {
    kind: "agent_key_revoked",
    principal_kind: "operator",
    agent_id: row.agent_id,
    key_id: keyId,
  });

  return { ok: true, agentId: row.agent_id, keyPrefix: row.key_prefix };
}

/**
 * POST /admin/keys/prune  { "mode": "expired" | "revoked", "dry_run"?: boolean,
 *                            "older_than_days"?: number }
 *   →  200 { mode, dry_run, matched, deleted }
 *
 * Hard-deletes inert `agent_keys` rows (issue #13). Neither class is ever
 * matched by `authenticateAgent` (`isKeyExpired` / the `revoked_at` check in
 * src/auth.ts rejects both), so a prune changes nothing about who can
 * authenticate — this is housekeeping against unbounded growth, not a
 * correctness fix. No FK references `agent_keys` (checked against every
 * migration), so a hard delete leaves nothing dangling.
 *
 * The two classes carry different audit value, so they get different rules —
 * "expired" and "revoked" are never pruned by one shared clause:
 *
 *   - "expired": `expires_at` is non-NULL (machine-minted by
 *     `create_publish_credential`, ≤60 min TTL) and in the past. Deleted the
 *     moment it lapses — self-revoking, fungible, near-zero audit value. NO
 *     age gate: `older_than_days` is rejected for this mode rather than
 *     silently ignored, so a caller who thinks they're adding a grace window
 *     finds out immediately that expired keys don't have one.
 *   - "revoked": `revoked_at` is non-NULL (a deliberate operator security
 *     action — the revoke handlers keep the row on purpose) AND older than
 *     `older_than_days`. That field is REQUIRED here (minimum 1) — there is
 *     no sane default for "how long does a revoke stay explainable in an
 *     audit trail," so the caller must say.
 *
 * `dry_run: true` runs the read-only count and returns `deleted: 0`,
 * `matched` = what a real call would delete. A real call issues exactly one
 * `DELETE … WHERE …` and reports `changes()` as BOTH `matched` and `deleted`
 * (one statement, so they can never disagree).
 */
export type PruneKeysMode = "expired" | "revoked";

export type PruneKeysResult =
  | { ok: true; mode: PruneKeysMode; dryRun: boolean; matched: number; deleted: number }
  | { ok: false; code: "bad_request"; message: string };

export async function pruneAgentKeysCore(
  env: Env,
  mode: PruneKeysMode,
  opts: { dryRun?: boolean; olderThanDays?: number } = {},
  nowMs: number = Date.now(),
  waitUntil?: WaitUntil,
): Promise<PruneKeysResult> {
  const dryRun = opts.dryRun ?? false;

  if (mode === "expired") {
    if (opts.olderThanDays !== undefined) {
      return {
        ok: false,
        code: "bad_request",
        message:
          `'older_than_days' is not accepted for mode "expired" — an expired ephemeral key ` +
          `is eligible for prune the moment it lapses, with no age gate`,
      };
    }
    const cutoff = new Date(nowMs).toISOString();
    if (dryRun) {
      const row = await env.META.prepare(
        "select count(*) as n from agent_keys where expires_at is not null and expires_at < ?",
      )
        .bind(cutoff)
        .first<{ n: number }>();
      return { ok: true, mode, dryRun: true, matched: row?.n ?? 0, deleted: 0 };
    }
    const result = await env.META.prepare(
      "delete from agent_keys where expires_at is not null and expires_at < ?",
    )
      .bind(cutoff)
      .run();
    const n = result.meta?.changes ?? 0;
    recordPrune(env, waitUntil, mode, n);
    return { ok: true, mode, dryRun: false, matched: n, deleted: n };
  }

  // mode === "revoked" — older_than_days is REQUIRED (a deliberate security
  // action's row is audit trail; it is never pruned on the same eager clause
  // as a self-revoking ephemeral key).
  if (
    opts.olderThanDays === undefined ||
    !Number.isInteger(opts.olderThanDays) ||
    opts.olderThanDays < 1
  ) {
    return {
      ok: false,
      code: "bad_request",
      message: `mode "revoked" requires 'older_than_days' as an integer >= 1`,
    };
  }
  const cutoff = new Date(nowMs - opts.olderThanDays * 86_400_000).toISOString();
  if (dryRun) {
    const row = await env.META.prepare(
      "select count(*) as n from agent_keys where revoked_at is not null and revoked_at < ?",
    )
      .bind(cutoff)
      .first<{ n: number }>();
    return { ok: true, mode, dryRun: true, matched: row?.n ?? 0, deleted: 0 };
  }
  const result = await env.META.prepare(
    "delete from agent_keys where revoked_at is not null and revoked_at < ?",
  )
    .bind(cutoff)
    .run();
  const n = result.meta?.changes ?? 0;
  recordPrune(env, waitUntil, mode, n);
  return { ok: true, mode, dryRun: false, matched: n, deleted: n };
}

/**
 * File a prune in the ledger (0020) — real runs only. A dry run reads and
 * deletes nothing, so recording it would put a row in the audit trail for an
 * act that never happened, which is precisely the confusion an audit trail
 * exists to prevent.
 */
function recordPrune(
  env: Env,
  waitUntil: WaitUntil | undefined,
  mode: PruneKeysMode,
  deleted: number,
): void {
  recordAudit(env, waitUntil, {
    kind: "agent_keys_pruned",
    principal_kind: "operator",
    mode,
    deleted,
  });
}

export async function pruneKeys(req: Request, env: Env, waitUntil?: WaitUntil): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const b = body as { mode?: unknown; dry_run?: unknown; older_than_days?: unknown };
  if (b?.mode !== "expired" && b?.mode !== "revoked") {
    return jsonError(400, "bad_request", `missing or invalid 'mode' ("expired" | "revoked")`);
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

  const result = await pruneAgentKeysCore(
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
  });
}
