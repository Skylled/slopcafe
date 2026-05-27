/**
 * Core write/read/list/revoke operations against D1 + R2, without any
 * Request/Response or auth coupling. The caller (HTTP handler in
 * src/index.ts or MCP tool in src/mcp.ts) is responsible for resolving an
 * agent identity; these functions trust the `agentId` they receive and
 * stamp it as the document creator / version author.
 *
 * Two callers, one path: sanitization runs exactly once, inside core,
 * regardless of which surface the bytes arrived through. This is the
 * extraction promised in plans/playful-stirring-deer.md §"Step 8".
 */

import type { Env } from "./env.js";
import { newPublicId, newUuid } from "./ids.js";
import { sanitize, sanitizerVersion } from "./sanitizer.js";
import { PUBLIC_ID_RE } from "./serve.js";

/** Per-document raw input cap. The per-fleet storage cap is enforced separately. */
export const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Shared "successful write" shape — same for publish and update. */
export type WriteOk = {
  ok: true;
  public_id: string;
  url: string;
  version: number;
  size_bytes: number;
  sanitizer_v: string;
  modified: boolean;
};

/** Result codes the wrappers translate to HTTP statuses / model-readable text. */
export type PublishErr =
  | { ok: false; code: "empty_body" }
  | { ok: false; code: "too_large"; limit: number; size: number }
  | { ok: false; code: "storage_cap_exceeded"; used: number; cap: number; this_write: number };

export type UpdateErr =
  | PublishErr
  | { ok: false; code: "not_found" }
  | { ok: false; code: "version_conflict"; current_version: number; expected: number };

/**
 * Global storage cap. Sums `size_bytes` across every non-revoked version,
 * regardless of which agent created the document — v1 is single-operator,
 * so the cap is a fleet-wide guardrail rather than a per-agent quota.
 *
 * Best-effort: the SUM runs outside the insert batch, so two concurrent
 * writes can both pass the check. v1 accepts the slight overrun.
 */
export async function checkStorageCap(
  env: Env,
  addBytes: number,
): Promise<{ ok: true } | { ok: false; used: number; cap: number }> {
  const cap = Number(env.STORAGE_CAP_BYTES);
  const row = await env.META.prepare(
    `select coalesce(sum(v.size_bytes), 0) as used
     from versions v
     join documents d on d.id = v.document_id
     where d.revoked_at is null`,
  ).first<{ used: number }>();
  const used = Number(row?.used ?? 0);
  if (used + addBytes > cap) return { ok: false, used, cap };
  return { ok: true };
}

/**
 * Sanitize, cap-check, write to R2, stamp D1. Creates a fresh document at
 * version 1. The caller must have already resolved `agentId` from whichever
 * door (bearer or OAuth) the request came in through.
 *
 * `origin` is the URL prefix used to mint `url` (e.g. "https://host"). We
 * accept it as a parameter so core never needs to touch a Request.
 */
export async function publishDocumentCore(
  env: Env,
  html: string,
  agentId: string,
  origin: string,
): Promise<WriteOk | PublishErr> {
  if (html.length === 0) return { ok: false, code: "empty_body" };

  // Reject oversize *input* up front — matches the existing HTTP path,
  // which 413s on raw req.arrayBuffer() bytes before decoding. The MCP
  // path has no Request to pre-check, so the cap is enforced here.
  const inputBytes = new TextEncoder().encode(html);
  if (inputBytes.byteLength > MAX_INPUT_BYTES) {
    return { ok: false, code: "too_large", limit: MAX_INPUT_BYTES, size: inputBytes.byteLength };
  }

  // Sanitize so the cap check reflects what would actually be stored.
  const cleanedHtml = sanitize(html);
  const cleanedBytes = new TextEncoder().encode(cleanedHtml);
  const sanitizerV = sanitizerVersion();

  const capCheck = await checkStorageCap(env, cleanedBytes.byteLength);
  if (!capCheck.ok) {
    return {
      ok: false,
      code: "storage_cap_exceeded",
      used: capCheck.used,
      cap: capCheck.cap,
      this_write: cleanedBytes.byteLength,
    };
  }

  const docId = newUuid();
  const publicId = newPublicId();
  const versionNo = 1;
  const r2Key = `${docId}/v${versionNo}`;

  // R2 first. If the D1 batch fails we attempt to delete the blob so we
  // don't accumulate orphans. R2 keys are unique per (docId, version), so a
  // retry harmlessly overwrites.
  await env.DOCS.put(r2Key, cleanedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      document_id: docId,
      version: String(versionNo),
      sanitizer_v: sanitizerV,
      agent_id: agentId,
    },
  });

  try {
    await env.META.batch([
      env.META.prepare(
        "insert into documents (id, public_id, created_by) values (?, ?, ?)",
      ).bind(docId, publicId, agentId),
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v)
         values (?, ?, ?, ?, ?)`,
      ).bind(docId, versionNo, r2Key, cleanedBytes.byteLength, sanitizerV),
      env.META.prepare("update documents set current_ver = ? where id = ?").bind(
        versionNo,
        docId,
      ),
    ]);
  } catch (err) {
    await env.DOCS.delete(r2Key).catch(() => {
      /* best effort; surfaced via logs if it matters */
    });
    throw err;
  }

  return {
    ok: true,
    public_id: publicId,
    url: `${origin}/d/${publicId}`,
    version: versionNo,
    size_bytes: cleanedBytes.byteLength,
    sanitizer_v: sanitizerV,
    modified: html !== cleanedHtml,
  };
}

/**
 * Append a new version to an existing document. `expectedVersion`:
 *   - number   → fail with `version_conflict` if the current version differs.
 *   - null     → clobber (skip the version check, last-write-wins).
 *
 * Cross-agent writes are intentional per the single-tenant trust model
 * documented in updateDocument's wrapper. The caller's `agentId` is
 * stamped onto the new version (R2 customMetadata only; `documents.created_by`
 * retains the original creator).
 */
export async function updateDocumentCore(
  env: Env,
  publicId: string,
  html: string,
  expectedVersion: number | null,
  agentId: string,
  origin: string,
): Promise<WriteOk | UpdateErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  if (html.length === 0) return { ok: false, code: "empty_body" };

  // Look up document + current version + revoked state in one go.
  const row = await env.META.prepare(
    "select id, current_ver, revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ id: string; current_ver: number | null; revoked_at: string | null }>();
  if (!row || row.revoked_at || row.current_ver === null) {
    return { ok: false, code: "not_found" };
  }

  if (expectedVersion !== null && expectedVersion !== row.current_ver) {
    return {
      ok: false,
      code: "version_conflict",
      current_version: row.current_ver,
      expected: expectedVersion,
    };
  }

  const inputBytes = new TextEncoder().encode(html);
  if (inputBytes.byteLength > MAX_INPUT_BYTES) {
    return { ok: false, code: "too_large", limit: MAX_INPUT_BYTES, size: inputBytes.byteLength };
  }

  const cleanedHtml = sanitize(html);
  const cleanedBytes = new TextEncoder().encode(cleanedHtml);
  const sanitizerV = sanitizerVersion();

  const capCheck = await checkStorageCap(env, cleanedBytes.byteLength);
  if (!capCheck.ok) {
    return {
      ok: false,
      code: "storage_cap_exceeded",
      used: capCheck.used,
      cap: capCheck.cap,
      this_write: cleanedBytes.byteLength,
    };
  }

  const nextVer = row.current_ver + 1;
  const r2Key = `${row.id}/v${nextVer}`;

  await env.DOCS.put(r2Key, cleanedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      document_id: row.id,
      version: String(nextVer),
      sanitizer_v: sanitizerV,
      agent_id: agentId,
    },
  });

  try {
    await env.META.batch([
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v)
         values (?, ?, ?, ?, ?)`,
      ).bind(row.id, nextVer, r2Key, cleanedBytes.byteLength, sanitizerV),
      env.META.prepare("update documents set current_ver = ? where id = ?").bind(nextVer, row.id),
    ]);
  } catch (err) {
    await env.DOCS.delete(r2Key).catch(() => {
      /* best effort; D1 is the source of truth */
    });
    throw err;
  }

  return {
    ok: true,
    public_id: publicId,
    url: `${origin}/d/${publicId}`,
    version: nextVer,
    size_bytes: cleanedBytes.byteLength,
    sanitizer_v: sanitizerV,
    modified: html !== cleanedHtml,
  };
}

/** Read the current version's bytes for the given public_id, buffered. */
export type ReadOk = {
  ok: true;
  bytes: Uint8Array;
  version_no: number;
  sanitizer_v: string;
};
export type ReadErr = { ok: false; code: "not_found" };

/**
 * Fetch the current version's sanitized HTML, buffered into memory.
 *
 * The browser path (`serveRaw` in src/serve.ts) streams R2 directly to
 * avoid buffering — different consumer, different needs. The MCP tool
 * needs the bytes in-process to return as text content, so we buffer here.
 */
export async function readDocumentCore(
  env: Env,
  publicId: string,
): Promise<ReadOk | ReadErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  const row = await env.META.prepare(
    `select d.revoked_at, v.r2_key, v.version_no, v.sanitizer_v
     from documents d
     join versions v on v.document_id = d.id and v.version_no = d.current_ver
     where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{ revoked_at: string | null; r2_key: string; version_no: number; sanitizer_v: string }>();
  if (!row || row.revoked_at) return { ok: false, code: "not_found" };

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return { ok: false, code: "not_found" }; // D1 says it should exist; treat as gone.

  const buf = await obj.arrayBuffer();
  return {
    ok: true,
    bytes: new Uint8Array(buf),
    version_no: row.version_no,
    sanitizer_v: row.sanitizer_v,
  };
}

/** Listing row shape — same columns as GET /admin/documents today. */
export type DocumentListing = {
  public_id: string;
  current_ver: number | null;
  created_at: string;
  created_by_id: string | null;
  created_by_name: string | null;
  current_size: number | null;
  revoked_at: string | null;
};

/**
 * List documents (including revoked). v1 has no pagination; LIST_LIMIT
 * keeps the response bounded.
 *
 * Single-tenant trust model: any caller (operator or any agent) sees the
 * full fleet. If per-agent filtering becomes a need, add a `createdBy?`
 * arg here and a `WHERE created_by = ?` clause.
 */
export async function listDocumentsCore(env: Env): Promise<{ documents: DocumentListing[] }> {
  const LIST_LIMIT = 200;
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
    .all<DocumentListing>();
  return { documents: rows.results ?? [] };
}

export type RevokeOk = { ok: true; public_id: string; r2_objects_purged: number };
export type RevokeErr = { ok: false; code: "not_found" };

/**
 * Operator kill switch for a single document. Marks `revoked_at` first so
 * the doc is unreachable instantly, then purges every version's R2 object.
 * Keeps `versions` rows as an audit trail; bytes are the irrecoverable part.
 */
export async function revokeDocumentCore(
  env: Env,
  publicId: string,
): Promise<RevokeOk | RevokeErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  const row = await env.META.prepare(
    "select id, revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ id: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) return { ok: false, code: "not_found" };

  const versions = await env.META.prepare(
    "select r2_key from versions where document_id = ? order by version_no",
  )
    .bind(row.id)
    .all<{ r2_key: string }>();
  const r2Keys = (versions.results ?? []).map((v) => v.r2_key);

  // Mark revoked BEFORE purging R2 so the doc is unreachable instantly,
  // even if the bucket call hangs or fails.
  await env.META.prepare(
    "update documents set revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), current_ver = null where id = ?",
  )
    .bind(row.id)
    .run();

  if (r2Keys.length > 0) {
    await env.DOCS.delete(r2Keys);
  }

  return { ok: true, public_id: publicId, r2_objects_purged: r2Keys.length };
}
