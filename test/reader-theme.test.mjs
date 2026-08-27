// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/reader-theme.ts — which reading theme (prose vs. the
// data-dense teardown-table theme) serve.ts's serveRaw and serveVersionRaw
// splice ahead of a Markdown document's bytes, keyed on `doc_kind` (migration
// 0019).
//
// Not a security boundary the way servedVersion is (both themes are inert
// presentation, no CSP change), but a rendering regression here is highly
// visible — every non-Insight document on this fork, and five of the seven
// Insight doc_kinds, must keep the prose theme; only `teardown` and
// `teardown-section` should ever get the wide/dense one.
//
// Pure functions, same Node-strip-types harness as conditional/served-version.
// serve.ts itself is NOT importable here (it transitively pulls in core.ts's
// WASM-backed sanitizer, which Node's plain ESM loader can't load outside the
// Workers runtime) — which is exactly why the theme-selection logic lives in
// this dependency-free leaf module instead of inline in serve.ts. The actual
// wiring into serveRaw/serveVersionRaw (doc_kind read off the D1 row) is
// exercised via wrangler dev (no D1 mock in v1).

import {
  DENSE_THEME_CSS,
  DENSE_THEME_PREFIX,
  READER_THEME_CSS,
  READER_THEME_PREFIX,
  readerThemePrefixForDocKind,
} from "../src/reader-theme.ts";

let fails = 0;

function ok(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails++;
}

// ---- selection: the two dense doc_kinds -------------------------------
ok(
  "doc_kind teardown selects the dense theme",
  readerThemePrefixForDocKind("teardown") === DENSE_THEME_PREFIX,
);
ok(
  "doc_kind teardown-section selects the dense theme",
  readerThemePrefixForDocKind("teardown-section") === DENSE_THEME_PREFIX,
);

// ---- selection: every other doc_kind, and NULL, keep prose -------------
// The other five DOC_KIND_VALUES from metadata.ts, plus NULL (every
// non-Insight document on this fork) and an unrecognized string (defense in
// depth — a D1 row's doc_kind is untyped TEXT, so this must fail closed to
// the SAFE default, not throw and not silently dense-ify).
for (const kind of [
  "writeup",
  "hypothesis",
  "experiment-result",
  "kb-feature",
  "analyst-context",
  null,
  "some-unrecognized-value",
]) {
  ok(
    `doc_kind ${JSON.stringify(kind)} keeps the prose theme`,
    readerThemePrefixForDocKind(kind) === READER_THEME_PREFIX,
  );
}

// ---- the prefixes wrap the matching CSS, doctype-first ------------------
ok("prose prefix starts with the doctype", READER_THEME_PREFIX.startsWith("<!doctype html>"));
ok("dense prefix starts with the doctype", DENSE_THEME_PREFIX.startsWith("<!doctype html>"));
ok("prose prefix embeds READER_THEME_CSS", READER_THEME_PREFIX.includes(READER_THEME_CSS));
ok("dense prefix embeds DENSE_THEME_CSS", DENSE_THEME_PREFIX.includes(DENSE_THEME_CSS));
// The two are genuinely different rule sets, not the same string twice.
ok("the two themes are not the same CSS", READER_THEME_CSS !== DENSE_THEME_CSS);

// ---- shared palette: both themes draw from the same custom properties ---
// Regression guard for "factor the shared variable block so the two themes
// don't duplicate the palette" — assert both embed the identical :root/dark
// block rather than each hand-rolling their own copy that could drift.
const propNames = ["--bg", "--surface", "--text", "--heading", "--link", "--rule", "--code-bg", "--thead"];
for (const name of propNames) {
  const propRe = new RegExp(`${name}:#[0-9a-f]{6}`);
  ok(`prose theme sets ${name}`, propRe.test(READER_THEME_CSS));
  ok(`dense theme sets ${name}`, propRe.test(DENSE_THEME_CSS));
}
ok(
  "both themes carry the identical prefers-color-scheme:dark block",
  READER_THEME_CSS.includes("@media (prefers-color-scheme:dark){:root{") &&
    DENSE_THEME_CSS.includes("@media (prefers-color-scheme:dark){:root{") &&
    READER_THEME_CSS.slice(
      READER_THEME_CSS.indexOf("@media (prefers-color-scheme:dark)"),
      READER_THEME_CSS.indexOf("}}") + 2,
    ) ===
      DENSE_THEME_CSS.slice(
        DENSE_THEME_CSS.indexOf("@media (prefers-color-scheme:dark)"),
        DENSE_THEME_CSS.indexOf("}}") + 2,
      ),
);

// ---- dense-theme specifics named in the design brief ---------------------
ok("dense body is wide-but-bounded (~110rem)", DENSE_THEME_CSS.includes("max-width:110rem"));
ok("prose body stays at the narrow 44rem measure", READER_THEME_CSS.includes("max-width:44rem"));
ok("dense body is ~14px/1.45", DENSE_THEME_CSS.includes("font-size:14px;line-height:1.45"));
ok("prose body is the original 17px/1.7", READER_THEME_CSS.includes("font-size:17px;line-height:1.7"));
ok("dense table declares table-layout:auto", /table\{[^}]*table-layout:auto/.test(DENSE_THEME_CSS));
ok(
  "dense th,td wrap long unbreakable keys",
  /th,td\{[^}]*word-break:break-word/.test(DENSE_THEME_CSS),
);
ok(
  "prose th,td do NOT force word-break (long keys would ribbon)",
  !/th,td\{[^}]*word-break/.test(READER_THEME_CSS),
);
ok(
  "dense theme wraps code spans inside table cells",
  DENSE_THEME_CSS.includes("td code,th code{white-space:pre-wrap}"),
);
ok("prose theme has no such per-cell code rule", !READER_THEME_CSS.includes("td code,th code"));
ok(
  "dense H2 is sticky, pinned to the theme surface, keeps the bottom rule",
  /h2\{[^}]*position:sticky[^}]*top:0[^}]*background:var\(--surface\)[^}]*border-bottom:1px solid var\(--rule\)|h2\{[^}]*border-bottom:1px solid var\(--rule\)[^}]*position:sticky[^}]*top:0[^}]*background:var\(--surface\)/.test(
    DENSE_THEME_CSS,
  ),
);
ok("prose H2 is NOT sticky", !/h2\{[^}]*position:sticky/.test(READER_THEME_CSS));

if (fails > 0) {
  console.error(`\n${fails} reader-theme test(s) FAILED`);
  process.exit(1);
}
console.log("\nall reader-theme tests passed");
