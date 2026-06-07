// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/integrity.ts — the optional X-Content-SHA256 content
// handshake on the HTTP write path. Pure-function tests in the same
// Node-strip-types harness as the other test/*.test.mjs files. Web Crypto
// (crypto.subtle) is a global in the Node runtime just as it is in Workers,
// so verifyContentIntegrity runs unchanged here.
//
// The end-to-end wiring (header → arrayBuffer → 400/422 Response) lives in
// src/index.ts readVerifiedBody and is exercised via wrangler dev; these
// tests pin the pure pieces the Response shape is built from.

import {
  normalizeExpectedSha256,
  sha256Hex,
  verifyContentIntegrity,
} from "../src/integrity.ts";

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

function checkObj(label, got, want) {
  const okEq = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${okEq ? "ok  " : "FAIL"} ${label}`);
  if (!okEq) {
    console.log(`  want: ${JSON.stringify(want)}`);
    console.log(`  got:  ${JSON.stringify(got)}`);
    fails++;
  }
}

const enc = new TextEncoder();

// Known-answer vectors so the digest itself is pinned, not just self-consistency.
// echo -n "" | sha256sum ; echo -n "abc" | sha256sum
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

// ----- sha256Hex known-answer ----------------------------------------------

check("sha256Hex('')", await sha256Hex(enc.encode("")), SHA_EMPTY);
check("sha256Hex('abc')", await sha256Hex(enc.encode("abc")), SHA_ABC);

// ----- normalizeExpectedSha256 ---------------------------------------------

checkObj("absent header → no check", normalizeExpectedSha256(null), {
  ok: true,
  value: null,
});
checkObj("plain 64-hex passes", normalizeExpectedSha256(SHA_ABC), {
  ok: true,
  value: SHA_ABC,
});
checkObj("uppercase folded to lowercase", normalizeExpectedSha256(SHA_ABC.toUpperCase()), {
  ok: true,
  value: SHA_ABC,
});
checkObj("sha256: prefix stripped", normalizeExpectedSha256(`sha256:${SHA_ABC}`), {
  ok: true,
  value: SHA_ABC,
});
checkObj("SHA256: prefix (case-insensitive) stripped", normalizeExpectedSha256(`SHA256:${SHA_ABC}`), {
  ok: true,
  value: SHA_ABC,
});
checkObj("surrounding whitespace trimmed", normalizeExpectedSha256(`  ${SHA_ABC}  `), {
  ok: true,
  value: SHA_ABC,
});
checkObj("too short → malformed", normalizeExpectedSha256("abc123"), { ok: false });
checkObj("too long → malformed", normalizeExpectedSha256(SHA_ABC + "ab"), { ok: false });
checkObj(
  "non-hex chars → malformed",
  normalizeExpectedSha256("g".repeat(64)),
  { ok: false },
);
checkObj("empty string → malformed", normalizeExpectedSha256(""), { ok: false });

// ----- verifyContentIntegrity ----------------------------------------------

checkObj(
  "null expectation is a no-op pass",
  await verifyContentIntegrity(enc.encode("anything"), null),
  { ok: true },
);
checkObj(
  "matching hash passes",
  await verifyContentIntegrity(enc.encode("abc"), SHA_ABC),
  { ok: true },
);

// Truncation is the headline failure mode: a body that lost its tail hashes
// differently and the verdict carries the actionable detail.
const full = "<h1>Report</h1>".repeat(100);
const fullSha = await sha256Hex(enc.encode(full));
const truncated = full.slice(0, full.length - 50); // dropped tail, still valid-ish HTML
const truncatedVerdict = await verifyContentIntegrity(enc.encode(truncated), fullSha);
check("truncated body fails", truncatedVerdict.ok, false);
check("verdict echoes expected", truncatedVerdict.expected, fullSha);
check(
  "verdict reports actual hash of received bytes",
  truncatedVerdict.actual,
  await sha256Hex(enc.encode(truncated)),
);
check(
  "verdict reports received byte count",
  truncatedVerdict.received_bytes,
  enc.encode(truncated).byteLength,
);

// A placeholder swap ("[unchanged]") is the other observed failure: same-ish
// length, different bytes → caught.
const placeholder = full.slice(0, 200) + "[unchanged]" + full.slice(211);
checkObj(
  "placeholder substitution fails",
  await verifyContentIntegrity(enc.encode(placeholder), fullSha).then((v) => ({ ok: v.ok })),
  { ok: false },
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall integrity tests passed");
}
