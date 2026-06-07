// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/search.ts — query tokenization for the FTS5-backed
// document search. Pure-function tests in the same Node-strip-types harness
// as the other test/*.test.mjs files. Integration with the actual FTS5
// index is exercised end-to-end via wrangler dev (no D1 mock in v1).

import { buildFtsMatchQuery } from "../src/search.ts";

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

// ----- basic tokenization ---------------------------------------------------

check("empty input → null", buildFtsMatchQuery(""), null);
check("whitespace only → null", buildFtsMatchQuery("   \t\n"), null);
check("single short token → null", buildFtsMatchQuery("a"), null);
check("two short tokens → null", buildFtsMatchQuery("a b"), null);
check("single usable token", buildFtsMatchQuery("publish"), "publish");
check("two usable tokens", buildFtsMatchQuery("publish docs"), "publish docs");
check(
  "mixed short + usable: shorts dropped",
  buildFtsMatchQuery("a publish b docs"),
  "publish docs",
);

// ----- prefix match ---------------------------------------------------------

check("prefix preserved", buildFtsMatchQuery("publi*"), "publi*");
check("prefix on short base dropped", buildFtsMatchQuery("a*"), null);
check(
  "mixed bare + prefix",
  buildFtsMatchQuery("publish docs*"),
  "publish docs*",
);

// ----- case folding ---------------------------------------------------------

check("uppercase folded", buildFtsMatchQuery("PUBLISH DOCS"), "publish docs");
check(
  "mixed case folded",
  buildFtsMatchQuery("Publishing Workflow"),
  "publishing workflow",
);
// The FTS5 operators AND/OR/NOT/NEAR are case-sensitive uppercase keywords.
// Lowercasing means agent queries like "math AND physics" are treated as three
// ordinary terms, not as a Boolean expression.
check(
  "FTS5 operators de-fanged via lowercase",
  buildFtsMatchQuery("math AND physics"),
  "math and physics",
);
check("OR de-fanged", buildFtsMatchQuery("foo OR bar"), "foo or bar");
check("NEAR de-fanged", buildFtsMatchQuery("foo NEAR bar"), "foo near bar");

// ----- punctuation stripping -----------------------------------------------

check(
  "quotes stripped, words kept",
  buildFtsMatchQuery(`"quoted phrase"`),
  "quoted phrase",
);
check(
  "parens stripped",
  buildFtsMatchQuery("(foo) (bar)"),
  "foo bar",
);
check(
  "column-prefix syntax neutralized",
  // `tags:foo` would be an FTS5 column filter. The `:` is excluded from the
  // token charset so it acts as a separator — both halves survive as plain
  // terms, neither retains the column-filter meaning.
  buildFtsMatchQuery("tags:foo"),
  "tags foo",
);
check(
  "punctuation-only input → null",
  buildFtsMatchQuery("()!@#"),
  null,
);

// ----- diacritics & unicode -------------------------------------------------

// Diacritics are HANDLED at index time by the FTS5 tokenizer (remove_diacritics
// 2 in the migration). buildFtsMatchQuery itself just preserves them; the
// match comparison happens server-side. The point of this test is to confirm
// we don't strip Unicode letters during tokenization.
check(
  "diacritics preserved through tokenizer",
  buildFtsMatchQuery("naïve résumé"),
  "naïve résumé",
);
check(
  "non-ASCII letters preserved",
  buildFtsMatchQuery("日本語 検索"),
  "日本語 検索",
);

// ----- identifiers ---------------------------------------------------------

// Underscores and hyphens stay inside tokens — agents often search for
// identifiers (function_name, my-component) and breaking on those would be
// surprising. FTS5's unicode61 tokenizer will re-split underscores at index
// time, so the match still works word-by-word; we just don't have to do that
// splitting on the query side.
check(
  "underscore-joined identifier preserved",
  buildFtsMatchQuery("foo_bar"),
  "foo_bar",
);
check(
  "hyphen-joined identifier preserved",
  buildFtsMatchQuery("my-component"),
  "my-component",
);
check(
  "identifiers mixed with words",
  buildFtsMatchQuery("the foo_bar function"),
  "the foo_bar function",
);

// ----- edge cases ----------------------------------------------------------

// `*` alone has length 0 after stripping the suffix → dropped.
check("bare asterisk dropped", buildFtsMatchQuery("*"), null);
// Many `*`s in a row — the regex anchors `*` only as a suffix, so the inner
// `*`s act as separators. None of the resulting tokens are usable.
check("multiple asterisks → null", buildFtsMatchQuery("***"), null);
// A digit-only "word" qualifies — useful for years, version numbers, etc.
check("digits-only token", buildFtsMatchQuery("2026"), "2026");
check(
  "mixed letters and digits",
  buildFtsMatchQuery("v1.2 release"),
  "v1 release",
  // `.` separates v1 from 2; the `2` token is one char so it drops out.
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall search tests passed");
}
