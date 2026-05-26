# agent-web-host

A single Cloudflare Worker that lets authenticated agents publish HTML at unguessable URLs. Humans click the URL and see a sandboxed render under a strict CSP. Agents `GET` the same URL with their key and receive raw sanitized HTML for further processing.

One deployment, one domain. Writing and reading share a TLD by construction, so the secret URL never crosses an origin boundary.

The design rationale (what's deliberately in v1 and what isn't, the two security layers and which one is load-bearing, why everything collapses into one Worker) lives in [action-plan-v1.md](action-plan-v1.md). This README is the operator's reference: how to deploy it, what the API looks like, and how to drive it day-to-day.

## Architecture

```
                    ┌─────────────────────────────────┐
   agent ──POST──▶  │            ONE WORKER            │
   (write)          │                                 │ ──▶ Ammonia-WASM (sanitize, in-process)
                    │  POST   /d                      │
   agent ──GET───▶  │  GET    /d/:id   (Authz → raw)  │ ──▶ D1   (agents, keys, docs, versions)
   (read API)       │  GET    /d/:id   (no auth →     │
                    │         sandboxed shell)        │ ──▶ R2   (sanitized bytes, append-only)
   human ─click──▶  │  GET    /d/:id/raw  (iframe src)│
   (browser)        │                                 │
                    │  PUT    /d/:id   (new version)  │
   operator ──────▶ │  DELETE /d/:id   (revoke+purge) │
                    │  /admin/*        (operator API) │
                    └─────────────────────────────────┘
```

**Two security layers, in order:**
1. **Sandbox + strict CSP** on what the browser renders. Iframe with all sandbox restrictions, `script-src 'none'`, `frame-ancestors 'self'`, `base-uri 'none'`, etc. The load-bearing wall against code execution, exfiltration, and framing.
2. **Ammonia-WASM sanitization** at write time. Strips `<script>`, `<style>`, `<meta http-equiv>`, `<iframe>`, dangerous URL schemes, and inline event handlers. Cheap insurance behind the wall — covers markup the CSP can't (e.g. `<meta refresh>` redirects).

Possession of the 22-character `public_id` is read access. There is no reader login. Revoking a document purges the R2 bytes immediately, so a real delete sticks.

## Setup

**Prerequisites:**
- A Cloudflare account, Wrangler installed (`npm i`)
- Node 18+
- Rust + `wasm-pack` (only needed for `npm run build:wasm`; deploys run this automatically). The repo's `.dev.vars` is gitignored — secrets live there for local dev, and on Cloudflare for production.

**Provision the stores** (one-time, names match [wrangler.toml](wrangler.toml)):

```sh
npx wrangler r2 bucket create agent-web-host-docs
npx wrangler d1 create agent-web-host-meta
# Paste the new database_id into wrangler.toml under [[d1_databases]].
```

**Apply the schema** ([migrations/0001_init.sql](migrations/0001_init.sql)):

```sh
npm run db:migrate:remote
npm run db:migrate:local       # for `wrangler dev`
```

**Set the two secrets** (random, ~256 bits each):

```sh
openssl rand -base64 48 | tr -d '\n=' | tr '/+' '_-' | \
  npx wrangler secret put HMAC_PEPPER
openssl rand -base64 48 | tr -d '\n=' | tr '/+' '_-' | \
  npx wrangler secret put OPERATOR_TOKEN
```

Mirror them into `.dev.vars` so `wrangler dev` works:

```
HMAC_PEPPER="..."
OPERATOR_TOKEN="..."
```

`HMAC_PEPPER` is the server pepper for hashing agent key secrets. `OPERATOR_TOKEN` is the single operator credential — keep it somewhere safe; rotating means re-running `wrangler secret put` and updating wherever you call admin endpoints from.

**Deploy:**

```sh
npm run deploy
```

The `predeploy` hook rebuilds the WASM sanitizer (`cd sanitizer && wasm-pack build --target web --release --no-typescript`). First deploy publishes to `https://<worker-name>.<workers-subdomain>.workers.dev`.

## Quickstart

After deploy, set `BASE` and `OP` in your shell:

```sh
BASE=https://<worker-name>.<workers-subdomain>.workers.dev
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

| Verb | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | — | Health/smoke (no secrets revealed) |
| `POST` | `/d` | agent | Create document; returns `public_id` + URL |
| `PUT` | `/d/:id` | agent + `If-Match` | Append new version |
| `DELETE` | `/d/:id` | operator | Revoke document, purge R2 bytes |
| `GET` | `/d/:id` | none / agent | Browser → shell; agent → raw HTML |
| `GET` | `/d/:id/raw` | — | Raw sanitized bytes (iframe `src`) |
| `GET` | `/admin/agents` | operator | List agents (counts of keys, docs) |
| `POST` | `/admin/agents` | operator | Mint agent + initial key |
| `GET` | `/admin/agents/:id/keys` | operator | List keys for an agent (prefixes, no secrets) |
| `POST` | `/admin/agents/:id/keys` | operator | Mint additional key for an agent |
| `DELETE` | `/admin/keys/:id` | operator | Revoke a single key |
| `GET` | `/admin/documents` | operator | List all docs (includes revoked) |

### Notable details

**`POST /d`**  Body must be `Content-Type: text/html`. Sanitized in-process (Ammonia-WASM). Returns 413 if the input or the fleet-wide storage cap would be exceeded. The response includes a `modified` boolean — `true` if the sanitizer changed anything; useful for agents that want to self-correct.

**`PUT /d/:id`**  Requires `If-Match`. Pass `If-Match: "v<n>"` for optimistic concurrency (returns **412** if `n` ≠ the current version), or `If-Match: *` to skip the version check. Returns **428** if the header is missing entirely — silently appending without a precondition is the wrong default. Any valid agent key under the operator can PUT to any document; the fleet shares trust.

**`GET /d/:id`**  Content-negotiates on `Authorization`:
- No header → minimal HTML shell with `<iframe sandbox src="/d/:id/raw">`. Shell CSP locks the page to a same-origin iframe; the iframe itself loads from the next route below.
- Valid agent key → raw bytes (byte-identical to `/d/:id/raw`).
- Present but invalid key → **401**, not silent fallback. Surfaces broken keys instead of hiding them.

**`GET /d/:id/raw`**  The bytes that render inside the sandboxed iframe. CSP is the strict one: `default-src 'none'`, `img/style/font-src` to `self/inline/data:`, `frame-ancestors 'self'`, `base-uri 'none'`, `form-action 'none'`. `Cache-Control: no-store` everywhere so a revoke is real-time.

**`DELETE /d/:id`**  Flips `revoked_at` in D1 first, then batch-deletes every version's R2 object. Subsequent GETs 404 within milliseconds even if the R2 cleanup hangs. `versions` rows stay as an audit trail; the bytes themselves are the irrecoverable part.

**Status codes you'll see across writes**: 200/201/400/401/404/412/413/415/428. Errors are JSON: `{ "error": "<code>", "message": "..." }` plus optional context fields.

## Operator runbook

**Find a document:**
```sh
curl -s "$BASE/admin/documents" -H "authorization: $OP" | jq .
```

**Revoke a document** (irreversible — R2 bytes are gone):
```sh
curl -s -X DELETE "$BASE/d/$PUBLIC_ID" -H "authorization: $OP"
# → { revoked: true, r2_objects_purged: N }
```

**Rotate an agent's key:**
```sh
# Mint a new key for the existing agent (returns plaintext once)
curl -s -X POST "$BASE/admin/agents/$AGENT_ID/keys" -H "authorization: $OP"

# Roll the new key into the agent's deployment, verify it works, then revoke the old one
curl -s -X DELETE "$BASE/admin/keys/$OLD_KEY_ID" -H "authorization: $OP"
```

**Kill a compromised key immediately:**
```sh
# Find the key_id from the prefix that's misbehaving (visible in your own logs)
curl -s "$BASE/admin/agents/$AGENT_ID/keys" -H "authorization: $OP"
curl -s -X DELETE "$BASE/admin/keys/$KEY_ID" -H "authorization: $OP"
# Next request signed by that key gets 401 — the auth check hits D1 every request.
```

**List the fleet:**
```sh
curl -s "$BASE/admin/agents" -H "authorization: $OP" | jq .
```

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
npm run dev            # wrangler dev — uses .dev.vars + local D1/R2
npm run typecheck
npm run test           # runs the sanitizer corpus (cargo test, host target)
npm run build:wasm     # rebuild the Rust→WASM sanitizer
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

```
src/
  index.ts            dispatcher + write path (POST/PUT/DELETE on /d)
  serve.ts            GET /d/:id and /d/:id/raw — shell, raw, content negotiation
  admin.ts            /admin/* operator endpoints
  auth.ts             Bearer parse, HMAC-SHA256, agent + operator auth
  ids.ts              UUIDs, public_ids, API key mint + parse
  sanitizer.ts        Worker-side wrapper around the WASM sanitizer
  env.ts              Env bindings interface
  wasm.d.ts           type shims for .wasm imports + the wasm-bindgen glue

sanitizer/
  Cargo.toml          Rust crate metadata (ammonia + wasm-bindgen)
  src/lib.rs          allowlist tuned for standalone HTML + SVG, link_rel injected
  pkg/                (gitignored) wasm-pack output, regenerated by predeploy
  target/             (gitignored) cargo build cache

migrations/
  0001_init.sql       agents, agent_keys, documents, versions

action-plan-v1.md     design rationale, security model, follow-ups
wrangler.toml         Worker config + bindings + non-secret vars
```

## Follow-ups & non-goals

Things deliberately not in v1 (and where to find the rationale):

- **Sanitizer test coverage is corpus-only.** ~40 hostile-input assertions in [sanitizer/src/lib.rs](sanitizer/src/lib.rs) cover the common vectors; not yet covered are regression pins (exact-output snapshots) or a Vitest + Miniflare integration layer that exercises the JS→WASM→Worker round-trip. See [action-plan-v1.md](action-plan-v1.md) "Follow-ups discovered during build" for the rest of the plan.
- **Storage cap is best-effort.** The `SUM` runs outside the insert batch, so two simultaneous writes can both pass the check.
- **No per-document version cap.** An agent could churn many versions of one doc and chew the fleet quota; mitigate via admin DELETE.
- **No pagination** on admin list endpoints (capped at 200 newest).
- **No `Idempotency-Key`** header support on POST `/d` yet. Route signature accommodates adding it without breaking changes.
- **Single operator credential, not Google OAuth.** Multi-operator scoping (and per-operator agent grouping) is the right place to grow if the project ever takes on collaborators.
- **CSP `'unsafe-inline'` in `style-src`** allows both `<style>` blocks and `style=""` attributes — CSP can't separate the two. The sanitizer strips `<style>` so only attributes survive; this is the layered defense, not a CSP weakness.
