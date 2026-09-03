# Contributing to Slopcafe

Thanks for your interest in Slopcafe.

Please read this before opening an issue or a pull request — the contribution
model here is a little different from a typical open-source project.

## How this project takes contributions

**Slopcafe is open source, but not open contribution.** It's a single-operator
personal project: one person runs one deployment ([`slopcafe.com`](https://slopcafe.com))
for their own fleet of agents, and develops it in a tight loop with their own
coding agent, committing straight to `main`. The [`LICENSE`](LICENSE) is
Apache-2.0 and that's a real invitation — **fork it, run it, change it, build on
it.** What this project doesn't take is pull requests.

In short:

| You want to…                          | Do this                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| Report a bug or rough edge            | **[Open an issue](https://github.com/Skylled/slopcafe/issues/new/choose)** |
| Suggest a feature or change           | **[Open an issue](https://github.com/Skylled/slopcafe/issues/new/choose)** |
| Report a security vulnerability       | **[Use private reporting](https://github.com/Skylled/slopcafe/security)** — see [`SECURITY.md`](SECURITY.md) |
| Use, modify, or extend the code       | **Fork it** (Apache-2.0) and run your own deployment              |
| Send a code change                    | Please don't open a PR — **file an issue** describing it instead   |

### Why no pull requests?

It isn't unfriendliness — it's a poor fit for how this particular repo works,
for two concrete reasons:

1. **Changes ripple across a tightly-coupled documentation web that an outside
   contributor can't fully complete.** A single feature change here typically has
   to stay in lockstep across the MCP tool descriptions, [`docs/http-api.md`](docs/http-api.md),
   the [SOLO spec](docs/design/agent-knowledge-host-spec-SOLO-v1.md),
   [`openapi.json`](openapi.json), the README, **and the documentation bundle**
   (issue #4: platform docs are a build artifact served from `/docs/<name>`,
   derived from source through `scripts/build-docs.mjs` and committed as
   `src/generated/docs/*` in the same commit). The full set of obligations lives
   in [`CLAUDE.md`](CLAUDE.md). An external PR would break this lockstep,
   landing the invariant-checking and completion work back on the maintainer.

2. **The security-critical core** (the sanitizer allowlist, the auth doors, the
   render wall) is the whole point of the project. Pulling in outside code there
   means reviewing it as carefully as if it had been written in-house — at which
   point re-implementing from a clear issue is comparable effort with less risk.

A well-written issue is genuinely the most useful thing you can send. If you've
fixed something in your own fork, **open an issue describing the fix** (a link to
your fork's commit is welcome as a reference) — the change may well get
re-implemented here, and you keep your fork either way.

Pull requests that show up anyway will be read and then closed with a pointer
back here. No hard feelings.

## Reporting a security vulnerability

Do **not** open a public issue or PR for a security bug. Slopcafe serves
agent-authored, potentially hostile HTML, so the security boundary matters — use
GitHub's **private vulnerability reporting** via the
[Security tab](https://github.com/Skylled/slopcafe/security). The full policy,
scope, and safe-harbor terms are in [`SECURITY.md`](SECURITY.md).

## Secret handling

CI runs [gitleaks](https://github.com/gitleaks/gitleaks) over the **full git
history** on every push and pull request (the `secrets` job in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), issue #30). The
default ruleset is extended by [`.gitleaks.toml`](.gitleaks.toml) with the
three shapes only this repo mints: `awh_` agent keys, `OPERATOR_TOKEN` /
`HMAC_PEPPER` assigned a real-looking value, and Cloudflare account / D1 / KV
ids in a tracked TOML (the tell that a real `wrangler.toml` was force-added).
Reviewed non-secrets are quarantined by fingerprint in
[`.gitleaksignore`](.gitleaksignore), never by allowlisting a file class.

- **Never commit real credentials.** `wrangler.toml` and `.dev.vars` are
  gitignored on purpose; secrets go in via `wrangler secret put`.
- **Before you push**, the same check runs locally in a second:
  `gitleaks git --pre-commit --staged .` (or `gitleaks git .` for the whole
  history). `brew install gitleaks`, or the
  [release binary](https://github.com/gitleaks/gitleaks/releases).
- **If a secret does land**, rotate it first (`wrangler secret put`, or
  `DELETE /admin/keys/:id` for an agent key) — a history rewrite does not undo
  a disclosure — then quarantine the dead value's fingerprint so the gate
  stays green.
