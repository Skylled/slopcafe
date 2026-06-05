// Coverage for src/vector.ts — the pure hybrid-search helpers for the CHUNKED
// design (N vectors per document, vector-search-design.md §2.1/§5):
//   reciprocalRankFusion  — rank-only fusion of keyword + semantic doc lists
//   chunkEmbedInputs       — split a doc into the per-chunk embed texts
//   collapseChunksToDocs   — fold chunk hits back to one entry per document
//   chunkVectorId / docIdFromChunkId / chunkVectorIdRange — the ${docId}#${i}
//                            vector-ID convention (single-sourced here)
// Same Node-strip-types harness as the other test/*.test.mjs files. Nothing
// imports src/vector.ts yet — this is inert prep landed ahead of the feature, so
// the fusion + chunk contract are pinned before anything depends on them.

import {
  MAX_CHUNKS,
  chunkEmbedInputs,
  chunkVectorId,
  chunkVectorIdRange,
  collapseChunksToDocs,
  docIdFromChunkId,
  reciprocalRankFusion,
} from "../src/vector.ts";

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

// ===== reciprocalRankFusion =================================================

// ----- single list preserves order -----------------------------------------

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

// ===== chunkEmbedInputs =====================================================

// ----- short docs: one chunk, head leads ------------------------------------

checkJson("short doc → one chunk, head then body", chunkEmbedInputs("T", "D", "Body here."), [
  "T\n\nD\n\nBody here.",
]);
checkJson("no head → body-only chunk", chunkEmbedInputs(null, null, "Body here."), ["Body here."]);
checkJson("empty body + head → metadata-only chunk", chunkEmbedInputs("T", "D", ""), ["T\n\nD"]);
checkJson("empty body + no head → no chunks", chunkEmbedInputs(null, null, ""), []);
checkJson("whitespace-only everywhere → no chunks", chunkEmbedInputs("  ", null, "   \n  "), []);

// ----- heading/paragraph blocks are preserved and rejoined ------------------

// A heading starts a block even without a preceding blank line; two short
// sections pack into one window joined by a blank line.
checkJson(
  "headings start blocks, repack with blank-line join",
  chunkEmbedInputs(null, null, "# Title\nIntro para.\n\n## Section\nMore text."),
  ["# Title\nIntro para.\n\n## Section\nMore text."],
);

// ----- long docs: multiple chunks, head ONLY in chunk 0 ---------------------

const para = (n) => `Paragraph ${n}: ` + "lorem ".repeat(80); // ~493 chars each
const longBody = Array.from({ length: 6 }, (_, i) => para(i)).join("\n\n"); // ~3 KB → splits
const longChunks = chunkEmbedInputs("T", "D", longBody);

check("long doc splits into >1 chunk", longChunks.length > 1, true);
check("chunk 0 carries the metadata head", longChunks[0].startsWith("T\n\nD\n\n"), true);
check("chunk 1 is body-only (no head)", longChunks[1].includes("T\n\nD"), false);
check("every non-zero chunk omits the head", longChunks.slice(1).some((c) => c.includes("T\n\nD")), false);

// ----- MAX_CHUNKS cap + determinism -----------------------------------------

const hugeBody = Array.from({ length: 120 }, (_, i) => para(i)).join("\n\n");
check("body past the cap is dropped at MAX_CHUNKS", chunkEmbedInputs("T", "D", hugeBody).length, MAX_CHUNKS);
checkJson(
  "chunking is deterministic (same input → same output)",
  chunkEmbedInputs("T", "D", longBody),
  chunkEmbedInputs("T", "D", longBody),
);

// ===== collapseChunksToDocs =================================================

checkJson(
  "chunks fold to best score per doc, ordered desc",
  collapseChunksToDocs([
    { id: "A#0", score: 0.5 },
    { id: "A#3", score: 0.9 },
    { id: "B#0", score: 0.7 },
  ]),
  [
    { id: "A", score: 0.9 },
    { id: "B", score: 0.7 },
  ],
);
checkJson(
  "equal scores tie-break by doc id asc",
  collapseChunksToDocs([
    { id: "B#0", score: 0.5 },
    { id: "A#0", score: 0.5 },
  ]),
  [
    { id: "A", score: 0.5 },
    { id: "B", score: 0.5 },
  ],
);
checkJson(
  "falsy ids skipped",
  collapseChunksToDocs([
    { id: "", score: 1 },
    { id: "A#0", score: 0.2 },
  ]),
  [{ id: "A", score: 0.2 }],
);
checkJson(
  "id with no '#' is treated as a whole doc id",
  collapseChunksToDocs([{ id: "plain", score: 1 }]),
  [{ id: "plain", score: 1 }],
);

// ===== chunk-id convention ==================================================

check("chunkVectorId joins on '#'", chunkVectorId("uuid", 3), "uuid#3");
check("docIdFromChunkId strips the chunk index", docIdFromChunkId("uuid#3"), "uuid");
check("docIdFromChunkId on a bare id is identity", docIdFromChunkId("uuid"), "uuid");
check("id convention round-trips", docIdFromChunkId(chunkVectorId("uuid", 5)), "uuid");
check("range covers exactly MAX_CHUNKS ids", chunkVectorIdRange("u").length, MAX_CHUNKS);
check("range starts at #0", chunkVectorIdRange("u")[0], "u#0");
check("range ends at #(MAX_CHUNKS-1)", chunkVectorIdRange("u")[MAX_CHUNKS - 1], `u#${MAX_CHUNKS - 1}`);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall vector tests passed");
}
