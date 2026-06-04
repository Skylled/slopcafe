// Coverage for src/vector.ts — the pure hybrid-search helpers:
// reciprocalRankFusion (rank-only fusion of keyword + semantic result lists)
// and buildEmbedInput (the embed-text shape). Same Node-strip-types harness as
// the other test/*.test.mjs files. Nothing imports src/vector.ts yet — this is
// inert prep landed ahead of the feature (see vector-search-design.md), so the
// fusion's tie/dedup/ordering rules are pinned before anything depends on them.

import { buildEmbedInput, reciprocalRankFusion } from "../src/vector.ts";

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

// Compare arrays/objects structurally.
function checkJson(label, got, want) {
  check(label, JSON.stringify(got), JSON.stringify(want));
}

// Float-tolerant equality for fused scores.
function checkClose(label, got, want) {
  const okEq = Math.abs(got - want) < 1e-9;
  console.log(`${okEq ? "ok  " : "FAIL"} ${label}`);
  if (!okEq) {
    console.log(`  want: ${want}`);
    console.log(`  got:  ${got}`);
    fails++;
  }
}

// Convenience: just the id order out of the fused result.
const ids = (rows) => rows.map((r) => r.id);
const rrf = (lists, k) => reciprocalRankFusion(lists, k);

// ----- reciprocalRankFusion: single list preserves order --------------------

checkJson("single list keeps best-first order", ids(rrf([["a", "b", "c"]])), ["a", "b", "c"]);
checkClose("single-list rank-1 score is 1/(60+1)", rrf([["a", "b", "c"]])[0].score, 1 / 61);
checkClose("single-list rank-2 score is 1/(60+2)", rrf([["a", "b", "c"]])[1].score, 1 / 62);

// ----- presence in both lists beats presence in one ------------------------

// lists: A=[a,b], B=[b,c]. b is in both (1/62 + 1/61), a only in A (1/61),
// c only in B (1/62). So b first; then a (1/61) edges c (1/62).
checkJson("doc in both lists ranks first", ids(rrf([["a", "b"], ["b", "c"]])), ["b", "a", "c"]);
checkClose(
  "shared doc score sums across lists",
  rrf([["a", "b"], ["b", "c"]]).find((r) => r.id === "b").score,
  1 / 62 + 1 / 61,
);

// ----- disjoint lists: symmetric scores, deterministic id tiebreak ----------

checkJson("disjoint single-item lists tie-break by id asc", ids(rrf([["x"], ["y"]])), ["x", "y"]);
checkJson("tiebreak is id order, not list order", ids(rrf([["y"], ["x"]])), ["x", "y"]);
checkClose("tied scores are equal", rrf([["x"], ["y"]])[0].score, rrf([["x"], ["y"]])[1].score);

// ----- empty inputs ---------------------------------------------------------

checkJson("no lists → empty", rrf([]), []);
checkJson("all-empty lists → empty", rrf([[], []]), []);
checkJson("empty list contributes nothing", ids(rrf([["a"], []])), ["a"]);

// ----- k controls top-rank emphasis ----------------------------------------

checkClose("k=0 makes rank-1 score 1/1", rrf([["a", "b"]], 0)[0].score, 1);
checkClose("k=0 makes rank-2 score 1/2", rrf([["a", "b"]], 0)[1].score, 1 / 2);
checkClose("negative k is floored to 0", rrf([["a"]], -5)[0].score, 1);

// ----- defensive: duplicate id within one list counts best rank only --------

// a appears at rank 1 and rank 3 of the same list; only rank 1 should count.
checkClose("dup id in one list counts best rank only", rrf([["a", "b", "a"]])[0].score, 1 / 61);
checkJson("dup id does not appear twice in output", ids(rrf([["a", "b", "a"]])), ["a", "b"]);

// ----- defensive: falsy ids skipped -----------------------------------------

checkJson("empty-string id is skipped", ids(rrf([["", "a"]])), ["a"]);

// ----- buildEmbedInput ------------------------------------------------------

check("all three parts joined by blank lines", buildEmbedInput("T", "D", "B"), "T\n\nD\n\nB");
check("null title dropped", buildEmbedInput(null, "D", "B"), "D\n\nB");
check("null description dropped", buildEmbedInput("T", null, "B"), "T\n\nB");
check("both null → body only", buildEmbedInput(null, null, "B"), "B");
check("parts are trimmed", buildEmbedInput("  T ", " D  ", "  B  "), "T\n\nD\n\nB");
check("empty-string part dropped", buildEmbedInput("", "D", "B"), "D\n\nB");
check("whitespace-only part dropped", buildEmbedInput("   ", "D", "B"), "D\n\nB");
check("empty body with metadata still joins", buildEmbedInput("T", "D", ""), "T\n\nD");

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall vector tests passed");
}
