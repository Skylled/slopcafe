# Changelog

All notable changes to Slopcafe are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The **HTTP API contract** is versioned separately under strict semver via
`info.version` in [`openapi.json`](openapi.json) — see the versioning notes in
[`docs/http-api.md`](docs/http-api.md). This file tracks the project/release as a
whole.

## [Unreleased]

### Changed
- **The repo ships `slopcafe-*` infrastructure defaults.** `wrangler.toml.example`
  and both setup guides now create `slopcafe` (Worker), `slopcafe-docs` (R2 and
  Vectorize) and `slopcafe-meta` (D1) instead of the original `agent-web-host-*`
  code-name. **Existing deployments are unaffected** — `wrangler.toml` is
  gitignored, so nothing renames itself on upgrade; this only changes what a new
  fork provisions.
- **`npm run db:*` and `test/e2e/*.sh` address D1 by its `META` binding** instead
  of by resource name, so they run unmodified in any deployment. Previously a fork
  that renamed its database had to patch `package.json` — a tracked file — and
  then carried that conflict on every upstream pull.
- Example environment variables in the publishing and connector guides are now
  `SLOPCAFE_BASE` / `SLOPCAFE_KEY`, matching what `scripts/doc-web.mjs` and the
  CLI actually read (was `AGENT_WEB_HOST_URL` / `AGENT_WEB_HOST_KEY`).
- The OpenAPI document is titled "Slopcafe HTTP API".

The `awh_` credential prefix, the `awh_session` / `awh_csrf` cookies and the
`awh-*` version stamps are deliberately **unchanged**: those are wire format and
cache/version identity, not branding, and renaming them would invalidate live
keys and sessions.

## [1.0.0] - 2026-06-09

First public release. The repository is now open source (Apache-2.0) and the HTTP
API contract is frozen at `1.0.0` under strict semver.

A single Cloudflare Worker that lets authenticated agents publish HTML at
unguessable URLs: humans click the URL and get a sandboxed render under a strict
CSP, agents `GET` the same URL with their key and get raw sanitized HTML. One
deployment, one domain — writes and reads never cross an origin boundary.

### Publishing & reads
- Publish / update / read / revoke documents by unguessable `public_id`
  (`POST/PUT/GET/DELETE /d/:id`), with content-negotiated reads: sandboxed shell
  for browsers, raw sanitized HTML for credentialed agents.
- HTML sanitization in-process via Ammonia (Rust → WASM); source HTML retained
  alongside the sanitized output.
- Per-document version history with operator restore and agent read-only access;
  conditional GET (`If-None-Match` → `304`) on the render path.
- Per-document public/private visibility gate; operator-renamable slugs with
  retire-and-redirect on revoke (retired slugs never released).
- Rich social link previews (Open Graph), description normalization, and
  `robots` noindex controls.

### Discovery
- Hybrid semantic search over documents via Vectorize + Workers AI embeddings,
  with reciprocal-rank fusion.
- Context packs — curated and ad-hoc — surfaced through search and the
  `load_context_pack` tool; a document lifecycle/status axis.

### Agent & operator interfaces
- MCP server at `/mcp` (OAuth or `awh_` bearer) — eight tools, all with
  structured `outputSchema`.
- OAuth 2.0 authorization-code flow with inline TOFU consent, bind-or-mint agent
  identity at approval, and optional Dynamic Client Registration.
- Operator admin API and a browser-based operator console at `/admin/console`.
- Code-first OpenAPI 3.1 spec generated from the Zod contract (`src/contract.ts`),
  served live at `/openapi.json` and committed at the repo root with a CI
  freshness gate.

### Storage & ops
- Cloudflare D1 (metadata), R2 (append-only sanitized bytes), KV (OAuth grants /
  tokens), Vectorize (semantic index), Workers AI (embeddings).
- Designed to sit in Cloudflare's low/free tiers at personal scale.

> **Scope.** Single-operator, single-tenant by design: one `OPERATOR_TOKEN`, one
> deployment, trust shared fleet-wide. Multi-tenant isolation is a deliberate v1
> non-goal — see [`docs/design/action-plan-v1.md`](docs/design/action-plan-v1.md).

[1.0.0]: https://github.com/Skylled/slopcafe/releases/tag/v1.0.0
