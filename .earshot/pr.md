Title: QL-275 S6: rebase the Insight fork onto main

Replays the Insight fork (`origin/insight` @ `7e64ca8`, 8 commits, 58 behind `main`) onto a fresh `origin/main` (`d8ab3d7`, v3.0.1) as a new branch. **`origin/insight` itself is untouched** — nothing was force-pushed or rewritten, so whatever is deployed for Insight today still has its source. Scope is QL-275 slice S6: rebase, renumber `0019`, add `AUTO_SLUG_REDIRECT`.

## What the fork contains (now on top of main)

- **Insight structured metadata** — six nullable, indexed `documents` columns (`app_package`, `app_version_code`, `app_version_name`, `compared_version_code`, `company`, `doc_kind`), set with `X-Doc-*` headers and MCP write inputs and returned on every read, list and search result. Migration renumbered **`0019` → `0021`**.
- **Reader tier + single-publisher write allowlist** — `READER_TOKENS` adds per-person read-only sessions. `WRITER_AGENT_IDS` limits writes to the listed agents (`403 read_only_agent`), enforced inside the shared write cores. `PUT /d/:id/{tags,status}` now require `requireCurator`, so a reader can never call them.
- **Browse by app** — `app_package`/`doc_kind`/`company` filters on both list routes and both search routes (HTTP and MCP), plus `GET /stats`.
- **Dense teardown theme** — `doc_kind` `teardown`/`teardown-section` gets a data-dense reading theme, chosen when the page is served.
- **Sanitizer** — one narrow image exception: `data:image/{png,jpeg,webp};base64` is allowed on SVG `<image>` only. Now stamped **`ammonia-v1.8`**.
- **`/text` envelope fix** (fork `7e64ca8`).

New in this PR (beyond replaying the fork):
- **`AUTO_SLUG_REDIRECT`** (S6, design §7.3). Set to exactly `"true"`, a browser following a retired slug gets a no-store `308` instead of the interstitial. It only applies after the readability check, agents still get `409 slug_redirected`, and only the operator can set redirects.
- **Backup/restore carries the six Insight columns.** Main's backup arrived with the rebase but would have reset them to NULL on a round trip.
- **`GET /d/:id/source`** now returns the six Insight fields. The contract already declared them, but the route dropped them, the same bug `7e64ca8` fixed for `/text`.
- **`.claude/rules/insight-fork.md`** is now the one home for the fork's guidance. CLAUDE.md is back to main's text plus short "(fork: …)" notes, at 149,996 characters (under the ~150k limit; main itself was at 150,155).
- Contract version **`3.1.0`**: an additive minor over main's 3.0.1. The fork's own 2.3.0–2.6.0 numbers are retired.

## Conflicts and how each was resolved

Main had split `core.ts`, `mcp.ts`, `admin.ts` and `serve.ts` into modules (#72), so most fork hunks were ported by hand, not merged textually. Where the two sides disagreed, main's fixes won.

| Fork commit | Conflict | Resolution |
|---|---|---|
| `2eb2b41` Insight metadata | `0019_insight_metadata.sql` vs main's `0019`/`0020` | Renumbered to `0021`, with a header that gives the one-time `d1_migrations` rename. |
| | `core.ts` deleted on main | Ported into `document-write.ts` (resolvers, insert, no-op check, update), `document-read.ts` (3 read cores) and `document-listing.ts` (listing columns). |
| | `mcp.ts` split into `mcp-tools/` | Fields and `metadataInputFromArgs` → `mcp-tool-fields.ts`; `readEnvelope` → `mcp-document-target.ts`. Update/edit use main's 3.0 `new_slug`. The sentence the keep-list protects is untouched; the Insight rule is a separate sentence. |
| | `openapi.ts` version, docs version claims | `3.1.0` with a fork ledger; the four documents that state the version updated. |
| `a2fe3a6` comment fix | none | Applied to the renamed file. |
| `f95f0be` reader tier + allowlist | `core.ts` | The gate goes first in publish/update/edit (before `screenAndPrepare`) and in tags/status, which now take a required `author`. `refuseNonWriter` lives in `auth.ts` so neither core module imports the other. |
| | `admin.ts` (git matched it to `admin-documents.ts`) | Reset to main and re-applied by hand: `requireReadSession` on the documents list/search/detail/versions reads and on `links/orphans`; `requireCurator` plus author on the two curate doors; `readOnlyAgent()` → `admin-response.ts`. **Main's newer operator reads (audit ledger, backup export, key prune) stay operator-only.** |
| | `serve.ts` split | Gates → `serve-policy.ts`; reader shells and version shell → `serve-shell.ts`; version raw and slug shell → `serve.ts`; tags/status forms → `manage.ts`. |
| | `access.ts` | Kept main's explicit `Author` union (it already excludes reader, and it carries main's `clientId`). |
| | `login.ts` vs main's audit ledger | Failures log `login_failed`; operator sign-ins log `login_succeeded`; **reader sign-ins log nothing**. 0020's `principal_kind` CHECK has no reader value, and logging a reader as the operator would be false. **Follow-up:** a migration that adds a reader principal to that CHECK. |
| | `console.ts` | Fork's tiered nav plus main's Audit link, operator only. |
| | `test/authz-surface.test.mjs` | Ported to the split modules. Every gated route main added since is classified operator-only. Mutation-checked: swapping a gate, or removing a `refuseNonWriter` call, fails the test. |
| | env, `.dev.vars.example`, `wrangler.toml.example`, `package.json`, README tables, CLAUDE.md | Both sides kept. |
| `c24fb05` dense theme | Main moved the theme into `serve-shell.ts`, which `platform-docs.ts` reuses | `reader-theme.ts` now owns both themes; `platform-docs.ts` imports from it. The fork's version of the prose theme had one extra blank line versus main's, now removed (and pinned by a test) so every non-teardown doc and every `/docs` page serves the same bytes as main. |
| `447b890` CORS | Already on main as `ccfffc3` (same code; the fork had only renumbered the version) | **Skipped.** |
| `e5bc42b` filters + `/stats` | `core.ts`, `admin.ts`, `mcp.ts`, `console.ts`, `cors.ts`, `openapi.ts` | `appendInsightFilters` → `document-listing.ts`, called from the list core and both search legs. `documentStats` → `admin-documents.ts`. MCP filter fields → `mcp-tool-fields.ts`. The console form now has main's visibility/publication filters **and** the fork's app/kind filters. `/stats` added to main's CORS eligibility list. `test/insight.test.mjs` re-pointed at the split modules. |
| `0003113` sanitizer image exception | **Main shipped its own `ammonia-v1.7`** (the `/docs/` new-tab change) | Main's v1.7 is kept intact, and the fork's change is stacked on top as **`ammonia-v1.8`**. A distinct stamp matters because `sanitizer_v` is part of the identical-write no-op key. Main's `attribute_filter` hadn't changed since the fork's base, so no main logic was overwritten. All `cargo test` suites pass, including the bypass corpus. |
| `7e64ca8` `/text` fix | none | Applied cleanly. |

## Validation

- `npm run typecheck`: clean.
- `npm test`: **all 33 suites pass**: 1,821 assertions, versus 1,469 on main. Includes the fork's `authz-surface`, `insight` and `reader-theme` suites and the ported `pagination`/`session`/`auth`/`access`/`contract`/`cors`/`openapi` cases.
- `cargo test` (sanitizer): 154 lib tests and 2 bypass-corpus tests pass.
- WASM, `openapi.json` and the `/docs` bundle were rebuilt; the freshness tests pass.
- **Not run:** the `test/e2e/*.sh` scripts. They need `wrangler dev`, and this deployment's AI/Vectorize bindings are remote-only. No `wrangler` command touched Cloudflare. No deploy, no secrets.

## Deploy notes for Kyle (before S7)

1. **Snapshot first.** `/admin/backup` only exists after this deploy, so take a D1 Time Travel bookmark of the Insight database (`npx wrangler d1 time-travel info META --remote`).
2. **Check the migration ledger:** `npx wrangler d1 migrations list META --remote`. Expect `0019_insight_metadata.sql` applied, and `0019_version_author_client.sql`, `0020_audit_events.sql` and `0021_insight_metadata.sql` pending.
3. **Rename the ledger row BEFORE applying**, or `0021` re-runs its ALTERs and fails with "duplicate column name":
   `npx wrangler d1 execute META --remote --command "UPDATE d1_migrations SET name = '0021_insight_metadata.sql' WHERE name = '0019_insight_metadata.sql'"`
   Then `npx wrangler d1 migrations apply META --remote`, which applies main's 0019 and 0020.
4. **Update the Insight `wrangler.toml`** (it's gitignored): add `"**/*.md"` to the `[[rules]] type = "Text"` globs (main now bundles the `/docs` corpus, and the build fails without it). Keep the existing `agent-web-host-*` resource names. Optionally set `AUTO_SLUG_REDIRECT = "true"` under `[vars]`; `WRITER_AGENT_IDS` and the `READER_TOKENS` secret carry over unchanged.
5. `npm run deploy` (it rebuilds WASM, `openapi.json` and the docs bundle first).
6. **Changes to expect:**
   - **Sanitizer stamp.** It moves to `ammonia-v1.8`. The first identical re-PUT of each doc will write one new version rather than being skipped as unchanged. auto-insight's client-side `current_source_sha256` skip still avoids most of these.
   - **MCP clients.** They see main's 3.0 MCP changes: `update_document`/`edit_document` take `public_id` or `slug` plus a separate `new_slug`, and `view_document` is opt-in via `?toolset=full`. The HTTP API changes are additive only.
7. **Still missing:** main's concurrent-write fix (`b193a4d`, on `fix/131-133-slug-oracle-update-races`) **is not on `main` yet, so it isn't in this rebase**. Concurrent PUTs to one document can still 500 until that lands and the fork is rebased again. Upstream minors after 3.0.1 will collide with the fork's `3.1.0`; the rules file says to bump past them next time.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012syqibunihsm9nL1F8dWDY
