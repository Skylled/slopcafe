// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/update-race.ts — what updateDocumentCore reports once every
// race-retry attempt lost its guarded batch (issue #132). Pure function, same
// Node-strip-types harness as the other test/*.test.mjs files. The races that
// lead here are exercised against wrangler dev by test/e2e/write-races.sh; an
// exhausted retry with NO version change (three straight slug/visibility
// losses) can't be forced there deterministically, which is why this decision
// lives in a leaf and is pinned here.

import { readFileSync } from "node:fs";
import { exhaustedRaceOutcome, MAX_UPDATE_ATTEMPTS } from "../src/update-race.ts";

let fails = 0;

function checkDeep(label, got, want) {
  const okEq = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${okEq ? "ok  " : "FAIL"} ${label}`);
  if (!okEq) {
    console.log(`  want: ${JSON.stringify(want)}`);
    console.log(`  got:  ${JSON.stringify(got)}`);
    fails++;
  }
}

const live = (v) => ({ current_ver: v, revoked_at: null });

// --- the formerly-500 case: version unchanged after every loss -------------
checkDeep(
  "pinned write, version unchanged → retryable version_conflict, concurrent_change",
  exhaustedRaceOutcome(live(5), 5, 5),
  { ok: false, code: "version_conflict", current_version: 5, expected: 5, concurrent_change: true },
);
checkDeep(
  "clobber write (expected = base), version unchanged → concurrent_change",
  exhaustedRaceOutcome(live(5), null, 5),
  { ok: false, code: "version_conflict", current_version: 5, expected: 5, concurrent_change: true },
);

// --- version moved: an ordinary conflict ------------------------------------
checkDeep(
  "clobber write under sustained contention → version_conflict against the fresh read",
  exhaustedRaceOutcome(live(9), null, 7),
  { ok: false, code: "version_conflict", current_version: 9, expected: 7, concurrent_change: false },
);
checkDeep(
  "pinned write, version moved → version_conflict naming the pin",
  exhaustedRaceOutcome(live(6), 5, 5),
  { ok: false, code: "version_conflict", current_version: 6, expected: 5, concurrent_change: false },
);

// --- the document died ------------------------------------------------------
checkDeep("no row → not_found", exhaustedRaceOutcome(null, 5, 5), { ok: false, code: "not_found" });
checkDeep(
  "revoked → not_found",
  exhaustedRaceOutcome({ current_ver: null, revoked_at: "2026-09-29T00:00:00.000Z" }, 5, 5),
  { ok: false, code: "not_found" },
);
checkDeep(
  "revoked with a stale current_ver → still not_found (revoked_at wins)",
  exhaustedRaceOutcome({ current_ver: 5, revoked_at: "2026-09-29T00:00:00.000Z" }, null, 5),
  { ok: false, code: "not_found" },
);

checkDeep("MAX_UPDATE_ATTEMPTS stays small", MAX_UPDATE_ATTEMPTS >= 2 && MAX_UPDATE_ATTEMPTS <= 5, true);

// --- source pins: the write path uses this, and never throws on exhaustion ---
const write = readFileSync(new URL("../src/document-write.ts", import.meta.url), "utf8");
checkDeep("document-write.ts routes the exhausted retry through exhaustedRaceOutcome",
  /exhaustedRaceOutcome\(now, expectedVersion, lost!\.base\)/.test(write), true);
checkDeep("document-write.ts no longer throws after losing every attempt",
  /throw new Error\(`update lost/.test(write), false);
// The flag is internal: no door may put it on the wire (ErrorBody members are
// additionalProperties:false). Every door reads it only to choose a message.
for (const f of ["src/index.ts", "src/admin-documents.ts", "src/mcp-write-errors.ts"]) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  checkDeep(`${f} reads concurrent_change only as a message switch`,
    [...src.matchAll(/concurrent_change/g)].length ===
      [...src.matchAll(/\.concurrent_change\b/g)].length && !/concurrent_change\s*:/.test(src), true);
}

if (fails > 0) {
  console.log(`\n${fails} update-race test(s) FAILED`);
  process.exit(1);
}
console.log("\nall update-race tests passed");
