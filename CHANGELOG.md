# Changelog

All notable changes to Slopcafe are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The **HTTP API contract** is versioned separately under strict semver via
`info.version` in [`openapi.json`](openapi.json) — see the versioning notes in
[`docs/http-api.md`](docs/http-api.md). This file tracks the project/release as a
whole.

## [Unreleased]

### Changed
- **Documentation is now a build artifact, served at `/docs/<name>`** (#4). The
  reference corpus used to be *mirrored* onto the running platform as ordinary
  documents by `scripts/doc-web.mjs` — an agent key, a byte-exact PUT, and a
  separate operator promote, all driven by hand. That made a stale live copy a
  representable state (which is why a drift *detector* had to exist) and made
  every runtime pointer at a doc — `/healthz`'s `docs` field, the MCP tool
  descriptions that tell a model what to read — a claim about whether someone
  had run a script on *that* instance. Documentation about the code is a build
  artifact of the code, like `openapi.json`: `scripts/build-docs.mjs` now
  renders every doc registered in `scripts/platform-docs.json` at build time
  (`predeploy`), and the Worker serves it. A fresh fork serves complete,
  accurate docs on its first deploy with no credentials and no ritual, and
  `npm test` fails on a stale bundle.
  - `scripts/doc-web.mjs` and `scripts/doc-web-map.json` are **deleted**;
    `scripts/platform-docs.json` replaces the map and carries no per-instance
    `public_id`s, so the registry is identical on every deployment.
  - Sanitizer bumped to **`ammonia-v1.7`**: `/docs` and `/docs/<name>` join
    `/d/` and `/s/` as on-platform paths for the new-tab pass, since they are
    served under `frame-ancestors 'none'` and an in-frame click would blank the
    render frame.
  - `/healthz`'s `docs` pointer and three MCP tool descriptions now name
    surfaces this build actually serves, rather than documents that happened to
    exist in the origin deployment.

### Added
- **Corpus backup + restore** (#9). `GET /admin/backup` streams one
  cursor-paginated NDJSON page of the whole corpus — agents, key hashes,
  OAuth-client bindings, documents, versions **with both R2 blobs inline**, link
  rows, slug tombstones — and `POST /admin/restore` verifies (the default) or
  applies a page. Restore re-asserts recorded identity (`public_id`s, ids,
  version numbers, timestamps) so shared links survive a disaster, re-derives
  every live version's render from its **source** through the current sanitizer
  (the file's HTML is never trusted; a bad `source_sha256` is `corrupt`; no
  source is `source_unavailable`), mints fresh R2 keys, never releases a slug
  tombstone, and rejects a page whole if any line fails schema validation.
  Console twin on the Maintenance page (download link + upload form).
  Same-deployment disaster recovery only — portability is deferred. Contract:
  additive under `3.0.0` (`BackupRecord`, `RestoreReport`); proven by
  `test/e2e/backup-restore.sh`.
- **`GET /docs`, `GET /docs/:name`, `GET /docs/:name/raw`** — the bundled
  documentation. `Accept: text/markdown` on `/docs/:name` returns the source, so
  an agent can ingest a doc as context. Public, anonymous, indexable.
- **`POST /admin/docs/seed`** (operator) — runs a seeding pass and reports each
  doc's outcome. An MCP agent cannot fetch an HTTP route, so the two docs a tool
  description *instructs* a model to read are also published into the corpus,
  under the reserved `slopcafe-docs-` slug namespace. Seeding is automatic
  (latched once per isolate off `/mcp`) and idempotent; this route is the
  immediate lever and the diagnostic.
- **Reserved slug namespace `slopcafe-docs-`.** Any writer — agent **or
  operator** — claiming a slug with that prefix is refused with
  `422 invalid_slug` (`reason: "reserved_prefix"`). Contract bumped to `2.4.0`.

> **Operator action required on upgrade.** If your corpus already holds a slug
> starting with `slopcafe-docs-`, the seeder will overwrite that document's
> content on the next deploy — rename it first. If you previously mirrored the
> docs corpus as documents, those rows are now orphaned: nothing updates them,
> and an agent searching the corpus will find both them and the bundled pages.
> Revoke them, and release their tombstones if you want the names free.

### Fixed
- **`/` no longer 404s forever on a forked deployment** (#55). The homepage
  document's `public_id` was a constant in `src/serve.ts` naming a document in
  the origin deployment's database, so every fork served an opaque 404 at `/`
  that only a source edit + redeploy could clear — and with `GET /d` being
  `requireReader`-gated, a fresh operator had no anonymous way to find an id to
  point it at. It's now the optional `HOMEPAGE_PUBLIC_ID` var, and an unset,
  malformed, missing, revoked, or non-public id renders a short
  "<brand> is running" placeholder (200, `noindex`) instead of a 404.

> **Operator action required on upgrade.** An existing deployment that relied
> on the old constant must add its homepage document's id to `wrangler.toml`
> before the next deploy, or `/` will serve the placeholder:
>
> ```toml
> [vars]
> HOMEPAGE_PUBLIC_ID = "<the 22-char public_id>"
> ```

### Changed
- **`GET /` no longer returns 404** in any case (contract change, hence the
  major): an unconfigured homepage is a normal state, not an error. Reflected
  in `openapi.json`.
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
