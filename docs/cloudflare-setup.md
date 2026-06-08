# Cloudflare setup

This guide walks through everything you need to provision on Cloudflare's side before you can deploy `agent-web-host`. It assumes you've already cloned the repo and are familiar with the [action plan](../action-plan-v1.md) at a high level — what the Worker does, what R2 holds, what D1 holds.

The setup is a one-time job. After this, all your iteration happens with `wrangler dev` and `wrangler deploy` from your terminal.

## Prerequisites

- A Cloudflare account. If you don't have one, sign up at <https://dash.cloudflare.com/sign-up>. The free tier covers everything in this project at typical personal-publishing volumes.
- Node.js 16 or later, with `npm`.
- A payment method on file with Cloudflare. R2 requires one even if you stay entirely within the free tier; you will not be charged at this project's scale, but the activation flow refuses to proceed without one.
- A domain is **not** required for initial setup. Cloudflare gives every account a `*.workers.dev` subdomain that's enough to test, demo, or run the project for yourself. Custom domains are a later upgrade.

## Order of operations

The steps are sequenced so that each one produces a value the next one needs. Doing them out of order works but you'll be bouncing back and forth between the dashboard and your terminal.

1. Pick a `workers.dev` subdomain (account-wide, hard to change later).
2. Activate R2 and create a bucket.
3. Create a D1 database and capture its ID.
4. Install Wrangler locally and authenticate it.
5. Write `wrangler.toml` and `package.json`.
6. Verify everything is wired up correctly.

## 1. Pick a `workers.dev` subdomain

Sign into the Cloudflare dashboard, then navigate to **Compute → Workers & Pages → Subdomain** (or visit `https://dash.cloudflare.com/<your-account-id>/workers/subdomain` directly). Your **Account ID** is the long hex string in any dashboard URL — note it down; you'll need it shortly.

Choose a subdomain name and click **Continue → Confirm**. The name you pick becomes `<that-name>.workers.dev`, and every Worker you ever deploy on this account hangs off it. So if you pick `acme`, this project will land at `agent-web-host.acme.workers.dev`.

Three things to know before you commit:

- The subdomain is **account-wide**, not per-project. Pick something neutral that represents you or your org, not this specific project.
- It must be **globally unique** across all Cloudflare accounts.
- Changing it later moves every existing Worker to the new name and breaks any URLs you've shared. Pick once, well.

## 2. Activate R2 and create the bucket

R2 is Cloudflare's S3-compatible object store. In this project it holds the sanitized HTML bytes — one object per document version, written by `POST /d` and read by `GET /d/:public_id`.

Navigate to **R2 Object Storage** in the left nav (under **Storage & databases**). If R2 isn't yet active on your account, you'll see an "Activate R2" screen. The free tier is:

- 10 GB / month storage
- 1 million Class A operations / month (writes, lists)
- 10 million Class B operations / month (reads)

Click **Add R2 subscription to my account** (or **Continue to R2** if it shows that instead). Total due is **$0/month** for usage within the free tier.

> **Heads-up on Class A vs Class B operations.** Class A (writes, lists) cost $4.50 per additional million; Class B (reads) cost $0.36 per additional million. Deletes are free. This project's request mix is read-heavy (humans and agents reading docs more often than agents publishing them), so the cost shape works in your favor.

Once R2 is active, click **Create bucket**. Use:

- **Bucket name:** anything that matches `^[a-z0-9-]+$`. The default in this project's `wrangler.toml` template is `agent-web-host-docs`; if you change it, change `wrangler.toml` to match.
- **Location:** **Automatic** is correct. Cloudflare will place the bucket near the first access; reads are served from the edge regardless.
- **Default Storage Class:** **Standard**. (Infrequent Access charges per read and is for cold archive data — not your access pattern.)
- **Do not enable bucket-level object versioning.** This project handles versioning at the application layer (the `versions` table). Bucket-level versioning would duplicate it and complicate the revoke flow, which depends on bytes-gone being the kill switch.

After creation, confirm the bucket page shows **Public Access: Disabled**. Reads in this project always go through the Worker (which checks `revoked_at` first); the bucket itself must never be public.

## 3. Create the D1 database

D1 is Cloudflare's serverless SQLite database. It holds the four metadata tables (`documents`, `versions`, `agents`, `agent_keys`).

Navigate to **D1 SQLite Database** in the left nav, then click **Create Database**.

- **Name:** the default in this project's template is `agent-web-host-meta`. Change it if you want, but match it in `wrangler.toml`.
- **Data location:** **Automatic** is correct for almost all cases. You only need to specify a jurisdiction if you have a regulatory reason to.

After creation, you land on the database's overview page. **Copy the Database ID** from the page header (a UUID like `00000000-0000-0000-0000-000000000000`). You'll paste it into `wrangler.toml` in the next step. There is no way to recover this ID without coming back to the dashboard.

> **No schema yet.** D1's schema is managed via migration files in your repo, not in the dashboard. The empty database here will get its tables when you first run `wrangler d1 migrations apply` against a `migrations/0001_init.sql` you write later.

## 4. Install Wrangler and authenticate

Wrangler is Cloudflare's CLI for Workers — it deploys your code, runs the local dev runtime, applies D1 migrations, and tails logs.

Install it as a per-project dev dependency. From the repo root:

```sh
npm install --save-dev wrangler @cloudflare/workers-types typescript
```

> **Use Wrangler 4 or later.** Older majors (Wrangler 3 and below) pull in versions of `esbuild`, `miniflare`, and `undici` with open advisories. See the [troubleshooting section](#troubleshooting) for context. Pinning `wrangler` to `^4.95.0` or later in `package.json` keeps `npm audit` clean.

Authenticate Wrangler against your Cloudflare account:

```sh
npx wrangler login
```

This opens a browser tab to a Cloudflare OAuth consent screen. Click **Allow** and the CLI catches the callback. Confirm with:

```sh
npx wrangler whoami
```

You should see your email and account ID printed.

> **Why per-project install over global?** A repo-pinned Wrangler version means future-you (or a contributor) won't get bitten by a Wrangler upgrade silently changing the build. `npx wrangler` calls use the locally installed version.

## 5. Write `wrangler.toml` and `package.json`

These two files tie everything together. The `package.json` declares your scripts and dependencies; the `wrangler.toml` tells Wrangler what to deploy and what to bind to.

### `package.json`

```json
{
  "name": "agent-web-host",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "db:migrate:local": "wrangler d1 migrations apply agent-web-host-meta --local",
    "db:migrate:remote": "wrangler d1 migrations apply agent-web-host-meta --remote",
    "db:console:local": "wrangler d1 execute agent-web-host-meta --local --command",
    "db:console:remote": "wrangler d1 execute agent-web-host-meta --remote --command"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250525.0",
    "typescript": "^5.5.0",
    "wrangler": "^4.95.0"
  }
}
```

If you renamed the D1 database in step 3, substitute that name in the `db:*` scripts.

### `wrangler.toml`

```toml
name = "agent-web-host"
main = "src/index.ts"
compatibility_date = "2026-05-26"
compatibility_flags = ["nodejs_compat"]

# From your Cloudflare dashboard URL.
account_id = "<YOUR_ACCOUNT_ID>"

# Publish to <name>.<your-subdomain>.workers.dev on each deploy.
# Set false later when you bind a custom domain.
workers_dev = true

# R2: sanitized HTML bytes.
# In Worker code: env.DOCS.put(key, body), env.DOCS.get(key), env.DOCS.delete(key)
[[r2_buckets]]
binding = "DOCS"
bucket_name = "agent-web-host-docs"

# D1: metadata (documents, versions, agents, agent_keys).
# In Worker code: env.META.prepare("SELECT ...").bind(...).first()
[[d1_databases]]
binding = "META"
database_name = "agent-web-host-meta"
database_id = "<YOUR_D1_DATABASE_ID>"
migrations_dir = "migrations"

[vars]
SANITIZER_VERSION = "ammonia-v1"
STORAGE_CAP_BYTES = "104857600"  # 100 MiB
```

Replace `<YOUR_ACCOUNT_ID>` and `<YOUR_D1_DATABASE_ID>` with the values you captured. If you used different names for the bucket or database, replace those too.

### What the bindings mean

The `binding` name in each `[[r2_buckets]]` and `[[d1_databases]]` block is the variable name your Worker code uses. `binding = "DOCS"` means `env.DOCS.put(...)` reaches the R2 bucket; `binding = "META"` means `env.META.prepare(...)` reaches D1. There's no SDK init, no URL, no credential — Cloudflare wires these in at runtime based on this config. Getting the bindings right matters more than any code you'll write on day one.

### Secrets — not yet, but you'll need them

The Worker will eventually expect two secrets at runtime:

- `HMAC_PEPPER` — server-side pepper for hashing agent key secrets stored in `agent_keys.key_hash`.
- `OPERATOR_TOKEN` — single shared secret for operator-only endpoints (revoke document, mint key) in v1.

Don't put these in `wrangler.toml` or `[vars]`. Set them encrypted via:

```sh
npx wrangler secret put HMAC_PEPPER
npx wrangler secret put OPERATOR_TOKEN
```

You'll be prompted for the value, and it's then stored encrypted in Cloudflare; you can overwrite but never read it back from the dashboard. For local development, create a `.dev.vars` file in the repo root (and add it to `.gitignore`):

```
HMAC_PEPPER=some-long-random-string
OPERATOR_TOKEN=another-long-random-string
```

`wrangler dev` reads `.dev.vars` automatically.

## 6. Verify

A few sanity checks before you write any Worker code:

```sh
npx wrangler whoami
```

Should print your email and account ID matching `account_id` in `wrangler.toml`.

```sh
npx wrangler r2 bucket list
```

Should list your bucket (e.g., `agent-web-host-docs`).

```sh
npx wrangler d1 list
```

Should list your database with the same UUID you put in `wrangler.toml`.

If all three match, you're done with setup. The next step belongs to the build (step 1 of the [action plan](../action-plan-v1.md)) — write a minimal `src/index.ts` that returns `new Response("hello")`, create a `migrations/0001_init.sql` with the four tables from the plan, and run `npx wrangler deploy`. Your Worker will appear at `https://agent-web-host.<your-subdomain>.workers.dev`.

## Troubleshooting

### `npm audit` reports vulnerabilities after installing Wrangler

If you see multiple advisories in `esbuild`, `miniflare`, `undici`, or `ws` right after `npm install`, the most likely cause is that an older Wrangler major (3 or below) got installed. All those packages are **build-time dependencies** — they run on your laptop during `wrangler dev` or `wrangler deploy`, never in the deployed Worker. Cloudflare doesn't ship esbuild or miniflare to the edge; the production runtime is V8 isolates and isn't affected by these CVEs.

That said, the fix is also the right thing to do anyway: pin Wrangler to `^4.95.0` or later, blow away the lockfile and `node_modules`, and reinstall:

```sh
rm -rf node_modules package-lock.json
npm install
npm audit
```

You should see "found 0 vulnerabilities."

### `wrangler deploy` fails with "Authentication error"

Your `wrangler login` session may have expired or never completed. Re-run `npx wrangler login` and confirm with `npx wrangler whoami`. If `whoami` still fails, delete `~/.config/.wrangler/config/default.toml` (or the equivalent on Windows) and start over.

### `wrangler dev` can't find R2 or D1

`wrangler dev` defaults to a *local* shadow of R2 and D1 (managed by Miniflare). On first run those shadows are empty regardless of what's in your real Cloudflare account. Apply your migrations locally:

```sh
npx wrangler d1 migrations apply agent-web-host-meta --local
```

To run against the real cloud R2/D1, pass `--remote`:

```sh
npx wrangler dev --remote
```

Use this sparingly — every request hits real R2/D1 and counts toward your quotas.

### `Could not find bucket` or `Could not find database` on deploy

Most often a name mismatch between `wrangler.toml` and the dashboard. The `bucket_name` in `[[r2_buckets]]` must match the bucket name in R2 exactly; the `database_id` in `[[d1_databases]]` must match the UUID shown in the D1 database header. Names are case-sensitive.

### Custom domain instead of `workers.dev`

When you're ready to graduate from `*.workers.dev` to your own subdomain, you have two paths:

- **Move the whole zone to Cloudflare.** Add your domain at **Domains → Add a domain**, get the two assigned nameservers, update them at your current registrar. Cloudflare becomes authoritative for the zone; you bind the Worker to a route at **Workers & Pages → your-worker → Settings → Triggers → Add Custom Domain**.
- **Cloudflare for SaaS / custom hostnames.** Keep your existing registrar authoritative; point one subdomain at Cloudflare via a CNAME. More fiddly; mainly useful when you can't or won't move the zone.

For most personal projects the first path is the right one. The `wrangler.toml` change is just `workers_dev = false` plus a `[[routes]]` entry — no code change required.
