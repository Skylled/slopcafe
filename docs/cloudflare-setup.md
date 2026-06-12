# Cloudflare setup

This guide walks through everything you need to provision on Cloudflare's side before you can deploy `agent-web-host` (the infrastructure code-name for **Slopcafe** — see the [naming note](../README.md) in the README). It assumes you've cloned the repo and have skimmed the [action plan](design/action-plan-v1.md) at a high level — what the Worker does, and what each store holds.

The setup is a one-time job. After this, all your iteration happens with `wrangler dev` and `wrangler deploy` from your terminal, and your day-to-day operating happens through the [operator guide](operating.md).

## Prerequisites

- A Cloudflare account. If you don't have one, sign up at <https://dash.cloudflare.com/sign-up>. The free tier covers everything in this project at typical personal-publishing volumes.
- **Node.js 22.6 or later**, with `npm` (the test suite and the OpenAPI build that runs on deploy use `--experimental-strip-types`, which needs ≥ 22.6).
- A payment method on file with Cloudflare. R2 requires one even if you stay entirely within the free tier; you will not be charged at this project's scale, but the activation flow refuses to proceed without one.
- **Rust toolchain + `wasm-pack`** — needed to build the WASM sanitizer (`npm run build:wasm`, which `npm run deploy` runs automatically via its `predeploy` hook). Install via [rustup](https://rustup.rs) with the `wasm32-unknown-unknown` target, plus `wasm-pack` (`brew install wasm-pack`, or `cargo install wasm-pack`). A fresh clone has no `sanitizer/pkg/` (it's gitignored), so run `npm run build:wasm` once before your first `wrangler dev` or deploy.
- A domain is **not** required for initial setup. Cloudflare gives every account a `*.workers.dev` subdomain that's enough to test, demo, or run the project for yourself. Custom domains are a later upgrade (see the [troubleshooting section](#custom-domain-instead-of-workersdev)).

## Order of operations

The steps are sequenced so each one produces a value the next one needs. The repo ships **config templates** (`wrangler.toml.example`, `.dev.vars.example`) you copy and fill in — you do **not** hand-write `wrangler.toml` or `package.json` (the latter already exists in the repo).

1. Pick a `workers.dev` subdomain (account-wide, hard to change later).
2. Activate R2 and create the documents bucket.
3. Create the D1 database and capture its ID.
4. Create the KV namespace (OAuth state) and capture its ID.
5. Create the Vectorize index (semantic search).
6. Install Wrangler (`npm install`) and authenticate it.
7. Copy the config templates and fill in your IDs.
8. Set the two production secrets.
9. Apply the database migrations.
10. Verify everything is wired up.
11. Deploy.

Workers AI (the embedding model behind semantic search) needs **no provisioning** — it's just a binding in `wrangler.toml`, covered in step 7.

## 1. Pick a `workers.dev` subdomain

Sign into the Cloudflare dashboard, then navigate to **Compute → Workers & Pages → Subdomain** (or visit `https://dash.cloudflare.com/<your-account-id>/workers/subdomain` directly). Your **Account ID** is the long hex string in any dashboard URL — note it down; you'll need it shortly (or just run `npx wrangler whoami` later).

Choose a subdomain name and click **Continue → Confirm**. The name you pick becomes `<that-name>.workers.dev`, and every Worker you ever deploy on this account hangs off it. So if you pick `acme`, this project lands at `agent-web-host.acme.workers.dev`.

Three things to know before you commit:

- The subdomain is **account-wide**, not per-project. Pick something neutral that represents you or your org, not this specific project.
- It must be **globally unique** across all Cloudflare accounts.
- Changing it later moves every existing Worker to the new name and breaks any URLs you've shared. Pick once, well.

## 2. Activate R2 and create the bucket

R2 is Cloudflare's S3-compatible object store. In this project it holds two blobs per document version: the sanitized render bytes **H** and the retained source **S** (the `.src` sibling). One bucket, written by the publish path and read by the render path.

Navigate to **R2 Object Storage** in the left nav (under **Storage & databases**). If R2 isn't yet active on your account, you'll see an "Activate R2" screen. The free tier is:

- 10 GB / month storage
- 1 million Class A operations / month (writes, lists)
- 10 million Class B operations / month (reads)

Click **Add R2 subscription to my account** (or **Continue to R2** if it shows that instead). Total due is **$0/month** for usage within the free tier.

> **Heads-up on Class A vs Class B operations.** Class A (writes, lists) cost $4.50 per additional million; Class B (reads) cost $0.36 per additional million. Deletes are free. This project's request mix is read-heavy (humans and agents reading docs more often than agents publishing them), so the cost shape works in your favor.

Create the bucket from the terminal (matches the name in `wrangler.toml.example`):

```sh
npx wrangler r2 bucket create agent-web-host-docs
```

Or from the dashboard via **Create bucket**, with:

- **Bucket name:** `agent-web-host-docs` (or anything matching `^[a-z0-9-]+$` — if you change it, change `bucket_name` in `wrangler.toml` to match).
- **Location:** **Automatic** is correct. Cloudflare places the bucket near the first access; reads are served from the edge regardless.
- **Default Storage Class:** **Standard**. (Infrequent Access charges per read and is for cold archive data — not your access pattern.)
- **Do not enable bucket-level object versioning.** This project handles versioning at the application layer (the `versions` table). Bucket-level versioning would duplicate it and complicate the revoke flow, which depends on bytes-gone being the kill switch.

Confirm the bucket page shows **Public Access: Disabled**. Reads in this project always go through the Worker (which checks `revoked_at` and visibility first); the bucket itself must never be public.

## 3. Create the D1 database

D1 is Cloudflare's serverless SQLite database. It holds all the metadata — agents, keys, documents, versions, OAuth clients, slug tombstones, and more. The schema is managed by the migration files in `migrations/` (13 of them as of this writing), **not** in the dashboard; you'll apply them in step 9.

Create it:

```sh
npx wrangler d1 create agent-web-host-meta
```

**Copy the printed `database_id`** (a UUID like `00000000-0000-0000-0000-000000000000`) — you'll paste it into `wrangler.toml` in step 7. You can recover it later with `npx wrangler d1 list`. If you rename the database, match it in `wrangler.toml` and the `db:*` scripts in `package.json`.

## 4. Create the KV namespace

KV holds the OAuth provider's state — registered clients, authorization grants, and access tokens. It's owned by `@cloudflare/workers-oauth-provider`; you never touch it directly, but the OAuth door (`/mcp` for hosted Claude / Cowork) won't work without it.

```sh
npx wrangler kv namespace create OAUTH_KV
```

**Copy the printed `id`** — you'll paste it into `wrangler.toml` under `[[kv_namespaces]]` in step 7.

## 5. Create the Vectorize index

Vectorize is Cloudflare's vector database. It holds the semantic-search index — N chunk vectors per document, used as a candidate ranker fused with keyword (FTS5) search. The dimensions and metric are **immutable after creation**, so get them right the first time:

```sh
npx wrangler vectorize create agent-web-host-docs --dimensions=1024 --metric=cosine
```

The index name (`agent-web-host-docs`) is referenced by `index_name` in `wrangler.toml`; if you change it, match it there. There's no ID to capture — Vectorize is bound by name.

> **Workers AI needs no provisioning.** The embedding model (`@cf/qwen/qwen3-embedding-0.6b`, 1024-dim) runs through the `[ai]` binding and is included on the Workers Free plan (daily neuron allowance). At this project's scale it's a rounding error against that allowance — no setup beyond the binding in step 7.

## 6. Install Wrangler and authenticate

Wrangler is Cloudflare's CLI for Workers — it deploys your code, runs the local dev runtime, applies D1 migrations, and tails logs. It's already pinned in the repo's `package.json`, so install the project's dependencies from the repo root:

```sh
npm install
```

> **Use Wrangler 4 or later.** The repo pins `wrangler` to a `^4.x` line. Older majors (Wrangler 3 and below) pull in versions of `esbuild`, `miniflare`, and `undici` with open advisories. See the [troubleshooting section](#npm-audit-reports-vulnerabilities-after-installing-wrangler) for why those don't affect the deployed Worker — but pinning `^4` keeps `npm audit` clean anyway.

Authenticate Wrangler against your Cloudflare account:

```sh
npx wrangler login
```

This opens a browser tab to a Cloudflare OAuth consent screen. Click **Allow** and the CLI catches the callback. Confirm with:

```sh
npx wrangler whoami
```

You should see your email and account ID printed. Note the account ID — it goes into `wrangler.toml` next.

## 7. Copy the config templates and fill in your IDs

The repo ships two templates. Copy them to their real (gitignored) names so your account/resource IDs never land in version control:

```sh
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

Then edit `wrangler.toml` and replace the `<PLACEHOLDERS>`:

- `account_id` — from `npx wrangler whoami` (step 6).
- `database_id` under `[[d1_databases]]` — from step 3.
- `id` under `[[kv_namespaces]]` — from step 4.

The bucket name, Vectorize index name, and AI binding are already filled in to match the resources you created above.

### What the bindings mean

The `binding` name in each block is the variable your Worker code uses. There's no SDK init, no URL, no credential — Cloudflare wires these in at runtime based on this config. Getting the bindings right matters more than any code you'll write on day one.

| Binding | Store | Used for |
|---|---|---|
| `DOCS` | R2 bucket | Sanitized render bytes + retained source per version (`env.DOCS.put/get/delete`). |
| `META` | D1 database | All metadata — agents, keys, documents, versions, etc. (`env.META.prepare(...)`). |
| `OAUTH_KV` | KV namespace | OAuth clients, grants, tokens (owned by the OAuth provider library). |
| `VECTORIZE` | Vectorize index | Semantic-search chunk vectors. |
| `AI` | Workers AI | Embeddings for the query + document side of hybrid search. |

The `[[rules]]` block at the bottom of the template is required and already correct — leave it as-is:

- **`CompiledWasm`** bundles the Rust sanitizer (`*.wasm`) directly into the Worker (instead of fetching it at runtime via `import.meta.url`, which doesn't exist on Workers).

### Non-secret config: `[vars]`

The `[vars]` block holds non-secret runtime config. The template's defaults are sensible; adjust if you want:

| Var | Default | Meaning |
|---|---|---|
| `STORAGE_CAP_BYTES` | `2147483648` (2 GiB) | Fleet-wide storage budget across every agent's documents (counts both the render and the retained source). |
| `SESSION_EPOCH` | `"1"` | Operator-browser-session signing epoch — a rotation counter, **not** a secret. Bump it and redeploy to invalidate every operator browser session at once. |
| `DEFAULT_DOCUMENT_VISIBILITY` | `"private"` | Birth visibility for newly published docs. With `"private"`, a fresh doc is **not** served on the anonymous web until you explicitly make it public. Any value other than exactly `"public"` clamps to `"private"`. |

## 8. Set the two production secrets

Secrets are **not** `[vars]` and must never go in `wrangler.toml`. Set them encrypted via `wrangler secret put`. Generate each as ~256 bits of URL-safe randomness:

```sh
openssl rand -base64 48 | tr -d '\n=' | tr '/+' '_-' | npx wrangler secret put HMAC_PEPPER
openssl rand -base64 48 | tr -d '\n=' | tr '/+' '_-' | npx wrangler secret put OPERATOR_TOKEN
```

- **`HMAC_PEPPER`** — server-side pepper for hashing agent key secrets (stored in `agent_keys.key_hash`). Rotating it invalidates every existing agent key.
- **`OPERATOR_TOKEN`** — the single operator credential. It mints agents/keys, revokes documents, and backs the operator browser login. Rotating it also ends every operator browser session. Keep it somewhere safe — you can overwrite it but never read it back from the dashboard.

For local development (`npm run dev`), put the **same two values** into the `.dev.vars` you copied in step 7. `wrangler dev` reads `.dev.vars` automatically; it's gitignored.

## 9. Apply the database migrations

The empty D1 database has no tables yet. Apply all of `migrations/` to both the remote (production) database and the local `wrangler dev` shadow:

```sh
npm run db:migrate:remote    # production
npm run db:migrate:local     # for `wrangler dev`
```

(These wrap `wrangler d1 migrations apply agent-web-host-meta --remote` / `--local`. If you renamed the database, the script names in `package.json` need to match.)

## 10. Verify

A few sanity checks before you deploy:

```sh
npx wrangler whoami                  # email + account ID matching wrangler.toml
npx wrangler r2 bucket list          # lists agent-web-host-docs
npx wrangler d1 list                 # lists agent-web-host-meta + its UUID
npx wrangler kv namespace list       # lists OAUTH_KV + the id in wrangler.toml
npx wrangler vectorize list          # lists agent-web-host-docs (1024-dim, cosine)
```

If all five line up with `wrangler.toml`, you're done provisioning.

## 11. Deploy

```sh
npm run deploy
```

The `predeploy` hook rebuilds the WASM sanitizer (needs the Rust toolchain from the prerequisites) and regenerates `openapi.json`, then `wrangler deploy` ships it. Your Worker goes live at `https://agent-web-host.<your-subdomain>.workers.dev`.

Smoke-test it:

```sh
curl -s https://agent-web-host.<your-subdomain>.workers.dev/healthz
# → {"ok":true,"service":"slopcafe","sanitizer_version":"...","d1":{...},"r2":{...}}
```

**Next:** head to the [operator guide](operating.md) to mint your first agent + key and learn the day-to-day tasks (both via the web console and via curl). To serve on your own domain, see the [custom-domain note](#custom-domain-instead-of-workersdev) below.

## Troubleshooting

### `npm audit` reports vulnerabilities after installing Wrangler

If you see advisories in `esbuild`, `miniflare`, `undici`, or `ws` right after `npm install`, the most likely cause is that an older Wrangler major (3 or below) got resolved. All those packages are **build-time dependencies** — they run on your laptop during `wrangler dev` or `wrangler deploy`, never in the deployed Worker. Cloudflare doesn't ship esbuild or miniflare to the edge; the production runtime is V8 isolates and isn't affected by these CVEs.

The fix is also the right thing to do anyway: ensure `wrangler` is pinned to a `^4` line in `package.json`, blow away the lockfile and `node_modules`, and reinstall:

```sh
rm -rf node_modules package-lock.json
npm install
npm audit
```

You should see "found 0 vulnerabilities."

### `npm run deploy` fails in the WASM build step

`predeploy` runs `npm run build:wasm`, which needs the Rust toolchain. If it errors with `wasm-pack: command not found` or a missing target, install the prerequisites: [rustup](https://rustup.rs) with `rustup target add wasm32-unknown-unknown`, then `cargo install wasm-pack` (or `brew install wasm-pack`). The `predeploy` script adds `$HOME/.cargo/bin` to `PATH` so a fresh shell resolves them. (If `wasm-opt` rejects the output, note that `sanitizer/Cargo.toml` already sets `wasm-opt = false` — rustc's `opt-level=z + lto` handles size.)

### `wrangler deploy` fails with "Authentication error"

Your `wrangler login` session may have expired or never completed. Re-run `npx wrangler login` and confirm with `npx wrangler whoami`. If `whoami` still fails, delete `~/.config/.wrangler/config/default.toml` (or the equivalent on Windows) and start over.

### `wrangler dev` can't find R2, D1, or returns empty data

`wrangler dev` defaults to a *local* shadow of R2/D1/KV (managed by Miniflare). On first run those shadows are empty regardless of what's in your real Cloudflare account. Apply your migrations locally:

```sh
npm run db:migrate:local
```

To run against the real cloud stores, pass `--remote` (`npx wrangler dev --remote`). Use this sparingly — every request hits real R2/D1/Vectorize and counts toward your quotas.

### `Could not find bucket / database / namespace / index` on deploy

Almost always a name/ID mismatch between `wrangler.toml` and the dashboard. The `bucket_name`, `database_id`, KV `id`, and Vectorize `index_name` must each match what you created exactly (names are case-sensitive; the D1 `database_id` is the UUID, not the name). Re-run the relevant `list` command from step 10 and compare.

### Custom domain instead of `workers.dev`

When you're ready to graduate from `*.workers.dev` to your own domain, the zone must already be in your Cloudflare account (nameservers pointed at Cloudflare). Then uncomment the `routes` block in `wrangler.toml` — `custom_domain = true` makes Cloudflare provision the TLS cert and route DNS automatically, no manual A/AAAA records:

```toml
routes = [
  { pattern = "example.com", custom_domain = true },
  { pattern = "www.example.com", custom_domain = true },
]
```

Flip `workers_dev = false` if you want to retire the `*.workers.dev` URL, then `npm run deploy`. No code change required. (If you can't move the zone to Cloudflare, the more fiddly **Cloudflare for SaaS / custom hostnames** path keeps your existing registrar authoritative via a CNAME — mainly useful when a full zone move isn't an option.)
