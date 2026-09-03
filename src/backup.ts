// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Corpus backup + restore (issue #9) — the IMPURE half: the streaming export
 * walk (`GET /admin/backup`) and the raw-row restore core (`POST /admin/restore`),
 * plus their two operator HTTP handlers. The pure format layer (cursor, base64,
 * the NDJSON parser that validates every line) is src/backup-format.ts; the
 * record shapes and the restore report are Zod in src/contract.ts.
 *
 * SCOPE — disaster recovery INTO THE SAME DEPLOYMENT. Same `HMAC_PEPPER`
 * (`agent_keys.key_hash` is HMAC-under-pepper, so it authenticates only here),
 * same bindings, same origin. Portability between instances is deferred by
 * operator decision (issue #9, 2026-09-03); nothing here pretends otherwise.
 *
 * WHAT A BACKUP HOLDS. Every row of `agents`, `agent_keys`, `oauth_clients`,
 * `documents`, `versions`, `document_links` and `slug_tombstones`, and for
 * every version of a live document BOTH R2 blobs inline (base64): the
 * sanitized render H and the retained source S. A backup without bytes is a
 * manifest. Deliberately EXCLUDED, each because it is derivable or owned
 * elsewhere: the OAuth provider's KV (clients/grants/tokens — re-consent is the
 * recovery), Vectorize chunk vectors (`POST /admin/vectors/backfill` rebuilds
 * them), and `documents_fts` (rebuilt by restore from the re-rendered H).
 *
 * THE RESTORE IS A NEW RAW-ROW PATH, NOT A WRITE THROUGH publishDocumentCore.
 * Publish mints `id`/`public_id`/`version_no`/`created_at`; a restore must
 * RE-ASSERT the recorded ones, or every shared `/d/<id>` link breaks. That
 * makes this the first path on which a `public_id` is not server-minted. It
 * is safe on three grounds, each load-bearing:
 *   1. OPERATOR-ONLY. `requireOperator` on both routes; nothing here is
 *      reachable from an agent door, and none may be added — an agent that
 *      could assert a `public_id` could squat any address it liked.
 *   2. OWN-INSTANCE BYTES. The file is this deployment's own export; identity
 *      values are the ones this instance minted (the schema regexes in
 *      contract.ts pin their shapes — a value that doesn't look like ours is
 *      refused at the line).
 *   3. RESTORED H IS NEVER TRUSTED FROM THE FILE. Every live version's render
 *      is RE-DERIVED from its restored source S through the real
 *      convert-if-markdown → `sanitize` pipeline (`screenAndPrepare`, the one
 *      copy the write cores use), stamped with the CURRENT `sanitizer_v`, with
 *      `size_bytes` and `source_sha256` recomputed — and the recomputed sha
 *      must equal the record's or the version is `corrupt`. The `html_b64`
 *      field is carried for completeness and never read here. This is
 *      docs/design/source-retention-design.md §9 (re-sanitize from source),
 *      built for the restore case. A version with no S (pre-0008) is NOT
 *      restorable on a live document — `source_unavailable`, never a legacy
 *      fallback (CLAUDE.md's manual-migration stance).
 *
 * R2 KEYS ARE MINTED FRESH per restored version (`putVersionBlobs`, the
 * attempt-nonced minting every write uses); the recorded key is never reused.
 * The one place a recorded key is stored verbatim: a REVOKED document's
 * version rows, restored as audit trail with no bytes — exactly the dead
 * pointers a revoke leaves behind today.
 *
 * SLUG TOMBSTONES ARE NEVER RELEASED BY A RESTORE. 0009's permanence contract
 * survives DR: a document whose recorded slug is retired (or held live by
 * another document) comes back SLUGLESS with a note, and the remedy is the
 * operator's existing escape hatch (`DELETE /admin/slugs/:slug`, then set the
 * slug). Same posture as the platform-docs seeder.
 *
 * FAIL CLOSED. Every line is validated before anything is applied; a page
 * with ANY invalid line is rejected whole in apply mode (`aborted`). Verify
 * mode still plans the valid records so the operator can see both problems.
 */

import { parseBackupNdjson, type ParsedBackupLine, type InvalidBackupLine, BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_MAX_LIMIT, type BackupCursor, type BackupPhase, base64ToBytes, bytesToBase64, decodeBackupCursor, encodeBackupCursor, nextBackupPhase, parseBackupLimit, RESTORE_MAX_BODY_BYTES } from "./backup-format.js";
import type {
  BackupAgentKeyRecord,
  BackupAgentRecord,
  BackupDocumentRecord,
  BackupOAuthClientRecord,
  BackupSlugTombstoneRecord,
  BackupVersionRecord,
  ErrorCode,
  RestoreAction,
  RestoreOutcome,
  RestoreReport,
} from "./contract.js";
import {
  currentStorageUsedBytes,
  extractDocumentLinks,
  linkSyncStatements,
  parseStoredTags,
  type Prep,
  putVersionBlobs,
  screenAndPrepare,
  serializeTags,
  storageCapBytes,
} from "./core.js";
import type { Env } from "./env.js";
import { sha256Hex } from "./integrity.js";
import { sanitizeTagsInput, validateDescriptionInput, validateTitleInput } from "./metadata.js";
import { OPENAPI_INFO_VERSION } from "./openapi.js";
import { converterVersion, htmlToMarkdown, sanitizerVersion } from "./sanitizer.js";
import { SERVICE_DESC_LINK } from "./serve.js";
import { requireOperator } from "./session.js";
import { deleteDocumentVector, syncDocumentVector, type WaitUntil } from "./vector-io.js";

// ============================================================================
// Shared bits
// ============================================================================

/** Same envelope as admin.ts's — `service-desc` Link on every JSON error. */
function jsonError(status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: code, message, ...extra }, { status, headers: { link: SERVICE_DESC_LINK } });
}

/** A short, value-free tag for a thrown error (D1/R2 messages only — never a
 *  line of the submitted file). */
function errTag(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 200)}`;
  return String(err).slice(0, 200);
}

/** D1's own timestamp shape — the same `NOW_SQL` the write cores use, so a
 *  restore's `updated_at` stamp sorts correctly against every other row. */
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Bound-parameter chunk for `IN (…)` lookups (D1 caps binds per statement). */
const IN_CHUNK = 50;

/** `sql` carries a literal `__IN__` where the placeholders go. Chunked, de-duplicated; no query for an empty list. */
async function selectIn<T>(env: Env, sql: string, values: string[]): Promise<T[]> {
  const uniq = [...new Set(values)];
  const out: T[] = [];
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const chunk = uniq.slice(i, i + IN_CHUNK);
    const res = await env.META.prepare(sql.replace("__IN__", chunk.map(() => "?").join(", "))).bind(...chunk).all<T>();
    out.push(...(res.results ?? []));
  }
  return out;
}

// ============================================================================
// Export — the streaming page walk
// ============================================================================

type AgentRow = { id: string; name: string; created_at: string };
type AgentKeyRow = {
  id: string;
  agent_id: string;
  key_prefix: string;
  key_hash: string;
  revoked_at: string | null;
  expires_at: string | null;
  created_at: string;
};
type OAuthClientRow = { client_id: string; agent_id: string; created_at: string };
type DocumentRow = {
  id: string;
  public_id: string;
  current_ver: number | null;
  published_ver: number | null;
  created_by: string | null;
  created_by_kind: "agent" | "operator";
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  slug: string | null;
  visibility: "public" | "private";
  tags: string | null;
  status: "active" | "deprecated" | "archived";
  superseded_by: string | null;
};
type VersionRow = {
  version_no: number;
  r2_key: string;
  size_bytes: number;
  sanitizer_v: string;
  source_format: "html" | "markdown";
  source_r2_key: string | null;
  source_size_bytes: number | null;
  source_sha256: string | null;
  title: string | null;
  description: string | null;
  author_kind: "agent" | "operator";
  author_agent_id: string | null;
  created_at: string;
};
type LinkRow = { position: number; target_kind: "public_id" | "slug"; target_value: string };
type TombstoneRow = {
  slug: string;
  document_id: string | null;
  retired_at: string;
  reason: string;
  redirect_to: string | null;
};

/** Per phase: the table, its `(ts, id)` walk key, and the projection. Every
 *  phase walks ASCENDING so a restore replays in creation order — agents land
 *  before the keys, clients and documents whose FKs name them. */
const PHASE_SQL: Record<BackupPhase, { table: string; ts: string; id: string; select: string }> = {
  agents: { table: "agents", ts: "created_at", id: "id", select: "id, name, created_at" },
  agent_keys: {
    table: "agent_keys",
    ts: "created_at",
    id: "id",
    select: "id, agent_id, key_prefix, key_hash, revoked_at, expires_at, created_at",
  },
  oauth_clients: { table: "oauth_clients", ts: "created_at", id: "client_id", select: "client_id, agent_id, created_at" },
  documents: {
    table: "documents",
    ts: "created_at",
    id: "id",
    select:
      "id, public_id, current_ver, published_ver, created_by, created_by_kind, revoked_at, created_at, updated_at, slug, visibility, tags, status, superseded_by",
  },
  slug_tombstones: {
    table: "slug_tombstones",
    ts: "retired_at",
    id: "slug",
    select: "slug, document_id, retired_at, reason, redirect_to",
  },
};

async function fetchPhase(
  env: Env,
  phase: BackupPhase,
  after: { ts: string; id: string } | null,
  take: number,
): Promise<Record<string, unknown>[]> {
  const def = PHASE_SQL[phase];
  const binds: unknown[] = [];
  let where = "";
  if (after !== null) {
    where = ` where (${def.ts} > ? or (${def.ts} = ? and ${def.id} > ?))`;
    binds.push(after.ts, after.ts, after.id);
  }
  binds.push(take);
  const sql = `select ${def.select} from ${def.table}${where} order by ${def.ts} asc, ${def.id} asc limit ?`;
  const res = await env.META.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return res.results ?? [];
}

function cursorKeyOf(phase: BackupPhase, row: Record<string, unknown>): { ts: string; id: string } {
  const def = PHASE_SQL[phase];
  return { ts: String(row[def.ts]), id: String(row[def.id]) };
}

/** One unit's records. A document is emitted WITH every version (both blobs
 *  inline) and its link rows, so a page never splits a document. */
async function* emitUnit(env: Env, phase: BackupPhase, row: Record<string, unknown>): AsyncGenerator<string> {
  switch (phase) {
    case "agents": {
      const r = row as AgentRow;
      yield JSON.stringify({ kind: "agent", id: r.id, name: r.name, created_at: r.created_at });
      return;
    }
    case "agent_keys": {
      const r = row as AgentKeyRow;
      yield JSON.stringify({
        kind: "agent_key",
        id: r.id,
        agent_id: r.agent_id,
        key_prefix: r.key_prefix,
        key_hash: r.key_hash,
        revoked_at: r.revoked_at,
        expires_at: r.expires_at,
        created_at: r.created_at,
      });
      return;
    }
    case "oauth_clients": {
      const r = row as OAuthClientRow;
      yield JSON.stringify({ kind: "oauth_client", client_id: r.client_id, agent_id: r.agent_id, created_at: r.created_at });
      return;
    }
    case "slug_tombstones": {
      const r = row as TombstoneRow;
      yield JSON.stringify({
        kind: "slug_tombstone",
        slug: r.slug,
        document_id: r.document_id,
        retired_at: r.retired_at,
        reason: r.reason,
        redirect_to: r.redirect_to,
      });
      return;
    }
    case "documents": {
      const d = row as DocumentRow;
      yield JSON.stringify({
        kind: "document",
        id: d.id,
        public_id: d.public_id,
        current_ver: d.current_ver,
        published_ver: d.published_ver,
        created_by: d.created_by,
        created_by_kind: d.created_by_kind,
        revoked_at: d.revoked_at,
        created_at: d.created_at,
        updated_at: d.updated_at,
        slug: d.slug,
        visibility: d.visibility,
        tags: parseStoredTags(d.tags),
        status: d.status,
        superseded_by: d.superseded_by,
      });
      const versions = await env.META.prepare(
        `select version_no, r2_key, size_bytes, sanitizer_v, source_format, source_r2_key, source_size_bytes,
                source_sha256, title, description, author_kind, author_agent_id, created_at
           from versions where document_id = ? order by version_no asc`,
      )
        .bind(d.id)
        .all<VersionRow>();
      for (const v of versions.results ?? []) {
        let html_b64: string | null = null;
        let source_b64: string | null = null;
        let sha = v.source_sha256;
        // A revoked document's blobs were purged on revoke — nothing to fetch,
        // and the row travels as audit trail. Keys come from the row, never a
        // formula (they carry a per-attempt nonce).
        if (d.revoked_at === null) {
          const h = await env.DOCS.get(v.r2_key);
          if (h !== null) html_b64 = bytesToBase64(new Uint8Array(await h.arrayBuffer()));
          if (v.source_r2_key !== null) {
            const s = await env.DOCS.get(v.source_r2_key);
            if (s !== null) {
              const bytes = new Uint8Array(await s.arrayBuffer());
              source_b64 = bytesToBase64(bytes);
              // Pre-0015 rows have no stored sha; compute it here so the
              // restore's corruption check has something to hold the bytes to.
              if (sha === null) sha = await sha256Hex(bytes);
            }
          }
        }
        yield JSON.stringify({
          kind: "version",
          document_id: d.id,
          version_no: v.version_no,
          size_bytes: v.size_bytes,
          sanitizer_v: v.sanitizer_v,
          source_format: v.source_format,
          source_size_bytes: v.source_size_bytes,
          source_sha256: sha,
          title: v.title,
          description: v.description,
          author_kind: v.author_kind,
          author_agent_id: v.author_agent_id,
          created_at: v.created_at,
          r2_key: v.r2_key,
          source_r2_key: v.source_r2_key,
          html_b64,
          source_b64,
        });
      }
      const links = await env.META.prepare(
        "select position, target_kind, target_value from document_links where src_doc_id = ? order by position asc",
      )
        .bind(d.id)
        .all<LinkRow>();
      for (const l of links.results ?? []) {
        yield JSON.stringify({
          kind: "document_link",
          src_doc_id: d.id,
          position: l.position,
          target_kind: l.target_kind,
          target_value: l.target_value,
        });
      }
      return;
    }
  }
}

async function footerRecord(env: Env): Promise<string> {
  const tables = ["agents", "agent_keys", "oauth_clients", "documents", "versions", "document_links", "slug_tombstones"] as const;
  const rows = await env.META.batch(tables.map((t) => env.META.prepare(`select count(*) as n from ${t}`)));
  const counts: Record<string, number> = {};
  tables.forEach((t, i) => {
    counts[t] = Number((rows[i]?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  });
  return JSON.stringify({ kind: "footer", counts });
}

/**
 * One export page as an async sequence of NDJSON lines (no trailing newline).
 *
 * `limit` counts UNITS (rows for the small tables, whole documents for the
 * documents phase). A page walks phases in order until it has emitted `limit`
 * units or everything is exhausted; the trailer's `next_cursor` names the last
 * unit emitted (or the start of the next phase when a phase ended exactly on
 * the boundary), and is null only after the footer.
 */
export async function* exportBackupPage(
  env: Env,
  cursor: BackupCursor | null,
  limit: number,
  origin: string,
): AsyncGenerator<string> {
  if (cursor === null) {
    yield JSON.stringify({
      kind: "header",
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      instance: origin,
      contract_version: OPENAPI_INFO_VERSION,
      sanitizer_v: sanitizerVersion(),
      converter_v: converterVersion(),
    });
  }

  let phase: BackupPhase = cursor?.phase ?? "agents";
  let after = cursor !== null && cursor.ts !== "" ? { ts: cursor.ts, id: cursor.id } : null;
  let remaining = limit;
  let next: BackupCursor | null = null;
  let done = false;

  while (remaining > 0) {
    const rows = await fetchPhase(env, phase, after, remaining + 1);
    const take = Math.min(rows.length, remaining);
    for (let i = 0; i < take; i++) {
      const row = rows[i]!;
      yield* emitUnit(env, phase, row);
      next = { phase, ...cursorKeyOf(phase, row) };
    }
    remaining -= take;
    if (rows.length <= take) {
      // This phase is exhausted. Move on (an empty ts = "from the start").
      const np = nextBackupPhase(phase);
      if (np === null) {
        done = true;
        next = null;
        break;
      }
      phase = np;
      after = null;
      next = { phase: np, ts: "", id: "" };
    } else if (next !== null) {
      after = { ts: next.ts, id: next.id };
    }
  }

  if (done) yield await footerRecord(env);
  yield JSON.stringify({ kind: "page", next_cursor: done || next === null ? null : encodeBackupCursor(next) });
}

/**
 * GET /admin/backup?cursor=&limit=
 *   → 200 application/x-ndjson (streamed), one page of the corpus backup.
 *
 * Operator-only. Cursor-paginated so every response is bounded; the operator
 * loops until the trailer's `next_cursor` is null (docs/operating.md has the
 * curl loop). A response whose last line is not `{kind:"page"}` was cut
 * short — the stream errors out rather than pretending completeness.
 *
 * Status codes: 200 · 400 bad_limit / bad_cursor · 401 · 403 csrf_failed
 */
export async function exportBackup(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = parseBackupLimit(url.searchParams.get("limit"));
  if (limit === null) {
    return jsonError(400, "bad_limit", `limit must be an integer between 1 and ${BACKUP_MAX_LIMIT}`);
  }
  const cursorRaw = url.searchParams.get("cursor");
  let cursor: BackupCursor | null = null;
  if (cursorRaw) {
    cursor = decodeBackupCursor(cursorRaw);
    if (cursor === null) return jsonError(400, "bad_cursor", "cursor is not a backup cursor (never hand-construct one)");
  }

  const gen = exportBackupPage(env, cursor, limit, url.origin);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(`${value}\n`));
      } catch (err) {
        // Truncate loudly: the consumer sees no `page` trailer and a transport
        // error, never a page that looks complete and isn't.
        console.error("backup.export.failed", errTag(err));
        controller.error(err);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="slopcafe-backup-${stamp}.ndjson"`,
      "x-content-type-options": "nosniff",
    },
  });
}

// ============================================================================
// Restore — the raw-row core
// ============================================================================

export type RestoreMode = "verify" | "apply";
export type RestoreOnConflict = "skip" | "replace";

type Line<T> = { line: number; r: T };

type ExistingDoc = {
  id: string;
  public_id: string;
  revoked_at: string | null;
  current_ver: number | null;
  published_ver: number | null;
  slug: string | null;
};
type ExistingVersion = { document_id: string; version_no: number; r2_key: string; source_r2_key: string | null };

/** A version's plan: its outcome plus, when its bytes will be written, the
 *  re-rendered `prep` (H derived from S) and the normalized metadata. */
type VersionPlan = {
  line: number;
  r: BackupVersionRecord;
  outcome: RestoreOutcome;
  prep: Prep | null;
  title: string | null;
  description: string | null;
  existing: ExistingVersion | null;
};

type DocPlan = {
  line: number;
  r: BackupDocumentRecord;
  outcome: RestoreOutcome;
  existing: ExistingDoc | null;
  /** The slug that will actually be bound (null when retired/taken → note). */
  slug: string | null;
  tags: string[];
  versions: VersionPlan[];
  /** D1 version rows NOT in the page — dropped under `replace` (their blobs purged). */
  extraVersions: ExistingVersion[];
};

const CLEAN: ReadonlySet<RestoreAction> = new Set(["create", "replace", "skip"]);

function outcome(
  line: number,
  kind: RestoreOutcome["kind"],
  key: string | null,
  action: RestoreAction,
  reason?: string,
  notes?: string[],
): RestoreOutcome {
  const o: RestoreOutcome = { line, kind, key, action };
  if (reason !== undefined) o.reason = reason;
  if (notes !== undefined && notes.length > 0) o.notes = notes;
  return o;
}

function normTitle(t: string | null): string | null {
  if (t === null) return null;
  const v = validateTitleInput(t);
  return v.length ? v : null;
}
function normDescription(d: string | null): string | null {
  if (d === null) return null;
  const v = validateDescriptionInput(d);
  return v.length ? v : null;
}

/**
 * Plan (verify) or plan-then-apply (apply) one submitted body. Pure planning
 * first — every record gets an outcome before a single write — then, in apply
 * mode, writes in FK order: agents → keys → clients → documents (each as one
 * unit: rows + re-rendered blobs + FTS + links in one batch) → versions of
 * documents not on the page → tombstones. Vector sync rides `waitUntil`,
 * best-effort, like every write core.
 */
export async function restoreBackupCore(
  env: Env,
  parsed: { records: ParsedBackupLine[]; invalid: InvalidBackupLine[] },
  opts: { mode: RestoreMode; onConflict: RestoreOnConflict },
  origin: string,
  waitUntil?: WaitUntil,
): Promise<RestoreReport> {
  const replace = opts.onConflict === "replace";
  const outcomes: RestoreOutcome[] = [];
  for (const inv of parsed.invalid) outcomes.push(outcome(inv.line, null, null, "invalid", inv.reason));
  const aborted: RestoreReport["aborted"] = parsed.invalid.length > 0 ? "invalid_records" : null;

  // ---- bucket the entity records --------------------------------------------
  const agents: Line<BackupAgentRecord>[] = [];
  const keys: Line<BackupAgentKeyRecord>[] = [];
  const clients: Line<BackupOAuthClientRecord>[] = [];
  const docs: Line<BackupDocumentRecord>[] = [];
  const versions: Line<BackupVersionRecord>[] = [];
  const tombstones: Line<BackupSlugTombstoneRecord>[] = [];
  let linkCount = 0;
  for (const { line, record } of parsed.records) {
    switch (record.kind) {
      case "agent": agents.push({ line, r: record }); break;
      case "agent_key": keys.push({ line, r: record }); break;
      case "oauth_client": clients.push({ line, r: record }); break;
      case "document": docs.push({ line, r: record }); break;
      case "version": versions.push({ line, r: record }); break;
      case "slug_tombstone": tombstones.push({ line, r: record }); break;
      case "document_link": linkCount++; break;
      default: break; // header / footer / page — structural, nothing to restore
    }
  }

  const finish = (): RestoreReport => {
    outcomes.sort((a, b) => a.line - b.line);
    const summary = { create: 0, replace: 0, skip: 0, corrupt: 0, source_unavailable: 0, missing_dependency: 0, rejected: 0, invalid: 0, failed: 0 };
    for (const o of outcomes) summary[o.action]++;
    const ok = aborted === null && outcomes.every((o) => CLEAN.has(o.action));
    return {
      mode: opts.mode,
      on_conflict: opts.onConflict,
      ok,
      aborted,
      records: parsed.records.length + parsed.invalid.length,
      document_links: linkCount,
      outcomes,
      summary,
    };
  };

  // ---- fail closed: a page with an invalid line applies NOTHING ---------------
  if (aborted !== null && opts.mode === "apply") {
    for (const a of agents) outcomes.push(outcome(a.line, "agent", a.r.id, "skip", "page_rejected"));
    for (const k of keys) outcomes.push(outcome(k.line, "agent_key", k.r.id, "skip", "page_rejected"));
    for (const c of clients) outcomes.push(outcome(c.line, "oauth_client", c.r.client_id, "skip", "page_rejected"));
    for (const d of docs) outcomes.push(outcome(d.line, "document", d.r.public_id, "skip", "page_rejected"));
    for (const v of versions) outcomes.push(outcome(v.line, "version", `${v.r.document_id}#v${v.r.version_no}`, "skip", "page_rejected"));
    for (const t of tombstones) outcomes.push(outcome(t.line, "slug_tombstone", t.r.slug, "skip", "page_rejected"));
    return finish();
  }

  // ---- what the database already holds ---------------------------------------
  const agentIds = new Set<string>();
  for (const a of agents) agentIds.add(a.r.id);
  for (const k of keys) agentIds.add(k.r.agent_id);
  for (const c of clients) agentIds.add(c.r.agent_id);
  for (const d of docs) if (d.r.created_by !== null) agentIds.add(d.r.created_by);
  for (const v of versions) if (v.r.author_agent_id !== null) agentIds.add(v.r.author_agent_id);
  const existingAgents = new Set(
    (await selectIn<{ id: string }>(env, "select id from agents where id in (__IN__)", [...agentIds])).map((r) => r.id),
  );
  const existingKeys = new Set(
    (await selectIn<{ id: string }>(env, "select id from agent_keys where id in (__IN__)", keys.map((k) => k.r.id))).map((r) => r.id),
  );
  const existingClientsById = new Map<string, string>();
  const existingClientsByAgent = new Map<string, string>();
  for (const row of await selectIn<{ client_id: string; agent_id: string }>(
    env,
    "select client_id, agent_id from oauth_clients where client_id in (__IN__)",
    clients.map((c) => c.r.client_id),
  )) existingClientsById.set(row.client_id, row.agent_id);
  for (const row of await selectIn<{ client_id: string; agent_id: string }>(
    env,
    "select client_id, agent_id from oauth_clients where agent_id in (__IN__)",
    clients.map((c) => c.r.agent_id),
  )) existingClientsByAgent.set(row.agent_id, row.client_id);

  const docIds = new Set<string>();
  for (const d of docs) docIds.add(d.r.id);
  for (const v of versions) docIds.add(v.r.document_id);
  for (const t of tombstones) if (t.r.document_id !== null) docIds.add(t.r.document_id);
  const DOC_SELECT = "select id, public_id, revoked_at, current_ver, published_ver, slug from documents where";
  const existingDocsById = new Map<string, ExistingDoc>();
  for (const row of await selectIn<ExistingDoc>(env, `${DOC_SELECT} id in (__IN__)`, [...docIds])) existingDocsById.set(row.id, row);
  const existingDocsByPublicId = new Map<string, ExistingDoc>();
  for (const row of await selectIn<ExistingDoc>(env, `${DOC_SELECT} public_id in (__IN__)`, docs.map((d) => d.r.public_id))) {
    existingDocsByPublicId.set(row.public_id, row);
  }
  const existingVersions = new Map<string, ExistingVersion>();
  const existingVersionsByDoc = new Map<string, ExistingVersion[]>();
  for (const row of await selectIn<ExistingVersion>(
    env,
    "select document_id, version_no, r2_key, source_r2_key from versions where document_id in (__IN__)",
    [...docIds],
  )) {
    existingVersions.set(`${row.document_id}#${row.version_no}`, row);
    const list = existingVersionsByDoc.get(row.document_id) ?? [];
    list.push(row);
    existingVersionsByDoc.set(row.document_id, list);
  }

  const slugSet = new Set<string>();
  for (const d of docs) if (d.r.slug !== null) slugSet.add(d.r.slug);
  for (const t of tombstones) slugSet.add(t.r.slug);
  const liveSlugHolders = new Map<string, { id: string; public_id: string }>();
  for (const row of await selectIn<{ slug: string; id: string; public_id: string }>(
    env,
    "select slug, id, public_id from documents where revoked_at is null and slug in (__IN__)",
    [...slugSet],
  )) liveSlugHolders.set(row.slug, { id: row.id, public_id: row.public_id });
  const tombstoned = new Set(
    (await selectIn<{ slug: string }>(env, "select slug from slug_tombstones where slug in (__IN__)", [...slugSet])).map((r) => r.slug),
  );

  // Storage cap, checked ONCE against the fleet total plus what this page
  // would add (the write cores' per-write SUM would be one query per version).
  const cap = storageCapBytes(env);
  let projectedUsed = await currentStorageUsedBytes(env);

  // ---- plan: agents / keys / clients -----------------------------------------
  const pageAgents = new Set<string>();
  for (const a of agents) {
    pageAgents.add(a.r.id);
    const exists = existingAgents.has(a.r.id);
    outcomes.push(outcome(a.line, "agent", a.r.id, exists ? (replace ? "replace" : "skip") : "create", exists && !replace ? "exists" : undefined));
  }
  const agentAvailable = (id: string): boolean => existingAgents.has(id) || pageAgents.has(id);

  const keyPlans: Array<Line<BackupAgentKeyRecord> & { o: RestoreOutcome }> = [];
  for (const k of keys) {
    let o: RestoreOutcome;
    if (!agentAvailable(k.r.agent_id)) o = outcome(k.line, "agent_key", k.r.id, "missing_dependency", `agent ${k.r.agent_id} is in neither the page nor the database`);
    else {
      const exists = existingKeys.has(k.r.id);
      o = outcome(k.line, "agent_key", k.r.id, exists ? (replace ? "replace" : "skip") : "create", exists && !replace ? "exists" : undefined);
    }
    outcomes.push(o);
    keyPlans.push({ ...k, o });
  }

  const clientPlans: Array<Line<BackupOAuthClientRecord> & { o: RestoreOutcome }> = [];
  for (const c of clients) {
    let o: RestoreOutcome;
    if (!agentAvailable(c.r.agent_id)) {
      o = outcome(c.line, "oauth_client", c.r.client_id, "missing_dependency", `agent ${c.r.agent_id} is in neither the page nor the database`);
    } else if (existingClientsById.has(c.r.client_id)) {
      o = outcome(c.line, "oauth_client", c.r.client_id, replace ? "replace" : "skip", replace ? undefined : "exists");
    } else if (existingClientsByAgent.has(c.r.agent_id)) {
      // `oauth_clients.agent_id` is UNIQUE: the agent is already bound to a
      // different client. Never silently re-bind — re-consent is the recovery.
      o = outcome(c.line, "oauth_client", c.r.client_id, "skip", "agent_bound_elsewhere");
    } else {
      o = outcome(c.line, "oauth_client", c.r.client_id, "create");
    }
    outcomes.push(o);
    clientPlans.push({ ...c, o });
  }

  // ---- plan: documents + versions --------------------------------------------
  const versionsByDoc = new Map<string, Line<BackupVersionRecord>[]>();
  for (const v of versions) {
    const list = versionsByDoc.get(v.r.document_id) ?? [];
    list.push(v);
    versionsByDoc.set(v.r.document_id, list);
  }
  const pageDocs = new Map<string, DocPlan>();
  const pageSlugHolders = new Set<string>();
  // `fatal` so undecodable bytes are `corrupt` rather than silently replaced;
  // `ignoreBOM: true` KEEPS a leading BOM in the string (the name is inverted),
  // so re-encoding reproduces the stored source byte-for-byte.
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  /** Plan one version against a known document state. */
  const planVersion = async (
    v: Line<BackupVersionRecord>,
    key: string,
    docLive: boolean,
  ): Promise<VersionPlan> => {
    const existing = existingVersions.get(`${v.r.document_id}#${v.r.version_no}`) ?? null;
    const base: VersionPlan = { line: v.line, r: v.r, outcome: outcome(v.line, "version", key, "skip"), prep: null, title: normTitle(v.r.title), description: normDescription(v.r.description), existing };
    if (v.r.author_agent_id !== null && !agentAvailable(v.r.author_agent_id)) {
      base.outcome = outcome(v.line, "version", key, "missing_dependency", `agent ${v.r.author_agent_id} is in neither the page nor the database`);
      return base;
    }
    const conflictAction: RestoreAction = existing ? (replace ? "replace" : "skip") : "create";
    if (!docLive) {
      // Rows-only audit trail: no bytes to write, recorded keys stored verbatim.
      base.outcome = outcome(v.line, "version", key, conflictAction, conflictAction === "skip" ? "exists" : undefined, ["bytes_absent"]);
      return base;
    }
    if (conflictAction === "skip") {
      // The row stays; the file's bytes are irrelevant to a skip, so they are
      // not judged here. To VALIDATE a backup's bytes, verify with
      // on_conflict=replace — that plans the full re-render and surfaces
      // corrupt / source_unavailable for every version.
      base.outcome = outcome(v.line, "version", key, "skip", "exists");
      return base;
    }
    if (v.r.source_b64 === null) {
      base.outcome = outcome(v.line, "version", key, "source_unavailable", "no retained source (pre-0008) — not restorable; revoke-and-republish");
      return base;
    }
    if (v.r.source_sha256 === null) {
      base.outcome = outcome(v.line, "version", key, "corrupt", "no recorded source_sha256 to verify the source against");
      return base;
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(v.r.source_b64);
    } catch {
      base.outcome = outcome(v.line, "version", key, "corrupt", "source_b64 does not decode");
      return base;
    }
    const actual = await sha256Hex(bytes);
    if (actual !== v.r.source_sha256) {
      base.outcome = outcome(v.line, "version", key, "corrupt", "source bytes do not hash to the recorded source_sha256");
      return base;
    }
    let text: string;
    try {
      text = utf8.decode(bytes);
    } catch {
      base.outcome = outcome(v.line, "version", key, "corrupt", "source is not valid UTF-8");
      return base;
    }
    // THE RENDER RULE: H is re-derived from S here, never read from the file.
    const screened = screenAndPrepare(text, v.r.source_format);
    if (!screened.ok) {
      base.outcome = outcome(v.line, "version", key, "rejected", `re-render refused: ${screened.code}`);
      return base;
    }
    const writeBytes = screened.prep.cleanedBytes.byteLength + screened.prep.sourceBytes.byteLength;
    if (projectedUsed + writeBytes > cap) {
      base.outcome = outcome(v.line, "version", key, "rejected", "storage_cap_exceeded");
      return base;
    }
    projectedUsed += writeBytes;
    base.prep = screened.prep;
    base.outcome = outcome(v.line, "version", key, conflictAction);
    return base;
  };

  for (const d of docs) {
    const rec = d.r;
    const byId = existingDocsById.get(rec.id);
    const byPub = existingDocsByPublicId.get(rec.public_id);
    const plan: DocPlan = { line: d.line, r: rec, outcome: outcome(d.line, "document", rec.public_id, "skip"), existing: byId ?? null, slug: rec.slug, tags: sanitizeTagsInput(rec.tags), versions: [], extraVersions: [] };
    pageDocs.set(rec.id, plan);
    const pageVersions = versionsByDoc.get(rec.id) ?? [];
    versionsByDoc.delete(rec.id);
    const notes: string[] = [];

    if ((byId && byId.public_id !== rec.public_id) || (byPub && byPub.id !== rec.id)) {
      plan.outcome = outcome(d.line, "document", rec.public_id, "rejected", "identity_conflict: the database binds this id/public_id pair differently — never guessed");
      for (const v of pageVersions) plan.versions.push({ line: v.line, r: v.r, outcome: outcome(v.line, "version", `${rec.public_id}#v${v.r.version_no}`, "skip", "document_rejected"), prep: null, title: null, description: null, existing: null });
    } else if (rec.created_by !== null && !agentAvailable(rec.created_by)) {
      plan.outcome = outcome(d.line, "document", rec.public_id, "missing_dependency", `agent ${rec.created_by} is in neither the page nor the database`);
      for (const v of pageVersions) plan.versions.push({ line: v.line, r: v.r, outcome: outcome(v.line, "version", `${rec.public_id}#v${v.r.version_no}`, "skip", "document_rejected"), prep: null, title: null, description: null, existing: null });
    } else {
      const exists = byId !== undefined;
      const action: RestoreAction = exists ? (replace ? "replace" : "skip") : "create";
      const docLive = rec.revoked_at === null;

      if (action === "skip") {
        // The row stays as it is; versions the database lacks are still added
        // (the "a version went missing" recovery), against the DB's own state.
        plan.slug = byId!.slug;
        for (const v of pageVersions) {
          plan.versions.push(await planVersion(v, `${rec.public_id}#v${v.r.version_no}`, byId!.revoked_at === null));
        }
        plan.outcome = outcome(d.line, "document", rec.public_id, "skip", "exists");
      } else {
        // Slug: never release a tombstone, never take a live name from another
        // document. The document comes back slugless with a note either way.
        if (rec.slug !== null) {
          const holder = liveSlugHolders.get(rec.slug);
          if (holder && holder.id !== rec.id) {
            notes.push(`slug_taken:${rec.slug}`);
            plan.slug = null;
          } else if (tombstoned.has(rec.slug)) {
            notes.push(`slug_retired:${rec.slug}`);
            plan.slug = null;
          } else if (pageSlugHolders.has(rec.slug)) {
            notes.push(`slug_taken:${rec.slug}`);
            plan.slug = null;
          }
        }
        for (const v of pageVersions) {
          plan.versions.push(await planVersion(v, `${rec.public_id}#v${v.r.version_no}`, docLive));
        }
        // A live document must come back renderable: its current (and, if
        // public, its published) version must be one this page will write.
        let reject: string | null = null;
        if (docLive) {
          const need = (n: number | null, label: string): void => {
            if (n === null || reject !== null) return;
            const vp = plan.versions.find((x) => x.r.version_no === n);
            if (!vp) reject = `${label}_unrestorable: v${n} is not on this page`;
            else if (vp.prep === null) reject = `${label}_unrestorable: v${n} is ${vp.outcome.action}`;
          };
          need(rec.current_ver, "current_version");
          need(rec.published_ver, "published_version");
        }
        if (reject !== null) {
          plan.outcome = outcome(d.line, "document", rec.public_id, "rejected", reject);
          for (const vp of plan.versions) {
            if (CLEAN.has(vp.outcome.action)) vp.outcome = outcome(vp.line, "version", vp.outcome.key, "skip", "document_rejected");
            vp.prep = null;
          }
        } else {
          if (replace && exists) {
            const pageNos = new Set(pageVersions.map((v) => v.r.version_no));
            plan.extraVersions = (existingVersionsByDoc.get(rec.id) ?? []).filter((ev) => !pageNos.has(ev.version_no));
            if (plan.extraVersions.length > 0) {
              notes.push(`drops_versions:${plan.extraVersions.map((ev) => ev.version_no).sort((a, b) => a - b).join(",")}`);
            }
          }
          if (!docLive) notes.push("restored_revoked");
          if (plan.slug !== null) pageSlugHolders.add(plan.slug);
          plan.outcome = outcome(d.line, "document", rec.public_id, action, undefined, notes);
        }
      }
    }
    outcomes.push(plan.outcome);
    for (const vp of plan.versions) outcomes.push(vp.outcome);
  }

  // Versions whose document is NOT on this page: restorable only into an
  // existing document, against its current state.
  const standalone = new Map<string, VersionPlan[]>();
  for (const [docId, list] of versionsByDoc) {
    const existing = existingDocsById.get(docId);
    for (const v of list) {
      if (!existing) {
        outcomes.push(outcome(v.line, "version", `${docId}#v${v.r.version_no}`, "missing_dependency", "document is in neither the page nor the database"));
        continue;
      }
      const vp = await planVersion(v, `${existing.public_id}#v${v.r.version_no}`, existing.revoked_at === null);
      outcomes.push(vp.outcome);
      const arr = standalone.get(docId) ?? [];
      arr.push(vp);
      standalone.set(docId, arr);
    }
  }

  // ---- plan: tombstones ------------------------------------------------------
  const tombPlans: Array<Line<BackupSlugTombstoneRecord> & { o: RestoreOutcome; documentId: string | null }> = [];
  for (const t of tombstones) {
    let documentId = t.r.document_id;
    const notes: string[] = [];
    let o: RestoreOutcome;
    if (liveSlugHolders.has(t.r.slug) || pageSlugHolders.has(t.r.slug)) {
      o = outcome(t.line, "slug_tombstone", t.r.slug, "skip", "slug_live");
    } else {
      if (documentId !== null && !existingDocsById.has(documentId) && !pageDocs.has(documentId)) {
        notes.push("document_missing");
        documentId = null;
      }
      const exists = tombstoned.has(t.r.slug);
      o = outcome(t.line, "slug_tombstone", t.r.slug, exists ? (replace ? "replace" : "skip") : "create", exists && !replace ? "exists" : undefined, notes);
    }
    outcomes.push(o);
    tombPlans.push({ ...t, o, documentId });
  }

  if (opts.mode === "verify") return finish();

  // ==== APPLY ================================================================
  const writes = (o: RestoreOutcome): boolean => o.action === "create" || o.action === "replace";
  const fail = (o: RestoreOutcome, err: unknown): void => {
    o.action = "failed";
    o.reason = errTag(err);
  };

  for (const a of agents) {
    const o = outcomes.find((x) => x.line === a.line)!;
    if (!writes(o)) continue;
    try {
      await env.META.prepare(
        "insert into agents (id, name, created_at) values (?, ?, ?) on conflict(id) do update set name = excluded.name, created_at = excluded.created_at",
      ).bind(a.r.id, a.r.name, a.r.created_at).run();
    } catch (err) { fail(o, err); }
  }
  for (const k of keyPlans) {
    if (!writes(k.o)) continue;
    try {
      await env.META.prepare(
        `insert into agent_keys (id, agent_id, key_prefix, key_hash, revoked_at, expires_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set agent_id = excluded.agent_id, key_prefix = excluded.key_prefix,
           key_hash = excluded.key_hash, revoked_at = excluded.revoked_at, expires_at = excluded.expires_at,
           created_at = excluded.created_at`,
      ).bind(k.r.id, k.r.agent_id, k.r.key_prefix, k.r.key_hash, k.r.revoked_at, k.r.expires_at, k.r.created_at).run();
    } catch (err) { fail(k.o, err); }
  }
  for (const c of clientPlans) {
    if (!writes(c.o)) continue;
    try {
      await env.META.prepare(
        `insert into oauth_clients (client_id, agent_id, created_at) values (?, ?, ?)
         on conflict(client_id) do update set agent_id = excluded.agent_id, created_at = excluded.created_at`,
      ).bind(c.r.client_id, c.r.agent_id, c.r.created_at).run();
    } catch (err) { fail(c.o, err); }
  }

  const versionUpsert = (docId: string, vp: VersionPlan, r2Key: string, sourceR2Key: string | null, sizeBytes: number, sanitizerV: string, sourceSize: number | null, sha: string | null): D1PreparedStatement =>
    env.META.prepare(
      `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v, source_format, source_r2_key,
                             source_size_bytes, source_sha256, title, description, author_kind, author_agent_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(document_id, version_no) do update set r2_key = excluded.r2_key, size_bytes = excluded.size_bytes,
         sanitizer_v = excluded.sanitizer_v, source_format = excluded.source_format, source_r2_key = excluded.source_r2_key,
         source_size_bytes = excluded.source_size_bytes, source_sha256 = excluded.source_sha256, title = excluded.title,
         description = excluded.description, author_kind = excluded.author_kind, author_agent_id = excluded.author_agent_id,
         created_at = excluded.created_at`,
    ).bind(docId, vp.r.version_no, r2Key, sizeBytes, sanitizerV, vp.r.source_format, sourceR2Key, sourceSize, sha, vp.title, vp.description, vp.r.author_kind, vp.r.author_agent_id, vp.r.created_at);

  /** Write the blobs for every version of a unit that carries a re-render;
   *  returns the statements + the keys written (for rollback) and to purge. */
  const writeVersionBlobs = async (
    docId: string,
    plans: VersionPlan[],
  ): Promise<{ statements: D1PreparedStatement[]; newKeys: string[]; oldKeys: string[] }> => {
    const statements: D1PreparedStatement[] = [];
    const newKeys: string[] = [];
    const oldKeys: string[] = [];
    for (const vp of plans) {
      if (!writes(vp.outcome)) continue;
      if (vp.prep !== null) {
        const author = vp.r.author_kind === "operator" ? { kind: "operator" as const } : { kind: "agent" as const, agentId: vp.r.author_agent_id };
        const { r2Key, sourceR2Key } = await putVersionBlobs(env, docId, vp.r.version_no, vp.prep, author);
        newKeys.push(r2Key, sourceR2Key);
        if (vp.existing) {
          oldKeys.push(vp.existing.r2_key);
          if (vp.existing.source_r2_key !== null) oldKeys.push(vp.existing.source_r2_key);
        }
        const sha = await sha256Hex(vp.prep.sourceBytes);
        statements.push(versionUpsert(docId, vp, r2Key, sourceR2Key, vp.prep.cleanedBytes.byteLength, vp.prep.sanitizerV, vp.prep.sourceBytes.byteLength, sha));
      } else {
        // Rows-only (revoked document): the recorded keys are dead pointers,
        // stored verbatim as the audit trail a revoke leaves behind.
        statements.push(versionUpsert(docId, vp, vp.r.r2_key, vp.r.source_r2_key, vp.r.size_bytes, vp.r.sanitizer_v, vp.r.source_size_bytes, vp.r.source_sha256));
      }
    }
    return { statements, newKeys, oldKeys };
  };

  const purge = async (keys: string[]): Promise<void> => {
    if (keys.length === 0) return;
    await env.DOCS.delete(keys).catch((err: unknown) => console.error("backup.restore.purge_failed", errTag(err)));
  };

  const derivedStatements = (docId: string, publicId: string, slug: string | null, title: string | null, description: string | null, html: string): { statements: D1PreparedStatement[]; body: string } => {
    const body = htmlToMarkdown(html);
    return {
      body,
      statements: [
        env.META.prepare("delete from documents_fts where document_id = ?").bind(docId),
        env.META.prepare("insert into documents_fts (document_id, title, description, body) values (?, ?, ?, ?)").bind(docId, title, description, body),
        ...linkSyncStatements(env, docId, extractDocumentLinks(html, origin, { publicId, slug })),
      ],
    };
  };

  for (const plan of pageDocs.values()) {
    if (!writes(plan.outcome)) {
      // A skipped-but-existing document may still gain versions the DB lacked.
      if (plan.outcome.action === "skip" && plan.existing && plan.versions.some((vp) => writes(vp.outcome))) {
        const list = standalone.get(plan.r.id) ?? [];
        standalone.set(plan.r.id, [...list, ...plan.versions.filter((vp) => writes(vp.outcome))]);
      }
      continue;
    }
    const rec = plan.r;
    const docLive = rec.revoked_at === null;
    let newKeys: string[] = [];
    try {
      const blobs = await writeVersionBlobs(rec.id, plan.versions);
      newKeys = blobs.newKeys;
      const statements: D1PreparedStatement[] = [];
      const tagsJson = serializeTags(plan.tags);
      if (plan.existing) {
        statements.push(
          env.META.prepare(
            `update documents set public_id = ?, current_ver = ?, published_ver = ?, created_by = ?, created_by_kind = ?,
               revoked_at = ?, created_at = ?, updated_at = ${NOW_SQL}, slug = ?, visibility = ?, tags = ?, status = ?, superseded_by = ?
             where id = ?`,
          ).bind(rec.public_id, rec.current_ver, rec.published_ver, rec.created_by, rec.created_by_kind, rec.revoked_at, rec.created_at, plan.slug, rec.visibility, tagsJson, rec.status, rec.superseded_by, rec.id),
        );
      } else {
        statements.push(
          env.META.prepare(
            `insert into documents (id, public_id, current_ver, published_ver, created_by, created_by_kind, revoked_at, created_at,
                                    updated_at, slug, visibility, tags, status, superseded_by)
             values (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_SQL}, ?, ?, ?, ?, ?)`,
          ).bind(rec.id, rec.public_id, rec.current_ver, rec.published_ver, rec.created_by, rec.created_by_kind, rec.revoked_at, rec.created_at, plan.slug, rec.visibility, tagsJson, rec.status, rec.superseded_by),
        );
      }
      for (const ev of plan.extraVersions) {
        statements.push(env.META.prepare("delete from versions where document_id = ? and version_no = ?").bind(rec.id, ev.version_no));
      }
      statements.push(...blobs.statements);
      let vectorBody: { title: string | null; description: string | null; body: string } | null = null;
      if (docLive) {
        const cur = plan.versions.find((vp) => vp.r.version_no === rec.current_ver)!;
        const derived = derivedStatements(rec.id, rec.public_id, plan.slug, cur.title, cur.description, cur.prep!.cleanedHtml);
        statements.push(...derived.statements);
        vectorBody = { title: cur.title, description: cur.description, body: derived.body };
      } else {
        statements.push(
          env.META.prepare("delete from documents_fts where document_id = ?").bind(rec.id),
          env.META.prepare("delete from document_links where src_doc_id = ?").bind(rec.id),
        );
      }
      await env.META.batch(statements);
      // Committed: purge the blobs this unit replaced (its own old keys only)
      // and any dropped extra versions'. Best-effort — orphaned R2 objects are
      // waste, not a correctness fault.
      const toPurge = [...blobs.oldKeys];
      for (const ev of plan.extraVersions) {
        toPurge.push(ev.r2_key);
        if (ev.source_r2_key !== null) toPurge.push(ev.source_r2_key);
      }
      await purge(toPurge);
      if (waitUntil) {
        if (vectorBody !== null) waitUntil(syncDocumentVector(env, rec.id, vectorBody.title, vectorBody.description, vectorBody.body));
        else waitUntil(deleteDocumentVector(env, rec.id));
      }
    } catch (err) {
      // Roll back the bytes THIS unit wrote (fresh nonced keys — never another
      // writer's), then report the whole unit failed.
      await purge(newKeys);
      fail(plan.outcome, err);
      for (const vp of plan.versions) if (writes(vp.outcome)) fail(vp.outcome, err);
    }
  }

  for (const [docId, plans] of standalone) {
    const existing = existingDocsById.get(docId)!;
    let newKeys: string[] = [];
    try {
      const blobs = await writeVersionBlobs(docId, plans);
      newKeys = blobs.newKeys;
      if (blobs.statements.length > 0) await env.META.batch(blobs.statements);
      await purge(blobs.oldKeys);
      if (existing.revoked_at === null) {
        // Derived state follows the DB's current version, whichever that is;
        // its H is read back from R2 by the row's key.
        const cur = await env.META.prepare(
          `select d.public_id, d.slug, v.r2_key, v.title, v.description from documents d
             join versions v on v.document_id = d.id and v.version_no = d.current_ver
            where d.id = ? and d.revoked_at is null`,
        ).bind(docId).first<{ public_id: string; slug: string | null; r2_key: string; title: string | null; description: string | null }>();
        const obj = cur ? await env.DOCS.get(cur.r2_key) : null;
        if (cur && obj !== null) {
          const html = await obj.text();
          const derived = derivedStatements(docId, cur.public_id, cur.slug, cur.title, cur.description, html);
          await env.META.batch(derived.statements);
          if (waitUntil) waitUntil(syncDocumentVector(env, docId, cur.title, cur.description, derived.body));
        }
      }
    } catch (err) {
      await purge(newKeys);
      for (const vp of plans) if (writes(vp.outcome)) fail(vp.outcome, err);
    }
  }

  for (const t of tombPlans) {
    if (!writes(t.o)) continue;
    try {
      await env.META.prepare(
        `insert into slug_tombstones (slug, document_id, retired_at, reason, redirect_to) values (?, ?, ?, ?, ?)
         on conflict(slug) do update set document_id = excluded.document_id, retired_at = excluded.retired_at,
           reason = excluded.reason, redirect_to = excluded.redirect_to`,
      ).bind(t.r.slug, t.documentId, t.r.retired_at, t.r.reason, t.r.redirect_to).run();
    } catch (err) { fail(t.o, err); }
  }

  return finish();
}

/**
 * POST /admin/restore?mode=verify|apply&on_conflict=skip|replace
 *   body: one NDJSON backup page (or several concatenated)
 *   → 200 RestoreReport (every outcome clean) | 207 RestoreReport (`ok: false`)
 *
 * `mode` defaults to `verify` — applying must be explicit. `on_conflict`
 * defaults to `skip`; `replace` is what resurrects a revoked document.
 *
 * Status codes: 200 · 207 · 400 bad_request (bad mode/on_conflict, empty body)
 *   · 401 · 403 csrf_failed · 413 too_large
 */
export async function restoreBackup(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const url = new URL(req.url);
  const modeRaw = url.searchParams.get("mode") || "verify";
  if (modeRaw !== "verify" && modeRaw !== "apply") return jsonError(400, "bad_request", `mode must be "verify" or "apply"`);
  const ocRaw = url.searchParams.get("on_conflict") || "skip";
  if (ocRaw !== "skip" && ocRaw !== "replace") return jsonError(400, "bad_request", `on_conflict must be "skip" or "replace"`);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > RESTORE_MAX_BODY_BYTES) {
    return jsonError(413, "too_large", `restore body exceeds ${RESTORE_MAX_BODY_BYTES} bytes — submit fewer pages per call`, { limit: RESTORE_MAX_BODY_BYTES });
  }
  const text = await req.text();
  if (text.length > RESTORE_MAX_BODY_BYTES) {
    return jsonError(413, "too_large", `restore body exceeds ${RESTORE_MAX_BODY_BYTES} bytes — submit fewer pages per call`, { limit: RESTORE_MAX_BODY_BYTES });
  }
  if (text.trim() === "") return jsonError(400, "bad_request", "empty body — send one or more NDJSON backup pages");

  const parsed = parseBackupNdjson(text);
  const report = await restoreBackupCore(env, parsed, { mode: modeRaw, onConflict: ocRaw }, url.origin, ctx.waitUntil.bind(ctx));
  return Response.json(report, { status: report.ok ? 200 : 207 });
}
