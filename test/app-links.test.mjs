// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/app-links.ts — the App Links / Universal Links verification
// files behind GitHub issue #50.
//
// Two things pinned here:
//   1. `appLinksConfig` — the single reader/validator of the three [var]s.
//      Off-by-default (unset → null), all-or-nothing for Android (either half
//      missing or malformed degrades the WHOLE platform to unconfigured, never
//      a partial/wrong statement), and independent per platform (a broken
//      Apple var must not disable a valid Android one, and vice versa).
//   2. The two pure JSON builders produce exactly the documented shapes.
//
// Same Node strip-types harness as src/cors.ts (its closest analog — a leaf
// module whose only cross-file import is the erased `Env` type).

import {
  appLinksConfig,
  buildAndroidAssetLinks,
  buildAppleAppSiteAssociation,
} from "../src/app-links.ts";

let fails = 0;

function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails++;
}

function eq(label, got, want) {
  const gotJson = JSON.stringify(got);
  const wantJson = JSON.stringify(want);
  const same = gotJson === wantJson;
  console.log(`${same ? "ok  " : "FAIL"} ${label}`);
  if (!same) {
    console.log(`  want: ${wantJson}`);
    console.log(`  got:  ${gotJson}`);
    fails++;
  }
}

function env(vars) {
  return vars;
}

// ----- appLinksConfig: fully unset -------------------------------------------

{
  const cfg = appLinksConfig(env({}));
  check("unset: android is null", cfg.android === null);
  check("unset: apple is null", cfg.apple === null);
}

// ----- Android: happy path ---------------------------------------------------

const GOOD_FP_1 = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const GOOD_FP_2 = "11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF";

{
  const cfg = appLinksConfig(
    env({
      APP_LINKS_ANDROID_PACKAGE: "com.example.slopcafe",
      APP_LINKS_ANDROID_SHA256: GOOD_FP_1,
    }),
  );
  check("android: valid package + one fingerprint parses", cfg.android !== null);
  eq("android: package name preserved", cfg.android?.packageName, "com.example.slopcafe");
  eq("android: one fingerprint, uppercased", cfg.android?.fingerprints, [GOOD_FP_1.toUpperCase()]);
}

{
  // lowercase hex + extra whitespace around the comma — both should be
  // tolerated and normalized.
  const cfg = appLinksConfig(
    env({
      APP_LINKS_ANDROID_PACKAGE: "com.example.slopcafe",
      APP_LINKS_ANDROID_SHA256: `  ${GOOD_FP_1.toLowerCase()} ,  ${GOOD_FP_2.toLowerCase()}  `,
    }),
  );
  check("android: multiple comma-separated fingerprints parse", cfg.android !== null);
  eq("android: both fingerprints present, uppercased, order preserved", cfg.android?.fingerprints, [
    GOOD_FP_1.toUpperCase(),
    GOOD_FP_2.toUpperCase(),
  ]);
}

// ----- Android: all-or-nothing -----------------------------------------------

{
  const cfg = appLinksConfig(env({ APP_LINKS_ANDROID_PACKAGE: "com.example.slopcafe" }));
  check("android: package set, sha256 unset → null (all-or-nothing)", cfg.android === null);
}

{
  const cfg = appLinksConfig(env({ APP_LINKS_ANDROID_SHA256: GOOD_FP_1 }));
  check("android: sha256 set, package unset → null (all-or-nothing)", cfg.android === null);
}

{
  const cfg = appLinksConfig(
    env({ APP_LINKS_ANDROID_PACKAGE: "  ", APP_LINKS_ANDROID_SHA256: "  " }),
  );
  check("android: both whitespace-only → null", cfg.android === null);
}

// ----- Android: malformed package name ---------------------------------------

for (const bad of ["", "com", "1com.example", "com.example.", "com..example", "com example.app", "com.example.app!"]) {
  const cfg = appLinksConfig(
    env({ APP_LINKS_ANDROID_PACKAGE: bad, APP_LINKS_ANDROID_SHA256: GOOD_FP_1 }),
  );
  check(`android: malformed package ${JSON.stringify(bad)} → null`, cfg.android === null);
}

check(
  "android: single-segment package (no dot) → null",
  appLinksConfig(env({ APP_LINKS_ANDROID_PACKAGE: "example", APP_LINKS_ANDROID_SHA256: GOOD_FP_1 })).android ===
    null,
);

// ----- Android: malformed / mixed fingerprints --------------------------------

for (const bad of [
  "not-a-fingerprint",
  "AA:BB:CC", // too short
  `${GOOD_FP_1}:FF`, // too long
  "GG:" + GOOD_FP_1.slice(3), // non-hex byte
  "AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899", // no colons
]) {
  const cfg = appLinksConfig(
    env({ APP_LINKS_ANDROID_PACKAGE: "com.example.slopcafe", APP_LINKS_ANDROID_SHA256: bad }),
  );
  check(`android: malformed fingerprint ${JSON.stringify(bad)} → null`, cfg.android === null);
}

{
  // One good, one bad in a comma list: the WHOLE list is rejected, not just
  // the bad entry — a silently-shortened trust list is a worse failure mode
  // than "unconfigured."
  const cfg = appLinksConfig(
    env({
      APP_LINKS_ANDROID_PACKAGE: "com.example.slopcafe",
      APP_LINKS_ANDROID_SHA256: `${GOOD_FP_1},not-a-fingerprint`,
    }),
  );
  check("android: one bad fingerprint among good ones rejects the whole list", cfg.android === null);
}

{
  // Only commas / whitespace, no actual fingerprint content.
  const cfg = appLinksConfig(
    env({ APP_LINKS_ANDROID_PACKAGE: "com.example.slopcafe", APP_LINKS_ANDROID_SHA256: " , , " }),
  );
  check("android: fingerprint list with no real entries → null", cfg.android === null);
}

// ----- Apple: happy path + malformed -----------------------------------------

{
  const cfg = appLinksConfig(env({ APP_LINKS_APPLE_APP_ID: "ABCDE12345.com.example.slopcafe" }));
  check("apple: valid TEAMID.bundle.id parses", cfg.apple !== null);
  eq("apple: appId preserved verbatim", cfg.apple?.appId, "ABCDE12345.com.example.slopcafe");
}

for (const bad of [
  "",
  "TOOSHORT.com.example",
  "ABCDE123456.com.example", // 11-char team id
  "abcde12345.com.example", // lowercase team id
  "ABCDE12345", // no bundle id at all
  "ABCDE12345.",
  "ABCDE-2345.com.example", // hyphen in team id
]) {
  const cfg = appLinksConfig(env({ APP_LINKS_APPLE_APP_ID: bad }));
  check(`apple: malformed app id ${JSON.stringify(bad)} → null`, cfg.apple === null);
}

// ----- platforms resolve independently ---------------------------------------

{
  const cfg = appLinksConfig(
    env({
      APP_LINKS_ANDROID_PACKAGE: "com.example.slopcafe",
      APP_LINKS_ANDROID_SHA256: GOOD_FP_1,
      APP_LINKS_APPLE_APP_ID: "not-valid",
    }),
  );
  check("mixed: valid android survives an invalid apple var", cfg.android !== null);
  check("mixed: invalid apple var → apple null", cfg.apple === null);
}

{
  const cfg = appLinksConfig(
    env({
      APP_LINKS_ANDROID_PACKAGE: "not valid!",
      APP_LINKS_APPLE_APP_ID: "ABCDE12345.com.example.slopcafe",
    }),
  );
  check("mixed: valid apple survives an invalid android package", cfg.apple !== null);
  check("mixed: invalid android package (sha256 also unset) → android null", cfg.android === null);
}

// ----- buildAndroidAssetLinks: exact shape ------------------------------------

eq(
  "buildAndroidAssetLinks: single-fingerprint shape",
  buildAndroidAssetLinks({ packageName: "com.example.slopcafe", fingerprints: [GOOD_FP_1] }),
  [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "com.example.slopcafe",
        sha256_cert_fingerprints: [GOOD_FP_1],
      },
    },
  ],
);

eq(
  "buildAndroidAssetLinks: multi-fingerprint shape, order preserved",
  buildAndroidAssetLinks({ packageName: "com.example.slopcafe", fingerprints: [GOOD_FP_1, GOOD_FP_2] })[0].target
    .sha256_cert_fingerprints,
  [GOOD_FP_1, GOOD_FP_2],
);

check(
  "buildAndroidAssetLinks: exactly one statement",
  buildAndroidAssetLinks({ packageName: "com.example.slopcafe", fingerprints: [GOOD_FP_1] }).length === 1,
);

// ----- buildAppleAppSiteAssociation: exact shape ------------------------------

eq(
  "buildAppleAppSiteAssociation: components form, apps empty, /d/* and /s/* covered",
  buildAppleAppSiteAssociation({ appId: "ABCDE12345.com.example.slopcafe" }),
  {
    applinks: {
      apps: [],
      components: [{ appID: "ABCDE12345.com.example.slopcafe", paths: ["/d/*", "/s/*"] }],
    },
  },
);

// The deprecated top-level `details` key must never appear — a host still
// running an old iOS that only understands `details` should see nothing
// rather than a shape that half-matches two competing formats.
check(
  "buildAppleAppSiteAssociation: no deprecated `details` key",
  !("details" in buildAppleAppSiteAssociation({ appId: "ABCDE12345.com.example.slopcafe" }).applinks),
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} app-links test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall app-links tests passed");
}
