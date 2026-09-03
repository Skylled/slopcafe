// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Regression net for the BM25 column weighting in `ftsSearch` (src/search-core.ts).
//
// WHY THIS EXISTS AND WHY IT'S SHAPED LIKE THIS
// The keyword leg declares `BM25_WEIGHTS = {title: 20, description: 5, body: 1}`
// and interpolates them into a `bm25(documents_fts, …)` call. FTS5 takes ONE
// weight per column OF THE TABLE, in CREATE order, INCLUDING `UNINDEXED` ones —
// so the migration-0012 schema (`document_id UNINDEXED, title, description,
// body`) needs FOUR. Shipping three shifted every weight one column left and
// left the last column on bm25's 1.0 default: description and body scored
// IDENTICALLY. Nothing errored. The only assertion that catches it is a real
// ranking comparison against a real FTS5 index, which is what this file is.
//
// `src/search-core.ts` can't be imported here (it pulls in the WASM sanitizer
// transitively via src/core.ts), so we read the two load-bearing fragments out
// of it as TEXT — the BM25_WEIGHTS object literal and the
// `bm25(documents_fts, …)` argument list — and run the ACTUAL emitted
// expression against a real FTS5 table built from the actual CREATE in
// migrations/0012. Precedent: test/contract.test.mjs already scans src/ as
// text. That means this fails if either the weights or the call drift, not
// merely if this file's copy of them drifts.
//
// Uses node:sqlite (Node ≥22.5, FTS5 compiled in). D1 is SQLite, and bm25 is
// core FTS5 with no D1-specific behavior, so the ranking model is the same one
// production runs.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const searchCoreSrc = readFileSync(`${root}src/search-core.ts`, "utf8");
const migration = readFileSync(`${root}migrations/0012_document_tags.sql`, "utf8");

let fails = 0;

function check(label, cond, detail) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) {
    if (detail !== undefined) console.log(`  ${detail}`);
    fails++;
  }
}

// ----- extract the real weights + the real bm25() call ----------------------

// `const BM25_WEIGHTS = { document_id: 0.0, title: 20.0, … };`
const weightsMatch = /const BM25_WEIGHTS = \{([^}]*)\}/.exec(searchCoreSrc);
if (!weightsMatch) {
  console.log("FAIL could not locate BM25_WEIGHTS in src/search-core.ts");
  process.exit(1);
}
const weights = {};
for (const [, key, value] of weightsMatch[1].matchAll(/(\w+)\s*:\s*([\d.]+)/g)) {
  weights[key] = Number(value);
}

// The emitted score expression, with `${BM25_WEIGHTS.x}` placeholders resolved.
const callMatch = /-bm25\(documents_fts,([^)]*)\)/.exec(searchCoreSrc);
if (!callMatch) {
  console.log("FAIL could not locate the bm25(documents_fts, …) call in src/search-core.ts");
  process.exit(1);
}
const bm25Args = callMatch[1]
  .split(",")
  .map((a) => a.trim())
  .map((a) => {
    const ref = /^\$\{BM25_WEIGHTS\.(\w+)\}$/.exec(a);
    if (ref) {
      if (!(ref[1] in weights)) throw new Error(`bm25() references unknown weight ${ref[1]}`);
      return weights[ref[1]];
    }
    return Number(a);
  });

// The FTS column list, straight out of the migration that created it.
const createMatch = /CREATE VIRTUAL TABLE documents_fts USING fts5\(([\s\S]*?)\);/.exec(migration);
const ftsColumns = createMatch[1]
  .split(",")
  .map((c) => c.trim())
  .filter((c) => c.length > 0 && !c.startsWith("tokenize"))
  .map((c) => c.split(/\s+/)[0]);

// ----- the structural rule --------------------------------------------------

check(
  "one bm25() weight per FTS column (UNINDEXED included)",
  bm25Args.length === ftsColumns.length,
  `columns [${ftsColumns.join(", ")}] (${ftsColumns.length}) vs weights [${bm25Args.join(", ")}] (${bm25Args.length})`,
);
check(
  "the UNINDEXED document_id column takes the leading (wasted) slot",
  ftsColumns[0] === "document_id" && bm25Args[0] === 0,
  `first column ${ftsColumns[0]}, first weight ${bm25Args[0]}`,
);
check(
  "declared tier order is title > description > body",
  weights.title > weights.description && weights.description > weights.body,
  JSON.stringify(weights),
);

// ----- the behavioral rule: run it against a real FTS5 index ---------------

const db = new DatabaseSync(":memory:");
db.exec(`CREATE VIRTUAL TABLE documents_fts USING fts5(
  ${ftsColumns[0]} UNINDEXED, ${ftsColumns.slice(1).join(", ")},
  tokenize = 'porter unicode61 remove_diacritics 2'
);`);

// Mirror-image rows: the SAME term in the SAME position, moved between columns,
// with every other column identical. Any score difference is therefore purely
// the column weighting. The filler rows give the term a realistic IDF (with
// only three rows in the index BM25's document-frequency term dominates).
const insert = db.prepare(
  "INSERT INTO documents_fts (document_id, title, description, body) VALUES (?, ?, ?, ?)",
);
const FILL = "filler filler filler filler";
insert.run("title_hit", "deployment", FILL, FILL);
insert.run("desc_hit", FILL, "deployment", FILL);
insert.run("body_hit", FILL, FILL, "deployment");
for (let i = 0; i < 40; i++) insert.run(`noise_${i}`, FILL, FILL, FILL);

const scores = Object.fromEntries(
  db
    .prepare(
      `SELECT document_id, -bm25(documents_fts, ${bm25Args.join(", ")}) AS score
         FROM documents_fts WHERE documents_fts MATCH '"deployment"'`,
    )
    .all()
    .map((r) => [r.document_id, r.score]),
);

const fmt = () =>
  `title ${scores.title_hit?.toFixed(4)} | description ${scores.desc_hit?.toFixed(4)} | body ${scores.body_hit?.toFixed(4)}`;

check("all three mirror rows matched", Object.keys(scores).length === 3, JSON.stringify(scores));
// THE assertion the shipped bug failed: with the weight list one short, these
// two were exactly equal (both fell through to bm25's 1.0 default).
check("a description-only hit outranks a body-only hit", scores.desc_hit > scores.body_hit, fmt());
check("a title-only hit outranks a description-only hit", scores.title_hit > scores.desc_hit, fmt());

console.log(`\nBM25 tiers: ${fmt()}`);
if (fails > 0) {
  console.log(`\n${fails} search-ranking test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall search-ranking tests passed");
}
