// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Vector I/O — the impure half of hybrid (keyword + semantic) search: the
 * Workers AI embedding calls and the Vectorize index reads/writes. Kept OUT of
 * `src/vector.ts` (which stays a pure, strip-types-testable leaf) because every
 * function here touches `env.AI` / `env.VECTORIZE`. Same testing stance as the
 * restore path — covered by typecheck + the manual remote E2E
 * (`docs/design/vector-search-design.md` §9/§14), not the unit suite: there is no local
 * Workers AI model and Vectorize local emulation is limited.
 *
 * EVENTUALLY-CONSISTENT, BEST-EFFORT (§6). Vectorize is NOT transactional with
 * D1 (async mutations, 5–10 s visibility lag), so the write/delete helpers run
 * AFTER the core's `META.batch()` commits, off `ctx.waitUntil`. Each one
 * swallows its own errors — logging the code only, never the body (it's user
 * HTML, per the `src/mcp.ts` logging-discipline rule) — so a Workers AI /
 * Vectorize hiccup degrades to "BM25 still finds it," never a failed publish.
 * The operator-run backfill (`POST /admin/vectors/backfill`, §8) is the
 * durability net for drops, especially on write-once docs that never get a
 * healing update.
 *
 * SECURITY: Vectorize is a candidate RANKER, never an access gate (§5/§10). A
 * chunk vector's ID is `${documents.id}#${i}`, so a hit yields only a doc id;
 * the authoritative "is this live / does this caller see it" check is the D1
 * re-join in `searchDocumentsCore` (`d.revoked_at is null` + the tag/slug
 * filters). The one stored metadata field, `preview`, is a non-indexed display
 * snippet — returnable, not filterable, never an identity surface.
 */
import type { Env } from "./env.js";
import {
  chunkEmbedInputs,
  chunkVectorId,
  chunkVectorIdRange,
  collapseChunksToDocs,
} from "./vector.js";

/**
 * The Workers AI embedding model. **1024 dims, cosine — immutable** (§2.3): the
 * index dimensionality is fixed at create time, so changing the model means a
 * NEW index + a full re-embed, never an in-place swap. Pinned `as const` so the
 * literal routes to the typed Qwen3 `run()` overload (input field names verified
 * against `@cloudflare/workers-types` at build time — §2 caveat).
 */
export const EMBED_MODEL = "@cf/qwen/qwen3-embedding-0.6b" as const;

/**
 * Query-side task instruction. Qwen3 is instruction-aware and assembles the
 * `Instruct:\nQuery:` prefix server-side from this string (~1–5% recall, §10).
 * ASYMMETRIC ON PURPOSE: only the query carries it — stored chunk vectors are
 * prefix-free (§5) so they stay symmetric with a re-embed. One named constant so
 * query-embed and any future eval agree.
 */
export const QUERY_INSTRUCTION =
  "Given a web search query, retrieve relevant passages that answer the query";

/**
 * `topK` for the Vectorize query. Chunks compete (multiple chunks of one doc can
 * rank), so we want a generous chunk-hit count to surface enough distinct docs
 * after the chunk→doc collapse (§10). **Capped at 50 by Cloudflare:** with
 * `returnMetadata: "all"` (which we need for the inline `preview`) Vectorize
 * rejects `topK > 50` (error 40025). 50 is ample at our corpus scale; the
 * scale-up path if a much larger corpus ever needs more candidates is a two-step
 * query (`returnMetadata:"none"`, topK 100) + a `getByIds` for the surfaced
 * docs' previews — deferred, not needed now. (Indexing `preview` to lift the cap
 * is the wrong trade: indexed string metadata truncates to 64 bytes, gutting the
 * 256-char snippet — §4.)
 */
export const VECTOR_TOPK = 50;

/** ~256-char preview slice stored as the non-indexed `preview` metadata; becomes
 * the semantic-hit snippet (§5/§11). Re-written on every sync, so it can never
 * drift from the embedded chunk. */
const PREVIEW_CHARS = 256;

/**
 * The `ctx.waitUntil` shape threaded into the write/revoke cores so the vector
 * sync rides the request's lifetime without blocking the response. `undefined`
 * in unit tests / any caller that can't supply it → the sync is skipped silently
 * (the doc is fully functional, just not yet indexed; the next update or the
 * backfill heals it — §6).
 */
export type WaitUntil = (promise: Promise<unknown>) => void;

/** A collapsed semantic candidate after the chunk→doc fold — `id` is the
 * internal `documents.id` (the FTS / D1 re-join key), `score` the best chunk's
 * cosine, `preview` the winning chunk's snippet. */
export type VectorCandidate = { id: string; score: number; preview?: string };

/** Short, content-safe error tag for logs (never the body / a secret). */
function errTag(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}

/**
 * Embed a batch of chunk strings (DOCUMENT side — no instruction, §5). One
 * batched `AI.run` call; returns one vector per input in order, or `[]` on an
 * empty/failed run. The chunk count (≤ MAX_CHUNKS) is well within any plausible
 * batch cap.
 */
async function embedChunks(env: Env, chunks: string[]): Promise<number[][]> {
  if (chunks.length === 0) return [];
  const out = await env.AI.run(EMBED_MODEL, { text: chunks });
  return out.data ?? [];
}

/**
 * Embed a raw query string (QUERY side — instruction-prefixed server-side, §10).
 * Returns the single query vector, or `null` on ANY failure so the read path can
 * fall back to keyword — search must never hard-fail because the AI binding
 * hiccuped.
 */
export async function embedQuery(env: Env, raw: string): Promise<number[] | null> {
  try {
    const out = await env.AI.run(EMBED_MODEL, {
      queries: raw,
      instruction: QUERY_INSTRUCTION,
    });
    const vec = out.data?.[0];
    return vec && vec.length > 0 ? vec : null;
  } catch (err) {
    console.error("vector.embedQuery.failed", errTag(err));
    return null;
  }
}

/**
 * Embed + upsert a document's chunk vectors (§6). Order is **embed → delete →
 * upsert**: embedding first means a failed embed never wipes the doc's existing
 * good vectors; deleting the whole fixed `${docId}#0 … #${MAX_CHUNKS-1}` range
 * before the upsert means a SHRUNK chunk count leaves no orphan tail vectors —
 * the fixed-range delete (idempotent; absent IDs are no-ops) is exactly what
 * lets us avoid tracking a chunk count in D1.
 *
 * Best-effort: swallows + logs (code only) so it is safe to fire under
 * `waitUntil`. Returns the number of chunk vectors upserted (the backfill sums
 * this into its `vectors` count). `0` = nothing embeddable OR a transient
 * failure; on the zero-chunk path it still clears any stale vectors a prior,
 * longer version left behind. (The `missing` backfill avoids retrying a
 * genuinely zero-chunk doc forever by pre-checking `chunkEmbedInputs` itself —
 * §8 — rather than inferring it from this return value.)
 */
export async function syncDocumentVector(
  env: Env,
  docId: string,
  title: string | null,
  description: string | null,
  body: string,
): Promise<number> {
  try {
    const chunks = chunkEmbedInputs(title, description, body);
    if (chunks.length === 0) {
      // Nothing embeddable (empty body + metadata). Still clear any stale
      // vectors a prior, longer version left behind.
      await env.VECTORIZE.deleteByIds(chunkVectorIdRange(docId));
      return 0;
    }
    const vectors = await embedChunks(env, chunks);
    if (vectors.length === 0) {
      console.error("vector.sync.no_embeddings", docId);
      return 0;
    }
    // Delete the whole fixed range, THEN upsert the fresh vectors. Delete after
    // a successful embed so a transient AI failure can't strand the doc with no
    // vectors; before the upsert so a shrunk chunk count leaves no tail.
    await env.VECTORIZE.deleteByIds(chunkVectorIdRange(docId));
    const upserts = chunks.slice(0, vectors.length).map((c, i) => ({
      id: chunkVectorId(docId, i),
      values: vectors[i]!,
      metadata: { preview: c.slice(0, PREVIEW_CHARS) },
    }));
    await env.VECTORIZE.upsert(upserts);
    return upserts.length;
  } catch (err) {
    console.error("vector.sync.failed", docId, errTag(err));
    return 0;
  }
}

/**
 * Delete every chunk vector for a document — the revoke path (§7) and the same
 * fixed range the write path uses (covers however many chunks the doc had).
 * The vector delete is NOT the kill switch (`documents.revoked_at`, flipped
 * before this, is); this just reclaims the index. Best-effort.
 */
export async function deleteDocumentVector(env: Env, docId: string): Promise<void> {
  try {
    await env.VECTORIZE.deleteByIds(chunkVectorIdRange(docId));
  } catch (err) {
    console.error("vector.delete.failed", docId, errTag(err));
  }
}

/**
 * Query the index with a query vector and collapse the chunk hits to one
 * candidate per document (§10) — best-cosine chunk per doc, carrying that
 * chunk's `preview` for the snippet. `returnMetadata: "all"` is required so each
 * hit carries its (non-indexed) `preview`. Throws propagate to the read path,
 * which catches and falls back to keyword.
 */
export async function queryVectors(
  env: Env,
  qvec: number[],
  topK = VECTOR_TOPK,
): Promise<VectorCandidate[]> {
  const res = await env.VECTORIZE.query(qvec, { topK, returnMetadata: "all" });
  const hits = (res.matches ?? []).map((m) => ({
    id: m.id,
    score: m.score,
    preview: typeof m.metadata?.preview === "string" ? m.metadata.preview : undefined,
  }));
  return collapseChunksToDocs(hits);
}

/**
 * For the backfill's `mode: "missing"` (§8): given a page of internal doc ids,
 * return the SET of ids whose `#0` chunk vector is already present in the index.
 * Presence-only — it heals MISSING vectors, not STALE ones (a content change
 * whose re-sync silently failed still has a present `#0`, so it's skipped; that
 * rarer case needs `mode: "rebuild"`). `getByIds` reflects only committed
 * Vectorize mutations (5–10 s lag), so a just-synced doc may briefly look absent
 * and get harmlessly re-embedded (idempotent).
 */
export async function presentDocIds(env: Env, docIds: string[]): Promise<Set<string>> {
  if (docIds.length === 0) return new Set();
  const found = await env.VECTORIZE.getByIds(docIds.map((id) => chunkVectorId(id, 0)));
  const present = new Set<string>();
  for (const v of found) {
    // v.id is `${docId}#0`; strip the suffix back to the doc id.
    const hash = v.id.indexOf("#");
    present.add(hash === -1 ? v.id : v.id.slice(0, hash));
  }
  return present;
}
