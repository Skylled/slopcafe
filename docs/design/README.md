# Design notes & specs

The rationale layer behind Slopcafe: the conceptual specs, the
design notes that argued each feature into existence, and a few frozen/aspirational
blueprints. These are **not** the wire contract — for that, read
[`../http-api.md`](../http-api.md) and the generated [`../../openapi.json`](../../openapi.json).
For *what's coming next* (with forward links into these notes), read
[`../feature-roadmap.md`](../feature-roadmap.md), the roadmap hub.

Each note is **bundled into the Worker at build time** and served at the
`/docs/<name>` route in the right-hand column — so it describes the build serving
it, on any deployment, with nothing to publish
([issue #4](https://github.com/Skylled/slopcafe/issues/4)). The bundler
([`scripts/build-docs.mjs`](../../scripts/build-docs.mjs)) rewrites these repo
`.md` links to their `/docs/<name>` form at build time (links to other repo files
become GitHub source URLs). The repo keeps the relative `.md` links for offline
reading.

## Conceptual specs

| Doc | What it is | Route |
|---|---|---|
| [`agent-knowledge-host-spec-SOLO-v1.md`](agent-knowledge-host-spec-SOLO-v1.md) | The single-operator conceptual spec — principals/auth, the `public_id`/`slug` model, the capability-URL boundary, sanitize-and-serve, write semantics, deliberate v1 omissions. Mixes as-built and deferred. | `/docs/spec-solo` |
| [`agent-knowledge-host-spec-PLATFORM-v2.md`](agent-knowledge-host-spec-PLATFORM-v2.md) | The **frozen** multi-tenant "if this becomes a service" blueprint the SOLO spec forked from. Reference/lineage only. | `/docs/spec-platform` |

## Design notes — built

| Doc | What it argued for | Status | Route |
|---|---|---|---|
| [`action-plan-v1.md`](action-plan-v1.md) | The original design rationale: the two security layers (which one is load-bearing), why everything collapses into one Worker, the v1 non-goals. | Foundational | `/docs/action-plan-v1` |
| [`vector-search-design.md`](vector-search-design.md) | Chunked semantic search via Vectorize + Workers AI, hybrid with FTS5/BM25 via Reciprocal Rank Fusion. | Built (phases 1–3) | `/docs/vector-search-design` |
| [`source-retention-design.md`](source-retention-design.md) | Retain the submitted source `S` alongside the sanitized render; edit-on-source; source-read surfaces. | Built (Case A) | `/docs/source-retention-design` |
| [`api-contract-design.md`](api-contract-design.md) | Make `src/contract.ts` (Zod) the single source of truth and generate an OpenAPI 3.1 spec from it. | Built (phases 1–2) | `/docs/api-contract-design` |
| [`api-contract-phase2-routes.md`](api-contract-phase2-routes.md) | The verified route table backing the OpenAPI assembler + its freshness gate. | Built (companion) | `/docs/api-contract-phase2-routes` |
| [`byte-exact-publish-design.md`](byte-exact-publish-design.md) | Byte-exact large-document publishing (the `curl --data-binary` + `X-Content-SHA256` path) vs the alternatives. | Built | `/docs/byte-exact-publish-design` |
| [`dcr-design.md`](dcr-design.md) | Dynamic client registration — the paste-the-URL connect flow for OAuth clients. | Built | `/docs/dcr-design` |
| [`context-packs-design.md`](context-packs-design.md) | Bulk-read-under-budget "packs," the lifecycle/status axis, and config-as-document curation. | Built (all three phases) | `/docs/context-packs-design` |
| [`backlinks-design.md`](backlinks-design.md) | The document link graph (wiki-style backlinks, issue #40): write-time extraction, late-binding resolution, backlinks/orphans/broken-link surfaces. | Built | `/docs/backlinks-design` |
| [`style-support-design.md`](style-support-design.md) | Allow `<style>` blocks through the sanitizer — class-driven theming, `:hover`/`@media`/`@keyframes`/`prefers-color-scheme`, data: `@font-face`. Verbatim CSS passthrough; safety owned by the render CSP+sandbox. | Built (v1.4) | `/docs/style-support-design` |
| [`mcp-apps-design.md`](mcp-apps-design.md) | MCP Apps (SEP-1865): the `view_document` tool + `ui://` viewer template, so documents render as inline interactive views in Apps-capable hosts (Claude web/desktop, ChatGPT); non-Apps hosts degrade to plain JSON. | Built (mcp-2026-07-28 branch) | `/docs/mcp-apps-design` |

## Design notes — proposed / deferred

| Doc | What it argues for | Status | Route |
|---|---|---|---|
| [`librarian-design.md`](librarian-design.md) | A curation agent that classifies docs against a controlled tag vocabulary. | Partially shipped (data model built; classifier pending) | `/docs/librarian-design` |
| [`content-domain-design.md`](content-domain-design.md) | Serve document bytes from a separate content domain so scripted (JS) documents become possible. | Deferred — post-V1 | `/docs/content-domain-design` |

> **Keeping these honest.** Per `CLAUDE.md`, a code change that builds something a
> note filed as *deferred*, or that moves the model a spec describes, must update the
> matching note in the same commit. There is no separate copy to re-publish: the
> deployed page is built from the file you just edited.
