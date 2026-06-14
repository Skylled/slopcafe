// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/depth.ts — the O(n) `maxNestingDepth` byte scan the write
// path runs as a cheap pre-screen to reject depth-bombs BEFORE the ~O(n²)
// sanitize/tree-build (GitHub issue #42). Pure function, same Node-strip-types
// harness as the other test/*.test.mjs files. The end-to-end "reject before
// sanitize" wiring is exercised via wrangler dev (no D1 mock in v1).

import { maxNestingDepth } from "../src/depth.ts";

let fails = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`  want: ${want}`);
    console.log(`  got:  ${got}`);
    fails++;
  }
}

// ----- basics ---------------------------------------------------------------

check("empty string", maxNestingDepth(""), 0);
check("plain text, no tags", maxNestingDepth("hello world"), 0);
check("single element", maxNestingDepth("<p>hi</p>"), 1);
check("siblings, not nested", maxNestingDepth("<p>a</p><p>b</p><p>c</p>"), 1);
check("two levels", maxNestingDepth("<div><p>x</p></div>"), 2);
check(
  "full document wrapper",
  maxNestingDepth("<html><head></head><body><div><p>x</p></div></body></html>"),
  4,
);

// ----- nested-element depth IS the count ------------------------------------

check("nested divs ×10", maxNestingDepth("<div>".repeat(10) + "</div>".repeat(10)), 10);
check("nested divs ×1000 (a depth-bomb)", maxNestingDepth("<div>".repeat(1000) + "</div>".repeat(1000)), 1000);
check(
  "unclosed nested opens still count (auto-closed by a real parser)",
  maxNestingDepth("<div>".repeat(500)),
  500,
);
check(
  "DISALLOWED nested tags count too (same parse cost)",
  maxNestingDepth("<foo>".repeat(800) + "</foo>".repeat(800)),
  800,
);

// ----- void elements never inflate depth (the key false-positive guard) -----

check("a run of <br> is depth 0", maxNestingDepth("<br>".repeat(600)), 0);
check("paragraph full of <br> is depth 1", maxNestingDepth("<p>" + "<br>".repeat(600) + "</p>"), 1);
check(
  "void siblings (img/hr/input) don't nest",
  maxNestingDepth("<div>" + "<img src=x><hr><input>".repeat(300) + "</div>"),
  1,
);

// ----- self-closing tags are leaves -----------------------------------------

check(
  "self-closing SVG primitives don't nest",
  maxNestingDepth("<svg>" + "<rect/><circle/>".repeat(400) + "</svg>"),
  1,
);

// ----- comments / doctype / PI are skipped ----------------------------------

check("markup inside a comment is not counted", maxNestingDepth("<!--" + "<div>".repeat(600) + "-->"), 0);
check(
  "comment between real elements",
  maxNestingDepth("<div><!-- <div><div><div> --><p>x</p></div>"),
  2,
);
check("doctype is skipped", maxNestingDepth("<!doctype html><p>x</p>"), 1);

// ----- raw-text element CONTENT is skipped ----------------------------------

check("<style> CSS with angle brackets is not counted", maxNestingDepth("<style>" + "<div>".repeat(600) + "</style>"), 1);
check("<script> body with markup is not counted", maxNestingDepth("<script>" + "<a><b><c>".repeat(300) + "</script>"), 1);
check("<title> rcdata is not counted", maxNestingDepth("<title>a<b>c<d>e</title>"), 1);
check("<textarea> content is not counted", maxNestingDepth("<textarea>" + "<li>".repeat(600) + "</textarea>"), 1);
check(
  "unclosed <style> runs to EOF (no count of its content)",
  maxNestingDepth("<p>x</p><style>" + "<div>".repeat(600)),
  1,
);

// ----- quoted attribute values don't break the tag scan ---------------------

check("'>' inside an attribute value doesn't end the tag", maxNestingDepth('<a title="a>b">x</a>'), 1);
check(
  "'<' / '</…>' inside an attribute value is not a tag",
  maxNestingDepth('<a data="<div></div>"><span>x</span></a>'),
  2,
);

// ----- mixed realistic content stays shallow --------------------------------

check(
  "a typical report nests only a few levels",
  maxNestingDepth(
    "<section><h1>Title</h1><p>intro <strong>bold</strong></p>" +
      "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>" +
      "<ul><li>one</li><li>two</li></ul></section>",
  ),
  5, // deepest path: section > table > thead/tbody > tr > th/td
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall depth tests passed");
}
