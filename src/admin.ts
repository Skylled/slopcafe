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
 *   GET    /admin/documents                    list documents (incl. revoked)
 *   GET    /admin/documents/search             full-text search over live documents
 *   POST   /admin/documents/:public_id/visibility  set a live doc public/private
 *   POST   /admin/documents/:public_id/slug        add/rename/clear a live doc's slug (rename auto-forwards)
 *   POST   /admin/slugs/:slug/redirect         point a retired slug at a live doc
 *   DELETE /admin/slugs/:slug/redirect         drop a retired slug's redirect (back to 410)
 *   DELETE /admin/slugs/:slug                  force-release a retired slug (escape hatch)
 *
 * Revoking a *document* lives on the public route (`DELETE /d/:public_id`)
 * since it shares the path with the resource. That endpoint is also
 * operator-auth.
 */

import { computeExpiresAt, hmacSha256Hex } from "./auth.js";
import {
  clearSlugRedirectCore,
  listDocumentsCore,
  releaseSlugTombstoneCore,
  searchDocumentsCore,
  setDocumentSlugCore,
  setDocumentVisibilityCore,
  setSlugRedirectCore,
} from "./core.js";
import type { Env } from "./env.js";
import { newApiKey, newUuid } from "./ids.js";
import { formatSlugReject, validateSlugInput } from "./metadata.js";
import { paginate, parseHttpListParams } from "./pagination.js";
import { buildFtsMatchQuery } from "./search.js";
import { requireOperator } from "./session.js";

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

  // (created_at DESC, id DESC) — id is the cursor tiebreaker; see core.ts
  // listDocumentsCore for the rationale.
  type Row = {
    id: string;
    name: string;
    created_at: string;
    active_keys: number;
    total_keys: number;
    live_docs: number;
  };
  const peek = params.limit + 1;
  const stmt = params.cursor
    ? env.META
        .prepare(
          `select a.id, a.name, a.created_at,
             (select count(*) from agent_keys k
                where k.agent_id = a.id and k.revoked_at is null) as active_keys,
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
                where k.agent_id = a.id and k.revoked_at is null) as active_keys,
             (select count(*) from agent_keys k
                where k.agent_id = a.id) as total_keys,
             (select count(*) from documents d
                where d.created_by = a.id and d.revoked_at is null) as live_docs
           from agents a
           order by a.created_at desc, a.id desc
           limit ?`,
        )
        .bind(peek);

  const result = await stmt.all<Row>();
  const { items: agents, next_cursor } = paginate(
    result.results ?? [],
    params.limit,
    (r) => r,
    (r) => ({ ts: r.created_at, id: r.id }),
  );
  return Response.json({ agents, next_cursor });
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
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  if (!UUID_RE.test(agentId)) return jsonError(404, "not_found", "no such agent");
  const params = parseHttpListParams(new URL(req.url));
  if (!params.ok) {
    return jsonError(400, params.code, params.message);
  }

  const agent = await env.META.prepare("select id, name from agents where id = ?")
    .bind(agentId)
    .first<{ id: string; name: string }>();
  if (!agent) return jsonError(404, "not_found", "no such agent");

  type Row = { id: string; key_prefix: string; created_at: string; revoked_at: string | null };
  const peek = params.limit + 1;
  const stmt = params.cursor
    ? env.META
        .prepare(
          `select id, key_prefix, created_at, revoked_at
           from agent_keys
           where agent_id = ?
             and (created_at < ? or (created_at = ? and id < ?))
           order by created_at desc, id desc
           limit ?`,
        )
        .bind(agentId, params.cursor.ts, params.cursor.ts, params.cursor.id, peek)
    : env.META
        .prepare(
          `select id, key_prefix, created_at, revoked_at
           from agent_keys
           where agent_id = ?
           order by created_at desc, id desc
           limit ?`,
        )
        .bind(agentId, peek);

  const result = await stmt.all<Row>();
  const { items: keys, next_cursor } = paginate(
    result.results ?? [],
    params.limit,
    (r) => r,
    (r) => ({ ts: r.created_at, id: r.id }),
  );
  return Response.json({
    agent_id: agentId,
    name: agent.name,
    keys,
    next_cursor,
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
  const denied = await requireOperator(req, env);
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

  const agent = await env.META.prepare("select id from agents where id = ?")
    .bind(agentId)
    .first<{ id: string }>();
  if (!agent) return jsonError(404, "not_found", "no such agent");

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
    await env.OAUTH_PROVIDER.deleteClient(clientId);
    oauthClientsDeleted++;
  }
  if (clientIds.length > 0) {
    await env.META.prepare("delete from oauth_clients where agent_id = ?")
      .bind(agentId)
      .run();
  }

  return Response.json({
    revoked: true,
    agent_id: agentId,
    keys_revoked: keysRevoked,
    oauth_clients_deleted: oauthClientsDeleted,
  });
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
 * migration 0007 and byte-exact-publish-design.md).
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
  const url = new URL(req.url);
  const params = parseHttpListParams(url);
  if (!params.ok) {
    return jsonError(400, params.code, params.message);
  }
  const q = url.searchParams.get("q");
  if (q === null || q === "") {
    return jsonError(422, "bad_query", "missing required `q` parameter");
  }
  const match = buildFtsMatchQuery(q);
  if (!match) {
    return jsonError(
      422,
      "bad_query",
      "no usable search terms (queries need at least one 2+ character word; " +
        "operators and punctuation are dropped)",
    );
  }
  const result = await searchDocumentsCore(env, match, params);
  if (!result.ok) {
    // Defensive — buildFtsMatchQuery already ruled out the only failure case.
    return jsonError(422, "bad_query", "query produced no usable terms");
  }
  return Response.json({ documents: result.documents });
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
    return jsonError(404, "not_found", "no such document");
  }
  return Response.json({ public_id: result.public_id, visibility: result.visibility });
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
        return jsonError(404, "not_found", "no such document");
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
