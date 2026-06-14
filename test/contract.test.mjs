// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/contract.ts — the Zod source of truth for the API contract
// (Phase 1 of docs/design/api-contract-design.md). Pure-schema tests in the same
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
  CreatePublishCredentialResponseSchema,
  DeleteOAuthClientResponseSchema,
  DocumentLinksOkSchema,
  DocumentLinksResponseSchema,
  DocumentListingSchema,
  ErrorBodySchema,
  McpReadDocumentResponseSchema,
  McpSearchDocumentsResponseSchema,
  PackDocumentSchema,
  PackOmittedSchema,
  PackResponseSchema,
  ErrorCodeSchema,
  HealthzResponseSchema,
  ListDocumentsResponseSchema,
  ListVersionsOkSchema,
  OutboundLinkSchema,
  ReadSourceOkSchema,
  ReadSourceResponseSchema,
  RevokeOkSchema,
  RevokeResponseSchema,
  SearchDocumentsResponseSchema,
  SearchHitSchema,
  VersionListingSchema,
  WriteOkSchema,
  WriteResponseSchema,
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
  created_by_kind: "agent",
  current_size: 2048,
  current_source_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  revoked_at: null,
  title: "My document",
  description: null,
  tags: ["metrics", "q2"],
  slug: "north-island-report",
  status: "active",
  superseded_by: null,
  visibility: "public",
};

// A revoked doc — the null-bearing variant that a sloppy schema would wrongly
// type as non-null (the #1 codegen footgun this test guards).
const revokedListing = {
  ...listing,
  current_ver: null,
  current_size: null,
  current_source_sha256: null,
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
  source_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
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
  author_kind: "agent",
  author_id: "agent-uuid",
  author_name: "my-app",
};

const sourceOk = {
  ok: true,
  source: "## My document\n\nbody",
  source_format: "markdown",
  version_no: 3,
  sanitizer_v: "1.2.3",
  source_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  stripped: [],
  will_not_render: [],
  title: "My document",
  description: null,
  tags: [],
  slug: null,
  status: "deprecated",
  superseded_by: "hdbOcFnhL1y9fe0tWpBvXA",
};

const revokeOk ={ ok: true, public_id: "hdbOcFnhL1y9fe0tWpBvXA", r2_objects_purged: 3 };

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

// Link graph (migration 0016 / issue #40).
const outboundLink = {
  kind: "slug",
  value: "my-doc",
  state: "live",
  target_public_id: "hdbOcFnhL1y9fe0tWpBvXA",
  title: "My document",
};
parses("OutboundLink (live)", OutboundLinkSchema, outboundLink);
parses("OutboundLink (missing — nulls)", OutboundLinkSchema, {
  kind: "public_id",
  value: "AAAAAAAAAAAAAAAAAAAAAA",
  state: "missing",
  target_public_id: null,
  title: null,
});
parses("DocumentLinksOk", DocumentLinksOkSchema, {
  ok: true,
  public_id: "hdbOcFnhL1y9fe0tWpBvXA",
  backlinks: [listing],
  outbound: [outboundLink],
});
parses("DocumentLinksResponse (wire — no ok tag)", DocumentLinksResponseSchema, {
  public_id: "hdbOcFnhL1y9fe0tWpBvXA",
  backlinks: [],
  outbound: [],
});
rejects("OutboundLink: state is a closed enum", OutboundLinkSchema, {
  ...outboundLink,
  state: "broken",
});

// Malformed — the schema must reject these, or codegen-derived clients lie.
rejects("DocumentListing: visibility must be enum", DocumentListingSchema, {
  ...listing,
  visibility: "secret",
});
rejects("DocumentListing: status is a closed enum", DocumentListingSchema, {
  ...listing,
  status: "draft",
});
rejects("DocumentListing: superseded_by required (nullable, not omittable)", DocumentListingSchema, (() => {
  const { superseded_by, ...rest } = listing;
  return rest;
})());
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

// ----- 1b. wire response shapes (Phase 2) -----------------------------------
// The handlers strip the internal `ok` tag (revoke renames it `revoked`); these
// are the on-the-wire variants the OpenAPI components are generated from.

const { ok: _writeOk, ...writeWire } = writeOk;
parses("WriteResponse (no `ok` tag)", WriteResponseSchema, writeWire);

parses("RevokeResponse", RevokeResponseSchema, {
  revoked: true,
  public_id: "hdbOcFnhL1y9fe0tWpBvXA",
  r2_objects_purged: 2,
});

const { ok: _srcOk, ...srcWire } = sourceOk;
parses("ReadSourceResponse (adds unsanitized:true)", ReadSourceResponseSchema, {
  ...srcWire,
  unsanitized: true,
});
rejects("ReadSourceResponse: unsanitized must be literal true", ReadSourceResponseSchema, {
  ...srcWire,
  unsanitized: false,
});

parses("ListDocumentsResponse (cursor nullable)", ListDocumentsResponseSchema, {
  documents: [listing, revokedListing],
  next_cursor: null,
});
parses("SearchDocumentsResponse (no next_cursor)", SearchDocumentsResponseSchema, {
  documents: [hit],
});

// ----- 1b'. context-pack envelope (issue #21) ---------------------------------

const packDoc = {
  ...listing,
  content: "# My document\n\nbody",
  format: "markdown",
  converter_v: "1.0.0",
  version: 3,
  score: 1.5,
  matched_field: "title",
  snippet: "[My] document",
  tier: null,
  hint: null,
};
parses("PackDocument (query-pack member)", PackDocumentSchema, packDoc);
parses("PackDocument (manifest member — null attribution, tier+hint)", PackDocumentSchema, {
  ...packDoc,
  score: null,
  matched_field: null,
  snippet: null,
  tier: "optional",
  hint: "how semantic ranking works",
});
rejects("PackDocument: format must be the literal markdown", PackDocumentSchema, {
  ...packDoc,
  format: "html",
});

parses("PackOmitted (budget, with size)", PackOmittedSchema, {
  ref: "hdbOcFnhL1y9fe0tWpBvXA",
  public_id: "hdbOcFnhL1y9fe0tWpBvXA",
  title: "Too big",
  reason: "budget",
  size_bytes: 300000,
  superseded_by: null,
  hint: null,
});
parses("PackOmitted (unresolvable manifest ref — null public_id)", PackOmittedSchema, {
  ref: "no-such-slug",
  public_id: null,
  title: null,
  reason: "unavailable",
  size_bytes: null,
  superseded_by: null,
  hint: "background reading",
});
rejects("PackOmitted: reason is a closed enum", PackOmittedSchema, {
  ref: "x",
  public_id: "x",
  title: null,
  reason: "too_boring",
  size_bytes: null,
  superseded_by: null,
  hint: null,
});

parses("PackResponse (query pack)", PackResponseSchema, {
  pack: {
    source: "query",
    query: "how does search work",
    root: null,
    budget_bytes: 65536,
    max_documents: 8,
    used_bytes: 41200,
  },
  documents: [packDoc],
  omitted: [
    {
      ref: "aaaaaaaaaaaaaaaaaaaaaa",
      public_id: "aaaaaaaaaaaaaaaaaaaaaa",
      title: "Old design",
      reason: "deprecated",
      size_bytes: 2048,
      superseded_by: "hdbOcFnhL1y9fe0tWpBvXA",
      hint: null,
    },
  ],
});
parses("PackResponse (manifest pack with root prose)", PackResponseSchema, {
  pack: {
    source: "manifest",
    query: null,
    root: {
      public_id: "hdbOcFnhL1y9fe0tWpBvXA",
      slug: "pack-slopcafe",
      title: "Slopcafe starter pack",
      content: "Read these in order.",
      format: "markdown",
    },
    budget_bytes: 65536,
    max_documents: 8,
    used_bytes: 10,
  },
  documents: [],
  omitted: [],
});

parses("HealthzResponse", HealthzResponseSchema, {
  ok: true,
  service: "slopcafe",
  sanitizer_version: "1.2.3",
  storage_cap_bytes: 2147483648,
  d1: { documents: 12, agents: 3 },
  r2: { bucket_reachable: true, sample_object_count: 1 },
});
parses("HealthzResponse (null d1 counts on a fresh deploy)", HealthzResponseSchema, {
  ok: true,
  service: "slopcafe",
  sanitizer_version: "1.2.3",
  storage_cap_bytes: 2147483648,
  d1: { documents: null, agents: null },
  r2: { bucket_reachable: true, sample_object_count: 0 },
});

// DeleteOAuthClient is a union (bound vs unbound teardown).
parses("DeleteOAuthClientResponse (bound)", DeleteOAuthClientResponseSchema, {
  revoked: true,
  client_id: "c",
  agent_id: "a",
});
parses("DeleteOAuthClientResponse (unbound)", DeleteOAuthClientResponseSchema, {
  revoked: true,
  client_id: "c",
  unbound: true,
});

// ----- 1d. MCP tool output envelopes (design §7 — outputSchema) --------------
// These back the registerTool outputSchema/structuredContent in src/mcp.ts;
// the SDK hard-fails a tool call whose structuredContent doesn't validate, so
// fixture drift here means a broken tool in production.

// read_document shape 1: the document envelope (rendered markdown read with
// history attached — the maximal common case).
parses("McpReadDocumentResponse (rendered + history)", McpReadDocumentResponseSchema, {
  public_id: "hdbOcFnhL1y9fe0tWpBvXA",
  representation: "rendered",
  content: "# My document\n\nbody",
  format: "markdown",
  version: 3,
  sanitizer_v: "1.2.3",
  converter_v: "0.3.0",
  title: "My document",
  description: null,
  tags: ["metrics"],
  slug: "north-island-report",
  status: "active",
  superseded_by: null,
  current_version: 3,
  history: [
    {
      version: 3,
      created_at: "2026-06-04T00:00:00.000Z",
      size_bytes: 2048,
      source_format: "markdown",
      title: "My document",
      is_current: true,
      author_kind: "agent",
      author_id: "agent-uuid",
      author_name: "my-app",
    },
  ],
});
// read_document shape 1, source representation (unsanitized + advisories).
parses("McpReadDocumentResponse (source read)", McpReadDocumentResponseSchema, {
  public_id: "hdbOcFnhL1y9fe0tWpBvXA",
  representation: "source",
  unsanitized: true,
  content: "## My document\n\nbody",
  format: "markdown",
  source_format: "markdown",
  source_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  stripped: [],
  will_not_render: [],
  version: 3,
  sanitizer_v: "1.2.3",
  converter_v: null,
  title: "My document",
  description: null,
  tags: [],
  slug: null,
  status: "deprecated",
  superseded_by: "hdbOcFnhL1y9fe0tWpBvXA",
});
// read_document shape 2: the unfollowed retired-slug redirect report.
parses("McpReadDocumentResponse (redirect report)", McpReadDocumentResponseSchema, {
  redirected: true,
  from_slug: "old-name",
  redirect_target: { public_id: "hdbOcFnhL1y9fe0tWpBvXA", slug: "new-name", title: "Doc" },
  message: "this slug is retired and now redirects to another document",
});
rejects("McpReadDocumentResponse: redirected must be literal true", McpReadDocumentResponseSchema, {
  redirected: false,
  from_slug: "old-name",
});
rejects("McpReadDocumentResponse: history rows are typed", McpReadDocumentResponseSchema, {
  history: [{ version: "three" }],
});

// search_documents: plain hits and the include_bodies pack are ONE schema.
parses("McpSearchDocumentsResponse (plain hits)", McpSearchDocumentsResponseSchema, {
  documents: [hit],
});
parses("McpSearchDocumentsResponse (include_bodies pack)", McpSearchDocumentsResponseSchema, {
  documents: [packDoc],
  pack: {
    source: "query",
    query: "how does search work",
    root: null,
    budget_bytes: 65536,
    max_documents: 8,
    used_bytes: 41200,
  },
  omitted: [],
});
rejects("McpSearchDocumentsResponse: documents rows keep the listing shape", McpSearchDocumentsResponseSchema, {
  documents: [{ ...hit, public_id: undefined }],
});

parses("CreatePublishCredentialResponse", CreatePublishCredentialResponseSchema, {
  key: "awh_secret",
  key_id: "key-uuid",
  expires_at: "2026-06-04T00:15:00.000Z",
  host: "https://slopcafe.com",
  publish_endpoint: "https://slopcafe.com/d",
  update_endpoint: "https://slopcafe.com/d/<public_id>",
  recipe: "curl -X POST ...",
  note: "Short-lived secret",
});
rejects("CreatePublishCredentialResponse: key is required", CreatePublishCredentialResponseSchema, {
  key_id: "key-uuid",
  expires_at: "2026-06-04T00:15:00.000Z",
  host: "https://slopcafe.com",
  publish_endpoint: "https://slopcafe.com/d",
  update_endpoint: "https://slopcafe.com/d/<public_id>",
  recipe: "curl -X POST ...",
  note: "Short-lived secret",
});

// ----- 1c. ErrorBody discriminates on `error` -------------------------------
// One member per ErrorCode; context-free codes are just {error, message},
// context-bearing codes require their extra fields.

parses("ErrorBody: context-free code", ErrorBodySchema, { error: "not_found", message: "no such document" });
parses("ErrorBody: slug_taken carries slug", ErrorBodySchema, {
  error: "slug_taken",
  message: "in use",
  slug: "north-island",
});
parses("ErrorBody: precondition_failed carries version context", ErrorBodySchema, {
  error: "precondition_failed",
  message: "current version is v3",
  current_version: 3,
  expected: 2,
});
parses("ErrorBody: slug_redirected nests a RedirectTarget", ErrorBodySchema, {
  error: "slug_redirected",
  message: "moved",
  slug: "old-name",
  redirect_to: { public_id: "hdbOcFnhL1y9fe0tWpBvXA", slug: "new-name", title: "Moved doc" },
  hint: "retry with ?follow_redirects=true",
});
parses("ErrorBody: integrity_mismatch carries the hashes", ErrorBodySchema, {
  error: "integrity_mismatch",
  message: "truncated",
  expected_sha256: "a".repeat(64),
  actual_sha256: "b".repeat(64),
  received_bytes: 17,
});

// Discrimination must be on `error`: a code's context is enforced, and an
// unknown discriminant is rejected outright.
rejects("ErrorBody: slug_taken WITHOUT slug is rejected", ErrorBodySchema, {
  error: "slug_taken",
  message: "in use",
});
rejects("ErrorBody: precondition_failed WITHOUT version context is rejected", ErrorBodySchema, {
  error: "precondition_failed",
  message: "x",
});
rejects("ErrorBody: unknown error code is rejected", ErrorBodySchema, {
  error: "teapot",
  message: "x",
});
check(
  "ErrorBody has one member per ErrorCode",
  ErrorBodySchema.options.length === ErrorCodeSchema.options.length,
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
  "bad_status",
  "bad_target",
  "client_exists",
  "csrf_failed",
  "empty_body",
  "gone",
  "integrity_mismatch",
  "internal",
  "invalid_slug",
  "invalid_status",
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
  "too_deep",
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
