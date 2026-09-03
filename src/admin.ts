// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-only admin endpoints. All gated by `OPERATOR_TOKEN` — for v1
 * we use a single shared secret (no Google OAuth yet); each handler
 * awaits the shared `requireOperator` (src/session.ts) and 401s/403s on
 * failure before doing any other work, so unauthenticated probes can't even
 * fingerprint the UUID validation paths. That guard accepts EITHER a Bearer
 * token (curl/scripts) OR a browser session cookie; cookie-authed mutating
 * requests additionally need an `X-CSRF-Token` header.
 *
 *   GET    /admin/agents                       list agents
 *   POST   /admin/agents                       mint agent + initial key
 *   GET    /admin/agents/:agent_id/keys        list keys for an agent
 *   POST   /admin/agents/:agent_id/keys        mint an additional key for an agent
 *   DELETE /admin/keys/:key_id                 revoke a single key
 *   POST   /admin/keys/prune                   hard-delete expired/long-revoked agent_keys rows (issue #13)
 *   GET    /admin/documents                    list documents (incl. revoked)
 *   POST   /admin/documents                    operator authors a new document (JSON body)
 *   GET    /admin/documents/search             full-text search over live documents
 *   GET    /admin/documents/:public_id         one listing row, BARE (incl. revoked) — the list's detail twin
 *   PUT    /admin/documents/:public_id         operator updates a document (new version; optional If-Match)
 *   GET    /admin/documents/:public_id/versions    version history (JSON twin of the manage-page table)
 *   POST   /admin/documents/:public_id/restore     restore version n as a NEW version (JSON twin of the manage-page form)
 *   POST   /admin/documents/:public_id/visibility  set a live doc public/private
 *   POST   /admin/documents/:public_id/promote     publish version n (what a PUBLIC doc renders)
 *   POST   /admin/documents/:public_id/slug        add/rename/clear a live doc's slug (rename auto-forwards)
 *   POST   /admin/documents/:public_id/tags        replace a live doc's tags (no version bump)
 *   POST   /admin/documents/:public_id/status      set a live doc's lifecycle status (active|deprecated; no version bump)
 *   POST   /admin/slugs/:slug/redirect         point a retired slug at a live doc
 *   DELETE /admin/slugs/:slug/redirect         drop a retired slug's redirect (back to 410)
 *   DELETE /admin/slugs/:slug                  force-release a retired slug (escape hatch)
 *   POST   /admin/links/backfill               backfill the link graph from stored renders (issue #40)
 *   GET    /admin/links/orphans                live docs nothing links to (link-graph curation view)
 *
 * Revoking a *document* lives on the public route (`DELETE /d/:public_id`)
 * since it shares the path with the resource. That endpoint is also
 * operator-auth.
 *
 * FIVE handlers here are NOT operator-gated; four are twins that share an
 * `*Impl` body with an `/admin/*` handler above, and `GET /d/pack` is the HTTP
 * twin of an MCP tool — only the auth door differs
 * (`requireReader`: any active agent key OR the operator, never anonymous):
 *
 *   GET  /d                        listDocumentsForReader     (→ GET /admin/documents)
 *   GET  /d/search                 searchDocumentsForReader   (→ GET /admin/documents/search)
 *   GET  /d/pack                   loadContextPackForReader   (MCP load_context_pack's HTTP twin)
 *   PUT  /d/:public_id/tags        curateDocumentTags         (→ POST /admin/documents/:id/tags)
 *   PUT  /d/:public_id/status      curateDocumentStatus       (→ POST /admin/documents/:id/status)
 *
 * The last two are WRITES on the agent door — see `curateDocumentStatus` for
 * why tags and lifecycle status belong there while `visibility`, revoke and
 * promotion emphatically do not. They also have MCP tools now
 * (`set_document_tags` / `set_document_status`), over the same cores.
 */

import type { Visibility } from "./access.js";
import { computeExpiresAt, hmacSha256Hex, isKeyExpired } from "./auth.js";
import { parseIfMatch } from "./conditional.js";
import {
  type BackfillMode,
  backfillVectorsCore,
  clearSlugRedirectCore,
  type DocumentMetadataInput,
  listDocumentsCore,
  listVersionsCore,
  promoteVersionCore,
  publishDocumentCore,
  releaseSlugTombstoneCore,
  restoreVersionCore,
  type SearchMode,
  searchDocumentsCore,
  setDocumentSlugCore,
  setDocumentStatusCore,
  setDocumentTagsCore,
  setDocumentVisibilityCore,
  setSlugRedirectCore,
  type SourceFormat,
  updateDocumentCore,
} from "./core.js";
import type { Env } from "./env.js";
import { newApiKey, newUuid, UUID_RE } from "./ids.js";
import { backfillLinksCore, listOrphanDocumentsCore } from "./links-core.js";
import { formatSlugReject, validateSlugInput } from "./metadata.js";
import { clampPackKnobs } from "./pack.js";
import { findDocumentByPublicIdCore, loadContextPackCore, packSearchHitsCore } from "./pack-core.js";
import { type ListParams, paginate, parseHttpListParams } from "./pagination.js";
import { idShapeHint, requireReader, SERVICE_DESC_LINK } from "./serve.js";
import { seedPlatformDocsCore } from "./seed-docs.js";
import { requireOperator } from "./session.js";
import { toWriteResponse } from "./wire.js";

/**
 * The admin/reader JSON error envelope. Carries the `service-desc` Link header
 * (SERVICE_DESC_LINK in serve.ts) like every other JSON error surface, so a
 * caller that only ever sees a failure still learns where `/openapi.json` is.
 */
function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: code, message, ...extra },
    { status, headers: { link: SERVICE_DESC_LINK } },
  );
}

/**
 * The `404 not_found` every document-addressed handler in this file returns.
 *
 * The message carries the one hint a wrong-shaped id can safely give (see
 * `idShapeHint` in serve.ts): a SLUG in the `:public_id` slot is by far the
 * commonest way to land here — every document in the corpus is named by its
 * slug in links and prose — and `GET /d?slug=…` is the conversion. Purely
 * syntactic, derived from the caller's own path segment and never from anything
 * we looked up, so it is exactly as opaque as the bare "no such document" it
 * replaced.
 */
function documentNotFound(publicId: string): Response {
  // No slug-addressed twin exists for any /admin/documents/:id route, so the
  // resolver is the only alternative worth naming.
  return jsonError(404, "not_found", idShapeHint(publicId, () => null));
}

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
  // (created_at DESC, id DESC) — id is the cursor tiebreaker; see core.ts
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
export async function mintAgent(req: Request, env: Env): Promise<Response> {
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

  const result = await mintAgentCore(env, name);
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
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const result = await mintAgentKeyCore(env, agentId);
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
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  if (!UUID_RE.test(agentId)) return jsonError(404, "not_found", "no such agent");

  const result = await revokeAgentCore(env, agentId);
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
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const result = await revokeKeyCore(env, keyId);
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
  return { ok: true, mode, dryRun: false, matched: n, deleted: n };
}

export async function pruneKeys(req: Request, env: Env): Promise<Response> {
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

  const result = await pruneAgentKeysCore(env, b.mode, {
    dryRun: b.dry_run === true,
    olderThanDays: b.older_than_days as number | undefined,
  });
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

/**
 * POST /admin/slugs/:slug/redirect — operator-only. Point a RETIRED slug
 * (migration 0009 tombstone) at a live target document, so `/s/:slug` forwards
 * loudly instead of 410ing (migration 0010). The deliberate "this name moved"
 * case: a branding rename or consolidating two docs, WITHOUT reusing the name.
 *
 * Body: `{ "target_public_id": "<22-char id>" }`. The target must be a live
 * document. Returns the resolved target (public_id + its current slug/title).
 *
 * 404 if the slug isn't retired (a live slug serves its own doc — revoke or
 * rename it first; a never-claimed slug has no tombstone). 422 if the target
 * is missing/revoked/malformed.
 */
export async function setSlugRedirect(
  slug: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  const v = validateSlugInput(slug);
  if (!v.ok) return jsonError(404, "not_found", "no such retired slug");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const target = (body as { target_public_id?: unknown })?.target_public_id;
  if (typeof target !== "string" || target.length === 0) {
    return jsonError(400, "bad_request", "missing or invalid 'target_public_id' (string)");
  }

  const result = await setSlugRedirectCore(env, v.slug, target);
  if (!result.ok) {
    if (result.code === "tombstone_not_found") {
      return jsonError(404, "not_found", `slug "${v.slug}" is not retired — nothing to redirect`);
    }
    return jsonError(
      422,
      "bad_target",
      `target "${result.target}" is not a live document (unknown, revoked, or malformed public_id)`,
      { target: result.target },
    );
  }
  return Response.json({
    slug: v.slug,
    redirect_to: result.target.public_id,
    target_slug: result.target.slug,
    target_title: result.target.title,
  });
}

/**
 * DELETE /admin/slugs/:slug/redirect — operator-only. Drop a retired slug's
 * redirect, reverting it to a plain 410-Gone tombstone. The slug stays retired
 * (still not reusable); only the forwarding target is removed.
 */
export async function clearSlugRedirect(
  slug: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  const v = validateSlugInput(slug);
  if (!v.ok) return jsonError(404, "not_found", "no such retired slug");

  const result = await clearSlugRedirectCore(env, v.slug);
  if (!result.ok) return jsonError(404, "not_found", `slug "${v.slug}" is not retired`);
  return Response.json({ slug: v.slug, redirect_to: null });
}

/**
 * DELETE /admin/slugs/:slug — operator-only ESCAPE HATCH. Force-release a
 * retired slug by deleting its tombstone entirely, returning the name to the
 * pool so a future publish can claim it again. For the genuine "I revoked by
 * mistake" / "I really do want to repurpose this name" case — the only path
 * that un-retires a slug. Distinct from clearing the redirect (which keeps the
 * slug retired); this removes the reservation outright.
 */
export async function releaseSlugTombstone(
  slug: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  const v = validateSlugInput(slug);
  if (!v.ok) return jsonError(404, "not_found", "no such retired slug");

  const result = await releaseSlugTombstoneCore(env, v.slug);
  if (!result.ok) return jsonError(404, "not_found", `slug "${v.slug}" is not retired`);
  return Response.json({ released: true, slug: v.slug });
}

/**
 * POST /admin/docs/seed — operator-invoked platform-documentation seeding
 * (GitHub issue #4).
 *
 * The seed pass also runs automatically, latched to once per isolate, off the
 * `/mcp` path (src/seed-docs.ts). This route exists for the two cases that
 * latch cannot serve: making it happen NOW rather than on the next cold start,
 * and seeing the per-doc outcome — in particular a `blocked` line, which is how
 * a retired reserved slug surfaces (the seeder deliberately will not release a
 * tombstone on its own).
 *
 * Operator-gated even though it writes only build output: it is a write, and
 * the report names corpus state. Idempotent — a pass with nothing to do writes
 * nothing and reports every doc `unchanged`.
 */
export async function seedPlatformDocs(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const origin = new URL(req.url).origin;
  const results = await seedPlatformDocsCore(env, origin, ctx.waitUntil.bind(ctx));
  const failed = results.filter((r) => r.action === "failed" || r.action === "blocked");
  return Response.json({ seeded: results, ok: failed.length === 0 }, { status: failed.length ? 207 : 200 });
}

// -- ephemeral keys -----------------------------------------------------------

/** Default lifetime for an on-demand publish credential — matches the OAuth
 *  access-token TTL in src/oauth.ts (15 min). */
export const EPHEMERAL_KEY_DEFAULT_TTL_SECONDS = 900;
/** Hard ceiling so a runaway `ttl_seconds` can't mint a near-permanent key. */
export const EPHEMERAL_KEY_MAX_TTL_SECONDS = 3600;
/** Floor — a sub-minute key is useless and just churns the table. */
export const EPHEMERAL_KEY_MIN_TTL_SECONDS = 60;

export type MintEphemeralOk = { ok: true; keyId: string; key: string; expiresAt: string };
export type MintEphemeralErr = { ok: false; code: "misconfigured" };

/**
 * Mint a short-lived `awh_` key for an ALREADY-AUTHENTICATED agent, for the
 * byte-exact curl publish path. Reuses the normal key shape (prefix + HMAC
 * under the pepper) and the existing `POST /d` / `PUT /d/:id` auth — the only
 * difference from an operator-minted key is a non-NULL `expires_at`, which
 * `authenticateAgent` enforces.
 *
 * This is NOT an operator endpoint: it's called from the MCP
 * `create_publish_credential` tool with `props.agentId` resolved upstream
 * (Door A OAuth or Door B bearer). The minted key grants nothing beyond what
 * that MCP session already wields — it just repackages those powers into a
 * form `curl` can send — so a short TTL + revocability is the whole
 * containment story (no separate operator gate, no new scope; see
 * migration 0007 and docs/design/byte-exact-publish-design.md).
 *
 * `ttlSeconds` is clamped to [MIN, MAX]. The caller passes a validated value;
 * we clamp again here so the floor/ceiling can't be bypassed by a future
 * caller. Returns the plaintext exactly once — the secret half is never
 * recoverable after this, same one-shot contract as the admin mints.
 */
export async function mintEphemeralKey(
  env: Env,
  agentId: string,
  ttlSeconds: number,
): Promise<MintEphemeralOk | MintEphemeralErr> {
  if (!env.HMAC_PEPPER) return { ok: false, code: "misconfigured" };

  const ttl = Math.min(
    Math.max(Math.floor(ttlSeconds), EPHEMERAL_KEY_MIN_TTL_SECONDS),
    EPHEMERAL_KEY_MAX_TTL_SECONDS,
  );
  const expiresAt = computeExpiresAt(Date.now(), ttl);

  const keyId = newUuid();
  const key = newApiKey();
  const keyHash = await hmacSha256Hex(key.secret, env.HMAC_PEPPER);

  await env.META.prepare(
    "insert into agent_keys (id, agent_id, key_prefix, key_hash, expires_at) values (?, ?, ?, ?, ?)",
  )
    .bind(keyId, agentId, key.prefix, keyHash, expiresAt)
    .run();

  return { ok: true, keyId, key: key.plaintext, expiresAt };
}

// -- documents ----------------------------------------------------------------

/**
 * GET /admin/documents   →  { documents: [...], next_cursor }
 *
 * Cursor-paginated (see src/pagination.ts). Includes revoked documents
 * (with `revoked_at` set) so the operator can audit the history.
 * `current_size` is the size of the live version; null for revoked docs
 * (bytes were purged at revoke time).
 *
 * Thin wrapper: the actual SELECT lives in listDocumentsCore so the MCP
 * `list_documents` tool returns the same shape (single-tenant trust model;
 * see src/mcp.ts).
 */
export async function listDocuments(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  return listDocumentsImpl(req, env);
}

/**
 * GET /d   →  { documents: [...], next_cursor }
 *
 * The AGENT-reachable twin of `listDocuments` above: same shape, same core, but
 * gated by `requireReader` (agent key OR operator — never anonymous) instead of
 * `requireOperator`. This is the HTTP counterpart of the MCP `list_documents`
 * tool (which calls the identical `listDocumentsCore`), so a headless agent can
 * browse the fleet and resolve a slug → public_id (`GET /d?slug=…` returns the
 * 0-or-1 matching row) — closing the gap that left `update`/`/source`/`/links`
 * id-only with no slug lookup. Consistent with the single-tenant trust model:
 * any agent key already reads every doc's full content by id, so enumeration
 * discloses nothing new. Includes revoked docs (with `revoked_at` set), exactly
 * like the operator list and the MCP tool.
 */
export async function listDocumentsForReader(req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator token required");
  if (denied) return denied;
  return listDocumentsImpl(req, env);
}

/** Shared body of the operator + reader document-list handlers (auth already
 *  resolved by the caller). */
async function listDocumentsImpl(req: Request, env: Env): Promise<Response> {
  const params = parseHttpListParams(new URL(req.url));
  if (!params.ok) {
    return jsonError(400, params.code, params.message);
  }
  return Response.json(await listDocumentsCore(env, params));
}

/**
 * GET /admin/documents/search?q=…&tag=…&slug=…&limit=…
 *   →  { documents: [...hits] }
 *
 * Sibling to listDocuments, but ordered by BM25 relevance over the FTS5
 * index instead of by created_at. Each hit carries the same row shape as
 * listDocuments entries PLUS `score`, `matched_field`, and `snippet` —
 * see SearchHit in src/core.ts.
 *
 * Tag and slug filters compose with `q` so "search for X within tag Y"
 * is a single request. `cursor` is silently ignored — search has no
 * cursor (see searchDocumentsCore for the rationale); `limit` is capped
 * at MAX_LIMIT just like the list endpoints.
 *
 * Operator-gated. The MCP `search_documents` tool is the agent-facing
 * twin and shares the core function.
 *
 * Status codes:
 *   200  hits returned (possibly empty)
 *   400  bad limit / bad tag-or-slug filter
 *   401  bad/missing operator auth
 *   422  `q` is missing or tokenizes to empty (e.g. only punctuation)
 */
export async function searchDocuments(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  return searchDocumentsImpl(req, env);
}

/**
 * GET /d/search?q=…   →  { documents: [...hits] }  (or a PackResponse with
 * ?include_bodies=true)
 *
 * The AGENT-reachable twin of `searchDocuments` above — same shape, same core,
 * `requireReader`-gated (agent key OR operator). The HTTP counterpart of the MCP
 * `search_documents` tool (identical `searchDocumentsCore`), so a headless agent
 * gets content discovery + context packs without the operator token.
 */
export async function searchDocumentsForReader(req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator token required");
  if (denied) return denied;
  return searchDocumentsImpl(req, env);
}

/** Shared body of the operator + reader document-search handlers (auth already
 *  resolved by the caller). */
async function searchDocumentsImpl(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const params = parseHttpListParams(url);
  if (!params.ok) {
    return jsonError(400, params.code, params.message);
  }
  const mode = parseSearchMode(url.searchParams.get("mode"));
  if (mode === null) {
    return jsonError(400, "bad_request", "mode must be one of: hybrid, keyword, semantic");
  }
  const q = url.searchParams.get("q");
  if (q === null || q === "") {
    return jsonError(422, "bad_query", "missing required `q` parameter");
  }
  // The raw query goes to core: it tokenizes internally for the keyword leg and
  // embeds the un-tokenized query for the semantic leg. bad_query now surfaces
  // only when no leg can carry the search (see searchDocumentsCore).
  const result = await searchDocumentsCore(env, q, params, mode);
  if (!result.ok) {
    return jsonError(
      422,
      "bad_query",
      "no usable search terms (queries need at least one 2+ character word; " +
        "operators and punctuation are dropped)",
    );
  }

  // ?include_bodies=true — the AUTOMATIC context pack (context-packs-design
  // §3.1 / issue #21): amplify this search into a budgeted bulk read. The 200
  // shape switches from { documents } to the PackResponse envelope
  // { pack, documents (with content), omitted }. Knobs are CLAMPED, not
  // rejected (clampPackKnobs); deprecated hits are omitted-and-reported unless
  // ?include_deprecated=true.
  if (url.searchParams.get("include_bodies") === "true") {
    const knobs = clampPackKnobs({
      budget_bytes: intParam(url, "budget_bytes"),
      max_documents: intParam(url, "max_documents"),
    });
    const packed = await packSearchHitsCore(env, q, result.documents, {
      budgetBytes: knobs.budgetBytes,
      maxDocuments: knobs.maxDocuments,
      includeDeprecated: url.searchParams.get("include_deprecated") === "true",
    });
    return Response.json(packed);
  }

  return Response.json({ documents: result.documents });
}

/**
 * GET /d/pack?from=<slug-or-public_id>   →  200 PackResponse
 *
 * The DOCUMENT/MANIFEST-root context pack — the HTTP twin of the MCP
 * `load_context_pack` tool (identical `loadContextPackCore`), `requireReader`-
 * gated like `GET /d` and `GET /d/search`. `from` takes a slug or a 22-char
 * public_id (live-slug-first resolution, same tiebreak as the tool); knobs are
 * CLAMPED, not rejected (clampPackKnobs). Sits on the exact-path `/d/pack`
 * dispatch ahead of `/d/:public_id` ("pack" is never a 22-char public_id).
 *
 *   400  missing `from`
 *   401  no/invalid credential
 *   404  `from` matches no live document
 *   410  `from` is a retired slug (same `gone` contract as GET /s/:slug)
 */
export async function loadContextPackForReader(req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator token required");
  if (denied) return denied;
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  if (from === null || from === "") {
    return jsonError(
      400,
      "bad_request",
      "missing required `from` parameter (a live slug or a 22-char public_id)",
    );
  }
  const knobs = clampPackKnobs({
    budget_bytes: intParam(url, "budget_bytes"),
    max_documents: intParam(url, "max_documents"),
  });
  const result = await loadContextPackCore(
    env,
    from,
    {
      budgetBytes: knobs.budgetBytes,
      maxDocuments: knobs.maxDocuments,
      includeDeprecated: url.searchParams.get("include_deprecated") === "true",
      followRedirects: url.searchParams.get("follow_redirects") === "true",
    },
    // Same-host absolute links count as pack members; cross-site ones don't.
    url.host,
  );
  if (!result.ok) {
    if (result.code === "root_retired") {
      return jsonError(
        410,
        "gone",
        `the slug "${result.slug}" is retired: the document it pointed to was revoked, or ` +
          "the slug was renamed or released. Slugs are not reused, so this handle will not " +
          "resolve again. Find the current document via GET /d or GET /d/search.",
      );
    }
    return jsonError(
      404,
      "not_found",
      "no live document matches `from` (pass a live slug or a 22-char public_id)",
    );
  }
  const { ok: _ok, ...envelope } = result;
  return Response.json(envelope);
}

/** Parse an optional integer query param; undefined when absent/non-integer
 *  (clampPackKnobs then applies the default). */
function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/** Parse the optional `?mode=` search param. Absent → "hybrid"; an unrecognized
 *  value → null (the caller 400s). */
function parseSearchMode(raw: string | null): SearchMode | null {
  if (raw === null || raw === "") return "hybrid";
  if (raw === "hybrid" || raw === "keyword" || raw === "semantic") return raw;
  return null;
}

/**
 * POST /admin/vectors/backfill?mode=missing|rebuild&limit=N&cursor=…
 *   →  200 { ok, mode, scanned, embedded, vectors, skipped, next_cursor }
 *
 * Operator-invoked Vectorize backfill / reconciliation (docs/design/vector-search-design.md
 * §8), MANUAL in v1 (no cron). `mode` (default "missing") is the incremental
 * heal — embeds only docs whose `#0` chunk is absent; "rebuild" re-embeds every
 * live doc. Idempotent and resumable: a non-null `next_cursor` means "more pages
 * — re-invoke with `?cursor=<that>`". `limit`/`cursor` reuse the standard list
 * params (tags/slug are ignored). Runs synchronously so the response carries the
 * counts; `vectors ≪ embedded` signals a transient Vectorize/AI failure (re-run).
 *
 * Status codes:
 *   200  page processed (see counts + next_cursor)
 *   400  bad mode / bad limit / bad cursor
 *   401  bad/missing operator auth       403  csrf_failed
 */
export async function backfillVectors(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const url = new URL(req.url);
  const modeRaw = url.searchParams.get("mode") || "missing";
  if (modeRaw !== "missing" && modeRaw !== "rebuild") {
    return jsonError(400, "bad_request", `mode must be "missing" or "rebuild"`);
  }
  const mode: BackfillMode = modeRaw;

  // Reuse the list-param parser for limit/cursor validation. tags/slug are
  // parsed but unused by backfillVectorsCore.
  const params = parseHttpListParams(url);
  if (!params.ok) return jsonError(400, params.code, params.message);

  const r = await backfillVectorsCore(env, mode, params);
  return Response.json({
    mode: r.mode,
    scanned: r.scanned,
    embedded: r.embedded,
    vectors: r.vectors,
    skipped: r.skipped,
    next_cursor: r.next_cursor,
  });
}

/**
 * POST /admin/links/backfill?limit=N&cursor=…
 *   →  200 { scanned, updated, links, next_cursor }
 *
 * Operator-invoked link-graph backfill (migration 0016 / issue #40): re-extracts
 * `document_links` rows from each live doc's stored render H. The write path
 * keeps the graph current from here on; this sweep covers the write-once corpus
 * that predates the migration. Always rebuild-semantics (idempotent, cheap —
 * one R2 GET + one tiny D1 batch per doc); resumable via `?cursor=` exactly
 * like the vectors backfill above.
 *
 * Status codes:
 *   200  page processed         400  bad limit / bad cursor
 *   401  bad/missing operator auth       403  csrf_failed
 */
export async function backfillLinks(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const url = new URL(req.url);
  const params = parseHttpListParams(url);
  if (!params.ok) return jsonError(400, params.code, params.message);

  const r = await backfillLinksCore(env, params, url.origin);
  return Response.json({
    scanned: r.scanned,
    updated: r.updated,
    links: r.links,
    next_cursor: r.next_cursor,
  });
}

/**
 * GET /admin/links/orphans
 *   →  200 { documents: DocumentListing[] }
 *
 * Orphan detection (issue #40): live documents NO live document links to —
 * neither by public_id nor by current slug. Newest first, capped at 200, no
 * cursor (a curation worklist, not a browse surface). A doc only ever written
 * and shared by URL is a perfectly fine orphan — this is a librarian's view,
 * not an error list. Run the links backfill first or pre-0016 docs will ALL
 * read as orphans (no graph rows yet to say otherwise).
 *
 * Status codes:
 *   200  list returned          401  bad/missing operator auth
 */
export async function listOrphanDocuments(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  const r = await listOrphanDocumentsCore(env);
  return Response.json({ documents: r.documents });
}

/**
 * POST /admin/documents/:public_id/visibility  { "visibility": "public" | "private" }
 *   →  200 { public_id, visibility }
 *
 * Operator-only — the ONLY principal that changes visibility (agents never do;
 * visibility-change is deliberately kept out of can_access, see src/access.ts).
 * Flips a LIVE document between public and private (migration 0011). Reversible,
 * no version bump, no tombstone. Idempotent: a no-op set returns 200.
 *
 * This is the curl/programmatic operator surface. (A future in-browser toolbar
 * toggle will be a separate revoke-style form with a form-field CSRF token —
 * see the plan / setDocumentVisibilityCore — reusing the same core function.)
 *
 * Status codes:
 *   200  visibility set (or already that value)
 *   400  invalid_visibility (body.visibility not "public"|"private") / bad JSON
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  no such live document (missing, revoked, or malformed public_id)
 */
export async function setDocumentVisibility(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const visibility = (body as { visibility?: unknown })?.visibility;
  if (visibility !== "public" && visibility !== "private") {
    return jsonError(400, "invalid_visibility", `'visibility' must be "public" or "private"`);
  }

  const result = await setDocumentVisibilityCore(env, publicId, visibility);
  if (!result.ok) {
    // invalid_visibility is already ruled out above; the reachable case is not_found.
    return documentNotFound(publicId);
  }
  return Response.json({ public_id: result.public_id, visibility: result.visibility });
}

/**
 * POST /admin/documents/:public_id/promote  { "version": n }
 *   →  200 { public_id, published_ver }
 *
 * Operator-only: choose WHICH version a document publishes (migration 0018).
 * The immediate sibling of the visibility flip above — between them the two
 * decide everything the anonymous internet sees: `visibility` opens the door,
 * `published_ver` picks the bytes behind it.
 *
 * WHY IT EXISTS: in the single-tenant trust model any active agent key can
 * overwrite any live document (core.ts deliberately does not scope writes by
 * `created_by`), and some documents are public — so without a promote step an
 * agent could push private content into a public document and have the world
 * served it on the next render. The HTML byte path for a PUBLIC document
 * therefore serves `published_ver` to EVERY caller (anonymous, agent and
 * operator alike) while `current_ver` keeps moving with each write. An agent
 * can still write; it just cannot publish.
 *
 * PRIVATE documents render `current_ver` unchanged, and every credentialed or
 * machine-readable surface (/text, /source, /links, MCP reads, search, packs,
 * FTS, vectors, the link graph) stays on `current_ver` regardless of visibility.
 * Promotion governs the browser byte path and nothing else.
 *
 * Promoting a PRIVATE document is allowed, and is the point: it stages the
 * choice before the door opens, and the later flip to public keeps it
 * (setDocumentVisibilityCore only fills `published_ver` when it is still NULL).
 *
 * No version bump, no FTS write, no vector sync, no tombstone — like the
 * visibility/tags/status mutators this sets one column and stamps `updated_at`.
 * Idempotent: re-promoting the current choice returns 200.
 *
 * Status codes:
 *   200  published_ver set (or already that version)
 *   400  bad JSON / missing-or-non-integer `version`
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  not_found — no such live document
 *   404  version_not_found — the document is live but has no version n (the body
 *        carries `version`). Same status class as the miss above, distinct
 *        discriminant: the remedy differs (pick another version vs. give up), so
 *        folding them onto one code made the difference a field's presence.
 *        Safe to distinguish only because `requireOperator` has already run —
 *        the operator can list every version at GET /admin/documents/:id/versions.
 */
export async function promoteDocumentVersion(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const version = (body as { version?: unknown })?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return jsonError(400, "bad_request", "missing or invalid 'version' (a positive integer)");
  }

  const result = await promoteVersionCore(env, publicId, version);
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return documentNotFound(publicId);
      case "version_not_found":
        // First-class code since the 2.0 window (ledger entry 7): `version` is a
        // declared, REQUIRED member of this arm rather than an optional field
        // bolted onto `not_found`. The shape guard above must stay — the core
        // returns this code for a non-integer or `< 1` version WITHOUT a DB read,
        // so dropping the guard would assert "this document exists" about a
        // public_id that does not.
        return jsonError(404, "version_not_found", `this document has no version v${version}`, {
          version,
        });
    }
  }
  return Response.json({ public_id: result.public_id, published_ver: result.published_ver });
}

/**
 * POST /admin/documents/:public_id/slug  { "slug": "<value>" }
 *   →  200 { public_id, slug, retired, redirected }
 *
 * Operator-only: add, rename, or clear a LIVE document's slug WITHOUT bumping a
 * version (slug is identity-adjacent — see setDocumentSlugCore). `slug` is a
 * required string; a non-empty value sets/renames (validated + uniqueness-
 * checked), an empty string `""` clears it.
 *
 * A RENAME (the doc already had a different slug) retires the old name AND
 * auto-forwards it to this document — exactly like an agent's `update_document`
 * slug change — so `redirected: true` and `/s/<old>` keeps resolving loudly. A
 * CLEAR retires the old name with NO redirect (`/s/<old>` 410s). A first-time
 * claim retires nothing.
 *
 * This is the programmatic twin of the browser slug form (`POST /d/:id/slug`);
 * both call setDocumentSlugCore. The agentic equivalent is the slug field on the
 * MCP/HTTP write tools — there is no separate MCP slug-change tool.
 *
 * Status codes:
 *   200  slug set / renamed / cleared (or unchanged no-op)
 *   400  bad JSON / missing-or-non-string `slug`
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  no such live document (missing, revoked, or malformed public_id)
 *   409  slug_taken (live collision) / slug_retired (previously used — not reusable)
 *   422  invalid_slug (charset/length — body has `reason`)
 */
export async function setDocumentSlug(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const slug = (body as { slug?: unknown })?.slug;
  if (typeof slug !== "string") {
    return jsonError(400, "bad_request", "missing or invalid 'slug' (string; pass \"\" to clear)");
  }

  const result = await setDocumentSlugCore(env, publicId, slug);
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return documentNotFound(publicId);
      case "invalid_slug":
        return jsonError(422, "invalid_slug", formatSlugReject(result.reason), {
          reason: result.reason,
        });
      case "slug_taken":
        return jsonError(409, "slug_taken", `slug "${result.slug}" is already in use`, {
          slug: result.slug,
        });
      case "slug_retired":
        return jsonError(
          409,
          "slug_retired",
          `slug "${result.slug}" was previously used and is retired; slugs are not reusable`,
          { slug: result.slug },
        );
    }
  }
  return Response.json({
    public_id: result.public_id,
    slug: result.slug,
    retired: result.retired,
    redirected: result.redirected,
  });
}

/**
 * POST /admin/documents/:public_id/status  { "status": "active" | "deprecated", "superseded_by"?: "<public_id>" }
 *   →  200 { public_id, status, superseded_by }
 *
 * Operator-only: set a LIVE document's lifecycle status (migration 0014 — the
 * "still findable, no longer current" axis context packs depend on) WITHOUT
 * bumping a version. Mirrors the visibility/tags/slug no-version-bump mutators;
 * see setDocumentStatusCore for the semantics:
 *   - `archived` is reserved (in the DB CHECK) and REJECTED until its behavior
 *     is wired — only "active" and "deprecated" are settable in v1.
 *   - `superseded_by` (optional, deprecated only) names the replacement doc by
 *     public_id. FULL-REPLACE per call; omitted → cleared. Must be a LIVE doc
 *     and not the doc itself. Setting "active" always clears it.
 *
 * Surfaces never auto-follow the pointer — search/list/pack carry it so the
 * reader decides (the loud slug-redirect stance, document-level).
 *
 * Status codes:
 *   200  status set (or already that value)
 *   400  bad JSON / invalid_status (not "active"|"deprecated")
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  no such live document (missing, revoked, or malformed public_id)
 *   422  bad_target (superseded_by malformed, not live, or self-pointing)
 */
export async function setDocumentStatus(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  return setDocumentStatusImpl(publicId, req, env);
}

/**
 * PUT /d/:public_id/status  { "status": "active" | "deprecated", "superseded_by"?: "<public_id>" }
 *
 * The AGENT-reachable twin of `setDocumentStatus` — same body, same core, same
 * response; only the door differs (`requireReader`: any active agent key OR the
 * operator, never anonymous).
 *
 * WHY THIS IS SAFE TO PUT ON THE AGENT DOOR: in the single-tenant whole-fleet
 * trust model an agent key already replaces any document's entire CONTENT via
 * `PUT /d/:public_id` (core.ts deliberately does not scope writes by
 * `created_by`). Marking that same document deprecated grants strictly less
 * authority than rewriting it, so this is not a widening of the trust model —
 * it just stops the model from being incoherent. An agent that can author a
 * corpus but can never curate it produces exactly the rot context packs exist
 * to avoid: superseded documents that still rank, with no way for the author to
 * say so.
 *
 * WHAT STAYS OPERATOR-ONLY, DELIBERATELY: `visibility` and `revoke`. Visibility
 * is the boundary between "private to the fleet" and "readable by the anonymous
 * internet" — a different KIND of authority from anything an agent key already
 * holds, since every agent-door power above is exercised inside the fleet.
 * Revoke is irreversible. Neither belongs here, and neither should be added by
 * analogy to this pair. (`POST /d/:id/status`, the manage-page HTML form, stays
 * operator-only too — this is PUT for exactly that reason.)
 *
 * Status codes are `setDocumentStatus`'s, with 401 meaning "no agent key and no
 * operator token" and no 403 (there is no cookie path here).
 */
export async function curateDocumentStatus(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator token required");
  if (denied) return denied;
  return setDocumentStatusImpl(publicId, req, env);
}

/** Shared body of the operator + agent-door status handlers (auth already
 *  resolved by the caller). */
async function setDocumentStatusImpl(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const b = body as { status?: unknown; superseded_by?: unknown };
  if (typeof b?.status !== "string") {
    return jsonError(400, "bad_request", `missing or invalid 'status' ("active" | "deprecated")`);
  }
  if (b.superseded_by !== undefined && b.superseded_by !== null && typeof b.superseded_by !== "string") {
    return jsonError(400, "bad_request", "'superseded_by' must be a public_id string when present");
  }

  const result = await setDocumentStatusCore(env, publicId, b.status, b.superseded_by ?? null);
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return documentNotFound(publicId);
      case "invalid_status":
        return jsonError(
          400,
          "invalid_status",
          `'status' must be "active" or "deprecated" ("archived" is reserved and not yet settable)`,
        );
      case "bad_target":
        return jsonError(
          422,
          "bad_target",
          `superseded_by "${result.target}" is not a live document (or points at this document itself)`,
          { target: result.target },
        );
    }
  }
  return Response.json({
    public_id: result.public_id,
    status: result.status,
    superseded_by: result.superseded_by,
  });
}

/**
 * POST /admin/documents/:public_id/tags  { "tags": ["a", "b", ...] }
 *   →  200 { public_id, tags }
 *
 * Operator-only: REPLACE a LIVE document's tags WITHOUT bumping a version (tags
 * are document-level classification since migration 0012 — see
 * setDocumentTagsCore). `tags` is a required array of strings; pass `[]` to
 * clear. Full replacement, not a merge. Input is charset-sanitized/deduped/
 * capped exactly like the publish/update tags field, so invalid chars are
 * silently stripped (not rejected) and the stored shape matches the write path.
 *
 * This is the operator JSON twin of the librarian's curation pass. The
 * agent-reachable twin is `PUT /d/:public_id/tags` (`curateDocumentTags`
 * below); the write tools' `tags` field remains the way to set them as part of
 * a content write.
 *
 * Status codes:
 *   200  tags replaced (or unchanged no-op)
 *   400  bad JSON / missing-or-non-array `tags`
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  no such live document (missing, revoked, or malformed public_id)
 */
export async function setDocumentTags(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  return setDocumentTagsImpl(publicId, req, env);
}

/**
 * PUT /d/:public_id/tags  { "tags": ["a", "b", ...] }
 *
 * The AGENT-reachable twin of `setDocumentTags` — same body, same core, same
 * response; only the door differs (`requireReader`: any active agent key OR the
 * operator, never anonymous). See `curateDocumentStatus` for the full rationale
 * — in short, an agent key already replaces this document's entire content
 * through `PUT /d/:public_id`, so re-classifying it grants strictly less
 * authority than it already has, while `visibility` and `revoke` stay
 * operator-only because they are a different KIND of authority.
 *
 * This is the write the librarian pass (docs/design/librarian-design.md) was
 * always going to need: retagging is the one curation verb that must be cheap,
 * because it is the one that runs over the whole corpus.
 */
export async function curateDocumentTags(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator token required");
  if (denied) return denied;
  return setDocumentTagsImpl(publicId, req, env);
}

/** Shared body of the operator + agent-door tags handlers (auth already
 *  resolved by the caller). */
async function setDocumentTagsImpl(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const tags = (body as { tags?: unknown })?.tags;
  if (!Array.isArray(tags)) {
    return jsonError(400, "bad_request", "missing or invalid 'tags' (array of strings; pass [] to clear)");
  }

  const result = await setDocumentTagsCore(env, publicId, tags);
  if (!result.ok) {
    return documentNotFound(publicId);
  }
  return Response.json({ public_id: result.public_id, tags: result.tags });
}

// -- operator version history + restore ---------------------------------------
//
// The JSON twins of the manage page's version-history table and Restore button
// (src/serve.ts: renderVersionHistory / handleRestoreForm). Both were HTML-form-
// only, so a scripted operator client — the Flutter app, a rollback script — had
// to scrape a page and parse a result card to use a first-class operator
// feature, while every other operator document mutator already had a JSON twin
// here. No new core, no migration: `listVersionsCore` / `restoreVersionCore`
// already back the MCP read knob and the browser form.
//
// OPERATOR-ONLY, both of them. Restore is a write that resurrects bytes an agent
// may have deliberately replaced, and version history is an operator axis that
// visibility deliberately does NOT govern (a public doc's history is as
// operator-only as a private one's — see serveVersionShell). There is no agent
// restore in v1; agents read history through MCP `read_document include_history`.

/**
 * GET /admin/documents/:public_id   →  200 <DocumentListing>
 *
 * The single-document twin of `GET /admin/documents` — one listing row, the
 * exact same projection (LISTING_SELECT_COLUMNS), returned BARE rather than
 * wrapped: there is nothing to sit beside one row (the list wraps only because
 * it carries `next_cursor`), and the consuming app already does
 * `DocumentListing.fromJson(response.data)`.
 *
 * It exists because the list→tap→detail flow had no detail call: a consumer
 * refreshing one document's metadata after a write had to re-fetch the whole
 * list, or scrape the manage page. `GET /d/:id` is the RENDER surface (HTML,
 * visibility-gated), so the JSON reader twin cannot live there.
 *
 * REVOKED ROWS ARE RETURNED, deliberately. `findDocumentByPublicIdCore` carries
 * no `revoked_at is null` predicate, and `GET /admin/documents` lists revoked
 * documents for audit — so 404ing here on a row the list just rendered would be
 * a broken drill-down. Such a row degrades to nulls (revoke nulls `current_ver`,
 * `published_ver` and `slug`, so the version joins miss and the title/size/hash
 * columns come back null), identical to how it already appears in the list.
 *
 * OPERATOR-ONLY, and the gate is the first statement — an unauthenticated probe
 * must not be able to fingerprint document existence here. There is deliberately
 * no agent-door twin: an agent already reads the same rows through `GET /d`,
 * `GET /d?slug=` and MCP `list_documents`, so this adds no reach it lacks.
 *
 * Status codes (no 403: `requireOperator` demands CSRF only on unsafe methods):
 *   200  the listing row (possibly a revoked one)
 *   401  bad/missing operator auth
 *   404  not_found — no such document, or a malformed public_id
 */
export async function getDocument(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const row = await findDocumentByPublicIdCore(env, publicId);
  // Same opaque body as every other admin document 404: `documentNotFound` runs
  // the purely-syntactic `idShapeHint` (no DB read) and attaches the
  // service-desc Link header. Never enrich it with anything looked up above.
  if (!row) return documentNotFound(publicId);
  return Response.json(row);
}

/**
 * GET /admin/documents/:public_id/versions   →  200 { public_id, current_ver, versions[] }
 *
 * Newest-first version manifest for a LIVE document, capped at the 200 most
 * recent (VERSION_HISTORY_LIMIT in core.ts — the same bound every list surface
 * uses). Each row is the `VersionListing` shape from src/contract.ts:
 * `version_no`, `created_at`, sizes, `sanitizer_v`, `source_format`, `title`,
 * `is_current`, the per-version author (`author_kind` / `author_id` /
 * `author_name`, migration 0013), and `source_present` — the last being the one
 * a caller MUST check before offering Restore, since a pre-0008 version with no
 * retained source cannot be restored (the manage page shows a muted "no source"
 * in place of its button for exactly this).
 *
 * Status codes (no 403: `requireOperator` demands CSRF only on unsafe methods):
 *   200  history returned
 *   401  bad/missing operator auth
 *   404  no such live document (missing, revoked, or malformed public_id)
 */
export async function listDocumentVersions(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const result = await listVersionsCore(env, publicId);
  if (!result.ok) return documentNotFound(publicId);
  const { ok: _ok, ...envelope } = result;
  return Response.json(envelope);
}

/**
 * POST /admin/documents/:public_id/restore  { "version": n }
 *   →  200 { public_id, url, version, restored_from, … }  (the write envelope)
 *
 * Re-publishes version `n`'s retained source as a NEW version, authored by the
 * `{ kind: "operator" }` principal. It is NEVER a `current_ver` rewind — see
 * restoreVersionCore: pointing `current_ver` backwards would make the next
 * ordinary update collide on the `(document_id, version_no)` primary key. The
 * response is the ordinary write envelope plus `restored_from`, so the caller's
 * existing publish/update handling applies unchanged.
 *
 * Body + title/description are restored. The document's CURRENT slug and tags
 * are left untouched — both are document-level (identity and classification),
 * not content, so a restore does not un-do a rename or a retag.
 *
 * Status codes:
 *   200  restored as a new version
 *   400  bad JSON / missing-or-non-integer `version` / that version has no content
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  not_found — no such live document
 *   404  version_not_found — that version doesn't exist (the body carries
 *        `version`). Same status class, distinct discriminant — see the twin in
 *        promoteDocumentVersion above for why the split is safe here.
 *   409  source_unavailable (that version predates source retention — revoke and
 *        republish, there is deliberately no fall-back-to-H; the body carries
 *        `version`) / precondition_failed
 *        (a concurrent write landed mid-restore; just retry)
 *   413  too_large / storage_cap_exceeded
 *   422  too_deep
 */
export async function restoreDocumentVersion(
  publicId: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const version = (body as { version?: unknown })?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return jsonError(400, "bad_request", "missing or invalid 'version' (a positive integer)");
  }

  const result = await restoreVersionCore(
    env,
    publicId,
    version,
    { kind: "operator" },
    new URL(req.url).origin,
    ctx.waitUntil.bind(ctx), // re-embed after the D1 batch commits
  );
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return documentNotFound(publicId);
      case "version_not_found":
        // First-class code since the 2.0 window (ledger entry 7) — `version` is
        // a declared, REQUIRED member of this arm, not an optional field on
        // `not_found`. Same shape-guard dependency as promoteDocumentVersion.
        return jsonError(404, "version_not_found", `this document has no version v${version}`, {
          version,
        });
      case "source_unavailable":
        return jsonError(
          409,
          "source_unavailable",
          `v${version} predates source retention, so it cannot be restored — revoke and republish the document instead`,
          { version },
        );
      case "version_conflict":
        return jsonError(
          409,
          "precondition_failed",
          `the document changed while restoring (it is now v${result.current_version}) — retry`,
          { current_version: result.current_version, expected: result.expected },
        );
      case "empty_body":
        return jsonError(400, "empty_body", `v${version} has no content to restore`);
      case "too_large":
        return jsonError(413, "too_large", `input exceeds ${result.limit} bytes`, {
          limit: result.limit,
        });
      case "too_deep":
        return jsonError(
          422,
          "too_deep",
          `document nesting too deep (${result.depth} levels; limit ${result.limit}) — flatten the markup`,
          { limit: result.limit, depth: result.depth },
        );
      case "storage_cap_exceeded":
        return jsonError(
          413,
          "storage_cap_exceeded",
          `fleet has used ${result.used} of ${result.cap} bytes; this write would exceed cap`,
          { used: result.used, cap: result.cap, this_write: result.this_write },
        );
      // The slug branches of UpdateErr are unreachable: a restore never changes
      // the slug (restoreMetaFrom carries title/description only), so nothing can
      // collide. Folded into a 500 rather than silently 200-ing.
      default:
        return jsonError(500, "internal", `unexpected restore failure: ${result.code}`);
    }
  }

  const { ok: _ok, ...envelope } = result;
  return Response.json(envelope);
}

// -- operator authoring -------------------------------------------------------
//
// The operator's OWN write door (POST /admin/documents, PUT /admin/documents/
// :public_id) — distinct from the agent write path (POST /d, PUT /d/:id) and
// from the MCP write tools. The operator authors as the `{ kind: "operator" }`
// principal (migration 0013): created_by/author_kind record "operator", no agent
// row is invented. Both route through the SAME core write path as every other
// door (publishDocumentCore / updateDocumentCore), so sanitize→cap→R2→D1→FTS
// runs exactly once and identically.
//
// JSON body (vs the agent path's raw text/html|text/markdown body + X-Doc-*
// headers): app-idiomatic and consistent with the rest of /admin/*. The
// operator app sends one object the mobile client codegens off /openapi.json.

/**
 * Validate and normalize the shared operator-write JSON body into the pieces
 * the core write functions take. `content` (string) and `format` ("html" |
 * "markdown") are required; title/description/tags/slug are optional and follow
 * the same omitted-vs-`""` inheritance semantics as every other write surface
 * (an absent key is left `undefined` so update inherits; an explicit `""`
 * clears). `visibility` is parsed only when `allowVisibility` (create) — on
 * update, visibility has its own no-version-bump endpoint
 * (POST /admin/documents/:id/visibility), so it is not accepted here.
 */
function parseOperatorWriteBody(
  body: unknown,
  allowVisibility: boolean,
):
  | { ok: true; content: string; format: SourceFormat; meta: DocumentMetadataInput; visibility?: Visibility }
  | { ok: false; response: Response } {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad = (msg: string) => ({ ok: false as const, response: jsonError(400, "bad_request", msg) });

  if (typeof b.content !== "string") return bad("missing or invalid 'content' (string)");
  if (b.format !== "html" && b.format !== "markdown") {
    return bad(`missing or invalid 'format' ("html" or "markdown")`);
  }

  const meta: DocumentMetadataInput = {};
  if (b.title !== undefined) {
    if (typeof b.title !== "string") return bad("'title' must be a string");
    meta.title = b.title;
  }
  if (b.description !== undefined) {
    if (typeof b.description !== "string") return bad("'description' must be a string");
    meta.description = b.description;
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || !b.tags.every((t) => typeof t === "string")) {
      return bad("'tags' must be an array of strings");
    }
    meta.tags = b.tags as string[];
  }
  if (b.slug !== undefined) {
    if (typeof b.slug !== "string") return bad(`'slug' must be a string (pass "" to clear)`);
    meta.slug = b.slug;
  }

  let visibility: Visibility | undefined;
  if (allowVisibility && b.visibility !== undefined) {
    if (b.visibility !== "public" && b.visibility !== "private") {
      return bad(`'visibility' must be "public" or "private"`);
    }
    visibility = b.visibility;
  }

  return { ok: true, content: b.content, format: b.format, meta, visibility };
}

/**
 * POST /admin/documents  { content, format, title?, description?, tags?, slug?, visibility? }
 *   →  201 { public_id, url, version, … }  (the shared WriteResponse)
 *
 * Operator-authored publish. Born at `visibility` when supplied (atomic, via
 * publishDocumentCore's operator-only override), else the deploy default. Same
 * success shape + Location/ETag headers as POST /d.
 *
 * Status codes:
 *   201  created
 *   400  bad JSON / invalid body (content, format, title, description, tags, slug, visibility)
 *   401  bad/missing operator auth        403  csrf_failed (cookie + missing X-CSRF-Token)
 *   409  slug_taken / slug_retired        413  too_large / storage_cap_exceeded
 *   422  invalid_slug
 */
export async function createDocumentAsOperator(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const parsed = parseOperatorWriteBody(raw, true);
  if (!parsed.ok) return parsed.response;

  const origin = new URL(req.url).origin;
  const result = await publishDocumentCore(
    env,
    parsed.content,
    { kind: "operator" },
    origin,
    parsed.format,
    parsed.meta,
    parsed.visibility,
    ctx.waitUntil.bind(ctx),
  );
  if (!result.ok) return mapWriteError(result);

  return Response.json(toWriteResponse(result), {
    status: 201,
    headers: { Location: result.url, ETag: `"v${result.version}"` },
  });
}

/**
 * PUT /admin/documents/:public_id  { content, format, title?, description?, tags?, slug? }
 *   →  200 { public_id, url, version, … }  (the shared WriteResponse)
 *
 * Operator-authored update — appends a new version authored by the operator
 * principal. `documents.created_by` is untouched (creator is immutable), so an
 * operator update of an agent-created doc yields creator=agent, this-version
 * author=operator (the full author list the version history surfaces).
 *
 * OPTIONAL If-Match (the deliberate, app-friendly divergence from PUT /d/:id's
 * REQUIRED If-Match): a `"v<n>"` (or `*`) header is honored for optimistic
 * concurrency (412 on mismatch); ABSENT means last-write-wins. visibility is
 * NOT accepted here — use POST /admin/documents/:id/visibility.
 *
 * Status codes:
 *   200  new version stored
 *   400  bad JSON / invalid body / malformed If-Match
 *   401  bad/missing operator auth        403  csrf_failed
 *   404  no such (missing or revoked) document
 *   409  slug_taken / slug_retired        412  If-Match version mismatch
 *   413  too_large / storage_cap_exceeded 422  invalid_slug
 */
export async function updateDocumentAsOperator(
  publicId: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  // Optional optimistic concurrency. Absent If-Match → null (clobber); `*` →
  // null; a version tag (`"v<n>"`, or the lenient `v<n>`/`<n>`/`"<n>"` forms) →
  // n; anything else → 400. (Required-If-Match is the agent path's contract —
  // POST /d; this operator/app path opts for last-write-wins when the header is
  // omitted.) Shares parseIfMatch with PUT /d/:id so both write doors accept the
  // same shapes (GitHub issue #32).
  let expectedVersion: number | null = null;
  const ifMatchRaw = req.headers.get("if-match");
  if (ifMatchRaw) {
    const ifMatch = parseIfMatch(ifMatchRaw);
    if (ifMatch.kind === "invalid") {
      return jsonError(400, "bad_request", `If-Match must be a version like "v3" (a bare v3 or 3 is also accepted) or "*"`);
    }
    expectedVersion = ifMatch.kind === "version" ? ifMatch.v : null;
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const parsed = parseOperatorWriteBody(raw, false);
  if (!parsed.ok) return parsed.response;

  const origin = new URL(req.url).origin;
  const result = await updateDocumentCore(
    env,
    publicId,
    parsed.content,
    expectedVersion,
    { kind: "operator" },
    origin,
    parsed.format,
    parsed.meta,
    ctx.waitUntil.bind(ctx),
  );
  if (!result.ok) return mapWriteError(result, publicId);

  return Response.json(toWriteResponse(result), {
    status: 200,
    headers: { Location: result.url, ETag: `"v${result.version}"` },
  });
}

/**
 * Map a publish/update core failure to its HTTP response. The union is the same
 * one POST /d and PUT /d/:id map (see src/index.ts) — kept identical so the
 * operator door's error contract matches the agent door's exactly. `empty_body`
 * is reachable (the parser allows a `""` content through to core, which is the
 * authoritative emptiness check).
 *
 * `publicId` is the addressed document on the UPDATE path, used only to build
 * the `not_found` hint. Absent on the create path (POST /admin/documents
 * addresses nothing), where `not_found` is unreachable anyway.
 */
function mapWriteError(
  result:
    | Awaited<ReturnType<typeof publishDocumentCore>>
    | Awaited<ReturnType<typeof updateDocumentCore>>,
  publicId?: string,
): Response {
  if (result.ok) throw new Error("mapWriteError called on a success result");
  switch (result.code) {
    case "not_found":
      return publicId === undefined
        ? jsonError(404, "not_found", "no such document")
        : documentNotFound(publicId);
    case "empty_body":
      return jsonError(400, "empty_body", "body is empty");
    case "too_large":
      return jsonError(413, "too_large", `input exceeds ${result.limit} bytes`, {
        limit: result.limit,
      });
    case "too_deep":
      return jsonError(
        422,
        "too_deep",
        `document nesting too deep (${result.depth} levels; limit ${result.limit}) — flatten the markup`,
        { limit: result.limit, depth: result.depth },
      );
    case "storage_cap_exceeded":
      return jsonError(
        413,
        "storage_cap_exceeded",
        `fleet has used ${result.used} of ${result.cap} bytes; this write would exceed cap`,
        { used: result.used, cap: result.cap, this_write: result.this_write },
      );
    case "version_conflict":
      return jsonError(412, "precondition_failed", `current version is v${result.current_version}`, {
        current_version: result.current_version,
        expected: result.expected,
      });
    case "invalid_slug":
      return jsonError(422, "invalid_slug", formatSlugReject(result.reason), { reason: result.reason });
    case "slug_taken":
      return jsonError(409, "slug_taken", `slug "${result.slug}" is already in use`, {
        slug: result.slug,
      });
    case "slug_retired":
      return jsonError(
        409,
        "slug_retired",
        `slug "${result.slug}" was previously used and is retired; slugs are not reusable`,
        { slug: result.slug },
      );
    // Migration 0018 / issue #43. UNREACHABLE through this mapper in practice —
    // its only callers are the operator authoring handlers, which pass
    // `{kind:"operator"}`, and the lock fires only for `author.kind === "agent"`.
    // The arm exists because the switch is exhaustive over the core error union
    // (that exhaustiveness is what makes tsc catch a new code with no handler),
    // and because "unreachable today" is a property of the callers, not of the
    // type — a future operator-door caller that forwards an agent's author would
    // otherwise fall through to no return at all.
    case "slug_locked":
      return jsonError(
        403,
        "slug_locked",
        "this document is public; a public document's slug can only be changed by the operator",
      );
  }
}
