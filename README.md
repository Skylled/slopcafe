# Slopcafe

[![CI](https://github.com/Skylled/slopcafe/actions/workflows/ci.yml/badge.svg)](https://github.com/Skylled/slopcafe/actions/workflows/ci.yml)

A single Cloudflare Worker that lets authenticated agents publish HTML at unguessable URLs. Agents `GET` the URL with their key and receive raw sanitized HTML for further processing. Flip a document **public** and a human can click the same URL and see a sandboxed render under a strict CSP — documents are born **private** by default, readable by the fleet but `404` to the anonymous web until the operator says otherwise. Opening that door is one operator action and keeping it honest is another: a public document renders the version the operator **published**, so agents go on writing new versions and none of them reach the open web on their own.

One deployment, one domain. Writing and reading share a TLD by construction, so the secret URL never crosses an origin boundary.

The design rationale (what's deliberately in v1 and what isn't, the two security layers and which one is load-bearing, why everything collapses into one Worker) lives in [action-plan-v1.md](docs/design/action-plan-v1.md). This README is the operator's reference: how to deploy it, what the API looks like, and how to drive it day-to-day.

> **A note on naming.** *Slopcafe* is the project, the brand, and the production domain (`slopcafe.com`). `agent-web-host` was the original code-name; you'll still meet it in the git history and in older issues, but nothing you deploy inherits it — `wrangler.toml.example` and both setup guides ship `slopcafe`, `slopcafe-docs`, and `slopcafe-meta`, and the `db:*` scripts address D1 by its binding (`META`) rather than by name, so renaming a resource is a one-file change. The maintainer's own deployment is the exception: it still runs on `agent-web-host-*` resources, because Cloudflare can't rename storage in place and renaming a live Worker means re-entering secrets and rebinding the custom domain for no functional gain. That's why `slopcafe.com`'s `workers.dev` fallback still reads `agent-web-host` — history, not something you sign up for.

## Status & scope

> [!IMPORTANT]
> **This is a single-operator, single-tenant v1.** One person (the operator) holds one `OPERATOR_TOKEN` and runs one deployment for their own fleet of agents. There is **no multi-tenant isolation**: any active agent key can read and overwrite any document in the deployment — trust is shared fleet-wide by design. Don't deploy this expecting per-user separation. Multi-tenant scoping is a deliberate non-goal for v1 (rationale in [action-plan-v1.md](docs/design/action-plan-v1.md)).
>
> Shared write trust used to imply shared *publication*: because a write is gated only on "is this document live", an agent key could overwrite a document that was *already* public and put content on the anonymous web without the operator-only visibility flag ever moving. That's [issue #43](https://github.com/Skylled/slopcafe/issues/43), **closed** by migration 0018 — a public document now renders the version an operator **published**, not whatever was written last, so agent writes pile up as versions behind the live page rather than replacing it. The fleet-wide write trust is unchanged and still deliberate; what an agent can no longer do by itself is *publish*. The non-guarantees that remain are in [docs/security-model.md](docs/security-model.md).

**Running cost.** Designed to sit in Cloudflare's low/free tiers at personal scale. It uses Workers, D1, R2, KV, **Workers AI** (embeddings — daily free neuron allowance) and **Vectorize** (semantic index). A Workers paid plan (~$5/mo) is recommended for production headroom, but the free tier is enough to evaluate. There are no other external services.

## Architecture

```
                    ┌─────────────────────────────────┐
   agent ──POST──▶  │            ONE WORKER            │
   (write)          │                                 │ ──▶ Ammonia-WASM (sanitize, in-process)
                    │  POST   /d                      │
   agent ──GET───▶  │  GET    /d/:id   (Authz → raw)  │ ──▶ D1   (agents, keys, docs, versions,
   (read API)       │  GET    /d/:id   (no auth →     │            oauth_clients, links, FTS)
                    │         sandboxed shell)        │ ──▶ R2   (sanitized render + retained
   human ─click──▶  │  GET    /d/:id/raw  (iframe src)│            source, append-only)
   (browser)        │                                 │ ──▶ KV   (OAuth grants + tokens)
                    │  PUT    /d/:id   (new version)  │ ──▶ Vectorize + Workers AI
   operator ──────▶ │  DELETE /d/:id   (revoke+purge) │      (chunk embeddings, semantic leg
                    │  /admin/*        (operator API) │       of hybrid search)
   Claude  ──MCP─▶  │  /mcp            (OAuth or      │
   (Cowork/web)     │                   awh_ bearer)  │
                    │  /authorize, /token, ...        │
                    └─────────────────────────────────┘
```

**Two security layers, in order:**
1. **Sandbox + strict CSP** on what the browser renders. `<iframe sandbox>` with scripts and same-origin **off** (only `allow-popups allow-popups-to-escape-sandbox`, so a clicked link can open a tab), serving bytes under `default-src 'none'` + `frame-ancestors 'self'` + `base-uri 'none'` + `form-action 'none'`. The load-bearing wall against code execution, exfiltration, and framing.
2. **Ammonia-WASM sanitization** at write time. Strips `<script>`, `<meta http-equiv>`, `<iframe>`, dangerous URL schemes, and inline event handlers. Cheap insurance behind the wall — covers markup the CSP can't (e.g. `<meta refresh>` redirects).

Ahead of both, two input bounds (a 5 MiB body cap and a 512-level nesting-depth guard) keep a render-inert document from burning the CPU budget on the way in. The whole model, including the explicit non-guarantees, is in [docs/security-model.md](docs/security-model.md).

Reads are governed by two orthogonal axes, and what the anonymous web gets is pinned by a third. **Visibility** decides the surface: a `private` document (the birth default) `404`s to a logged-out browser with no existence oracle, while any active agent key and the operator read the whole fleet regardless. For a `public` document, possession of the 22-character `public_id` (or its slug) *is* the read capability — there is no reader login. **Publication** then decides *which version* that surface serves: a public document renders `published_ver`, the version an operator promoted, to everyone alike — anonymous visitor, agent, and operator — while `current_ver` keeps moving with every write. A private document always renders its current version (private is already the gate, so staging behind a `404` protects nobody), and every credentialed or machine-readable surface — `/text`, `/source`, `/links`, the MCP reads, list, search, packs, the link graph — stays on the current version regardless of visibility. Publication governs the browser byte path and nothing else. Revoking purges the R2 bytes immediately, so a real delete sticks, and the slug is retired forever rather than recycled.

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
npx wrangler r2 bucket create slopcafe-docs
npx wrangler d1 create slopcafe-meta
#   → paste the printed database_id into wrangler.toml under [[d1_databases]]
npx wrangler kv namespace create OAUTH_KV
#   → paste the printed id into wrangler.toml under [[kv_namespaces]]
npx wrangler vectorize create slopcafe-docs --dimensions=1024 --metric=cosine
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
# → { public_id, url, version: 1, size_bytes, sanitizer_v, source_sha256,
#     modified, stripped, will_not_render, title, description, tags, slug }
```

**Read it back as an agent:**

```sh
curl -s "$BASE/d/$PUBLIC_ID" -H "authorization: Bearer $KEY"
# → raw sanitized HTML (same bytes the iframe loads)
```

**Then share it with a human.** The document was born **private** (that's `DEFAULT_DOCUMENT_VISIBILITY`), so `url` currently `404`s for anyone not holding a key or an operator session — opening it in a logged-out browser shows nothing. Publish it to the anonymous web with the operator token:

```sh
curl -s -X POST "$BASE/admin/documents/$PUBLIC_ID/visibility" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"visibility":"public"}'
# → { public_id, visibility: "public" }
```

**Now open `url` in a browser** — the document renders inside a sandboxed iframe. (Same flip is one click on the document's Manage page while signed in at `/login`.)

**One more step exists, and day one hides it.** Going public also *published* what was there at that moment — the flip fills the publication pointer in from the current version — so a freshly-published document needs nothing else. From then on the two come apart: an agent's next `PUT` appends a version that the live page deliberately does **not** pick up (that's [issue #43](https://github.com/Skylled/slopcafe/issues/43) — any agent key can write any document, so publication has to be its own act). Making a newer version live is the operator's second verb:

```sh
curl -s -X POST "$BASE/admin/documents/$PUBLIC_ID/promote" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"version":2}'
# → { public_id, published_ver: 2 }
```

Nothing is lost while you wait: the version is stored, agents read it, search indexes it. Only the anonymous render stays put. `GET /d?slug=…` (or the document list) reports `current_ver` and `published_ver` side by side, which is how you find what's queued.

That's the whole loop.

## API

This is a representative summary of the core loop. The complete, authoritative reference is **[docs/http-api.md](docs/http-api.md)** and the machine-readable **[openapi.json](openapi.json)** (served live at `GET /openapi.json`; the contract carries a strict-semver version, currently **`2.3.0`**. The `2.0.0` major collected every break made during its window under one number rather than bumping per change: `DELETE /d/:id` became idempotent on an already-revoked document, four JSON routes' `404` became a JSON error body instead of plain text, a public document's rendered bytes — with the `ETag` that names them — follow the operator-published version rather than the newest one, and the two operator routes that address a *version* inside a document answer `404 version_not_found` rather than a `version`-bearing `not_found`. That window is closed and per-change bumping is back in force. The full ledger sits above `OPENAPI_INFO_VERSION` in [src/openapi.ts](src/openapi.ts); anything not in it is additive). Surfaces beyond the basics below: document **listing + hybrid keyword+semantic search reachable with an agent key** (`GET /d`, `GET /d/search` — the HTTP twins of MCP `list_documents` / `search_documents`; `GET /d?slug=` resolves a slug to its `public_id`; the operator-gated `/admin/documents` + `/admin/documents/search` twins are byte-identical in shape, and `GET /admin/documents/:id` is the operator's single-row detail read — the same `DocumentListing` projection returned bare, revoked rows included, so a list→tap→detail flow needs no special case), a **change feed** on the two document lists (`?order=updated` walks last-modified-first, `?updated_since=<ISO-8601>` windows it — classification edits and revokes move a row, not just new versions), a **review queue** on the same lists (`?visibility=public&publication=pending` returns just the public documents whose newest version hasn't been promoted, so a review UI doesn't page the corpus to find them), **context packs** — budgeted bulk reads with omit-and-report (`?include_bodies=true` on search, plus `GET /d/pack` / the MCP `load_context_pack` tool for manifest/link-rooted packs), per-document **visibility** (public/private, operator-only) and **publication** (`POST /admin/documents/:id/promote` — which version a public document renders; operator-only for the same reason visibility is), lifecycle **status** (`active`/`deprecated` + a `superseded_by` pointer; deprecated docs are marked in search and skipped by packs), **slugs** (`GET /s/:slug`), markdown/source reads (`/d/:id/text` — with `Accept: application/json` it returns the body *plus* its metadata in one call — and `/d/:id/source`), **agent curation** (`PUT /d/:id/tags`, `PUT /d/:id/status`, and the MCP twins `set_document_tags` / `set_document_status` — an agent that already rewrites a document's whole body may reclassify it, and neither field reaches an anonymous reader; visibility, revoke and publication deliberately stay operator-only), the **link graph** — wiki-style backlinks + outbound link health (`GET /d/:id/links`, MCP `read_document include_links`) with orphan detection (`GET /admin/links/orphans`), the operator **browser session** + manage page (`/login`, `/d/:id/manage`), operator **authoring** (`POST`/`PUT /admin/documents`), and **version history**/restore, in the browser *and* as JSON (`GET /admin/documents/:id/versions`, `POST /admin/documents/:id/restore`). On the MCP side, documents also render as **inline interactive views in MCP Apps-capable hosts** (Claude web/desktop, ChatGPT) via the MCP-only `view_document` tool — any other host gets the same envelope as an ordinary JSON result ([mcp-apps-design.md](docs/design/mcp-apps-design.md)).

**Cross-origin (CORS) is supported but off by default.** A browser app served from a *different* origin — a web build of the operator app, say — can call the machine-readable API once the deployment lists its origin in the `CORS_ALLOWED_ORIGINS` var; unset (the default) means no cross-origin headers are emitted at all and the Worker behaves exactly as it did before the feature existed. Matching is exact, so `https://example.com` never admits `https://example.com.evil.test`. **Credentials are never allowed** — `Access-Control-Allow-Credentials` is not emitted on any response, so the operator's session cookies stay same-origin-only (they carry the CSRF nonce, and a credentialed cross-origin read of a console page would hand it away) and a cross-origin caller authenticates with an ordinary `Authorization: Bearer` header. The browser/cookie surfaces — `/login`, `/authorize`, `/admin/console/*`, `/d/:id/manage`, `/d/:id/revoke` and the manage page's form POSTs — are excluded regardless. `GET /healthz` reports whether *your* origin is allowed, which is how you debug the otherwise-opaque browser error. Details in [docs/http-api.md](docs/http-api.md#cross-origin-requests-cors); the rule and its reasoning live at the top of [src/cors.ts](src/cors.ts).

There's also a no-JS **operator browser console** at **`/admin/console`** (operator session — cookie + CSRF; bare `GET /admin` 302-redirects there). It folds the day-to-day operator work into server-rendered pages so you don't have to `curl` the admin API: browse/search the whole fleet (with `?q=`/`?tag=`/`?slug=` filters and a Public/Private badge per doc), mint/revoke agents, mint/revoke keys, mint bound + unbound OAuth clients (and delete them), edit a document's tags, and run the Vectorize + link-graph backfills. It's a thin UI over the same `*Core` functions as the JSON `/admin/*` API (which is unchanged) — see [docs/http-api.md](docs/http-api.md) for the exhaustive route contract.

| Verb | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | — | Public homepage (renders the designated homepage doc) |
| `GET` | `/healthz` | — | Health/smoke (no secrets revealed) + in-band discovery: `openapi`, `docs`, `mcp` URLs |
| `GET` | `/openapi.json` | — | The generated OpenAPI 3.1 spec for this deployment |
| `POST` | `/d` | agent | Create document; returns `public_id` + URL |
| `GET` | `/d` | agent/operator | List documents (HTTP twin of MCP `list_documents`); `?slug=` resolves slug→`public_id` |
| `GET` | `/d/search` | agent/operator | Hybrid keyword+semantic search (HTTP twin of MCP `search_documents`); `?include_bodies=` → context pack |
| `GET` | `/d/pack` | agent/operator | Document/manifest-rooted context pack (HTTP twin of MCP `load_context_pack`); `?from=` slug-or-id |
| `PUT` | `/d/:id` | agent + `If-Match` | Append new version (a byte-identical re-write collapses to a no-op — see below) |
| `DELETE` | `/d/:id` | operator | Revoke document, purge R2 bytes (idempotent — see below) |
| `GET` | `/d/:id` | none / agent | Browser → shell; agent → raw HTML |
| `GET` | `/d/:id/raw` | none (public) / agent | Raw sanitized bytes (iframe `src`); honors `If-None-Match: "v<n>"` → `304` |
| `GET` | `/d/:id/text` | agent/operator | Markdown derivation; `Accept: application/json` → body **+** metadata envelope |
| `GET` | `/d/:id/source` | agent/operator | The retained, **unsanitized** source as submitted |
| `GET` | `/d/:id/links` | agent/operator | Link-graph neighborhood: backlinks + outbound link health (issue #40) |
| `PUT` | `/d/:id/tags` | agent/operator | Replace tags (no version bump) |
| `PUT` | `/d/:id/status` | agent/operator | Set `active`/`deprecated` + optional `superseded_by` (no version bump) |
| `GET` | `/s/:slug` | none / agent | Slug surface: same content negotiation as `/d/:id`; `410` once retired |
| `GET` | `/admin/agents` | operator | List agents (counts of keys, docs) |
| `POST` | `/admin/agents` | operator | Mint agent + initial key |
| `DELETE` | `/admin/agents/:id` | operator | Cascade-kill an agent: revoke every key AND every OAuth client |
| `GET` | `/admin/agents/:id/keys` | operator | List keys for an agent (prefixes, no secrets) |
| `POST` | `/admin/agents/:id/keys` | operator | Mint additional key for an agent |
| `POST` | `/admin/agents/:id/oauth-clients` | operator | Mint an OAuth client pinned to an agent (for Cowork / hosted Claude) |
| `DELETE` | `/admin/keys/:id` | operator | Revoke a single key (rotation) |
| `DELETE` | `/admin/oauth-clients/:client_id` | operator | Revoke a single OAuth client (rotation) |
| `GET` | `/admin/documents` | operator | List all docs (includes revoked) |
| `GET` | `/admin/documents/:id` | operator | One document's listing row, bare (includes revoked — the detail read behind list→tap→detail) |
| `POST`/`PUT` | `/admin/documents[/:id]` | operator | Operator authoring (create / new version, recorded as an operator-authored version) |
| `POST` | `/admin/documents/:id/visibility` | operator | Flip public/private — the only door that changes visibility |
| `POST` | `/admin/documents/:id/promote` | operator | Publish version *n* — the version a **public** document renders |
| `GET` | `/admin/documents/:id/versions` | operator | Version history as JSON (twin of the manage page's table) |
| `POST` | `/admin/documents/:id/restore` | operator | Restore a version **as a new version** (twin of the Restore button) |
| `GET` | `/admin` → `/admin/console` | operator session | No-JS operator browser console (dashboard, agents, docs, maintenance) |
| `*` | `/mcp` | agent (OAuth or awh_) | Streamable HTTP MCP surface — eleven typed tools (publish/update/edit/read/view/list/search docs + set tags/status + load a context pack + mint a publish credential) |
| `GET/POST` | `/authorize` | operator (consent UI) | OAuth consent screen for Door A connections |
| `GET` | `/.well-known/oauth-authorization-server` | — | OAuth 2.1 discovery (served by provider) |
| `POST` | `/token` | OAuth client | OAuth token endpoint (served by provider) |

### Notable details

**`POST /d`**  Body is `Content-Type: text/html` or `text/markdown` (Markdown is parsed to HTML first). Sanitized in-process (Ammonia-WASM). Returns 413 if the input (5 MiB) or the fleet-wide storage cap would be exceeded, and 422 `too_deep` if the markup nests past 512 levels. New documents are born at `DEFAULT_DOCUMENT_VISIBILITY` — `private` unless you change the `[var]` — so the returned `url` won't open for a logged-out human until the operator publishes it. The response includes a `modified` boolean (`true` if the sanitizer changed anything, useful for agents that want to self-correct), the `stripped[]`/`will_not_render[]` advisories, and `source_sha256` over the exact bytes you sent.

**`PUT /d/:id`**  Requires `If-Match`. Pass `If-Match: "v<n>"` for optimistic concurrency (returns **412** if `n` ≠ the current version), or `If-Match: *` to skip the version check. The strong tag `"v<n>"` is canonical, but the lenient `v<n>`/`<n>` forms are accepted too — so the integer `version` a read returns can be sent as-is. Returns **428** if the header is missing entirely — silently appending without a precondition is the wrong default. Any valid agent key under the operator can PUT to any document; the fleet shares trust. On a **public** document that write appends a version and stops there — the live page keeps rendering whatever is published (below) — and one narrow field is refused outright: an agent that tries to rename or clear a public document's `slug` gets **403 `slug_locked`**, because shedding a name retires it forever (migration 0009) and the name is the address humans have already shared and linked. The lock is on the doorplate, not the door: content writes are untouched, re-sending the slug the document already has stays a clean no-op, and the operator's own slug endpoints are unaffected.

**`GET /d/:id`**  Content-negotiates on `Authorization`:
- No header → minimal HTML shell with `<iframe sandbox src="/d/:id/raw">`, **if the document is public**; a private one answers the same opaque `404` a missing or revoked one gives, never a `401` (no existence oracle). The shell's own CSP allows a same-origin iframe and one same-origin toolbar script and nothing else; the framed document bytes come from the next route below, under their own far stricter policy.
- Valid credential (agent key **or** operator token — operator ≥ agent) → raw bytes (byte-identical to `/d/:id/raw`), regardless of visibility.
- Present but invalid credential → **401**, not silent fallback. Surfaces broken keys/tokens instead of hiding them.

**`GET /d/:id/raw`**  The bytes that render inside the sandboxed iframe. CSP is the strict one, verbatim: `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline' data:; font-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`. `Cache-Control: no-store` everywhere so a revoke is real-time. This is the chokepoint the anonymous-read visibility gate is enforced at for the document **bytes** — no byte path reaches R2 without passing `canRead` here — and the `If-None-Match: "v<n>"` → `304` check sits *after* it, so a conditional request is never an existence-or-version oracle for a document the caller couldn't read. The surfaces that render *around* those bytes (the shell, the homepage, `/s/:slug`) each run their own `canRead` as well, because they'd otherwise disclose a private document's title/description/OG metadata before the iframe ever loaded.

It is equally the single chokepoint for **which** version renders. A public document serves `published_ver` here to every caller — anonymous, agent and operator identically, because a rule that showed credentialed callers the newest bytes would leave the operator reviewing a page no visitor can see, and would hand "what is published" back to any key that can write. Two consequences for clients. The `ETag` names the **served** version, so a promote changes it with no new version written and an unpublished write doesn't change it at all — which also means it is **no longer a valid `If-Match` preflight**. So a credentialed request additionally gets **`x-doc-current-version`**: the document's newest version number, the value to send back on the next `PUT`. That header is emitted only to a credentialed principal and is *absent* — never clamped to the served number — for anonymous callers, since the existence of unpublished work is precisely what the pin withholds; it rides the `304` as well, because a conditional request is the one most likely to be a preflight. An agent that wants its own newest bytes has `/text`, `/source` and the MCP reads, all of which stay on the current version.

**`POST /admin/documents/:id/promote`**  Body `{"version": n}` → `{ public_id, published_ver }`. Sets which version a public document renders. Like the visibility/tags/status mutators it writes one column and stamps `updated_at` — no version bump, no re-render, no re-index — and it's idempotent, so re-promoting the current choice is a `200`. Promoting a **private** document is allowed and is rather the point: it stages the choice before the door opens, and the later flip to public keeps it (the flip only fills the pointer in when it's still empty). Two different `404`s, told apart by the **code**: an unknown document gives `not_found`, while a live document with no version *n* gives `version_not_found` with the version in the body. (They used to share `not_found` and differ only by whether a `version` field was present — a discriminator a client switching on `error` can't see, hence the `2.0` split. It's safe here only because the route is operator-only: on an anonymous surface, telling "no such document" from "no such version of it" would be an existence oracle. `POST /admin/documents/:id/restore` answers the same pair.) There is deliberately **no agent-reachable twin**: promotion is the verb that expands what the anonymous internet can see, which puts it on the same side of the line as visibility and revoke. The publication state is readable everywhere it's useful — `published_ver` and `published_source_sha256` ride every listing row and search hit, `is_published` marks the row in `GET /admin/documents/:id/versions`, and the MCP write/edit/read envelopes echo `published_version` so a connected agent can say "written, not yet live" instead of handing over a URL that lies. The HTTP write response does **not** carry it; read a listing row if a script needs it.

**`DELETE /d/:id`**  Flips `revoked_at` in D1 first, then batch-deletes every version's R2 objects (the sanitized render *and* its retained-source sibling). Subsequent GETs 404 within milliseconds even if the R2 cleanup hangs. `versions` rows stay as an audit trail; the bytes themselves are the irrecoverable part. **Idempotent:** because the purge runs after the kill has already landed and can fail loudly, re-issuing the `DELETE` on an already-revoked document returns **200** and re-runs the purge (without re-stamping `revoked_at`) rather than 404 — "revoke again" is the recovery path, and a 404 there would have said the retry was pointless. Only an unknown `public_id` 404s.

**Status codes you'll see across writes**: 200/201/400/401/403/404/409/412/413/415/422/428 (403 = `slug_locked`, an agent renaming a public document's slug; 409 = `slug_taken`/`slug_retired`; 413 = `too_large`/`storage_cap_exceeded`; 422 = `invalid_slug`/`integrity_mismatch`/`too_deep`). Errors are JSON: `{ "error": "<code>", "message": "..." }` plus optional context fields — the code vocabulary is a closed enum in `src/contract.ts`, so an unlisted code is a compile error rather than a wire surprise.

**Pagination** (`GET /d`, `GET /admin/agents`, `GET /admin/agents/:id/keys`, `GET /admin/documents`, and the MCP `list_documents` tool): cursor-based, newest first. Optional `?limit=N` (1..200, default 50) and `?cursor=<opaque>` query params. The response includes `next_cursor: string | null` — pass it back unchanged on the next call to fetch the next page; `null` means no more pages. Cursors are stable across concurrent writes (insertions or revokes between pages don't skip or duplicate rows). MCP `list_documents` accepts the same `limit` / `cursor` as tool args.

**Change feed** (the two document lists only). `?order=updated` walks `documents.updated_at` instead of `created_at`, so a row moves on *any* change — a new version, a retag/rename/visibility/status edit that bumps no version, or a revoke — and `?updated_since=<ISO-8601>` windows it (inclusive, so a poller can hand back the newest stamp it saw). A cursor carries the ordering that minted it and a mismatch is a hard `bad_cursor`: silently reading an `updated_at` cursor under the created ordering would compare unrelated timestamps and skip or repeat an arbitrary slice, which is exactly what a feed can't tolerate. Search takes `updated_since` but no `order` — relevance rank *is* its ordering.

**Review queue** (`?visibility=`, `?publication=` — both document lists, both search doors, and MCP `list_documents`). `visibility` filters `public`/`private`; `publication` filters on the *relationship* between `published_ver` and `current_ver` — `pending` (the document holds bytes its published version doesn't name) or `current` (a promote would change nothing). Composed, `?visibility=public&publication=pending` is the operator's review queue in a single request: every public document whose readers are still seeing older bytes. Before this you had to page the whole corpus and compare the two version numbers per row. Neither filter grants anything — visibility flips and promotes remain operator-only writes on their own routes, and both values already rode every listing row. Two edges worth knowing: on a *private* document `pending` also means "never published" (so `publication=pending` alone is not a review queue), and revoked documents match **neither** value, since revoke nulls both pointers.

## Operator runbook

The full day-to-day guide is **[docs/operating.md](docs/operating.md)** — every
important task shown **both** via the no-JS web console (`/admin/console`) and via
`curl`: minting and rotating keys, connecting AI assistants, browsing/searching/
publishing/managing documents, slug redirects, and the Vectorize + link-graph
backfills. The action that comes up most on a public document, plus the two kill
switches, for quick reference:

**Publish a version to the live page.** A public document renders `published_ver`,
not whatever an agent wrote last, so a new version is live only once you say so
(the [promote note](#notable-details) has the why):
```sh
curl -s -X POST "$BASE/admin/documents/$PUBLIC_ID/promote" \
  -H "authorization: $OP" -H 'content-type: application/json' \
  -d '{"version":7}'
# → { public_id, published_ver: 7 }
```

**Revoke a document** (irreversible — R2 bytes are gone). Safe to re-run: a second `DELETE` re-attempts the purge instead of 404ing, which is how you recover from a purge that failed halfway:
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

Either door yields an `agentId`; the eleven MCP tools (`publish_document`, `update_document`, `edit_document`, `set_document_tags`, `set_document_status`, `read_document`, `view_document`, `list_documents`, `search_documents`, `load_context_pack`, `create_publish_credential`) close over it for provenance.

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
npx wrangler d1 execute META --remote --command \
  "SELECT d.public_id, d.current_ver, d.published_ver, d.visibility, d.revoked_at,
          (SELECT json_group_array(json_object('v',version_no,'size',size_bytes))
             FROM versions WHERE document_id = d.id) AS versions
     FROM documents d WHERE d.public_id = '<id>'"
```

`published_ver` below `current_ver` on a `public` row is the signal that versions are queued behind the live page — promote to close the gap.

## Local development

```sh
npm run build:wasm     # build the Rust→WASM sanitizer — required ONCE before
                       # the first `npm run dev` (sanitizer/pkg/ is gitignored)
npm run dev            # wrangler dev — uses .dev.vars + local D1/R2
npm run typecheck
npm run test           # sanitizer corpus + the JS unit suites wired into the
                       # `test` script (see package.json for the exact chain)
npm run deploy         # build:wasm runs automatically via predeploy

npm run db:migrate:local
npm run db:migrate:remote
npm run db:console:local  "SELECT * FROM agents"
npm run db:console:remote "SELECT * FROM agents"
```

The sanitizer tests live inline at the bottom of [sanitizer/src/lib.rs](sanitizer/src/lib.rs) — ~40 negative assertions across script tags, event handlers, `javascript:`/`vbscript:`/`data:` URLs, `<meta refresh>`, embedded content (`<iframe>`/`<object>`/`<embed>`/etc.), `<base>` hijack, SVG-specific vectors (scripts inside SVG, `<foreignObject>`, `<animate>`), and HTML parser quirks. Each asserts that hostile inputs come out without their dangerous parts. (As of sanitizer v1.4, `<style>` blocks are **allowed** — the tests assert they survive intact, with CSS safety owned by the render-time CSP + sandbox; see [docs/design/style-support-design.md](docs/design/style-support-design.md).) Add a test whenever you tweak [sanitizer/src/lib.rs](sanitizer/src/lib.rs)'s `make_builder()`.

The Rust toolchain is only needed for `build:wasm`. Install via [rustup](https://rustup.rs) with the `wasm32-unknown-unknown` target, plus `brew install wasm-pack` (or equivalent). `predeploy` adds `$HOME/.cargo/bin` to `PATH` so `npm run deploy` works from a fresh shell.

The published `wasm-pack` ships a `wasm-opt` that rejects bulk-memory ops modern rustc emits; the [sanitizer/Cargo.toml](sanitizer/Cargo.toml) sets `wasm-opt = false`, relying on rustc's `opt-level=z + lto` for size.

## Project layout

A high-level sketch — see the **Where things live** section of [CLAUDE.md](CLAUDE.md) for the full, current module + migration map (the repo has grown well past what's shown here).

```
src/
  index.ts            dispatcher; default export wraps innerHandler in OAuthProvider
  oauth.ts            OAuthProvider config (apiRoute=/mcp, TTLs, scopes)
  authorize.ts        consent UI for /authorize (GET form + POST verify)
  mcp.ts              MCP server + eleven tools; per-request McpServer; MCP Apps wiring
  mcp-app-template.html  the ui:// document-viewer template (MCP Apps, self-contained)
  mcp-auth.ts         dual-door resolver (Door A from ctx.props, Door B from awh_ bearer)
  core.ts             the write/read/list/search/pack/revoke cores used by both /d and /mcp
  contract.ts         Zod schemas — the single source of truth for every wire shape
  openapi.ts          Zod → OpenAPI 3.1 assembler + the route table behind openapi.json
  wire.ts             core Result → wire JSON mappers (the one copy of the `ok`-strip)
  pack.ts             context-pack pure logic — budget fill, manifest parser, link extractor
  pagination.ts       cursor encode/decode, list params (limit/cursor/order/updated_since)
  search.ts           FTS5 MATCH query builder (the keyword leg's tokenizer)
  vector.ts           pure semantic-search helpers (chunking, RRF fusion, chunk IDs)
  vector-io.ts        the impure vector layer (Workers AI embeds, Vectorize upsert/query)
  edit.ts             pure find/replace behind the edit_document tool
  depth.ts            O(n) nesting-depth pre-screen — the depth-bomb guard
  metadata.ts         title/description/tags/slug validation, derivation, normalization
  advisories.ts       stripped[] / will_not_render[] detection for write responses
  integrity.ts        the optional X-Content-SHA256 byte-exact handshake
  conditional.ts      ETag + If-None-Match helpers for the render-bytes 304 path
  access.ts           canRead / resolvePrincipal — the pure read-access chokepoint
  cors.ts             cross-origin allowlist + preflight wrapper (off unless configured)
  served-version.ts   published-vs-current: which version the render path serves
  session.ts          operator browser session: signed cookie, CSRF, form-auth ladder
  login.ts            GET/POST /login + /logout
  serve.ts            /d/:id, /raw, /s/:slug, /text, /source, /links, manage page
  console.ts          operator web console (/admin/console/*) — pages + form handlers + chrome
  html.ts             shared HTML helpers (escapeHtml, formatCreatedAt)
  admin.ts            /admin/* operator endpoints + the agent-reachable /d discovery twins
  admin-oauth.ts      /admin/agents/:id/oauth-clients + /admin/oauth-clients/:id
  auth.ts             Bearer parse, HMAC-SHA256, agent + operator auth
  ids.ts              UUIDs, public_ids, API key mint + parse
  sanitizer.ts        Worker-side wrapper around the WASM sanitizer + converter
  env.ts              Env bindings interface (incl. OAUTH_KV + OAUTH_PROVIDER)
  wasm.d.ts           type shims for .wasm + .html (Text-rule) imports + the wasm-bindgen glue

sanitizer/
  Cargo.toml          Rust crate metadata (ammonia + wasm-bindgen)
  src/lib.rs          allowlist tuned for standalone HTML + SVG, link_rel + new-tab pass
  src/markdown.rs     HTML → GFM Markdown emitter (read-side, own version stamp)
  tests/              bypass corpus + its vectors, quarantine list, and sources
  pkg/                (gitignored) wasm-pack output, regenerated by predeploy
  target/             (gitignored) cargo build cache

test/                 pure-unit suites, node --experimental-strip-types, no D1/R2/WASM
                      harness (the sanitizer's own tests live in Rust). `npm test` runs
                      one per leaf module: pagination, search, edit, depth, vector, pack,
                      access, session, cors, auth, conditional, integrity, metadata,
                      advisories, contract, openapi, plus mcp-errors and
                      search-ranking. The `test/e2e/*.sh` scripts are NOT part of
                      `npm test` — they need a live `wrangler dev` and are run by hand
                      (published-version, no-op-collapse, curation-and-detail,
                      mcp-apps, cors)

migrations/
  0001_init.sql … 0018_published_version.sql   18 migrations of schema evolution
                      (oauth clients, source format/retention, metadata, slugs +
                       tombstones, FTS, key expiry, visibility, doc tags, authorship,
                       status, source hash, link graph, updated_at, published
                       version) — see CLAUDE.md for what each adds

skills/
  README.md           orientation for the skill files below
  publishing.md       agent-facing: auth, endpoints, HTML/CSS/SVG allowlist
  connector-guide.md  for humans building MCP / Gemini function-calling connectors

docs/
  README.md           index of the consumer-facing reference docs
  for-agents.md       the agent-facing front door (what/why, verifiable safety claims, tools, connect)
  http-api-quickstart.md  the five-minute on-ramp (four routes, one auth header)
  http-api.md         the full HTTP/REST API reference
  security-model.md   the two walls, the input bounds, the explicit non-guarantees
  feature-roadmap.md  what's coming next (forward-links each design note)
  cloudflare-setup.md one-time Cloudflare provisioning guide
  agent-setup-runbook.md  agent-executable setup (cloudflare-setup.md's run/expect/if-it-fails twin)
  operating.md        day-to-day operator guide (every task via UI + curl)
  design/             design notes + SOLO/PLATFORM specs (rationale; as-built + aspirational)

scripts/
  build-openapi.mjs   regenerates openapi.json from src/contract.ts
  doc-web.mjs         on-platform doc-web republish recipe + `check` drift detector (#27, #4)
  doc-web-map.json    slug map: which docs mirror to Slopcafe, and their slugs

cli/                  Dart command-line client for the agent-key HTTP surface
  bin/slopcafe.dart   entrypoint (`dart compile exe` → a single static binary)
  lib/api/            typed model layer GENERATED from openapi.json
  lib/src/            client, config, commands; see cli/README.md
  test/               command-output + failure-contract suites (injected-Dio harness)
  tool/generate_api.dart  vendored model generator (re-pin openapi.json + re-run)

openapi.json          the committed, generated OpenAPI 3.1 spec (served at /openapi.json)

wrangler.toml         Worker config + bindings + non-secret vars
```

A **command-line client** lives in [`cli/`](cli/) — a Dart CLI covering the
agent-key HTTP surface (publish, list, search, context packs, find-by-slug, read,
update, edit, links) with first-class byte-exact publishing and a uniform
`--json` contract, for `claude` in headless mode, scripts, and devices where a
single binary beats wiring an MCP server. Its typed models are generated from
`openapi.json` (reusing the Flutter app's generator). See
[cli/README.md](cli/README.md) and [docs/design/cli-design.md](docs/design/cli-design.md).
It's a *consumer* of the HTTP API (no new surface), and is a candidate to split
into its own repo later.

## Agents and connectors

Point the agent itself at **[docs/for-agents.md](docs/for-agents.md)** first — the
front door written for the model rather than the operator: what the service is,
when to recommend it to its user, safety claims linked to the source that
enforces them, the tool surface, and how to connect (mirrored on-platform as
slug `slopcafe-for-agents`). An agent standing up a *fresh instance* drives
[docs/agent-setup-runbook.md](docs/agent-setup-runbook.md) instead.

If you want an AI agent to publish documents through this service, install
the skill in [skills/publishing.md](skills/publishing.md) — it documents auth,
the birth-private visibility rule, the operator-published render pointer (so an
agent says "written, not yet live" instead of handing over a stale URL),
publishing/updating/editing, discovery and context packs, cross-document
linking, and the full allowed/forbidden HTML+CSS+SVG reference. It's also published on Slopcafe itself (slug
`slopcafe-publishing-guide`) so a connected agent can read it on demand. To wrap
the API in typed tools for Claude or Gemini, see
[skills/connector-guide.md](skills/connector-guide.md) (recommended tool
surface + a TypeScript MCP server skeleton + Gemini function-calling
declarations).

## Follow-ups & non-goals

Things deliberately not in v1 (and where to find the rationale):

- **No integration-test layer.** ~40 inline hostile-input assertions in [sanitizer/src/lib.rs](sanitizer/src/lib.rs) plus a separate data-driven [bypass corpus](sanitizer/tests/bypass_corpus.rs) cover the sanitizer, and each pure leaf module has its own suite under `test/` — but nothing exercises the full JS→WASM→Worker→D1/R2 round-trip (no Vitest + Miniflare harness). The paths that need one — restore, the vector sync — are verified by typecheck plus a manual `wrangler dev` E2E. See [action-plan-v1.md](docs/design/action-plan-v1.md) for the rest of the plan.
- **Storage cap is best-effort.** The `SUM` runs outside the insert batch, so two simultaneous writes can both pass the check. (A *misconfigured* cap does fail closed: an unparseable or non-positive `STORAGE_CAP_BYTES` logs and falls back to the 2 GiB default rather than silently disabling the check.)
- **No per-document version cap.** An agent could churn many *differing* versions of one doc and chew the fleet quota; mitigate via admin DELETE. The one case that is handled is churning **identical** ones: since contract `2.1.0` a write whose source and metadata match what the document already holds is collapsed to a no-op (`"unchanged": true`, nothing stored, no `updated_at` touch) rather than appending a duplicate. That came out of a mis-programmed agent re-pushing an unchanged body every 30 minutes for ~1000 versions; the collapse is logged, so a runaway client stays visible in `wrangler tail` instead of merely being absorbed.
- **No `Idempotency-Key`** header support on POST `/d` yet. Route signature accommodates adding it without breaking changes. `PUT /d/:id` doesn't need one for the duplicate-delivery case — the identical-write collapse above makes replaying a write whose response was lost free instead of forking the version chain — but that is not a substitute for `If-Match`, which is what guards against *lost updates* (two principals writing different content). (`DELETE /d/:id` *is* idempotent — that's a separate, deliberate property of the kill switch.)
- **Single operator credential, not Google OAuth.** Multi-operator scoping (and per-operator agent grouping) is the right place to grow if the project ever takes on collaborators.
- **Writes are not scoped to a document's creator.** Any live document is writable by any active agent key — the flip side of the single-tenant trust model. What that no longer implies is publication: since migration 0018 a public document renders the operator-published version ([issue #43](https://github.com/Skylled/slopcafe/issues/43), closed), so an agent write is a staged version rather than a live change, and the one outward-facing field an agent can't touch on a public doc is its slug (`403 slug_locked`). Per-agent scoping via `created_by` is still the seam if content-level separation is ever wanted.
- **No agent-reachable publish, and none planned.** Promotion has no MCP tool and no agent HTTP door, deliberately: a tool that moved `published_ver` would hand straight back the path the column exists to close. What agents get instead is visibility into it — `published_version` on every MCP write/edit/read envelope, `published_ver` on every listing row — so a well-behaved agent reports "stored, waiting to be published" rather than pasting a URL that still shows last week's page. Same reasoning, same answer as visibility and revoke. Agents *have* since gained the two classification writes (`set_document_tags` / `set_document_status`, plus their `PUT /d/:id/…` twins), and that is the line rather than a step toward crossing it: tags are a fleet-internal filter and status marks currency, so neither reaches an anonymous reader — which is exactly what visibility, revoke and promotion each do.
- **CSP `'unsafe-inline'` in `style-src`** allows both `<style>` blocks and `style=""` attributes — CSP can't separate the two. As of sanitizer v1.4 both are allowed through; CSS safety is owned by the render-time CSP + iframe sandbox (no external CSS can load — `style-src`/`font-src`/`img-src` permit only `'self'`/`data:`), not by stripping `<style>`.
- **Documents keep the sanitizer policy they were written under.** `sanitize()` runs at write time, so a stored document doesn't pick up an allowlist or link-behavior change (e.g. the v1.6 new-tab pass on on-platform links) until it is re-published. Re-sanitizing from the retained source is a deferred design ([source-retention-design.md](docs/design/source-retention-design.md) §9).

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
