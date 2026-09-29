Title: fix: close the /s/:slug existence oracle and guard the update batch (#131, #132, #133)

Closes #131, closes #132, closes #133.

## #131: `/s/:slug` existence oracle (security)
`serveBySlug` looked the slug up (private docs included) before checking a presented credential, so the response to an invalid credential varied with the slug's state. The credential is now checked first, and every invalid-credential response is byte-identical whatever the slug's state. `/s/:slug/text` already checked the credential first; the e2e now pins its bytes too. `docs/http-api.md` states the ordering.

## #132: unguarded update batch
- The versions INSERT becomes `INSERT … SELECT … WHERE EXISTS(doc live at the read current_ver [+ slug is prior, new slug not tombstoned, agent ⇒ not public])`. Every later statement carries a `WriteGuard` witness (this attempt's own versions row, by nonced `r2_key`), so a lost race turns the whole batch into a no-op.
- The attempt that loses deletes its blobs and re-runs (max 3). The fresh read classifies the outcome as `not_found`, `version_conflict`, `slug_locked` or `slug_taken`. A same-base race is now a 412, not a 500.
- Revoke reads its purge list *after* the kill batch, so a write that commits in between can't leave H or `.src` blobs behind.
- The same guard applies to `setDocumentSlugCore` and the links backfill. Publish maps a slug UNIQUE race to `slug_taken`. Vector sync re-checks liveness before upsert.

## #133
- The storage-cap check moves after the no-op collapse.
- `putVersionBlobs` deletes H if the `.src` put fails.
- The misleading `serveRaw` comment about `published_ver` is corrected.

## CI fixes since the first push
- **e2e:** the clobber-race check counted statuses over concatenated newline-less `curl -w` output, so it saw zero successes. It now classifies each response separately. The code under test was correct.
- **gitleaks:** the junk bearer in `write-races.sh` was a literal `curl -H "authorization: Bearer …"`, which the default `curl-auth-header` rule flags. It's now held in a variable (the `audit.sh` convention) and folded into the original commit, so no quarantine entry is needed. The branch was force-pushed for this.

## Tests (run locally)
- `npm run typecheck`: pass.
- `npm test`, the full suite including `test:sanitizer` (cargo) and `test:docs-bundle`: pass.
- `scripts/run-e2e.sh`, all nine suites against `wrangler dev`: pass. `write-races.sh` passed 36/36 on two separate runs.

## Known residuals (not fixed)
- Publish can still claim a slug that another doc claimed and gave up between `resolveSlug` and the batch. The window is narrow, and closing it means restructuring the documents INSERT.
- An ambiguous batch error (committed, then threw) would delete the blobs.
- A vector-embedding ordering race can let an older embed overwrite a newer one. It self-heals on the next write.
- If an update loses three consecutive slug races with no version change, it still throws (500), because no honest retryable code fits.
- Unrelated to this PR: `test/e2e/mcp-apps.sh` fails under macOS's stock bash 3.2 (`"${2:-{\}}"` expands to `{\}`). It passes under bash 5, as in CI.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01GrrdsbkBPcykonECaPMynA
