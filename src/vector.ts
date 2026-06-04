/**
 * Pure helpers behind the planned hybrid (keyword + semantic) search — the
 * two pieces that are correctness-critical and have nothing to do with I/O,
 * so they live here standalone (no D1/R2/WASM/AI imports) and are unit-tested
 * under the Node strip-types runner, exactly like `search.ts`, `edit.ts`, and
 * `conditional.ts`. The Vectorize/Workers-AI calls themselves (embed, upsert,
 * query) stay in the write/read path; they're covered by typecheck + the
 * remote E2E, not this file.
 *
 * See `vector-search-design.md` for the full plan. NOTHING imports this module
 * yet — it is inert prep, landed ahead of the feature so the trickiest bit
 * (the fusion) can be reviewed and pinned in isolation.
 */

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
 * Build the text we embed for a document's single vector.
 *
 * Title and description lead, body last, joined by blank lines. The ordering
 * is deliberate: the embedding models (bge-*) truncate input at ~512 tokens,
 * so the highest-signal curated metadata must come FIRST to survive on a long
 * body. Null/empty parts are dropped (no stray separators), and each part is
 * trimmed. This is the single source of the embed-input shape so the write
 * path and any future re-embed/backfill agree byte-for-byte.
 */
export function buildEmbedInput(
  title: string | null,
  description: string | null,
  body: string,
): string {
  return [title, description, body]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}
