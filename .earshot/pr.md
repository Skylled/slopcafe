Title: QL-808: data-integrity, reliability, and hygiene fixes (Q2-Q7 + M3)

## Summary

Tracked under **QL-808** (PR 2 of 2 — **stacked on PR 78** [`feat/ql-808/oauth-renewal`](https://github.com/Skylled/slopcafe/pull/78); **merge PR 78 first**, then this PR).

Implements the data-integrity, concurrency, memory-safety, and hygiene quick wins from the QL-808 repository audit (`Q2`–`Q7` + `M3`):

- **`Q2` — Backup/restore `author_client_id` provenance + R2 purge chunking:**
  - Export and restore `versions.author_client_id` (migration `0019`) in `src/backup.ts` and `BackupVersionRecordSchema` (`src/contract.ts`, optional on input so pre-fix backups still restore cleanly with `NULL`), regenerating `openapi.json`.
  - Lift `deleteR2Keys()` (`R2_DELETE_BATCH = 1000`) to `src/document-storage.ts` and share it across `src/document-revoke.ts` and `src/backup.ts` so >500-version restore purges never exceed R2's 1,000-key delete batch cap.
- **`Q3` — Vectorize `getByIds()` chunking:**
  - Chunk `presentDocIds()` in `src/vector-io.ts` at `VECTORIZE_GET_BY_IDS_BATCH = 20` so `POST /admin/vectors/backfill?mode=missing` works with default/max page sizes (`50` / `200`) beyond 20 documents.
- **`Q4` — Eliminate double Markdown WASM parse on writes:**
  - Pass preconverted HTML (and UTF-8 `inputBytes`) from `screenAndPrepare()` into `prepareForStorage()` → `computeAdvisories()` (`src/document-write.ts`, `src/document-read.ts`) so Markdown writes invoke `markdownToHtml()` once instead of twice.
- **`Q5` — Stream-bounded request body reads (prevent isolate OOM & UTF-16 under-counting):**
  - Add pure Web Fetch `readBodyWithLimit()` in `src/http-body.ts` (fast-fail on declared `Content-Length > maxBytes` without pulling the stream, cancel stream immediately when streamed bytes exceed `maxBytes`, enforce true UTF-8 byte length).
  - Apply in `readVerifiedBody()` (`src/index.ts` for `POST /d` and `PUT /d/:public_id`) and `restoreBackup()` (`src/backup.ts`).
- **`Q6` — Eliminate R2 & OAuth KV partial-failure orphan leaks:**
  - Run H and S blob puts concurrently via `Promise.allSettled()` in `putVersionBlobs()` (`src/document-storage.ts`) and delete the fulfilled sibling if the other rejects.
  - Roll back `OAUTH_PROVIDER.deleteClient()` in `createOAuthClientCore()` (`src/admin-oauth.ts`) if the D1 `INSERT INTO oauth_clients` throws.
- **`M3` — Translate D1 concurrency constraint races into retryable `412` / `409`:**
  - Add `src/d1-errors.ts` (`isVersionsPkConstraintError`, `isSlugUniqueConstraintError`) walking `.cause` chains.
  - Translate concurrent `versions(document_id, version_no)` PK races in `updateDocumentCore` into `412 version_conflict` (with a `write_conflict` audit event), and concurrent `documents.slug` UNIQUE races in `publishDocumentCore`, `updateDocumentCore`, and `setDocumentSlugCore` into `409 slug_taken`.
- **`Q7` — Hygiene & drift fixes:**
  - Use shared `jsonError()` from `src/admin-response.ts` in `src/admin-oauth.ts` (adds `Link: </openapi.json>; rel="service-desc"`).
  - Import shared `escapeHtml()` from `src/html.ts` in `src/authorize.ts`.
  - Align `McpServer` (`src/mcp.ts`) and Dart CLI (`cli/pubspec.yaml`, `cli/lib/src/runner.dart`) versions to `3.0.1`.
  - Fix `src/seed-docs.ts` isolate latch (`seedInFlight` guard; latch `seedCheckedInIsolate` only after a pass with zero failed outcomes) and self-heal `published_ver !== current_ver` when `source_sha256` already matches.
  - Fix stale comments in `sanitizer/src/lib.rs` and `src/index.ts`. *(Note: the 1-line stale OpenAPI banner wording update in `.github/workflows/ci.yml` was deferred because the push token intentionally lacks GitHub `workflow` scope; it can be folded into PR 3 / CI catch-up.)*
- **Tests:**
  - Add `test/integrity-fixes.test.mjs` (wired into `npm test` via `package.json`) and extend `test/backup-format.test.mjs`.

## Merge Order

- **Stacked PR:** Based on commit `e7747e4` from PR 78 (`feat/ql-808/oauth-renewal`) because both PRs modify overlapping files (`src/admin-oauth.ts`, `src/authorize.ts`, `src/backup.ts`, `src/contract.ts`, `src/index.ts`, `openapi.json`, `package.json`).
- **Merge order:** Merge **PR 78 (`feat/ql-808/oauth-renewal`)** first, then merge **this PR (`feat/ql-808/integrity-fixes`)**.

## Validation

- `npm run typecheck` — **PASS**
- `npm test` (Rust sanitizer 142 unit + 2 bypass-corpus tests + all 32 JS unit suites incl. `test:integrity-fixes`, `test:backup`, `test:oauth-renewal`, `test:openapi`, `test:docs-bundle`, `test:lockstep`, `test:audit`) — **PASS**
- `npm run build:openapi && git diff --exit-code openapi.json` — **PASS** (0 diff)
- `cd cli && dart test test/version_test.dart` — **PASS** (`4/4` tests passed)
- Live Worker E2E against local `wrangler dev` (with migration `0021` applied):
  - `test/e2e/published-version.sh` — **PASS** (`31 passed, 0 failed`)
  - `test/e2e/no-op-collapse.sh` — **PASS** (`30 passed, 0 failed`)
  - `test/e2e/cors.sh` — **PASS** (`44 passed, 0 failed`)
  - `test/e2e/curation-and-detail.sh` — **PASS** (`30 passed, 0 failed`)
  - `test/e2e/backup-restore.sh` — **PASS** (`88 passed, 0 failed`)
  - `test/e2e/audit.sh` — **PASS** (`36 passed, 0 failed`)
  - `test/e2e/oauth.sh` — **PASS** (`34 passed, 0 failed`)
  - `test/e2e/mcp-apps.sh` & `test/e2e/mcp-toolset.sh` — **PRE-EXISTING FAIL on `origin/main` (`02b28ff`)**: `@modelcontextprotocol/server@2.3.1` (bumped in PR 76) rejects stateless `2026-07-28` JSON-RPC requests lacking an `MCP-Protocol-Version: 2026-07-28` header (`400`, JSON-RPC `-32020`). Untouched in this PR; follow-up fix is adding `-H "MCP-Protocol-Version: 2026-07-28"` to those two scripts.
