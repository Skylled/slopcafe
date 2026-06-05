# Semantic (vector) search — design note

**Status:** **BUILT (phases 1–3)** — design + as-built record. Direction chosen by
the operator: **chunked vectors (N per document), Cloudflare Vectorize + Workers
AI, hybrid with the existing FTS5/BM25 search via Reciprocal Rank Fusion.**
Everything below is a decided constraint unless tagged *deferred*. The write path,
backfill, and hybrid read path have landed (see §13 for what shipped and the
as-built deltas); phase 4 (Queue-backed durable sync, cron backfill,
`vector_synced_ver`) remains deferred.

> **As-built deltas from this note (2026-06-05 implementation):**
> - **Pure vs I/O split:** the pure helpers are in `src/vector.ts` (as planned);
>   the Vectorize/AI I/O landed in a dedicated **`src/vector-io.ts`** (the "thin
>   `src/vector-io.ts`" option §9 offered), not folded into `core.ts`.
> - **`Env.VECTORIZE` type is `Vectorize`** (the current async-mutation binding
>   type for a freshly-created index), not the deprecated-beta `VectorizeIndex`
>   §4 named. Functionally identical for our calls (query/upsert/deleteByIds/
>   getByIds); we ignore the mutation return.
> - **Qwen3 input fields verified** against `@cloudflare/workers-types`: documents
>   pass `{ text: string[] }`, the query passes `{ queries, instruction }`, both
>   return `{ data: number[][] }`. (The §2 build-time caveat — confirm field
>   names + the enforced token cap empirically — is resolved for field names;
>   the 8,192-vs-4,096 token cap is moot at our ~500-token chunks.)
> - **Backfill takes query params** (`?mode=&limit=&cursor=`), not a JSON body,
>   matching the `GET …/search` style; it runs synchronously and reports
>   `{ mode, scanned, embedded, vectors, skipped, next_cursor }`.

This follows the shape of `source-retention-design.md` /
`byte-exact-publish-design.md`: problem → decisions → mechanics → docs/test/cost
→ rollout → deferred.

---

## 1. Problem & goal

Search today is keyword-only: `searchDocumentsCore` (`src/core.ts:1885`) runs an
FTS5 `MATCH` over `documents_fts` and ranks with `bm25()`. That nails exact
terms, slugs, and identifiers, but misses paraphrase and concept matches ("how
do I keep a doc private" won't find a doc titled "visibility & access control").

**Goal:** add semantic recall *without* removing keyword precision. The two are
complementary, so the target is **hybrid search** — run both, fuse the rankings —
not a replacement. Keep the agent-facing contract (`SearchHit`, the
`search_documents` MCP tool) backward-compatible where possible.

## 2. Decisions (locked)

1. **Chunked: N vectors per document.** Split the embed input into ~512-token
   chunks (heading/paragraph-aware, small overlap), one vector per chunk, keyed
   `${docId}#${i}`. The read path collapses chunk hits back to one hit per
   document before fusion (§10), so chunking is invisible to the `SearchHit`
   contract. **Why chunk** (the call that reversed the original single-vector
   plan, operator 2026-06-04): mean-pooling a whole long note into ONE vector
   dilutes any narrow concept buried deep in it — the exact recall semantic
   search exists to provide. Per-chunk vectors let a buried passage match
   strongly instead of being averaged away. This holds *even though* docs now fit
   the model's context window (§2.3 caveat): the window question is about truncation;
   the dilution question is about pooling, and they're independent. Cost is free
   either way at our scale (§15), so the decision turns purely on recall quality.
   Mechanics in §5; chunk-count cap and orphan handling in §6.
2. **Cloudflare Vectorize** for the index (native binding, no egress, free at our
   scale — §15). Not turbopuffer/Pinecone/pgvector (overkill for single-tenant,
   small corpus).
3. **Workers AI `@cf/qwen/qwen3-embedding-0.6b`** for embeddings — **1024 dims,
   cosine**. **LOCKED** (operator, 2026-06-04). Rationale: best-quality *native*
   Workers AI embedding model for a long-document English corpus — newest of the
   catalog (2025 vs bge's 2023), state-of-the-art for its size (reported to edge
   out flagship OpenAI/Cohere embeddings at the 0.6B class), **instruction-aware**
   (a query-side task prefix buys ~1–5% recall; see §10), and — verified against
   the live Workers AI model page — both the **cheapest** credible option
   (**1,075 neurons / M input tokens**, ~5.6× cheaper than `bge-base-en-v1.5`'s
   6,058) *and* the one with the **largest input window** (**8,192 tokens** on
   Workers AI — 16× bge-base-en's 512-token cap). The cost-vs-quality tension the
   first revision worried about turned out not to exist: Qwen3 is both. *Index
   dimensionality is immutable*, so this is the one sticky choice — changing
   models later means a new index + full re-embed, never an in-place swap
   (Matryoshka only lets us shrink *dims* on a new index of the **same** model,
   not swap models in place).

   > **Verify-at-build caveats (from the 2026-06-04 Workers AI doc audit):**
   > - **Context window: Cloudflare publishes two conflicting numbers.** The
   >   current model page says **8,192 tokens**; their 2026-04-09 launch changelog
   >   said **4,096**; the upstream base model is 32K. We design to 8,192 but
   >   **confirm the enforced cap empirically** before freezing chunk size (§5) —
   >   send an over-limit input and observe error-vs-silent-truncate. Either
   >   published number is comfortably larger than our ~512-token chunks, so this
   >   only matters for the safety margin, not the core design.
   > - **No in-API Matryoshka.** The base model is MRL-truncatable 32–1024, but
   >   Workers AI exposes **no `dimensions` parameter** — you get the full 1024.
   >   That's what we index anyway; we just can't shrink it server-side. (Earlier
   >   "truncatable 32–1024" framing overstated what WAI gives us.)
   > - **Native `instruction` param.** WAI exposes `instruction` (and distinct
   >   `queries` / `documents` inputs) and assembles the `Instruct:\nQuery:`
   >   prefix server-side — so we pass `instruction` rather than hand-prepending a
   >   string (§10). Confirm the exact input field names + return shape against the
   >   model page at build time (CF doesn't document the templating internals).
   >
   > **CHANGED 2026-06-04 (supersedes a same-day bge-base-en lock — see §16).**
   > This slot first locked `@cf/baai/bge-base-en-v1.5` (768 dims) on a *cheapest
   > credible English model* rationale. Auditing the current Workers AI catalog
   > the same day surfaced Qwen3 and showed the original rationale was doubly
   > wrong: Qwen3 is *cheaper* per token than bge-base (1,075 vs 6,058 neurons/M),
   > and bge-base-en's 512-token ceiling truncates exactly the long archival docs
   > that are the point of this corpus. `embeddinggemma-300m` (768 dims, 2,048 ctx)
   > was the minimal-deviation alternative but is **absent from the WAI pricing
   > table** entirely (unmodelable cost) and thinly documented; Qwen3 won on
   > window + retrieval quality + documented price. The earlier
   > English-specialization argument for bge-base is real but outweighed here —
   > Qwen3's English retrieval is strong despite being multilingual.
4. **Hybrid via Reciprocal Rank Fusion (RRF).** Combine the FTS rank list and the
   (chunk-collapsed) vector rank list with `score = Σ 1/(k + rank_i)`, `k = 60`.
   RRF needs no score normalization — critical because BM25 (unbounded, negated)
   and cosine (`[-1,1]`) aren't on the same scale.
5. **Vectorize is a candidate ranker, never the access gate.** The authoritative
   "is this doc live / does this caller see it" check stays in D1 — vector hits
   are re-joined through `LISTING_JOINS` with `d.revoked_at is null` exactly like
   FTS hits today (§7, §10). The vector store can lag or hold a stale row; the D1
   re-join is belt-and-suspenders, mirroring the existing FTS `revoked_at` filter
   + delete-in-batch pattern.
6. **Vector sync is eventually-consistent and best-effort in v1.** Vectorize is
   **not transactional with D1** (async mutations, 5–10 s visibility lag), so the
   vector write **cannot** join the `META.batch()` that keeps FTS atomic. A
   missing/stale vector degrades gracefully — the doc still surfaces via BM25.
   This is a documented bounded blind spot, same stance as the `converter_v`
   FTS-vs-read drift and the best-effort storage cap.

## 3. Architecture at a glance

```text
WRITE (publish/update)                 READ (search_documents / GET .../search)
─────────────────────                  ────────────────────────────────────────
core computes ftsBody (already!)       embed(query, instruction) ─┐
        │                                                          ├─ VECTORIZE.query
        ├─ D1 batch: docs+versions+FTS  FTS5 MATCH  ───────────────┘   → chunk IDs+cosine
        │  (atomic, unchanged)                  │                  │
        └─ after commit, waitUntil:             │       collapse chunks→docs (best/doc)
           chunkEmbedInputs → N vectors         │                  │
           deleteByIds(range) → upsert(0..n-1)  │              fuse (RRF)
                                                 └──────────────────┤
REVOKE                                              re-join top-N through D1
──────                                              (LISTING_JOINS, revoked_at,
D1 batch flips revoked_at + FTS delete               tags/slug filters)
        └─ after commit, waitUntil:                          │
           deleteByIds(${docId}#0 … #MAX-1)             SearchHit[]
```

## 4. Infra & configuration

**Create the index** (immutable dims/metric):

```sh
npx wrangler vectorize create agent-web-host-docs --dimensions=1024 --metric=cosine
```

**Bindings** (`wrangler.toml`):

```toml
[ai]
binding = "AI"            # Workers AI — env.AI.run("@cf/qwen/qwen3-embedding-0.6b", …)

[[vectorize]]
binding = "VECTORIZE"
index_name = "agent-web-host-docs"
```

**`Env` type** (`worker-configuration.d.ts` is generated; if hand-maintained, add
`AI: Ai` and `VECTORIZE: VectorizeIndex`). We create **no metadata *indexes*** —
the doc id is recovered by parsing the chunk vector ID (`id.split("#")[0]`) and
the authoritative row comes from a D1 re-join (§10), so the 64-byte
indexed-metadata truncation and the "create-index-before-insert" footgun never
apply. (We *do* store one **non-indexed** metadata field per vector — a short
`preview` for the semantic-hit snippet, §5/§11 — but non-indexed metadata is
returnable, not filterable, so neither footgun touches it.)

## 5. Data model — no migration required

N vectors per doc, stored in Vectorize. Each chunk's ID is **`${documents.id}#${i}`**
(`documents.id` = the internal UUID already used as `documents_fts.document_id`;
`i` = 0-based chunk index). The doc id is recoverable as `id.split("#")[0]`, which
makes the read-time collapse (§10) and the `where d.id in (...)` re-join identical
to the FTS join key — and means **no per-vector metadata is needed** (no metadata
index, no staleness surface). UUID(36) + `#` + ≤2 digits is well under Vectorize's
64-byte ID cap.

**No D1 schema change.** The vectors live in Vectorize; nothing about them needs a
column — *including* the chunk count, which the fixed-range delete (§6) makes
unnecessary to track. (Same ethos as the version-history feature, which needed no
migration.) A `documents.vector_synced_at` observability column is *deferred* —
the write path is idempotent without it, and v1 doesn't need staleness telemetry.

**Chunking rule (`chunkEmbedInputs`, pure, in `src/vector.ts`):** input is
`title`, `description`, and `ftsBody` — the exact `htmlToMarkdown(prep.cleanedHtml)`
already computed for FTS (`src/core.ts:596`, `:779`). **No second R2 read, no
second parse** — vectorization is one more derivation off bytes the write path
already holds. The split:
- **Chunk 0 leads with `${title}\n\n${description}\n\n${firstBodyWindow}`** so a
  title/summary-shaped query matches it; **subsequent chunks are body-only**.
  Prepending title+description to *every* chunk would pull all chunks toward a
  common centroid and erode the inter-chunk discrimination that is the whole point
  of chunking — so it lives in chunk 0 only.
- Body is split on **heading/paragraph boundaries** (`\n#…` headings, blank-line
  paragraph breaks), greedily packed into `TARGET_CHUNK_CHARS` (~2,000 chars ≈
  ~500 tokens — sized for *granularity*, far under the 8,192 window) with a
  ~`CHUNK_OVERLAP_CHARS` (~200) overlap so a concept straddling a boundary isn't
  cut mid-thought. Splitting on headings means a chunk usually *starts* with its
  `##` section heading — free local context, no per-chunk title injection.
- **`MAX_CHUNKS` cap (~24).** ~24 × ~500 tokens ≈ ~12k tokens of coverage (more
  than a single 8,192-token pass) — body past that is dropped and the drop is
  logged (code only). Far more coverage than the old single-vector 512-token
  truncation; rare to hit on this corpus.
- **Deterministic** — same `(title, description, body)` → same chunk array,
  byte-for-byte — so a re-embed/backfill reproduces the stored vectors exactly.
  `TARGET_CHUNK_CHARS` / `CHUNK_OVERLAP_CHARS` / `MAX_CHUNKS` are named constants
  in `src/vector.ts` so they're sweepable in the E2E (§14) rather than baked in.

**No instruction prefix on the document side** — the instruction-aware prefix is a
*query-side* lever only (§10); keep the chunk inputs prefix-free so the stored
vectors stay symmetric with a re-embed.

**Metadata stored on the vector:** one **non-indexed** field, `preview` — a
trimmed ~256-char slice of the chunk's text, written at upsert time (§6) and
returned on query (§10) to build the snippet for a semantic-only hit (§11).
Non-indexed = returnable but not filterable, so it dodges the indexed-metadata
footguns (§4); and because it travels *with* the vector and is re-written on every
sync, it can't drift from the embedded chunk. The doc id is **not** in metadata
(it's parsed from the chunk ID) and the authoritative listing row still comes from
the D1 re-join (§10), so metadata is never an access or identity surface — only a
display preview. (`public_id` is deliberately NOT stored: the chunk ID already
yields the doc id, and storing it would add a staleness surface for no gain.)

## 6. Write path — embed + upsert after commit

Both `publishDocumentCore` and `updateDocumentCore` already end in a `META.batch`
that writes docs/versions/FTS atomically (`src/core.ts:599`, `:801`). **Leave
that batch untouched.** After it commits, schedule the vector sync off the
request's lifetime:

- Thread an optional `waitUntil: (p: Promise<unknown>) => void` into the write
  cores; callers pass `ctx.waitUntil.bind(ctx)`, unit tests omit it (the sync
  becomes a no-op). **Plumbing researched — smaller than first flagged:**
  - **MCP (both doors): nothing to plumb.** `handleMcp(request, env, ctx, props)`
    already receives `ctx` (`src/mcp.ts:83`), and all seven tools are closures
    defined *inside* that function — so `ctx.waitUntil` is already in scope at
    every tool handler. Verified the `ctx` is the **real** ExecutionContext, not a
    stub: `@cloudflare/workers-oauth-provider` decorates the genuine `ctx` with
    `.props` (`ctx.props = …` then `apiHandler.fetch(request, env, ctx)` —
    `dist/oauth-provider.js:2042,2050`) rather than substituting one, so
    `waitUntil` is the live runtime one for Door A *and* Door B. Both doors funnel
    through the single `handleMcp(request, env, ctx, props)` call at
    `src/index.ts:149`.
  - **HTTP: a 3-signature change.** `innerHandler.fetch` has `ctx`
    (`src/index.ts:121`) but does **not** currently pass it to `createDocument` /
    `updateDocument` / `revokeDocument`. Thread `ctx` (or just
    `ctx.waitUntil.bind(ctx)`) into those three, then into core. Mechanical,
    behavior-preserving — do it *in* the feature PR, not as dead carry now.
- When present: `waitUntil(syncDocumentVector(env, docId, title, description, body))`.
  When absent (unit tests, any caller that can't supply it): **skip silently** —
  the doc is fully functional, just not yet in the vector index; the next update
  heals it, or the operator-run backfill (§8) does.
- **`syncDocumentVector`** (the chunked write):
  1. `chunks = chunkEmbedInputs(title, description, body)` → up to `MAX_CHUNKS`
     strings (§5).
  2. `result = env.AI.run(MODEL, { text: chunks })` — one batched call (chunk
     count ≤ `MAX_CHUNKS` is well within any plausible batch cap; WAI's exact cap
     for Qwen3 is undocumented — confirm at build, fall back to per-chunk only if
     it rejects).
  3. **Delete-then-upsert to bound orphans** (a shorter update produces fewer
     chunks, which would leave stale tail vectors): first
     `env.VECTORIZE.deleteByIds([${docId}#0 … ${docId}#${MAX_CHUNKS-1}])`
     (idempotent — absent IDs are no-ops), then
     `env.VECTORIZE.upsert(chunks.map((c, i) => ({ id: ${docId}#${i}, values:
     result.data[i], metadata: { preview: c.slice(0, 256) } })))` — the per-chunk
     `preview` is the trimmed text the read path turns into a semantic snippet
     (§5/§10/§11).
     Delete **before** upsert so the range-delete can't wipe the just-written
     vectors. This fixed-range delete is what lets us avoid a chunk-count column
     (§5).
  - Wrap the whole thing in try/catch that logs **code only** (per the
    `src/mcp.ts` logging-discipline rule — never the body, it's user HTML).

**Why not the D1 batch / a Queue in v1?** The batch can't include a non-D1,
async, eventually-consistent mutation without breaking its atomicity guarantee.
A Cloudflare **Queue** (durable, retrying consumer) is the *correct* upgrade and
is **deferred** (§13 phase 4) — `waitUntil` fire-and-forget is enough for v1
because the failure mode (a transient Workers AI / Vectorize hiccup drops a doc's
vectors) degrades to "BM25 still finds it." **Caveat — self-healing assumes a
next write.** A doc updated again re-embeds and heals; but much of this corpus is
*archival / write-once* ("things I worked on"), and those docs never get a
healing write — vectors dropped at publish stay missing indefinitely, and with
`vector_synced_at` telemetry deferred (§16) nothing detects it. So the real v1
durability net for write-once content is the **operator-run backfill (§8)**, which
in v1 is **manual** (no scheduler — see §8); the Queue (phase 4) is what
ultimately closes the gap. Document the Queue upgrade path in CLAUDE.md so it's a
known seam, not a surprise.

## 7. Revoke path — delete the vectors

`revokeDocumentCore` flips `revoked_at` and deletes the FTS row inside its batch
(`src/core.ts:2061`). After that batch commits, schedule
`waitUntil(deleteDocumentVector(env, docId))`, where `deleteDocumentVector` =
`env.VECTORIZE.deleteByIds([${docId}#0 … ${docId}#${MAX_CHUNKS-1}])` (the same
fixed-range delete the write path uses — covers however many chunks the doc had).
**The vector delete is not the kill-switch** — the authoritative gate is
`documents.revoked_at`, flipped *before* the R2/vector cleanup (existing
invariant), and enforced again at read time by the re-join's `d.revoked_at is
null`. So a revoked doc whose vectors haven't been purged yet still cannot appear
in results. Belt and suspenders.

## 8. Backfill — operator-invoked, incremental by default (manual in v1)

Two jobs, one endpoint. (a) Live docs published before this ships have no
vectors — the one-time migration. (b) Because write-once docs don't self-heal
(§6), the same endpoint reconciles anything a transient sync failure dropped.
Add an operator-gated `POST /admin/vectors/backfill` (in `src/admin.ts`,
`requireOperator`) with a `mode`:

- **`mode: "missing"` (default) — incremental; embeds only un-vectorized docs.**
  Page through live docs (`revoked_at is null`) via the existing cursor
  pagination; for each page, `env.VECTORIZE.getByIds(...)` the page's
  `${docId}#0` chunk IDs and embed (`syncDocumentVector`) **only the docs whose
  `#0` came back absent**, skipping the rest. No sense re-embedding known-good
  docs — a steady-state run embeds ~nothing, which is also what would make a
  future cron (§13 phase 4) nearly free.
- **`mode: "rebuild"` — re-embed every live doc.** The full sweep (the original
  behavior): use it after a model or chunk-size change (when every vector must be
  regenerated), or to repair suspected staleness (below).

Shared mechanics: idempotent (upsert-by-id + the §6 range-delete), resumable via
the returned cursor, **upsert in batches of ≤1000 vectors** (the Workers API
per-call cap — silently truncates if exceeded; with chunking, count *vectors* not
docs). `getByIds` is a cheap by-ID fetch (not a vector `query`), one call per
page; the whole job stays comfortably inside the free daily neurons (§15).

**`missing` is presence-only — it heals MISSING, not STALE.** It keys on whether
`#0` exists, so it re-embeds a doc with no vectors (publish-time sync dropped —
the dominant write-once failure §6 names) but will NOT re-embed a doc whose
*content changed* and whose update-time re-sync silently failed: the old vectors
still exist, so `#0` is present and the doc is skipped. The fallbacks for that
rarer stale case are `mode: "rebuild"` (v1) or the deferred `vector_synced_ver`
column (§16) — which would let `missing` compare the embedded version to
`current_ver` and catch staleness authoritatively. Two minor edges: `getByIds`
reflects only *committed* Vectorize mutations (5–10 s lag), so a just-synced doc
may briefly look absent and get harmlessly re-embedded (idempotent); and a doc
with no embeddable content (empty body + metadata → zero chunks) has no `#0` to
find, so treat "produced zero chunks" as synced rather than retrying it forever.

**Manual in v1 — no scheduler.** Reconciliation means *the operator re-invokes
the endpoint* (after a suspected sync gap, or periodically by hand); there is
deliberately **no Cron Trigger** yet. Because `missing` embeds only drift, a
scheduled sweep would now be nearly free — so the cost objection that deferred
cron has largely dissolved, leaving it a "do we want it automatic?" call for
phase 4 (§13), with the Queue (§6) as the other durable-sync answer.
(Alternatively a `wrangler`-invoked one-shot script; the admin endpoint is
preferred so it runs with the deployed bindings and can be re-triggered.)

## 9. New modules & tests

- **`src/vector.ts`** — the pure, unit-testable core, mirroring how `search.ts`,
  `edit.ts`, and `conditional.ts` are standalone (no D1/R2/WASM imports) so
  `test/vector.test.mjs` runs under the Node strip-types runner:
  - `chunkEmbedInputs(title, description, body)` → `string[]` (≤ `MAX_CHUNKS`).
    Test: short doc → 1 chunk; long doc → N chunks with overlap; title+description
    in chunk 0 only; `MAX_CHUNKS` cap clamps + (implicitly) drops the tail;
    determinism (same input → identical array). Document side — **no instruction
    prefix** (that's query-side, §10).
  - `collapseChunksToDocs(hits)` → ordered `{ id, score, preview }[]`, one entry
    per doc — map each hit's vector ID to its doc id (`split("#")[0]`), keep the
    best-scoring chunk per doc **carrying that winning chunk's `preview`** (for the
    snippet, §11), preserve rank order. Test: multiple chunks of one doc collapse
    to the best; the kept entry carries the best chunk's preview; disjoint docs
    preserved; ties.
  - `reciprocalRankFusion(lists, k=60)` → fused, ordered `{ id, score }[]`. **The
    load-bearing pure function** — test ties, single-list, disjoint lists, `k`
    sensitivity. Note `k=60` is the canonical TREC default tuned on large corpora;
    at a small personal corpus it flattens rank position (1/(60+1) vs 1/(60+10)
    is a narrow spread), pushing fusion toward "appears in either list" over
    "ranked well." Keep `k` a single named constant
    so it's sweepable in the E2E.
- **Vector I/O** (`embedQuery`, `syncDocumentVector`, `deleteDocumentVector`,
  `queryVectors`) lives in `src/core.ts` (or a thin `src/vector-io.ts`) — it
  touches `env.AI` / `env.VECTORIZE`, so it's covered by typecheck + the manual
  remote E2E (§14), not the pure-function suite. Same testing stance as the
  restore path.

## 10. Read path — hybrid query in `searchDocumentsCore`

Add an optional `mode: "hybrid" | "keyword" | "semantic"` (default `"hybrid"`):

1. **keyword** → today's behavior exactly (FTS only). Escape hatch for callers
   wanting deterministic exact-match.
2. **semantic** → vector only.
3. **hybrid** (default) → both, fused.

Hybrid flow:

- `embedQuery(raw)` via Workers AI — because Qwen3 is **instruction-aware**, pass
  the **native `instruction` param** (default-style task string
  `"Given a web search query, retrieve relevant passages that answer the query"`)
  so WAI assembles the `Instruct:\nQuery:` prefix server-side, buying ~1–5%
  recall. Asymmetric on purpose: the query gets the instruction; stored chunk
  vectors do not (§5). Keep the instruction string a single named constant so
  query-embed and any eval agree, and confirm the exact input field
  (`queries` + `instruction` vs `text`) + return shape against the model page at
  build time. **On embed failure, fall back to keyword** and log the code —
  search must never hard-fail because the AI binding hiccuped.
- In parallel: existing FTS5 `MATCH` (returns full listing rows + snippets, as
  today) **and** `env.VECTORIZE.query(qvec, { topK: 50, returnMetadata: "all" })`
  — `returnMetadata: "all"` so each chunk hit carries its `preview` (§5) for the
  snippet. **topK is 50** because chunks compete (multiple chunks of one doc can
  rank, so we want a generous chunk-hit count to surface enough distinct docs).
  **AS-BUILT CAP (verified 2026-06-05 against the live binding):** Cloudflare
  rejects `topK > 50` when `returnMetadata: "all"` (error 40025) — the first
  revision's "~100" was wrong. 50 is ample at this corpus scale; the scale-up
  path if a far larger corpus ever needs more candidates is a two-step query
  (`returnMetadata:"none"`, topK 100) + a `getByIds` for the surfaced docs'
  previews. (Indexing `preview` to lift the cap is the wrong trade — indexed
  string metadata truncates to 64 bytes, §4.)
- `collapseChunksToDocs(...)` (§9) folds the chunk hits to one ranked entry per
  doc id, **carrying the winning chunk's `preview`** — *this* is the vector rank
  list fed to RRF.
- For vector-candidate doc IDs **not** already in the FTS rows, do **one** D1
  fetch: `select ${LISTING_SELECT_COLUMNS} ${LISTING_JOINS} where d.id in (...)
  and d.revoked_at is null` **plus the same tag/slug filter clauses** the FTS
  branch applies (`d.tags like ? escape '\\'`, `d.slug = ?`). This is where
  revoked + filters are authoritatively enforced for semantic hits — a vector hit
  that fails the filter or is revoked simply isn't materialized.
- `reciprocalRankFusion([ftsRanked, vectorRanked])`, order by fused score, take
  `limit`. Pagination stays disabled (RRF score is no more a stable cursor key
  than BM25 was).

**Access note:** `search_documents` is agent-key/operator-gated, **not** the
anonymous browser surface — so per the existing model, visibility does *not* gate
search (every authenticated caller sees the whole fleet), only `revoked_at` does.
No `canRead` call belongs here. (If search ever gained an anonymous surface,
`canRead` + visibility would gate it *at that surface*, not in this core.)

## 11. Response contract changes (`SearchHit`)

`SearchHit` (`src/core.ts:1842`) keeps `score` / `matched_field` / `snippet`,
with these semantics changes (chunking is invisible here — collapse happens
before the hit is built):

- `score` → the **fused RRF score** in hybrid mode (still "higher = better"). In
  `keyword` mode it remains the negated-BM25 value as today. Document that the
  scale differs by mode and is only meaningful *within* one result set.
- `matched_field` → union gains **`"semantic"`** for a vector-only hit (no FTS
  bracket to attribute). A hit matched by *both* keeps its FTS attribution
  (`title`/`description`/`body`) — the more informative signal.
- `snippet` → FTS hits unchanged (bracketed `snippet()` output). A `"semantic"`
  hit has no matched token to bracket, so surface the **matched chunk's `preview`**
  — the trimmed ~256-char excerpt of the passage whose vector actually matched
  (carried through the collapse from Vectorize metadata — §5/§9/§10), clearly
  *not* bracketed (which itself signals "concept match, not term match"). This is
  the most glanceable signal we have: it shows *why* the doc surfaced for this
  query rather than a generic doc summary, and for an agent it can answer "do I
  need to open this?" without a follow-up `read_document`. Falls back to a
  `description`/`title` excerpt only if the winning chunk has no preview (e.g. a
  legacy vector written before previews, until the next sync/backfill heals it).
  For a hit matched by *both* FTS and semantic, keep the FTS **bracketed** snippet
  — it pinpoints the actual matched term, strictly more informative than the
  preview.

These are **wire-contract changes** → they trip every clause of the CLAUDE.md
API-surface-change rule (§12).

## 12. Docs-sync obligations (do at implementation time)

Per CLAUDE.md, the implementing commit(s) must, in lockstep:

1. **MCP `search_documents` tool** (`src/mcp.ts`) — add the `mode` input field
   with `.describe()`; update the prose to mention semantic/hybrid, the new
   `matched_field: "semantic"`, and the fused-score caveat; keep the documented
   JSON response shape matching the handler.
2. **`docs/http-api.md`** — the `GET /admin/documents/search` request (`mode`
   param) + the `SearchHit` shape in "Shared response shapes"; add
   `POST /admin/vectors/backfill` (incl. its `missing`/`rebuild` `mode`).
   **Re-publish the live `slopcafe-http-api` copy**
   (public_id `0EtsEq6cnCeuOhBKO6ICzA`) byte-exact via the `create_publish_credential`
   + `curl --data-binary` recipe (`docs/README.md`).
3. **`agent-knowledge-host-spec-SOLO-v1.md`** — search gains a semantic axis; move
   it from deferred/aspirational to as-built. **Re-publish `slopcafe-spec-solo`**
   (public_id `ClcgZMaOEcworHzhr17gVQ`).
4. **`CLAUDE.md`** — new `AI`/`VECTORIZE` bindings (Storage model), `src/vector.ts`
   (Where things live), the non-transactional-with-D1 convention + the
   waitUntil→Queue upgrade seam + the chunk-ID/range-delete invariant (Conventions
   & gotchas), and the hybrid-search note on `searchDocumentsCore`.
5. **`skills/publishing.md`** — unaffected (authoring contract, not search). No
   change expected; confirm at implementation time.
6. **This note + the live `slopcafe-vector-search-design` copy** (public_id
   `2-bdgp8w4HixgQrGRvzGaQ`) — keep both in sync (the repo file and the published
   mirror have drifted before); re-publish on change.

`byte-exact-publish-design.md`-style note: not bundled, reference-only.

## 13. Rollout phases

1. **Infra + write path. ✅ BUILT.** `[ai]` + `[[vectorize]]` bindings in
   `wrangler.toml`, `AI`/`VECTORIZE` on `Env`; `waitUntil` threaded through the
   write/revoke cores (HTTP `index.ts`, MCP closures, operator authoring in
   `admin.ts`); the pure helpers in `src/vector.ts` and the I/O
   (`syncDocumentVector`/`deleteDocumentVector`/`embedQuery`/`queryVectors`/
   `presentDocIds`) in `src/vector-io.ts`; `syncDocumentVector` wired into
   publish/update/edit/restore, `deleteDocumentVector` into revoke. **Operator
   action before first deploy: create the index** —
   `npx wrangler vectorize create agent-web-host-docs --dimensions=1024 --metric=cosine`.
2. **Backfill. ✅ BUILT.** `POST /admin/vectors/backfill` (`backfillVectorsCore`).
   Run it once by hand after deploy (`mode:"missing"` is the default) and
   spot-check `vectors` (≈ Σ chunks, not doc count).
3. **Read path. ✅ BUILT.** `mode` + `collapseChunksToDocs` + hybrid RRF in
   `searchDocumentsCore` (`ftsSearch` + `semanticSearch` legs), the D1 re-join,
   the `SearchHit`/`mode` contract, and **all of §12**. Ships with `mode`
   defaulting to `hybrid`.
4. **(Deferred) Durability + scale.** Replace `waitUntil` with a Cloudflare Queue
   + consumer for retrying sync. Optionally promote the incremental (`missing`)
   backfill to a Cron Trigger — incremental keeps the recurring cost negligible,
   so this is mostly a "want it automatic?" call now (§8). Optional
   `vector_synced_ver` column (would let the `missing` backfill catch STALE
   vectors, not just missing — §8/§16). Re-tune chunk size / `MAX_CHUNKS` if the
   §14 eval shows long-doc recall gaps.

## 14. Local dev & testing

- **Pure logic** (`chunkEmbedInputs`, `collapseChunksToDocs`,
  `reciprocalRankFusion`) → `test/vector.test.mjs` under the strip-types runner;
  wire into `npm test`.
- **Vector/AI I/O has no local harness.** Workers AI runs on Cloudflare's edge
  (no local model) and Vectorize local emulation is limited — `wrangler dev` may
  need `--remote` for these paths, or they no-op locally. Covered by **typecheck
  + a manual remote E2E**: publish a doc → wait ~10 s for vector visibility →
  semantic-query a paraphrase → confirm the doc ranks → revoke → confirm it drops.
  **Probe deep-chunk recall explicitly:** the paraphrase must target a concept
  *deep in a long doc* (a late section, well past the first chunk), not the
  title/intro — that's exactly what chunking is meant to fix, so a pass on a
  title-shaped query proves nothing. Same "no D1/Vectorize harness, covered by
  typecheck + remote E2E" stance as the restore path.

## 15. Cost (free at our scale — no Workers Paid plan or card required)

**Bottom line: this ships on the Workers _Free_ plan with no payment method on
file** (verified 2026-06-04 against the Vectorize + Workers AI docs). Vectorize
opened to the Free tier on **2024-09-16**, so the once-true "Vectorize needs
Workers Paid" is now **stale** — a leftover line on the Workers *pricing* page
still says it, but the Vectorize product docs override it. Workers AI is included
on Free with a daily neuron allocation. You'd attach a card / move to **Workers
Paid ($5/mo, one subscription covers both Vectorize and Workers AI)** only to
exceed the caps below — which our corpus doesn't approach. (The deferred phase-4
levers don't force an upgrade either: Cloudflare Queues is Free-usable at 10k
ops/day and Cron Triggers aren't Paid-gated.)

Current Cloudflare pricing, **1024-dim vectors, Qwen3, ~N chunks/doc**. The
**Free** and **Paid** plans have *different* included allowances — an earlier draft
mislabeled the Paid allowances as "the free tier," so both columns are spelled out
here:

| Lever | Free plan | Paid ($5/mo) included | Overage | At our scale |
|---|---|---|---|---|
| Vectorize **stored** dims | **5M/mo** | 10M/mo | $0.05 / 100M | chunking ×N's the vector count: ~25 docs × ~7 chunks ≈ 175 vectors × 1024 ≈ **0.18M dims** — ~4% of the *Free* cap; even 10k docs × 7 ≈ 70k vectors ≈ 71.7M dims ≈ **$0.03/mo** (Paid overage) |
| Vectorize **queried** dims | **30M/mo** | 50M/mo | $0.01 / 1M | billed `(queries + stored_vectors) × dims` **per month** (the stored term is added once/mo, *not* per query) — well under 1M/mo at our scale |
| Workers AI embeddings (`qwen3-embedding-0.6b`) | **10k neurons/day** | 10k neurons/day | $0.011 / 1k neurons | **1,075 neurons / M input tokens** (verified, ~5.6× cheaper than bge-base's 6,058); a fully-chunked full-corpus backfill is a rounding error against the daily free neurons |

Worked example for a *hypothetical large* corpus (already on Paid): 10k docs ≈
70k stored vectors, 30k queries/mo → `(30,000 + 70,000) × 1024 = 102.4M` queried
dims → ~$0.52/mo beyond the Paid 50M allowance. **At our actual <25-doc scale it's
$0 on the Free plan** — ~0.18M stored and well under 1M queried dims/mo, orders of
magnitude under the 5M / 30M Free caps. Chunking multiplies the stored-vector
count but stays free well past our realistic corpus — which is precisely why the
chunking decision (§2.1) turns on recall, not cost.

## 16. Deferred / open questions

- **History / version-evolution search — CUT (recorded as a decision, not an
  oversight).** §5 keys vectors on `documents.id#i` and re-writes them on every
  update, so only the *current* version is ever embedded; "how did this doc
  evolve" / searching prior versions is not supported. The read-path collapse
  (§10) assumes current-version chunks only; per-version search would need
  version-scoped IDs and a collapse that no longer folds to the live doc. Reopen
  only if version-level recall becomes a real need — additive over the same
  index, but not free.
- **Queue-backed durable sync** — phase 4; `waitUntil` first (§6).
- **Scheduled (cron) backfill reconciliation** — deferred. With the incremental
  `missing` backfill (§8) the recurring cost is negligible, so this is now a
  "want it automatic?" decision rather than a cost unknown; manual operator
  invocation in v1.
- **`vector_synced_ver` marker column** — deferred. The incremental backfill (§8)
  is presence-only without it; the column would let `mode:"missing"` also catch
  STALE vectors (embedded version < `current_ver`), not just missing ones.
  `mode:"rebuild"` covers staleness in v1, so it stays deferred.
- **Confirm the enforced Qwen3 input-token cap** (8,192 vs 4,096 — CF docs
  conflict, §2) empirically before freezing chunk size. Decision-margin only:
  both numbers dwarf our ~512-token chunks.
- ~~Chunking (single-vector-per-doc)~~ **PROMOTED to v1** (operator 2026-06-04):
  chunked N-per-doc is now decision §2.1. Reversed the original single-vector
  plan once the embedding-model audit showed cost is free either way, so the call
  could be made on recall quality (pooling dilution) alone.
- ~~MCP plumbing of `ctx.waitUntil`~~ **RESOLVED** (researched, §6): MCP needs
  none — `ctx` is already in the tool closures and is the real ExecutionContext
  through the OAuth wrap; HTTP needs only a 3-signature `ctx` thread.
- ~~`bge-m3`~~ ~~`@cf/baai/bge-base-en-v1.5` (768)~~ ~~`embeddinggemma-300m`~~
  **SUPERSEDED → `@cf/qwen/qwen3-embedding-0.6b` (1024)** (operator, 2026-06-04).
  Lineage: bge-m3 → locked bge-base-en on a (mistaken) cost rationale → same-day
  Workers AI catalog audit re-locked on Qwen3, which is both cheaper *and*
  larger-window (full reasoning in §2's change note). Any future model change is a
  new index + full re-embed, never in place.
- **Caching query embeddings** — not in v1; the per-search embed is tens of ms.
