# Design notes & specs

The rationale layer behind Slopcafe (`agent-web-host`): the conceptual specs, the
design notes that argued each feature into existence, and a few frozen/aspirational
blueprints. These are **not** the wire contract — for that, read
[`../http-api.md`](../http-api.md) and the generated [`../../openapi.json`](../../openapi.json).
For *what's coming next* (with forward links into these notes), read
[`../feature-roadmap.md`](../feature-roadmap.md), the roadmap hub.

Each note is mirrored on Slopcafe under the `slopcafe-<name>` slug in the right-hand
column — its canonical address in the on-platform doc web (born **private**; the
corpus goes public at launch). The mirror is kept in sync by the republish recipe
([`scripts/doc-web.mjs`](../../scripts/doc-web.mjs), [issue #27](https://github.com/Skylled/slopcafe/issues/27)),
which rewrites these repo `.md` links to `/s/<slug>` at publish time (other repo-file
links become GitHub source URLs). The repo keeps the relative `.md` links for offline
reading.

## Conceptual specs

| Doc | What it is | Canonical slug |
|---|---|---|
| [`agent-knowledge-host-spec-SOLO-v1.md`](agent-knowledge-host-spec-SOLO-v1.md) | The single-operator conceptual spec — principals/auth, the `public_id`/`slug` model, the capability-URL boundary, sanitize-and-serve, write semantics, deliberate v1 omissions. Mixes as-built and deferred. | `slopcafe-spec-solo` |
| [`agent-knowledge-host-spec-PLATFORM-v2.md`](agent-knowledge-host-spec-PLATFORM-v2.md) | The **frozen** multi-tenant "if this becomes a service" blueprint the SOLO spec forked from. Reference/lineage only. | `slopcafe-spec-platform` |

## Design notes — built

| Doc | What it argued for | Status | Canonical slug |
|---|---|---|---|
| [`action-plan-v1.md`](action-plan-v1.md) | The original design rationale: the two security layers (which one is load-bearing), why everything collapses into one Worker, the v1 non-goals. | Foundational | `slopcafe-action-plan-v1` |
| [`vector-search-design.md`](vector-search-design.md) | Chunked semantic search via Vectorize + Workers AI, hybrid with FTS5/BM25 via Reciprocal Rank Fusion. | Built (phases 1–3) | `slopcafe-vector-search-design` |
| [`source-retention-design.md`](source-retention-design.md) | Retain the submitted source `S` alongside the sanitized render; edit-on-source; source-read surfaces. | Built (Case A) | `slopcafe-source-retention-design` |
| [`api-contract-design.md`](api-contract-design.md) | Make `src/contract.ts` (Zod) the single source of truth and generate an OpenAPI 3.1 spec from it. | Built (phases 1–2) | `slopcafe-api-contract-design` |
| [`api-contract-phase2-routes.md`](api-contract-phase2-routes.md) | The verified route table backing the OpenAPI assembler + its freshness gate. | Built (companion) | `slopcafe-api-contract-phase2-routes` |
| [`byte-exact-publish-design.md`](byte-exact-publish-design.md) | Byte-exact large-document publishing (the `curl --data-binary` + `X-Content-SHA256` path) vs the alternatives. | Built | `slopcafe-byte-exact-publish-design` |
| [`dcr-design.md`](dcr-design.md) | Dynamic client registration — the paste-the-URL connect flow for OAuth clients. | Built | `slopcafe-dcr-design` |
| [`context-packs-design.md`](context-packs-design.md) | Bulk-read-under-budget "packs," the lifecycle/status axis, and config-as-document curation. | Built (all three phases) | `slopcafe-context-packs-design` |
| [`backlinks-design.md`](backlinks-design.md) | The document link graph (wiki-style backlinks, issue #40): write-time extraction, late-binding resolution, backlinks/orphans/broken-link surfaces. | Built | `slopcafe-backlinks-design` |
| [`style-support-design.md`](style-support-design.md) | Allow `<style>` blocks through the sanitizer — class-driven theming, `:hover`/`@media`/`@keyframes`/`prefers-color-scheme`, data: `@font-face`. Verbatim CSS passthrough; safety owned by the render CSP+sandbox. | Built (v1.4) | `slopcafe-style-support-design` |

## Design notes — proposed / deferred

| Doc | What it argues for | Status | Canonical slug |
|---|---|---|---|
| [`librarian-design.md`](librarian-design.md) | A curation agent that classifies docs against a controlled tag vocabulary. | Partially shipped (data model built; classifier pending) | `slopcafe-librarian-design` |
| [`content-domain-design.md`](content-domain-design.md) | Serve document bytes from a separate content domain so scripted (JS) documents become possible. | Deferred — post-V1 | `slopcafe-content-domain-design` |

> **Keeping these honest.** Per `CLAUDE.md`, a code change that builds something a
> note filed as *deferred*, or that moves the model a spec describes, must update the
> matching note in the same commit — and re-publish the live Slopcafe mirror.
