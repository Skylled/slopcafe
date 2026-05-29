// Coverage for src/edit.ts — the pure find/replace logic behind the
// `edit_document` MCP tool and editDocumentCore.
//
// Same Node-strip-types harness as the other test/*.test.mjs files. Pure
// functions only: editDocumentCore's D1/R2/FTS plumbing imports the WASM
// sanitizer (can't load under --experimental-strip-types) and is exercised
// end-to-end via wrangler dev, exactly like the FTS path in search.test.mjs.
//
// Critical cases (where regression would be most agent-visible):
//   - zero-match is an ERROR, not a silent no-op (the whole reason the tool
//     matches against stored bytes — a miss must be loud)
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

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall edit tests passed");
}
