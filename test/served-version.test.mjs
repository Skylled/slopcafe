// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/served-version.ts — the rule deciding WHICH version's bytes a
// caller sees (migration 0018 / GitHub issue #43).
//
// This is not a display preference, it is the anonymous-disclosure boundary.
// Before 0018 the render path served whatever was current, so any agent key —
// and under the single-tenant trust model every agent key may write every
// document — could publish private content to the open internet with one
// ordinary authorized PUT, never touching the operator-only visibility flag.
// `servedVersion` returning `current_ver` where it should return `published_ver`
// IS that vulnerability, so the four-line function gets a real test.
//
// Pure function, same Node-strip-types harness as conditional/depth/edit/pack.
// The SQL twin (SERVED_VER_SQL) and the wiring into serveRaw/serveShell/
// serveHomepage/serveBySlug are exercised via wrangler dev (no D1 mock in v1) —
// what is pinned here is the RULE, plus the textual agreement between the two
// encodings so they cannot drift apart silently.

import { SERVED_VER_SQL, servedVersion } from "../src/served-version.ts";

let fails = 0;

function check(label, got, want) {
  const okEq = got === want;
  console.log(`${okEq ? "ok  " : "FAIL"} ${label}`);
  if (!okEq) {
    console.log(`  want: ${JSON.stringify(want)}`);
    console.log(`  got:  ${JSON.stringify(got)}`);
    fails++;
  }
}

function ok(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails++;
}

const doc = (visibility, published_ver, current_ver) => ({
  visibility,
  published_ver,
  current_ver,
});

// ---- the security case -----------------------------------------------------
// A public document with staged (unpromoted) work. If this ever returns 7, an
// agent's newest bytes are live on the anonymous internet and issue #43 is open
// again. This is the single most important assertion in the file.
check("public + staged work serves the PUBLISHED version", servedVersion(doc("public", 5, 7)), 5);

// The same shape at every distance, including the pathological "published is
// ahead of current" state that a restore-then-revert sequence could produce.
check("public, published far behind current", servedVersion(doc("public", 1, 40)), 1);
check("public, published == current (steady state)", servedVersion(doc("public", 3, 3)), 3);
check("public, published AHEAD of current is still honoured", servedVersion(doc("public", 9, 4)), 9);

// ---- the fallback ----------------------------------------------------------
// Null published_ver on a public doc means the birth/flip/backfill invariant was
// broken; the rule degrades to current_ver. That fallback is deliberate (a
// public page must serve SOMETHING rather than 404), which is exactly why
// publishDocumentCore binds published_ver at birth — the fallback must stay
// unreachable in practice, and this test documents the consequence if it isn't.
check("public + nothing published falls back to current", servedVersion(doc("public", null, 4)), 4);

// ---- private always renders current ----------------------------------------
// Private is already the gate: the render path 404s for anonymous callers, so
// there is nobody to protect from fresh bytes, and staging there would make the
// fleet's own write→look→write loop need an operator round-trip per iteration.
check("private serves current, ignoring a stage", servedVersion(doc("private", 2, 8)), 8);
check("private with no stage serves current", servedVersion(doc("private", null, 8)), 8);

// A private document MAY carry a published_ver — promotion is allowed before the
// door opens, and setDocumentVisibilityCore's coalesce is what preserves that
// choice through the flip. Pinned because the natural misreading is that a
// non-null value on a private doc is a broken invariant.
check(
  "a staged private doc, once public, serves the STAGED version",
  servedVersion(doc("public", 2, 8)),
  2,
);

// ---- revoked ---------------------------------------------------------------
// revokeDocumentCore nulls both pointers in the same batch. Callers 404 on
// revoked_at before ever reaching here; null is the honest answer, not 0.
check("revoked (both pointers null) returns null", servedVersion(doc("public", null, null)), null);

// ---- the two encodings must agree ------------------------------------------
// SERVED_VER_SQL is the same rule for callers that issue their own join. It
// cannot be executed here (no D1), so assert the structural properties that
// would break the pairing: it must gate on visibility, prefer published_ver,
// fall back to current_ver, and alias the document table as `d`.
ok("SQL twin gates on public visibility", SERVED_VER_SQL.includes("d.visibility = 'public'"));
ok("SQL twin null-checks published_ver", SERVED_VER_SQL.includes("d.published_ver is not null"));
ok("SQL twin falls back to current_ver", SERVED_VER_SQL.includes("else d.current_ver"));
ok(
  "SQL twin prefers published_ver over current_ver",
  SERVED_VER_SQL.indexOf("then d.published_ver") < SERVED_VER_SQL.indexOf("else d.current_ver"),
);
// Parenthesised so it can be interpolated into a join predicate without the
// surrounding SQL re-associating the CASE.
ok(
  "SQL twin is self-contained (parenthesised)",
  SERVED_VER_SQL.startsWith("(") && SERVED_VER_SQL.endsWith(")"),
);
// No bound parameters: the expression names columns, never caller input. A `?`
// appearing here would mean someone threaded a value through the one place that
// must stay a compile-time constant.
ok("SQL twin binds no parameters", !SERVED_VER_SQL.includes("?"));

if (fails > 0) {
  console.error(`\n${fails} served-version test(s) FAILED`);
  process.exit(1);
}
console.log("\nall served-version tests passed");
