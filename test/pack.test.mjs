// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/pack.ts — the pure context-pack logic (issue #21,
// docs/design/context-packs-design.md). pack.ts has no D1/R2/WASM imports, so
// it runs under the same Node strip-types harness as search/edit/vector.

import {
  clampPackKnobs,
  DEFAULT_BUDGET_BYTES,
  DEFAULT_MAX_DOCUMENTS,
  MAX_BUDGET_BYTES,
  MAX_MAX_DOCUMENTS,
  MIN_BUDGET_BYTES,
  selectWithinBudget,
} from "../src/pack.ts";

let fails = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? "ok  " : "FAIL"} ${label}`);
  if (!pass) {
    console.log(`  expected: ${e}`);
    console.log(`  actual:   ${a}`);
    fails++;
  }
}

const doc = (id, size) => ({ id, size });
const sizeOf = (d) => d.size;
const ids = (arr) => arr.map((d) => d.id);

// ----- selectWithinBudget -----------------------------------------------------

{
  // Everything fits.
  const r = selectWithinBudget([doc("a", 10), doc("b", 20)], sizeOf, 100, 10);
  check("fill: all fit", ids(r.included), ["a", "b"]);
  check("fill: nothing omitted", r.omitted, []);
  check("fill: used_bytes sums included", r.used_bytes, 30);
}

{
  // Budget binds: the too-big middle doc is SKIPPED (reason budget) and the
  // walk CONTINUES — a later smaller doc still uses the room (greedy-by-rank,
  // skip-and-continue, §3.2).
  const r = selectWithinBudget([doc("a", 50), doc("b", 60), doc("c", 40)], sizeOf, 100, 10);
  check("fill: skip-and-continue past a too-big doc", ids(r.included), ["a", "c"]);
  check(
    "fill: skipped doc reported with reason budget",
    r.omitted.map((o) => [o.item.id, o.reason]),
    [["b", "budget"]],
  );
  check("fill: used_bytes excludes the skipped doc", r.used_bytes, 90);
}

{
  // max_documents binds first: candidates past the cap report max_documents,
  // not budget, even if they'd fit.
  const r = selectWithinBudget([doc("a", 1), doc("b", 1), doc("c", 1)], sizeOf, 100, 2);
  check("fill: max_documents caps the count", ids(r.included), ["a", "b"]);
  check(
    "fill: over-cap reported as max_documents",
    r.omitted.map((o) => [o.item.id, o.reason]),
    [["c", "max_documents"]],
  );
}

{
  // The empty-pack edge (review decision: ALWAYS skip-and-report, no force
  // include): the #1 candidate alone exceeding the whole budget yields an
  // empty pack with that candidate loudly in omitted[].
  const r = selectWithinBudget([doc("a", 500)], sizeOf, 100, 10);
  check("fill: oversized #1 candidate → empty pack", r.included, []);
  check(
    "fill: oversized #1 reported, not force-included",
    r.omitted.map((o) => [o.item.id, o.reason]),
    [["a", "budget"]],
  );
  check("fill: empty pack uses zero bytes", r.used_bytes, 0);
}

{
  // Exact-fit boundary: a doc that lands exactly on the budget is included.
  const r = selectWithinBudget([doc("a", 60), doc("b", 40)], sizeOf, 100, 10);
  check("fill: exact fit included", ids(r.included), ["a", "b"]);
  check("fill: exact fit uses whole budget", r.used_bytes, 100);
}

{
  // Order is preserved — candidates arrive ranked; the selector never re-sorts
  // (e.g. it does NOT bin-pack small-docs-first).
  const r = selectWithinBudget([doc("big", 90), doc("small", 5)], sizeOf, 100, 10);
  check("fill: rank order preserved", ids(r.included), ["big", "small"]);
}

{
  // No candidates → clean empty result.
  const r = selectWithinBudget([], sizeOf, 100, 10);
  check("fill: empty input", { i: r.included, o: r.omitted, u: r.used_bytes }, { i: [], o: [], u: 0 });
}

// ----- clampPackKnobs ---------------------------------------------------------

{
  const k = clampPackKnobs({});
  check(
    "knobs: defaults",
    k,
    { budgetBytes: DEFAULT_BUDGET_BYTES, maxDocuments: DEFAULT_MAX_DOCUMENTS },
  );
}

{
  const k = clampPackKnobs({ budget_bytes: 10_000_000, max_documents: 9999 });
  check(
    "knobs: clamped to max, not rejected",
    k,
    { budgetBytes: MAX_BUDGET_BYTES, maxDocuments: MAX_MAX_DOCUMENTS },
  );
}

{
  const k = clampPackKnobs({ budget_bytes: 1, max_documents: 0 });
  check("knobs: clamped to min", k, { budgetBytes: MIN_BUDGET_BYTES, maxDocuments: 1 });
}

{
  const k = clampPackKnobs({ budget_bytes: 32768, max_documents: 3 });
  check("knobs: in-range passes through", k, { budgetBytes: 32768, maxDocuments: 3 });
}

{
  // Non-integers fall back to defaults (the parse layer hands undefined for
  // malformed input; a float is treated the same).
  const k = clampPackKnobs({ budget_bytes: 1.5, max_documents: NaN });
  check(
    "knobs: non-integers fall back to defaults",
    k,
    { budgetBytes: DEFAULT_BUDGET_BYTES, maxDocuments: DEFAULT_MAX_DOCUMENTS },
  );
}

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} pack test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall pack tests passed");
}
