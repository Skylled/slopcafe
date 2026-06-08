# Slopcafe — Feature Roadmap

A short, living index of what's coming to **Slopcafe**: one brief summary per
upcoming feature, each with a forward link to its full design note. For the
*current* contract, see [`http-api.md`](http-api.md); this doc is about what's
*next*.

> **Note on links (read before publishing).** Every "Design" link below points to
> a Slopcafe slug (`/s/slopcafe-…`). All of these docs are being published
> on-platform with **public** visibility, so once each is live the slug link
> resolves in place. Until then the slug is **predicted** from the repo filename
> (`<name>.md` → `slopcafe-<name>`), and the repo path is given alongside so a
> reader (or the publishing agent) can map slug → file.
>
> **Publishing agent:** when you publish these, reconcile each link to the doc's
> **actual final slug** — fix any that were renamed at publish time, and update
> this roadmap (slug `slopcafe-feature-roadmap`) in the same pass so the index
> doesn't ship with dead links.

**Status legend:** **Proposed** (drafted, nothing built) · **Planned** (decided,
not started) · **Partially shipped** (groundwork built, headline feature pending)
· **Deferred** (decided, intentionally held to post-V1) · **Exploring** (shape
under discussion, no committed design).

---

## Upcoming features

### Multi-domain content serving

**Status:** Deferred — post-V1 · **Design:** [`slopcafe-content-domain-design`](/s/slopcafe-content-domain-design) (repo: [`content-domain-design.md`](design/content-domain-design.md))

Serve document bytes from a **separate registrable content domain** (e.g.
`slopcafecontent.com`) distinct from the `slopcafe.com` app origin, so a document
can never reach the app's cookies, session, or DOM. The mechanism is one Worker
bound to two custom domains with a hostname-dispatch branch, gated by a single
`CONTENT_ORIGIN` switch: **single-domain stays the default and changes nothing**;
two-domain is opt-in. On its own this is invisible to users — its purpose is to
be the security prerequisite for scripted documents (below), and the two ship
together in one push.

### Optional JavaScript documents

**Status:** Deferred — post-V1 (gated on multi-domain) · **Design:** [`slopcafe-content-domain-design`](/s/slopcafe-content-domain-design) (serving half; repo: [`content-domain-design.md`](design/content-domain-design.md)) + [issue #3](https://github.com/Skylled/slopcafe/issues/3) (authoring/sanitizer half)

Documents are static today (no scripts). This adds an **opt-in, per-document**
tier where a doc may run sandboxed JavaScript — but only on the isolated content
origin, with `allow-scripts` and **never** `allow-same-origin`, under
`connect-src 'none'`: the script gets interactivity over its own inert DOM and
nothing else (no app origin, no cookies, no network). **Private docs stay
scriptable, not forced public**, via a short-lived content-origin capability
token minted after an app-origin access check. The origin/serving layer is fully
designed in the content-domain note; the separate, larger piece — letting
`<script>` of a safe shape through the ammonia allowlist — is tracked as issue #3.

### Librarian agent

**Status:** Partially shipped (data model built; classifier agent pending) · **Design:** [`slopcafe-librarian-design`](/s/slopcafe-librarian-design) (repo: [`librarian-design.md`](design/librarian-design.md)) · vocabulary: [`slopcafe-tag-authority`](/s/slopcafe-tag-authority)

An agent that keeps the corpus organized by classifying documents against a
**controlled tag vocabulary**. The data-model groundwork is **already built** —
document-level tags (migration 0012), the lockstep core/wire changes, and the
operator tag-set endpoint. What remains is the headline feature: the closed-set
classifier agent itself, the published controlled-vocabulary document, and a
read-only audit pass as the cautious first step.

### Context packs

**Status:** Proposed (first draft, nothing built) · **Design:** [`slopcafe-context-packs-design`](/s/slopcafe-context-packs-design) (repo: [`context-packs-design.md`](design/context-packs-design.md))

A **bulk-read-under-budget** mechanism: assemble several documents into one
budget-bounded "pack" an agent can ingest in a single call, instead of N
round-trips. It bundles two supporting pieces — a **lifecycle/status** axis that
keeps stale documents out of automatic packs, and a **config-as-document**
curation surface (reusing the pattern the librarian vocabulary established).
Proposed and open for iteration; nothing is built yet.

---

## Also on the radar

Tracked by issue, design not yet committed (no design note to link yet):

| Feature | Status | Tracking |
|---|---|---|
| Operator/admin web console buildout | Partially shipped (in progress) | [issue #22](https://github.com/Skylled/slopcafe/issues/22) |
| Frontend/backend separation | Exploring | [issue #26](https://github.com/Skylled/slopcafe/issues/26) (relates to multi-domain) |
| Cross-instance connectivity | Exploring | [issue #14](https://github.com/Skylled/slopcafe/issues/14) |
| Periodic corpus backup | Planned | [issue #9](https://github.com/Skylled/slopcafe/issues/9) |
| Expired/revoked key cleanup | Planned | [issue #13](https://github.com/Skylled/slopcafe/issues/13) |

---

## Recently shipped (for orientation)

Not upcoming — listed so the roadmap situates against what's already live. These
design notes are published on-platform too:

- **Semantic / hybrid search** — [`slopcafe-vector-search-design`](/s/slopcafe-vector-search-design) (repo: [`vector-search-design.md`](design/vector-search-design.md))
- **Source retention + edit-on-source** — repo: [`source-retention-design.md`](design/source-retention-design.md)
- **Code-first API contract + OpenAPI** — repo: [`api-contract-design.md`](design/api-contract-design.md)
- **Dynamic client registration** (paste-the-URL connect flow) — repo: [`dcr-design.md`](design/dcr-design.md)
