# Context Packs — design note

**Status:** PROPOSED — **first draft for review, nothing is built.** This note
follows the shape of `librarian-design.md` / `source-retention-design.md`:
problem → reframe → decisions → mechanics → threat model → deferred. Everything
here is aspirational until a build order is agreed; the point of the draft is to
have something concrete to iterate over (and to publish on Slopcafe for other
agents to critique). Where a decision is still open it's marked **(open)**.

The note bundles three things that turn out to be one feature plus its
prerequisite: a **bulk-read-under-budget** mechanism (the "pack"), a **lifecycle
status** axis that keeps stale documents out of automatic packs, and a
**config-as-document** curation surface that reuses the pattern
`librarian-design.md §3.5` already set for the tag vocabulary.

---

## 1. Problem

The corpus is meant to bring an agent **up to speed on a task**. Today the only
way an agent does that is:

1. `search_documents` (or `list_documents`) → a page of hits with snippets, **no
   bodies**.
2. Decide which hits matter.
3. `read_document` × N to pull each full body.

That's an N+1 round-trip the agent has to orchestrate every time, and three
things are missing that no amount of agent cleverness supplies:

- **No budgeted bulk read.** "Give me as much of the relevant corpus as fits in
  ~16K tokens, best-first" is a server-side policy, not something an agent can do
  without already knowing every body's size.
- **No canonical set.** There's no operator-blessed "to understand Slopcafe, read
  *these*, in *this* order." Search answers "relevant to my query"; it cannot
  answer "what the operator thinks everyone should read first."
- **No way to keep stale docs out of onboarding.** A superseded design note still
  ranks in search. An automatic onboarding pack that pulls it is *worse* than no
  pack — it confidently briefs an agent on outdated truth. The corpus has `revoke`
  (hard kill) and `visibility` (anonymous gate) but **no "still findable, no
  longer current"** state.

## 2. Reframe: "Context Pack" is two features wearing one name

The phrase covers two operations that return the same shape but answer different
questions — and they fall on the two axes this codebase already separates in
`librarian-design.md` (search = *content discovery*; the browse/classification
axis = *curation*):

- **Automatic pack** — ephemeral, query-derived. "Bring me up to speed on X."
  Pure amplification of `search_documents`. No storage. Lives on the **search**
  axis.
- **Curated pack** — durable, named, operator-authored. "The canonical set for
  understanding Slopcafe." Lives on the **browse** axis — the librarian's domain,
  not search's.

They share a return shape but need separate justifications, data models, and
threat models. Conflating them is the main way this design could go wrong.

### The unifying model

Strip both down and a pack is the same three-step pipeline:

> **root → expand to candidate documents → budgeted best-first body fill**

Only the **root** differs:

| Pack kind | Root | Candidate set | Order |
|---|---|---|---|
| Automatic | a **query** string | top search hits | relevance rank |
| Ad-hoc | **any document** | the docs it links to | order of appearance |
| Curated | a **manifest document** | the manifest's explicit members | authored order |

The ad-hoc and curated rows are two points on **one continuum**: a document with
no special structure expands via its **outbound links** (zero ceremony — any
index/hub page is instantly a pack); a document that wants precision carries an
explicit **manifest block** (§3.3). A manifest, when present, **wins** over loose
links. This is the heart of the "any document can become a pack" idea: the
manifest is not required, it's the *upgrade*.

## 3. Decisions

### 3.1 A pack is "root + budgeted best-first body fill" — and that's why it's a server tool, not a prompt

The naïve automatic pack ("run search, read the top 5") is something an agent can
already do with existing tools. If that's all a pack were, it wouldn't earn a new
tool. What justifies server-side machinery is **policy you don't want every agent
to re-implement**:

1. **Budgeted best-first fill.** The pack takes a byte budget, walks candidates
   in order, includes *whole* bodies until the budget is exhausted, then stops —
   and **reports what it omitted** (with ids, so the agent can pull more
   deliberately). Never silently truncate a body (loud-over-silent, like the rest
   of this codebase): include-whole-or-skip-and-report.
2. **Deprecation exclusion** (§3.4) — the policy that stops a pack from
   *mis*-onboarding an agent with stale docs.
3. **Supersession substitution** — when a candidate is deprecated with a
   `superseded_by` pointer, surface the pointer rather than silently swapping
   (mirrors the loud slug-redirect stance: never auto-follow).

Those three are the whole reason this lives on the server. The tool description
must lead with them, or a reviewer will rightly ask "why isn't this just search?"

### 3.2 Bodies are markdown; selection is byte-budgeted with omit-and-report

- **Format: markdown/text, always — no per-member format knob.** Any document
  qualifies as a pack member; there is no "pack-friendly" doc type. Every member
  is returned as its markdown/text representation regardless of how it was
  authored — an HTML-authored doc comes back converted, each member re-derived
  from the sanitized H via `htmlToMarkdown` exactly like `readDocumentTextCore`
  (a pack is for *feeding a model*, not rendering). Unlike `read_document` a pack
  deliberately has **no `format`/`representation` axis**: the whole point is
  uniform, ingestible text, so it never serves HTML or the unsanitized `source`
  per member. An agent that needs raw HTML or source for one specific doc drops to
  `read_document` for that one — the pack is the bulk-ingest path, not the
  fidelity path.
- **Budget is bytes, with a token hint.** The system measures `size_bytes`; tokens
  are ~bytes/4. Proposed defaults (tunable): `budget_bytes` **64 KB** (~16K
  tokens), max **256 KB**; `max_documents` **8**, max **25**, whichever binds
  first.
- **Omit-and-report, never truncate.** For each candidate in order: if the body
  fits the remaining budget **and** we're under `max_documents`, include it whole;
  else append to `omitted[]` with a reason (`budget` / `max_documents` /
  `deprecated` / `unavailable` / `revoked`). A single doc larger than the *whole*
  budget is skipped and reported (the agent reads it directly) — **(open)** whether
  the top candidate should be force-included when nothing else has landed yet, to
  avoid an empty pack.
- **No caching in v1.** Each member is a fresh R2 GET + convert, same stance as
  `read_document` (no per-version markdown cache). A pack of K docs = 1 resolve +
  K GETs.

### 3.3 Curated packs are documents (and so is the no-ceremony ad-hoc pack)

`librarian-design.md §3.5` ("The vocabulary is a document") already established
the pattern this codebase reaches for: **operator-authored config lives as a
normal Slopcafe document**, inheriting version history, restore, visibility, and a
human-rendered view for free. Context packs reuse it wholesale.

A curated pack is **a document** (proposed slug `pack-<name>`, e.g.
`pack-slopcafe`), addressable by the operator's natural instruction *"load context
pack 'Slopcafe'"*. The pack tool returns **the manifest doc's own prose *plus* the
full bodies of its members** — strictly better than a bare list, because the
manifest page explains *why* these docs and in *what order*, which is itself
premium onboarding context.

Two ways a document defines its members (the §2 continuum). **Keep both in v1**
per the review decision:

- **(a) Implicit — outbound links.** Any document with no special structure
  expands via the `/d/<public_id>` and `/s/<slug>` links in its body. A hand-
  authored index page ("Start here") is instantly a pack with zero ceremony. Links
  are extracted from the **sanitized H** (`<a href>` survives sanitization), deduped,
  in first-appearance order, self-link excluded.
- **(b) Explicit — a manifest block.** A document that wants precision carries a
  fenced ` ```pack ` block, parsed from the **retained source S** (the authored
  bytes — so we read exactly what was written, not a round-trip):

  ````
  ```pack
  slopcafe-spec-solo
  slopcafe-http-api
  slopcafe-vector-search-design
  ClcgZMaOEcworHzhr17gVQ   # public_id also accepted
  # one member per line; slug or public_id; '#' comments; order preserved
  ```
  ````

  When a manifest block is present it **wins** over loose links (precise overrides
  implicit). Richer directives (a `query:` line so a curated pack can pin N docs
  *plus* top results; `exclude:`) are **deferred** (§7).

**Tiering — must-read vs. optional (exploring).** A flat member list treats every
doc as equally essential, which fights the budget: a 9th "nice to have" doc can
crowd out budget you'd rather spend on the two that matter. So a manifest *may*
split into two tiers:

- **Required** (the default tier) — filled first, in authored order, before
  anything optional.
- **Optional** (below an `[optional]` marker) — fills only the budget the required
  tier leaves, and each entry may carry a one-line **hint** ("this might be useful
  if you need to know about X"):

  ````
  ```pack
  slopcafe-spec-solo
  slopcafe-http-api

  [optional]
  slopcafe-vector-search-design   how semantic search ranking works
  slopcafe-context-packs-design   how packs themselves are built
  ```
  ````

  Syntax stays a dumb list: a line is `<slug-or-public_id>` optionally followed by
  whitespace + a free-text hint; `[optional]` switches tier; `#` is a full-line
  comment.

  The hint earns its keep on the **omitted** path: an optional doc that doesn't fit
  the budget is still reported in `omitted[]` **with its hint**, so the pack
  doubles as a *menu* — the agent learns "there's a doc about X I can pull if I
  need it" without spending a byte on its body. That menu-for-free property is the
  real argument for tiering, more than the priority ordering.

  **Why this is still (open):** required-then-optional *priority* is already
  expressible by plain authored order + the budget cutoff (the first members win
  anyway), so the tier marker alone adds syntax for little gain. The thing ordering
  **can't** replicate is the hint-on-omitted menu. So the lean is **both-or-neither**:
  adopt the `[optional]` tier only if we adopt per-entry hints (they justify each
  other), or ship neither and let authored order + budget do the prioritizing.
  Tracked in §7.

**(open)** Whether to *require* a manifest for a doc to be loadable as a pack, or
allow the implicit link-neighborhood for any doc. The draft keeps both; the risk
of (a) is that a casual mention in prose accidentally joins the pack — the
mitigation is to only treat links inside a marked section, or to require (b) for
*named* packs while allowing (a) for explicit `from: <doc>` expansion. To be
settled in iteration.

### 3.4 Lifecycle `status` — a first-class third axis (migration 0014)

The prerequisite for trustworthy automatic packs. Today a document has two
orthogonal state axes; this adds a third:

| Axis | Question | Affects |
|---|---|---|
| `revoked_at` | Does it exist? | Hard kill — gone from everything, 404 |
| `visibility` | Who can see it? | Anonymous browser surface only |
| **`status` (new)** | Is it current? | **Pack inclusion + search marking** |

Decisions:

- **A CHECK-pinned column on `documents`.** `documents.status TEXT NOT NULL
  DEFAULT 'active' CHECK (status IN ('active','deprecated','archived'))`, migration
  0014, backfilling legacy rows to `'active'`. Idiomatic with `visibility`
  (0011) and `created_by_kind` (0013).
- **Status is classification, not content.** It lives on `documents` next to
  `slug`/`tags`/`visibility`, survives version bumps and restores, and a status
  change is a **no-version-bump** operator mutation (`setDocumentStatusCore` +
  `POST /admin/documents/:id/status` + a manage-page control), exactly mirroring
  `setDocumentVisibilityCore` / `setDocumentTagsCore`.
- **v1 wires `active` + `deprecated`; `archived` is reserved in the CHECK.**
  - `active` — normal.
  - `deprecated` — still renders, still found by search **but marked**; **excluded
    from automatic packs by default**. The "still findable, no longer current"
    state the corpus is missing.
  - `archived` — reserved for a stronger "hidden from default search/list unless
    opted in, but not revoked" state. Pinned in the CHECK now so adding the
    behavior later needs no migration; **no behavior wired in v1**.
- **Companion `superseded_by` pointer (recommend, same migration).** Nullable
  `documents.superseded_by` holding a target `public_id`. A deprecated doc can
  point at its replacement; the pack/search surfaces it **loudly** (never
  auto-follow) — the document-level analogue of `slug_tombstones.redirect_to`.
  Single-hop, validated like the slug redirect (target exists/live, no self/loop).
  **(open)** whether to ship `superseded_by` in 0014 or defer to keep the migration
  minimal.
- **Per-surface policy:**
  - **Pack:** exclude `deprecated` by default; `include_deprecated` override for
    completeness.
  - **Search / list:** include `deprecated`, carry `status` (and `superseded_by`)
    in the hit so the agent discounts it. v1 does **not** re-rank by status
    (down-ranking deprecated is a deferred tuning knob); a new `status` filter
    param (like `tags`/`slug`) lets a caller ask for active-only or
    deprecated-only.
- **Operator-gated in v1.** `setDocumentStatusCore` ships operator-gated like its
  visibility/tags/slug siblings. Agent-reachable self-deprecation ("I published v2
  as a new doc; mark the old one deprecated → `superseded_by`") is a natural
  follow-up the single-tenant trust model already permits — deferred to keep the
  first cut small.

### 3.5 Tool surface — **(open, decide during drafting)**

Two shapes, both viable; the draft recommends the first and keeps the second on
the table.

**Recommended — honor the search/browse split:**

- Extend `search_documents` with `include_bodies: true` + `budget_bytes` /
  `max_documents`. Automatic packs ride the search axis where they belong; no new
  tool for the common case, which keeps the tool count (and description budget)
  down.
- Add **one** new browse-axis tool, `load_context_pack({ from, ... })`, that
  resolves a document reference (slug or public_id), auto-detects manifest-vs-links
  (§3.3), and returns the root prose + member bodies. `"load context pack
  'Slopcafe'"` is sugar for `from: "pack-slopcafe"`.

**Alternative — one unified tool:** a single `get_context_pack` taking `query`
**xor** `from`, shared `budget_bytes` / `max_documents` / `mode` /
`include_deprecated`. Fewer concepts to discover; matches the repo's
`format`-param collapse philosophy. The cost is one tool straddling both axes.

Either way the shared knobs are: `budget_bytes`, `max_documents`, `mode`
(search-mode passthrough for the query root), `include_deprecated`,
`follow_redirects` (opt-in to substitute a `superseded_by` target).

## 4. Mechanics

- **Where the pure logic lives:** a new `src/pack.ts` (no D1/R2/WASM/AI imports,
  unit-tested under the strip-types runner like `search.ts` / `vector.ts` /
  `edit.ts`): manifest-block parsing, outbound-link extraction (over an HTML
  string), candidate dedup/ordering, and the budget-fill selector
  (`selectWithinBudget(candidates, sizes, budget, maxDocs) → {included, omitted}`).
  The impure orchestration (`loadContextPackCore` / the search `include_bodies`
  branch) lives in `core.ts` and does the R2 GET + `htmlToMarkdown` per member,
  reusing `readDocumentTextCore`'s converter path.
- **Link extraction** runs over the stored H, matching `^/d/(PUBLIC_ID_RE)` and
  `^/s/(SLUG)` (and the absolute `https://slopcafe.com/...` equivalents), reusing
  `PUBLIC_ID_RE` and the slug regex. Resolve each → live doc via the existing
  lookups; a revoked/retired/missing target is dropped to `omitted[]`, never
  fatal.
- **Manifest parsing** runs over S (`readDocumentSourceCore`): find the first
  fenced ` ```pack ` block, one member per line, strip `#` comments, resolve
  slug-or-public_id, preserve order, dedup, drop the self-reference.
- **Response shape** (member envelope reuses the familiar `ReadTextOk` fields):

  ```jsonc
  {
    "pack": {
      "source": "query" | "document" | "manifest",
      "query": "...",                 // when source = query
      "root": { "public_id": "...", "slug": "...", "title": "..." }, // doc/manifest
      "budget_bytes": 65536,
      "used_bytes": 41200
    },
    "documents": [
      { "public_id": "...", "slug": "...", "title": "...", "description": "...",
        "tags": ["..."], "status": "active", "version": 3,
        "format": "markdown", "content": "...",
        "snippet": "...",             // query packs only (the search snippet)
        "tier": "required",           // manifest packs only: required | optional
        "hint": null,                 // manifest optional-tier entries only
        "superseded_by": null }
    ],
    "omitted": [
      // reason: budget | max_documents | deprecated | unavailable | revoked
      // `hint` is echoed for omitted optional-tier members (the menu-for-free, §3.3)
      { "public_id": "...", "title": "...", "reason": "budget", "hint": "..." }
    ]
  }
  ```

- **Contract changes:** `DocumentListingSchema` gains `status` (and
  `superseded_by`), so it flows to list + search + pack members uniformly; new
  `PackResponse` / member schemas in `contract.ts`; `openapi.json` regenerated +
  `OPENAPI_INFO_VERSION` minor bump.

## 5. Threat model

- **Manifest / link injection → exfiltration?** Moot. A pack returns only
  documents the **calling agent could already read** — under the single-tenant
  model an agent key reads the whole fleet, and the pack tools are agent-gated
  (anonymous can't call MCP at all). A hostile manifest can name any public_id,
  but the agent could already `read_document` it. No escalation, same shape as the
  librarian's self-scoped argument (`librarian-design.md §4`).
- **Visibility is unchanged.** The pack tool is an agent surface; it does not
  touch the anonymous render gate. A *public* manifest doc that links to a
  *private* member renders, for an anonymous viewer, as a link that 404s (private →
  opaque 404); the authenticated agent loading the pack gets the body, exactly as
  `read_document` already would. No new disclosure.
- **Budget as a DoS knob.** `max_documents` + `budget_bytes` + the per-doc cap
  bound the work; a pack is `1 + K` R2 GETs with `K ≤ max_documents`. The fill
  loop stops at the first binding limit.
- **Stale-onboarding (the motivating risk).** Addressed by §3.4: deprecated docs
  are excluded from packs by default and marked in search.

## 6. Build order & the surface-sync tax

Phased so each step is independently shippable (like `vector-search-design.md`):

1. **Lifecycle axis.** Migration 0014 (`status`, reserved `archived`, optional
   `superseded_by`); `setDocumentStatusCore` + `POST /admin/documents/:id/status`
   + manage-page control; `DocumentListingSchema.status` + search marking + the
   `status` list/search filter. Independently valuable (the corpus gets a
   deprecate-without-killing verb even before packs exist).
2. **Automatic pack.** `src/pack.ts` budget-fill + the `search_documents`
   `include_bodies` branch (or the unified tool, per §3.5). Excludes deprecated by
   default.
3. **Curated / ad-hoc pack.** `load_context_pack({ from })` — link-neighborhood +
   manifest parsing; the `pack-<name>` slug convention; discovery via existing
   `list_documents` (filter to the `pack-` slug prefix or a `pack` tag).

**Per the API-surface-change rule, each phase must touch in the same commit:** the
seven (→eight) MCP tool descriptions, `skills/publishing.md`, `docs/http-api.md`
(+ its live Slopcafe mirror), both specs (SOLO as-built; PLATFORM only if lineage
diverges), `openapi.json` + `OPENAPI_INFO_VERSION`, and `CLAUDE.md`. The `status`
field and the new tool are exactly the kind of contract a cold MCP agent sees only
through descriptions.

## 7. Deferred / open

- **Tool surface (§3.5)** — search-extension + `load_context_pack` vs. one unified
  `get_context_pack`. Recommended but not locked.
- **Manifest required or not (§3.3)** — allow implicit link-neighborhood for any
  doc, or require an explicit manifest for *named* packs. Both kept in the draft.
- **`superseded_by` in 0014 or later (§3.4)** — ship with status or defer to keep
  the migration minimal.
- **Empty-pack edge (§3.2)** — force-include the top candidate when it alone
  exceeds budget, or always skip-and-report.
- **Manifest tiering & hints (§3.3)** — adopt the `[optional]` tier *and*
  per-entry hints (they justify each other; the hint-on-omitted menu is the real
  win), or ship neither and let authored order + budget prioritize. Leaning:
  both-or-neither.
- **Richer manifest directives (§3.3)** — `query:` (pinned docs + top results),
  `exclude:`. Beyond tiering.
- **Status-aware ranking** — down-rank `deprecated` in search rather than only
  marking it; size the tuning before wiring.
- **`archived` behavior** — the reserved third state's hide-unless-opted-in
  semantics on search/list.
- **Agent-reachable deprecation** — let an author deprecate/supersede via MCP, not
  just the operator (the trust model already permits it).
- **Pack caching** — none in v1; if budget-fill R2 fan-out ever bites, a
  per-version markdown cache would help packs and `read_document` alike.
- **Token budgeting vs byte budgeting** — bytes are what we measure; a real
  tokenizer-aware budget is a later refinement.
