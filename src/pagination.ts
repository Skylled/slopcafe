/**
 * Cursor-based pagination shared by the four list endpoints:
 *   GET /admin/agents
 *   GET /admin/agents/:id/keys
 *   GET /admin/documents
 *   MCP list_documents
 *
 * Why cursors (not offset/limit): every list is ORDER BY created_at DESC.
 * Offset pagination would skip or duplicate rows when items are inserted or
 * revoked between pages. A cursor encoding the last row's (created_at, id)
 * is stable across writes — the worst it does on a concurrent insert is
 * fail to surface the new row in this page; the caller sees it on the next
 * top-of-list walk.
 *
 * Cursor shape: base64url(JSON({ ts, id })). It's deliberately opaque to
 * callers — they round-trip the string verbatim and never parse it. Using
 * JSON inside means we can extend the cursor (add a sort-field discriminator,
 * say) without a versioning dance, and a stray cursor from a different
 * endpoint just fails the decode and 400s.
 *
 * Tie-breaker: `id` after `created_at`. UUIDs (agents, agent_keys, documents)
 * compare lexicographically as text and are unique, so the (ts, id) pair is
 * a strict total order — no duplicates on tied timestamps.
 *
 * SQL pattern: we use the boolean rewrite
 *   WHERE created_at < ? OR (created_at = ? AND id < ?)
 * rather than the SQL row-value form `(created_at, id) < (?, ?)`. Both work
 * in recent SQLite, but the rewrite is portable to older planners and reads
 * the same to anyone scanning the query.
 *
 * Filter inputs (`tags`, `slug`) are parsed here too. They're list-shaped on
 * the wire — `?tag=foo&tag=bar` over HTTP, `tags: ["foo","bar"]` over MCP —
 * and consumed by listDocumentsCore only (the agent-keys and agents lists
 * don't carry tags or slugs). Defining them here keeps the parse/validate
 * surface in one place; lists that don't use the filters just ignore the
 * fields.
 */

import {
  sanitizeTagsInput,
  type SlugReject,
  validateSlugInput,
} from "./metadata.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** The decoded shape; callers should never inspect or construct this directly. */
export type Cursor = { ts: string; id: string };

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
  tags: string[];
  slug: string | null;
};

export type ParsedListParams =
  | ({ ok: true } & ListParams)
  | { ok: false; code: "bad_limit"; message: string }
  | { ok: false; code: "bad_cursor"; message: string }
  | { ok: false; code: "bad_slug"; message: string };

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
      return { ts: obj.ts, id: obj.id };
    }
  } catch {
    /* fall through */
  }
  return null;
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
  const cursorRaw = url.searchParams.get("cursor");
  let cursor: Cursor | null = null;
  if (cursorRaw !== null && cursorRaw !== "") {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      return { ok: false, code: "bad_cursor", message: "invalid cursor" };
    }
  }

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

  return { ok: true, limit, cursor, tags, slug };
}

/**
 * Parse MCP tool args of the shape `{ limit?, cursor?, tags?, slug? }`.
 * Same semantics as parseHttpListParams; tools surface the message via
 * textError on failure. MCP takes tags as an array (the natural JSON-RPC
 * shape) rather than as repeated keys.
 */
export function parseMcpListArgs(args: {
  limit?: number;
  cursor?: string;
  tags?: string[];
  slug?: string;
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
  let cursor: Cursor | null = null;
  if (args.cursor !== undefined && args.cursor !== "") {
    cursor = decodeCursor(args.cursor);
    if (!cursor) {
      return { ok: false, code: "bad_cursor", message: "invalid cursor" };
    }
  }

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

  return { ok: true, limit, cursor, tags, slug };
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
 * `id` literally (e.g. on a joined query the alias might differ).
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
