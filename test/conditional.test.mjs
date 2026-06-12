// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/conditional.ts — the If-None-Match matcher + ETag formatter
// behind the conditional-GET (304) short-circuit on the render-bytes path
// (`/d/:id/raw`, `/d/:id/v/:n/raw`). Pure functions, same Node-strip-types
// harness as the other test/*.test.mjs files; the actual 304 wiring + the
// load-bearing "after the access gate" ordering is exercised via wrangler dev
// (no D1 mock in v1).

import { etagForVersion, ifNoneMatchSatisfied, parseIfMatch } from "../src/conditional.ts";

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

function checkDeep(label, got, want) {
  const okEq = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${okEq ? "ok  " : "FAIL"} ${label}`);
  if (!okEq) {
    console.log(`  want: ${JSON.stringify(want)}`);
    console.log(`  got:  ${JSON.stringify(got)}`);
    fails++;
  }
}

// ----- etagForVersion -------------------------------------------------------

check("etag is quoted v<n>", etagForVersion(1), '"v1"');
check("etag for large n", etagForVersion(42), '"v42"');

// ----- absent / empty header → no match -------------------------------------

check("null header → false", ifNoneMatchSatisfied(null, 5), false);
check("empty header → false", ifNoneMatchSatisfied("", 5), false);

// ----- spec-correct strong match --------------------------------------------

check("exact quoted tag matches", ifNoneMatchSatisfied('"v5"', 5), true);
check("quoted tag for different version → false", ifNoneMatchSatisfied('"v6"', 5), false);

// ----- wildcard -------------------------------------------------------------

check("wildcard matches any version", ifNoneMatchSatisfied("*", 5), true);
check("wildcard matches version 1", ifNoneMatchSatisfied("*", 1), true);

// ----- weak comparison (W/ prefix ignored) ----------------------------------

check("weak tag matches (W/ dropped)", ifNoneMatchSatisfied('W/"v5"', 5), true);
check("weak tag wrong version → false", ifNoneMatchSatisfied('W/"v6"', 5), false);

// ----- comma-separated lists ------------------------------------------------

check("list with matching member", ifNoneMatchSatisfied('"v3", "v5", "v9"', 5), true);
check("list without match → false", ifNoneMatchSatisfied('"v3", "v9"', 5), false);
check("list with spaces + weak member", ifNoneMatchSatisfied('"v1", W/"v5"', 5), true);

// ----- first-party unquoted tolerances --------------------------------------

check("bare v<n> tolerated", ifNoneMatchSatisfied("v5", 5), true);
check("bare numeric tolerated", ifNoneMatchSatisfied("5", 5), true);
check("bare numeric wrong version → false", ifNoneMatchSatisfied("6", 5), false);

// ----- no false positives on substrings / prefixes --------------------------

check("v50 does not match v5", ifNoneMatchSatisfied('"v50"', 5), false);
check("v5 does not match v50", ifNoneMatchSatisfied('"v5"', 50), false);
check("empty list members ignored", ifNoneMatchSatisfied('"v5", ', 5), true);

// ----- parseIfMatch (write-path If-Match) -----------------------------------

// Wildcard.
checkDeep("parse * → any", parseIfMatch("*"), { kind: "any" });
checkDeep("parse * with surrounding space → any", parseIfMatch("  *  "), { kind: "any" });

// The canonical strong tag plus the three lenient spellings of "version n"
// (GitHub issue #32) — all parse to the same version.
checkDeep('parse "v5" → version 5', parseIfMatch('"v5"'), { kind: "version", v: 5 });
checkDeep("parse v5 → version 5", parseIfMatch("v5"), { kind: "version", v: 5 });
checkDeep("parse bare 5 → version 5", parseIfMatch("5"), { kind: "version", v: 5 });
checkDeep('parse "5" → version 5', parseIfMatch('"5"'), { kind: "version", v: 5 });
checkDeep("parse with surrounding space → version 5", parseIfMatch('  "v5"  '), { kind: "version", v: 5 });
checkDeep("parse multi-digit version", parseIfMatch("v42"), { kind: "version", v: 42 });

// Rejected shapes: weak tags, multi-tag lists, unbalanced quotes, garbage.
checkDeep("parse weak tag → invalid", parseIfMatch('W/"v5"'), { kind: "invalid" });
checkDeep("parse multi-tag list → invalid", parseIfMatch('"v3", "v5"'), { kind: "invalid" });
checkDeep("parse unbalanced open quote → invalid", parseIfMatch('"v5'), { kind: "invalid" });
checkDeep("parse unbalanced close quote → invalid", parseIfMatch('v5"'), { kind: "invalid" });
checkDeep("parse trailing junk → invalid", parseIfMatch('"v5"x'), { kind: "invalid" });
checkDeep("parse empty string → invalid", parseIfMatch(""), { kind: "invalid" });
checkDeep("parse non-numeric → invalid", parseIfMatch("latest"), { kind: "invalid" });
checkDeep("parse negative → invalid", parseIfMatch("-5"), { kind: "invalid" });

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall conditional tests passed");
}
