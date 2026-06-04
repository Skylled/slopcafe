// Coverage for src/contract.ts — the Zod source of truth for the API contract
// (Phase 1 of api-contract-design.md). Pure-schema tests in the same
// Node-strip-types harness as the other test/*.test.mjs files. contract.ts is a
// leaf module (only runtime dep: zod), so it imports cleanly here.
//
// Three jobs:
//   1. Schema fidelity — representative valid objects parse; malformed ones
//      (wrong nullability, missing field) are rejected.
//   2. Error-code vocabulary — the enum is exactly the documented set.
//   3. Drift net — every error code LITERALLY emitted anywhere in src/ is a
//      member of ErrorCodeSchema (catches the un-typed `Response.json({error})`
//      paths that jsonError/operatorError typing can't reach).

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DocumentListingSchema,
  ErrorCodeSchema,
  ListVersionsOkSchema,
  ReadSourceOkSchema,
  RevokeOkSchema,
  SearchHitSchema,
  VersionListingSchema,
  WriteOkSchema,
} from "../src/contract.ts";

let fails = 0;

function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails++;
}

function parses(label, schema, value) {
  const r = schema.safeParse(value);
  if (!r.success) {
    console.log(`FAIL ${label}`);
    console.log(`  zod: ${JSON.stringify(r.error.issues?.[0] ?? r.error)}`);
    fails++;
  } else {
    console.log(`ok   ${label}`);
  }
}

function rejects(label, schema, value) {
  check(label, schema.safeParse(value).success === false);
}

// ----- representative fixtures ----------------------------------------------

const listing = {
  public_id: "hdbOcFnhL1y9fe0tWpBvXA",
  current_ver: 3,
  created_at: "2026-06-04T00:00:00.000Z",
  created_by_id: "agent-uuid",
  created_by_name: "my-app",
  current_size: 2048,
  revoked_at: null,
  title: "My document",
  description: null,
  tags: ["metrics", "q2"],
  slug: "north-island-report",
  visibility: "public",
};

// A revoked doc — the null-bearing variant that a sloppy schema would wrongly
// type as non-null (the #1 codegen footgun this test guards).
const revokedListing = {
  ...listing,
  current_ver: null,
  current_size: null,
  revoked_at: "2026-06-04T01:00:00.000Z",
  title: null,
  slug: null,
};

const hit = { ...listing, score: 1.5, matched_field: "title", snippet: "[My] document" };

const writeOk = {
  ok: true,
  public_id: "hdbOcFnhL1y9fe0tWpBvXA",
  url: "https://slopcafe.com/d/hdbOcFnhL1y9fe0tWpBvXA",
  version: 1,
  size_bytes: 2048,
  sanitizer_v: "1.2.3",
  modified: false,
  stripped: [],
  will_not_render: [],
  title: "My document",
  description: null,
  tags: [],
  slug: null,
};

const versionRow = {
  version_no: 2,
  created_at: "2026-06-04T00:00:00.000Z",
  size_bytes: 1024,
  source_size_bytes: null,
  sanitizer_v: "1.2.3",
  source_format: "markdown",
  title: "v2",
  is_current: true,
  source_present: false,
};

const sourceOk = {
  ok: true,
  source: "## My document\n\nbody",
  source_format: "markdown",
  version_no: 3,
  sanitizer_v: "1.2.3",
  stripped: [],
  will_not_render: [],
  title: "My document",
  description: null,
  tags: [],
  slug: null,
};

const revokeOk = { ok: true, public_id: "hdbOcFnhL1y9fe0tWpBvXA", r2_objects_purged: 3 };

// ----- 1. schema fidelity ---------------------------------------------------

parses("DocumentListing (live)", DocumentListingSchema, listing);
parses("DocumentListing (revoked — nulls allowed)", DocumentListingSchema, revokedListing);
parses("SearchHit", SearchHitSchema, hit);
parses("WriteOk", WriteOkSchema, writeOk);
parses("VersionListing", VersionListingSchema, versionRow);
parses("ReadSourceOk", ReadSourceOkSchema, sourceOk);
parses("RevokeOk", RevokeOkSchema, revokeOk);
parses("ListVersionsOk", ListVersionsOkSchema, {
  ok: true,
  public_id: "hdbOcFnhL1y9fe0tWpBvXA",
  current_ver: 2,
  versions: [versionRow],
});

// Malformed — the schema must reject these, or codegen-derived clients lie.
rejects("DocumentListing: visibility must be enum", DocumentListingSchema, {
  ...listing,
  visibility: "secret",
});
rejects("DocumentListing: tags must be present (not null)", DocumentListingSchema, {
  ...listing,
  tags: null,
});
rejects("DocumentListing: public_id required", DocumentListingSchema, (() => {
  const { public_id, ...rest } = listing;
  return rest;
})());
rejects("WriteOk: ok must be the literal true", WriteOkSchema, { ...writeOk, ok: false });
rejects("SearchHit: matched_field is a closed enum", SearchHitSchema, {
  ...hit,
  matched_field: "tags",
});
rejects("VersionListing: source_format closed enum", VersionListingSchema, {
  ...versionRow,
  source_format: "pdf",
});

// SearchHit must be a strict superset of DocumentListing.
const listingKeys = Object.keys(DocumentListingSchema.shape);
const hitKeys = new Set(Object.keys(SearchHitSchema.shape));
check(
  "SearchHit carries every DocumentListing field",
  listingKeys.every((k) => hitKeys.has(k)),
);
check(
  "SearchHit adds score/matched_field/snippet",
  ["score", "matched_field", "snippet"].every((k) => hitKeys.has(k)),
);

// ----- 2. error-code vocabulary ---------------------------------------------

const EXPECTED_CODES = [
  "bad_cursor",
  "bad_integrity_header",
  "bad_json",
  "bad_limit",
  "bad_query",
  "bad_request",
  "bad_slug",
  "bad_target",
  "client_exists",
  "csrf_failed",
  "empty_body",
  "gone",
  "integrity_mismatch",
  "internal",
  "invalid_slug",
  "invalid_visibility",
  "misconfigured",
  "not_found",
  "precondition_failed",
  "precondition_required",
  "slug_redirected",
  "slug_retired",
  "slug_taken",
  "source_unavailable",
  "storage_cap_exceeded",
  "too_large",
  "unsupported_media_type",
  "unauthorized",
];
const enumCodes = new Set(ErrorCodeSchema.options);
check(
  "ErrorCode enum == documented vocabulary",
  enumCodes.size === EXPECTED_CODES.length && EXPECTED_CODES.every((c) => enumCodes.has(c)),
);
check("ErrorCode accepts a known code", ErrorCodeSchema.safeParse("slug_taken").success);
check("ErrorCode rejects an unknown code", !ErrorCodeSchema.safeParse("teapot").success);

// ----- 3. drift net: every literally-emitted code is in the enum ------------
// Scans src/ for codes passed as a string literal to jsonError()/operatorError()
// or set as `error: "..."` in a Response.json. The dynamic `params.code` calls
// are covered by `jsonError(code: ErrorCode)` typing instead, so they're not
// scanned here. A new literal code added without updating the enum fails here.

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const emitted = new Set();
const patterns = [
  /jsonError\(\s*\d+\s*,\s*"([a-z_]+)"/g,
  /operatorError\(\s*\d+\s*,\s*"([a-z_]+)"/g,
  /error:\s*"([a-z_]+)"/g, // direct Response.json({ error: "..." })
];
for (const name of readdirSync(srcDir)) {
  if (!name.endsWith(".ts")) continue;
  const text = readFileSync(`${srcDir}/${name}`, "utf8");
  for (const re of patterns) {
    for (const m of text.matchAll(re)) emitted.add(m[1]);
  }
}
const orphanCodes = [...emitted].filter((c) => !enumCodes.has(c)).sort();
check(
  `every emitted error code is in ErrorCode (${emitted.size} scanned)`,
  orphanCodes.length === 0,
);
if (orphanCodes.length > 0) {
  console.log(`  emitted but not in ErrorCode enum: ${orphanCodes.join(", ")}`);
}

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} contract test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall contract tests passed");
}
