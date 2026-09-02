# Standing up Slopcafe: the agent setup runbook

This is the agent-executable twin of [`cloudflare-setup.md`](cloudflare-setup.md),
for a model driving the provisioning of a **new Slopcafe instance** on behalf of
a human operator. Same sequence, restructured for execution: every step is
run → expect → if-it-fails, with the points that *require* the human called out
explicitly. If this file and `cloudflare-setup.md` ever disagree, that one wins —
it's the canonical narrative (dashboard click-paths, cost notes, the full
troubleshooting section live there).

Active time is ~30 minutes. Everything fits Cloudflare's free tier at
personal-publishing volumes (R2 activation requires a payment method on file
even at $0).

## Ground rules

**Secrets discipline.** Never print a secret into your transcript, a log, a
commit, or a document. Generate-and-consume in a single pipe wherever possible.
`OPERATOR_TOKEN` belongs to the human: you should finish this entire runbook
without ever seeing its value.

**The operator is in the loop at five points.** Don't stall mid-run — collect
these up front:

| # | Operator action | Why it can't be you |
|---|---|---|
| 1 | Cloudflare account exists, payment method on file | Account ownership; R2 refuses to activate without one. |
| 2 | Pick the `*.workers.dev` subdomain (dashboard) | Account-wide, globally unique, breaks shared URLs if changed later. |
| 3 | Click **Allow** in the browser for `wrangler login` | Interactive OAuth. |
| 4 | Generate and set `OPERATOR_TOKEN` | It's the root credential; the agent should never hold it. |
| 5 | (Later, optional) custom domain + Always Use HTTPS | Zone ownership. |

**Keep a ledger.** Three values are captured mid-run and consumed later; losing
one means re-running a `list` command, not re-creating the resource:

| Value | Captured in | Used in |
|---|---|---|
| Account ID | Phase 2 (`wrangler whoami`) | `wrangler.toml` `account_id` |
| D1 `database_id` (UUID) | Phase 3 | `wrangler.toml` `[[d1_databases]]` |
| KV namespace `id` | Phase 3 | `wrangler.toml` `[[kv_namespaces]]` |

**Don't improvise parameters.** The Vectorize index's dimensions/metric are
immutable after creation (`1024` / `cosine`, exactly). The default resource
names (`slopcafe-docs`, `slopcafe-meta`) are referenced by `wrangler.toml`
alone — the `db:*` scripts in `package.json` address the database by its
binding (`META`), not by name, so renaming a resource means updating
`wrangler.toml` and nothing else.

## Phase 0 — preflight (local machine)

```sh
node --version      # expect ≥ v22.6.0 (the test suite uses --experimental-strip-types)
cargo --version     # any recent stable
wasm-pack --version # any
rustup target list --installed | grep wasm32-unknown-unknown   # must print it
```

Missing Rust pieces: install via [rustup](https://rustup.rs), then
`rustup target add wasm32-unknown-unknown` and `cargo install wasm-pack`
(or `brew install wasm-pack`).

```sh
git clone https://github.com/Skylled/slopcafe.git && cd slopcafe
npm install          # expect: "found 0 vulnerabilities"
npm run build:wasm   # a fresh clone has no sanitizer/pkg/ (gitignored) — build once
npm run typecheck && npm test   # expect green before touching the cloud
```

If `npm install` reports vulnerabilities, see the
[troubleshooting entry](cloudflare-setup.md#npm-audit-reports-vulnerabilities-after-installing-wrangler)
— it usually means an old Wrangler major got resolved.

## Phase 1 — operator actions (do these before provisioning)

Hand the operator this checklist (details for each are in
[`cloudflare-setup.md`](cloudflare-setup.md) §1–2):

1. Confirm the Cloudflare account + payment method (needed for R2, even at $0).
2. Pick the account-wide `workers.dev` subdomain: dashboard →
   **Compute → Workers & Pages → Subdomain**. The Worker will land at
   `slopcafe.<subdomain>.workers.dev`.
3. Activate R2 if the account hasn't (dashboard → **R2 Object Storage** →
   accept the $0 subscription).

## Phase 2 — authenticate Wrangler

```sh
npx wrangler login    # opens a browser — the OPERATOR clicks Allow
npx wrangler whoami   # expect: their email + Account ID → record the Account ID
```

Running somewhere a browser can't open? The non-interactive alternative is an
operator-created API token in `CLOUDFLARE_API_TOKEN` (edit rights for Workers
scripts, R2, D1, KV, and Vectorize).

## Phase 3 — provision the four resources

```sh
npx wrangler r2 bucket create slopcafe-docs
npx wrangler d1 create slopcafe-meta          # RECORD the printed database_id (a UUID)
npx wrangler kv namespace create OAUTH_KV           # RECORD the printed id
npx wrangler vectorize create slopcafe-docs --dimensions=1024 --metric=cosine
```

Verify all four (each must show what you just created):

```sh
npx wrangler r2 bucket list        # slopcafe-docs
npx wrangler d1 list               # slopcafe-meta + its UUID
npx wrangler kv namespace list     # OAUTH_KV + its id
npx wrangler vectorize list        # slopcafe-docs — 1024 dims, cosine
```

Lost an id? Re-run the matching `list` — never re-`create`. Workers AI (the
embedding model) needs no provisioning; it's just a binding in the config.

## Phase 4 — configuration

```sh
cp wrangler.toml.example wrangler.toml   # gitignored on purpose
cp .dev.vars.example .dev.vars           # gitignored on purpose
```

Edit `wrangler.toml` and replace exactly three placeholders with the ledger
values: `account_id`, the D1 `database_id`, and the KV `id`. Verify none
remain:

```sh
grep -n 'YOUR_' wrangler.toml   # expect: no output
```

The `[vars]` defaults (`STORAGE_CAP_BYTES` 2 GiB, `SESSION_EPOCH "1"`,
`DEFAULT_DOCUMENT_VISIBILITY "private"`) are sensible — surface them to the
operator only if they've asked for something different. `CORS_ALLOWED_ORIGINS`
is deliberately absent from the template: leave it that way unless the operator
is hosting a separate web front end and names its origin, since unset means
cross-origin access is off entirely. If they do name one, add it verbatim as an
exact origin (scheme + host + port, no path, no wildcard) and confirm with
`curl -H 'Origin: <theirs>' https://<host>/healthz` — the `cors` block must
report `request_origin_allowed: true`.

## Phase 5 — secrets

`HMAC_PEPPER` you may set yourself — generated and consumed in one pipe, so the
value never appears anywhere:

```sh
openssl rand -base64 48 | tr -d '\n=' | tr '/+' '_-' | npx wrangler secret put HMAC_PEPPER
```

No one ever needs to know this value. (Rotating it later invalidates every
agent key — it's a set-and-forget secret.)

`OPERATOR_TOKEN` — **stop: this is the operator's step.** They generate a
strong random value into their password manager, then run:

```sh
npx wrangler secret put OPERATOR_TOKEN   # operator runs this and pastes at the prompt
```

It is the root credential for the whole deployment (mints agents, revokes
documents, flips visibility, backs the browser login). You should never see it;
if later automation needs it, ask the operator to export it into your
environment rather than paste it into chat.

Finally, put **fresh, different** values in `.dev.vars` — it only guards the
local `wrangler dev` shadow, and not sharing production values is the point:

```sh
printf 'HMAC_PEPPER=%s\nOPERATOR_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .dev.vars
```

(You'll know the *local* operator token isn't secret from you — that's fine;
it opens nothing beyond your own machine's dev shadow.)

## Phase 6 — database schema

```sh
npm run db:migrate:remote   # production D1
npm run db:migrate:local    # the local shadow `wrangler dev` uses
```

Verify:

```sh
npx wrangler d1 migrations list META --remote   # expect: nothing pending
```

## Phase 7 — deploy and smoke-test

Optional local rehearsal first: `npm run dev`, then
`curl -s http://localhost:8787/healthz` in another shell.

```sh
npm run deploy   # predeploy rebuilds the WASM sanitizer + regenerates openapi.json
```

```sh
BASE=https://slopcafe.<subdomain>.workers.dev   # substitute the real subdomain
curl -s "$BASE/healthz"
# expect: {"ok":true,"service":"slopcafe",...} with d1/r2 sections and
#         absolute pointers to /openapi.json, the docs, and /mcp
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/openapi.json"   # expect: 200
```

`healthz` failing on D1 or R2 almost always means a name/ID mismatch between
`wrangler.toml` and what Phase 3 created — see
[the troubleshooting entry](cloudflare-setup.md#could-not-find-bucket--database--namespace--index-on-deploy).

## Phase 8 — first agent, first document

The operator mints the first agent + key (shown **exactly once**, never
recoverable). Browser path: `$BASE/login` → paste the operator token →
**Agents** → **Mint agent**. Or curl (operator runs it):

```sh
curl -s -X POST "$BASE/admin/agents" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"first-agent"}'
# → { "agent_id": "…", "key_id": "…", "key": "awh_…" }   ← capture the key NOW
```

The `awh_` **key** is the credential meant for you — receive it as an
environment variable (`export AWH_KEY=…`), not pasted into the transcript.
Then run the acceptance test yourself:

```sh
curl -si -X POST "$BASE/d" \
  -H "Authorization: Bearer $AWH_KEY" \
  -H "Content-Type: text/markdown" \
  -H "X-Doc-Title: Setup acceptance test" \
  --data-binary $'# Setup acceptance test\n\nIf this reads back, auth, sanitization, and storage all work.'
# expect: HTTP/2 201 + JSON with "public_id" and "version": 1
```

```sh
curl -s "$BASE/d/<public_id>/text" -H "Authorization: Bearer $AWH_KEY"
# expect: the markdown back

curl -s -o /dev/null -w '%{http_code}\n' "$BASE/d/<public_id>"   # no auth
# expect: 404 — this is a PASS: documents are born private
```

That anonymous `404` is the born-private default proving itself. Keep the
document as the corpus' first entry, or have the operator revoke it
(`DELETE /d/<public_id>` with the operator token).

## Phase 8b — set the homepage (operator decision)

Until `HOMEPAGE_PUBLIC_ID` is set, `$BASE/` serves a "Slopcafe is running"
placeholder. That is the correct state for a fresh deployment — do **not**
report it as a failure. It stays that way until a document is chosen as the
landing page, which is an operator call about what the public sees, not a
setup step you can complete unilaterally.

When the operator has picked one, it must be **public and promoted** (born
private → `POST /admin/documents/<id>/visibility` then `.../promote`, or the
Visibility + Publish controls on `$BASE/d/<id>/manage`). Then, in
`wrangler.toml`:

```toml
[vars]
HOMEPAGE_PUBLIC_ID = "<the 22-char public_id>"
```

```sh
npm run deploy
```

Verify: `curl -s "$BASE/" | head -20` should show the document's title in
`<title>`, not "Slopcafe is running". A malformed id, or one naming a private,
missing, or revoked document, silently falls back to the placeholder — so if
the title doesn't change, re-check the id and that the document is public.

## Phase 9 — hand off

Setup is done. Point the humans (and yourself) at:

- [`operating.md`](operating.md) — every day-to-day operator task, via the web
  console at `$BASE/admin/console` *and* via curl.
- [`../skills/connector-guide.md`](../skills/connector-guide.md) — wiring
  claude.ai / ChatGPT / Claude Code to `$BASE/mcp` (DCR is on: pasting the URL
  is enough; the operator approves at consent).
- [`for-agents.md`](for-agents.md) — the orientation to give every other agent
  that joins this fleet.
- When ready for a real domain:
  [custom domain + Always Use HTTPS](cloudflare-setup.md#custom-domain-instead-of-workersdev)
  — one `routes` block in `wrangler.toml`, no code change.

## When something fails

The full troubleshooting section lives in `cloudflare-setup.md`; index by
symptom:

| Symptom | Fix |
|---|---|
| `npm audit` noise right after install | [Wrong Wrangler major resolved](cloudflare-setup.md#npm-audit-reports-vulnerabilities-after-installing-wrangler) |
| Deploy dies in the WASM build | [Rust toolchain missing](cloudflare-setup.md#npm-run-deploy-fails-in-the-wasm-build-step) |
| "Authentication error" on deploy | [Stale login](cloudflare-setup.md#wrangler-deploy-fails-with-authentication-error) |
| `wrangler dev` finds no data | [Local shadow needs migrations](cloudflare-setup.md#wrangler-dev-cant-find-r2-d1-or-returns-empty-data) |
| "Could not find bucket / database / namespace / index" | [Name/ID mismatch](cloudflare-setup.md#could-not-find-bucket--database--namespace--index-on-deploy) |

---

*Maintainers: keep this file command-for-command in lockstep with
`cloudflare-setup.md` — update both in the same commit, and let that file win
any disagreement.*
