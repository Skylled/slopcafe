// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for the pure access-control core in src/access.ts — the single-tenant
// `can_access` primitive introduced with document visibility (GitHub issue #7).
//
// Same Node-strip-types harness as the other test/*.test.mjs files; needs the
// .ts resolver because access.ts imports auth.ts / session.ts (which resolve
// `.js` specifiers to their `.ts` sources). None of that graph pulls the WASM
// sanitizer, so it loads fine here.
//
// What we pin: the read decision matrix (a private doc must be 404-to-anonymous
// but readable by operator/agent; revoked beats everything) and the
// visibility-parsing clamp (a bad config value must fall back to the SAFER
// `private`, never throw or leak `public`). The request-resolving wrapper
// (resolvePrincipal) reads real auth/env/Request and is exercised end-to-end via
// wrangler dev, exactly like session.ts's env-aware wrappers.

import { canRead, defaultDocumentVisibility, parseVisibility } from "../src/access.ts";

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

const OPERATOR = { kind: "operator" };
const AGENT = { kind: "agent", agentId: "agent-1" };
const ANON = { kind: "anonymous" };

// ----- canRead: live public ------------------------------------------------
// Public + live → readable by everyone, including the open web.

check("operator reads live public", canRead(OPERATOR, { visibility: "public", revoked: false }), true);
check("agent reads live public", canRead(AGENT, { visibility: "public", revoked: false }), true);
check("anonymous reads live public", canRead(ANON, { visibility: "public", revoked: false }), true);

// ----- canRead: live private -----------------------------------------------
// Private is the WHOLE point: inner circle reads it, the open web cannot.

check("operator reads live private", canRead(OPERATOR, { visibility: "private", revoked: false }), true);
check("agent reads live private", canRead(AGENT, { visibility: "private", revoked: false }), true);
check("anonymous DENIED live private", canRead(ANON, { visibility: "private", revoked: false }), false);

// ----- canRead: revoked beats everything -----------------------------------
// Defense-in-depth: even an operator/agent gets false on a revoked row, so a
// caller that forgets to exclude revoked rows still fails closed.

check("operator denied revoked public", canRead(OPERATOR, { visibility: "public", revoked: true }), false);
check("agent denied revoked public", canRead(AGENT, { visibility: "public", revoked: true }), false);
check("anonymous denied revoked public", canRead(ANON, { visibility: "public", revoked: true }), false);
check("operator denied revoked private", canRead(OPERATOR, { visibility: "private", revoked: true }), false);
check("anonymous denied revoked private", canRead(ANON, { visibility: "private", revoked: true }), false);

// ----- parseVisibility: strict value, safe failure -------------------------
// Only the exact string "public" yields public; everything else clamps to the
// SAFER private. Case-sensitive on purpose (the column CHECK is lowercase).

check('parseVisibility "public"', parseVisibility("public"), "public");
check('parseVisibility "private"', parseVisibility("private"), "private");
check('parseVisibility "publik" → private', parseVisibility("publik"), "private");
check('parseVisibility "PUBLIC" → private', parseVisibility("PUBLIC"), "private");
check('parseVisibility "" → private', parseVisibility(""), "private");
check("parseVisibility null → private", parseVisibility(null), "private");
check("parseVisibility undefined → private", parseVisibility(undefined), "private");

// ----- defaultDocumentVisibility: the deploy-time birth toggle -------------
// An operator typo in the [var] must NOT 500 every publish via the 0011 CHECK —
// it clamps to private. Unset → private (born-private default).

check(
  "default toggle public",
  defaultDocumentVisibility({ DEFAULT_DOCUMENT_VISIBILITY: "public" }),
  "public",
);
check(
  "default toggle private",
  defaultDocumentVisibility({ DEFAULT_DOCUMENT_VISIBILITY: "private" }),
  "private",
);
check("default toggle unset → private", defaultDocumentVisibility({}), "private");
check(
  "default toggle garbage → private",
  defaultDocumentVisibility({ DEFAULT_DOCUMENT_VISIBILITY: "garbage" }),
  "private",
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall access tests passed");
}
