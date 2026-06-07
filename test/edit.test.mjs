// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/edit.ts — the pure find/replace logic behind the
// `edit_document` MCP tool and editDocumentCore.
//
// Same Node-strip-types harness as the other test/*.test.mjs files. Pure
// functions only: editDocumentCore's D1/R2/FTS plumbing imports the WASM
// sanitizer (can't load under --experimental-strip-types) and is exercised
// end-to-end via wrangler dev, exactly like the FTS path in search.test.mjs.
//
// Representation note (source-retention / Case A): applyEdits is
// representation-AGNOSTIC — it is plain literal find/replace over whatever
// string it's handed. Under Case A, editDocumentCore now hands it the RETAINED
// SOURCE S (Markdown for a Markdown doc, original HTML for an HTML doc), not the
// stored sanitized HTML (H) it matched against before. The agent obtains that
// string via a `representation: "source"` read. None of the pure assertions
// below change behavior — the substitution rules are identical regardless of
// representation — but the framing now describes matching against S, and the
// Markdown-source block at the end exercises old_strings an agent would copy
// straight out of a `representation: "source"` read (## headings, "- " list
// items, fenced code) to prove that path works on the same literal engine.
//
// Critical cases (where regression would be most agent-visible):
//   - zero-match is an ERROR, not a silent no-op (the whole reason the tool
//     matches against the retained SOURCE — a miss must be loud)
//   - multi-match without replace_all is an ERROR reporting the count
//   - replace_all replaces every occurrence and counts them
//   - new_string with `$` specials is inserted LITERALLY (no $&/$1 mangling)
//   - sequential edits operate on the running result

import { applyEdits, countOccurrences } from "../src/edit.ts";

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

// ----- countOccurrences (non-overlapping) -----------------------------------

check("count: absent", countOccurrences("abcdef", "xyz"), 0);
check("count: single", countOccurrences("abcdef", "cd"), 1);
check("count: multiple", countOccurrences("a-a-a", "a"), 3);
check("count: empty needle → 0", countOccurrences("abc", ""), 0);
// Non-overlapping is the count that matches what split/join actually replaces.
check("count: non-overlapping", countOccurrences("aaaa", "aa"), 2);

// ----- single edit, happy path ----------------------------------------------

{
  const r = applyEdits("<h1>Hello</h1>", [{ old_string: "Hello", new_string: "World" }], false);
  check("single: ok", r.ok, true);
  check("single: html", r.ok && r.html, "<h1>World</h1>");
  check("single: replacements", r.ok && r.replacements, 1);
}

// ----- no edits --------------------------------------------------------------

{
  const r = applyEdits("<p>x</p>", [], false);
  check("no_edits: not ok", r.ok, false);
  check("no_edits: code", !r.ok && r.code, "no_edits");
}

// ----- zero match is an error (NOT a silent no-op) ---------------------------
// A miss must be loud: an old_string copied from a stale *rendered* read (H/M)
// won't be found in the retained SOURCE S whenever the two diverge, so the
// agent gets edit_no_match instead of silently editing the wrong representation.

{
  const r = applyEdits("<p>actual</p>", [{ old_string: "expected", new_string: "x" }], false);
  check("edit_no_match: not ok", r.ok, false);
  check("edit_no_match: code", !r.ok && r.code, "edit_no_match");
  check("edit_no_match: index", !r.ok && r.edit_index, 0);
  check("edit_no_match: echoes old_string", !r.ok && r.old_string, "expected");
}

// ----- multi-match without replace_all is an error reporting the count -------

{
  const r = applyEdits("<i>a</i><i>a</i><i>a</i>", [{ old_string: "<i>a</i>", new_string: "<b>z</b>" }], false);
  check("edit_not_unique: not ok", r.ok, false);
  check("edit_not_unique: code", !r.ok && r.code, "edit_not_unique");
  check("edit_not_unique: count", !r.ok && r.count, 3);
}

// ----- multi-match WITH replace_all replaces all and counts ------------------

{
  const r = applyEdits("<i>a</i><i>a</i><i>a</i>", [{ old_string: "<i>a</i>", new_string: "<b>z</b>" }], true);
  check("replace_all: ok", r.ok, true);
  check("replace_all: html", r.ok && r.html, "<b>z</b><b>z</b><b>z</b>");
  check("replace_all: replacements", r.ok && r.replacements, 3);
}

// ----- empty old_string ------------------------------------------------------

{
  const r = applyEdits("<p>x</p>", [{ old_string: "", new_string: "y" }], false);
  check("empty_old_string: not ok", r.ok, false);
  check("empty_old_string: code", !r.ok && r.code, "empty_old_string");
}

// ----- no-op edit (old === new) ---------------------------------------------

{
  const r = applyEdits("<p>x</p>", [{ old_string: "x", new_string: "x" }], false);
  check("noop_edit: not ok", r.ok, false);
  check("noop_edit: code", !r.ok && r.code, "noop_edit");
}

// ----- literal replacement: `$` specials are NOT interpreted -----------------
// String.prototype.replace(string, string) would expand $&, $1, $$ in the
// replacement. applyEdits must insert new_string verbatim.

{
  const r = applyEdits("<p>PRICE</p>", [{ old_string: "PRICE", new_string: "$5 & up" }], false);
  check("literal $: ok", r.ok, true);
  check("literal $: inserted verbatim", r.ok && r.html, "<p>$5 & up</p>");
}
{
  // $& would, under regex-replace semantics, expand to the whole match.
  const r = applyEdits("[match]", [{ old_string: "match", new_string: "$&$1$$" }], false);
  check("literal $&: inserted verbatim", r.ok && r.html, "[$&$1$$]");
}
{
  // replace_all path is split/join, also literal.
  const r = applyEdits("a a", [{ old_string: "a", new_string: "$$" }], true);
  check("literal $ (replace_all): verbatim", r.ok && r.html, "$$ $$");
}

// ----- sequential edits: each runs on the result of the previous ------------

{
  const r = applyEdits(
    "<h1>one</h1>",
    [
      { old_string: "one", new_string: "two" },
      { old_string: "two", new_string: "three" },
    ],
    false,
  );
  check("sequential: ok", r.ok, true);
  check("sequential: final html", r.ok && r.html, "<h1>three</h1>");
  check("sequential: replacements summed", r.ok && r.replacements, 2);
}

// A later edit can match text an earlier edit produced.
{
  const r = applyEdits(
    "X",
    [
      { old_string: "X", new_string: "Y" },
      { old_string: "Y", new_string: "Z" },
    ],
    false,
  );
  check("sequential: later matches earlier output", r.ok && r.html, "Z");
}

// ----- multi-edit error reports the offending index -------------------------

{
  const r = applyEdits(
    "<p>findme</p>",
    [
      { old_string: "findme", new_string: "found" },
      { old_string: "nope", new_string: "x" },
    ],
    false,
  );
  check("multi-edit: second fails", r.ok, false);
  check("multi-edit: code", !r.ok && r.code, "edit_no_match");
  check("multi-edit: edit_index is 1", !r.ok && r.edit_index, 1);
}

// ----- edit can empty the document (surfaced downstream as empty_body) ------
// applyEdits itself doesn't reject an empty result; editDocumentCore delegates
// to updateDocumentCore, which returns empty_body. Here we just confirm the
// substitution produces "".

{
  const r = applyEdits("DELETE_ALL", [{ old_string: "DELETE_ALL", new_string: "" }], false);
  check("empty result: ok at apply layer", r.ok, true);
  check("empty result: html empty", r.ok && r.html, "");
}

// ----- MARKDOWN SOURCE (Case A: edit matches the RETAINED SOURCE) ------------
// Under source retention, editDocumentCore hands applyEdits the doc's retained
// SOURCE S, not the rendered HTML. For a Markdown doc that S is Markdown, so an
// agent copies its old_string out of a `representation:"source"` read — i.e. raw
// Markdown syntax (`## Heading`, a `- item` list line, a ```fenced``` block),
// NOT the <h2>/<ul>/<pre> the renderer would emit. applyEdits is the same
// literal engine either way; these cases prove the Markdown-source old_strings
// an agent would actually paste resolve correctly (and that markdown markup is
// matched/replaced verbatim — `#`, `-`, backticks carry no special meaning).

// An ATX heading line copied verbatim from a source read.
{
  const md = "# Title\n\n## Heading\n\nBody paragraph.\n";
  const r = applyEdits(md, [{ old_string: "## Heading", new_string: "## Overview" }], false);
  check("md heading: ok", r.ok, true);
  check("md heading: source edited (## stays markdown)", r.ok && r.html, "# Title\n\n## Overview\n\nBody paragraph.\n");
  check("md heading: replacements", r.ok && r.replacements, 1);
}

// A single list item edited by its raw "- " bullet line — unique match.
{
  const md = "Shopping:\n\n- apples\n- bananas\n- cherries\n";
  const r = applyEdits(md, [{ old_string: "- bananas", new_string: "- blueberries" }], false);
  check("md list item: ok", r.ok, true);
  check("md list item: only that bullet changes", r.ok && r.html, "Shopping:\n\n- apples\n- blueberries\n- cherries\n");
  check("md list item: replacements", r.ok && r.replacements, 1);
}

// The "- " bullet prefix repeats across items, so an un-anchored "- " old_string
// is ambiguous — edit_not_unique reports the count, mirroring a real source edit
// where the agent must include enough surrounding markdown to be unique.
{
  const md = "- apples\n- bananas\n- cherries\n";
  const r = applyEdits(md, [{ old_string: "- ", new_string: "* " }], false);
  check("md bullet prefix: not ok", r.ok, false);
  check("md bullet prefix: code", !r.ok && r.code, "edit_not_unique");
  check("md bullet prefix: count", !r.ok && r.count, 3);
}

// replace_all over a repeating markdown token (re-style every bullet at once).
{
  const md = "- apples\n- bananas\n- cherries\n";
  const r = applyEdits(md, [{ old_string: "- ", new_string: "* " }], true);
  check("md bullets replace_all: ok", r.ok, true);
  check("md bullets replace_all: every bullet restyled", r.ok && r.html, "* apples\n* bananas\n* cherries\n");
  check("md bullets replace_all: replacements", r.ok && r.replacements, 3);
}

// A fenced code block edited by its raw ``` source — the rendered read would
// show <pre><code>, so this old_string is only matchable against S.
{
  const md = "Run:\n\n```sh\nnpm test\n```\n";
  const r = applyEdits(
    md,
    [{ old_string: "```sh\nnpm test\n```", new_string: "```sh\nnpm run test:edit\n```" }],
    false,
  );
  check("md fenced code: ok", r.ok, true);
  check("md fenced code: block body swapped, fences intact", r.ok && r.html, "Run:\n\n```sh\nnpm run test:edit\n```\n");
  check("md fenced code: replacements", r.ok && r.replacements, 1);
}

// Markdown markup is matched LITERALLY: backticks, `#`, `*` carry no regex/
// special meaning, and `$` in a replacement (a code snippet, a price) is verbatim.
{
  const md = "Inline `code` and a $PATH note.\n";
  const r = applyEdits(md, [{ old_string: "$PATH", new_string: "$HOME" }], false);
  check("md literal specials: ok", r.ok, true);
  check("md literal specials: $ inserted verbatim", r.ok && r.html, "Inline `code` and a $HOME note.\n");
}

// An old_string lifted from a stale RENDERED markdown read (M = htmlToMarkdown(H))
// can diverge from S; here the agent pasted the rendered HTML tag instead of the
// markdown source, so it misses loudly rather than corrupting the wrong bytes.
{
  const md = "## Heading\n";
  const r = applyEdits(md, [{ old_string: "<h2>Heading</h2>", new_string: "<h2>Other</h2>" }], false);
  check("md source vs rendered: rendered old_string misses S", r.ok, false);
  check("md source vs rendered: loud edit_no_match", !r.ok && r.code, "edit_no_match");
}

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall edit tests passed");
}
