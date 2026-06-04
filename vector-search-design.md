# Semantic (vector) search — design note

**Status:** plan of record, **not yet built**. Direction chosen by the operator:
**one vector per document, Cloudflare Vectorize + Workers AI, hybrid with the
existing FTS5/BM25 search via Reciprocal Rank Fusion.** Everything below is a
decided constraint unless tagged *deferred*. No code has landed yet — this note
exists to be reviewed and then implemented in phases (§13).

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

1. **One vector per document.** Embed `title + description + body-text`
   concatenated, a single vector keyed by the document. No chunking in v1.
   (Tradeoff & upgrade path in §12.)
2. **Cloudflare Vectorize** for the index (native binding, no egress, free at our
   scale — §11). Not turbopuffer/Pinecone/pgvector (overkill for single-tenant,
   small corpus).
3. **Workers AI `@cf/baai/bge-base-en-v1.5`** for embeddings — 768 dims, cosine.
   **LOCKED** (operator, 2026-06-04). Rationale: cheapest credible English model,
   native binding, well-trodden. *Index dimensionality is immutable*, so this is
   the one sticky choice — changing models later means a new index + full
   re-embed, never an in-place swap. `bge-m3` (1024 dims, multilingual, even
   cheaper per token) was the considered alternative; revisit it ONLY if a
   non-English corpus emerges, and only as a brand-new index alongside this one.
4. **Hybrid via Reciprocal Rank Fusion (RRF).** Combine the FTS rank list and the
   vector rank list with `score = Σ 1/(k + rank_i)`, `k = 60`. RRF needs no score
   normalization — critical because BM25 (unbounded, negated) and cosine
   (`[-1,1]`) aren't on the same scale.
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

```
WRITE (publish/update)                 READ (search_documents / GET .../search)
─────────────────────                  ────────────────────────────────────────
core computes ftsBody (already!)       embed(query)  ─┐
        │                                              ├─ VECTORIZE.query → IDs+cosine
        ├─ D1 batch: docs+versions+FTS  FTS5 MATCH  ───┘        │
        │  (atomic, unchanged)                  │              fuse (RRF)
        └─ after commit:                        └──────────────┤
           waitUntil(embed + VECTORIZE.upsert)        re-join top-N through D1
                                                      (LISTING_JOINS, revoked_at,
REVOKE                                                 tags/slug filters)
──────                                                        │
D1 batch flips revoked_at + FTS delete                  SearchHit[]
        └─ after commit: VECTORIZE.deleteByIds
```

## 4. Infra & configuration

**Create the index** (immutable dims/metric):

```sh
npx wrangler vectorize create agent-web-host-docs --dimensions=768 --metric=cosine
```

**Bindings** (`wrangler.toml`):

```toml
[ai]
binding = "AI"            # Workers AI — env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [...] })

[[vectorize]]
binding = "VECTORIZE"
index_name = "agent-web-host-docs"
```

**`Env` type** (`worker-configuration.d.ts` is generated; if hand-maintained, add
`AI: Ai` and `VECTORIZE: VectorizeIndex`). No metadata indexes are created — we
re-join through D1 rather than filter on Vectorize metadata (§10), so the
64-byte indexed-metadata truncation and the "create-index-before-insert" footgun
never apply.

## 5. Data model — no migration required

One vector per doc, stored in Vectorize, keyed by **`documents.id`** (the
internal UUID already used as `documents_fts.document_id`). Using `id` (not
`public_id`) makes the read-time re-join `where d.id in (...)` identical to the
FTS join key. The vector ID is stable across version bumps — each update
re-embeds and **upserts the same ID**, so there's exactly one vector per live
doc, always reflecting the current version.

**No D1 schema change.** The vector lives in Vectorize; nothing about it needs a
column. (Same ethos as the version-history feature, which needed no migration.)
A `documents.vector_synced_at` observability column is *deferred* — upsert-by-id
is idempotent without it, and v1 doesn't need staleness telemetry.

**What we embed:** `\`${title}\n\n${description}\n\n${ftsBody}\``, where `ftsBody`
is the exact `htmlToMarkdown(prep.cleanedHtml)` already computed for FTS
(`src/core.ts:596`, `:779`). Title/description lead so they survive the model's
~512-token truncation. **No second R2 read, no second parse** — vectorization is
one more derivation off bytes the write path already holds.

**Metadata stored on the vector:** none required (we re-join through D1). If a
future cross-check wants it, `{ public_id }` is the only useful field — but it's
not needed for v1 and adds a staleness surface, so we omit it.

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
- When present: `waitUntil(syncDocumentVector(env, docId, embedText))`. When
  absent (unit tests, any caller that can't supply it): **skip silently** — the
  doc is fully functional, just not yet in the vector index; the next update
  heals it, or the backfill (§8) does.
- `syncDocumentVector` = `env.AI.run(MODEL, { text: [embedText] })` →
  `env.VECTORIZE.upsert([{ id: docId, values: result.data[0] }])`. Wrap in
  try/catch that logs **code only** (per the `src/mcp.ts` logging-discipline
  rule — never the body, it's user HTML).

**Why not the D1 batch / a Queue in v1?** The batch can't include a non-D1,
async, eventually-consistent mutation without breaking its atomicity guarantee.
A Cloudflare **Queue** (durable, retrying consumer) is the *correct* upgrade and
is **deferred to phase 2** — `waitUntil` fire-and-forget is enough for v1 because
the failure mode (a transient Workers AI / Vectorize hiccup drops one vector)
degrades to "BM25 still finds it," and is self-healing on next write. Document
the Queue upgrade path in CLAUDE.md so it's a known seam, not a surprise.

## 7. Revoke path — delete the vector

`revokeDocumentCore` flips `revoked_at` and deletes the FTS row inside its batch
(`src/core.ts:2061`). After that batch commits, schedule
`waitUntil(env.VECTORIZE.deleteByIds([docId]))`. **The vector delete is not the
kill-switch** — the authoritative gate is `documents.revoked_at`, flipped *before*
the R2/vector cleanup (existing invariant), and enforced again at read time by
the re-join's `d.revoked_at is null`. So a revoked doc whose vector hasn't been
purged yet still cannot appear in results. Belt and suspenders.

## 8. Backfill — one-time, idempotent

Live docs published before this ships have no vector. Add an operator-gated
`POST /admin/vectors/backfill` (in `src/admin.ts`, `requireOperator`):

- Page through live docs (`revoked_at is null`) using the existing cursor
  pagination, embed each, **upsert in batches of ≤1000** (the Workers API
  per-call cap — silently truncates if exceeded).
- Idempotent (upsert-by-id), resumable via the returned cursor. Re-running is
  safe and cheap.
- Comfortably inside Workers AI's free daily neurons (§11) for any realistic
  corpus — a few thousand docs is a single-digit-cent, sub-minute job.

Alternatively a `wrangler`-invoked one-shot script; the admin endpoint is
preferred so it runs with the deployed bindings and can be re-triggered.

## 9. New modules & tests

- **`src/vector.ts`** — the pure, unit-testable core, mirroring how `search.ts`,
  `edit.ts`, and `conditional.ts` are standalone (no D1/R2/WASM imports) so
  `test/vector.test.mjs` runs under the Node strip-types runner:
  - `reciprocalRankFusion(lists, k=60)` → fused, ordered `{ id, score }[]`. **The
    load-bearing pure function** — test ties, single-list, disjoint lists,
    `k` sensitivity.
  - `buildEmbedInput(title, description, body)` → the concatenation rule (so the
    write path and any re-embed agree byte-for-byte).
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

- `embedQuery(raw)` via Workers AI. **On embed failure, fall back to keyword** and
  log the code — search must never hard-fail because the AI binding hiccuped.
- In parallel: existing FTS5 `MATCH` (returns full listing rows + snippets, as
  today) **and** `env.VECTORIZE.query(qvec, { topK: 50, returnMetadata: "none" })`
  → candidate `id`s + cosine.
- For vector-candidate IDs **not** already in the FTS rows, do **one** D1 fetch:
  `select ${LISTING_SELECT_COLUMNS} ${LISTING_JOINS} where d.id in (...) and
  d.revoked_at is null` **plus the same tag/slug filter clauses** the FTS branch
  applies (`d.tags like ? escape '\\'`, `d.slug = ?`). This is where revoked +
  filters are authoritatively enforced for semantic hits — a vector hit that
  fails the filter or is revoked simply isn't materialized.
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
with these semantics changes:

- `score` → the **fused RRF score** in hybrid mode (still "higher = better"). In
  `keyword` mode it remains the negated-BM25 value as today. Document that the
  scale differs by mode and is only meaningful *within* one result set.
- `matched_field` → union gains **`"semantic"`** for a vector-only hit (no FTS
  bracket to attribute). A hit matched by *both* keeps its FTS attribution
  (`title`/`description`/`body`) — the more informative signal.
- `snippet` → FTS hits unchanged (bracketed `snippet()` output). A `"semantic"`
  hit has no matched token to bracket, so surface a plain excerpt of
  `description` (fallback `title`) — clearly *not* bracketed, which itself signals
  "this was a concept match, not a term match."

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
   `POST /admin/vectors/backfill`. **Re-publish the live `slopcafe-http-api` copy**
   (public_id `0EtsEq6cnCeuOhBKO6ICzA`) byte-exact via the `create_publish_credential`
   + `curl --data-binary` recipe (`docs/README.md`).
3. **`agent-knowledge-host-spec-SOLO-v1.md`** — search gains a semantic axis; move
   it from deferred/aspirational to as-built. **Re-publish `slopcafe-spec-solo`**
   (public_id `ClcgZMaOEcworHzhr17gVQ`).
4. **`CLAUDE.md`** — new `AI`/`VECTORIZE` bindings (Storage model), `src/vector.ts`
   (Where things live), the non-transactional-with-D1 convention + the
   waitUntil→Queue upgrade seam (Conventions & gotchas), and the hybrid-search
   note on `searchDocumentsCore`.
5. **`skills/publishing.md`** — unaffected (authoring contract, not search). No
   change expected; confirm at implementation time.

`byte-exact-publish-design.md`-style note: not bundled, reference-only.

## 13. Rollout phases

1. **Infra + write path.** Create index, add bindings, thread `waitUntil`, wire
   `syncDocumentVector` into publish/update + `deleteDocumentVector` into revoke.
   No read change yet — vectors start accumulating for new writes.
2. **Backfill.** `POST /admin/vectors/backfill`; run it once; spot-check counts.
3. **Read path.** Add `mode` + hybrid RRF to `searchDocumentsCore`, the D1
   re-join, the `SearchHit`/`mode` contract, and **all of §12**. Ship behind
   `mode` defaulting to `hybrid` (or default `keyword` first, flip to `hybrid`
   after eval — operator's call).
4. **(Deferred) Durability + scale.** Replace `waitUntil` with a Cloudflare Queue
   + consumer for retrying sync. Revisit chunking (§12 below) if long-doc recall
   disappoints. Optional `vector_synced_at` observability column.

## 14. Local dev & testing

- **Pure logic** (`reciprocalRankFusion`, `buildEmbedInput`) → `test/vector.test.mjs`
  under the strip-types runner; wire into `npm test`.
- **Vector/AI I/O has no local harness.** Workers AI runs on Cloudflare's edge
  (no local model) and Vectorize local emulation is limited — `wrangler dev` may
  need `--remote` for these paths, or they no-op locally. Covered by **typecheck
  + a manual remote E2E**: publish a doc → wait ~10 s for vector visibility →
  semantic-query a paraphrase → confirm the doc ranks → revoke → confirm it drops.
  Same "no D1/Vectorize harness, covered by typecheck + remote E2E" stance as the
  restore path.

## 15. Cost (free at our scale)

Current Cloudflare pricing, one 768-dim vector per doc:

| Lever | Free tier | Beyond | At our scale |
|---|---|---|---|
| Vectorize **stored** dims | 10M/mo | $0.05 / 100M | 768 dims → ~13,000 docs free; 100k docs ≈ **$0.03/mo** |
| Vectorize **queried** dims | 50M/mo | $0.01 / 1M | billed `(queries + stored_vectors) × dims` **per month** (stored term added once/mo, *not* per query) → ~55k searches/mo free at 10k docs |
| Workers AI embeddings (`bge-base`) | 10k neurons/day | $0.011 / 1k neurons | 6,058 neurons/M tokens ≈ **$0.067/M tokens**; full-corpus backfill is a rounding error |

Cloudflare's own worked example: 10k vectors @ 768 dims, 30k queries/mo →
`(30,000+10,000)×768 = 30.72M` queried dims → **under the 50M free tier, $0**.
This stays free or pennies well past our realistic corpus.

## 16. Deferred / open questions

- **Chunking (multi-vector per doc).** v1 embeds one vector and accepts the
  model's ~512-token truncation (title/description-first mitigates the worst of
  it). If recall on long docs is weak, move to N chunks/doc keyed back to `id`
  via metadata; the read re-join already dedups by doc `id`, so chunking is
  additive. Deferred until measured.
- **Queue-backed durable sync** — phase 4; `waitUntil` first.
- **`vector_synced_at` observability column** — deferred; upsert-by-id is
  idempotent without it.
- ~~MCP plumbing of `ctx.waitUntil`~~ **RESOLVED** (researched, §6): MCP needs
  none — `ctx` is already in the tool closures and is the real ExecutionContext
  through the OAuth wrap; HTTP needs only a 3-signature `ctx` thread.
- ~~`bge-m3` (multilingual, 1024 dims)~~ **DECIDED** — locked on
  `@cf/baai/bge-base-en-v1.5` (768) per §2 (operator, 2026-06-04). `bge-m3`
  revisited only if a non-English corpus emerges, and only as a new index (dims
  are immutable).
- **Caching query embeddings** — not in v1; the per-search embed is tens of ms.
