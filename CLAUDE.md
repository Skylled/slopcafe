# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Build / deploy / dev:
```sh
npm run dev            # wrangler dev — uses .dev.vars + local D1/R2
npm run typecheck      # tsc --noEmit
npm run build:wasm     # rebuild the Rust→WASM sanitizer (auto-run via predeploy)
npm run deploy         # rebuilds WASM then `wrangler deploy`
```

Tests:
```sh
npm test                  # runs sanitizer corpus + advisories
npm run test:sanitizer    # cargo test in /sanitizer (host target, not wasm)
npm run test:advisories   # node --experimental-strip-types test/advisories.test.mjs

# Run a single sanitizer test (Rust name match):
(cd sanitizer && PATH="$HOME/.cargo/bin:$PATH" cargo test rejects_script_tag)
```

Database (D1):
```sh
npm run db:migrate:local            # apply migrations to local D1
npm run db:migrate:remote           # apply migrations to remote D1
npm run db:console:local  "SELECT * FROM agents"
npm run db:console:remote "SELECT * FROM agents"
```

`predeploy` injects `$HOME/.cargo/bin` into PATH so `wasm-pack` resolves from a fresh shell. Rust toolchain (`rustup` + `wasm32-unknown-unknown` target + `wasm-pack`) is only required for `build:wasm`.

## Architecture

**Single Worker, one origin.** `src/index.ts` exports an `innerHandler` doing exact-match route dispatch, and the default export is that handler wrapped in `@cloudflare/workers-oauth-provider` (see `src/oauth.ts`). The OAuth wrap intercepts `/mcp` (its `apiRoute`), validates the token, populates `ctx.props.agentId`, and dispatches to the same inner handler as `apiHandler`. Everything else (including `/authorize` and the `awh_`-bearer path on `/mcp`) goes to `defaultHandler`. **The inner handler is registered as both `apiHandler` and `defaultHandler`** — the only difference between the two paths is whether `ctx.props.agentId` is populated.

**Two auth doors converge on one identity (`AwhProps` in `src/mcp-auth.ts`):**
- **Door A (OAuth 2.1 + PKCE)** — one pre-registered client per agent, pinned at mint time via `POST /admin/agents/:id/oauth-clients`. Consent UI lives in `src/authorize.ts`; the operator approves with `OPERATOR_TOKEN`. Used by Cowork / claude.ai web. `agentId` comes from the grant's `encryptedProps` (via `ctx.props`).
- **Door B (static `awh_` bearer)** — same key shape `POST /d` uses. Plumbed into the OAuth wrap as `resolveExternalToken` so a single configured `apiRoute` covers both transports. `agentId` comes from `authenticateAgent` (HMAC-under-pepper + `revoked_at` check on `agent_keys`).

**Shared write path: `src/core.ts`.** Both HTTP (`POST /d`, `PUT /d/:id` in `src/index.ts`) and MCP (`src/mcp.ts` tools) call `publishDocumentCore` / `updateDocumentCore` / `readDocumentCore` / `revokeDocumentCore` / `listDocumentsCore`. **Sanitization runs exactly once, inside core**, regardless of door. If you add a new write surface, route it through core — never duplicate the sanitize → cap-check → R2 → D1 sequence.

**Two security layers (in order):**
1. **Sandbox + strict CSP at render** (`src/serve.ts`). `GET /d/:id` returns a tiny HTML shell with `<iframe sandbox>` (empty = all restrictions on); `GET /d/:id/raw` is what the iframe loads under `default-src 'none'` + `frame-ancestors 'self'`. Two URLs is deliberate — `frame-ancestors` is header-only, so the bytes must come from an HTTP response, not `srcdoc`. **This is the load-bearing wall.**
2. **Ammonia-WASM sanitization at write** (`sanitizer/src/lib.rs` → `src/sanitizer.ts`). Strips `<script>`, `<style>`, `<meta http-equiv>`, `<iframe>`, dangerous URL schemes, inline event handlers. Cheap insurance behind the CSP wall (covers e.g. `<meta refresh>` which CSP can't).

**Storage model.** D1 (`META` binding) holds the metadata — see `migrations/0001_init.sql` for `agents`, `agent_keys`, `documents`, `versions`, and `0002_oauth_clients.sql` for `oauth_clients` (client_id ↔ agent_id join). R2 (`DOCS` binding) holds one sanitized blob per version at key `<docId>/v<n>`; `versions` rows are append-only and survive revoke as an audit trail (only the R2 bytes are purged). KV (`OAUTH_KV` binding) is owned by the OAuth provider library (clients, grants, tokens). On revoke, `documents.revoked_at` is flipped **before** the R2 batch delete so the doc is unreachable instantly even if R2 cleanup hangs.

**Single-tenant trust model.** Any active agent key under one operator can `PUT` to any document — `core.ts` deliberately does not scope updates by `created_by`. `documents.created_by` retains the original creator; new version metadata records the writer's `agent_id` only in R2 `customMetadata`. `listDocumentsCore` shows the whole fleet to every caller. If per-agent scoping ever becomes needed, add a `createdBy?` arg to core functions.

**Sanitizer is bundled as WASM.** `src/sanitizer.ts` imports `sanitizer/pkg/sanitizer_bg.wasm` directly as a `WebAssembly.Module` (wrangler's `[[rules]] type = "CompiledWasm"` rule) and calls `initSync`. **Do not use the wasm-pack `--target web` glue's `init()`** — it tries to fetch via `import.meta.url`, which doesn't exist on Workers. Init is lazy and idempotent. `skills/publishing.md` is bundled the same way via the `[[rules]] type = "Text"` rule and served verbatim as the `awh://publishing-guide` MCP resource — the same bytes humans read.

**MCP server lifecycle.** `src/mcp.ts` builds a fresh `McpServer` **per request**. The MCP SDK ≥1.26 throws on reused instances and cross-request state would leak. The four tools (`publish_document`, `update_document`, `read_document`, `list_documents`) close over `props.agentId` resolved upstream — they never re-validate auth. Tool descriptions are intentionally heavy with the HTML contract (static-only, inline-SVG-not-`<img>`, inline styles); a cold agent that never reads `skills/publishing.md` should still understand the rules from the description alone. When editing tool descriptions, preserve the priority order (non-negotiables first) — length-trimmed renders truncate the tail.

## Conventions and gotchas

- **`If-Match` is required on `PUT /d/:id`** (428 if missing). Send `"v<n>"` for optimistic concurrency or `*` to skip. Strong tags only; no weak tags, no multi-tag lists.
- **`POST /d` requires `Content-Type: text/html`** (415 otherwise). Body is sanitized in-process and stored as `text/html; charset=utf-8`.
- **`public_id` regex is fixed**: `/^[A-Za-z0-9_-]{22}$/` (`PUBLIC_ID_RE` in `src/serve.ts`). It's safe to interpolate into HTML templates after this check; `serveShell` does so.
- **Storage cap is best-effort.** `checkStorageCap` runs `SUM(size_bytes)` outside the insert batch; two concurrent writes can both pass. v1 accepts the slight overrun.
- **Logging discipline in MCP tools** (`src/mcp.ts`): log tool name + error code only. Never args (may contain user HTML), never request headers (may contain the bearer), never the OAuth token.
- **Adding a sanitizer test:** the ~40 negative assertions live inline at the bottom of `sanitizer/src/lib.rs`. Each tweak to `make_builder()` should add a case there.
- **Adding an advisory:** `src/advisories.ts` is regex-based on (input, cleaned) pairs — false negatives are acceptable, false positives are not. The entity-encoded-script test in `test/advisories.test.mjs` is the guard against false positives.
- **Wrangler version + Workers types** are pinned in `package.json`. `compatibility_date = "2026-05-26"` with `nodejs_compat`.
- **Secrets** (`HMAC_PEPPER`, `OPERATOR_TOKEN`) live in `.dev.vars` for local dev (gitignored) and `wrangler secret put` for production — never `[vars]` in `wrangler.toml`.

## Where things live

- `src/index.ts` — route dispatch + thin HTTP wrappers for `/d` and `/d/:id`. Default export wraps `innerHandler` with the OAuth provider.
- `src/core.ts` — sanitize/cap-check/R2/D1 sequence shared by HTTP and MCP. **Add new write surfaces here, not in route handlers.**
- `src/serve.ts` — the two render URLs (shell + raw). CSP and sandbox flags are defined here.
- `src/oauth.ts` — OAuth provider config. `resolveExternalToken` is the Door B integration point.
- `src/mcp.ts` — MCP server + four tools, per-request lifecycle. Imports `skills/publishing.md` as a bundled resource.
- `src/mcp-auth.ts` — the `AwhProps` type both doors converge on.
- `src/authorize.ts` — Door A consent UI (GET form + POST verify against `OPERATOR_TOKEN`).
- `src/admin.ts`, `src/admin-oauth.ts` — operator endpoints; `revokeAgent` cascades both keys and OAuth clients.
- `src/auth.ts` — `authenticateAgent` (HMAC + revoked check), `authenticateOperator` (constant-time string compare), `bearerToken`, `hmacSha256Hex`.
- `src/ids.ts` — `newUuid`, `newPublicId` (22-char URL-safe base64), API key mint/parse.
- `src/sanitizer.ts` — WASM init shim.
- `src/advisories.ts` — regex-based `stripped[]` / `will_not_render[]` detection for write responses.
- `sanitizer/src/lib.rs` — Ammonia allowlist + ~40 corpus tests.
- `migrations/` — D1 schema. `0001_init.sql` (agents/keys/docs/versions), `0002_oauth_clients.sql`.
- `skills/publishing.md` — agent-facing authoring contract; also bundled as the `awh://publishing-guide` MCP resource. **Keep in sync with the sanitizer allowlist.**
- `skills/connector-guide.md` — human-facing guide for wiring Claude/Gemini connectors.
- `action-plan-v1.md` — design rationale, security model, deliberate v1 omissions.
