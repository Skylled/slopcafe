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
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** The decoded shape; callers should never inspect or construct this directly. */
export type Cursor = { ts: string; id: string };

/**
 * What list-core functions consume — already validated, no `ok` discriminant.
 * The parsers below return a `{ ok: true } & ListParams` variant so the call
 * site can narrow, then pass the validated shape to core.
 */
export type ListParams = {
  limit: number;
  cursor: Cursor | null;
};

export type ParsedListParams =
  | ({ ok: true } & ListParams)
  | { ok: false; code: "bad_limit"; message: string }
  | { ok: false; code: "bad_cursor"; message: string };

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
 * Parse `?limit=N&cursor=<opaque>` from a request URL. Returns ListParams on
 * success or a typed error the HTTP wrapper can convert to a 400 JSON body.
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
  return { ok: true, limit, cursor };
}

/**
 * Parse MCP tool args of the shape `{ limit?, cursor? }`. Same semantics as
 * parseHttpListParams; tools surface the message via textError on failure.
 */
export function parseMcpListArgs(args: {
  limit?: number;
  cursor?: string;
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
  return { ok: true, limit, cursor };
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
