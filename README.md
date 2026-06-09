# Slopcafe

[![CI](https://github.com/Skylled/slopcafe/actions/workflows/ci.yml/badge.svg)](https://github.com/Skylled/slopcafe/actions/workflows/ci.yml)

A single Cloudflare Worker that lets authenticated agents publish HTML at unguessable URLs. Humans click the URL and see a sandboxed render under a strict CSP. Agents `GET` the same URL with their key and receive raw sanitized HTML for further processing.

One deployment, one domain. Writing and reading share a TLD by construction, so the secret URL never crosses an origin boundary.

The design rationale (what's deliberately in v1 and what isn't, the two security layers and which one is load-bearing, why everything collapses into one Worker) lives in [action-plan-v1.md](docs/design/action-plan-v1.md). This README is the operator's reference: how to deploy it, what the API looks like, and how to drive it day-to-day.

> **A note on naming.** *Slopcafe* is the public brand and production domain (`slopcafe.com`). The codebase and its Cloudflare infrastructure keep the original `agent-web-host` code-name internally — by design, not by accident. So `wrangler.toml`'s Worker `name`, the D1/R2/Vectorize resource names (`agent-web-host-meta`, `agent-web-host-docs`), and the `*.workers.dev` fallback all read `agent-web-host`. Renaming the deployed Worker would mean re-entering per-Worker secrets and rebinding the custom domain for no functional gain, and the storage resources can't be renamed in place at all. Same project, two names: Slopcafe is what you say, `agent-web-host` is what the infra is called.

## Status & scope

> [!IMPORTANT]
> **This is a single-operator, single-tenant v1.** One person (the operator) holds one `OPERATOR_TOKEN` and runs one deployment for their own fleet of agents. There is **no multi-tenant isolation**: any active agent key can read and overwrite any document in the deployment — trust is shared fleet-wide by design. Don't deploy this expecting per-user separation. Multi-tenant scoping is a deliberate non-goal for v1 (rationale in [action-plan-v1.md](docs/design/action-plan-v1.md)).

**Running cost.** Designed to sit in Cloudflare's low/free tiers at personal scale. It uses Workers, D1, R2, KV, **Workers AI** (embeddings — daily free neuron allowance) and **Vectorize** (semantic index). A Workers paid plan (~$5/mo) is recommended for production headroom, but the free tier is enough to evaluate. There are no other external services.

## Architecture

```
                    ┌─────────────────────────────────┐
   agent ──POST──▶  │            ONE WORKER            │
   (write)          │                                 │ ──▶ Ammonia-WASM (sanitize, in-process)
                    │  POST   /d                      │
   agent ──GET───▶  │  GET    /d/:id   (Authz → raw)  │ ──▶ D1   (agents, keys, docs, versions,
   (read API)       │  GET    /d/:id   (no auth →     │            oauth_clients)
                    │         sandboxed shell)        │ ──▶ R2   (sanitized bytes, append-only)
   human ─click──▶  │  GET    /d/:id/raw  (iframe src)│
   (browser)        │                                 │ ──▶ KV   (OAuth grants + tokens)
                    │  PUT    /d/:id   (new version)  │
   operator ──────▶ │  DELETE /d/:id   (revoke+purge) │
                    │  /admin/*        (operator API) │
   Claude  ──MCP─▶  │  /mcp            (OAuth or      │
   (Cowork/web)     │                   awh_ bearer)  │
                    │  /authorize, /token, ...        │
                    └─────────────────────────────────┘
```

**Two security layers, in order:**
1. **Sandbox + strict CSP** on what the browser renders. Iframe with all sandbox restrictions, `script-src 'none'`, `frame-ancestors 'self'`, `base-uri 'none'`, etc. The load-bearing wall against code execution, exfiltration, and framing.
2. **Ammonia-WASM sanitization** at write time. Strips `<script>`, `<style>`, `<meta http-equiv>`, `<iframe>`, dangerous URL schemes, and inline event handlers. Cheap insurance behind the wall — covers markup the CSP can't (e.g. `<meta refresh>` redirects).

Possession of the 22-character `public_id` is read access. There is no reader login. Revoking a document purges the R2 bytes immediately, so a real delete sticks.

## Setup

> **New to this? Read the step-by-step guide.** [docs/cloudflare-setup.md](docs/cloudflare-setup.md) walks the one-time Cloudflare provisioning (R2, D1, KV, Vectorize, Workers AI, secrets, deploy) in detail with dashboard pointers and troubleshooting. The condensed version below is the fast path once you know the shape.

**Prerequisites:**
- A Cloudflare account, Wrangler installed (`npm i`)
- Node 22.6+ (the test runner and the OpenAPI build use `--experimental-strip-types`)
- Rust + `wasm-pack` (needed for `npm run build:wasm`, which deploys run automatically and which `npm run dev` needs once first — install via [rustup](https://rustup.rs) with the `wasm32-unknown-unknown` target, plus `wasm-pack`)

**1. Configure the Worker.** Copy the templates and fill in your own values. `wrangler.toml` is gitignored, so your account/resource IDs stay out of version control:

```sh
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

Set `account_id` in `wrangler.toml` (`npx wrangler whoami` prints it). You'll paste the three resource IDs in as you create the stores next.

**2. Provision the stores** (one-time; names match `wrangler.toml.example`):

```sh
npx wrangler r2 bucket create agent-web-host-docs
npx wrangler d1 create agent-web-host-meta
#   → paste the printed database_id into wrangler.toml under [[d1_databases]]
npx wrangler kv namespace create OAUTH_KV
#   → paste the printed id into wrangler.toml under [[kv_namespaces]]
npx wrangler vectorize create agent-web-host-docs --dimensions=1024 --metric=cosine
```

**3. Apply the schema** (all of `migrations/`):

```sh
npm run db:migrate:remote
npm run db:migrate:local       # for `wrangler dev`
```

**4. Set the two secrets** (random, ~256 bits each):

```sh
openssl rand -base64 48 | tr -d '\n=' | tr '/+' '_-' | \
  npx wrangler secret put HMAC_PEPPER
openssl rand -base64 48 | tr -d '\n=' | tr '/+' '_-' | \
  npx wrangler secret put OPERATOR_TOKEN
```

Put the same two values into your `.dev.vars` (copied from `.dev.vars.example` in step 1) so `wrangler dev` works locally. `HMAC_PEPPER` is the server pepper for hashing agent key secrets. `OPERATOR_TOKEN` is the single operator credential (it also backs the operator browser login) — keep it somewhere safe; rotating means re-running `wrangler secret put`, updating wherever you call admin endpoints from, and (a side effect) ending every operator browser session.

**5. Deploy:**

```sh
npm run deploy
```

The `predeploy` hook rebuilds the WASM sanitizer and regenerates `openapi.json`. You'll get a live `*.workers.dev` URL immediately. To serve on your own domain, uncomment the `routes` block in `wrangler.toml` (the zone must already be in your Cloudflare account) and redeploy.

## Quickstart

After deploy, set `BASE` and `OP` in your shell:

```sh
BASE=https://<your-worker>.workers.dev   # or your custom domain
OP="Bearer $OPERATOR_TOKEN"
```

**Mint your first agent + key:**

```sh
curl -s -X POST "$BASE/admin/agents" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"name":"my-first-agent"}'
# → { agent_id, key_id, key: "awh_<prefix>.<secret>", ... }
```

The `key` is shown exactly once; capture it.

**Publish a document:**

```sh
KEY="awh_..."   # from the mint above
curl -s -X POST "$BASE/d" \
  -H "authorization: Bearer $KEY" -H 'content-type: text/html' \
  --data '<h1>Hello</h1><p>Posted by my agent.</p>'
# → { public_id, url, version: 1, size_bytes, sanitizer_v, modified }
```

**Open `url` in a browser** — you see the document rendered inside a sandboxed iframe.

**Read it back as an agent:**

```sh
curl -s "$BASE/d/$PUBLIC_ID" -H "authorization: Bearer $KEY"
# → raw sanitized HTML (same bytes the iframe loads)
```

That's the whole loop.

## API

This is a representative summary of the core loop. The complete, authoritative reference is **[docs/http-api.md](docs/http-api.md)** and the machine-readable **[openapi.json](openapi.json)** (served live at `GET /openapi.json`). Surfaces beyond the basics below: hybrid keyword+semantic **search** (`GET /admin/documents/search`, MCP `search_documents`), **context packs** — budgeted bulk reads with omit-and-report (`?include_bodies=true` on search, plus the MCP `load_context_pack` tool for manifest/link-rooted packs), per-document **visibility** (public/private), lifecycle **status** (`active`/`deprecated` + a `superseded_by` pointer; deprecated docs are marked in search and skipped by packs), **slugs** (`GET /s/:slug`), markdown/source reads (`/d/:id/text`, `/d/:id/source`), the operator **browser session** + manage page (`/login`, `/d/:id/manage`), operator **authoring** (`POST`/`PUT /admin/documents`), and **version history**/restore.

There's also a no-JS **operator browser console** at **`/admin/console`** (operator session — cookie + CSRF; bare `GET /admin` 302-redirects there). It folds the day-to-day operator work into server-rendered pages so you don't have to `curl` the admin API: browse/search the whole fleet (with `?q=`/`?tag=`/`?slug=` filters and a Public/Private badge per doc), mint/revoke agents, mint/revoke keys, mint bound + unbound OAuth clients (and delete them), edit a document's tags, and run a Vectorize backfill. It's a thin UI over the same `*Core` functions as the JSON `/admin/*` API (which is unchanged) — see [docs/http-api.md](docs/http-api.md) for the exhaustive route contract.

| Verb | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | — | Public homepage (renders the designated homepage doc) |
| `GET` | `/healthz` | — | Health/smoke (no secrets revealed) |
| `POST` | `/d` | agent | Create document; returns `public_id` + URL |
| `PUT` | `/d/:id` | agent + `If-Match` | Append new version |
| `DELETE` | `/d/:id` | operator | Revoke document, purge R2 bytes |
| `GET` | `/d/:id` | none / agent | Browser → shell; agent → raw HTML |
| `GET` | `/d/:id/raw` | — | Raw sanitized bytes (iframe `src`) |
| `GET` | `/admin/agents` | operator | List agents (counts of keys, docs) |
| `POST` | `/admin/agents` | operator | Mint agent + initial key |
| `DELETE` | `/admin/agents/:id` | operator | Cascade-kill an agent: revoke every key AND every OAuth client |
| `GET` | `/admin/agents/:id/keys` | operator | List keys for an agent (prefixes, no secrets) |
| `POST` | `/admin/agents/:id/keys` | operator | Mint additional key for an agent |
| `POST` | `/admin/agents/:id/oauth-clients` | operator | Mint an OAuth client pinned to an agent (for Cowork / hosted Claude) |
| `DELETE` | `/admin/keys/:id` | operator | Revoke a single key (rotation) |
| `DELETE` | `/admin/oauth-clients/:client_id` | operator | Revoke a single OAuth client (rotation) |
| `GET` | `/admin/documents` | operator | List all docs (includes revoked) |
| `GET` | `/admin` → `/admin/console` | operator session | No-JS operator browser console (dashboard, agents, docs, maintenance) |
| `*` | `/mcp` | agent (OAuth or awh_) | Streamable HTTP MCP surface — eight typed tools (publish/update/edit/read/list/search docs + load a context pack + mint a publish credential) |
| `GET/POST` | `/authorize` | operator (consent UI) | OAuth consent screen for Door A connections |
| `GET` | `/.well-known/oauth-authorization-server` | — | OAuth 2.1 discovery (served by provider) |
| `POST` | `/token` | OAuth client | OAuth token endpoint (served by provider) |

### Notable details

**`POST /d`**  Body is `Content-Type: text/html` or `text/markdown` (Markdown is parsed to HTML first). Sanitized in-process (Ammonia-WASM). Returns 413 if the input or the fleet-wide storage cap would be exceeded. The response includes a `modified` boolean — `true` if the sanitizer changed anything; useful for agents that want to self-correct.

**`PUT /d/:id`**  Requires `If-Match`. Pass `If-Match: "v<n>"` for optimistic concurrency (returns **412** if `n` ≠ the current version), or `If-Match: *` to skip the version check. Returns **428** if the header is missing entirely — silently appending without a precondition is the wrong default. Any valid agent key under the operator can PUT to any document; the fleet shares trust.

**`GET /d/:id`**  Content-negotiates on `Authorization`:
- No header → minimal HTML shell with `<iframe sandbox src="/d/:id/raw">`. Shell CSP locks the page to a same-origin iframe; the iframe itself loads from the next route below.
- Valid agent key → raw bytes (byte-identical to `/d/:id/raw`).
- Present but invalid key → **401**, not silent fallback. Surfaces broken keys instead of hiding them.

**`GET /d/:id/raw`**  The bytes that render inside the sandboxed iframe. CSP is the strict one: `default-src 'none'`, `img/style/font-src` to `self/inline/data:`, `frame-ancestors 'self'`, `base-uri 'none'`, `form-action 'none'`. `Cache-Control: no-store` everywhere so a revoke is real-time.

**`DELETE /d/:id`**  Flips `revoked_at` in D1 first, then batch-deletes every version's R2 object. Subsequent GETs 404 within milliseconds even if the R2 cleanup hangs. `versions` rows stay as an audit trail; the bytes themselves are the irrecoverable part.

**Status codes you'll see across writes**: 200/201/400/401/404/409/412/413/415/422/428 (409 = `slug_taken`/`slug_retired`; 422 = `invalid_slug`/`integrity_mismatch`). Errors are JSON: `{ "error": "<code>", "message": "..." }` plus optional context fields.

**Pagination** (`GET /admin/agents`, `GET /admin/agents/:id/keys`, `GET /admin/documents`, and the MCP `list_documents` tool): cursor-based, newest first. Optional `?limit=N` (1..200, default 50) and `?cursor=<opaque>` query params. The response includes `next_cursor: string | null` — pass it back unchanged on the next call to fetch the next page; `null` means no more pages. Cursors are stable across concurrent writes (insertions or revokes between pages don't skip or duplicate rows). MCP `list_documents` accepts the same `limit` / `cursor` as tool args.

## Operator runbook

The full day-to-day guide is **[docs/operating.md](docs/operating.md)** — every
important task shown **both** via the no-JS web console (`/admin/console`) and via
`curl`: minting and rotating keys, connecting AI assistants, browsing/searching/
publishing/managing documents, slug redirects, and Vectorize backfills. The two most
common kill switches, for quick reference:

**Revoke a document** (irreversible — R2 bytes are gone):
```sh
curl -s -X DELETE "$BASE/d/$PUBLIC_ID" -H "authorization: $OP"
# → { revoked: true, r2_objects_purged: N }
```

**Kill an entire agent** (both doors at once — every key and every OAuth client):
```sh
curl -s -X DELETE "$BASE/admin/agents/$AGENT_ID" -H "authorization: $OP"
# → { revoked: true, keys_revoked: N, oauth_clients_deleted: M }
```
For rotation, prefer the narrower per-key (`DELETE /admin/keys/:id`) or per-OAuth-client
(`DELETE /admin/oauth-clients/:client_id`) endpoints — those leave the agent alive. See
[operating.md](docs/operating.md#agents-and-keys) for the full set.

## Connecting a hosted Claude / Cowork connector

Cowork (and claude.ai web/mobile) can't paste a static bearer or custom header — only OAuth 2.1 + PKCE through Anthropic's cloud. The worker hosts both doors on the same `/mcp` URL:

- **Door A — OAuth.** One pre-registered OAuth client per agent. Pinned at registration time, so authorizing it always resolves to the same `agents` row and stamps `documents.created_by` accordingly.
- **Door B — static `awh_` bearer.** For Gemini, `curl`, and any script — unchanged from the regular agent path. Same HMAC-under-pepper, same `revoked_at` check, same `agents.id`.

Either door yields an `agentId`; the eight MCP tools (`publish_document`, `update_document`, `edit_document`, `read_document`, `list_documents`, `search_documents`, `load_context_pack`, `create_publish_credential`) close over it for provenance.

> **Shortcut — Dynamic Client Registration.** The worker also serves RFC 7591 DCR (`POST /register`), so most OAuth-capable clients can connect by **pasting the `/mcp` URL alone** — no client_id/secret. The client self-registers (unbound), and you pick or mint the agent it binds to right on the consent screen. The pre-registered flow below is the alternative when you want the agent pinned ahead of time. See [docs/design/dcr-design.md](docs/design/dcr-design.md).

**One-time, per agent that you want a hosted-Claude connector for (pre-registered flow):**

1. Mint the agent if you haven't already:
   ```sh
   curl -s -X POST "$BASE/admin/agents" \
     -H "authorization: $OP" -H 'content-type: application/json' \
     -d '{"name":"claude-via-cowork"}'
   ```
2. Mint an OAuth client pinned to that agent:
   ```sh
   curl -s -X POST "$BASE/admin/agents/$AGENT_ID/oauth-clients" -H "authorization: $OP"
   # → { client_id, client_secret, mcp_url, ... }
   ```
   `client_secret` is shown exactly once — capture it now.
3. In Claude → Customize → Connectors → **+** → **Add custom connector**:
   - URL: paste `mcp_url` (`https://<worker>/mcp`)
   - Advanced settings → paste `client_id` and `client_secret`
   - **Add**, then **Connect**
4. The worker shows a small consent page. Enter your `OPERATOR_TOKEN` and click **Allow**. Cowork now lists the connector as connected.
5. Enable the connector per-conversation via **+** → Connectors.

The Gemini path is unchanged — `POST /admin/agents/:id/keys` for the `awh_...` bearer and put it in Gemini's connector config; no OAuth involved.

The two-door design rationale (why two doors, why one OAuth client per agent, why the consent step is required even for hosted-Claude paths) lives in [action-plan-v1.md](docs/design/action-plan-v1.md) and the SOLO spec ([agent-knowledge-host-spec-SOLO-v1.md](docs/design/agent-knowledge-host-spec-SOLO-v1.md)). The `OAUTH_KV` namespace this path needs is already provisioned by the main setup above.

**Audit a single doc's storage** (via D1 console):
```sh
npx wrangler d1 execute agent-web-host-meta --remote --command \
  "SELECT d.public_id, d.current_ver, d.revoked_at,
          (SELECT json_group_array(json_object('v',version_no,'size',size_bytes))
             FROM versions WHERE document_id = d.id) AS versions
     FROM documents d WHERE d.public_id = '<id>'"
```

## Local development

```sh
npm run build:wasm     # build the Rust→WASM sanitizer — required ONCE before
                       # the first `npm run dev` (sanitizer/pkg/ is gitignored)
npm run dev            # wrangler dev — uses .dev.vars + local D1/R2
npm run typecheck
npm run test           # sanitizer corpus + all JS unit suites (see package.json)
npm run deploy         # build:wasm runs automatically via predeploy

npm run db:migrate:local
npm run db:migrate:remote
npm run db:console:local  "SELECT * FROM agents"
npm run db:console:remote "SELECT * FROM agents"
```

The sanitizer tests live inline at the bottom of [sanitizer/src/lib.rs](sanitizer/src/lib.rs) — ~40 negative assertions across script tags, event handlers, `javascript:`/`vbscript:`/`data:` URLs, `<meta refresh>`, embedded content (`<iframe>`/`<object>`/`<embed>`/etc.), `<base>` hijack, `<style>` blocks, SVG-specific vectors (scripts inside SVG, `<foreignObject>`, `<animate>`), and HTML parser quirks. Each asserts that hostile inputs come out without their dangerous parts. Add a test whenever you tweak [sanitizer/src/lib.rs](sanitizer/src/lib.rs)'s `make_builder()`.

The Rust toolchain is only needed for `build:wasm`. Install via [rustup](https://rustup.rs) with the `wasm32-unknown-unknown` target, plus `brew install wasm-pack` (or equivalent). `predeploy` adds `$HOME/.cargo/bin` to `PATH` so `npm run deploy` works from a fresh shell.

The published `wasm-pack` ships a `wasm-opt` that rejects bulk-memory ops modern rustc emits; the [sanitizer/Cargo.toml](sanitizer/Cargo.toml) sets `wasm-opt = false`, relying on rustc's `opt-level=z + lto` for size.

## Project layout

A high-level sketch — see the **Where things live** section of [CLAUDE.md](CLAUDE.md) for the full, current module + migration map (the repo has grown well past what's shown here).

```
src/
  index.ts            dispatcher; default export wraps innerHandler in OAuthProvider
  oauth.ts            OAuthProvider config (apiRoute=/mcp, TTLs, scopes)
  authorize.ts        consent UI for /authorize (GET form + POST verify)
  mcp.ts              MCP server + eight tools; per-request McpServer
  mcp-auth.ts         dual-door resolver (Door A from ctx.props, Door B from awh_ bearer)
  core.ts             pure write/read/list/revoke functions used by both /d and /mcp
  pack.ts             context-pack pure logic — budget fill, manifest parser, link extractor
  serve.ts            GET /d/:id and /d/:id/raw — shell, raw, content negotiation
  console.ts          operator web console (/admin/console/*) — pages + form handlers + chrome
  html.ts             shared HTML helpers (escapeHtml, formatCreatedAt)
  admin.ts            /admin/* operator endpoints + revokeAgent cascade
  admin-oauth.ts      /admin/agents/:id/oauth-clients + /admin/oauth-clients/:id
  auth.ts             Bearer parse, HMAC-SHA256, agent + operator auth
  ids.ts              UUIDs, public_ids, API key mint + parse
  sanitizer.ts        Worker-side wrapper around the WASM sanitizer
  env.ts              Env bindings interface (incl. OAUTH_KV + OAUTH_PROVIDER)
  wasm.d.ts           type shims for .wasm imports + the wasm-bindgen glue

sanitizer/
  Cargo.toml          Rust crate metadata (ammonia + wasm-bindgen)
  src/lib.rs          allowlist tuned for standalone HTML + SVG, link_rel injected
  pkg/                (gitignored) wasm-pack output, regenerated by predeploy
  target/             (gitignored) cargo build cache

migrations/
  0001_init.sql … 0014_document_status.sql   14 migrations of schema evolution
                      (oauth clients, source format/retention, metadata, slugs +
                       tombstones, FTS, key expiry, visibility, doc tags, authorship)
                      — see CLAUDE.md for what each one adds

skills/
  README.md           orientation for the skill files below
  publishing.md       agent-facing: auth, endpoints, HTML/CSS/SVG allowlist
  connector-guide.md  for humans building MCP / Gemini function-calling connectors

docs/
  README.md           index of the consumer-facing reference docs
  http-api.md         the full HTTP/REST API reference
  security-model.md   the two security walls + the explicit non-guarantees
  feature-roadmap.md  what's coming next (forward-links each design note)
  cloudflare-setup.md one-time Cloudflare provisioning guide
  operating.md        day-to-day operator guide (every task via UI + curl)
  design/             design notes + SOLO/PLATFORM specs (rationale; as-built + aspirational)

scripts/
  build-openapi.mjs   regenerates openapi.json from src/contract.ts
  doc-web.mjs         on-platform doc-web republish recipe (issue #27)
  doc-web-map.json    slug map: which docs mirror to Slopcafe, and their slugs

wrangler.toml         Worker config + bindings + non-secret vars
```

## Agents and connectors

If you want an AI agent to publish documents through this service, install
the skill in [skills/publishing.md](skills/publishing.md) — it documents
auth, the three agent endpoints, and the full allowed/forbidden HTML+CSS+SVG
reference. To wrap the API in typed tools for Claude or Gemini, see
[skills/connector-guide.md](skills/connector-guide.md) (recommended tool
surface + a TypeScript MCP server skeleton + Gemini function-calling
declarations).

## Follow-ups & non-goals

Things deliberately not in v1 (and where to find the rationale):

- **Sanitizer tests are corpus-based.** ~40 inline hostile-input assertions in [sanitizer/src/lib.rs](sanitizer/src/lib.rs) plus a separate data-driven [bypass corpus](sanitizer/tests/bypass_corpus.rs) cover the common and long-tail vectors; not yet covered is a Vitest + Miniflare integration layer exercising the full JS→WASM→Worker round-trip. See [action-plan-v1.md](docs/design/action-plan-v1.md) for the rest of the plan.
- **Storage cap is best-effort.** The `SUM` runs outside the insert batch, so two simultaneous writes can both pass the check.
- **No per-document version cap.** An agent could churn many versions of one doc and chew the fleet quota; mitigate via admin DELETE.
- **No `Idempotency-Key`** header support on POST `/d` yet. Route signature accommodates adding it without breaking changes.
- **Single operator credential, not Google OAuth.** Multi-operator scoping (and per-operator agent grouping) is the right place to grow if the project ever takes on collaborators.
- **CSP `'unsafe-inline'` in `style-src`** allows both `<style>` blocks and `style=""` attributes — CSP can't separate the two. The sanitizer strips `<style>` so only attributes survive; this is the layered defense, not a CSP weakness.

## Contributing

Slopcafe is **open source but not open contribution** — a single-operator
personal project that doesn't accept pull requests. Bug reports and ideas are
welcome as [issues](https://github.com/Skylled/slopcafe/issues/new/choose), the
code is yours to **fork** under Apache-2.0, and security vulnerabilities go
through [private reporting](https://github.com/Skylled/slopcafe/security). The
reasoning, plus the dev/test loop for forkers, is in
[CONTRIBUTING.md](CONTRIBUTING.md); the security policy is in
[SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Skylled / Kyle Bradshaw.

The bypass-corpus test vectors under [`sanitizer/tests/corpus/`](sanitizer/tests/corpus/) include payloads adapted from third-party security cheat sheets (notably the OWASP XSS Filter Evasion Cheat Sheet, CC BY-SA 4.0); those keep their own attribution in [`SOURCES.md`](sanitizer/tests/corpus/SOURCES.md) and are not covered by the Apache grant.
