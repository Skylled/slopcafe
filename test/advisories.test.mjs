// Regex-level coverage for src/advisories.ts — same negative-assertion
// shape as sanitizer/src/lib.rs tests. Each case: given (input, cleaned),
// the advisory output should contain (or not contain) certain entries.
//
// Critical: the entity-encoded-script case verifies we don't false-positive
// on legitimate text content that mentions stripped tags. False positives
// here would tell an agent it lost something it actually kept.
//
// Runs under Node's native TS strip via `--experimental-strip-types`.

import { detectAdvisories } from "../src/advisories.ts";

const cases = [
  // [label, input, fakeCleaned, expectStripped[], expectWillNotRender[]]
  ["script stripped", "<script>alert(1)</script>", "", ["<script>"], []],
  ["style stripped", "<style>p{}</style><p>x</p>", "<p>x</p>", ["<style>"], []],
  [
    "link stylesheet stripped",
    "<link rel=\"stylesheet\" href=\"https://x.css\"><p>x</p>",
    "<p>x</p>",
    ["<link rel=stylesheet>"],
    [],
  ],
  ["iframe stripped", "<iframe src=\"//x\"></iframe>", "", ["<iframe>"], []],
  ["meta stripped", "<meta http-equiv=\"refresh\" content=\"0\">", "", ["<meta>"], []],
  ["form stripped", "<form action=\"/x\"><input></form>", "", ["<form>"], []],
  [
    "inline handler stripped",
    "<a href=\"https://x\" onclick=\"alert(1)\">x</a>",
    "<a href=\"https://x\" rel=\"noopener noreferrer\">x</a>",
    ["inline event handler"],
    [],
  ],
  [
    "javascript: URL stripped",
    "<a href=\"javascript:alert(1)\">x</a>",
    "<a rel=\"noopener noreferrer\">x</a>",
    ["javascript: URL"],
    [],
  ],
  [
    "data: URL in href stripped",
    "<a href=\"data:text/html,x\">x</a>",
    "<a rel=\"noopener noreferrer\">x</a>",
    ["data: URL"],
    [],
  ],
  [
    "data: URL in img src stripped",
    "<img src=\"data:image/png;base64,xxx\">",
    "<img>",
    ["data: URL"],
    [],
  ],
  [
    "aria-owns stripped",
    "<div aria-owns=\"victim\">x</div>",
    "<div>x</div>",
    ["IDREF-typed aria-*"],
    [],
  ],
  [
    "comment stripped",
    "<!-- hi --><p>x</p>",
    "<p>x</p>",
    ["HTML comment"],
    [],
  ],
  [
    "entity-encoded script — NOT stripped (false-positive guard)",
    "<p>The &lt;script&gt; tag is dangerous</p>",
    "<p>The &lt;script&gt; tag is dangerous</p>",
    [],
    [],
  ],
  [
    "external img survives — will_not_render",
    "<img src=\"https://example.com/a.png\">",
    "<img src=\"https://example.com/a.png\">",
    [],
    ["<img> with external src"],
  ],
  [
    "no changes — empty",
    "<h1>hi</h1><p>world</p>",
    "<h1>hi</h1><p>world</p>",
    [],
    [],
  ],
  [
    // Fragment/relative links still strip target — they navigate in-frame.
    // External http(s) links KEEP target="_blank" post-sanitizer-v1.2, so they
    // would NOT trigger this advisory (covered by the Rust sanitizer corpus).
    "target=_blank stripped on a non-external link",
    "<a href=\"#section\" target=\"_blank\">x</a>",
    "<a href=\"#section\" rel=\"noopener noreferrer\">x</a>",
    ["target= stripped"],
    [],
  ],
];

let fails = 0;
for (const [label, input, cleaned, wantStripped, wantWNR] of cases) {
  const got = detectAdvisories(input, cleaned);
  const okS = wantStripped.every((needle) =>
    got.stripped.some((entry) => entry.toLowerCase().includes(needle.toLowerCase())),
  );
  const noExtraS = wantStripped.length === got.stripped.length || got.stripped.length >= wantStripped.length;
  const okW = wantWNR.every((needle) =>
    got.will_not_render.some((entry) => entry.toLowerCase().includes(needle.toLowerCase())),
  );
  const exactCountS = got.stripped.length === wantStripped.length;
  const exactCountW = got.will_not_render.length === wantWNR.length;
  const passed = okS && okW && exactCountS && exactCountW;
  console.log(`${passed ? "ok  " : "FAIL"} ${label}`);
  if (!passed) {
    console.log(`  want stripped: ${JSON.stringify(wantStripped)}`);
    console.log(`  got  stripped: ${JSON.stringify(got.stripped)}`);
    console.log(`  want will_not_render: ${JSON.stringify(wantWNR)}`);
    console.log(`  got  will_not_render: ${JSON.stringify(got.will_not_render)}`);
    fails++;
  }
}
process.exit(fails === 0 ? 0 : 1);
