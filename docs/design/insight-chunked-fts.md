# Chunked `documents_fts` — the Insight escape hatch (design note, deferred)

**Status: DEFERRED — design note only, NOT built.** Written as the companion to
migration `0019` (Insight structured-metadata columns) during the
agent-web-host-insight fork; see `slopcafe_migration/DESIGN.md` Decision 8, item 2
("Chunked FTS — DESIGN NOTE ONLY for now"). Nothing in this document is
implemented; it exists so a future implementer doesn't have to re-derive the shape
from scratch if the trigger condition in §7 is ever hit.

## 1. Problem this would solve

`documents_fts` (migration 0006, reshaped by 0012) stores **one row per live
document**, with the WHOLE document's markdown in a single `body` column
(`src/core.ts`'s write paths: `htmlToMarkdown(prep.cleanedHtml)`, inserted in the
same `META.batch()` as the version row). D1/SQLite bounds that matter here:

- a **row** is capped at 2 MB,
- a **SQL statement** (the `INSERT`/`UPDATE` that carries the row) is capped at
  100 KB.

A document whose rendered markdown exceeds those limits fails the FTS write
outright — and because the FTS statement rides the *same* `.batch()` as the
version/document rows (`publishDocumentCore`/`updateDocumentCore` in
`src/core.ts`), a batch failure fails the **whole publish**, not just the search
index. This was flagged as the "CRITICAL GAP" in the platform-architecture
research behind the Slopcafe migration (`auto-insight-slopcafe`'s
`slopcafe_migration/research/04-slopcafe-architecture.md`): *"the current search
assumes small-to-medium docs; never exercised on multi-MB bodies."*

## 2. Why it's deferred, not built

The migration design that produced this fork bounds the problem away instead of
solving it: `slopcafe_migration/DESIGN.md` **Decision 1** caps every
Insight-produced document's primary rendered body at **≤ 256 KB**, with an
overflow rule (oversized sections spill into linked child documents — a
`document_links` graph reference, never silently dropped) so no single document
the producer writes ever approaches the 2 MB row / 100 KB statement ceilings.
256 KB is comfortably inside both bounds even accounting for markdown-to-... the
FTS body being the *whole* document, not a truncated one.

So: **as long as the producer honors the 256 KB bound, the existing single-row
FTS works with no fork.** Building chunked FTS tonight would mean shipping a
non-trivial schema/write/read change with **no live D1 to validate it against**
(this fork was written without Cloudflare credentials — see the migration
0019 header and `slopcafe_migration/DESIGN.md`'s closing paragraph) to solve a
problem the producer doesn't have yet. That's the wrong trade for an additive,
reviewable overnight fork. This note is the deferral's paper trail: written up
so the reasoning and the shape survive even though the code doesn't exist.

## 3. The trigger condition for revisiting

Build this **only if** a future Insight document genuinely needs to exceed the
256 KB bound as a *single, unbounded* document — i.e. the child-document spill
rule (Decision 1) stops being an acceptable answer for some new document shape
(a hypothetical "the whole app's flag history in one document" use case was
one example raised during the migration design, though Decision 1 currently
routes that through child docs instead). If that need never materializes, this
document should stay exactly what it is: a note, not a debt.

## 4. Proposed mechanics (mirrors `src/vector.ts`'s chunking, not invented fresh)

The codebase already solved "one document, many indexed pieces, fold back to one
result" for semantic search (`docs/design/vector-search-design.md`, built). The
chunked-FTS shape below is deliberately the **same decomposition** applied to
FTS5 instead of Vectorize, so it reuses a pattern reviewers and future
implementers already understand rather than inventing a second one.

### 4.1 Schema: `documents_fts` becomes one row per chunk

Today (`documents_fts`, migration 0012's shape):

```
CREATE VIRTUAL TABLE documents_fts USING fts5(
  document_id UNINDEXED,
  title,
  description,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
```

— exactly one row per live document (`document_id` is a de facto unique key,
though FTS5 has no real constraint mechanism to enforce that).

Chunked shape: add a chunk index to the key and store per-chunk body text,
carrying `title`/`description` only on chunk 0 (mirroring `chunkEmbedInputs` in
`src/vector.ts`, which prepends the title/description head to chunk 0 alone —
*"prepending it to every chunk would pull all of a doc's vectors toward a
common centroid," the same argument applies to FTS relevance: repeating the
title/description in every chunk row would let a document with many chunks
dominate title/description matches purely by chunk count*):

```
CREATE VIRTUAL TABLE documents_fts USING fts5(
  document_id UNINDEXED,
  chunk_index UNINDEXED,
  title,
  description,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
```

`chunk_index` is `UNINDEXED` (never searched, only used to distinguish/order
rows for one `document_id` — the same role `document_id` itself already plays).
`title`/`description` are non-null only on `chunk_index = 0`; other chunks carry
empty strings there (FTS5 has no per-row NULL for indexed columns in a useful
sense — an empty string is the practical "nothing here" for BM25 purposes,
matching how a chunk-0-only head already behaves in the vector design).

### 4.2 Chunk split: reuse `chunkEmbedInputs`, don't reinvent it

`src/vector.ts` already exports `chunkEmbedInputs(title, description, body):
string[]` — heading/paragraph-aware windowing, `TARGET_CHUNK_CHARS` (2000),
`CHUNK_OVERLAP_CHARS` (200) tail overlap, capped at `MAX_CHUNKS` (24), with the
title/description head prepended to chunk 0 only. That function is **already
exactly the split this design needs** for FTS chunk boundaries — same
granularity goal (a buried passage should be findable on its own terms, not
diluted into a whole-document average/rank). The chunked-FTS write path should
call the same function rather than writing a second, subtly-different chunker;
two chunkers chunking the same document differently would make the FTS chunk
boundaries and the vector chunk boundaries drift for no reason, which would be
a maintenance trap the first time someone tries to correlate a semantic hit's
`preview` against an FTS `snippet()`.

### 4.3 Write path

Everywhere `publishDocumentCore`/`updateDocumentCore` (`src/core.ts`) currently
emit **one** `documents_fts` `INSERT`/`DELETE+INSERT` per write, they would
instead emit **N** (one per chunk from `chunkEmbedInputs`), still inside the
same `META.batch()` — the write-path-local, no-triggers discipline
(`CLAUDE.md`'s "FTS sync is write-path-local" convention) does not change, only
the row count does. This is where the 100 KB statement cap actually gets
respected: each chunk's `body` is bounded by `TARGET_CHUNK_CHARS` (2000 chars,
plus overlap), so each `INSERT` statement is small regardless of total document
size; the previous single-row `INSERT` was the one whose size scaled with the
whole document.

`updateDocumentCore`'s existing `delete from documents_fts where document_id =
?` (a per-document delete, not per-row) still works unchanged — it deletes every
chunk row for that document in one statement, so the DELETE-then-INSERT
resync pattern doesn't need to know the old chunk count (the same "fixed range,
no orphan tail" property `src/vector.ts`'s `chunkVectorIdRange` gives the vector
side, but for free here since SQL `DELETE ... WHERE document_id = ?` already
matches an arbitrary number of rows).

### 4.4 Read path: fold chunk hits back to one result per document

`searchDocumentsCore` (`src/core.ts`) currently runs one FTS `MATCH` query and
gets back one row per matching document, complete with `bm25()` and three
`snippet()` calls (title/description/body) used to compute `SearchHit.
matched_field`/`snippet` (see the doc comment on that section — "Priority on
multi-column matches: title > description > body"). With chunked storage, a
single `MATCH` query returns one row **per matching chunk**, potentially several
per document. The read path needs a fold step, structurally identical to
`collapseChunksToDocs` in `src/vector.ts` (which already does exactly this for
Vectorize's chunk-level cosine hits):

1. Run the FTS `MATCH` query as today, but the row set is now chunk rows.
2. Group by `document_id`; within each group, keep the **best-scoring chunk**
   (lowest raw `bm25()`, since `core.ts` negates it so "higher is better" —
   same sign convention already documented on `SearchHit.score`) as that
   document's representative hit.
3. The representative chunk's `snippet()` output becomes the document's
   `SearchHit.snippet` (chunk 0's snippet also carries the title/description
   attribution, since only chunk 0 has non-empty title/description columns —
   a hit whose ONLY match is in a body chunk with `chunk_index > 0` is
   unambiguously a `matched_field: "body"` hit, which is arguably a clearer
   signal than today's shape, not a regression).
4. Continue exactly as today from there — the collapsed one-row-per-document
   list re-joins `LISTING_JOINS` (`d.revoked_at is null`, tag/slug/status
   filters) exactly like the current FTS leg, and feeds `reciprocalRankFusion`
   exactly like the semantic leg already does. Hybrid fusion doesn't care that
   one of its input lists used to come from a single query and now comes from
   query-plus-fold — the list shape RRF consumes (`{id, score}[]`, best-first)
   is unchanged.

The `BM25_WEIGHTS` mechanism (`src/core.ts`) — "one weight per column of the
table, including UNINDEXED" — still applies; `chunk_index` joins `document_id`
as a zero-weighted UNINDEXED slot in the weight list, the same trap already
documented for adding any column to `documents_fts` ("Add a `documents_fts`
column → both argument lists move together," `CLAUDE.md`).

## 5. Concrete files a future implementer would touch

| File | What changes |
|---|---|
| `migrations/00NN_chunked_fts.sql` | Rebuild `documents_fts` with `chunk_index` added to the CREATE (FTS5 can't `ALTER ADD COLUMN` on a virtual table — this is a drop/recreate + repopulate, the same shape migration 0012 already used to reshape this exact table. **Repopulating body text is NOT possible from a pure-SQL migration** — the FTS `body` column is the *only* place chunk text would live (no `versions`/`documents` column holds it, same as today's single-row body) — so this migration needs a one-time backfill pass through the write path's chunking logic, not a `CREATE TABLE ... AS SELECT`, unlike 0012's carry-through (0012 could copy `body` verbatim because the column shape didn't change; this does, because the row-per-document invariant becomes row-per-chunk). |
| `src/vector.ts` | `chunkEmbedInputs` becomes a two-consumer pure function (semantic chunking AND FTS chunking) — if the two ever need different granularity, split the export rather than parameterizing one function for two silently-different call sites. |
| `src/core.ts` | `publishDocumentCore`/`updateDocumentCore`: replace the single `documents_fts` INSERT with a loop over `chunkEmbedInputs(...)` results. `searchDocumentsCore`: add the chunk-fold step (§4.4) between the FTS query and the existing `LISTING_JOINS` re-join; `BM25_WEIGHTS`/`snippet()` index arguments need the `chunk_index` slot accounted for (see the "silent-corruption trap" pattern already called out for the 0012 migration — a uniform off-by-one here corrupts ranking/snippets with no error, exactly like last time). |
| `test/search.test.mjs` (or wherever `buildFtsMatchQuery`/BM25 weight tests live) | New coverage for the fold step: a synthetic multi-chunk document must produce exactly one `SearchHit`, and the "did title/description match" attribution must still work when the match is on a non-zero chunk. |
| `docs/http-api.md`, `src/openapi.ts` | No wire-shape change expected (`SearchHit` stays the same shape — chunking is meant to be invisible to the contract, exactly as `docs/design/vector-search-design.md` §2.1 states for the vector side: *"the read path collapses chunk hits back to one hit per document ... so chunking is invisible to the SearchHit contract"*) — but re-verify against `test/openapi.test.mjs`'s freshness gate before assuming that's still true. |
| This file (`docs/design/insight-chunked-fts.md`) | Update status from DEFERRED to BUILT (or partially-built) in the same commit that implements any of the above — per `CLAUDE.md`'s "keeping these honest" rule for design notes. |

## 6. Non-goals / what this note does NOT propose

- **No change to Vectorize/semantic chunking.** `src/vector.ts`'s existing
  `MAX_CHUNKS` (24) / `TARGET_CHUNK_CHARS` (2000) chunking for the semantic leg
  is unrelated machinery that already exists and already works; this note
  proposes reusing its pure split function, not modifying its behavior.
- **No change to the 256 KB producer bound.** This note is explicitly the
  escape hatch *for when* that bound needs to be exceeded — it does not argue
  for raising or removing it. `slopcafe_migration/DESIGN.md` Decision 1 is the
  place that bound is owned.
- **No change to `MAX_INPUT_BYTES` (5 MiB, `src/core.ts`)** or any other
  Slopcafe-wide limit — this is purely about how one already-accepted document
  gets indexed for keyword search, not about what's accepted at write time.
- **Not a batch/bulk-ingest design.** Orthogonal to the "no bulk endpoint"
  finding in the migration's platform-architecture research; chunked FTS is
  about document *size*, not document *count*.

## 7. Summary

Build this if and only if a real Insight document needs to be a single,
unbounded document larger than ~256 KB of rendered markdown. Until then, the
producer-side size bound (`slopcafe_migration/DESIGN.md` Decision 1) is cheaper,
simpler, and already shipped, and this note is the paper trail so the shape
doesn't need to be re-derived if that changes.
