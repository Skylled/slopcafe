// Coverage for the pure expiry helpers in src/auth.ts — the boundary logic
// behind short-lived publish credentials (migration 0007 + mintEphemeralKey).
// Same Node-strip-types harness as the other test/*.test.mjs files.
//
// authenticateAgent / mintEphemeralKey themselves hit D1 and are exercised
// end-to-end via wrangler dev (no D1 mock in v1); what we pin here is the
// clock-comparison rule, where an off-by-one would silently grant or deny
// access at the expiry edge.

import { computeExpiresAt, isKeyExpired } from "../src/auth.ts";

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

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall auth tests passed");
}
