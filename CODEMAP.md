# Slopcafe code map

This is the progressive-disclosure entry point for contributors—human or
agent. It answers “where do I start?” without duplicating the repository’s
detailed invariants.

[`CLAUDE.md`](CLAUDE.md) is canonical. Read its relevant topic before changing
behavior, security policy, storage sequencing, or a public contract. This map
routes you to that detail; it does not supersede it.

## Start by task

| If you are changing… | Start here | Contract and verification |
|---|---|---|
| Route dispatch or an HTTP document write | `src/index.ts` | `src/openapi.ts`, `test/openapi.test.mjs`, applicable `test/e2e/*.sh` |
| MCP transport or Apps resources | `src/mcp.ts` | `src/contract.ts`, `test/mcp-errors.test.mjs`, `test/e2e/mcp-*.sh` |
| An MCP tool registration | `src/mcp-tools/<tool>.ts` when split; otherwise `src/mcp.ts` | `src/mcp-tool-input.ts`, `src/mcp-tool-result.ts`, `src/mcp-toolset.ts`, `test/mcp-*.test.mjs` |
| Short-lived publish credentials | `src/publish-credential.ts` | `src/auth.ts`, migration 0007, `test/auth.test.mjs`, MCP credential-tool tests |
| Document publish/update/edit transaction | `src/core.ts` | `test/e2e/no-op-collapse.sh`, `test/e2e/published-version.sh`, sanitizer tests |
| Document listing projection or filters | `src/document-listing.ts` | `test/document-listing.test.mjs`, `test/pagination.test.mjs` |
| Search ranking or retrieval | `src/search-core.ts` | `src/search-ranking.ts`, `test/search-ranking.test.mjs`, `test/e2e/curation-and-detail.sh` |
| Context-pack selection or fill | `src/pack-core.ts` | `src/pack.ts`, `test/pack.test.mjs`, `test/e2e/curation-and-detail.sh` |
| Backlinks, outbound links, or link repair | `src/links-core.ts` | write-time sync in `src/core.ts`, `test/e2e/curation-and-detail.sh` |
| Public document shell/raw/text/source serving | `src/serve.ts` | `src/served-version.ts`, `docs/security-model.md`, applicable E2E tests |
| Operator JSON APIs | `src/admin.ts`, `src/admin-oauth.ts` | `src/openapi.ts`, operator-console callers, applicable E2E tests |
| Operator browser UI | `src/console.ts`, `src/manage.ts` | `src/session.ts`, HTML/CSP rules in `CLAUDE.md` |
| Authentication or authorization | `src/auth.ts`, `src/access.ts`, `src/session.ts`, `src/oauth.ts` | matching unit tests plus `docs/security-model.md` |
| API response shape or error code | `src/contract.ts` | `src/openapi.ts`, `test/contract.test.mjs`, regenerate `openapi.json` when needed |
| Backup/restore | `src/backup-format.ts`, then `src/backup.ts` | `test/backup-format.test.mjs`, `test/e2e/backup-restore.sh` |
| Sanitization or HTML→Markdown conversion | `sanitizer/src/lib.rs`, `sanitizer/src/markdown.rs` | `sanitizer/tests/`, `skills/publishing.md`, `docs/security-model.md` |

## Runtime flow

`src/index.ts` is the Worker entry point. It classifies the request and delegates
to narrowly scoped transport modules. HTTP and MCP writes converge on the same
functions in `src/core.ts`; route handlers must not reproduce the sanitization,
storage-cap, R2, D1, link-sync, or vector-sync sequence.

Credentialed read discovery is divided by concern:

- `src/document-listing.ts`: shared projection, row decoding, and filter SQL.
- `src/search-core.ts`: keyword/semantic retrieval and fusion.
- `src/pack-core.ts`: context-pack roots and budgeted body fill.
- `src/links-core.ts`: link-graph reads and repair.

Public HTML delivery is a separate security boundary in `src/serve.ts`. The
published/current pointer decision is centralized in `src/served-version.ts`.

## Sources of truth

- Repository behavior and implementation invariants: `CLAUDE.md`.
- Runtime response/data schemas and error codes: `src/contract.ts`.
- HTTP operations: `src/openapi.ts`; `openapi.json` is generated output.
- MCP tool names and presets: `src/mcp-toolset.ts`.
- Database shape: ordered files under `migrations/`.
- Static authoring/sanitization contract: `skills/publishing.md` plus the Rust
  sanitizer implementation.
- Bundled documentation registry: `scripts/platform-docs.json`.

## Generated files

Do not hand-edit `openapi.json`, `src/generated/platform-docs.ts`, or files
under `src/generated/docs/`. Use `npm run build:openapi` or
`npm run build:docs`, then commit the resulting artifacts with their source.

The Dart API client under `cli/lib/api/` is also generated; follow the three-pin
procedure in `CLAUDE.md` when intentionally updating it.

## Verification rule

Run `npm run typecheck` and `npm test` for every structural move. Then run the
specific E2E script named by `CLAUDE.md` whenever the change crosses a D1/R2,
OAuth/MCP, CORS, publication, audit, or backup boundary. A source-only move is
not exempt when tests inspect source placement or generated documentation.
