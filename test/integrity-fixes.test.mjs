// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for QL-808 PR 2 integrity & reliability fixes (Q2–Q7 + M3):
 *   - Q2: deleteR2Keys chunks R2 deletes at 1,000 keys; backup.ts exports and
 *     restores versions.author_client_id.
 *   - Q3: presentDocIds chunks Vectorize getByIds at 20 IDs.
 *   - Q4: Markdown writes do not call markdownToHtml() twice.
 *   - Q5: readBodyWithLimit enforces Content-Length fast-fail, streaming cap
 *     cancellation, and true UTF-8 byte length (not UTF-16 code units).
 *   - Q6: putVersionBlobs rolls back partial R2 puts; createOAuthClientCore
 *     rolls back KV client if D1 INSERT throws.
 *   - M3: D1 constraint error classification (versions PK -> 412, slug UNIQUE -> 409)
 *     and setDocumentSlugCore race translation.
 *   - Q7: admin-oauth errors carry SERVICE_DESC_LINK; authorize imports shared escapeHtml.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createOAuthClient, createOAuthClientCore } from "../src/admin-oauth.ts";
import { isSlugUniqueConstraintError, isVersionsPkConstraintError } from "../src/d1-errors.ts";
import { setDocumentSlugCore } from "../src/document-slug.ts";
import { deleteR2Keys, putVersionBlobs, R2_DELETE_BATCH } from "../src/document-storage.ts";
import { readBodyWithLimit } from "../src/http-body.ts";
import { SERVICE_DESC_LINK } from "../src/serve-policy.ts";
import { presentDocIds, VECTORIZE_GET_BY_IDS_BATCH } from "../src/vector-io.ts";

let fails = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function checkThat(label, cond, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : `\n       ${detail}`}`);
}

// ============================================================================
// Q2: R2 purge chunking at 1,000 keys
// ============================================================================

check("R2_DELETE_BATCH is 1000", R2_DELETE_BATCH, 1000);

{
  const calls = [];
  const env = {
    DOCS: {
      async delete(keys) {
        calls.push([...keys]);
      },
    },
  };

  await deleteR2Keys(env, []);
  check("deleteR2Keys([]) makes 0 R2 calls", calls.length, 0);

  const keys = Array.from({ length: 2501 }, (_, i) => `doc/v${i}`);
  await deleteR2Keys(env, keys);
  check("deleteR2Keys(2501) makes 3 chunked calls", calls.length, 3);
  check("chunk sizes are [1000, 1000, 501]", calls.map((c) => c.length).join(","), "1000,1000,501");
  check("all 2501 keys preserved in order", calls.flat().length === 2501 && calls[2][500] === "doc/v2500", true);
}

// ============================================================================
// Q3: Vectorize presentDocIds chunking at 20 IDs
// ============================================================================

check("VECTORIZE_GET_BY_IDS_BATCH is 20", VECTORIZE_GET_BY_IDS_BATCH, 20);

{
  const batches = [];
  const env = {
    VECTORIZE: {
      async getByIds(ids) {
        batches.push([...ids]);
        // Pretend every even-numbered doc is present in Vectorize.
        return ids
          .filter((id) => {
            const num = Number(id.split("#")[0].slice(1));
            return num % 2 === 0;
          })
          .map((id) => ({ id, values: [] }));
      },
    },
  };

  const empty = await presentDocIds(env, []);
  check("presentDocIds([]) returns empty set with 0 calls", empty.size === 0 && batches.length === 0, true);

  const ids = Array.from({ length: 55 }, (_, i) => `d${i}`);
  const found = await presentDocIds(env, ids);
  check("presentDocIds(55) makes 3 Vectorize getByIds calls", batches.length, 3);
  check("batch sizes are [20, 20, 15]", batches.map((b) => b.length).join(","), "20,20,15");
  check("every batch has <= 20 IDs", batches.every((b) => b.length <= 20), true);
  check("found set contains all 28 even doc IDs with #0 stripped", found.size, 28);
  check("spot check d0 present and d1 absent", found.has("d0") && !found.has("d1") && found.has("d54"), true);
}

// ============================================================================
// Q4: No double markdownToHtml() in document-write.ts
// ============================================================================

{
  const writeSrc = readFileSync(
    fileURLToPath(new URL("../src/document-write.ts", import.meta.url)),
    "utf8",
  );
  const mdCalls = writeSrc.match(/\bmarkdownToHtml\(/g) ?? [];
  check("document-write.ts invokes markdownToHtml() exactly once (inside screenAndPrepare)", mdCalls.length, 1);
  checkThat(
    "screenAndPrepare passes preconverted asHtml to prepareForStorage",
    /prepareForStorage\(body,\s*format,\s*asHtml,\s*inputBytes\)/.test(writeSrc),
  );
  const readSrc = readFileSync(
    fileURLToPath(new URL("../src/document-read.ts", import.meta.url)),
    "utf8",
  );
  checkThat(
    "computeAdvisories reuses preconvertedHtml when supplied",
    /const asHtml = preconvertedHtml \?\? \(format === "markdown" \? markdownToHtml\(body\) : body\);/.test(readSrc),
  );
}

// ============================================================================
// Q5: Bounded body reading (Content-Length + streaming + UTF-8 byte length)
// ============================================================================

{
  // Exact limit passes.
  const exactReq = new Request("https://slopcafe.com/d", {
    method: "POST",
    body: "12345",
  });
  const exactRes = await readBodyWithLimit(exactReq, 5);
  check("readBodyWithLimit accepts exact maxBytes", exactRes.ok && exactRes.bytes.byteLength === 5, true);

  // Declared Content-Length > maxBytes fails BEFORE pulling from stream!
  let pulled = 0;
  const neverReadStream = new ReadableStream(
    {
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const clReq = new Request("https://slopcafe.com/d", {
    method: "POST",
    headers: { "content-length": "99999999" },
    body: neverReadStream,
    duplex: "half",
  });
  const clRes = await readBodyWithLimit(clReq, 1024);
  check("declared Content-Length > maxBytes returns too_large", !clRes.ok && clRes.code === "too_large", true);
  check("declared oversize request never reads from stream", pulled === 0 && clReq.bodyUsed === false, true);

  // Chunked stream without Content-Length cancels early as soon as limit is exceeded.
  let chunksPulled = 0;
  let canceled = false;
  const hugeChunkedStream = new ReadableStream({
    pull(controller) {
      chunksPulled++;
      controller.enqueue(new Uint8Array(60));
      if (chunksPulled >= 100) controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  const chunkedReq = new Request("https://slopcafe.com/d", {
    method: "POST",
    body: hugeChunkedStream,
    duplex: "half",
  });
  const chunkedRes = await readBodyWithLimit(chunkedReq, 100);
  check("chunked oversize stream returns too_large", !chunkedRes.ok && chunkedRes.code === "too_large", true);
  check("chunked oversize stream cancels without draining remaining chunks", canceled && chunksPulled <= 3, true);

  // Multi-byte UTF-8 check: 100 x "😀" is 200 UTF-16 code units (.length), but 400 UTF-8 bytes!
  const emojiText = "😀".repeat(100);
  check("UTF-16 length is 200 while UTF-8 byte length is 400", emojiText.length === 200 && new TextEncoder().encode(emojiText).byteLength === 400, true);
  const utf8Req = new Request("https://slopcafe.com/admin/restore", {
    method: "POST",
    body: emojiText,
  });
  const utf8Res = await readBodyWithLimit(utf8Req, 300);
  check("multi-byte UTF-8 body exceeding byte limit (but <= UTF-16 length) is rejected as too_large", !utf8Res.ok && utf8Res.code === "too_large", true);
}

// ============================================================================
// Q6: putVersionBlobs partial-put orphan rollback + createOAuthClientCore KV rollback
// ============================================================================

{
  const prep = {
    cleanedHtml: "<p>hi</p>",
    cleanedBytes: new TextEncoder().encode("<p>hi</p>"),
    sourceBytes: new TextEncoder().encode("hi"),
    sourceFormat: "markdown",
    sanitizerV: "ammonia-v1.7",
    modified: false,
    stripped: [],
    will_not_render: [],
    depth: 2,
  };

  // Case 1: S put fails -> H key is deleted (no orphan).
  const stored1 = new Set();
  const deleted1 = [];
  const env1 = {
    DOCS: {
      async put(key) {
        if (key.endsWith(".src")) throw new Error("R2 S put failed");
        stored1.add(key);
      },
      async delete(keys) {
        for (const k of keys) {
          stored1.delete(k);
          deleted1.push(k);
        }
      },
    },
  };
  let threw1 = false;
  try {
    await putVersionBlobs(env1, "doc-1", 1, prep, { kind: "operator" });
  } catch {
    threw1 = true;
  }
  check("putVersionBlobs rethrows when S put fails", threw1, true);
  check("putVersionBlobs rolls back H blob on S put failure (0 orphans)", stored1.size === 0 && deleted1.length === 1, true);

  // Case 2: H put fails -> S key is deleted (no orphan).
  const stored2 = new Set();
  const deleted2 = [];
  const env2 = {
    DOCS: {
      async put(key) {
        if (!key.endsWith(".src")) throw new Error("R2 H put failed");
        stored2.add(key);
      },
      async delete(keys) {
        for (const k of keys) {
          stored2.delete(k);
          deleted2.push(k);
        }
      },
    },
  };
  let threw2 = false;
  try {
    await putVersionBlobs(env2, "doc-2", 1, prep, { kind: "operator" });
  } catch {
    threw2 = true;
  }
  check("putVersionBlobs rethrows when H put fails", threw2, true);
  check("putVersionBlobs rolls back S blob on H put failure (0 orphans)", stored2.size === 0 && deleted2.length === 1, true);

  // Case 3: createOAuthClientCore rolls back KV client if D1 INSERT throws.
  const kvStore = new Map();
  const deletedKv = [];
  const oauthEnv = {
    META: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("from agents")) return { id: "11111111-1111-4111-8111-111111111111", name: "Claude" };
                return null;
              },
              async run() {
                throw new Error("D1_ERROR: transient write failure");
              },
            };
          },
        };
      },
    },
    OAUTH_PROVIDER: {
      async createClient(info) {
        const client = { clientId: "cid_leak_test", clientSecret: "sec_x", redirectUris: info.redirectUris };
        kvStore.set(client.clientId, client);
        return client;
      },
      async deleteClient(id) {
        kvStore.delete(id);
        deletedKv.push(id);
      },
    },
  };
  let threwOAuth = false;
  try {
    await createOAuthClientCore(oauthEnv, "11111111-1111-4111-8111-111111111111", "https://slopcafe.com");
  } catch {
    threwOAuth = true;
  }
  check("createOAuthClientCore rethrows on D1 insert failure", threwOAuth, true);
  check("createOAuthClientCore rolls back KV client on D1 failure (0 orphans)", kvStore.size === 0 && deletedKv[0] === "cid_leak_test", true);
}

// ============================================================================
// M3: D1 concurrency constraint error translation (412 / 409)
// ============================================================================

check(
  "classifies D1 versions PK UNIQUE error",
  isVersionsPkConstraintError(
    new Error("D1_ERROR: UNIQUE constraint failed: versions.document_id, versions.version_no: SQLITE_CONSTRAINT"),
  ),
  true,
);
check(
  "classifies PRIMARY KEY constraint failed on versions",
  isVersionsPkConstraintError(new Error("PRIMARY KEY constraint failed: versions.document_id, versions.version_no")),
  true,
);
check(
  "classifies wrapped .cause versions PK error",
  isVersionsPkConstraintError(
    new Error("batch failed", { cause: new Error("UNIQUE constraint failed: versions.document_id, versions.version_no") }),
  ),
  true,
);
check(
  "does not misclassify documents.slug as versions PK",
  isVersionsPkConstraintError(new Error("D1_ERROR: UNIQUE constraint failed: documents.slug")),
  false,
);
check(
  "classifies D1 documents.slug UNIQUE error",
  isSlugUniqueConstraintError(new Error("D1_ERROR: UNIQUE constraint failed: documents.slug: SQLITE_CONSTRAINT")),
  true,
);
check(
  "classifies wrapped .cause slug UNIQUE error",
  isSlugUniqueConstraintError(
    new Error("batch failed", { cause: new Error("UNIQUE constraint failed: documents.slug") }),
  ),
  true,
);
check(
  "does not misclassify unrelated constraint as slug UNIQUE",
  isSlugUniqueConstraintError(new Error("UNIQUE constraint failed: agents.id")),
  false,
);

// End-to-end setDocumentSlugCore race: pre-check SELECT sees no conflict, then META.batch throws slug UNIQUE -> returns slug_taken!
{
  const raceEnv = {
    META: {
      prepare(sql) {
        const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
        return {
          bind() {
            return {
              async first() {
                if (norm.includes("from documents where public_id = ?")) {
                  return { id: "doc-uuid-1", slug: null, revoked_at: null };
                }
                // Pre-check SELECTs see no conflict / no tombstone.
                return null;
              },
            };
          },
        };
      },
      async batch() {
        throw new Error("D1_ERROR: UNIQUE constraint failed: documents.slug: SQLITE_CONSTRAINT");
      },
    },
  };
  const r = await setDocumentSlugCore(raceEnv, "AbCdEfGhIjKlMnOpQrStUv", "raced-slug");
  check("setDocumentSlugCore translates concurrent slug UNIQUE into slug_taken", !r.ok && r.code === "slug_taken" && r.slug === "raced-slug", true);
}

// ============================================================================
// Q7: Hygiene checks (SERVICE_DESC_LINK on admin-oauth errors + shared escapeHtml)
// ============================================================================

{
  const req = new Request("https://slopcafe.com/admin/agents/not-a-uuid/oauth-clients", {
    method: "POST",
    headers: { authorization: "Bearer test-op-token" },
  });
  const res = await createOAuthClient("not-a-uuid", req, { OPERATOR_TOKEN: "test-op-token" });
  check("admin-oauth error returns 404 for malformed agent id", res.status, 404);
  check("admin-oauth error carries SERVICE_DESC_LINK header (Q7)", res.headers.get("link"), SERVICE_DESC_LINK);

  const authSrc = readFileSync(
    fileURLToPath(new URL("../src/authorize.ts", import.meta.url)),
    "utf8",
  );
  checkThat("src/authorize.ts imports escapeHtml from ./html.js", authSrc.includes('import { escapeHtml } from "./html.js";'));
  checkThat("src/authorize.ts has no private duplicate escapeHtml function", !/function escapeHtml\(/.test(authSrc));
}

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} integrity-fixes test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall integrity-fixes tests passed");
}
