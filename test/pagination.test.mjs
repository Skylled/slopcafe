// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/pagination.ts — cursor encode/decode round-trip, HTTP and
// MCP arg parsers (limit bounds + cursor validity + the migration-0017
// order/updated_since knobs), and the paginate() peek helper.
//
// Same Node-strip-types harness as test/metadata.test.mjs, same pass/FAIL
// shape so `npm test` stays one log to scan.

import {
  DEFAULT_LIMIT,
  DEFAULT_ORDER,
  decodeCursor,
  encodeCursor,
  LIST_ORDERS,
  MAX_LIMIT,
  paginate,
  parseHttpListParams,
  parseMcpListArgs,
  PUBLICATION_FILTERS,
} from "../src/pagination.ts";

let fails = 0;

function check(label, got, want) {
  const okEq =
    Array.isArray(want) && Array.isArray(got)
      ? want.length === got.length && want.every((v, i) => v === got[i])
      : got === want;
  console.log(`${okEq ? "ok  " : "FAIL"} ${label}`);
  if (!okEq) {
    console.log(`  want: ${JSON.stringify(want)}`);
    console.log(`  got:  ${JSON.stringify(got)}`);
    fails++;
  }
}

// ----- encodeCursor / decodeCursor ------------------------------------------

{
  const c = { ts: "2025-01-02T03:04:05.678Z", id: "11111111-2222-3333-4444-555555555555" };
  const round = decodeCursor(encodeCursor(c));
  check("cursor: round-trips ts", round?.ts, c.ts);
  check("cursor: round-trips id", round?.id, c.id);
}

check("cursor: rejects empty string", decodeCursor(""), null);
check("cursor: rejects garbage", decodeCursor("!!not-base64!!"), null);
check("cursor: rejects valid b64 of non-JSON", decodeCursor(btoa("not json")), null);
check(
  "cursor: rejects b64 of wrong-shape JSON",
  decodeCursor(btoa(JSON.stringify({ ts: "x" }))),
  null,
);
check(
  "cursor: rejects b64 of non-string fields",
  decodeCursor(btoa(JSON.stringify({ ts: 1, id: 2 }))),
  null,
);

// ----- cursor: the migration-0017 ordering discriminator ---------------------

{
  // A cursor minted by an ordering-aware list round-trips its `order`.
  const c = { ts: "2026-07-01T00:00:00.000Z", id: "doc-a", order: "updated" };
  const round = decodeCursor(encodeCursor(c));
  check("cursor: round-trips order", round?.order, "updated");
}

{
  // A bare (ts, id) cursor — what the agents/keys/backfill lists mint — decodes
  // with no order at all. Absent means the created-at default; the parsers turn
  // that into the compatibility that keeps those lists untouched.
  const round = decodeCursor(encodeCursor({ ts: "t", id: "i" }));
  check("cursor: bare cursor has no order field", round?.order, undefined);
}

check(
  "cursor: rejects an unknown order (never silently defaulted)",
  decodeCursor(btoa(JSON.stringify({ ts: "t", id: "i", order: "relevance" }))),
  null,
);

check(
  "cursor: rejects a non-string order",
  decodeCursor(btoa(JSON.stringify({ ts: "t", id: "i", order: 1 }))),
  null,
);

// Base64url alphabet check: encodeCursor should never emit + / =.
{
  // Compose a value that would emit + / = in plain base64 (high bytes / padding).
  const c = { ts: "ÿþý", id: "x" };
  const s = encodeCursor(c);
  const offending = /[+/=]/.test(s);
  check("cursor: base64url alphabet (no + / =)", offending, false);
}

// ----- parseHttpListParams --------------------------------------------------

{
  const p = parseHttpListParams(new URL("https://x/list"));
  check("http: defaults ok", p.ok, true);
  if (p.ok) {
    check("http: default limit", p.limit, DEFAULT_LIMIT);
    check("http: default cursor", p.cursor, null);
    check("http: default tags empty", p.tags, []);
    check("http: default slug null", p.slug, null);
  }
}

{
  const p = parseHttpListParams(new URL("https://x/list?limit=10"));
  check("http: explicit limit ok", p.ok && p.limit === 10, true);
}

{
  const p = parseHttpListParams(new URL(`https://x/list?limit=${MAX_LIMIT}`));
  check("http: max limit ok", p.ok && p.limit === MAX_LIMIT, true);
}

{
  const p = parseHttpListParams(new URL(`https://x/list?limit=${MAX_LIMIT + 1}`));
  check("http: over-max limit rejected", !p.ok && p.code === "bad_limit", true);
}

check(
  "http: zero limit rejected",
  (() => {
    const p = parseHttpListParams(new URL("https://x/list?limit=0"));
    return !p.ok && p.code === "bad_limit";
  })(),
  true,
);

check(
  "http: negative limit rejected",
  (() => {
    const p = parseHttpListParams(new URL("https://x/list?limit=-1"));
    return !p.ok && p.code === "bad_limit";
  })(),
  true,
);

check(
  "http: non-integer limit rejected",
  (() => {
    const p = parseHttpListParams(new URL("https://x/list?limit=1.5"));
    return !p.ok && p.code === "bad_limit";
  })(),
  true,
);

check(
  "http: non-numeric limit rejected",
  (() => {
    const p = parseHttpListParams(new URL("https://x/list?limit=banana"));
    return !p.ok && p.code === "bad_limit";
  })(),
  true,
);

check(
  "http: empty limit param falls back to default",
  (() => {
    const p = parseHttpListParams(new URL("https://x/list?limit="));
    return p.ok && p.limit === DEFAULT_LIMIT;
  })(),
  true,
);

{
  const c = encodeCursor({ ts: "2025-01-01T00:00:00.000Z", id: "abc" });
  const p = parseHttpListParams(new URL(`https://x/list?cursor=${c}`));
  check("http: valid cursor decoded", p.ok && p.cursor?.id === "abc", true);
}

check(
  "http: bad cursor rejected",
  (() => {
    const p = parseHttpListParams(new URL("https://x/list?cursor=garbage!!"));
    return !p.ok && p.code === "bad_cursor";
  })(),
  true,
);

// ----- parseHttpListParams: tag + slug filters ------------------------------

{
  // Repeated ?tag= → AND list (semantics applied downstream in core, this
  // just collects them).
  const p = parseHttpListParams(new URL("https://x/list?tag=foo&tag=bar"));
  check("http: repeated tag params collected", p.ok ? p.tags : null, ["foo", "bar"]);
}

{
  // Comma-separated alternative spelling — same outcome.
  const p = parseHttpListParams(new URL("https://x/list?tag=foo,bar"));
  check("http: comma-separated tags collected", p.ok ? p.tags : null, ["foo", "bar"]);
}

{
  // Repeated AND comma — flattened together, deduped.
  const p = parseHttpListParams(new URL("https://x/list?tag=foo,bar&tag=baz&tag=foo"));
  check("http: mixed forms deduped", p.ok ? p.tags : null, ["foo", "bar", "baz"]);
}

{
  // Invalid charset is SILENTLY stripped (matches write-time behavior).
  // `foo!bar` → `foobar`; the filter still runs against the sanitized form.
  const p = parseHttpListParams(new URL("https://x/list?tag=foo!bar"));
  check("http: invalid charset sanitized", p.ok ? p.tags : null, ["foobar"]);
}

{
  // Empty tag (or only-invalid) drops the filter entirely.
  const p = parseHttpListParams(new URL("https://x/list?tag=&tag=!!"));
  check("http: empties/all-invalid drop to []", p.ok ? p.tags : null, []);
}

{
  const p = parseHttpListParams(new URL("https://x/list?slug=my-doc"));
  check("http: valid slug captured", p.ok && p.slug === "my-doc", true);
}

{
  // Case + whitespace are normalized (validateSlugInput lowercases + trims).
  const p = parseHttpListParams(new URL("https://x/list?slug=%20My-Slug%20"));
  check("http: slug lowercased + trimmed", p.ok && p.slug === "my-slug", true);
}

{
  // Empty slug = no filter (not an error — stripped form field is a common cause).
  const p = parseHttpListParams(new URL("https://x/list?slug="));
  check("http: empty slug → no filter", p.ok && p.slug === null, true);
}

{
  // Uppercase that doesn't normalize cleanly (starts with hyphen after lowercase)
  // → bad_slug error.
  const p = parseHttpListParams(new URL("https://x/list?slug=-bad"));
  check("http: leading-hyphen slug rejected", !p.ok && p.code === "bad_slug", true);
}

{
  const p = parseHttpListParams(new URL("https://x/list?slug=foo bar"));
  check("http: space in slug rejected", !p.ok && p.code === "bad_slug", true);
}

// ----- parseHttpListParams: status filter (migration 0014) -------------------

{
  const p = parseHttpListParams(new URL("https://x/list?status=deprecated"));
  check("http: valid status captured", p.ok && p.status === "deprecated", true);
}

{
  // Absent / empty → no filter (deprecated docs included by default).
  const p = parseHttpListParams(new URL("https://x/list"));
  check("http: omitted status → no filter", p.ok && p.status === null, true);
  const q = parseHttpListParams(new URL("https://x/list?status="));
  check("http: empty status → no filter", q.ok && q.status === null, true);
}

{
  // Reject-not-sanitize: a typo'd status that silently matched everything
  // would mislead (same rule as the slug filter).
  const p = parseHttpListParams(new URL("https://x/list?status=draft"));
  check("http: unknown status rejected", !p.ok && p.code === "bad_status", true);
}

{
  // "archived" is accepted by the parser (forward-compat with the reserved
  // CHECK state) even though nothing sets it in v1 — it just matches no rows.
  const p = parseHttpListParams(new URL("https://x/list?status=archived"));
  check("http: archived accepted (reserved state)", p.ok && p.status === "archived", true);
}

// ----- parseHttpListParams: visibility + publication filters (0011 + 0018) ---
//
// Together these two are the operator's REVIEW QUEUE in one request
// (`?visibility=public&publication=pending`) — the alternative was paging the
// whole corpus and comparing published_ver to current_ver client-side.

check("publication: exactly two values", PUBLICATION_FILTERS.join(","), "pending,current");

{
  const p = parseHttpListParams(new URL("https://x/list?visibility=public"));
  check("http: valid visibility captured", p.ok && p.visibility === "public", true);
  const q = parseHttpListParams(new URL("https://x/list?visibility=private"));
  check("http: private visibility captured", q.ok && q.visibility === "private", true);
}

{
  const p = parseHttpListParams(new URL("https://x/list"));
  check("http: omitted visibility → no filter", p.ok && p.visibility === null, true);
  const q = parseHttpListParams(new URL("https://x/list?visibility="));
  check("http: empty visibility → no filter", q.ok && q.visibility === null, true);
}

{
  // Reject-not-sanitize, and the reason is sharper here than for tags: a
  // dropped `visibility=public` returns the private drafts too, and a review
  // queue that lists them reads as "the world can see these."
  const p = parseHttpListParams(new URL("https://x/list?visibility=world"));
  check(
    "http: unknown visibility rejected",
    !p.ok && p.code === "bad_request",
    true,
  );
}

{
  const p = parseHttpListParams(new URL("https://x/list?publication=pending"));
  check("http: pending publication captured", p.ok && p.publication === "pending", true);
  const q = parseHttpListParams(new URL("https://x/list?publication=current"));
  check("http: current publication captured", q.ok && q.publication === "current", true);
}

{
  const p = parseHttpListParams(new URL("https://x/list"));
  check("http: omitted publication → no filter", p.ok && p.publication === null, true);
  const q = parseHttpListParams(new URL("https://x/list?publication="));
  check("http: empty publication → no filter", q.ok && q.publication === null, true);
}

{
  // `stale` is the obvious near-miss spelling; dropping it would return the
  // whole corpus as "awaiting promotion".
  const p = parseHttpListParams(new URL("https://x/list?publication=stale"));
  check("http: unknown publication rejected", !p.ok && p.code === "bad_request", true);
}

{
  // The review-queue call itself: both filters, composed, alongside the others.
  const p = parseHttpListParams(
    new URL("https://x/list?visibility=public&publication=pending&order=updated&limit=200"),
  );
  check(
    "http: review-queue params compose",
    p.ok &&
      p.visibility === "public" &&
      p.publication === "pending" &&
      p.order === "updated" &&
      p.limit === 200,
    true,
  );
}

// ----- parseHttpListParams: order + updated_since (migration 0017) -----------

check("order: exactly two orderings", LIST_ORDERS.join(","), "created,updated");
check("order: default is created", DEFAULT_ORDER, "created");

{
  const p = parseHttpListParams(new URL("https://x/list"));
  check("http: omitted order → created", p.ok && p.order === "created", true);
  const q = parseHttpListParams(new URL("https://x/list?order="));
  check("http: empty order → created", q.ok && q.order === "created", true);
}

{
  const p = parseHttpListParams(new URL("https://x/list?order=updated"));
  check("http: order=updated captured", p.ok && p.order === "updated", true);
}

{
  // Reject-not-fall-back: silently walking created_at when the caller asked for
  // the change feed returns plausible rows in the wrong order.
  const p = parseHttpListParams(new URL("https://x/list?order=modified"));
  check("http: unknown order rejected", !p.ok && p.code === "bad_request", true);
}

{
  const p = parseHttpListParams(new URL("https://x/list"));
  check("http: omitted updated_since → no window", p.ok && p.updatedSince === null, true);
  const q = parseHttpListParams(new URL("https://x/list?updated_since="));
  check("http: empty updated_since → no window", q.ok && q.updatedSince === null, true);
}

{
  // Normalization is what makes the lexicographic `>=` in SQL a chronological
  // compare: a bare date becomes UTC midnight in the stored millisecond shape.
  const p = parseHttpListParams(new URL("https://x/list?updated_since=2026-07-01"));
  check("http: date-only updated_since normalized", p.ok ? p.updatedSince : null,
    "2026-07-01T00:00:00.000Z");
}

{
  const p = parseHttpListParams(
    new URL("https://x/list?updated_since=2026-07-01T09%3A30%3A00Z"),
  );
  check("http: second-precision updated_since gains .000", p.ok ? p.updatedSince : null,
    "2026-07-01T09:30:00.000Z");
}

{
  // An offset-bearing stamp is CONVERTED to UTC, not compared as text — text
  // comparison would silently window the wrong 12 hours.
  const p = parseHttpListParams(
    new URL("https://x/list?updated_since=2026-07-01T12%3A00%3A00%2B12%3A00"),
  );
  check("http: offset updated_since converted to UTC", p.ok ? p.updatedSince : null,
    "2026-07-01T00:00:00.000Z");
}

{
  const p = parseHttpListParams(new URL("https://x/list?updated_since=last-tuesday"));
  check("http: unparseable updated_since rejected", !p.ok && p.code === "bad_request", true);
}

// ----- cursor/order mismatch is a HARD error, never a mis-read page ----------

{
  // The compatibility case: a bare cursor (agents/keys/backfill lists) under the
  // default ordering is fine — that's what keeps those lists untouched by 0017.
  const c = encodeCursor({ ts: "2026-01-01T00:00:00.000Z", id: "a" });
  const p = parseHttpListParams(new URL(`https://x/list?cursor=${c}`));
  check("http: bare cursor ok under default order", p.ok && p.cursor?.id === "a", true);
}

{
  // Bare cursor (= created) but the caller asked for the change feed: its `ts`
  // is a created_at value, so reading it against updated_at would land the page
  // boundary somewhere arbitrary. Hard error.
  const c = encodeCursor({ ts: "2026-01-01T00:00:00.000Z", id: "a" });
  const p = parseHttpListParams(new URL(`https://x/list?cursor=${c}&order=updated`));
  check("http: created cursor under order=updated rejected", !p.ok && p.code === "bad_cursor", true);
}

{
  // ...and the reverse: an updated cursor replayed under the default ordering.
  const c = encodeCursor({ ts: "2026-01-01T00:00:00.000Z", id: "a", order: "updated" });
  const p = parseHttpListParams(new URL(`https://x/list?cursor=${c}`));
  check("http: updated cursor under default order rejected", !p.ok && p.code === "bad_cursor", true);
}

{
  // Matching pair walks normally.
  const c = encodeCursor({ ts: "2026-01-01T00:00:00.000Z", id: "a", order: "updated" });
  const p = parseHttpListParams(new URL(`https://x/list?cursor=${c}&order=updated`));
  check("http: matching cursor+order accepted", p.ok && p.cursor?.order === "updated", true);
}

{
  // The mismatch message has to say how to recover, not just refuse.
  const c = encodeCursor({ ts: "t", id: "a", order: "updated" });
  const p = parseHttpListParams(new URL(`https://x/list?cursor=${c}`));
  check("http: mismatch message names the minting order", !p.ok && p.message.includes("order=updated"), true);
}

// ----- parseMcpListArgs -----------------------------------------------------

{
  const p = parseMcpListArgs({});
  check("mcp: empty args ok", p.ok && p.limit === DEFAULT_LIMIT && p.cursor === null, true);
}

{
  const p = parseMcpListArgs({ limit: 25 });
  check("mcp: explicit limit", p.ok && p.limit === 25, true);
}

{
  const p = parseMcpListArgs({ limit: MAX_LIMIT + 1 });
  check("mcp: over-max limit rejected", !p.ok && p.code === "bad_limit", true);
}

{
  const p = parseMcpListArgs({ limit: 0 });
  check("mcp: zero limit rejected", !p.ok && p.code === "bad_limit", true);
}

{
  const p = parseMcpListArgs({ cursor: "garbage!!" });
  check("mcp: bad cursor rejected", !p.ok && p.code === "bad_cursor", true);
}

{
  // Empty-string cursor is tolerated as "no cursor" — matches HTTP behavior
  // where a stripped form field could yield ?cursor= rather than dropping it.
  const p = parseMcpListArgs({ cursor: "" });
  check("mcp: empty cursor → no cursor", p.ok && p.cursor === null, true);
}

// ----- parseMcpListArgs: tag + slug filters ---------------------------------

{
  const p = parseMcpListArgs({ tags: ["foo", "bar"] });
  check("mcp: tags array captured", p.ok ? p.tags : null, ["foo", "bar"]);
}

{
  // sanitizeTagsInput silently strips invalid chars, matching write semantics.
  const p = parseMcpListArgs({ tags: ["foo!", "bar_baz"] });
  check("mcp: invalid-char tags sanitized", p.ok ? p.tags : null, ["foo", "bar_baz"]);
}

{
  // Non-array tags → empty (defensive against badly-typed JSON-RPC input).
  // We bypass the TypeScript boundary with an explicit cast in JS.
  const p = parseMcpListArgs({ tags: "not-an-array" });
  check("mcp: non-array tags defaulted to []", p.ok ? p.tags : null, []);
}

{
  const p = parseMcpListArgs({ slug: "my-doc" });
  check("mcp: valid slug captured", p.ok && p.slug === "my-doc", true);
}

{
  // Empty slug = no filter (parity with HTTP empty form field).
  const p = parseMcpListArgs({ slug: "" });
  check("mcp: empty slug → no filter", p.ok && p.slug === null, true);
}

{
  const p = parseMcpListArgs({ slug: "Bad Slug" });
  check("mcp: bad-charset slug rejected", !p.ok && p.code === "bad_slug", true);
}

{
  // No-filter omits — tags, slug, and status all default cleanly.
  const p = parseMcpListArgs({ limit: 10 });
  check(
    "mcp: filters default when omitted",
    p.ok && p.tags.length === 0 && p.slug === null && p.status === null,
    true,
  );
}

{
  const p = parseMcpListArgs({ status: "active" });
  check("mcp: valid status captured", p.ok && p.status === "active", true);
}

{
  const p = parseMcpListArgs({ status: "draft" });
  check("mcp: unknown status rejected", !p.ok && p.code === "bad_status", true);
}

// ----- parseMcpListArgs: visibility + publication filters (0011 + 0018) ------

{
  const p = parseMcpListArgs({ visibility: "public", publication: "pending" });
  check(
    "mcp: review-queue filters captured",
    p.ok && p.visibility === "public" && p.publication === "pending",
    true,
  );
}

{
  const p = parseMcpListArgs({});
  check(
    "mcp: omitted visibility/publication → no filter",
    p.ok && p.visibility === null && p.publication === null,
    true,
  );
}

{
  const p = parseMcpListArgs({ visibility: "world" });
  check("mcp: unknown visibility rejected", !p.ok && p.code === "bad_request", true);
}

{
  const p = parseMcpListArgs({ publication: "stale" });
  check("mcp: unknown publication rejected", !p.ok && p.code === "bad_request", true);
}

// ----- parseMcpListArgs: order + updated_since (migration 0017) --------------

{
  const p = parseMcpListArgs({});
  check("mcp: omitted order → created", p.ok && p.order === "created", true);
  check("mcp: omitted updated_since → no window", p.ok && p.updatedSince === null, true);
}

{
  const p = parseMcpListArgs({ order: "updated" });
  check("mcp: order=updated captured", p.ok && p.order === "updated", true);
}

{
  const p = parseMcpListArgs({ order: "relevance" });
  check("mcp: unknown order rejected", !p.ok && p.code === "bad_request", true);
}

{
  // MCP keeps the wire spelling (snake_case) on the way in.
  const p = parseMcpListArgs({ updated_since: "2026-07-01" });
  check("mcp: updated_since normalized", p.ok ? p.updatedSince : null, "2026-07-01T00:00:00.000Z");
}

{
  const p = parseMcpListArgs({ updated_since: "whenever" });
  check("mcp: unparseable updated_since rejected", !p.ok && p.code === "bad_request", true);
}

{
  const c = encodeCursor({ ts: "2026-01-01T00:00:00.000Z", id: "a", order: "updated" });
  const p = parseMcpListArgs({ cursor: c });
  check("mcp: updated cursor under default order rejected", !p.ok && p.code === "bad_cursor", true);
  const q = parseMcpListArgs({ cursor: c, order: "updated" });
  check("mcp: matching cursor+order accepted", q.ok && q.cursor?.order === "updated", true);
}

// ----- paginate() peek helper -----------------------------------------------

{
  // Less than limit → no next_cursor.
  const rows = [
    { created_at: "t3", id: "c", payload: 3 },
    { created_at: "t2", id: "b", payload: 2 },
  ];
  const { items, next_cursor } = paginate(
    rows,
    5,
    (r) => r.payload,
    (r) => ({ ts: r.created_at, id: r.id }),
  );
  check("paginate: short page items", items, [3, 2]);
  check("paginate: short page next_cursor", next_cursor, null);
}

{
  // Exactly limit rows (no peek row hit) → no next_cursor.
  const rows = [
    { created_at: "t3", id: "c", payload: 3 },
    { created_at: "t2", id: "b", payload: 2 },
  ];
  const { items, next_cursor } = paginate(
    rows,
    2,
    (r) => r.payload,
    (r) => ({ ts: r.created_at, id: r.id }),
  );
  check("paginate: exact-fit items", items, [3, 2]);
  check("paginate: exact-fit next_cursor", next_cursor, null);
}

{
  // Limit+1 rows (peek hit) → next_cursor encodes the LAST IN-PAGE row, not
  // the peek row. Walking forward from that cursor should start with the
  // first row we trimmed off.
  const rows = [
    { created_at: "t3", id: "c", payload: 3 },
    { created_at: "t2", id: "b", payload: 2 },
    { created_at: "t1", id: "a", payload: 1 },
  ];
  const { items, next_cursor } = paginate(
    rows,
    2,
    (r) => r.payload,
    (r) => ({ ts: r.created_at, id: r.id }),
  );
  check("paginate: peek-hit items (only limit rows)", items, [3, 2]);
  const decoded = next_cursor ? decodeCursor(next_cursor) : null;
  check("paginate: cursor.ts = last in-page", decoded?.ts, "t2");
  check("paginate: cursor.id = last in-page", decoded?.id, "b");
}

// ----- order=updated: a full walk across a timestamp collision ---------------
//
// The boundary case the mandatory id tiebreaker exists for, on the new axis.
// A retag sweep touches five documents inside one strftime millisecond, so every
// row shares an `updated_at` and the ordering rests ENTIRELY on `id DESC`. We
// walk the whole set two rows at a time, replaying listDocumentsCore's cursor
// predicate — `(ts < ? or (ts = ? and id < ?))` — and its cursorFromRow, and
// assert the walk yields each document exactly once with nothing skipped.
{
  const SAME = "2026-07-24T12:00:00.000Z";
  const corpus = ["e", "d", "c", "b", "a"].map((id) => ({ updated_at: SAME, id }));

  // The SQL ORDER BY, in JS: updated_at DESC, id DESC.
  const sorted = [...corpus].sort((x, y) =>
    x.updated_at === y.updated_at
      ? y.id.localeCompare(x.id)
      : y.updated_at.localeCompare(x.updated_at),
  );

  const after = (cur) =>
    cur === null
      ? sorted
      : sorted.filter(
          (r) =>
            r.updated_at < cur.ts || (r.updated_at === cur.ts && r.id < cur.id),
        );

  const limit = 2;
  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    // `LIMIT ?+1` peek, exactly as core issues it.
    const rows = after(cursor).slice(0, limit + 1);
    const page = paginate(
      rows,
      limit,
      (r) => r.id,
      (r) => ({ ts: r.updated_at, id: r.id, order: "updated" }),
    );
    seen.push(...page.items);
    pages++;
    if (!page.next_cursor || pages > 10) break;
    cursor = decodeCursor(page.next_cursor);
    check("paginate/updated: each cursor carries its ordering", cursor?.order, "updated");
  }

  check("paginate/updated: walk covers the corpus once, in order", seen, ["e", "d", "c", "b", "a"]);
  check("paginate/updated: no duplicates across pages", new Set(seen).size, 5);
  check("paginate/updated: terminated on its own (no runaway)", pages, 3);
}

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall pagination tests passed");
}
