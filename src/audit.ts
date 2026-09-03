// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The append-only operator audit ledger (migration 0020 / GitHub issue #62).
 *
 * ---------------------------------------------------------------------------
 * THE NEVER-LOG RULE IS ENFORCED BY CONSTRUCTION, NOT BY REVIEW.
 *
 * `recordAudit` takes a value of {@link AuditEventInput} — a DISCRIMINATED
 * UNION whose members carry only named scalar fields. There is no `detail:
 * object` parameter, no `extra: Record<string, unknown>`, no rest spread. A
 * caller physically cannot hand this module a request body, a document, a
 * header bag or a credential, because no member of the union has a field that
 * would accept one.
 *
 * That is the whole design. A ledger whose writer accepts free-form context is
 * one careless call site away from persisting an `Authorization` header, and no
 * amount of "remember not to log secrets" in a comment prevents that. The list
 * below is therefore a consequence of the type, not a promise on top of it:
 *
 *   minted keys and client secrets · OPERATOR_TOKEN · session cookies and CSRF
 *   nonces · request bodies · document content · Authorization headers · PKCE
 *   verifiers and authorization codes.
 *
 * `test/audit.test.mjs` walks the union's field names at runtime and fails the
 * build if any of them is `token`, `key`, `secret`, `password`, `body`,
 * `content`, `authorization`, `cookie`, `verifier` or `code`. (`key_id` is the
 * one deliberate near-miss and is allowlisted there: it is an opaque
 * `agent_keys` row id, which is exactly the thing you want in an audit trail
 * and exactly not the thing the rule is about.)
 *
 * Zod's default object behaviour STRIPS unknown keys, so even a caller that
 * defeats the compiler — a value crossing an `any`, a JS caller — cannot smuggle
 * an extra field into a row.
 *
 * ---------------------------------------------------------------------------
 * BEST-EFFORT, OUTSIDE THE BATCH, NEVER BLOCKING.
 *
 * `recordAudit` returns `void` immediately and schedules its single INSERT
 * through `ctx.waitUntil`. It never joins a `META.batch()` and never sits on the
 * response path. Failures are swallowed and logged (the event KIND, never its
 * fields).
 *
 * This is the same posture vector sync takes (see the vector-sync bullet in
 * CLAUDE.md) and for the same reason: the ledger is DERIVED state. A lost row is
 * acceptable; a publish that fails because the ledger was briefly unavailable is
 * not. The stricter alternative — refuse the act when its audit row cannot be
 * written — was considered and explicitly declined on issue #62.
 *
 * `waitUntil` is optional so a core can be called from a context that has no
 * `ExecutionContext` (a unit test, an un-plumbed caller). When it is absent the
 * INSERT is still STARTED and its rejection still handled, but the runtime may
 * cancel it once the response is returned — a lost row, which the contract above
 * already permits. Thread the real thing wherever you have one.
 */

import { z } from "zod";
import { AuditPrincipalKindSchema, type AuditEvent, type AuditKind } from "./contract.js";
import type { Env } from "./env.js";
import { newUuid } from "./ids.js";
import type { AuditListParams } from "./pagination.js";
import { paginate } from "./pagination.js";
import type { WaitUntil } from "./vector-io.js";

/**
 * D1's canonical timestamp shape — the same expression `documents.updated_at`
 * (migration 0017) is stamped with, so the `since=` filter's lexicographic `>=`
 * on TEXT is a chronological comparison.
 */
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Ceilings on `detail`. Every field that reaches it is a scalar the writer named,
 * so these can only bind on something long-ish and legitimate (a callback URI) —
 * but this table is never pruned, so an unbounded string is not something to
 * leave to chance.
 *
 * The truncation is applied to individual STRING VALUES, before serialization,
 * never to the serialized JSON: slicing the JSON would produce a syntactically
 * invalid document that the reader below could only degrade to `null`, losing
 * the whole detail to save a few bytes of one field. `MAX_DETAIL_CHARS` is the
 * backstop for the case a future kind declares many long fields at once, and it
 * replaces the object rather than corrupting it.
 */
const MAX_DETAIL_VALUE_CHARS = 256;
const MAX_DETAIL_CHARS = 1024;

/**
 * The six fields that map to their own COLUMNS. Everything else a union member
 * declares is folded into `detail`. Listed once, here, so adding a column means
 * touching one array rather than hunting for a switch.
 */
const COLUMN_FIELDS = [
  "principal_kind",
  "outcome",
  "agent_id",
  "client_id",
  "key_id",
  "document_id",
  "request_id",
] as const;

/** Scalar leaves — the only value types a detail field may carry. */
const scalar = z.union([z.string(), z.number(), z.boolean()]);

/**
 * The identity fields every event may carry, all optional. A member that has no
 * meaningful value for one simply never passes it and the column stays NULL —
 * which is the honest reading, not a gap (Door B has no `client_id`; a login
 * failure has no `agent_id` by definition).
 *
 * `request_id` is the edge `cf-ray` where a Request was in hand (the outer
 * observe-only layer, the `/mcp` dispatch, `/login`, `/authorize`) and null from
 * inside a core, which sees no Request.
 */
const IDENTITY_FIELDS = {
  agent_id: z.string().optional(),
  client_id: z.string().optional(),
  key_id: z.string().optional(),
  document_id: z.string().optional(),
  request_id: z.string().optional(),
};

/**
 * Build one member of the union.
 *
 * `outcome` is FIXED by the kind and defaulted, so a call site can never file a
 * `login_failed` as `ok`. `principal_kind` is passed as a schema because it is
 * genuinely fixed for most kinds and genuinely variable for a couple (a write
 * refusal can be an agent's or the operator's) — a literal where it is known,
 * the open enum where it is not.
 */
function event<K extends AuditKind, S extends z.ZodRawShape>(
  kind: K,
  outcome: "ok" | "denied" | "error",
  principalKind: z.ZodType<z.infer<typeof AuditPrincipalKindSchema>>,
  detail: S = {} as S,
) {
  return z.object({
    kind: z.literal(kind),
    outcome: z.literal(outcome).default(outcome),
    principal_kind: principalKind,
    ...IDENTITY_FIELDS,
    ...detail,
  });
}

const OPERATOR = z.literal("operator");
const ANONYMOUS = z.literal("anonymous");
const AGENT = z.literal("agent");

/**
 * The v1 event vocabulary. Adding a kind means: a member here, an entry in
 * `AuditKindSchema` (src/contract.ts), and the CHECK list in migration 0020 —
 * `test/audit.test.mjs` pins all three against each other, so forgetting one is
 * a failed build rather than a 500 on a deployed Worker.
 */
export const AuditEventInputSchema = z.discriminatedUnion("kind", [
  // --- the OAuth / connector door -------------------------------------------
  // DCR is open by design (registration confers no authority — the consent
  // screen is the gate), but "open and unrecorded" is what issue #62 was about.
  event("client_registered", "ok", ANONYMOUS),
  event("token_issued", "ok", ANONYMOUS, { status: z.number() }),
  event("token_denied", "denied", ANONYMOUS, { status: z.number() }),
  event("mcp_auth_failed", "denied", ANONYMOUS, { reason: z.string() }),
  event("consent_allowed", "ok", OPERATOR),
  event("consent_denied", "denied", OPERATOR),
  // The moment a self-registered client gains authority: it is bound to an
  // agent. `mode` distinguishes "bound to an agent that already existed" from
  // "an agent was minted for it at the consent screen".
  event("oauth_client_bound", "ok", OPERATOR, { mode: z.enum(["new", "existing"]) }),
  // TOFU callback approval. The URI is the artifact that was approved and is
  // exactly what a later reader needs; it is a registered redirect target, not
  // a credential.
  event("callback_approved", "ok", OPERATOR, { callback_uri: z.string() }),

  // --- the operator browser session -----------------------------------------
  event("login_succeeded", "ok", OPERATOR),
  // `anonymous`, deliberately: the attempt failed, so there is no operator to
  // attribute it to. Nothing about the submitted token is recorded — not its
  // length, not a prefix, not a hash.
  event("login_failed", "denied", ANONYMOUS),

  // --- credentials -----------------------------------------------------------
  // The one key mint an AGENT can trigger (MCP create_publish_credential), so
  // the principal genuinely varies here where it is fixed on its siblings.
  event("agent_key_minted", "ok", AuditPrincipalKindSchema, {
    // True for the short-lived credentials MCP `create_publish_credential`
    // mints (migration 0007). The KEY is never here — only that one was made.
    ephemeral: z.boolean().optional(),
  }),
  event("agent_key_revoked", "ok", OPERATOR),
  event("agent_keys_pruned", "ok", OPERATOR, {
    mode: z.enum(["expired", "revoked"]),
    deleted: z.number(),
  }),
  event("agent_revoked", "ok", OPERATOR, {
    // `credentials_revoked`, not `keys_revoked`: it is a COUNT of agent_keys
    // rows, but the never-log test in test/audit.test.mjs matches forbidden
    // names as SUBSTRINGS, and that strictness is the point — a rule that only
    // catches a field named exactly `key` would miss `api_key` and
    // `key_material`, which are the ones that matter. Renaming a harmless
    // integer is a trivially cheap price for keeping the check strict; do not
    // "fix" this by loosening the test.
    credentials_revoked: z.number(),
    oauth_clients_deleted: z.number(),
  }),
  event("oauth_client_minted", "ok", OPERATOR, {
    // An unbound mint has no agent yet — the binding happens at consent, which
    // files its own `oauth_client_bound` row.
    bound: z.boolean(),
  }),
  event("oauth_client_deleted", "ok", OPERATOR),

  // --- documents: the acts that cross a trust boundary ----------------------
  // Content writes are NOT here. Every version is already its own durable,
  // attributed record in `versions` (author_kind / author_agent_id /
  // author_client_id, migrations 0013 + 0019); duplicating that would double the
  // ledger's volume to say something the schema already says better. What IS
  // here is the set of acts that leave no version row and change who can read
  // what: revoke, the visibility flip, promotion, and the slug lifecycle.
  event("document_revoked", "ok", OPERATOR, { already_revoked: z.boolean() }),
  event("document_visibility_changed", "ok", OPERATOR, {
    visibility: z.enum(["public", "private"]),
  }),
  event("document_promoted", "ok", OPERATOR, { version: z.number() }),
  event("slug_redirect_set", "ok", OPERATOR, { slug: z.string() }),
  event("slug_redirect_cleared", "ok", OPERATOR, { slug: z.string() }),
  event("slug_released", "ok", OPERATOR, { slug: z.string() }),

  // --- refusals on the write path -------------------------------------------
  // Recorded inside updateDocumentCore, which is the ONE place both doors (HTTP
  // PUT /d/:id and the MCP write tools) converge — so this covers them without a
  // per-route call and cannot be bypassed by a new write surface that routes
  // through core as it must.
  event("write_conflict", "denied", AuditPrincipalKindSchema, {
    expected: z.number(),
    current: z.number(),
  }),
  event("slug_locked", "denied", AGENT),
]);

/**
 * What `recordAudit` accepts. Note this is the schema's INPUT type: `outcome` is
 * defaulted per kind, so call sites pass the kind, the identities they know, and
 * nothing else.
 */
export type AuditEventInput = z.input<typeof AuditEventInputSchema>;

/**
 * Record one event. Fire-and-forget by contract — returns `void`, never throws,
 * never blocks, and its failure is invisible to the request that triggered it.
 *
 * Call it AFTER the act it describes has committed. An event recorded before the
 * write it claims happened is a lie the ledger can never correct.
 */
export function recordAudit(
  env: Env,
  waitUntil: WaitUntil | undefined,
  event: AuditEventInput,
): void {
  const write = writeAuditEvent(env, event);
  if (waitUntil) waitUntil(write);
}

/**
 * The same write, as an awaitable that NEVER REJECTS.
 *
 * For the one caller that must sequence something before the row is written —
 * the observe-only layer in src/index.ts reads a cloned `/register` response to
 * learn the `client_id` first — so the whole chain can ride ONE `ctx.waitUntil`
 * instead of scheduling a second one from inside the first.
 */
export function writeAuditEvent(env: Env, event: AuditEventInput): Promise<void> {
  const parsed = AuditEventInputSchema.safeParse(event);
  if (!parsed.success) {
    // A malformed event is a bug in a call site, not a reason to fail a request.
    // Log the kind so it is findable in `wrangler tail`; never log the value —
    // the whole point of this module is that untyped data does not get written
    // down, and that has to hold on the error path too.
    console.error(`audit: refusing malformed event (kind=${String(event?.kind)})`);
    return Promise.resolve();
  }

  const row = parsed.data as Record<string, unknown>;
  const detail: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "kind") continue;
    if ((COLUMN_FIELDS as readonly string[]).includes(k)) continue;
    if (v === undefined) continue;
    // Belt and braces: the union only declares scalars, so this can only reject
    // something a future edit got wrong.
    if (!scalar.safeParse(v).success) continue;
    detail[k] = typeof v === "string" ? v.slice(0, MAX_DETAIL_VALUE_CHARS) : (v as number | boolean);
  }
  let detailJson: string | null = null;
  if (Object.keys(detail).length > 0) {
    detailJson = JSON.stringify(detail);
    if (detailJson.length > MAX_DETAIL_CHARS) {
      // Still valid JSON, and honest about what happened — never a truncated
      // object literal the reader would have to throw away.
      detailJson = JSON.stringify({ truncated: true });
    }
  }

  return env.META.prepare(
    `insert into audit_events
       (id, at, kind, principal_kind, agent_id, client_id, key_id, document_id, outcome, detail, request_id)
     values (?, ${NOW_SQL}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newUuid(),
      row.kind as string,
      row.principal_kind as string,
      (row.agent_id as string | undefined) ?? null,
      (row.client_id as string | undefined) ?? null,
      (row.key_id as string | undefined) ?? null,
      (row.document_id as string | undefined) ?? null,
      row.outcome as string,
      detailJson,
      (row.request_id as string | undefined) ?? null,
    )
    .run()
    .then(() => undefined)
    .catch((err: unknown) => {
      // Swallowed on purpose — see the module header. The kind and the error's
      // own message only; never the event's fields.
      console.error(`audit: write failed (kind=${row.kind as string}): ${String(err)}`);
    });
}

/**
 * The edge request id, when there is one. `cf-ray` is present on every request
 * that came through Cloudflare and absent under `wrangler dev`, so a null here
 * is normal in local development and means "no edge id", never "an error".
 */
export function requestIdOf(req: Request): string | undefined {
  return req.headers.get("cf-ray") ?? undefined;
}

// ============================================================================
// The read surface
// ============================================================================

type AuditRow = {
  id: string;
  at: string;
  kind: string;
  principal_kind: string;
  agent_id: string | null;
  client_id: string | null;
  key_id: string | null;
  document_id: string | null;
  outcome: string;
  detail: string | null;
  request_id: string | null;
};

/**
 * List the ledger newest-first, cursor-paginated on `(at DESC, id DESC)` — the
 * same predicate rewrite and `id` tiebreaker every other list in this codebase
 * uses (src/pagination.ts). The cursor is minted bare (no `order`
 * discriminator), like the agents/keys lists: this surface has exactly one
 * ordering and always will — a ledger read in any order but "most recent first"
 * is not a ledger.
 *
 * The filters are pure narrowings and grant nothing: the caller is already
 * `requireOperator` by the time this runs, and the operator can read every row
 * with no filter at all.
 */
export async function listAuditEventsCore(
  env: Env,
  params: AuditListParams,
): Promise<{ events: AuditEvent[]; next_cursor: string | null }> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (params.cursor) {
    where.push("(at < ? or (at = ? and id < ?))");
    binds.push(params.cursor.ts, params.cursor.ts, params.cursor.id);
  }
  if (params.kind !== null) {
    where.push("kind = ?");
    binds.push(params.kind);
  }
  if (params.agentId !== null) {
    where.push("agent_id = ?");
    binds.push(params.agentId);
  }
  if (params.documentId !== null) {
    where.push("document_id = ?");
    binds.push(params.documentId);
  }
  if (params.since !== null) {
    where.push("at >= ?");
    binds.push(params.since);
  }

  const sql =
    `select id, at, kind, principal_kind, agent_id, client_id, key_id, document_id,
            outcome, detail, request_id
       from audit_events` +
    (where.length > 0 ? `\n      where ${where.join(" and ")}` : "") +
    `\n      order by at desc, id desc
       limit ?`;

  // limit+1 is the peek row `paginate` turns into next_cursor.
  const rs = await env.META.prepare(sql)
    .bind(...binds, params.limit + 1)
    .all<AuditRow>();

  return paginateAudit(rs.results ?? [], params.limit);
}

function paginateAudit(
  rows: AuditRow[],
  limit: number,
): { events: AuditEvent[]; next_cursor: string | null } {
  const { items, next_cursor } = paginate(rows, limit, projectAuditRow, (r) => ({
    ts: r.at,
    id: r.id,
  }));
  return { events: items, next_cursor };
}

/**
 * D1 row → wire shape. `detail` is stored as JSON text; a row whose JSON is
 * unparseable (impossible via `recordAudit`, but the column is plain TEXT and
 * this table is meant to outlive the code that wrote it) degrades to null rather
 * than throwing — a ledger that 500s on one bad row is worse than one that shows
 * the other ten thousand.
 */
function projectAuditRow(r: AuditRow): AuditEvent {
  let detail: AuditEvent["detail"] = null;
  if (r.detail !== null) {
    try {
      const parsed: unknown = JSON.parse(r.detail);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        detail = parsed as AuditEvent["detail"];
      }
    } catch {
      detail = null;
    }
  }
  return {
    id: r.id,
    at: r.at,
    // The CHECK constraint is the authority on these two; cast rather than
    // re-validate on every row of every page.
    kind: r.kind as AuditEvent["kind"],
    principal_kind: r.principal_kind as AuditEvent["principal_kind"],
    agent_id: r.agent_id,
    client_id: r.client_id,
    key_id: r.key_id,
    document_id: r.document_id,
    outcome: r.outcome as AuditEvent["outcome"],
    detail,
    request_id: r.request_id,
  };
}
