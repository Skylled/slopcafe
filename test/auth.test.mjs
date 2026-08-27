// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for the pure helpers in src/auth.ts:
//
//   1. The expiry boundary behind short-lived publish credentials (migration
//      0007 + mintEphemeralKey), where an off-by-one would silently grant or
//      deny access at the edge.
//   2. The two comma-separated config lists the insight fork's auth model rests
//      on — `READER_TOKENS` (the human read-only tier) and `WRITER_AGENT_IDS`
//      (the single-publisher write allowlist) — plus `agentMayWrite`, the one
//      predicate behind `403 read_only_agent`. Pure (config in, decision out),
//      so the whole rule is pinned here rather than only in a live Worker.
//
// authenticateAgent / mintEphemeralKey themselves hit D1 and are exercised
// end-to-end via wrangler dev (no D1 mock in v1).
//
// Same Node-strip-types harness as the other test/*.test.mjs files.

import {
  agentMayWrite,
  computeExpiresAt,
  isKeyExpired,
  matchReaderToken,
  matchTokenInList,
  parseTokenList,
  readerTokens,
  writerAgentIds,
} from "../src/auth.ts";

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

// ----- isKeyExpired ---------------------------------------------------------

const NOW = Date.parse("2026-05-29T12:00:00.000Z");

check("null never expires", isKeyExpired(null, NOW), false);
check(
  "future stamp is still valid",
  isKeyExpired("2026-05-29T12:15:00.000Z", NOW),
  false,
);
check(
  "past stamp is expired",
  isKeyExpired("2026-05-29T11:45:00.000Z", NOW),
  true,
);
// Boundary: expiry is inclusive (<=), so a key is dead exactly at its stamp.
check(
  "equal stamp is expired (inclusive)",
  isKeyExpired("2026-05-29T12:00:00.000Z", NOW),
  true,
);
check(
  "one ms before now → valid",
  isKeyExpired("2026-05-29T12:00:00.001Z", NOW),
  false,
);
check(
  "one ms after now-stamp → expired",
  isKeyExpired("2026-05-29T11:59:59.999Z", NOW),
  true,
);
// Fail closed: a stamp we can't parse must not read as "valid forever".
check("unparseable stamp fails closed (expired)", isKeyExpired("not-a-date", NOW), true);
check("empty string fails closed (expired)", isKeyExpired("", NOW), true);

// ----- computeExpiresAt -----------------------------------------------------

check(
  "computeExpiresAt adds ttl seconds, ISO Z form",
  computeExpiresAt(NOW, 900),
  "2026-05-29T12:15:00.000Z",
);
check(
  "computeExpiresAt 60s",
  computeExpiresAt(NOW, 60),
  "2026-05-29T12:01:00.000Z",
);

// Round-trip: a freshly minted key is NOT yet expired at mint time, and IS
// expired one ms past its computed stamp. This is the property that matters —
// the two helpers agree on the same clock.
const exp = computeExpiresAt(NOW, 900);
check("minted key not expired at mint instant", isKeyExpired(exp, NOW), false);
check("minted key not expired just before stamp", isKeyExpired(exp, NOW + 899_999), false);
check("minted key expired at its stamp", isKeyExpired(exp, NOW + 900_000), true);

// ============================================================================
// parseTokenList — the shared parser for READER_TOKENS and WRITER_AGENT_IDS
// ============================================================================
//
// Both features read `[]` as "feature off", so the empty cases are the ones
// worth being exact about: a typo'd WRITER_AGENT_IDS that parsed to a
// single-empty-string list would lock the publisher out of its own corpus.

const listEq = (label, got, want) => check(label, JSON.stringify(got), JSON.stringify(want));

listEq("undefined → []", parseTokenList(undefined), []);
listEq("null → []", parseTokenList(null), []);
listEq("empty string → []", parseTokenList(""), []);
listEq("whitespace only → []", parseTokenList("   "), []);
listEq("bare commas → []", parseTokenList(",,,"), []);
listEq("single value", parseTokenList("alpha"), ["alpha"]);
listEq("comma-separated", parseTokenList("alpha,beta"), ["alpha", "beta"]);
listEq("surrounding whitespace trimmed", parseTokenList(" alpha , beta "), ["alpha", "beta"]);
listEq("trailing comma dropped", parseTokenList("alpha,beta,"), ["alpha", "beta"]);
listEq("empty middle entry dropped", parseTokenList("alpha,,beta"), ["alpha", "beta"]);
listEq("newlines are whitespace", parseTokenList("alpha,\n beta\n"), ["alpha", "beta"]);
listEq("duplicates collapse", parseTokenList("alpha,beta,alpha"), ["alpha", "beta"]);
// Interior spaces are NOT stripped — only the ends. A token is whatever the
// operator pasted between the commas.
listEq("interior spaces preserved", parseTokenList("a b,c"), ["a b", "c"]);

// ============================================================================
// matchTokenInList / matchReaderToken — the constant-time reader lookup
// ============================================================================

const TOKENS = ["reader-alice-secret", "reader-bob-secret", "reader-carol-secret"];

check("match returns the matched token", matchTokenInList("reader-bob-secret", TOKENS), "reader-bob-secret");
check("first entry matches", matchTokenInList("reader-alice-secret", TOKENS), "reader-alice-secret");
check("last entry matches", matchTokenInList("reader-carol-secret", TOKENS), "reader-carol-secret");
check("non-member → null", matchTokenInList("reader-mallory-secret", TOKENS), null);
check("empty candidate → null", matchTokenInList("", TOKENS), null);
check("null candidate → null", matchTokenInList(null, TOKENS), null);
check("undefined candidate → null", matchTokenInList(undefined, TOKENS), null);
check("empty list → null (feature off)", matchTokenInList("reader-alice-secret", []), null);
// Prefix/suffix of a real token must NOT match — the compare is whole-string,
// and timingSafeEqual folds the length difference into the accumulator.
check("prefix of a token → null", matchTokenInList("reader-alice", TOKENS), null);
check("token plus a suffix → null", matchTokenInList("reader-alice-secretX", TOKENS), null);
// Case matters; tokens are opaque secrets, not identifiers.
check("case mismatch → null", matchTokenInList("Reader-Alice-Secret", TOKENS), null);

// The env-reading wrapper agrees with the pure one, and an unset secret means
// the tier simply does not exist.
check(
  "matchReaderToken reads READER_TOKENS",
  matchReaderToken("reader-bob-secret", { READER_TOKENS: TOKENS.join(",") }),
  "reader-bob-secret",
);
check("matchReaderToken unset env → null", matchReaderToken("reader-bob-secret", {}), null);
check(
  "matchReaderToken empty secret → null",
  matchReaderToken("reader-bob-secret", { READER_TOKENS: "" }),
  null,
);
listEq("readerTokens unset → []", readerTokens({}), []);
listEq("readerTokens parses", readerTokens({ READER_TOKENS: "a, b" }), ["a", "b"]);

// ============================================================================
// WRITER_AGENT_IDS — the single-publisher write allowlist
// ============================================================================

// Real-shaped agent ids (UUIDs with hex LETTERS, so the case check below is
// actually testing something).
const PIPELINE = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER = "f0e1d2c3-b4a5-4968-8778-695a4b3c2d1e";
const ALLOWED_ENV = { WRITER_AGENT_IDS: PIPELINE };
const opAuthor = { kind: "operator" };
const writer = { kind: "agent", agentId: PIPELINE };
const stranger = { kind: "agent", agentId: OTHER };

check("writerAgentIds unset → empty set", writerAgentIds({}).size, 0);
check("writerAgentIds parses", writerAgentIds({ WRITER_AGENT_IDS: `${PIPELINE},${OTHER}` }).size, 2);
check("writerAgentIds membership", writerAgentIds(ALLOWED_ENV).has(PIPELINE), true);

// BACKWARD COMPATIBILITY — the property that keeps the pipeline publishing
// before the var is ever set. Every one of these must be `true`.
check("empty var: any agent may write", agentMayWrite({}, stranger), true);
check("empty-string var: any agent may write", agentMayWrite({ WRITER_AGENT_IDS: "" }, stranger), true);
check("whitespace var: any agent may write", agentMayWrite({ WRITER_AGENT_IDS: "  " }, stranger), true);
check("comma-only var: any agent may write", agentMayWrite({ WRITER_AGENT_IDS: ",," }, stranger), true);

// Allowlist configured.
check("listed agent may write", agentMayWrite(ALLOWED_ENV, writer), true);
check("unlisted agent may NOT write", agentMayWrite(ALLOWED_ENV, stranger), false);
check(
  "listed among several may write",
  agentMayWrite({ WRITER_AGENT_IDS: `${OTHER}, ${PIPELINE}` }, writer),
  true,
);
check(
  "whitespace around the id still matches",
  agentMayWrite({ WRITER_AGENT_IDS: `  ${PIPELINE}  ` }, writer),
  true,
);
// Ids are matched whole and exactly — no prefix, no case folding.
check(
  "prefix of a listed id is refused",
  agentMayWrite(ALLOWED_ENV, { kind: "agent", agentId: PIPELINE.slice(0, 8) }),
  false,
);
check(
  "uppercased id is refused",
  agentMayWrite(ALLOWED_ENV, { kind: "agent", agentId: PIPELINE.toUpperCase() }),
  false,
);

// THE OPERATOR IS NEVER CONSTRAINED — WRITER_AGENT_IDS scopes the agent fleet,
// and the operator has its own door and its own credential.
check("operator writes with an allowlist set", agentMayWrite(ALLOWED_ENV, opAuthor), true);
check("operator writes with no allowlist", agentMayWrite({}, opAuthor), true);
check(
  "operator writes even when the list names other agents",
  agentMayWrite({ WRITER_AGENT_IDS: OTHER }, opAuthor),
  true,
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall auth tests passed");
}
