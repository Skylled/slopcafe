// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for the Insight "browse by app" surface (agent-web-host-insight fork,
// sketches #4 + #6, migration 0019):
//
//   1. corpusStatsCore (src/stats.ts) — the GET /stats aggregation, exercised
//      against a real in-memory SQLite via a small D1 shim. Pins: revoked
//      exclusion, the by_doc_kind full-enum projection, the by_app_package
//      count-DESC ordering + top-N truncation flag, and the auth/visibility
//      DECISION — the aggregate counts PRIVATE docs too (no visibility
//      predicate), which is correct ONLY because the route is authenticated.
//   2. The list/search FILTER predicates — that `d.app_package = ?` /
//      `d.doc_kind = ?` / `d.company = ?` narrow and COMPOSE with tags +
//      visibility, run against real SQLite, plus a TEXT scan that core.ts wires
//      the shared helper into all three legs (list + both search legs).
//   3. The route auth/visibility GUARD, pinned as source scans: documentStats
//      is requireReader-gated (never anonymous), and corpusStatsCore carries the
//      revoked filter but NO visibility filter (full-fleet, single-tenant).
//
// corpusStatsCore is importable here because src/stats.ts is deliberately
// sanitizer-free (unlike core.ts, which pulls in the WASM sanitizer and cannot
// load under the strip-types runner). The list/search cores CAN'T be imported,
// so their predicates are validated as real SQL + a text scan of the wiring —
// the same technique test/search-ranking.test.mjs and test/authz-surface.test.mjs use.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { corpusStatsCore, STATS_TOP_APP_PACKAGES } from "../src/stats.ts";
import { DOC_KIND_VALUES } from "../src/metadata.ts";

let fails = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) {
    if (detail !== undefined) console.log(`  ${detail}`);
    fails++;
  }
}
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const root = fileURLToPath(new URL("..", import.meta.url));
const CORE = readFileSync(`${root}src/core.ts`, "utf8");
const STATS = readFileSync(`${root}src/stats.ts`, "utf8");
const ADMIN = readFileSync(`${root}src/admin.ts`, "utf8");

// --- a minimal D1 shim over node:sqlite -------------------------------------
// Presents the D1 surface corpusStatsCore uses: prepare(sql) → { bind, all,
// first }. `.all()` returns { results }, `.first()` returns row-or-null. Both
// work with or without a preceding `.bind(...)` (default no args).
function makeD1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      return {
        bind(...a) {
          args = a;
          return this;
        },
        async all() {
          return { results: stmt.all(...args) };
        },
        async first() {
          return stmt.get(...args) ?? null;
        },
      };
    },
  };
}

// A minimal stand-in for the migration-0019 `documents` table — only the columns
// the stats aggregation and the filter predicates touch. (The real table has
// many more; reconstructing the full 0001..0019 chain here would test the
// migrations, not this feature.)
function freshDocsDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    public_id TEXT,
    revoked_at TEXT,
    visibility TEXT,
    tags TEXT,
    app_package TEXT,
    doc_kind TEXT,
    company TEXT
  );`);
  return db;
}
let seq = 0;
function insertDoc(db, { revoked = null, visibility = "public", tags = null, app_package = null, doc_kind = null, company = null } = {}) {
  seq++;
  db.prepare(
    "INSERT INTO documents (id, public_id, revoked_at, visibility, tags, app_package, doc_kind, company) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(`id${seq}`, `pub${seq}`, revoked, visibility, tags, app_package, doc_kind, company);
}

// ============================================================================
// 1. corpusStatsCore — the GET /stats aggregation
// ============================================================================

{
  const db = freshDocsDb();
  // gms: 3 live (1 private) + 1 revoked (excluded). maps: 2 live. null pkg: 1.
  insertDoc(db, { app_package: "com.google.android.gms", doc_kind: "teardown" });
  insertDoc(db, { app_package: "com.google.android.gms", doc_kind: "teardown", visibility: "private" });
  insertDoc(db, { app_package: "com.google.android.gms", doc_kind: "writeup" });
  insertDoc(db, { app_package: "com.google.android.gms", doc_kind: "teardown", revoked: "2026-01-01T00:00:00.000Z" });
  insertDoc(db, { app_package: "com.google.android.apps.maps", doc_kind: "teardown" });
  insertDoc(db, { app_package: "com.google.android.apps.maps", doc_kind: "hypothesis" });
  insertDoc(db, { app_package: null, doc_kind: null }); // a non-Insight doc

  const stats = await corpusStatsCore({ META: makeD1(db) });

  // totals: live rows only (7 inserted − 1 revoked = 6), INCLUDING the private one.
  eq("stats: totals.documents excludes revoked, counts private", stats.totals.documents, 6);

  // by_app_package: count DESC, revoked excluded, NULL app_package excluded.
  eq("stats: by_app_package (count DESC, no revoked, no null pkg)", stats.by_app_package, [
    { app_package: "com.google.android.gms", count: 3 },
    { app_package: "com.google.android.apps.maps", count: 2 },
  ]);
  check("stats: not truncated for a small corpus", stats.by_app_package_truncated === false);

  // by_doc_kind: one entry per DOC_KIND_VALUES, in enum order, 0 where absent.
  eq(
    "stats: by_doc_kind covers the full enum in order",
    stats.by_doc_kind.map((r) => r.doc_kind),
    [...DOC_KIND_VALUES],
  );
  const kindCount = Object.fromEntries(stats.by_doc_kind.map((r) => [r.doc_kind, r.count]));
  // 3 LIVE teardowns (gms, gms-private, maps); the 4th gms teardown is revoked
  // and excluded — so the count is 3, and a naive "4" would mean revoke leaked in.
  eq("stats: teardown count (the revoked teardown is excluded)", kindCount.teardown, 3);
  eq("stats: writeup count", kindCount.writeup, 1);
  eq("stats: hypothesis count", kindCount.hypothesis, 1);
  eq("stats: an unused kind reports 0, not absent", kindCount["kb-feature"], 0);
}

// The auth/visibility decision, behaviorally: a corpus of ONLY private docs
// still reports its full count. That is correct only because GET /stats is
// authenticated (requireReader) — the guard scans below pin that half.
{
  const db = freshDocsDb();
  insertDoc(db, { app_package: "com.x", doc_kind: "teardown", visibility: "private" });
  insertDoc(db, { app_package: "com.x", doc_kind: "teardown", visibility: "private" });
  const stats = await corpusStatsCore({ META: makeD1(db) });
  eq("stats: private-only corpus is fully counted (whole-fleet trust)", stats.totals.documents, 2);
  eq("stats: private docs appear in by_app_package", stats.by_app_package, [{ app_package: "com.x", count: 2 }]);
}

// The top-N cap + truncation flag: STATS_TOP_APP_PACKAGES+1 distinct packages
// trims to the cap and flags it (no silent truncation).
{
  const db = freshDocsDb();
  for (let i = 0; i < STATS_TOP_APP_PACKAGES + 1; i++) {
    insertDoc(db, { app_package: `com.app.p${String(i).padStart(4, "0")}`, doc_kind: "teardown" });
  }
  const stats = await corpusStatsCore({ META: makeD1(db) });
  eq("stats: by_app_package capped to the top-N", stats.by_app_package.length, STATS_TOP_APP_PACKAGES);
  check("stats: truncation flagged, not silent", stats.by_app_package_truncated === true);
}

// Empty corpus → zeros, still a full by_doc_kind enum.
{
  const stats = await corpusStatsCore({ META: makeD1(freshDocsDb()) });
  eq("stats: empty corpus totals 0", stats.totals.documents, 0);
  eq("stats: empty corpus by_app_package []", stats.by_app_package, []);
  eq("stats: empty corpus by_doc_kind still full enum", stats.by_doc_kind.length, DOC_KIND_VALUES.length);
  check("stats: empty corpus not truncated", stats.by_app_package_truncated === false);
}

// ============================================================================
// 2. list/search filter predicates — real SQL narrowing + composition
// ============================================================================

// Pull the REAL predicate strings out of core.ts's appendInsightFilters so this
// behavioral test tracks the shipped SQL (same technique as search-ranking).
const helperMatch = /function appendInsightFilters\([\s\S]*?\n}\n/.exec(CORE);
check("core.ts defines appendInsightFilters", helperMatch !== null);
const helperBody = helperMatch ? helperMatch[0] : "";
const predicates = [...helperBody.matchAll(/clauses\.push\("([^"]+)"\)/g)].map((m) => m[1]);
eq("appendInsightFilters pushes the three column predicates", predicates, [
  "d.app_package = ?",
  "d.doc_kind = ?",
  "d.company = ?",
]);

// The helper is CALLED in all three legs — the list surface and both search legs
// — so a filter can never be silently honored on one path and dropped on another.
function bodyOf(src, sig) {
  const m = new RegExp(`\\n(?:export )?(?:async )?function ${sig}\\b`).exec(src);
  if (!m) return null;
  const start = m.index + 1;
  const end = src.indexOf("\n}\n", start);
  return end === -1 ? src.slice(start) : src.slice(start, end + 2);
}
for (const fn of ["listDocumentsCore", "ftsSearch", "semanticSearch"]) {
  const body = bodyOf(CORE, fn);
  check(`${fn} calls appendInsightFilters`, body !== null && body.includes("appendInsightFilters("));
}

// Behavioral: the predicates narrow and compose with tags + visibility. Build a
// small corpus and run the exact predicate strings core emits.
{
  const db = freshDocsDb();
  const tagJson = (arr) => JSON.stringify(arr);
  // Two gms teardowns (one private, one tagged "flags"), one maps teardown, one
  // gms writeup — enough to prove each predicate narrows and they AND together.
  insertDoc(db, { app_package: "com.gms", doc_kind: "teardown", visibility: "public", tags: tagJson(["flags"]) });
  insertDoc(db, { app_package: "com.gms", doc_kind: "teardown", visibility: "private", tags: tagJson(["other"]) });
  insertDoc(db, { app_package: "com.gms", doc_kind: "writeup", visibility: "public", tags: tagJson(["flags"]) });
  insertDoc(db, { app_package: "com.maps", doc_kind: "teardown", visibility: "public", tags: tagJson(["flags"]) });

  // Alias `documents d`, matching core.ts's `from documents d`, so the extracted
  // `d.<col> = ?` predicates resolve here exactly as they do in production.
  const runWhere = (clauses, binds) =>
    db
      .prepare(`SELECT d.id FROM documents d WHERE ${["d.revoked_at is null", ...clauses].join(" and ")}`)
      .all(...binds)
      .map((r) => r.id);

  // app_package alone: the three com.gms rows.
  eq(
    "filter: app_package narrows to that package",
    runWhere([predicates[0]], ["com.gms"]).length,
    3,
  );
  // app_package + doc_kind: the two com.gms teardowns.
  eq(
    "filter: app_package AND doc_kind compose",
    runWhere([predicates[0], predicates[1]], ["com.gms", "teardown"]).length,
    2,
  );
  // app_package + doc_kind + visibility: the one public com.gms teardown.
  eq(
    "filter: app_package AND doc_kind AND visibility compose",
    runWhere([predicates[0], predicates[1], "d.visibility = ?"], ["com.gms", "teardown", "public"]).length,
    1,
  );
  // app_package + a tag LIKE (the real tags predicate): com.gms rows tagged "flags"
  // = the public teardown + the writeup.
  eq(
    "filter: app_package AND a tag filter compose",
    runWhere([predicates[0], "d.tags like ? escape '\\'"], ["com.gms", '%"flags"%']).length,
    2,
  );
  // company predicate is a plain equality — matches nothing here (no company set),
  // proving the predicate is wired and inert on an unset column (parity case).
  eq("filter: company predicate matches unset column = 0 rows", runWhere([predicates[2]], ["Google"]).length, 0);
}

// ============================================================================
// 3. route auth/visibility guard — pinned as source scans
// ============================================================================

// documentStats is requireReader-gated (operator OR reader OR agent, NEVER
// anonymous). test/authz-surface.test.mjs classifies it too; this is the
// feature-local pin so a regression here fails in the feature's own file.
const statsHandler = bodyOf(ADMIN, "documentStats");
check("admin.documentStats exists", statsHandler !== null);
check(
  "GET /stats is requireReader-gated (never anonymous)",
  statsHandler !== null && statsHandler.includes("requireReader("),
  "documentStats must gate on requireReader before aggregating",
);
check(
  "GET /stats returns corpusStatsCore's aggregate",
  statsHandler !== null && statsHandler.includes("corpusStatsCore(env)"),
);

// corpusStatsCore counts the WHOLE fleet: every aggregate excludes revoked, and
// NONE carries a visibility predicate (single-tenant, authenticated callers see
// everything). That pairing is the correctness landmine — a visibility filter
// here would be wrong for the authenticated route, and dropping revoked-exclusion
// would count tombstones. If an anonymous door is ever added it MUST add a
// visibility filter first; this asserts one isn't silently present/absent today.
check(
  "corpusStatsCore excludes revoked rows from every aggregate",
  (STATS.match(/revoked_at is null/g) ?? []).length >= 3,
  "expected a `revoked_at is null` guard on totals + by_app_package + by_doc_kind",
);
// Scan CODE ONLY (comments stripped): the module's prose legitimately discusses
// visibility, but corpusStatsCore's actual SQL must never reference it —
// counting private docs is correct for an authenticated whole-fleet route, and a
// visibility predicate would silently narrow it. (Behaviorally proven above by
// the private-only corpus test; this is the belt to that suspenders.)
const statsCode = STATS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
check(
  "corpusStatsCore carries NO visibility predicate (whole-fleet, authenticated route)",
  !/visibility/.test(statsCode),
  "a visibility filter here would be wrong for an authenticated whole-fleet aggregate",
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} insight test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall insight tests passed");
}
