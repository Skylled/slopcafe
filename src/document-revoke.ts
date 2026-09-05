// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator kill switch for one document.
 *
 * Key invariants:
 *   - `revoked_at` flips (with the slug clear + tombstone, FTS delete, outbound
 *     link delete and `updated_at` touch, in ONE batch) BEFORE the R2 purge, so
 *     the doc is unreachable instantly even if the bucket call hangs.
 *   - The purge is IDEMPOTENT and re-issuing the revoke IS the recovery: a
 *     second revoke skips the D1 batch and re-runs the purge (H and `.src`
 *     alike, chunked under R2's 1000-key delete limit). Don't "fix" it to 404.
 *   - The chunk-vector delete rides `waitUntil` — index reclaim, not the gate.
 */

import { recordAudit } from "./audit.js";
import { NOW_SQL, TOUCH_UPDATED_AT } from "./document-listing.js";
import { tombstoneSlug } from "./document-slug.js";
import type { Env } from "./env.js";
import { PUBLIC_ID_RE } from "./ids.js";
import { deleteDocumentVector, type WaitUntil } from "./vector-io.js";
import type { RevokeOk } from "./contract.js";

// RevokeOk — defined in src/contract.ts (re-exported above).
export type RevokeErr = { ok: false; code: "not_found" };

/**
 * R2's `delete(keys[])` accepts at most 1000 keys per call. The purge below is
 * up to 2× the version count (H + its `.src` sibling), so a heavily-edited doc
 * blows past it — `edit_document` appends a version per call and nothing prunes.
 */
const R2_DELETE_BATCH = 1000;

/**
 * Delete R2 keys in ≤`R2_DELETE_BATCH` chunks. Sequential on purpose: a purge is
 * a rare operator action, and serializing keeps one oversized document from
 * firing hundreds of concurrent subrequests.
 */
async function deleteR2Keys(env: Env, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    await env.DOCS.delete(keys.slice(i, i + R2_DELETE_BATCH));
  }
}

/**
 * Operator kill switch for a single document. Marks `revoked_at` first so
 * the doc is unreachable instantly, then purges every version's R2 objects —
 * BOTH the rendered H blob AND the retained source S sibling.
 * Revoked-doc source is purged WITH H, not retained as an audit trail: leaving
 * unsanitized source resident after the operator pressed kill would be a §8
 * data-at-rest / exfil gap. Keeps `versions` rows as an audit trail; the bytes
 * (H and S alike) are the irrecoverable part — which is also what makes the
 * purge re-derivable: the surviving rows still carry every key.
 *
 * IDEMPOTENT ON THE PURGE PATH. An already-revoked document is NOT a 404 here —
 * it re-runs the R2 purge and returns ok. The kill (the D1 batch) lands first
 * and never repeats; the purge is the part that can fail, and before this it
 * failed UNRECOVERABLY: one transient R2 error (or a >500-version doc hitting
 * R2's 1000-key delete limit) left every unsanitized `.src` blob resident
 * forever, because the second revoke attempt 404'd on `revoked_at` and no other
 * API path purges those keys. Now a failed purge throws (loud — the operator
 * sees a 500) AND is retryable by simply re-issuing the revoke. Re-revoking is
 * safe because the D1 batch is skipped: `revoked_at` keeps its original
 * timestamp and the slug tombstone is not re-written.
 *
 * Also CLEARS the slug (sets documents.slug = NULL) as part of the same UPDATE,
 * so the live-slug queries stop resolving it. That is NOT a release: migration
 * 0009 reverses 0005's "available again on revoke" contract, and the same batch
 * RETIRES the slug into `slug_tombstones` so it can never be reclaimed (/s/<it>
 * answers 410 Gone from then on). The `public_id` survives on the row as an
 * audit/lookup key; the slug is treated like the R2 bytes — gone instantly on
 * revoke, just permanently spent rather than recyclable.
 */
export async function revokeDocumentCore(
  env: Env,
  publicId: string,
  waitUntil?: WaitUntil,
): Promise<RevokeOk | RevokeErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  const row = await env.META.prepare(
    "select id, revoked_at, slug from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ id: string; revoked_at: string | null; slug: string | null }>();
  if (!row) return { ok: false, code: "not_found" };
  // Already dead: skip the kill, keep the original revoked_at, re-run the purge.
  const alreadyRevoked = row.revoked_at !== null;

  // Both keys come from D1, never from a formula: `r2_key` / `source_r2_key` are
  // opaque stored columns and the live keys carry a per-write-attempt nonce
  // (see putVersionBlobs), so `${r2Key}.src` is a coincidence of how they're
  // MINTED, not a contract this purge may rely on. `source_r2_key` is NULL on
  // pre-0008 rows — those versions genuinely have no `.src` blob to purge.
  const versions = await env.META.prepare(
    "select r2_key, source_r2_key from versions where document_id = ? order by version_no",
  )
    .bind(row.id)
    .all<{ r2_key: string; source_r2_key: string | null }>();
  const versionRows = versions.results ?? [];
  const r2Keys = versionRows.map((v) => v.r2_key);

  // Mark revoked + clear the live slug + RETIRE it into slug_tombstones + drop
  // the FTS row BEFORE purging R2 so the doc is unreachable instantly (including
  // via search) even if the bucket call hangs or fails. Batched so the writes
  // succeed together — a half-completed revoke that left the FTS row alive would
  // surface a tombstone in search results until the next reindex. Skipped
  // entirely on a re-revoke (the purge-retry path): the kill already landed, and
  // re-running this would stamp a fresh revoked_at over the real one.
  //
  // The slug is cleared from `documents.slug` (so the live-slug queries stop
  // resolving it) AND tombstoned (so it can never be reclaimed) — migration
  // 0009 reverses 0005's "released for reuse on revoke." A slugless doc skips
  // the tombstone INSERT. tombstoneSlug uses INSERT OR IGNORE so this kill
  // switch can never roll back on the tombstone write.
  if (!alreadyRevoked) {
    const statements: D1PreparedStatement[] = [
      // `updated_at` is touched here too (migration 0017): a revoke is the
      // largest change a document can undergo, and a change-feed consumer that
      // never saw it would keep serving a mirror of bytes that no longer exist.
      // Both stamps come from the same statement's `now`, so a revoked row reads
      // `updated_at == revoked_at`. The re-revoke path skips this whole batch, so
      // a retried purge can't stamp a second, fictitious "change."
      env.META.prepare(
        // `published_ver` is nulled alongside `current_ver` (migration 0018).
        // Not strictly required — every read path gates on `revoked_at` before
        // it joins — but leaving it standing means a revoked public document
        // keeps a live-looking pointer at a version whose R2 bytes this very
        // function is about to purge, and the served-version expression would
        // happily resolve it. Nulling both keeps "the kill switch leaves nothing
        // resolvable" true at the data layer instead of resting on every
        // present and future caller remembering to check revoke first.
        `update documents
         set revoked_at = ${NOW_SQL},
             current_ver = null,
             published_ver = null,
             slug = null,
             ${TOUCH_UPDATED_AT}
         where id = ?`,
      ).bind(row.id),
      env.META.prepare("delete from documents_fts where document_id = ?").bind(row.id),
      // The revoked doc's OUTBOUND link rows go with it (migration 0016) —
      // revoke tombstones the documents row rather than deleting it, so the ON
      // DELETE CASCADE never fires; this is the live cleanup. INBOUND rows in
      // other docs' link sets are raw target names and stay put — they now
      // resolve to "revoked"/"missing" at read time, which is the broken-link
      // signal documentLinksCore exists to surface.
      env.META.prepare("delete from document_links where src_doc_id = ?").bind(row.id),
    ];
    if (row.slug !== null) {
      statements.push(tombstoneSlug(env, row.slug, row.id, "revoked"));
    }
    await env.META.batch(statements);
  }

  // Purge each H key AND its retained `.src` source blob so no unsanitized
  // source survives the kill. Chunked under R2's 1000-key delete limit, which a
  // long-edited document exceeds on its own (2 keys per version). Failures
  // propagate — a silent swallow here is what a §8 kill-switch guarantee cannot
  // afford — and the operator's remedy is to re-issue the revoke, which lands
  // back on the idempotent path above and re-purges. The reported
  // r2_objects_purged stays the H count (one per version) to keep the RevokeOk
  // shape stable; the .src siblings are deleted alongside but not counted.
  const purge = versionRows.flatMap((v) =>
    v.source_r2_key === null ? [v.r2_key] : [v.r2_key, v.source_r2_key]
  );
  if (purge.length > 0) {
    await deleteR2Keys(env, purge);
  }

  // Reclaim the doc's chunk vectors AFTER the batch flipped revoked_at (§7).
  // The vector delete is NOT the kill switch — revoked_at (set above, BEFORE
  // this) is, and the read-path D1 re-join enforces `revoked_at is null` again,
  // so a revoked doc whose vectors haven't purged yet still can't surface.
  // Belt-and-suspenders, best-effort. Skipped when no waitUntil is supplied.
  if (waitUntil) {
    waitUntil(deleteDocumentVector(env, row.id));
  }

  // Ledger (0020). Filed on BOTH paths, with `already_revoked` telling them
  // apart: the idempotent purge-retry is a real operator act (it is the
  // documented recovery from a partial R2 purge) and an operator reading the
  // ledger months later needs to see the retry, not conclude the kill was
  // issued twice. Only the first one carries the D1 kill; the second re-ran the
  // purge and stamped nothing.
  recordAudit(env, waitUntil, {
    kind: "document_revoked",
    principal_kind: "operator",
    document_id: publicId,
    already_revoked: alreadyRevoked,
  });

  return { ok: true, public_id: publicId, r2_objects_purged: r2Keys.length };
}
