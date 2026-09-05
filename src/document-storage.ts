// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage accounting and the per-version blob writer.
 *
 * Key invariants:
 *   - `storageCapBytes` is the SINGLE reader of the `STORAGE_CAP_BYTES` [var]
 *     and FAILS CLOSED (falls back to `DEFAULT_STORAGE_CAP_BYTES`, never NaN).
 *   - `currentStorageUsedBytes` is the one copy of the accounting (H + S bytes
 *     across live docs); `checkStorageCap` is best-effort, outside the batch.
 *   - `putVersionBlobs` writes BOTH blobs per version at PER-WRITE-ATTEMPT
 *     nonced keys; nothing may ever re-derive an R2 key by formula.
 */

import type { Prep } from "./document-write.js";
import type { Env } from "./env.js";
import { newPublicId } from "./ids.js";
import type { SourceFormat } from "./contract.js";

/**
 * Fallback fleet cap, used when `STORAGE_CAP_BYTES` is missing or unparseable.
 * Same value wrangler.toml(.example) ships, so a healthy deployment never
 * notices the fallback exists — it only matters for a typo'd [var].
 */
export const DEFAULT_STORAGE_CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * The SINGLE reader of the `STORAGE_CAP_BYTES` [var] — normalizes it into a
 * usable byte count, FAILING CLOSED.
 *
 * `STORAGE_CAP_BYTES` is typed `string` on Env, which is a compile-time shape
 * guarantee and nothing more: an operator/forker editing wrangler.toml can
 * still land `"2 GiB"`, `""`, or delete the line entirely. The old inline
 * `Number(env.STORAGE_CAP_BYTES)` turned that into NaN, and every comparison
 * against NaN is false — so a typo silently DISABLED the fleet guardrail with
 * no log line, which is exactly the wrong direction to fail on a guardrail.
 *
 * Fail-closed here means "a cap is still enforced," not "all writes die": a
 * bad value falls back to `DEFAULT_STORAGE_CAP_BYTES` and screams in the logs.
 * A zero/negative value is treated as misconfiguration too (a deliberate
 * write-freeze is not a thing this [var] is for) rather than bricking publish.
 *
 * Everything that reads the cap goes through here — `checkStorageCap` below,
 * the operator console dashboard, and `/healthz` — so the three can never
 * disagree about what a bad value means.
 */
export function storageCapBytes(env: Env): number {
  const cap = Number(env.STORAGE_CAP_BYTES);
  if (!Number.isFinite(cap) || cap <= 0) {
    // Value only, never a secret — STORAGE_CAP_BYTES is a public [var].
    console.error("storage_cap.misconfigured", {
      value: env.STORAGE_CAP_BYTES,
      falling_back_to: DEFAULT_STORAGE_CAP_BYTES,
    });
    return DEFAULT_STORAGE_CAP_BYTES;
  }
  return Math.floor(cap);
}

/**
 * Global storage cap. Sums BOTH stored blobs per version — the rendered H
 * (`size_bytes`) and the retained source S (`source_size_bytes`) — across
 * every non-revoked version, regardless of which agent created the document.
 * v1 is single-operator, so the cap is a fleet-wide guardrail rather than a
 * per-agent quota. Source retention counts toward the cap (§6); the inner
 * `coalesce(v.source_size_bytes, 0)` keeps legacy/un-backfilled rows (NULL
 * source_size_bytes) a no-op zero so they don't break the SUM.
 *
 * Best-effort: the SUM runs outside the insert batch, so two concurrent
 * writes can both pass the check. v1 accepts the slight overrun — retention
 * changes the magnitude, not the concurrency story (the 2 GiB cap has
 * headroom for the roughly-doubled footprint).
 */
export async function checkStorageCap(
  env: Env,
  addBytes: number,
): Promise<{ ok: true } | { ok: false; used: number; cap: number }> {
  const cap = storageCapBytes(env);
  const used = await currentStorageUsedBytes(env);
  if (used + addBytes > cap) return { ok: false, used, cap };
  return { ok: true };
}

/**
 * Current fleet storage in use: the SUM of both stored blobs per version (the
 * rendered H `size_bytes` + the retained source S `source_size_bytes`) across
 * live documents. The SINGLE copy of this accounting — `checkStorageCap`
 * enforces it and the operator console dashboard reports it, both through here,
 * so "used" can never drift from what the cap actually checks.
 */
export async function currentStorageUsedBytes(env: Env): Promise<number> {
  const row = await env.META.prepare(
    `select coalesce(sum(v.size_bytes + coalesce(v.source_size_bytes, 0)), 0) as used
     from versions v
     join documents d on d.id = v.document_id
     where d.revoked_at is null`,
  ).first<{ used: number }>();
  return Number(row?.used ?? 0);
}

/**
 * Content-type for a retained source blob, keyed on the doc's source format.
 * Markdown sources are stored as `text/markdown`; html sources as `text/html`.
 * The render H blob is always `text/html` regardless (it's the sanitized HTML).
 */
function sourceContentType(format: SourceFormat): string {
  return format === "markdown" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8";
}

/**
 * Write BOTH blobs for one version: the sanitized render H at
 * `<docId>/v<n>-<nonce>` and the retained source S at its `.src` sibling. The
 * `.src` suffix is a dot-suffix sibling of the H key — version keys carry no
 * dot, so the suffix cannot collide.
 *
 * WHY THE NONCE — the key is PER-WRITE-ATTEMPT, not per-(docId, versionNo).
 * Both write cores PUT to R2 before the D1 batch and, if the batch throws,
 * delete the keys they just wrote. With a deterministic `<docId>/v<n>` key that
 * rollback is only safe for a RETRY (same writer, same bytes); it is actively
 * destructive for a CONCURRENT writer. Two updates that both read current_ver=5
 * both compute nextVer=6 and both address `D/v6`: `versions`' PRIMARY KEY
 * (document_id, version_no) lets exactly one batch commit, and the loser's
 * rollback then deletes the WINNER's committed bytes — leaving a live D1 row
 * whose R2 object is gone (404 on render, `source_unavailable` on edit/source,
 * still listed in search). The nonce makes each attempt own a private address,
 * so a loser can only ever delete its own bytes and the winner's blob is
 * untouchable. Nothing recomputes these keys — `versions.r2_key` /
 * `versions.source_r2_key` are opaque stored columns and every reader (render,
 * text/source reads, link backfill, revoke purge) reads them back from D1.
 * KEEP IT THAT WAY: re-deriving a key by formula anywhere would silently
 * reintroduce the shared address this nonce exists to remove. (Source-retention
 * §9's in-place re-heal is unaffected — it overwrites at the key it read off
 * the version row, which is stable once committed.)
 *
 * S is stored UNCONDITIONALLY (dedup-when-identical is a deferred optimization,
 * §6) and is NOT sanitized — it is by definition the unsanitized original. The
 * `representation: 'source'` customMetadata marker lets an R2 audit distinguish
 * S from H without parsing the bytes. Both puts complete before the D1 batch so
 * the existing orphan-on-D1-failure ordering holds; the callers' catch blocks
 * delete BOTH keys on a failed batch.
 */
export type BlobAuthor = { kind: "operator" } | { kind: "agent"; agentId: string | null };

export async function putVersionBlobs(
  env: Env,
  docId: string,
  versionNo: number,
  prep: Prep,
  // `Author` is assignable; the nullable agent id exists for the backup
  // restore (src/backup.ts), which re-stores legacy versions whose
  // migration-0013 default is author_kind='agent' with no agent id.
  author: BlobAuthor,
): Promise<{ r2Key: string; sourceR2Key: string }> {
  // 16 CSPRNG bytes, URL-safe base64 — the same minting `newPublicId` uses.
  // Opacity isn't the point here (the key never reaches a client); collision
  // resistance between concurrent attempts is.
  const r2Key = `${docId}/v${versionNo}-${newPublicId()}`;
  const sourceR2Key = `${r2Key}.src`;
  // `author_kind` is the principal discriminator (migration 0013); `agent_id`
  // is kept for agent authors so existing R2 audits still find a writer id. An
  // operator author carries no agent id — the queryable record is the D1
  // versions row (author_kind/author_agent_id); this customMetadata is a
  // best-effort echo, not the source of truth.
  const sharedMeta = {
    document_id: docId,
    version: String(versionNo),
    sanitizer_v: prep.sanitizerV,
    author_kind: author.kind,
    ...(author.kind === "agent" && author.agentId !== null ? { agent_id: author.agentId } : {}),
    source_format: prep.sourceFormat,
  };

  // H blob — the sanitized render, unchanged from the prior inline puts.
  await env.DOCS.put(r2Key, prep.cleanedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: sharedMeta,
  });

  // S blob — the retained, unsanitized source. Content-type follows the
  // source format; the representation marker flags it as source in an audit.
  await env.DOCS.put(sourceR2Key, prep.sourceBytes, {
    httpMetadata: { contentType: sourceContentType(prep.sourceFormat) },
    customMetadata: { ...sharedMeta, representation: "source" },
  });

  return { r2Key, sourceR2Key };
}
