// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/backup-format.ts — the pure half of the corpus backup
// (issue #9): the page cursor, the base64 helpers, and the NDJSON parser that
// VALIDATES every record against src/contract.ts before a restore touches
// anything. Runs under the strip-types runner with the .js→.ts resolver
// (backup-format.ts imports `./contract.js`). No D1/R2/WASM: the export walk
// and the restore core are proven by test/e2e/backup-restore.sh.

import {
  BACKUP_DEFAULT_LIMIT,
  BACKUP_MAX_LIMIT,
  BACKUP_PHASES,
  base64ToBytes,
  bytesToBase64,
  decodeBackupCursor,
  encodeBackupCursor,
  nextBackupPhase,
  parseBackupLimit,
  parseBackupNdjson,
} from "../src/backup-format.ts";

let fails = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails++;
}

// ----- cursor ---------------------------------------------------------------

const c = { phase: "documents", ts: "2026-09-03T10:00:00.123Z", id: "11111111-2222-4333-8444-555555555555" };
const enc = encodeBackupCursor(c);
check("cursor is base64url (no + / =)", /^[A-Za-z0-9_-]+$/.test(enc));
check("cursor round-trips", JSON.stringify(decodeBackupCursor(enc)) === JSON.stringify(c));
check(
  "an empty ts/id (phase-start cursor) round-trips",
  JSON.stringify(decodeBackupCursor(encodeBackupCursor({ phase: "agents", ts: "", id: "" }))) ===
    JSON.stringify({ phase: "agents", ts: "", id: "" }),
);
check("garbage is null", decodeBackupCursor("not-a-cursor!!") === null);
check("empty string is null", decodeBackupCursor("") === null);
check(
  "an unknown phase fails the WHOLE decode",
  decodeBackupCursor(btoa(JSON.stringify({ p: "future_table", ts: "", id: "" }))) === null,
);
check(
  "a LIST cursor ({ts,id} with no phase) is not a backup cursor",
  decodeBackupCursor(btoa(JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", id: "x" }))) === null,
);
check("a JSON array is null", decodeBackupCursor(btoa("[1,2]")) === null);
check("a non-string ts is null", decodeBackupCursor(btoa(JSON.stringify({ p: "agents", ts: 5, id: "" }))) === null);

check("phases walk in the FK-safe order", BACKUP_PHASES.join(",") === "agents,agent_keys,oauth_clients,documents,slug_tombstones");
check("nextBackupPhase steps forward", nextBackupPhase("agents") === "agent_keys");
check("nextBackupPhase ends with null", nextBackupPhase("slug_tombstones") === null);

// ----- limit ----------------------------------------------------------------

check("limit absent → default", parseBackupLimit(null) === BACKUP_DEFAULT_LIMIT);
check("limit empty → default", parseBackupLimit("") === BACKUP_DEFAULT_LIMIT);
check("limit 1 ok", parseBackupLimit("1") === 1);
check("limit max ok", parseBackupLimit(String(BACKUP_MAX_LIMIT)) === BACKUP_MAX_LIMIT);
check("limit 0 rejected", parseBackupLimit("0") === null);
check("limit over max rejected", parseBackupLimit(String(BACKUP_MAX_LIMIT + 1)) === null);
check("limit non-integer rejected", parseBackupLimit("1.5") === null);
check("limit negative rejected", parseBackupLimit("-1") === null);

// ----- base64 ---------------------------------------------------------------

const bytes = new Uint8Array(70000);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff;
const b64 = bytesToBase64(bytes);
check("bytesToBase64 emits standard base64", /^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0);
const back = base64ToBytes(b64);
check("base64 round-trips a >32 KiB buffer byte-for-byte", back.length === bytes.length && back.every((v, i) => v === bytes[i]));
check("empty buffer → empty string", bytesToBase64(new Uint8Array(0)) === "");
check("utf-8 text survives", new TextDecoder().decode(base64ToBytes(bytesToBase64(new TextEncoder().encode("héllo — 世界")))) === "héllo — 世界");

// ----- NDJSON parse ---------------------------------------------------------

const TS = "2026-09-03T10:00:00.000Z";
const AG = "11111111-2222-4333-8444-555555555555";
const DOC = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PUB = "AbCdEfGhIjKlMnOpQrStUv";
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const header = {
  kind: "header",
  format: "slopcafe-backup",
  version: 1,
  exported_at: TS,
  instance: "http://localhost:8787",
  contract_version: "3.0.0",
  sanitizer_v: "ammonia-v1.7",
  converter_v: "awh-md-v2",
};
const agent = { kind: "agent", id: AG, name: "e2e", created_at: TS };
const doc = {
  kind: "document",
  id: DOC,
  public_id: PUB,
  current_ver: 1,
  published_ver: null,
  created_by: AG,
  created_by_kind: "agent",
  revoked_at: null,
  created_at: TS,
  updated_at: TS,
  slug: "a-slug",
  visibility: "private",
  tags: ["x"],
  status: "active",
  superseded_by: null,
};
const ver = {
  kind: "version",
  document_id: DOC,
  version_no: 1,
  size_bytes: 10,
  sanitizer_v: "ammonia-v1.7",
  source_format: "markdown",
  source_size_bytes: 5,
  source_sha256: SHA,
  title: "t",
  description: null,
  author_kind: "agent",
  author_agent_id: AG,
  created_at: TS,
  r2_key: `${DOC}/v1-nonce`,
  source_r2_key: `${DOC}/v1-nonce.src`,
  html_b64: bytesToBase64(new TextEncoder().encode("<p>hi</p>")),
  source_b64: bytesToBase64(new TextEncoder().encode("hi")),
};
const link = { kind: "document_link", src_doc_id: DOC, position: 0, target_kind: "slug", target_value: "other" };
const tomb = { kind: "slug_tombstone", slug: "gone", document_id: null, retired_at: TS, reason: "revoked", redirect_to: null };
const footer = {
  kind: "footer",
  counts: { agents: 1, agent_keys: 0, oauth_clients: 0, documents: 1, versions: 1, document_links: 1, slug_tombstones: 1 },
};
const page = { kind: "page", next_cursor: null };

const good = [header, agent, doc, ver, link, tomb, footer, page].map((r) => JSON.stringify(r)).join("\n") + "\n";
const parsedGood = parseBackupNdjson(good);
check("a well-formed page parses with no invalid lines", parsedGood.invalid.length === 0);
check("every record is returned with its 1-based line", parsedGood.records.length === 8 && parsedGood.records[0].line === 1 && parsedGood.records[7].line === 8);
check("kinds survive the discriminated union", parsedGood.records.map((r) => r.record.kind).join(",") === "header,agent,document,version,document_link,slug_tombstone,footer,page");
check("the version's blobs come back as strings", typeof parsedGood.records[3].record.source_b64 === "string");

// Tolerances.
const crlf = good.replace(/\n/g, "\r\n") + "\n\n   \n";
check("CRLF line endings + blank lines are tolerated", parseBackupNdjson(crlf).invalid.length === 0 && parseBackupNdjson(crlf).records.length === 8);
check("an empty body yields nothing (not an error here — the route 400s)", parseBackupNdjson("").records.length === 0 && parseBackupNdjson("").invalid.length === 0);

// Fail-closed: each bad line is reported by number with a reason and nothing is
// inferred from it.
function invalidFor(obj, line = 1) {
  const r = parseBackupNdjson(typeof obj === "string" ? obj : JSON.stringify(obj));
  const hit = r.invalid.find((i) => i.line === line);
  return hit ? hit.reason : null;
}
check("non-JSON line → invalid", invalidFor("{not json") === "not valid JSON");
check("a JSON array line → invalid", invalidFor("[1,2,3]") === "not a JSON object");
check("a JSON scalar line → invalid", invalidFor("42") === "not a JSON object");
check("unknown kind → invalid (names the discriminator)", (invalidFor({ kind: "settings", x: 1 }) ?? "").startsWith("kind:"));
check("missing kind → invalid", invalidFor({ id: AG }) !== null);
check("a v2 header → invalid at the header line", (invalidFor({ ...header, version: 2 }) ?? "").includes("version"));
check("a foreign format → invalid", (invalidFor({ ...header, format: "other-backup" }) ?? "").includes("format"));
check("bad public_id shape → invalid", (invalidFor({ ...doc, public_id: "too-short" }) ?? "").includes("public_id"));
check("bad uuid shape → invalid", (invalidFor({ ...agent, id: "AG-not-a-uuid" }) ?? "").includes("id"));
check("an unpadded timestamp → invalid (ordering is lexicographic)", (invalidFor({ ...agent, created_at: "2026-9-3T10:00:00Z" }) ?? "").includes("created_at"));
check("an offset timestamp → invalid", (invalidFor({ ...agent, created_at: "2026-09-03T10:00:00.000+02:00" }) ?? "").includes("created_at"));
check("bad slug charset → invalid", (invalidFor({ ...doc, slug: "Not A Slug" }) ?? "").includes("slug"));
check("bad sha256 → invalid", (invalidFor({ ...ver, source_sha256: "xyz" }) ?? "").includes("source_sha256"));
check("non-base64 blob → invalid", (invalidFor({ ...ver, source_b64: "@@@@" }) ?? "").includes("source_b64"));
check("mis-padded base64 → invalid", (invalidFor({ ...ver, source_b64: "abc" }) ?? "").includes("source_b64"));
check("URL-safe base64 is NOT accepted (btoa emits standard)", (invalidFor({ ...ver, source_b64: "ab-_" }) ?? "").includes("source_b64"));
check("version_no 0 → invalid", (invalidFor({ ...ver, version_no: 0 }) ?? "").includes("version_no"));
check("negative size → invalid", (invalidFor({ ...ver, size_bytes: -1 }) ?? "").includes("size_bytes"));
check("a bad visibility → invalid", (invalidFor({ ...doc, visibility: "secret" }) ?? "").includes("visibility"));
check("a live document with no current_ver → invalid (invariant)", (invalidFor({ ...doc, current_ver: null }) ?? "").includes("current_ver"));
check("a live PUBLIC document with no published_ver → invalid (0018 invariant)", (invalidFor({ ...doc, visibility: "public" }) ?? "").includes("published_ver"));
check("a REVOKED document may carry null pointers", invalidFor({ ...doc, revoked_at: TS, current_ver: null, published_ver: null }) === null);
check("a revoked document's version may carry null blobs", invalidFor({ ...ver, html_b64: null, source_b64: null }) === null);
check("a pre-0008 version (no source key, no source) validates", invalidFor({ ...ver, source_r2_key: null, source_b64: null, source_size_bytes: null, source_sha256: null }) === null);
check("bad key_hash shape → invalid", (invalidFor({ kind: "agent_key", id: AG, agent_id: AG, key_prefix: "abc", key_hash: "nope", revoked_at: null, expires_at: null, created_at: TS }) ?? "").includes("key_hash"));
check("bad link target_kind → invalid", (invalidFor({ ...link, target_kind: "url" }) ?? "").includes("target_kind"));
check("a page trailer with a cursor validates", invalidFor({ kind: "page", next_cursor: "abc" }) === null);

// Multiple bad lines are ALL reported (an operator fixes the file once), and the
// good lines around them still parse.
const mixed = [JSON.stringify(agent), "{broken", JSON.stringify({ kind: "nope" }), JSON.stringify(tomb)].join("\n");
const parsedMixed = parseBackupNdjson(mixed);
check("mixed page: both bad lines reported by number", parsedMixed.invalid.map((i) => i.line).join(",") === "2,3");
check("mixed page: the good lines still parse", parsedMixed.records.map((r) => r.line).join(",") === "1,4");
check("reasons are bounded (≤ 300 chars)", parsedMixed.invalid.every((i) => i.reason.length <= 300));

// The parser never echoes the offending VALUE into the reason — a hostile file's
// contents must not ride into the report or the logs.
const SECRET_LOOKING = "awh_zzzzzzzzzzz.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
const leak = parseBackupNdjson(JSON.stringify({ kind: "agent", id: SECRET_LOOKING, name: "x", created_at: TS }));
check("a rejected value is not echoed in the reason", leak.invalid.length === 1 && !leak.invalid[0].reason.includes(SECRET_LOOKING));

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} backup-format test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall backup-format tests passed");
}
