// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/depth.ts — the O(n) `maxNestingDepth` byte scan the write
// path runs as a cheap pre-screen to reject depth-bombs BEFORE the ~O(n²)
// sanitize/tree-build (GitHub issue #42). Pure function, same Node-strip-types
// harness as the other test/*.test.mjs files. The end-to-end "reject before
// sanitize" wiring is exercised via wrangler dev (no D1 mock in v1).

import { maxNestingDepth, DEPTH_SCAN_CAP } from "../src/depth.ts";

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
check(
  "unclosed nested opens still count (auto-closed by a real parser)",
  maxNestingDepth("<div>".repeat(500)),
  500,
);
check(
  "DISALLOWED nested tags count too (same parse cost)",
  maxNestingDepth("<foo>".repeat(400) + "</foo>".repeat(400)),
  400,
);

// ----- end tags run against an open-element stack ---------------------------
// The scan's load-bearing property: an end tag that matches nothing open is
// IGNORED (as the parser ignores it), so it can't "close" a level that is in
// fact still open. The first cut of this scan decremented on ANY end tag, so
// every case below scanned as depth 1 while the real parse nested one element
// per repeat — which put the ~O(n²) sanitize path this screen exists to close
// right back within reach (176 KB of `<div></foo>` = 2.3 s in sanitize).

check("an unmatched end tag does not close the open element", maxNestingDepth("<div></foo>"), 1);
check(
  "unmatched end tags: real nesting is counted, not cancelled",
  maxNestingDepth("<div></foo>".repeat(300)),
  300,
);
check(
  "</p> with no open <p> is an INSERTED element, not a close",
  maxNestingDepth("<div></p>".repeat(300)),
  300,
);
check(
  "</br> is an INSERTED <br> leaf, not a close",
  maxNestingDepth("<div></br>".repeat(300)),
  300,
);
check("an end tag with nothing open at all is a no-op", maxNestingDepth("</div></div></div>"), 0);
check("end tags past the open element don't go negative", maxNestingDepth("<p>x</p></p></p><b>y</b>"), 1);
check("end tag matching is case-insensitive", maxNestingDepth("<div></DIV><div></div>"), 1);
check("end tag name stops at whitespace", maxNestingDepth("<div></div ><div></div>"), 1);
check("</> is not an end tag", maxNestingDepth("<div></><p>x</p></div>"), 2);

// A matching end tag pops the whole run above it — the elements a real parser
// would auto-close go with it, so honest markup measures its honest depth.
check("a close pops the unclosed elements above it", maxNestingDepth("<div><p>a<p>b</div><div>c</div>"), 3);
check(
  "properly closed list/table markup measures its true depth",
  maxNestingDepth("<ul>" + "<li>x</li>".repeat(200) + "</ul>"),
  2,
);
check(
  "unclosed <li> siblings accumulate (a deliberate over-count, never an under-count)",
  maxNestingDepth("<ul><li>a<li>b<li>c</ul>"),
  4,
);

// The search stops at a barrier element, so a stray end tag can't reach past a
// block boundary and flatten the count. `<foo><div></foo>` is the case that
// makes the barrier set load-bearing: the real parse ignores the `</foo>` over
// the special `<div>` and nests two levels per repeat (×200 → maxDomDepth 202),
// so a search that crossed the `<div>` to reach the `<foo>` would scan it flat.
check("an unknown end tag can't close through a barrier", maxNestingDepth("<foo><div></foo>".repeat(100)), 200);
check("a stray end tag can't close through a barrier", maxNestingDepth("<div><table></div>".repeat(100)), 200);
check(
  "but it does cross non-barrier elements to its match",
  maxNestingDepth("<div><span><b>x</div><div>y</div>"),
  3,
);

// ----- the count saturates at the cap ---------------------------------------
// Past the caller's reject threshold the verdict can't change, so the scan
// stops rather than stacking the rest of a bomb.

check("a depth-bomb saturates at the cap", maxNestingDepth("<div>".repeat(20000)), DEPTH_SCAN_CAP);
check(
  "an unmatched-end-tag bomb saturates too (the old scan reported 1)",
  maxNestingDepth("<div></foo>".repeat(20000)),
  DEPTH_SCAN_CAP,
);
check("the cap is one past core.ts's MAX_DOM_DEPTH (512)", DEPTH_SCAN_CAP, 513);
check("an explicit cap saturates there", maxNestingDepth("<div>".repeat(50), 10), 10);
check("input under an explicit cap is unaffected", maxNestingDepth("<div>".repeat(9), 10), 9);

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

// …and raw-text content can't reach the open-element stack either: an end tag
// inside CSS/JS/title text is text, so it must neither close a real element
// (which would under-count) nor be left half-parsed.
check(
  "end tags inside raw text don't close the elements around it",
  maxNestingDepth("<div><style>" + "</div>".repeat(50) + "</style><p>x</p></div>"),
  2,
);
check(
  "rcdata content is skipped, and the element after it still nests",
  maxNestingDepth("<div><title>a</div>b</title><p><b>x</b></p></div>"),
  3,
);
check(
  "a raw-text element is one level, whatever is nested around it",
  maxNestingDepth("<div><p><script>" + "<i>".repeat(300) + "</script></p></div>"),
  3,
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

// ----- tokenizer-accurate tag names (accumulating under-count bypasses) -----
//
// Each of these repeats a unit that the real parser nests one level deeper
// every time, while a name-shaped-characters scan reads them as balanced (or
// as leaves) and reports a flat depth. A flat reading here is exactly what
// lets a multi-megabyte depth bomb walk past the pre-screen and into the
// ~O(n²) sanitize path that issue #42 added this scan to protect.

check(
  "the HTML self-closing flag is IGNORED on ordinary elements — <div/> opens a div",
  maxNestingDepth("<div/>".repeat(300)),
  300,
);

check(
  "…including the shortest form, <b/> at 4 bytes per level",
  maxNestingDepth("<b/>".repeat(300)),
  300,
);

check(
  "…but foreign content really does self-close, so legitimate SVG stays flat",
  maxNestingDepth("<svg>" + "<path/>".repeat(400) + "</svg>"),
  1,
);

check(
  "an HTML integration point inside SVG switches back to HTML rules",
  maxNestingDepth("<svg><foreignObject>" + "<div/>".repeat(300)),
  302, // svg > foreignObject > 300 nested divs
);

check(
  "an end-tag name the tokenizer would extend closes nothing (</div=x>)",
  maxNestingDepth("<div></div=x>".repeat(300)),
  300,
);

check(
  "a start-tag name the tokenizer would extend can't be closed by the short name",
  maxNestingDepth("<div=x></div>".repeat(300)),
  300,
);

check(
  "…and the same for a name extended by '.' rather than '='",
  maxNestingDepth("<div></div.>".repeat(300)),
  300,
);

check(
  'a name-extended void lookalike is not void — <br"x> is an unknown element',
  maxNestingDepth('<br"x>'.repeat(300)),
  300,
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall depth tests passed");
}
