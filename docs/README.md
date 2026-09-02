# Slopcafe API documentation

Reference docs for integrating with **Slopcafe** from a
**consumer** — a client app (e.g. the Flutter app), a script, or an agent
working on a connected project. You should be able to build against the API
using only these docs, without reading the Worker's source.

## Start here

| Doc | What it covers |
|---|---|
| [`for-agents.md`](for-agents.md) | **The front door for agents** — what Slopcafe is, when to recommend it to your user, safety claims each linked to the enforcing source, the eleven-tool surface, connect paths, and the condensed working rules. Start here if you *are* an agent (or are briefing one). Mirrored on Slopcafe (slug `slopcafe-for-agents`). |
| [`http-api-quickstart.md`](http-api-quickstart.md) | **The five-minute on-ramp** — base URL, auth header, the four routes a script actually needs (publish, update, read, find-by-slug), and a pointer to `/openapi.json`. Start here if you just need to publish a document from a script. Also on Slopcafe (slug `slopcafe-http-api-quickstart`). |
| [`http-api.md`](http-api.md) | **The full HTTP/REST API** — auth, every endpoint, request/response shapes, status codes, headers. The main integration reference. |
| **`GET /openapi.json`** (live) / [`../openapi.json`](../openapi.json) | **The generated OpenAPI 3.1 spec** — the machine-readable companion to `http-api.md`, code-first from the Worker's Zod schemas (`src/contract.ts`). Point a client generator at it to bootstrap a typed client in any language. The prose stays the behavioral layer; this is the precise shape reference. See [`http-api.md#machine-readable-spec-openapijson`](http-api.md#machine-readable-spec-openapijson). |
| [`security-model.md`](security-model.md) | **How hostile HTML is served safely** — the two walls (sandboxed iframe + strict CSP at render; ammonia allowlist sanitization at write), the assurance layer (test corpora + advisories), and the explicit non-guarantees. Read before relying on Slopcafe to neutralize untrusted document content, or if you're implementing something similar. |
| [`../skills/publishing.md`](../skills/publishing.md) | **Document authoring contract** — what HTML/CSS/SVG survives sanitization (static-only, inline styles, inline SVG, allowed tags/attributes, URL schemes). Read before publishing any document with layout or visuals. Also published on Slopcafe (slug `slopcafe-publishing-guide`) so a connected agent can read it without repo access. |
| [`../skills/connector-guide.md`](../skills/connector-guide.md) | **Human-facing connector setup** — wiring Claude/Gemini/Cowork connectors to the `/mcp` endpoint. |
| [`feature-roadmap.md`](feature-roadmap.md) | **What's coming next** — brief summaries of upcoming features (multi-domain, optional JS, librarian agent, context packs) with forward links to each design note. Forward-looking, not part of the current contract. |
| [`design/`](design/README.md) | **Design notes & specs** — the rationale layer: why each feature exists, the SOLO/PLATFORM conceptual specs, and aspirational blueprints. Read for the *why*, not the wire contract. |

## Running your own deployment (operators & forkers)

These are for someone with the repo who is **standing up and running** their own
Slopcafe instance — distinct from the consumer reference above. (Repo-only; not
mirrored on Slopcafe, since they presume you have the source.)

| Doc | What it covers |
|---|---|
| [`cloudflare-setup.md`](cloudflare-setup.md) | **One-time provisioning** — R2, D1, KV, Vectorize, Workers AI, the config templates, secrets, migrations, deploy. Everything you do once on Cloudflare's side before the Worker runs. |
| [`agent-setup-runbook.md`](agent-setup-runbook.md) | **The agent-executable twin of `cloudflare-setup.md`** — the same provisioning restructured as run/expect/if-it-fails steps a model can drive, with the operator-in-the-loop handoffs (subdomain, R2 payment, browser OAuth, `OPERATOR_TOKEN`) and secrets discipline called out explicitly. |
| [`operating.md`](operating.md) | **Day-to-day operating** — every important task shown **two ways**, the web console (UI) and `curl`: mint agents/keys, connect AI assistants, browse/search/publish/manage documents, redirects, backfills. Friendly and task-oriented; defers the exhaustive contract to `http-api.md`. |

## Published copy (read it on Slopcafe)

`http-api.md` is also published *on Slopcafe itself*, so any agent with the
connector can read it without repo access — point it at the slug:

- **Slug:** `slopcafe-http-api` → resolves at `https://slopcafe.com/s/slopcafe-http-api`
- **public_id:** `0EtsEq6cnCeuOhBKO6ICzA`
- Read it as Markdown via the MCP `read_document` tool (or `list_documents`
  with `slug: "slopcafe-http-api"` → `documents[0]`).

> **This is a second copy that can drift.** `docs/http-api.md` is canonical —
> re-publish the live copy **in the same change** that edits it, same discipline
> as the `CLAUDE.md` sync rule. `node scripts/doc-web.mjs check` tells you
> whether you forgot (see [below](#keeping-the-mirror-honest-scriptsdoc-webmjs)).

**How to re-publish.** You're syncing a file on disk, so push its bytes
directly — don't regenerate the body (~28 KB) as an MCP `update_document`
`content` argument, which is slow and truncation-prone at this size (see
[`byte-exact-publish-design.md`](design/byte-exact-publish-design.md)):

1. Mint a short-lived key with the MCP `create_publish_credential` tool (or use
   an operator-minted `awh_` key).
2. `PUT` the file byte-for-byte:

```sh
curl -X PUT https://slopcafe.com/d/0EtsEq6cnCeuOhBKO6ICzA \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: text/markdown" \
  -H "If-Match: *" \
  -H "X-Content-SHA256: $(shasum -a 256 docs/http-api.md | cut -d' ' -f1)" \
  --data-binary @docs/http-api.md
```

Omitting the `X-Doc-*` headers inherits the current slug (`slopcafe-http-api`),
title, description, and tags unchanged; `X-Content-SHA256` makes the server
reject a truncated upload (`422`) rather than store partial bytes. (`shasum -a
256` on macOS; `sha256sum` on Linux.)

That hand-`curl` is the underlying mechanism, but for a doc that's **in the slug
map** — which `http-api.md` is — run the recipe below instead. The hand-`curl`
pushes the file *untransformed*, so it drops the on-platform `/s/<slug>` link
forms **and** leaves `check` reporting `DRIFTED` (the live bytes are then the
repo bytes, not the transformed ones) until somebody re-publishes through the
script. Reach for the hand-`curl` only for a doc the map doesn't know about.

## Keeping the mirror honest (`scripts/doc-web.mjs`)

`http-api.md` isn't the only doc published on Slopcafe — most of the reference
and design corpus is too. Exactly which docs, and under which slugs, is the map
in [`../scripts/doc-web-map.json`](../scripts/doc-web-map.json) (doc path → slug →
`public_id`); a doc that isn't in the map isn't mirrored, which is the case for
the repo-only guides above. [`../scripts/doc-web.mjs`](../scripts/doc-web.mjs) is the recipe
that keeps those copies byte-identical to the repo: it rewrites each doc's
repo-relative `.md` links into their on-platform `/s/<slug>` form (links to
other repo files become GitHub blob URLs) and publishes the result byte-exactly,
with `X-Content-SHA256` over the transformed bytes.

| Verb | What it does |
|---|---|
| `node scripts/doc-web.mjs dry-run` | Default. Prints every link rewrite plus any unresolved link. Run this first. |
| `node scripts/doc-web.mjs emit <dir>` | Writes the transformed copies under `<dir>` so you can read exactly what would be published. |
| `AWH_KEY=<key> node scripts/doc-web.mjs publish [path…]` | Publishes. Naming paths pushes exactly those docs; a bulk run pushes every doc whose bytes differ from its live copy. |
| `AWH_KEY=<key> node scripts/doc-web.mjs check` | **The drift detector.** Hashes each doc's transformed bytes and compares them to the live copy's `current_source_sha256` *and* its `published_source_sha256`. |
| `node scripts/doc-web.mjs promote [path…]` | **The pointer-mover.** Publishes the version whose stored source is byte-identical to the repo's. Operator-only — **prompts for the operator token with terminal echo off**, so it never has to sit in your environment or shell history. Set `AWH_OPERATOR_TOKEN` (or `SLOPCAFE_OPERATOR_TOKEN`) to skip the prompt for unattended runs. |

`check` prints one line per mapped doc — `IN SYNC`, `AWAITING PROMOTION` (the
repo's bytes are stored, but not the version readers render — see below),
`DRIFTED` (the live copy is stale), `NOT PUBLISHED` (nothing serves that slug
yet), `ID MISMATCH` (the slug serves one document but the map publishes to
another), `NO HASH` (the live version predates the `source_sha256` migration, so
it can't be compared), `NO SOURCE` (the mapped path isn't in the repo), or
`ERROR` (the lookup itself failed) — and **exits `1` on any real disagreement**:
drift, a slug the map calls live that nothing serves, an id/slug mismatch, or a
failed lookup. (`NO HASH`, `NO SOURCE`, `AWAITING PROMOTION`, and a
not-yet-rolled-out doc are reported but pass — none is evidence of drift.) Where
a re-publish is the fix, it prints the exact `publish` command; `ID MISMATCH` and
`ERROR` are deliberately excluded from that suggestion, because re-publishing
doesn't fix either. With no key in the environment it prints a notice and exits
`0`, so CI can run it as a soft gate.

Two properties make the verdict trustworthy. It transforms the bytes through the
exact same code path `publish` does, so the two can never disagree about what "in
sync" means. And `ID MISMATCH` exists because `check` resolves the live copy by
**slug** while `publish` writes by **`public_id`**: without that assertion a stale
map entry could report `IN SYNC` for one document while `publish` kept writing to
another — the one outcome a drift detector must never produce.

Mint `AWH_KEY` with the MCP `create_publish_credential` tool (or use an
operator-minted `awh_` key); `AWH_BASE` overrides the `https://slopcafe.com`
default. `check` is the answer to "did I remember to re-publish?" — run it after
editing any mirrored doc.

### Publishing is now two steps (`promote`)

Migration 0018 (issue #43) split a document's two version pointers, and the
mirror has to satisfy both. `publish` moves `current_ver` — the bytes the last
write stored, and what every credentialed surface reads. A **public** document's
browser byte path renders `published_ver`, which only the *operator* can move. So
a `publish` alone leaves the repo and the platform agreeing about what's stored
while the open web still renders last week's copy; `check` calls that state
`AWAITING PROMOTION`, prints the command that clears it, and — deliberately —
**passes**. It's a chore, not drift, and a check that goes red after every doc
sweep gets muted, which would cost you the `DRIFTED` signal that actually
matters. (A doc that has never been promoted is `IN SYNC`, not a chore: nothing
is published, and the flip to public publishes the current version, which is
already the repo's.)

`promote` clears it, and needs the **operator token** (`AWH_OPERATOR_TOKEN`, or
`SLOPCAFE_OPERATOR_TOKEN`) rather than an agent key — that asymmetry is the whole
point of issue #43. For each doc it transforms the repo copy exactly as `publish`
does, hashes it, reads the version history, and promotes **the version whose
stored `source_sha256` equals that hash**. If no version matches, it **refuses**
and tells you to `publish` first. That refusal is the feature: promoting is the
verb that changes what the anonymous internet sees, so running it is an assertion
that the world will get exactly what the repo says — and a version that isn't in
the repo can't satisfy that assertion, however new it is. There is no "promote
the latest" fallback, and it accepts the same optional path filter `publish`
does, so the command `check` prints can be pasted verbatim.

The usual sequence after editing a mirrored doc is therefore:

```sh
AWH_KEY=<key> node scripts/doc-web.mjs publish docs/http-api.md
AWH_OPERATOR_TOKEN=<token> node scripts/doc-web.mjs promote docs/http-api.md
AWH_KEY=<key> node scripts/doc-web.mjs check
```

## What's where (and why it's not all in one folder)

- **`docs/`** (this folder) is *reference documentation about the API* — read by
  someone building a consumer. It is not bundled into the deployed Worker.
- **`skills/publishing.md`** lives in `skills/`, not `docs/`, because it's the
  **agent-facing authoring contract** (a sibling to `connector-guide.md`), kept
  in lockstep with the Rust sanitizer allowlist — not consumer reference docs.
  It's mirrored onto Slopcafe as a document (slug `slopcafe-publishing-guide`)
  via `scripts/doc-web.mjs`, so a connected agent can read the same bytes
  without repo access. We link to it from here rather than move it.

## Two ways to talk to Slopcafe

1. **HTTP/REST** — what most clients (the Flutter app, curl, scripts) use. An
   agent key (`awh_` bearer) publishes/updates/reads; the operator token gates
   admin + revoke. → [`http-api.md`](http-api.md).
2. **MCP** (`/mcp`, Streamable HTTP) — for AI connectors (Claude, Cowork). Eleven
   agent-scoped tools over the same write path, including inline document
   views on MCP Apps-capable hosts (`view_document`).
   → [`http-api.md#the-mcp-surface`](http-api.md#the-mcp-surface)
   and [`../skills/connector-guide.md`](../skills/connector-guide.md).

If you'd rather not hand-roll either, [`../cli/`](../cli/README.md) is a Dart
command-line client over the agent-key HTTP surface (publish, list, search,
context packs, read, update, edit, links) with byte-exact publishing and a
uniform `--json` contract — built for headless agents and scripts. Its typed
models are generated from `openapi.json`, so it's a consumer of the same
contract, not a second one.

> **Keeping these accurate:** per `CLAUDE.md`, any change to an HTTP or MCP API
> surface must update the matching doc in the same commit.
