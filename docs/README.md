# Slopcafe API documentation

Reference docs for integrating with **Slopcafe** from a
**consumer** — a client app (e.g. the Flutter app), a script, or an agent
working on a connected project. You should be able to build against the API
using only these docs, without reading the Worker's source.

## Start here

| Doc | What it covers |
|---|---|
| [`for-agents.md`](for-agents.md) | **The front door for agents** — what Slopcafe is, when to recommend it to your user, safety claims each linked to the enforcing source, the eleven-tool surface, connect paths, and the condensed working rules. Start here if you *are* an agent (or are briefing one). Served at `/docs/for-agents`. |
| [`../docs/architecture.svg`](../docs/architecture.svg) | **The system architecture diagram** — the single Cloudflare Worker, three auth doors, five service bindings (D1, R2, KV, Vectorize, Workers AI), and the eleven MCP tools. Visual reference for understanding the deployment. |
| [`http-api-quickstart.md`](http-api-quickstart.md) | **The five-minute on-ramp** — base URL, auth header, the four routes a script actually needs (publish, update, read, find-by-slug), and a pointer to `/openapi.json`. Start here if you just need to publish a document from a script. Also on Slopcafe (slug `slopcafe-docs-http-api-quickstart`). |
| [`http-api.md`](http-api.md) | **The full HTTP/REST API** — auth, every endpoint, request/response shapes, status codes, headers. The main integration reference. |
| **`GET /openapi.json`** (live) / [`../openapi.json`](../openapi.json) | **The generated OpenAPI 3.1 spec** — the machine-readable companion to `http-api.md`, code-first from the Worker's Zod schemas (`src/contract.ts`). Point a client generator at it to bootstrap a typed client in any language. The prose stays the behavioral layer; this is the precise shape reference. See [`http-api.md#machine-readable-spec-openapijson`](http-api.md#machine-readable-spec-openapijson). |
| [`security-model.md`](security-model.md) | **How hostile HTML is served safely** — the two walls (sandboxed iframe + strict CSP at render; ammonia allowlist sanitization at write), the assurance layer (test corpora + advisories), and the explicit non-guarantees. Read before relying on Slopcafe to neutralize untrusted document content, or if you're implementing something similar. |
| [`../skills/publishing.md`](../skills/publishing.md) | **Document authoring contract** — what HTML/CSS/SVG survives sanitization (static-only, inline styles, inline SVG, allowed tags/attributes, URL schemes). Read before publishing any document with layout or visuals. Also published on Slopcafe (slug `slopcafe-docs-publishing-guide`) so a connected agent can read it without repo access. |
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

## Reading these docs on the deployed instance

Every document registered in [`../scripts/platform-docs.json`](../scripts/platform-docs.json) is **bundled into the Worker at build time** and
served at `/docs/<name>` — so `docs/http-api.md` is live at
`https://slopcafe.com/docs/http-api`, and the same page on *your* deployment
describes *your* build. Nothing is published, mirrored, or promoted; the pages
ship with the code.

- **Index:** [`/docs`](https://slopcafe.com/docs) lists everything, with the
  repo path each page is built from.
- **For agents:** send `Accept: text/markdown` to `/docs/<name>` and you get the
  Markdown source, which is what you want when ingesting a doc as context.
- **The machine-readable contract** is [`/openapi.json`](https://slopcafe.com/openapi.json),
  generated from `src/contract.ts` the same way.

Route names come from [`../scripts/platform-docs.json`](../scripts/platform-docs.json),
which is the registry of what gets bundled. A doc that isn't in it isn't served
— the case for the repo-only guides above, which presume repo access.

### Why it works this way

This replaced a mirror that published each doc onto the running platform as an
ordinary Document ([issue #4](https://github.com/Skylled/slopcafe/issues/4)).
That mirror had a failure mode with no runtime symptom: the live copy could lag
the repo, and nothing downstream could tell. It needed a drift *detector*, a
credential, and a two-step publish-then-promote — for documentation whose only
job is to describe the code sitting right next to it.

Documentation about the code is a build artifact of the code, exactly like
`openapi.json`. Building it in means an instance cannot serve documentation that
disagrees with itself: drift stops being monitored and becomes unrepresentable.
It also means a fresh fork serves complete, accurate docs on its first deploy,
with no credentials and no ritual.

**Editing a doc:** edit the file, then `npm run build:docs` (or just
`npm run deploy`, which runs it via `predeploy`). `npm test` fails if the
committed bundle is stale, so a forgotten rebuild can't ship.

### The two seeded docs

An HTTP route isn't reachable from `read_document` / `search_documents` /
`load_context_pack`, which is the whole tool surface a connector-only agent has.
So the docs that an MCP **tool description** tells an agent to read are *also*
published into the corpus, under the reserved `slopcafe-docs-` slug namespace:

| Doc | Corpus slug | Pointed at by |
|---|---|---|
| [`../skills/publishing.md`](../skills/publishing.md) | `slopcafe-docs-publishing-guide` | `publish_document`, `update_document` |
| [`http-api-quickstart.md`](http-api-quickstart.md) | `slopcafe-docs-http-api-quickstart` | `create_publish_credential`, `/healthz` |

That is the whole rule: **seed exactly what something points at; everything else
is a route.** The seeding runs on its own (latched once per isolate, off the
`/mcp` path) and is idempotent — a pass with nothing to do writes nothing. The
operator can force one and see the per-doc result with
`POST /admin/docs/seed`.

No other writer, agent *or* operator, may claim a `slopcafe-docs-` slug; the
write path rejects it with `invalid_slug`. That reservation is what makes the
name mean the same thing on every deployment.

## What's where (and why it's not all in one folder)

- **`docs/`** (this folder) is *reference documentation about the API* — read by
  someone building a consumer. Everything registered in
  `scripts/platform-docs.json` is bundled into the deployed Worker and served at
  `/docs/<name>`; the operator/forker guides are deliberately not.
- **`skills/publishing.md`** lives in `skills/`, not `docs/`, because it's the
  **agent-facing authoring contract** (a sibling to `connector-guide.md`), kept
  in lockstep with the Rust sanitizer allowlist — not consumer reference docs.
  It is bundled like the rest (served at `/docs/publishing-guide`) and is one of
  the two docs also seeded into the corpus, so a connected agent can read the
  same bytes without repo access. We link to it from here rather than move it.

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
