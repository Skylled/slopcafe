// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Pure coverage for the listing vocabulary shared by list, search, packs, and
// link-graph reads. These helpers moved out of core.ts in issue #72 so the
// earlier #53 extractions no longer depend on the broad document core merely
// to agree on SQL projection/filter semantics.

import {
  decodeDocumentListing,
  DOCUMENT_LISTING_COLUMNS,
  DOCUMENT_LISTING_JOINS,
  documentPublicationClause,
  documentTagLikePattern,
  parseStoredTags,
} from "../src/document-listing.ts";

let fails = 0;

function check(label, got, want) {
  const equal = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${equal ? "ok  " : "FAIL"} ${label}`);
  if (!equal) {
    console.log(`  want: ${JSON.stringify(want)}`);
    console.log(`  got:  ${JSON.stringify(got)}`);
    fails++;
  }
}

function ok(label, condition) {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}`);
  if (!condition) fails++;
}

check("null stored tags decode empty", parseStoredTags(null), []);
check("malformed stored tags fail closed", parseStoredTags("not-json"), []);
check("stored tags reuse write-side sanitization", parseStoredTags('["One!","two","two"]'), ["One", "two"]);
check("tag pattern anchors a complete tag", documentTagLikePattern("foo"), '%"foo"%');
check("tag pattern escapes LIKE underscores", documentTagLikePattern("my_tag"), '%"my\\_tag"%');

const pending = documentPublicationClause("pending");
const current = documentPublicationClause("current");
ok("pending uses null-safe pointer inequality", pending.includes("published_ver is not d.current_ver"));
ok("current requires a non-null published pointer", current.includes("published_ver is not null"));
ok("both publication filters exclude revoked rows", pending.includes("revoked_at is null") && current.includes("revoked_at is null"));
ok("publication filters do not silently include visibility", !pending.includes("visibility") && !current.includes("visibility"));

ok("projection includes the internal cursor id", DOCUMENT_LISTING_COLUMNS.startsWith("d.id,"));
ok("projection resolves current-version authorship", DOCUMENT_LISTING_COLUMNS.includes("current_author_client_id"));
ok("joins pin current and published versions separately", DOCUMENT_LISTING_JOINS.includes("v.version_no = d.current_ver") && DOCUMENT_LISTING_JOINS.includes("pv.version_no = d.published_ver"));

const row = {
  id: "internal",
  public_id: "public",
  tags: '["one","two"]',
  marker: "preserved",
};
check("listing decoder removes internal id and parses tags", decodeDocumentListing(row), {
  public_id: "public",
  marker: "preserved",
  tags: ["one", "two"],
});

if (fails > 0) {
  console.error(`\n${fails} document-listing test(s) FAILED`);
  process.exit(1);
}
console.log("\nall document-listing tests passed");
