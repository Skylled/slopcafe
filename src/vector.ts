// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers behind the planned hybrid (keyword + semantic) search — the
 * correctness-critical pieces that have nothing to do with I/O, so they live
 * here standalone (no D1/R2/WASM/AI imports) and are unit-tested under the Node
 * strip-types runner, exactly like `search.ts`, `edit.ts`, and `conditional.ts`.
 * The Vectorize/Workers-AI calls themselves (embed, upsert, query) stay in the
 * write/read path; they're covered by typecheck + the remote E2E, not this file.
 *
 * Design is CHUNKED — N vectors per document (see `docs/design/vector-search-design.md` §2.1,
 * §5). This module owns the three pure pieces that decision implies: the chunk
 * split (`chunkEmbedInputs`), the `${docId}#${i}` vector-ID convention
 * (`chunkVectorId` / `docIdFromChunkId` / `chunkVectorIdRange`), and the
 * read-time collapse of chunk hits back to one hit per document
 * (`collapseChunksToDocs`) — plus the rank fusion (`reciprocalRankFusion`).
 *
 * NOTHING imports this module yet — it is inert prep, landed ahead of the
 * feature so the trickiest bits (the fusion + the chunk contract) can be
 * reviewed and pinned in isolation.
 */

// ---- Chunking constants ----------------------------------------------------
// Named here (not baked into the logic) so they're sweepable in the remote E2E
// (§14). Sizes target GRANULARITY, not the model window: at ~4 chars/token the
// ~2,000-char target is ~500 tokens, far under Qwen3's ≥8,192-token cap — small
// chunks are what give a buried concept its own vector instead of being pooled
// into a whole-doc average (§2.1).
export const TARGET_CHUNK_CHARS = 2000;
export const CHUNK_OVERLAP_CHARS = 200;
export const MAX_CHUNKS = 24;

/**
 * Reciprocal Rank Fusion.
 *
 * Combine several independently-ranked result lists into one ranking. Each
 * input list is an array of item IDs in BEST-FIRST order (rank 1 = index 0).
 * An item's fused score is the sum, over every list it appears in, of
 * `1 / (k + rank)` where `rank` is its 1-based position in that list. Items
 * absent from a list contribute nothing for that list.
 *
 * WHY RRF (and not score-averaging): our two rankers are on incomparable
 * scales — FTS5 `bm25()` is unbounded and we surface it negated, while cosine
 * similarity is in `[-1, 1]`. Averaging or summing those raw scores would let
 * whichever metric has the larger numeric range dominate. RRF throws the
 * scores away and fuses on RANK alone, so no normalization step is needed and
 * neither ranker can swamp the other. `k` (conventionally 60) damps the pull
 * of the very top ranks: with `k = 60`, rank 1 scores `1/61` and rank 2
 * `1/62` — close together, so a doc must rank well in MULTIPLE lists to beat a
 * doc that's #1 in only one. A smaller `k` sharpens the advantage of top
 * ranks; a larger `k` flattens it.
 *
 * In the chunked design the SEMANTIC list handed to RRF is already collapsed to
 * one entry per document (`collapseChunksToDocs`), so fusion operates on doc IDs
 * in both lists exactly as it would have for single-vector — chunking is
 * invisible here.
 *
 * Determinism: results are sorted by fused score descending, ties broken by id
 * ascending (lexicographic). Equal scores are genuinely symmetric under RRF
 * (e.g. an item that's #1 in only list A vs. one that's #1 in only list B both
 * score `1/(k+1)`), so the id tiebreak is an arbitrary-but-STABLE choice —
 * identical inputs always yield identical output order, which is what the
 * tests pin and what a caller paginating/truncating to `limit` relies on.
 *
 * Defensive details: `k` is floored at 0 (a negative `k` could make `k + rank`
 * non-positive and blow up the reciprocal); a falsy/empty id is skipped; and a
 * duplicate id WITHIN one list counts only its best (first) rank, so a
 * malformed list can't double-credit an item.
 *
 * @param lists  ranked ID lists, each best-first
 * @param k      RRF damping constant (default 60); floored at 0
 * @returns      `{ id, score }[]` sorted by score desc, then id asc
 */
export function reciprocalRankFusion(
  lists: readonly (readonly string[])[],
  k = 60,
): Array<{ id: string; score: number }> {
  const kk = Math.max(0, k);
  const scores = new Map<string, number>();

  for (const list of lists) {
    // Track ids already credited in THIS list so a duplicate only counts its
    // best (earliest) rank — cross-list accumulation still happens via the
    // shared `scores` map.
    const seenInList = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      if (!id || seenInList.has(id)) continue;
      seenInList.add(id);
      const rank = i + 1; // 1-based
      scores.set(id, (scores.get(id) ?? 0) + 1 / (kk + rank));
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Split a document into the text chunks we embed (one vector per chunk).
 *
 * The split rule (`docs/design/vector-search-design.md` §5):
 *  - **Chunk 0 leads with the metadata head** (`title`/`description`, blank-line
 *    joined) followed by the first body window; **every other chunk is
 *    body-only**. The head lives in chunk 0 ALONE on purpose — prepending it to
 *    every chunk would pull all of a doc's vectors toward a common centroid and
 *    erode the inter-chunk discrimination that is the whole point of chunking.
 *  - **Body is split on heading/paragraph boundaries** — blank lines separate
 *    blocks, and a Markdown heading (`#`–`######`) starts a fresh block even
 *    without a preceding blank line, so a chunk usually *begins* with its
 *    section heading (free local context, no per-chunk title injection).
 *  - Blocks are **greedily packed** into windows of up to `TARGET_CHUNK_CHARS`,
 *    with a `CHUNK_OVERLAP_CHARS` tail carried into the next window so a concept
 *    straddling a boundary isn't cut mid-thought. A single block larger than the
 *    target is hard-split by characters (same overlap step).
 *  - At most `MAX_CHUNKS` chunks; body past that is dropped (the I/O caller logs
 *    the drop — code only, never the body).
 *
 * The head is prepended to chunk 0 *after* body windowing, so chunk 0 can run
 * slightly over `TARGET_CHUNK_CHARS` by the (small) head length — acceptable
 * given the model's large token window; the target governs granularity, not a
 * hard cap.
 *
 * DETERMINISTIC — identical `(title, description, body)` yields an identical
 * array, so a re-embed/backfill reproduces the stored vectors byte-for-byte.
 * The document side takes **no instruction prefix** (that's a query-side lever,
 * §10) — keeping chunk inputs prefix-free is what keeps them symmetric with a
 * re-embed.
 *
 * @returns up to `MAX_CHUNKS` chunk strings; `[]` only when there is no head and
 *          no body content to embed.
 */
export function chunkEmbedInputs(
  title: string | null,
  description: string | null,
  body: string,
): string[] {
  const head = [title, description]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("\n\n");

  const windows = packWindows(splitIntoBlocks(body ?? ""));

  if (windows.length === 0) {
    // Metadata-only doc (empty body): chunk 0 is the head, or nothing to embed.
    return head ? [head] : [];
  }

  const chunks = windows.slice();
  chunks[0] = head ? `${head}\n\n${chunks[0]}` : chunks[0];
  return chunks;
}

/** Heading/paragraph-aware block split (see `chunkEmbedInputs`). */
function splitIntoBlocks(body: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    const text = cur.join("\n").trim();
    if (text.length > 0) blocks.push(text);
    cur = [];
  };
  for (const line of body.split("\n")) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line) && cur.length > 0) flush(); // heading starts a block
    cur.push(line);
  }
  flush();
  return blocks;
}

/** Greedy block packing into ≤`TARGET_CHUNK_CHARS` windows with tail overlap. */
function packWindows(blocks: string[]): string[] {
  const step = Math.max(1, TARGET_CHUNK_CHARS - CHUNK_OVERLAP_CHARS);
  const windows: string[] = [];
  let cur = "";

  for (const block of blocks) {
    if (windows.length >= MAX_CHUNKS) break;

    if (block.length > TARGET_CHUNK_CHARS) {
      // Oversized single block: flush, then hard-split by characters.
      if (cur) {
        windows.push(cur);
        cur = "";
      }
      for (let start = 0; start < block.length && windows.length < MAX_CHUNKS; start += step) {
        windows.push(block.slice(start, start + TARGET_CHUNK_CHARS));
      }
      continue;
    }

    const candidate = cur ? `${cur}\n\n${block}` : block;
    if (candidate.length <= TARGET_CHUNK_CHARS) {
      cur = candidate;
    } else {
      if (cur) windows.push(cur);
      const tail = cur.slice(Math.max(0, cur.length - CHUNK_OVERLAP_CHARS)).trimStart();
      cur = tail ? `${tail}\n\n${block}` : block;
    }
  }

  if (cur && windows.length < MAX_CHUNKS) windows.push(cur);
  return windows;
}

/** The Vectorize vector ID for a document's chunk `index` (the ONE convention). */
export function chunkVectorId(docId: string, index: number): string {
  return `${docId}#${index}`;
}

/** Recover the document id from a chunk vector ID (`split on the first '#'`). */
export function docIdFromChunkId(chunkId: string): string {
  const hash = chunkId.indexOf("#");
  return hash === -1 ? chunkId : chunkId.slice(0, hash);
}

/**
 * The fixed `${docId}#0 … #${MAX_CHUNKS-1}` ID range for the delete-then-upsert
 * write (§6) and the revoke delete (§7). Deleting the whole range (idempotent —
 * absent IDs are no-ops) is what lets us re-write a doc whose chunk count
 * SHRANK without tracking the old count in D1 — no migration, no orphans.
 */
export function chunkVectorIdRange(docId: string): string[] {
  return Array.from({ length: MAX_CHUNKS }, (_, i) => chunkVectorId(docId, i));
}

/**
 * Collapse Vectorize chunk hits to one entry per document for fusion (§10).
 *
 * Vectorize returns chunk-level matches (`${docId}#${i}` + cosine, plus the
 * chunk's `preview` metadata); multiple chunks of one document can rank. Fold
 * them to the BEST (highest cosine) chunk per document — the document's single
 * semantic score — then order best-first. The per-document rank list
 * `reciprocalRankFusion` consumes is chunk-agnostic; the one chunk detail that
 * surfaces is the winning chunk's `preview`, carried through here to become the
 * semantic snippet (§11).
 *
 * Deterministic: score descending, ties broken by id ascending — the same
 * stable rule as `reciprocalRankFusion`. Falsy hits/ids are skipped; `preview`
 * is optional (undefined for a legacy vector written before previews).
 */
export function collapseChunksToDocs(
  hits: readonly { id: string; score: number; preview?: string }[],
): Array<{ id: string; score: number; preview?: string }> {
  // Best score per doc, plus the preview of the chunk that achieved it.
  const best = new Map<string, { score: number; preview?: string }>();
  for (const hit of hits) {
    if (!hit || !hit.id) continue;
    const docId = docIdFromChunkId(hit.id);
    if (!docId) continue;
    const prev = best.get(docId);
    if (prev === undefined || hit.score > prev.score) {
      best.set(docId, { score: hit.score, preview: hit.preview });
    }
  }
  return [...best.entries()]
    .map(([id, { score, preview }]) => ({ id, score, preview }))
    .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
