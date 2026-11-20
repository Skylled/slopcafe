Title: QL-808: fix OAuth token/client lifetimes and renewal UX (Q1 + M1)

## Summary

Tracked under **QL-808** (PR 1 of 2 — **merge first**; PR 2 on `feat/ql-808/integrity-fixes` is stacked on top of this branch).

Eliminates the 30-day refresh-token expiry cliff, the 90-day client registration / `updateClient()` TTL trap, and the manual delete-before-reconnect `409` friction for Claude and ChatGPT OAuth connectors:

- **OAuth token & client lifetimes (`Q1`):**
  - Extract static provider config to `src/oauth-config.ts` and spread into `new OAuthProvider(...)` (`src/oauth.ts`).
  - Explicitly pass `refreshTokenTTL: undefined` (non-expiring rotating refresh tokens; overwrites `@cloudflare/workers-oauth-provider@0.8.2`'s strictly absolute 30-day default) and `clientRegistrationTTL: undefined` (never-expiring client registrations; fixes `updateClient()` TOFU callback approval overwriting pre-registered clients with a 90-day TTL).
  - Raise `ACCESS_TOKEN_TTL_SECONDS` from `900` (15 min) to `86_400` (24 hours), reducing refresh rotation race exposure and `token_issued` audit-ledger noise by ~96× while retaining instant cascading revocation via `DELETE /admin/oauth-clients/:client_id`.
- **Multi-client per agent & renewal UX (`M1`):**
  - Add migration `migrations/0021_oauth_clients_multi.sql` rebuilding `oauth_clients` without `UNIQUE(agent_id)` (unblocked by migration `0019` `versions.author_client_id`), preserving `PRIMARY KEY (client_id)`, `ON DELETE CASCADE`, and `oauth_clients_agent_id` index.
  - Remove single-client-per-agent `409` checks from `src/admin-oauth.ts`, `src/console.ts`, and `src/backup.ts`.
  - Add `GET /admin/oauth-clients` (fleet-wide D1 + `OAUTH_KV` liveness and active grant summary inventory; never exposes client secrets), `POST /admin/oauth-clients/prune` (`unbound` + `expired_ghosts` modes, `dry_run`, `OAUTH_PROVIDER.purgeExpiredData()`), and console form twin `POST /admin/console/oauth-clients/prune`.
  - Accept optional `redirect_uris` and `client_name` on manual bound/unbound client mint (`POST /admin/agents/:id/oauth-clients`, `POST /admin/oauth-clients`, and console forms).
  - Enrich `/admin/console/agents/:id` with KV status badges, grant expiry status, callback URIs, and ghost-row prune callout.
  - Enhance `/authorize` (`src/authorize.ts`) with agent-picker KV liveness annotations, automatic dead KV ghost eviction on bind, an inline `replace_existing` checkbox to revoke prior active clients during reconnect, and operator-only expired-client guidance (preserving non-operator anti-oracle behavior and anti-phishing invariants).
- **Spec, docs, and tests:**
  - Regenerate `openapi.json`, update `docs/design/dcr-design.md`, `docs/http-api.md`, `docs/design/api-contract-phase2-routes.md`, `CLAUDE.md`, `README.md`, and bundled docs under `src/generated/`.
  - Add `test/oauth-renewal.test.mjs` and live Worker E2E suite `test/e2e/oauth.sh` (registered in `scripts/run-e2e.sh`).

## Merge Order & Operations Note

- **Stacking:** PR 1 of 2 (`feat/ql-808/oauth-renewal` → `main`). Merge this PR **before** PR 2 (`feat/ql-808/integrity-fixes`).
- **Migration required before deploy:** Apply D1 migration `0021_oauth_clients_multi.sql` before deploying the Worker. Existing KV grants keep their old 30-day `expiresAt` until one final re-auth after deploy; all grants minted afterward are non-expiring.

## Validation

- `npm run build:wasm` — **PASS**
- `npm run typecheck` — **PASS**
- `npm test` (Rust sanitizer 142 unit + 2 bypass-corpus tests + all 31 JS unit suites incl. `test:oauth-renewal`, `test:authorize`, `test:openapi`, `test:docs-bundle`, `test:lockstep`, `test:audit`) — **PASS**
- `npm run build:openapi && git diff --exit-code openapi.json` — **PASS** (0 diff)
- Live Worker E2E against local `wrangler dev` (with migration `0021` applied):
  - `test/e2e/oauth.sh` — **PASS** (`34 passed, 0 failed`)
  - `test/e2e/audit.sh` — **PASS** (`36 passed, 0 failed`)
- Note: `test/e2e/mcp-apps.sh` and `test/e2e/mcp-toolset.sh` currently fail on `origin/main` (`02b28ff`) due to a pre-existing issue from PR 76 (`@modelcontextprotocol/server@2.3.1` requiring the `MCP-Protocol-Version: 2026-07-28` header, error `-32020`); untouched here.
