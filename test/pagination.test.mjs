// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/pagination.ts — cursor encode/decode round-trip, HTTP and
// MCP arg parsers (limit bounds + cursor validity), and the paginate() peek
// helper.
//
// Same Node-strip-types harness as test/metadata.test.mjs, same pass/FAIL
// shape so `npm test` stays one log to scan.

import {
  DEFAULT_LIMIT,
  decodeCursor,
  encodeCursor,
  MAX_LIMIT,
  paginate,
  parseHttpListParams,
  parseMcpListArgs,
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
  // No-filter omits — both tags and slug default cleanly.
  const p = parseMcpListArgs({ limit: 10 });
  check("mcp: filters default when omitted", p.ok && p.tags.length === 0 && p.slug === null, true);
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

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall pagination tests passed");
}
