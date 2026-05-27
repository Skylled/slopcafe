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

import { detectAdvisories } from "./advisories.js";
import type { Env } from "./env.js";
import { newPublicId, newUuid } from "./ids.js";
import {
  converterVersion,
  htmlToMarkdown,
  markdownToHtml,
  sanitize,
  sanitizerVersion,
} from "./sanitizer.js";
import { PUBLIC_ID_RE } from "./serve.js";

/** Per-document raw input cap. The per-fleet storage cap is enforced separately. */
export const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Which input format the caller sent. Stored on the versions row as
 * `source_format` so admin/list views can show provenance without inspecting
 * the bytes. The stored R2 blob is always sanitized HTML — convert-and-discard
 * is the v1 model — but knowing what the agent originally authored is useful.
 *
 * The trust boundary is identical for both: sanitize() runs on the
 * post-conversion HTML regardless of source format.
 */
export type SourceFormat = "html" | "markdown";

/** Shared "successful write" shape — same for publish and update. */
export type WriteOk = {
  ok: true;
  public_id: string;
  url: string;
  version: number;
  size_bytes: number;
  sanitizer_v: string;
  modified: boolean;
  /**
   * Short, human/agent-readable summaries of constructs the sanitizer
   * removed. Empty array when `modified: false` (and usually empty even
   * when modified, if the change was something we don't pattern-match —
   * advisory is best-effort). See src/advisories.ts.
   */
  stripped: string[];
  /**
   * Constructs that survived the sanitizer but the iframe CSP will refuse
   * to load (currently: external <img src>). Without this the agent has
   * no signal at all — `modified: false` and a broken-image render.
   */
  will_not_render: string[];
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
 * Convert (if needed) → sanitize → measure. Used by both write paths so
 * the (conversion-then-trust-boundary) order is encoded in one place.
 *
 * For markdown input the conversion is `pulldown-cmark` + GFM extensions;
 * for html input the conversion is the identity. `sanitize()` always runs
 * on the resulting HTML, so neither door bypasses the allowlist.
 *
 * The `modified` flag and advisories compare against the POST-CONVERSION
 * HTML, not the raw input. For a Markdown caller that's the meaningful
 * question — "did the sanitizer touch the HTML my Markdown produced?" —
 * since the conversion itself is always a transformation by definition.
 */
function prepareForStorage(body: string, format: SourceFormat): {
  cleanedHtml: string;
  cleanedBytes: Uint8Array;
  sanitizerV: string;
  modified: boolean;
  stripped: string[];
  will_not_render: string[];
} {
  const asHtml = format === "markdown" ? markdownToHtml(body) : body;
  const cleanedHtml = sanitize(asHtml);
  const cleanedBytes = new TextEncoder().encode(cleanedHtml);
  const advisories = detectAdvisories(asHtml, cleanedHtml);
  return {
    cleanedHtml,
    cleanedBytes,
    sanitizerV: sanitizerVersion(),
    modified: asHtml !== cleanedHtml,
    stripped: advisories.stripped,
    will_not_render: advisories.will_not_render,
  };
}

/**
 * Sanitize, cap-check, write to R2, stamp D1. Creates a fresh document at
 * version 1. The caller must have already resolved `agentId` from whichever
 * door (bearer or OAuth) the request came in through.
 *
 * `origin` is the URL prefix used to mint `url` (e.g. "https://host"). We
 * accept it as a parameter so core never needs to touch a Request.
 *
 * `format` selects the input pipeline. `"html"` is the legacy path; for
 * `"markdown"` we parse with pulldown-cmark (GFM) before running the
 * sanitizer. Either way the stored bytes are sanitized HTML — only the
 * `versions.source_format` column records what the agent originally sent.
 */
export async function publishDocumentCore(
  env: Env,
  body: string,
  agentId: string,
  origin: string,
  format: SourceFormat,
): Promise<WriteOk | PublishErr> {
  if (body.length === 0) return { ok: false, code: "empty_body" };

  // Reject oversize *input* up front — matches the existing HTTP path,
  // which 413s on raw req.arrayBuffer() bytes before decoding. The MCP
  // path has no Request to pre-check, so the cap is enforced here.
  // The cap applies to the raw input bytes (whether HTML or Markdown);
  // a Markdown document that expands during conversion is still bounded
  // by what the agent sent.
  const inputBytes = new TextEncoder().encode(body);
  if (inputBytes.byteLength > MAX_INPUT_BYTES) {
    return { ok: false, code: "too_large", limit: MAX_INPUT_BYTES, size: inputBytes.byteLength };
  }

  // Convert (if needed) + sanitize so the cap check reflects what would
  // actually be stored. The sanitize step is the trust boundary for both
  // input formats; pulldown-cmark does not filter dangerous HTML on its
  // own (see sanitizer/src/lib.rs markdown_to_html docs).
  const prep = prepareForStorage(body, format);

  const capCheck = await checkStorageCap(env, prep.cleanedBytes.byteLength);
  if (!capCheck.ok) {
    return {
      ok: false,
      code: "storage_cap_exceeded",
      used: capCheck.used,
      cap: capCheck.cap,
      this_write: prep.cleanedBytes.byteLength,
    };
  }

  const docId = newUuid();
  const publicId = newPublicId();
  const versionNo = 1;
  const r2Key = `${docId}/v${versionNo}`;

  // R2 first. If the D1 batch fails we attempt to delete the blob so we
  // don't accumulate orphans. R2 keys are unique per (docId, version), so a
  // retry harmlessly overwrites.
  await env.DOCS.put(r2Key, prep.cleanedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      document_id: docId,
      version: String(versionNo),
      sanitizer_v: prep.sanitizerV,
      agent_id: agentId,
      source_format: format,
    },
  });

  try {
    await env.META.batch([
      env.META.prepare(
        "insert into documents (id, public_id, created_by) values (?, ?, ?)",
      ).bind(docId, publicId, agentId),
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v, source_format)
         values (?, ?, ?, ?, ?, ?)`,
      ).bind(docId, versionNo, r2Key, prep.cleanedBytes.byteLength, prep.sanitizerV, format),
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
    size_bytes: prep.cleanedBytes.byteLength,
    sanitizer_v: prep.sanitizerV,
    modified: prep.modified,
    stripped: prep.stripped,
    will_not_render: prep.will_not_render,
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
  body: string,
  expectedVersion: number | null,
  agentId: string,
  origin: string,
  format: SourceFormat,
): Promise<WriteOk | UpdateErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  if (body.length === 0) return { ok: false, code: "empty_body" };

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

  const inputBytes = new TextEncoder().encode(body);
  if (inputBytes.byteLength > MAX_INPUT_BYTES) {
    return { ok: false, code: "too_large", limit: MAX_INPUT_BYTES, size: inputBytes.byteLength };
  }

  const prep = prepareForStorage(body, format);

  const capCheck = await checkStorageCap(env, prep.cleanedBytes.byteLength);
  if (!capCheck.ok) {
    return {
      ok: false,
      code: "storage_cap_exceeded",
      used: capCheck.used,
      cap: capCheck.cap,
      this_write: prep.cleanedBytes.byteLength,
    };
  }

  const nextVer = row.current_ver + 1;
  const r2Key = `${row.id}/v${nextVer}`;

  await env.DOCS.put(r2Key, prep.cleanedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      document_id: row.id,
      version: String(nextVer),
      sanitizer_v: prep.sanitizerV,
      agent_id: agentId,
      source_format: format,
    },
  });

  try {
    await env.META.batch([
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v, source_format)
         values (?, ?, ?, ?, ?, ?)`,
      ).bind(row.id, nextVer, r2Key, prep.cleanedBytes.byteLength, prep.sanitizerV, format),
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
    size_bytes: prep.cleanedBytes.byteLength,
    sanitizer_v: prep.sanitizerV,
    modified: prep.modified,
    stripped: prep.stripped,
    will_not_render: prep.will_not_render,
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

/** Markdown read result — derived on the fly from the sanitized HTML. */
export type ReadTextOk = {
  ok: true;
  text: string;
  version_no: number;
  sanitizer_v: string;
  converter_v: string;
};

/**
 * Fetch the current version's sanitized HTML and convert it to Markdown.
 *
 * The conversion runs at read time (no per-version cache in v1 — see
 * action-plan-v1.md follow-ups for the cost analysis). The input to
 * `htmlToMarkdown` is always the sanitized bytes from R2, never raw
 * agent input, so the text view reflects exactly what would render and
 * nothing the sanitizer stripped can leak through.
 *
 * `sanitizer_v` and `converter_v` are both stamped on the response so a
 * caller seeing surprising output can tell which knob changed.
 */
export async function readDocumentTextCore(
  env: Env,
  publicId: string,
): Promise<ReadTextOk | ReadErr> {
  const html = await readDocumentCore(env, publicId);
  if (!html.ok) return html;

  const htmlStr = new TextDecoder().decode(html.bytes);
  const text = htmlToMarkdown(htmlStr);
  return {
    ok: true,
    text,
    version_no: html.version_no,
    sanitizer_v: html.sanitizer_v,
    converter_v: converterVersion(),
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
