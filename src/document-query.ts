// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Document listing / lookup cores: the cursor-paginated fleet list, the
 * slug→row and slug→public_id lookups, and the review-queue count.
 *
 * Key invariants:
 *   - `listDocumentsCore` is the ONE place `params.order` becomes SQL: one
 *     `orderColumn` local drives the cursor predicate, the ORDER BY and the
 *     next-cursor `ts`.
 *   - Revoked rows are INCLUDED in the list (a revoked row surfacing in an
 *     `order=updated` walk is how a consumer learns the document died); the
 *     `publication` filter is the one exception, via the shared
 *     `documentPublicationClause`.
 *   - Slug lookups match LIVE documents only; the retired-vs-never-claimed
 *     distinction is the caller's job via `findSlugTombstoneCore`
 *     (document-slug).
 *   - Single-tenant: every caller sees the whole fleet.
 */

import {
  decodeDocumentListing,
  DOCUMENT_LISTING_COLUMNS,
  DOCUMENT_LISTING_JOINS,
  documentPublicationClause,
  documentTagLikePattern,
  type DocumentListingRow,
} from "./document-listing.js";
import type { Env } from "./env.js";
import { type ListParams, paginate } from "./pagination.js";
import type { DocumentListing } from "./contract.js";

/**
 * Count of documents in the operator's REVIEW QUEUE — public AND
 * publication=pending (issue #57), composed exactly the way the console/API
 * filter pair is: `d.visibility = 'public'` plus the SAME `documentPublicationClause`
 * the list surface and both search legs use, so this count can never drift
 * from what `?visibility=public&publication=pending` itself returns. The
 * single copy of the operator console dashboard's pending-promotion stat.
 */
export async function countPendingPromotionCore(env: Env): Promise<number> {
  const row = await env.META.prepare(
    `select count(*) as n from documents d where d.visibility = 'public' and ${documentPublicationClause("pending")}`,
  ).first<{ n: number }>();
  return Number(row?.n ?? 0);
}


// DocumentListing — the listing-row projection (same columns as
// GET /admin/documents). Defined in src/contract.ts. NOTE: `visibility` rides
// through the MCP list/search responses as an UNDOCUMENTED field — never named
// in any agent-facing contract (decision: agents see "published is published").


/**
 * The columns projected by DOCUMENT_LISTING_COLUMNS — shared by
 * listDocumentsCore (paginated, filtered), findDocumentBySlugCore (single-row
 * lookup), searchDocumentsCore's two legs (below), documentLinksCore's
 * backlinks and listOrphanDocumentsCore (src/links-core.ts, #53), and
 * findDocumentByPublicIdCore (src/pack-core.ts, #53). The shared declaration
 * and row decoder live in document-listing.ts (#72).
 * Centralizing the SELECT keeps the surface in lockstep: any new column added
 * to DocumentListing flows to every one of those paths in one edit.
 *
 * `updated_at` + `current_version_at` are the migration-0017 modification-time
 * pair. The second is FREE — `v` is the current-version row this projection
 * already joins for title/description/size — and the two answer different
 * questions: `updated_at` moves on any change (including a retag, which never
 * bumps a version), `current_version_at` moves only when bytes are written. A
 * row where they sit MEANINGFULLY apart was last touched by classification, not
 * content (they're stamped by two statements of the same batch, so a pure
 * content write can leave a millisecond between them — read the gap, not an
 * exact inequality).
 *
 * `published_ver` + `published_source_sha256` are the migration-0018 published/
 * current split (issue #43). `v` is still the CURRENT version — every field
 * derived from it (title, description, size, current_source_sha256) keeps
 * describing what a credentialed read returns — and the second `pv` join is the
 * PUBLISHED version, the one a public document's byte path actually renders.
 * Both are NULL when nothing has been promoted. Reading `published_ver` against
 * `current_ver` is how a caller sees "there is staged work here"; the hash pair
 * is how it sees whether a local copy matches the live page or the draft.
 *
 * `current_author_kind`/`current_author_id`/`current_author_name` (issue #58)
 * are the CURRENT VERSION's writer — `v.author_kind`/`v.author_agent_id`
 * (migration 0013), already sitting on the same `v` join this projection uses
 * for title/description/size, plus a second agents join (`va`, distinct from
 * `a` which resolves the DOCUMENT's birth-time `created_by`) for the writing
 * agent's display name. Free: no new join condition on `d`, no extra round
 * trip. Null together with the rest of `v.*` on a revoked doc (the `v` join
 * misses); `current_author_id`/`current_author_name` are additionally null for
 * an operator-written version (`va` join has nothing to resolve) or a
 * pre-0013 legacy version (`author_agent_id` was never backfilled).
 *
 * `current_author_client_id` (issue #63, migration 0019) rides the SAME `v`
 * join with no additional join of its own — it is stored verbatim, never
 * resolved through `oauth_clients` (deleting a client must not erase which
 * client wrote a version). It answers the question `current_author_id` cannot
 * once two OAuth clients share one agent: WHICH connector wrote these bytes.
 * Null on a revoked doc with the rest of `v.*`, and additionally null for an
 * operator write, a Door B `awh_`-bearer write, and every pre-0019 version.
 */
// Keep this rationale beside listDocumentsCore; the actual shared declaration
// lives in document-listing.ts so read-oriented modules do not import the write core.
/**
 * Build the LIKE-pattern for an AND-style tag filter against the JSON-encoded
 * `documents.tags` column (document-level since migration 0012). This filter
 * has never used FTS — it matches the real tags column — so the FTS tags-column
 * removal in 0012 leaves it unaffected beyond retargeting `v.tags` → `d.tags`.
 *
 * Storage shape (see `serializeTags`): `JSON.stringify(tags)` — for tags
 * `["foo","bar_x"]` that's the literal string `["foo","bar_x"]` with no spaces
 * and no JSON-escape characters (tag charset is `[A-Za-z0-9_-]`, so nothing
 * inside a tag needs escaping). The double-quotes around each tag are the
 * delimiter we anchor on, so `%"foo"%` matches when the tag list contains
 * "foo" and never matches a substring of a longer tag.
 *
 * The `_` LIKE wildcard collides with the tag charset (`_` IS legal inside
 * a tag — e.g. `my_tag`), so we escape underscores with `\_` and tell SQLite
 * about it via `ESCAPE '\'`. The `\` character itself isn't in the tag
 * charset, so it never appears in stored bytes — no double-escape needed.
 * The `%` wildcard doesn't collide with the charset, so it stays a literal
 * wildcard at the ends.
 */
// documentTagLikePattern lives in document-listing.ts; search-core.ts imports
// the same implementation directly — one encoding, no second copy.
/**
 * The `publication` filter's WHERE fragment (migration 0018), in ONE place —
 * the list surface and both search legs share it so the three can't drift on a
 * predicate whose whole subtlety is NULL handling. Takes no caller input (the
 * parser has already narrowed it to one of two literals) and binds nothing, so
 * it interpolates safely.
 *
 *   pending — `published_ver IS NOT current_ver`: the document holds bytes its
 *     publication pointer doesn't name. On a PUBLIC doc that's the operator's
 *     review queue; on a private one it also means "never published", which is
 *     the resting state of a private draft — hence `visibility=public` as the
 *     composing filter rather than a `visibility` term baked in here (the two
 *     knobs stay orthogonal, and "private docs with staged versions" stays
 *     expressible).
 *   current — `published_ver IS current_ver` (and non-null): a promote would be
 *     a no-op. The non-null term is what keeps "has no versions at all" — a
 *     shape the write path never produces, but the column allows — out of a set
 *     that claims something is published.
 *
 * `IS` / `IS NOT` (null-safe), never `=` / `<>`: `published_ver` is genuinely
 * nullable, and `NULL <> 3` evaluates to NULL — the plain comparison would drop
 * every never-published document out of `pending` without erroring.
 *
 * The `revoked_at is null` guard is the deliberate exception to this surface's
 * "filters narrow, revoked rows still appear" rule: revoke nulls BOTH pointers,
 * so a dead row would otherwise satisfy `current` (NULL IS NULL) and report a
 * publication state it doesn't have. The search legs already carry that guard;
 * repeating it here keeps the fragment correct standalone. Documented in
 * PUBLICATION_FILTERS (pagination.ts) and docs/http-api.md.
 *
 * `documentPublicationClause` lives in document-listing.ts so this list,
 * countPendingPromotionCore, and both search legs compose the ONE copy.
 */
/**
 * List documents (including revoked), newest first. Cursor-paginated — see
 * src/pagination.ts for the contract; callers omit `cursor` on the first
 * page and pass back `next_cursor` from the prior response to walk forward.
 *
 * Single-tenant trust model: any caller (operator or any agent) sees the
 * full fleet. If per-agent filtering becomes a need, add a `createdBy?`
 * arg here and an additional `WHERE created_by = ?` clause.
 *
 * The versions LEFT JOIN pulls title/description/size from the current
 * version row; tags/slug/visibility come from the document row itself
 * (document-level). Older code used a correlated subselect for size; the
 * JOIN form scales better as more per-version fields get surfaced.
 *
 * ORDERING is (<time column> DESC, id DESC), where the column is chosen by
 * `params.order` (migration 0017): `created` → `d.created_at` (newest published
 * first, the default), `updated` → `d.updated_at` (most recently TOUCHED first —
 * the change feed, where a retag or a revoke moves a row to the top even though
 * no version was written). The `id` tiebreaker matters on either column when two
 * rows share a stamp (D1's strftime stamps to ms; collisions are rare but real
 * under bursty writes, and a retag sweep touching several docs in one pass is
 * exactly such a burst) — without it cursors could skip a row at a page boundary.
 *
 * FILTERS:
 *   - `params.tags` — AND semantics. One `tags LIKE ? ESCAPE '\'` predicate
 *     per requested tag (see documentTagLikePattern for the encoding). Tags are
 *     pre-sanitized by `parseHttpListParams` / `parseMcpListArgs` to the
 *     stored shape so a `?tag=Foo!` query filters by `["Foo"]` — same
 *     silent-strip semantics as the write path.
 *   - `params.slug` — exact match against `documents.slug` (unique across
 *     live docs, so returns 0 or 1 rows when combined with no other filter).
 *   - `params.updatedSince` — `d.updated_at >= ?`, the change-feed window
 *     (migration 0017). Independent of `order`: windowing without re-sorting is
 *     legitimate ("what changed this week, oldest-published first"), and the two
 *     knobs compose. The parser has already normalized the bound to the stored
 *     timestamp shape, so this is a plain lexicographic compare.
 *   - `params.visibility` — `d.visibility = ?` (migration 0011). Narrows the
 *     same rows the caller already sees; the value has ridden every listing row
 *     since 0011, so this saves a client-side pass and nothing else.
 *   - `params.publication` — the `published_ver` vs `current_ver` relationship
 *     (migration 0018), via documentPublicationClause. `visibility=public` +
 *     `publication=pending` is the operator's REVIEW QUEUE — the documents whose
 *     readers are seeing older bytes than the fleet has written — answered in
 *     one request instead of a full-corpus walk with a client-side compare.
 *
 * Filters compose with the cursor predicate: the WHERE clause is always
 * built as `<cursor>? AND <tags>? AND <slug>? AND …`, so paginating through a
 * filtered list walks the filtered subset in the same (time, id) order as the
 * unfiltered list. Revoked docs are still included — slug is cleared on revoke
 * (see revokeDocumentCore), so a `slug=` filter naturally only matches live docs
 * anyway, and a revoked row surfacing in an `order=updated` walk is the POINT:
 * it's how a consumer learns the document died. The ONE exception is
 * `publication`, which excludes revoked rows in both directions (revoke nulls
 * both pointers, so a dead row has no publication state to report) — a consumer
 * that wants deaths in its feed leaves that filter off.
 */
export async function listDocumentsCore(
  env: Env,
  params: ListParams,
): Promise<{ documents: DocumentListing[]; next_cursor: string | null }> {
  // `d.id` is needed for the cursor tiebreaker but isn't part of the public
  // DocumentListing shape — we strip it in the projection below.
  // The ONE place `order` becomes SQL (migration 0017). The cursor predicate,
  // the ORDER BY, and the `ts` we mint into the next cursor all read this single
  // local, so the three can never disagree about which column the walk is on.
  // Interpolated, not bound — it's a column name, and `params.order` is a
  // two-value union the parser already validated (a bound parameter can't be an
  // identifier anyway).
  const orderColumn = params.order === "updated" ? "d.updated_at" : "d.created_at";

  // Build the WHERE clause + bind list dynamically. Every predicate is
  // optional, so we accumulate clauses + bind args and join with AND at
  // the end. The cursor predicate, when present, comes first so its three
  // binds line up positionally with the existing `?, ?, ?` triple.
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (params.cursor) {
    // Same (ts, id) boolean rewrite as ever, applied to whichever column this
    // walk is ordered by. The parser guarantees the cursor was minted under this
    // same ordering (`bad_cursor` otherwise), so `ts` is always a value of
    // `orderColumn` and never a timestamp from the other axis.
    clauses.push(`(${orderColumn} < ? or (${orderColumn} = ? and d.id < ?))`);
    binds.push(params.cursor.ts, params.cursor.ts, params.cursor.id);
  }
  if (params.updatedSince !== null) {
    // Inclusive `>=` (migration 0017), deliberately: a caller resuming a change
    // feed passes back the newest `updated_at` it saw, and `>` would drop any
    // row sharing that exact millisecond — the same collision the id tiebreaker
    // exists for. Re-delivering the boundary row is the recoverable failure
    // (dedupe on public_id); skipping one silently is not. Uses the
    // (updated_at, id) index from migration 0017.
    clauses.push("d.updated_at >= ?");
    binds.push(params.updatedSince);
  }
  for (const tag of params.tags) {
    // One LIKE per tag = AND semantics over the document-level `d.tags` JSON
    // column (migration 0012). SQLite plans this as a sequential scan over the
    // `documents` set — fine for v1's scale; a tag index would mean
    // restructuring storage (json_each + a normalized tags table, say). Deferred.
    clauses.push("d.tags like ? escape '\\'");
    binds.push(documentTagLikePattern(tag));
  }
  if (params.slug !== null) {
    // Slug uses the partial UNIQUE INDEX on documents(slug) WHERE slug IS NOT NULL.
    // Equality match — the planner uses the index for a single row hit.
    clauses.push("d.slug = ?");
    binds.push(params.slug);
  }
  if (params.status !== null) {
    // Lifecycle filter (migration 0014). No filter (the default) includes
    // deprecated docs — they're still findable, just carried/marked in the row.
    clauses.push("d.status = ?");
    binds.push(params.status);
  }
  if (params.visibility !== null) {
    // Anonymous-readability filter (migration 0011). A plain column equality —
    // it narrows the same fleet-wide row set every credentialed caller already
    // sees (the row has always carried `visibility`), so it discloses nothing.
    clauses.push("d.visibility = ?");
    binds.push(params.visibility);
  }
  if (params.publication !== null) {
    // Publication-pointer filter (migration 0018). `visibility=public` +
    // `publication=pending` IS the operator's review queue in one call —
    // See documentPublicationClause for the NULL semantics and revoked exclusion.
    clauses.push(documentPublicationClause(params.publication));
  }
  const whereSql = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";

  // Peek one past the limit so we know whether next_cursor should be set.
  const peek = params.limit + 1;
  binds.push(peek);

  const sql = `select ${DOCUMENT_LISTING_COLUMNS}
     ${DOCUMENT_LISTING_JOINS}
     ${whereSql}
     order by ${orderColumn} desc, d.id desc
     limit ?`;
  const result = await env.META.prepare(sql).bind(...binds).all<DocumentListingRow>();
  const { items, next_cursor } = paginate(
    result.results ?? [],
    params.limit,
    decodeDocumentListing,
    // Stamp the ordering onto the cursor we hand back (migration 0017) so the
    // next page is validated against the axis this page was ordered by, and
    // read the `ts` from the matching column — a cursor carrying an updated_at
    // value labelled `created` would be the exact silent skip the label prevents.
    (row) => ({
      ts: params.order === "updated" ? row.updated_at : row.created_at,
      id: row.id,
      order: params.order,
    }),
  );
  return { documents: items, next_cursor };
}

/**
 * Look up a single document by its slug. Returns the same DocumentListing
 * shape as a row from listDocumentsCore so callers can render both with one
 * projection.
 *
 * Why a dedicated function rather than just calling listDocumentsCore with a
 * slug filter: ergonomic. A slug lookup is "the doc, or not_found" — wrapping
 * that in a `{ documents: [...], next_cursor: null }` envelope and asking the
 * caller to peel out `documents[0]` is friction we'd rather absorb here.
 *
 * Revoked docs are excluded — `revokeDocumentCore` clears `documents.slug` to
 * NULL on revoke, so a revoked document has no live slug to match. (Its slug is
 * now retired into `slug_tombstones`, migration 0009 — a separate table this
 * live-only lookup never touches.) The `revoked_at IS NULL` clause is belt-and-
 * suspenders for the same reason. A retired slug surfacing as 410 Gone is the
 * caller's job (it consults findSlugTombstoneCore on this lookup's miss), not
 * this function's.
 *
 * Caller validates the slug input shape upstream (validateSlugInput in
 * src/metadata.ts); this function trusts what it receives and just runs the
 * SELECT. An invalid-shape slug that bypasses validation would simply fail
 * to match — no security implication, but the agent-facing error message is
 * better when the upstream parser catches it first.
 */
export type FindBySlugErr = { ok: false; code: "not_found" };
export async function findDocumentBySlugCore(
  env: Env,
  slug: string,
): Promise<{ ok: true; document: DocumentListing } | FindBySlugErr> {
  const row = await env.META.prepare(
    `select ${DOCUMENT_LISTING_COLUMNS}
     ${DOCUMENT_LISTING_JOINS}
     where d.slug = ? and d.revoked_at is null
     limit 1`,
  )
    .bind(slug)
    .first<DocumentListingRow>();
  if (!row) return { ok: false, code: "not_found" };
  return { ok: true, document: decodeDocumentListing(row) };
}

/**
 * Resolve a slug to its live document's public_id, or null if no live
 * document carries it. Backs the MCP read_document tool's slug-input path
 * so a slug→body read is a single call (vs. list_documents then read).
 *
 * The slug is validated upstream (validateSlugInput in the handler); this
 * is the bare DB hit. It mirrors findDocumentBySlugCore's revoked-exclusion
 * — a revoked doc's slug is retired (migration 0009), so this resolves to
 * nothing and the caller distinguishes "retired → 410" from "never existed →
 * 404" via findSlugTombstoneCore. We return the public_id (not the body) so the
 * handler can reuse the unchanged readDocumentCore / readDocumentTextCore path
 * and echo the resolved capability id back to the caller.
 */
export async function resolvePublicIdBySlug(
  env: Env,
  slug: string,
): Promise<string | null> {
  const row = await env.META.prepare(
    "select public_id from documents where slug = ? and revoked_at is null limit 1",
  )
    .bind(slug)
    .first<{ public_id: string }>();
  return row?.public_id ?? null;
}
