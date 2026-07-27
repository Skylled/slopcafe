// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Cursor-based pagination shared by the four list endpoints:
 *   GET /admin/agents
 *   GET /admin/agents/:id/keys
 *   GET /admin/documents
 *   MCP list_documents
 *
 * Why cursors (not offset/limit): every list is ORDER BY <time column> DESC.
 * Offset pagination would skip or duplicate rows when items are inserted or
 * revoked between pages. A cursor encoding the last row's (time, id) pair
 * is stable across writes — the worst it does on a concurrent insert is
 * fail to surface the new row in this page; the caller sees it on the next
 * top-of-list walk.
 *
 * Cursor shape: base64url(JSON({ ts, id, order? })). It's deliberately opaque
 * to callers — they round-trip the string verbatim and never parse it. Using
 * JSON inside is what let the sort-field discriminator (`order`) be added
 * below without a versioning dance, and a stray cursor from a different
 * endpoint just fails the decode and 400s.
 *
 * Tie-breaker: `id` after the time column. UUIDs (agents, agent_keys,
 * documents) compare lexicographically as text and are unique, so the (ts, id)
 * pair is a strict total order — no duplicates on tied timestamps.
 *
 * SQL pattern: we use the boolean rewrite
 *   WHERE created_at < ? OR (created_at = ? AND id < ?)
 * rather than the SQL row-value form `(created_at, id) < (?, ?)`. Both work
 * in recent SQLite, but the rewrite is portable to older planners and reads
 * the same to anyone scanning the query.
 *
 * ORDERING (migration 0017): the document list walks either `created_at` (the
 * default, "newest first") or `updated_at` (the change feed, "most recently
 * touched first"). A cursor is only meaningful under the ordering that minted
 * it — its `ts` is a value of THAT column — so the cursor carries the ordering
 * and a mismatch is a HARD `bad_cursor` error, never a silently-walked page.
 * Silently reading an `updated_at` cursor under the created ordering would
 * neither error nor return the right rows: it would skip or repeat an arbitrary
 * slice of the corpus, which is the failure mode a change feed can least afford.
 *
 * Filter inputs (`tags`, `slug`, `status`, `visibility`, `publication`,
 * `updated_since`) are parsed here too. They're list-shaped on the wire —
 * `?tag=foo&tag=bar` over HTTP, `tags: ["foo","bar"]` over MCP — and consumed by
 * listDocumentsCore / searchDocumentsCore only (the agent-keys and agents lists
 * carry none of those columns). Defining them here keeps the parse/validate
 * surface in one place; lists that don't use the filters just ignore the fields
 * — `order` included.
 */

import type { Visibility } from "./access.js";
import { DocumentStatusSchema, type DocumentStatus, VisibilitySchema } from "./contract.js";
import {
  sanitizeTagsInput,
  type SlugReject,
  validateSlugInput,
} from "./metadata.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/**
 * Which time axis a document list walks (migration 0017):
 *   - `created` — `documents.created_at`, newest-published first. The default,
 *     and the ONLY ordering the non-document lists (agents, keys, the backfill
 *     sweeps) have; they ignore the param entirely.
 *   - `updated` — `documents.updated_at`, most-recently-touched first. The
 *     change-feed ordering: content writes AND classification changes (retag,
 *     rename, visibility/status flip) and revokes all move a row to the top.
 *
 * Search surfaces ignore `order` — they rank by relevance, which is why they
 * also have no cursor (see searchDocumentsCore).
 */
export const LIST_ORDERS = ["created", "updated"] as const;
export type ListOrder = (typeof LIST_ORDERS)[number];
export const DEFAULT_ORDER: ListOrder = "created";

/**
 * The PUBLICATION filter (migration 0018) — a filter on the relationship between
 * `documents.published_ver` and `documents.current_ver`, not on a column:
 *   - `pending` — `published_ver IS NOT current_ver`: the document holds bytes
 *     its publication pointer doesn't name. On a PUBLIC document that is exactly
 *     the operator's review queue ("readers are seeing older bytes than the
 *     fleet has written"); on a PRIVATE one it also covers "nothing has ever
 *     been published" (`published_ver IS NULL`), which is the normal state of a
 *     private draft — so `publication=pending` alone is NOT a review queue.
 *     Compose it with `visibility=public` for that (the one call the Flutter
 *     review-queue UI makes instead of walking the whole corpus).
 *   - `current` — `published_ver IS current_ver`: what the pointer names is the
 *     newest thing there is, so a promote would be a no-op.
 *
 * Both branches EXCLUDE REVOKED documents, which is the one place this filter
 * departs from the "filters just narrow, revoked rows still appear" rule the
 * rest of the list surface follows. Revoke nulls both pointers, so a dead row
 * would otherwise land in `current` (NULL IS NULL) and claim a publication state
 * it does not have. Publication state is meaningless for a document that serves
 * nothing; a consumer that wants revokes in its feed leaves this filter off.
 *
 * Null-safe SQL (`IS` / `IS NOT`, not `=` / `<>`) is load-bearing: `published_ver`
 * is genuinely nullable ("nothing has ever been published" is a real, permanent
 * state), and `NULL <> 3` is NULL, not true — the plain comparison would silently
 * drop every never-published document from `pending`, which is most of a
 * private-by-default corpus.
 */
export const PUBLICATION_FILTERS = ["pending", "current"] as const;
export type PublicationFilter = (typeof PUBLICATION_FILTERS)[number];

/**
 * The decoded shape; callers should never inspect or construct this directly.
 *
 * `order` is the sort-field discriminator (migration 0017). ABSENT means the
 * created-at ordering — that's the encoding of the default, not a legacy shape:
 * the agents/keys/backfill lists have exactly one ordering and mint bare
 * (ts, id) cursors, so requiring the field would mean touching every one of them
 * to say the only thing they can say. What the field buys is the mismatch check
 * (`cursorOrderMismatch` below): a cursor minted under one ordering is rejected
 * outright under the other rather than being read against the wrong column.
 */
export type Cursor = { ts: string; id: string; order?: ListOrder };

/**
 * What list-core functions consume — already validated, no `ok` discriminant.
 * The parsers below return a `{ ok: true } & ListParams` variant so the call
 * site can narrow, then pass the validated shape to core.
 *
 * `tags` and `slug` are document-list filters. The agent-keys and agents
 * list endpoints ignore them (they have no such columns); only
 * `listDocumentsCore` consults them.
 *
 *   - `tags`: AND semantics. A row matches when EVERY tag in the array
 *     appears in the row's stored tags JSON. Empty array (the common case)
 *     means "no tag filter".
 *   - `slug`: exact match against `documents.slug`. Returns 0 or 1 rows
 *     when set (slug is unique across live docs). Null = no slug filter.
 *   - `status`: exact match against `documents.status` (migration 0014 —
 *     "active" | "deprecated"; "archived" is accepted for forward-compat but
 *     nothing sets it in v1). Null = no status filter (deprecated docs are
 *     INCLUDED by default and carried/marked in the row).
 *   - `visibility`: exact match against `documents.visibility` (migration 0011 —
 *     "public" | "private"). Null = no filter. Discloses nothing new: every
 *     caller of these surfaces is already credentialed (`requireReader` / an
 *     agent key / the operator) and already reads `visibility` off every row —
 *     this only saves them the client-side pass.
 *   - `publication`: the `published_ver` vs `current_ver` relationship
 *     (migration 0018) — see PUBLICATION_FILTERS above. Null = no filter.
 *   - `updatedSince`: `documents.updated_at >= ?` (migration 0017), the change
 *     feed's window. Already normalized to the stored timestamp shape by the
 *     parser (see parseUpdatedSince) so core can compare lexicographically.
 *     Null = no window. Applies to the list AND search surfaces, like tags/slug.
 *
 * `order` is not a filter but the same kind of pre-validated input: core turns
 * it into a column name, so it must arrive as one of the two legal values.
 *
 * Why tags arrive pre-validated here (not as raw user input that core
 * validates): the parser owns the silent-sanitization step that mirrors
 * write-time tag handling (charset, dedupe, length cap). That keeps core
 * focused on SQL — it can assume the tags it receives are already in the
 * stored shape.
 */
export type ListParams = {
  limit: number;
  cursor: Cursor | null;
  order: ListOrder;
  tags: string[];
  slug: string | null;
  status: DocumentStatus | null;
  visibility: Visibility | null;
  publication: PublicationFilter | null;
  updatedSince: string | null;
};

/**
 * `bad_request` (not a dedicated `bad_order` / `bad_updated_since`) is the
 * deliberate choice for the two migration-0017 params: both are plain
 * parameter-shape rejections with no context field a client could branch on,
 * and the closest existing analogue — search's enum-valued `?mode=` — already
 * answers `bad_request`. Growing the canonical `ErrorCode` vocabulary (and with
 * it every generated client's error enum, the OpenAPI ErrorBody union, and four
 * docs that must stay in lockstep) buys nothing here. `bad_slug`/`bad_status`
 * are dedicated codes because they predate that reasoning, not against it — and
 * the `visibility` / `publication` filters follow the 0017 precedent, not the
 * `bad_status` one, for the same reason.
 */
export type ParsedListParams =
  | ({ ok: true } & ListParams)
  | { ok: false; code: "bad_limit"; message: string }
  | { ok: false; code: "bad_cursor"; message: string }
  | { ok: false; code: "bad_slug"; message: string }
  | { ok: false; code: "bad_status"; message: string }
  | { ok: false; code: "bad_request"; message: string };

export function encodeCursor(c: Cursor): string {
  return base64UrlEncode(JSON.stringify(c));
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const json = base64UrlDecode(s);
    const obj = JSON.parse(json);
    if (
      obj &&
      typeof obj === "object" &&
      typeof obj.ts === "string" &&
      typeof obj.id === "string"
    ) {
      // An `order` we don't recognize fails the whole decode rather than being
      // dropped to the default: a cursor minted by a FUTURE ordering must not be
      // silently walked against created_at (that's the same wrong-column read
      // the mismatch check exists to prevent, just from the other direction).
      if (obj.order === undefined) return { ts: obj.ts, id: obj.id };
      if (!isListOrder(obj.order)) return null;
      return { ts: obj.ts, id: obj.id, order: obj.order };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function isListOrder(v: unknown): v is ListOrder {
  return typeof v === "string" && (LIST_ORDERS as readonly string[]).includes(v);
}

function base64UrlEncode(s: string): string {
  // btoa expects Latin-1; our payload is JSON of ASCII timestamps + UUIDs, so
  // no codepoint escapes are needed. If we ever encode non-ASCII strings,
  // route through TextEncoder first.
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}

/**
 * Parse `?limit=N&cursor=<opaque>&tag=…&slug=…` from a request URL. Returns
 * ListParams on success or a typed error the HTTP wrapper can convert to a
 * 400 / 422 JSON body.
 *
 * Tag handling on the wire: each `?tag=` query param contributes one value;
 * `?tag=foo,bar` is also split on commas as a courtesy (mirroring the
 * `X-Doc-Tags` header). All values flow through `sanitizeTagsInput` — same
 * silent-strip-and-dedupe semantics as write time — so `?tag=foo!&tag=bar`
 * filters by `["foo", "bar"]`. A list that sanitizes to empty drops the
 * filter entirely (matches every row), which is the only sane reading: the
 * alternative ("matches no row, ever") surprises an agent that typoed.
 *
 * Slug handling: a present-but-empty `?slug=` is treated as no filter (a
 * stripped form field is the common cause); a non-empty slug is validated
 * with the same rules as the write path and rejected with `bad_slug` on
 * invalid charset/length.
 *
 * Change-feed handling (migration 0017): `?order=updated` switches the walk to
 * `documents.updated_at`, and `?updated_since=2026-07-01` windows it. The
 * cursor's ordering must match `?order=` or the request fails `bad_cursor` —
 * paginating a change feed is exactly where a silently mis-read cursor would do
 * the most damage.
 */
export function parseHttpListParams(url: URL): ParsedListParams {
  const limitRaw = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return {
        ok: false,
        code: "bad_limit",
        message: `limit must be an integer in 1..${MAX_LIMIT}`,
      };
    }
    limit = n;
  }
  const order = parseOrderParam(url.searchParams.get("order"));
  if (!order.ok) return order;

  const cursorRaw = url.searchParams.get("cursor");
  let cursor: Cursor | null = null;
  if (cursorRaw !== null && cursorRaw !== "") {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      return { ok: false, code: "bad_cursor", message: "invalid cursor" };
    }
    const mismatch = cursorOrderMismatch(cursor, order.value);
    if (mismatch) return mismatch;
  }

  const updatedSince = parseUpdatedSince(url.searchParams.get("updated_since"));
  if (!updatedSince.ok) return updatedSince;

  // `?tag=foo&tag=bar` (repeated) AND `?tag=foo,bar` (comma) both work; we
  // flatten the comma form before handing to sanitizeTagsInput so dedupe
  // sees the full set.
  const tagsRaw = url.searchParams.getAll("tag").flatMap((v) => v.split(","));
  const tags = sanitizeTagsInput(tagsRaw);

  const slugRaw = url.searchParams.get("slug");
  let slug: string | null = null;
  if (slugRaw !== null && slugRaw !== "") {
    const v = validateSlugInput(slugRaw);
    if (!v.ok) {
      return { ok: false, code: "bad_slug", message: slugRejectMessage(v.reason) };
    }
    slug = v.slug;
  }

  const status = parseStatusFilter(url.searchParams.get("status"));
  if (!status.ok) return status;

  const visibility = parseVisibilityFilter(url.searchParams.get("visibility"));
  if (!visibility.ok) return visibility;

  const publication = parsePublicationFilter(url.searchParams.get("publication"));
  if (!publication.ok) return publication;

  return {
    ok: true,
    limit,
    cursor,
    order: order.value,
    tags,
    slug,
    status: status.value,
    visibility: visibility.value,
    publication: publication.value,
    updatedSince: updatedSince.value,
  };
}

/**
 * Parse MCP tool args of the shape
 * `{ limit?, cursor?, order?, tags?, slug?, status?, updated_since? }`.
 * Same semantics as parseHttpListParams; tools surface the message via
 * textError on failure. MCP takes tags as an array (the natural JSON-RPC
 * shape) rather than as repeated keys, and `updated_since` keeps its wire
 * spelling (snake_case) rather than the camelCase it lands in on ListParams.
 */
export function parseMcpListArgs(args: {
  limit?: number;
  cursor?: string;
  order?: string;
  tags?: string[];
  slug?: string;
  status?: string;
  visibility?: string;
  publication?: string;
  updated_since?: string;
}): ParsedListParams {
  let limit = DEFAULT_LIMIT;
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT) {
      return {
        ok: false,
        code: "bad_limit",
        message: `limit must be an integer in 1..${MAX_LIMIT}`,
      };
    }
    limit = args.limit;
  }
  const order = parseOrderParam(args.order ?? null);
  if (!order.ok) return order;

  let cursor: Cursor | null = null;
  if (args.cursor !== undefined && args.cursor !== "") {
    cursor = decodeCursor(args.cursor);
    if (!cursor) {
      return { ok: false, code: "bad_cursor", message: "invalid cursor" };
    }
    const mismatch = cursorOrderMismatch(cursor, order.value);
    if (mismatch) return mismatch;
  }

  const updatedSince = parseUpdatedSince(args.updated_since ?? null);
  if (!updatedSince.ok) return updatedSince;

  // sanitizeTagsInput accepts unknown and tolerates non-array/non-string
  // entries, so a misbehaving client can't crash this parse — it just gets
  // an empty filter (same outcome as omitting the field).
  const tags = sanitizeTagsInput(args.tags);

  let slug: string | null = null;
  if (args.slug !== undefined && args.slug !== "") {
    const v = validateSlugInput(args.slug);
    if (!v.ok) {
      return { ok: false, code: "bad_slug", message: slugRejectMessage(v.reason) };
    }
    slug = v.slug;
  }

  const status = parseStatusFilter(args.status ?? null);
  if (!status.ok) return status;

  const visibility = parseVisibilityFilter(args.visibility ?? null);
  if (!visibility.ok) return visibility;

  const publication = parsePublicationFilter(args.publication ?? null);
  if (!publication.ok) return publication;

  return {
    ok: true,
    limit,
    cursor,
    order: order.value,
    tags,
    slug,
    status: status.value,
    visibility: visibility.value,
    publication: publication.value,
    updatedSince: updatedSince.value,
  };
}

/**
 * Validate a raw `order` value against the two orderings (migration 0017).
 * Absent/empty → the created-at default. Rejects an unknown value rather than
 * falling back: silently walking created-at when the caller asked for the change
 * feed would return plausible-looking rows in the wrong order — the worst kind
 * of wrong (same reject-not-sanitize rule as the slug and status filters).
 */
function parseOrderParam(
  raw: string | null,
): { ok: true; value: ListOrder } | { ok: false; code: "bad_request"; message: string } {
  if (raw === null || raw === "") return { ok: true, value: DEFAULT_ORDER };
  if (!isListOrder(raw)) {
    return {
      ok: false,
      code: "bad_request",
      message: `order must be one of: ${LIST_ORDERS.join(", ")}`,
    };
  }
  return { ok: true, value: raw };
}

/**
 * Validate + NORMALIZE the `updated_since` window (migration 0017) into the
 * exact shape `documents.updated_at` is stored in.
 *
 * Normalization is load-bearing, not politeness: the comparison in SQL is a
 * plain lexicographic `>=` against a TEXT column, which is only equivalent to a
 * chronological comparison when both sides are the same zero-padded UTC
 * `YYYY-MM-DDTHH:MM:SS.sssZ` shape D1's `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
 * produces. `Date.parse` accepts the useful spellings an agent will actually
 * send (a bare `2026-07-01` date, a `…Z` instant, a `+12:00` offset) and
 * `toISOString()` re-emits exactly that canonical shape — so an offset stamp is
 * converted to UTC rather than compared as text and quietly matching the wrong
 * window.
 *
 * Absent/empty → no window. An unparseable value is rejected (`bad_request`)
 * rather than dropped: a change feed that silently ignored its window would
 * return the whole corpus and look like "everything changed."
 */
function parseUpdatedSince(
  raw: string | null,
): { ok: true; value: string | null } | { ok: false; code: "bad_request"; message: string } {
  if (raw === null || raw === "") return { ok: true, value: null };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      code: "bad_request",
      message:
        "updated_since must be an ISO-8601 timestamp (e.g. 2026-07-01 or 2026-07-01T09:30:00Z)",
    };
  }
  return { ok: true, value: new Date(ms).toISOString() };
}

/**
 * Reject a cursor minted under a different ordering than the one requested.
 *
 * A cursor's `ts` is a value of the column its walk was ordered by, so reading
 * an `updated_at` cursor under the created-at ordering (or vice versa) compares
 * two unrelated timestamps: the page boundary lands somewhere arbitrary and the
 * caller gets a silently skipped or repeated slice of the corpus with no signal
 * anything went wrong. Hard error, per the pagination contract at the top of
 * this file. An absent `order` on the cursor means the created-at default (see
 * the Cursor type) — that's what makes the agents/keys/backfill lists, which
 * mint bare cursors and never take an `order`, keep working untouched.
 */
function cursorOrderMismatch(
  cursor: Cursor,
  requested: ListOrder,
): { ok: false; code: "bad_cursor"; message: string } | null {
  const minted = cursor.order ?? DEFAULT_ORDER;
  if (minted === requested) return null;
  return {
    ok: false,
    code: "bad_cursor",
    message:
      `cursor was minted for order=${minted} but this request asked for order=${requested}; ` +
      `pass order=${minted} to continue that walk, or drop the cursor to restart`,
  };
}

/**
 * Validate a raw `status` filter value against the lifecycle enum (migration
 * 0014). Absent/empty → no filter (null). Validated against the full CHECK set
 * — "archived" is accepted for forward-compat even though nothing sets it in
 * v1 (it just matches zero rows) — so the filter contract won't need a parser
 * change when the reserved state gets wired. Rejects with `bad_status` rather
 * than silently dropping: a typo'd status filter that matched everything would
 * mislead (mirrors the slug filter's reject-not-sanitize rule).
 */
function parseStatusFilter(
  raw: string | null,
): { ok: true; value: DocumentStatus | null } | { ok: false; code: "bad_status"; message: string } {
  if (raw === null || raw === "") return { ok: true, value: null };
  const parsed = DocumentStatusSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_status",
      message: `status filter must be one of: ${DocumentStatusSchema.options.join(", ")}`,
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Validate the `visibility` filter (migration 0011). Absent/empty → no filter.
 * Rejected rather than dropped on an unknown value, same reject-not-sanitize
 * rule as `status`/`order`: a review-queue caller that asked for `public` and
 * silently got the whole corpus back would read every private draft as
 * something readers can see.
 */
function parseVisibilityFilter(
  raw: string | null,
): { ok: true; value: Visibility | null } | { ok: false; code: "bad_request"; message: string } {
  if (raw === null || raw === "") return { ok: true, value: null };
  const parsed = VisibilitySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_request",
      message: `visibility must be one of: ${VisibilitySchema.options.join(", ")}`,
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Validate the `publication` filter (migration 0018) — see PUBLICATION_FILTERS
 * for what the two values mean and why both exclude revoked rows. Absent/empty
 * → no filter; an unknown value is rejected, not dropped (dropping it would turn
 * "show me what's awaiting promotion" into "show me everything", which reads as
 * a corpus-sized review queue).
 */
function parsePublicationFilter(
  raw: string | null,
):
  | { ok: true; value: PublicationFilter | null }
  | { ok: false; code: "bad_request"; message: string } {
  if (raw === null || raw === "") return { ok: true, value: null };
  if (!isPublicationFilter(raw)) {
    return {
      ok: false,
      code: "bad_request",
      message: `publication must be one of: ${PUBLICATION_FILTERS.join(", ")}`,
    };
  }
  return { ok: true, value: raw };
}

function isPublicationFilter(v: unknown): v is PublicationFilter {
  return typeof v === "string" && (PUBLICATION_FILTERS as readonly string[]).includes(v);
}

/**
 * Translate a SlugReject code into the same one-line message the write path
 * uses, scoped to a filter rather than a stored value. Centralized here so
 * both transports get identical wording.
 */
function slugRejectMessage(reason: SlugReject): string {
  switch (reason) {
    case "empty":
      // Unreachable in this file — parseHttpListParams/parseMcpListArgs both
      // treat "" as no-filter and skip validateSlugInput. Defensive only.
      return "slug filter must be non-empty";
    case "too_long":
      return "slug filter exceeds 64 characters";
    case "bad_charset":
      return "slug filter may only contain lowercase letters, digits, '-', '_'";
    case "must_start_alnum":
      return "slug filter must start with a lowercase letter or digit";
    case "must_end_alnum":
      return "slug filter must end with a lowercase letter or digit";
  }
}

/**
 * Drain a peeked result set (limit+1 rows) into a page + next_cursor pair.
 *
 * Callers issue `LIMIT ?+1` with the cursor predicate; this helper handles
 * the "did we get a peek row?" → next_cursor decision in one place so the
 * three list endpoints don't each reinvent it.
 *
 * `cursorFromRow` extracts the (ts, id) pair from whatever row shape the
 * endpoint uses — the cursor field names don't have to be `created_at` /
 * `id` literally (e.g. on a joined query the alias might differ). It is also
 * where an ordering-aware list stamps `order` onto the cursor it mints, so the
 * discriminator is written by the same code that chose the `ts` column.
 */
export function paginate<TRow, TOut>(
  rows: TRow[],
  limit: number,
  project: (row: TRow) => TOut,
  cursorFromRow: (row: TRow) => Cursor,
): { items: TOut[]; next_cursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const next_cursor = hasMore && last ? encodeCursor(cursorFromRow(last)) : null;
  return { items: page.map(project), next_cursor };
}
