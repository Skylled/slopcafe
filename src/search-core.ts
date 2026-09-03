// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Hybrid (keyword + semantic) document search — a PURE MOVE out of core.ts
 * (GitHub issue #53, zero logic edits): `searchDocumentsCore` and its two
 * private legs, `ftsSearch` (FTS5/BM25) and `semanticSearch` (Vectorize,
 * re-joined through D1). docs/design/vector-search-design.md §10 is the
 * design record; the search bullet in CLAUDE.md is the behavioral contract.
 *
 * Edge is strictly ONE-WAY: this module imports core.ts for the same
 * DocumentListing projection (`LISTING_SELECT_COLUMNS`/`LISTING_JOINS`),
 * `parseStoredTags`, `publicationClause`, and `tagLikePattern` — all exported
 * from there so listDocumentsCore and this module build the identical AND-tag
 * / publication filter, never a second copy of the SQL. core.ts imports
 * nothing from here.
 */

import type { Env } from "./env.js";
import { type ListParams } from "./pagination.js";
import { buildFtsMatchQuery } from "./search.js";
import { reciprocalRankFusion } from "./vector.js";
import { embedQuery, queryVectors, type VectorCandidate } from "./vector-io.js";
import {
  type DocumentListing,
  LISTING_JOINS,
  LISTING_SELECT_COLUMNS,
  parseStoredTags,
  publicationClause,
  type SearchHit,
  tagLikePattern,
} from "./core.js";

/**
 * Hit row from searchDocumentsCore — the same DocumentListing shape every
 * list surface returns, plus three search-specific fields:
 *
 *   - `score`: positive float, bigger = better match. The raw FTS5 bm25()
 *     function returns NEGATIVE values (lower = better, so ORDER BY rank
 *     puts the best first); we negate before surfacing so callers can use
 *     the natural "higher is better" reading.
 *   - `matched_field`: which column the agent should treat as the
 *     "reason" for this hit. Useful for an agent deciding whether the hit
 *     is metadata-substantive (title/description) vs only a body mention.
 *     **Per-column attribution rather than strength.** D1's FTS5 bm25()
 *     does not produce reliable per-column subscores via the weights-
 *     isolation trick (passing `(1,0,0)` gives the same value as `(0,0,1)`
 *     for the same row — verified locally), so we instead detect which
 *     columns matched via their per-column `snippet()` output (the matched-
 *     token bracketing is unambiguous) and pick a winner by priority:
 *     title > description > body. The priority mirrors BM25 weights and
 *     reflects "metadata hits are stronger relevance signals than body
 *     mentions." (Tags are no longer FTS-indexed since migration 0012.)
 *   - `snippet`: a short excerpt of the matched column with `[bracketed]`
 *     match tokens, drawn from whichever column won the matched_field
 *     priority. For a body match this is the FTS5 snippet builtin's
 *     output; for a title match it's the title with the matched term
 *     bracketed.
 */
// SearchHit — a DocumentListing plus `score` / `matched_field` / `snippet`.
// Defined in src/contract.ts. (Per-column attribution rationale above.)

/**
 * Tunable BM25 column weights. Title >> description >> body.
 *
 * THE RULE: FTS5's `bm25()` takes one weight per column OF THE TABLE, in CREATE
 * order, INCLUDING `UNINDEXED` columns — an UNINDEXED column consumes a weight
 * slot even though it can never match. This is the SAME convention `snippet()`
 * column indices use; the two do NOT differ. So the migration-0012 schema
 * (`document_id UNINDEXED, title, description, body`) needs FOUR weights, with
 * `document_id` taking a wasted leading 0.0.
 *
 * Getting it wrong is silent: emitting three weights shifts every weight one
 * column left (20 → document_id, 5 → title, 1 → description) and leaves the
 * last column on bm25's 1.0 default — which is what shipped until it was
 * measured against SQLite directly. The declared 20/5/1 ran as 5/1/1, with
 * description and body scoring IDENTICALLY (an exact tie, arbitrary order),
 * and — because the keyword leg's rank list feeds RRF — degraded hybrid
 * ordering too. Nothing errors; the results just come back mis-ranked.
 *
 * Keep this object in CREATE order with one entry per column, and keep the
 * emitting `bm25(...)` call below listing every one of them.
 */
const BM25_WEIGHTS = { document_id: 0.0, title: 20.0, description: 5.0, body: 1.0 };

export type SearchErr = { ok: false; code: "bad_query" };
/** Which retrieval legs run (docs/design/vector-search-design.md §10). Default `hybrid`. */
export type SearchMode = "hybrid" | "keyword" | "semantic";

/**
 * Search over live documents — HYBRID by default (docs/design/vector-search-design.md §10).
 *
 * Three modes over a RAW query string (we tokenize for FTS internally now, so
 * the semantic leg can embed the un-tokenized query):
 *  - `keyword`  → FTS5/BM25 only (today's exact behavior; the deterministic
 *    exact-match escape hatch).
 *  - `semantic` → Vectorize only — the query is embedded, the chunk hits are
 *    collapsed to one candidate per doc, then re-joined through D1.
 *  - `hybrid`   → both legs, fused by Reciprocal Rank Fusion (`reciprocalRankFusion`
 *    in src/vector.ts). RRF fuses on RANK, so BM25 (unbounded, negated) and
 *    cosine (`[-1,1]`) never need to be put on the same scale.
 *
 * GRACEFUL DEGRADATION: the query embed is best-effort — on any AI failure
 * `embedQuery` returns null and hybrid/semantic fall back to the keyword leg;
 * search never hard-fails because the AI binding hiccuped. `bad_query` is
 * returned ONLY when no leg can carry the search: keyword mode with no usable
 * tokens, or hybrid/semantic when the embed failed AND there are no tokens.
 *
 * ACCESS: this surface is agent-key/operator-gated, NOT the anonymous browser
 * surface, so visibility does not gate search (every authenticated caller sees
 * the whole fleet); only `revoked_at` does. Vectorize is a candidate RANKER, not
 * the access gate — semantic hits are authoritatively re-joined through D1
 * (`d.revoked_at is null` + the tag/slug filters) exactly like FTS hits, so a
 * stale/revoked vector can never surface (§5/§10).
 *
 * FILTERS: `tags` / `slug` / `status` / `updatedSince` all apply here exactly as
 * they do on the list surface — both legs enforce them in their D1 clause, so a
 * filter is never a post-hoc trim of an already-ranked page. `params.order` is
 * the one list knob search IGNORES: these results are ordered by relevance, and
 * re-sorting them by time would discard the ranking that is the entire point of
 * the surface. (An agent that wants "recent, ranked" filters with
 * `updated_since` and keeps the relevance order.)
 *
 * Pagination stays disabled (BM25 / RRF score is not a stable cursor key); v1
 * caps at `limit` and returns no `next_cursor`.
 */
export async function searchDocumentsCore(
  env: Env,
  rawQuery: string,
  params: ListParams,
  mode: SearchMode = "hybrid",
): Promise<{ ok: true; documents: SearchHit[] } | SearchErr> {
  // FTS needs the tokenized form; it can be null (only punctuation / 1-char
  // words). That's `bad_query` ONLY when no semantic leg can carry the search.
  const match = buildFtsMatchQuery(rawQuery);

  if (mode === "keyword") {
    if (!match) return { ok: false, code: "bad_query" };
    return { ok: true, documents: await ftsSearch(env, match, params) };
  }

  // semantic + hybrid both need the query vector. Best-effort embed (null on any
  // AI failure → fall back to keyword rather than hard-fail, §10).
  const qvec = await embedQuery(env, rawQuery);

  if (mode === "semantic") {
    if (!qvec) {
      if (!match) return { ok: false, code: "bad_query" };
      return { ok: true, documents: await ftsSearch(env, match, params) };
    }
    const vec = await semanticSearch(env, qvec, params);
    return { ok: true, documents: vec.slice(0, params.limit) };
  }

  // hybrid (default): run both legs, fuse on rank.
  const ftsHits = match ? await ftsSearch(env, match, params) : [];
  if (!qvec) {
    if (!match) return { ok: false, code: "bad_query" };
    return { ok: true, documents: ftsHits }; // AI down → keyword-only, gracefully
  }
  const vecHits = await semanticSearch(env, qvec, params);

  if (ftsHits.length === 0 && vecHits.length === 0) {
    // Nothing matched either leg. If we also had no FTS tokens the query was
    // unusable (bad_query); otherwise it's a legitimate empty result set.
    return match ? { ok: true, documents: [] } : { ok: false, code: "bad_query" };
  }

  const ftsByPid = new Map(ftsHits.map((h) => [h.public_id, h]));
  const vecByPid = new Map(vecHits.map((h) => [h.public_id, h]));
  // Fuse the two RANK lists (best-first public_id arrays). RRF needs no score
  // normalization — see reciprocalRankFusion. Chunking is already invisible:
  // the vector list was collapsed to one entry per doc before this point.
  const fused = reciprocalRankFusion([
    ftsHits.map((h) => h.public_id),
    vecHits.map((h) => h.public_id),
  ]);

  const documents: SearchHit[] = fused.slice(0, params.limit).map(({ id: pid, score }) => {
    // A hit matched by BOTH legs keeps its FTS attribution + bracketed snippet —
    // strictly more informative than the preview (§11). A semantic-only hit gets
    // matched_field "semantic" and the preview snippet. Either way `score` is the
    // FUSED RRF score (higher = better), not the leg's native bm25/cosine.
    const ftsHit = ftsByPid.get(pid);
    if (ftsHit) return { ...ftsHit, score };
    return { ...vecByPid.get(pid)!, score };
  });
  return { ok: true, documents };
}

/**
 * The keyword leg: FTS5/BM25 over `documents_fts` (migrations/0006). `match` is a
 * SANITIZED FTS5 MATCH expression (from `buildFtsMatchQuery`). Tag/slug filters
 * compose with the MATCH; revoked docs are excluded via the JOIN's
 * `d.revoked_at is null` AND the DELETE in revokeDocumentCore's batch (belt and
 * suspenders). `matched_field` is per-column `snippet()` bracketing (title >
 * description > body priority — see the SearchHit doc comment); tags are not
 * FTS-indexed (migration 0012). Returns hits in BM25 rank order (best first).
 */
async function ftsSearch(env: Env, match: string, params: ListParams): Promise<SearchHit[]> {
  // Per-row shape with the overall BM25 score and three per-column snippet
  // outputs. The snippets are how we detect which columns matched: FTS5's
  // snippet() wraps matched tokens with the start/end delimiters we pass,
  // so the presence of '[' in a column's snippet means that column had a
  // hit. (See SearchHit doc comment for why we don't use per-column bm25.)
  // Score and snippets are search-internals — destructured off before the
  // row hits the SearchHit response shape.
  type Row = Omit<DocumentListing, "tags"> & {
    id: string;
    tags: string | null;
    score: number;
    title_snippet: string | null;
    description_snippet: string | null;
    body_snippet: string | null;
  };

  const clauses: string[] = ["documents_fts match ?", "d.revoked_at is null"];
  const binds: unknown[] = [match];

  for (const tag of params.tags) {
    clauses.push("d.tags like ? escape '\\'");
    binds.push(tagLikePattern(tag));
  }
  if (params.slug !== null) {
    clauses.push("d.slug = ?");
    binds.push(params.slug);
  }
  if (params.status !== null) {
    clauses.push("d.status = ?");
    binds.push(params.status);
  }
  if (params.visibility !== null) {
    clauses.push("d.visibility = ?");
    binds.push(params.visibility);
  }
  if (params.publication !== null) {
    // Same publication filter the list surface takes (migration 0018): it
    // narrows WHICH rows can rank, like every other filter here, and never
    // reorders them.
    clauses.push(publicationClause(params.publication));
  }
  if (params.updatedSince !== null) {
    // The change-feed window (migration 0017) filters search too — same
    // inclusive `>=` and same pre-normalized bound as the list surface. It
    // narrows WHICH rows can rank; it never reorders them.
    clauses.push("d.updated_at >= ?");
    binds.push(params.updatedSince);
  }

  // Snippet builtin: 6-arg form is (table, column_idx, start, end, ellipsis,
  // token_count). Columns are 0-indexed counting the UNINDEXED column, in
  // CREATE order — after migration 0012: document_id=0, title=1, description=2,
  // body=3 (the old tags column at index 3 is gone, so body moved 4→3). bm25()
  // uses the SAME convention: one weight per column of the table, UNINDEXED
  // included, so the weight list below is four long and leads with a wasted 0.0
  // for document_id (see BM25_WEIGHTS — dropping that slot silently shifts
  // every weight one column left). One snippet() per indexed column gives us
  // both the bracketed match context AND the per-column "did this match" signal
  // — a column whose snippet contains '[' had a hit. FTS5 caches the match
  // state across these snippet() calls per row.
  const sql = `select ${LISTING_SELECT_COLUMNS},
       -bm25(documents_fts, ${BM25_WEIGHTS.document_id}, ${BM25_WEIGHTS.title}, ${BM25_WEIGHTS.description}, ${BM25_WEIGHTS.body}) as score,
       snippet(documents_fts, 1, '[', ']', '…', 16) as title_snippet,
       snippet(documents_fts, 2, '[', ']', '…', 16) as description_snippet,
       snippet(documents_fts, 3, '[', ']', '…', 16) as body_snippet
     ${LISTING_JOINS}
     join documents_fts on documents_fts.document_id = d.id
     where ${clauses.join(" and ")}
     order by score desc
     limit ?`;
  binds.push(params.limit);

  const result = await env.META.prepare(sql).bind(...binds).all<Row>();
  return (result.results ?? []).map((row) => {
    // Detect which columns matched by looking for FTS5's bracket delimiters
    // in each per-column snippet. The snippet builtin only wraps matched
    // tokens with the start/end strings we passed — a column with no match
    // gets its value back verbatim, no brackets. This is unambiguous and
    // works around D1's FTS5 not honoring weight-isolation for per-column
    // bm25 attribution (see the SearchHit doc comment).
    //
    // Priority on multi-column matches: title > description > body.
    // Mirrors the BM25 weight ordering — a hit in curated metadata is a
    // stronger relevance signal than a body mention. Deterministic, so
    // identical queries on identical content always pick the same field.
    const matched = {
      title: (row.title_snippet ?? "").includes("["),
      description: (row.description_snippet ?? "").includes("["),
      body: (row.body_snippet ?? "").includes("["),
    };
    const matched_field: SearchHit["matched_field"] = matched.title
      ? "title"
      : matched.description
        ? "description"
        : "body"; // every row has at least one match (it's a search hit);
                  // if no column lit up via the bracket signal something
                  // upstream broke and we default to body, which is the
                  // most informative snippet to surface anyway.

    // Snippet to surface: just the matched column's bracketed output.
    // All three columns get snippet()'d so we can pick any one without an
    // extra round trip.
    const snippetByField = {
      title: row.title_snippet ?? "",
      description: row.description_snippet ?? "",
      body: row.body_snippet ?? "",
    } as const;
    const snippet = snippetByField[matched_field];

    // Strip the search-internal columns from the row before it becomes a
    // SearchHit. The destructured locals are unused (signalled with `_`)
    // but the spread of `rest` is what guarantees the response shape.
    const parsedTags = parseStoredTags(row.tags);
    const {
      id: _id,
      tags: _tags,
      score: _score,
      title_snippet: _tsn,
      description_snippet: _dsn,
      body_snippet: _bsn,
      ...rest
    } = row;
    return {
      ...rest,
      tags: parsedTags,
      score: row.score,
      matched_field,
      snippet,
    };
  });
}

/**
 * The semantic leg: embed-side already done (`qvec`). Query Vectorize, collapse
 * the chunk hits to one candidate per document (best cosine, carrying the
 * winning chunk's preview — `queryVectors`/`collapseChunksToDocs`), then RE-JOIN
 * those doc ids through D1. The re-join is where revoked + the tag/slug filters
 * are authoritatively enforced for semantic hits (Vectorize is a ranker, never
 * the gate): a candidate that's revoked or filtered out simply isn't
 * materialized. Returns hits in cosine-rank order so the caller's RRF sees the
 * vector ranking. A Vectorize hiccup degrades to "no semantic hits" (the caller
 * keeps the FTS leg), never a hard error.
 */
async function semanticSearch(
  env: Env,
  qvec: number[],
  params: ListParams,
): Promise<SearchHit[]> {
  let candidates: VectorCandidate[];
  try {
    candidates = await queryVectors(env, qvec);
  } catch (err) {
    console.error("vector.query.failed", String(err));
    return [];
  }
  if (candidates.length === 0) return [];

  type Row = Omit<DocumentListing, "tags"> & { id: string; tags: string | null };
  const ids = candidates.map((c) => c.id);
  const placeholders = ids.map(() => "?").join(", ");
  const clauses: string[] = [`d.id in (${placeholders})`, "d.revoked_at is null"];
  const binds: unknown[] = [...ids];
  for (const tag of params.tags) {
    clauses.push("d.tags like ? escape '\\'");
    binds.push(tagLikePattern(tag));
  }
  if (params.slug !== null) {
    clauses.push("d.slug = ?");
    binds.push(params.slug);
  }
  if (params.status !== null) {
    clauses.push("d.status = ?");
    binds.push(params.status);
  }
  if (params.visibility !== null) {
    clauses.push("d.visibility = ?");
    binds.push(params.visibility);
  }
  if (params.publication !== null) {
    clauses.push(publicationClause(params.publication));
  }
  if (params.updatedSince !== null) {
    // Enforced in the D1 re-join, not against Vectorize metadata — same rule as
    // revoked/tags/slug: the vector index is a ranker, D1 is the authority.
    clauses.push("d.updated_at >= ?");
    binds.push(params.updatedSince);
  }
  const sql = `select ${LISTING_SELECT_COLUMNS}
     ${LISTING_JOINS}
     where ${clauses.join(" and ")}`;
  const result = await env.META.prepare(sql).bind(...binds).all<Row>();

  // Map internal id → listing row, then walk the candidate order (cosine desc)
  // so the returned rank list matches the vector ranking RRF expects. A
  // candidate with no row (revoked / filtered out) is silently dropped.
  const rowById = new Map<string, Row>();
  for (const row of result.results ?? []) rowById.set(row.id, row);

  const hits: SearchHit[] = [];
  for (const cand of candidates) {
    const row = rowById.get(cand.id);
    if (!row) continue;
    const { id: _id, tags, ...rest } = row;
    // Snippet = the winning chunk's preview (the passage whose vector actually
    // matched), deliberately NOT bracketed (the lack of brackets itself signals
    // "concept match, not term match" — §11). Falls back to a description/title
    // excerpt only when the chunk carried no preview (a legacy vector written
    // before previews, until the next sync/backfill heals it).
    const snippet = cand.preview ?? semanticFallbackSnippet(rest.description, rest.title);
    hits.push({
      ...rest,
      tags: parseStoredTags(tags),
      score: cand.score, // cosine; overwritten by the fused score in hybrid mode
      matched_field: "semantic",
      snippet,
    });
  }
  return hits;
}

/** Snippet for a semantic hit whose winning chunk carried no preview metadata. */
function semanticFallbackSnippet(description: string | null, title: string | null): string {
  const text = (description ?? title ?? "").trim();
  return text.length > 256 ? text.slice(0, 256) : text;
}
