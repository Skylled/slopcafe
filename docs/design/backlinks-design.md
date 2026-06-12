# Wiki-style backlinks: the document link graph

**Status: BUILT** (GitHub issue #40, migration 0016). This note is the design
rationale + as-built record for the `document_links` table, the write-path
sync, the read-time resolution model, and the surfaces that consume them.

## 1. Problem

Slug cross-linking has existed since migration 0005 — documents routinely link
each other with `/s/<slug>` and `/d/<public_id>` hrefs, and context packs
(issue #21) already *walk* those links at read time to expand an index page
into a pack. But nothing knew **"what links here."** The corpus was a set of
pages with one-way pointers, not a web:

- no backlinks ("referenced by…") — the traversal primitive a wiki gives both
  the operator and a reading agent;
- no orphan detection (docs nothing links to);
- no broken-link detection (links to unclaimed slugs, retired slugs, revoked
  docs) — and renames/revokes *create* link rot silently, because slugs retire
  rather than free (issue #6).

## 2. Shape of the solution

**Extract at write time, resolve at read time.**

At write time, every publish/update extracts the on-platform link targets from
the *sanitized render H* — the same `extractOutboundLinks` walk `src/pack.ts`
already does for pack expansion — and stores them as rows in a new
`document_links` table, **inside the same D1 batch** as the `documents_fts`
row. The graph therefore tracks each document's current version exactly the
way search does: never a trigger, never a second write path, never drift.

```sql
CREATE TABLE document_links (
  src_doc_id   TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,            -- authored first-appearance order
  target_kind  TEXT    NOT NULL CHECK (target_kind IN ('public_id', 'slug')),
  target_value TEXT    NOT NULL,            -- the RAW addressed name
  PRIMARY KEY (src_doc_id, target_kind, target_value)
);
CREATE INDEX document_links_target ON document_links (target_kind, target_value);
```

### Late binding is the core decision

`target_value` stores the raw addressed name, **not** a resolved
`documents.id` FK. A wiki's links legitimately point at things that don't
exist yet (an unclaimed slug), things that stop existing (a revoked doc), and
things that change names (a renamed slug). Resolving at write time would
freeze one moment's answer into the row and rot immediately; storing the raw
name and resolving at read time keeps every one of those states representable
and the answer always current. This is the "bites" item from the issue,
embraced as the design rather than worked around.

### Resolution states (read time)

`documentLinksCore` (src/core.ts) resolves each stored target against the
tables that actually know, yielding one of five states on the outbound side:

| state        | meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `live`       | a live document answers here (target public_id + title carried)    |
| `redirected` | retired slug with a loud tombstone redirect (migration 0010)       |
| `retired`    | retired slug, no redirect — `/s/<slug>` is 410 Gone                |
| `revoked`    | a `/d/` link whose document was killed                             |
| `missing`    | nothing ever answered here (unclaimed slug / unknown public_id)    |

`retired` / `revoked` / `missing` are the broken-link report. `redirected` is
the "update your link" nudge — consistent with the platform-wide rule that
redirects are loud and never auto-followed.

**Backlinks** are the reverse query: live documents whose stored rows address
this doc by its `public_id` or its **current** live slug, returned as full
`DocumentListing` rows (the shared `LISTING_SELECT_COLUMNS` projection),
newest first, capped at 200 like every list surface. A link authored against a
since-renamed slug deliberately does **not** count as a backlink — it reaches
the doc only through the tombstone redirect, and redirect hops are never
followed implicitly anywhere in the system; it shows up on the *source* doc's
outbound list as `redirected` instead, which is the actionable view.

Self-links are excluded twice (write-time filter + read-time `id != ?` guard):
a document "referencing itself" is navigation chrome, not graph structure.

### Sync rules (mirror of the FTS convention)

- **publish / update** (and therefore `edit_document` / restore, which
  delegate to `updateDocumentCore`): DELETE-then-INSERT the doc's rows in the
  same `META.batch()` as the version + FTS writes.
- **revoke**: DELETE the doc's outbound rows in the revoke batch (revoke
  tombstones the `documents` row rather than deleting it, so the FK cascade
  never fires — the explicit DELETE is the live cleanup). Inbound rows in
  *other* docs' link sets stay put: they're raw names, and now resolve to
  `revoked`/`missing` — exactly the broken-link signal the feature exists to
  surface.
- Per-doc row cap: 200 (matches the pack member-ref cap); 4-binds-per-row
  INSERTs are chunked under D1's bound-parameter limit.

## 3. Surfaces

| surface | what | auth |
| --- | --- | --- |
| `GET /d/:id/links` | `{public_id, backlinks[], outbound[]}` (`DocumentLinksResponse`) | credentialed (operator ≥ agent, `requireReader`) |
| MCP `read_document` `include_links:true` | adds `backlinks[]` + `outbound_links[]` to the envelope | agent (the MCP door) |
| `/d/:id/manage` "Link graph" panel | referenced-by list + outbound health, read-only | operator session |
| `GET /admin/links/orphans` | live docs nothing (live) links to — curation worklist, capped 200, no cursor | operator |
| `POST /admin/links/backfill` (+ console form) | re-extract rows from stored H, paged/resumable | operator |

**Why backlinks are credentialed, not public.** A backlink row is a listing
row for a *different* document — including private ones — and the whole-fleet
listing surface has always been credentialed. Putting a "referenced by" panel
on the anonymous shell would leak private docs' existence/titles through any
public doc they link to. So the anonymous render surface is untouched; the
operator gets the panel on the manage page, agents get `include_links`. A
public-only filtered panel on the shell is a possible later increment (§5).

**Why orphans is operator-only.** It's a curation view of the whole fleet, and
"orphan" is a librarian's signal, not an error — a deliberately standalone doc
(shared by URL only) is a fine orphan. The operator decides; agents don't need
the worklist.

## 4. Backfill

Link rows derive from R2-resident H bytes, which a SQL migration can't see —
and much of this corpus is write-once, so "rows appear on next write" would
never converge (the same gap the vectors `missing` backfill exists for).
`backfillLinksCore` pages live docs, GETs each H, re-extracts, and
delete-then-inserts — always rebuild-semantics (extraction is cheap and
deterministic, so a `missing` mode isn't worth its switch), idempotent,
resumable via the standard cursor. Run it once after deploying migration 0016;
until then, orphan detection reports everything as an orphan (no rows say
otherwise) — the orphans endpoint documents this loudly.

Unlike the vector sync there is **no best-effort/waitUntil seam**: link rows
ride the synchronous write batch itself, so there is nothing to heal — the
backfill exists only for pre-0016 history, not for dropped syncs.

## 5. Deferred / not built

- **Graph view** — a rendered corpus map for the operator console. The table
  is the hard part; a viz is additive whenever it earns its keep.
- **Redirect-aware backlink matching** — counting `redirected`-state inbound
  links as backlinks (flagged `via: "redirect"`). Deliberately out for v1 to
  keep the loud-redirect posture uniform; revisit if renames make real
  backlinks vanish in practice.
- **Anonymous backlinks panel** — a public-only filtered "referenced by" on
  the shell page. Needs a visibility-filtered query + a leak review; not
  needed by the operator or agents, who have credentialed surfaces.
- **Orphans/links in MCP tools beyond read_document** — e.g. an agent-facing
  orphan list for librarian work (docs/design/librarian-design.md). The
  classifier agent design should pull this in when it lands.
- **`?tags=`-style link filters on list/search** — e.g. "docs that link to X."
  `GET /d/:id/links` already answers the common form of the question.
