# Agent Knowledge Host — Single-Operator Fork (SOLO v1)

> **Lineage.** This is a deliberate fork of the multi-tenant platform spec (`agent-knowledge-host-spec-PLATFORM-v2.md`), descoped to a single operator with a public read surface. The platform spec is preserved unchanged as the blueprint for "if this ever becomes a service." This document is a **strict subset**: every mechanism here is either carried over identically or simplified, never divergent — so growing back toward the platform is additive, not a rewrite. Where a platform section was dropped, it is listed in §0 with the reason, so the lineage stays auditable.

## 0. What this is, and what was dropped

**The itch this actually serves.** My agents write reports and other HTML content I want to share externally with nothing more than a link, without the manual copy-into-Google-Drive-then-share dance. This is a personal tool with a public *read* surface — not a platform.

**Three actors, and only three:**
- **The operator** (me) — the sole owner. Full control: manage agents and keys, write, delete, revoke.
- **Agents** — authenticated by per-agent API key; can **read and write**. Per-agent keys exist specifically so a rogue or compromised agent can be contained (revoked) without disturbing the others.
- **Link-holders** — unauthenticated, **read-only**. The capability is *possession of the unguessable URL*. There is no login for readers.

**Dropped from the platform spec (with reason), so the descope is explicit:**
- **Multiple operators / the operator-access invariant / `can_access` matrix** — there is one operator; ownership is implicit. The entire access-control engine collapses to "mine" + "link-published."
- **Projects, share policies (`operator_only`/`writing_agent_only`/`all_*`/`explicit`), the polymorphic `shares` table** — no multi-principal sharing exists. A document is reachable by its unguessable URL or revoked. That is the whole access model.
- **The admin / Trust-&-Safety service (platform §12–§13): reports intake, enforcement_actions, platform_admins, the moderation queue, withhold-vs-delete, statement-of-reasons, DMCA repeat-infringer machinery** — there is no tenant population to police. This is the section whose weight motivated the fork; it is gone. (The residual publisher duties that *don't* vanish are in §8.)
- **Legal holds / the two-counter quota / hold-invisibility / the `held` cache and its reconciler** — all existed for the multi-tenant + preservation-duty context. Replaced by a single simple storage cap (§7) and an ordinary delete.
- **The Organization principal seam** — irrelevant at one operator.

**Carried over, because they are load-bearing even at this scope:**
- **Sanitize-and-sandbox-on-serve** (platform §6/§7). This is the one heavy piece that *survives*, and it survives *because* of the public-read requirement: anything reachable at a URL in someone's browser is published to the open web, so it must be sanitized and served in an isolated, network-restricted sandbox. The threat is not a malicious *author* (my agents aren't adversarial) — it is (a) an agent that gets prompt-injected into emitting something hostile, and (b) the simple fact that public bytes render in other people's browsers.
- **Per-agent API keys + revocation** (rogue-agent containment).
- **Versioning** (agents iterate; cheap and useful).
- **The per-document isolated-origin serving model** (platform §7.1) — and here it does *double duty*, see §4.

---

## 1. Principals and authentication

- **Operator** — authenticates via Google OAuth (Auth.js / Lucia or equivalent). The single owner. The operator is the only principal who can mint/revoke agent keys, delete or revoke documents, and set a human label on share (§3).
- **Agent** — authenticates with a per-agent API key: a ≥32-byte CSPRNG secret, stored as HMAC-SHA-256 under a server pepper, constant-time compared (a key-verification construction, **not** a password hash). The key resolves to an agent identity owned by the operator. Revoking a key (`revoked_at`) fails it closed on the next request — the rogue-agent kill switch.
- **Link-holder** — not authenticated. Presents an unguessable document URL; possession is the capability (§4). Read-only, always.

There is no cross-principal access logic to evaluate. A request is operator (session), agent (key), or anonymous (public read) — and what each may do is fixed by the lists above, not computed per-document.

---

## 2. The document model

A **document** is an agent- or operator-authored HTML artifact, versioned, with two names (§3) and a published-bytes/original-bytes pair (§5).

```
documents
  id              uuid pk            -- internal row id
  public_id       text unique not null  -- the UNGUESSABLE capability (§4). High-entropy; the shareable URL.
  slug            text unique not null  -- the AUTHORING/LINKING name (§3). Agent-chosen, human-meaningful.
  label           text                  -- optional human label set by operator at share time (cosmetic; §3)
  current_version_id  uuid references document_versions(id)  -- nullable only transiently at create (§6)
  created_by_agent_id uuid references agents(id)  -- provenance; null if operator-authored
  revoked_at      timestamptz        -- null = live. Set = the kill switch: public_id returns 404 forever (§4).
  created_at      timestamptz not null default now()

document_versions
  id              uuid pk
  document_id     uuid not null references documents(id)
  version_no      int not null       -- monotonic per document; the ETag (§6)
  sanitized_key   text not null      -- object-store key, the served bytes (§5)
  original_key    text               -- object-store key, the pre-sanitized input (retained for re-sanitization; §5)
  sanitized_hash  text not null
  size_bytes      int not null       -- for the storage cap (§7)
  sanitizer_profile_version  text not null  -- which sanitizer profile produced sanitized_key (§5)
  created_by_agent_id uuid references agents(id)
  model           text
  created_at      timestamptz not null default now()

agents
  id              uuid pk
  name            text not null
  created_at      timestamptz not null default now()

agent_keys
  id              uuid pk
  agent_id        uuid not null references agents(id)
  key_prefix      text not null      -- indexed lookup
  key_hash        text not null      -- HMAC-SHA-256(secret) under server pepper
  created_at      timestamptz not null default now()
  revoked_at      timestamptz        -- null = active
```

`unique(slug)` and `unique(public_id)` are both global — there is one operator, so no tenant partition. No `deleted_at`/soft-delete machinery: deletion is revoke (§4) plus, if the operator chooses, an actual purge of the bytes.

---

## 3. Two names, two jobs — `public_id` and `slug`

This is the crux of the design and the part most worth getting right, because it is what lets documents both be shared by link *and* hyperlink to each other.

- **`public_id` — the unguessable capability.** High-entropy (≥128 bits; UUIDv4 or a ≥22-char base62 CSPRNG token). It *is* the security boundary (§4): the public share URL is `https://<host>/d/<public_id>`. Unguessable, non-enumerable, never sequential. This is what I copy and send to someone.
- **`slug` — the discovery + linking name.** Agent-chosen, human-meaningful (`north-island-report`), `unique`. It does two jobs. **(1) Discoverability** — a slugged document is reachable at the short, typeable `https://<host>/s/<slug>` URL, which 302-redirects to the `public_id` URL. This is for documents *meant* to be found by name: paste a clean link, print it on something physical, point a human at it without the opaque id. **(2) Inter-document links** — an agent authoring document A needs a stable, predictable name to link to document B, since it cannot use B's server-minted random `public_id`. So A links to B by its `/s/<slug>` URL, which the public redirect resolves to B's `public_id` at click/read time (§4). Because that URL is stable and predictable, A can link to B *before B exists*; the two can be authored in either order, or at once. **A slug is opt-in, not a default.** Unlike `public_id`, a slug is **low-entropy and externally visible** — the `/s/<slug>` endpoint is public (§4), so a slug is a deliberate, *weaker* capability traded for findability. **Most documents should not carry one:** a document you only ever share by its `public_id` URL is strictly more private without a slug, and that is the right default. Reserve slugs for documents that are meant to be found by name or linked to from another document.
- **`label` — optional cosmetic alias** the operator may set when sharing, purely for human readability. It resolves to the same document; it is never the security boundary and carries no uniqueness-collision machinery (two labels colliding is merely human-ambiguous, not a security problem). Deferred-nice-to-have; the model reserves it.

**Slug claim semantics (the POST/PUT distinction):**
- `POST` with a slug that already exists → **`409 slug_in_use`**. POST means "create a new document and claim this name"; the name must be novel. (A *revoked* document keeps its slug claimed — see §4 — so a `409` can come from a revoked name; this is deliberate, it prevents a new document from hijacking a revoked one's identity and inbound links. Agents handle `409` by choosing a different slug, e.g. appending a suffix, and retrying.)
- `PUT /s/<slug>` → **create-or-update at this name**: if the slug exists, write a new version of that document; if not, create it. PUT is idempotent on the slug — the agent's "revise the doc at this name" verb.

So agents have a clean mental model: **POST to claim a name; PUT to revise the doc at a name.**

**Forward links just work — no pending-link machinery.** Because internal links are authored as `/s/<slug>` URLs resolved at click/read time by the public redirect (§4), a link's target does **not** need to exist when the link is written. A link to an unclaimed slug 404s until that slug is published, then resolves; a link to a revoked slug 404s again. The platform tracks no `pending_links` table and does no serve-time patching or backfill — the redirect *is* the late binding. This is exactly what lets a cross-linked set, cycles included (A↔B), be authored in any order or all at once. The details are in §4.

---

## 4. The capability-URL security model (this is THE security boundary)

Because there is no reader login, **possession of the `public_id` URL is authorization.** There is no second check. This concentrates the entire read-security of the public surface into one mechanism, so that mechanism is treated as first-class, not a detail:

- **High entropy, non-enumerable.** `public_id` is ≥128 bits of CSPRNG output. No sequential ids, no `/d/1`, no low-entropy tokens. It cannot be brute-forced or walked. (Contrast: in the platform spec the unguessable origin was *defense-in-depth* behind `can_access`; **here it is the sole boundary**, so the entropy requirement is load-bearing, not belt-and-suspenders.)
- **The slug is a deliberate, weaker capability — and that asymmetry is the design, not a leak.** A slugged document is reachable at the public `https://<host>/s/<slug>` endpoint, which 302-redirects to its `public_id` URL with no auth. So slugged and unslugged documents are **not** equally private: a slug trades part of the `public_id`'s ≥128-bit unguessability for a short, typeable, linkable name. A memorable slug like `north-island-report` *is* guessable, so a slugged document is discoverable by anyone who guesses or is told the name. **This is acceptable precisely because the slug is opt-in and rare.** The default — and the posture for the overwhelming majority of documents — is *no slug*: a document shared only by its `public_id` URL keeps the full capability boundary. Give a document a slug only when it is *meant* to be found by name or to serve as a link target (next bullet); for everything else the unguessable `public_id` alone is the stronger, correct posture. The lever against an over-shared slug is the same kill switch as any document — revoke releases the slug and 404s the `/s/` lookup (§4 revoke bullet).
- **Internal links are authored as `/s/<slug>` URLs and resolved at click/read time by the public redirect.** An agent writes `<a href="/s/section-1">` — a normal same-origin relative link the sanitizer passes through unchanged. There is **no write-time link rewriting, no `doc:` scheme, no stored `public_id` substitution**: the authored slug URL is exactly what gets stored and served, and the `/s/<slug>` endpoint (above) resolves it to the current target on every click or agent read. The cost is paid per *read* (a cheap 302), not per *write*, and the served bytes carry the slug, not a resolved `public_id`. This is what makes cross-references and cycles trivial — because `/s/<slug>` is stable and predictable, an agent can write A linking to B and B linking to A in either order, or publish both at once, without knowing either `public_id` in advance. A link to a slug that isn't claimed yet simply 404s until the target is published (and again if the target is later revoked); there is **no** forward-reference bookkeeping, **no** drop-and-advise pass, and **no** leaf-first ordering constraint. Net: **agents link by memorable slug; the slug URL is public and stable; resolution is a redirect, not a write-time rewrite.**
- **Born-live, no draft state (v1).** A document is reachable at its `public_id` URL from creation. "Sharing" is simply sending someone the URL; the entropy of the `public_id` *is* the privacy (it is *unlisted*, not access-controlled). There is no per-document public/private toggle in v1.
  - *The deferred seam:* a real draft/private state (born-private, explicit operator publish) is the natural future addition, and it is also the mitigation for the compromised-agent-exfiltration scenario (§8). Reserved, not built.
- **Revoke = the kill switch.** Setting `revoked_at` makes the `public_id` return `404` immediately (subject to the same edge-cache/TTL caveat as any served-bytes change — see §5), permanently. A revoked `public_id` is never reissued. Its **slug is released** — the `/s/<slug>` lookup 404s and the name becomes immediately available for a future document to claim. Because internal links are `/s/<slug>` URLs resolved at click time (above), any inbound links to a revoked document's slug 404 until/unless that slug is re-claimed, at which point they would resolve to the *new* document. That late re-binding is inherent to naming things by slug; it is acceptable because slugs are opt-in and rare and the operator controls reuse. (If a name must never silently re-point, don't reuse it — mint a fresh slug.) This is the "nuke a live link" capability.
- **`Referer` leakage is closed.** External links in served documents carry `rel="noopener noreferrer"` (carried from platform §6.5). The `noreferrer` does double duty here: besides opener-protection, it stops a document's own secret `public_id` URL from leaking to an external site via the `Referer` header when a reader clicks an outbound link. Without it, the capability secret would leak on every outbound click.

---

## 5. Sanitize and serve (carried from platform §6/§7, slimmed)

Anything reachable at a public URL is published to the open web, so the sanitize-then-sandbox pipeline is retained. It is simpler than the platform's only in that there is no adversarial-author threat model and no scripted tier — but the mechanics are the same and should be lifted from platform §6/§7 directly.

**Write path (validate → sanitize → store):**
- **Validate (loud, agent-facing ergonomics):** check against a named blocklist (`<script>`, `on*` handlers, `javascript:`/`data:` hrefs, `<iframe>`/`<object>`/`<embed>`/`<form>`, `<img>`/SVG `<image>`, SVG `<foreignObject>`/`<use>`, `<meta http-equiv=refresh>`, `<base>`, MathML). On a hit, reject with a structured error naming the violation, so the agent can self-correct. This is feedback, **not** the security boundary.
- **Sanitize (the security boundary — allowlist):** run an allowlist-based sanitizer (DOMPurify, pinned profile) — only allowed tags/attributes/SVG-subset survive; everything else is dropped. The allowlist, not the blocklist, is what makes it safe (safe against *unknown* constructs). **The sanitizer's serialized output is the bytes stored at `sanitized_key`, unchanged** — no markup mutation after the sanitizer's final serialization (the platform §6.2 ordering rule; re-serialization after the last security decision manufactures mutation-XSS). Forced link attributes (`rel="noopener noreferrer"`, `target="_blank"`) are applied *inside* the sanitizer profile (a hook), never as a post-pass.
- **SVG** is admitted as an explicit diagram/chart **allowlist**, not "SVG minus the bad parts"; `<use>` and `<foreignObject>` dropped (platform §6.3).
- **Store** sanitized bytes (`sanitized_key`, served) + original (`original_key`, retained for re-sanitization) + `sanitizer_profile_version` (so "which docs used a now-vulnerable profile" is a `WHERE` clause).
- **Resource bounds:** per-document size cap; a cheap pre-parse depth/node/attribute gate before the heavy parser; sanitize in a **killable worker** with a global concurrency bound (a wall-clock timeout cannot preempt synchronous parse work on the Node event loop — platform §6.6). These survive because a compromised/injected agent can still submit a pathological document.

**Serve path (two readers, two representations):**
- **Browser read (public, via `public_id`):** the document is served inside a **sandboxed iframe from a per-document isolated origin**, with the CSP attached at serve time by an edge worker — `connect-src 'none'` (no exfiltration), `frame-ancestors` limited to the app, `base-uri 'none'`, `form-action 'none'`, `img/font/style-src` self/inline/`data:` with no external origins, `sandbox` with no `allow-scripts` (static, no script), `Cache-Control: no-store`. A raw object-store URL cannot carry these headers, so serving routes through the worker (platform §7.3/§11.4). **Per-document origin note (the double duty):** in the platform spec the per-document origin existed to isolate documents from *each other*; here the `public_id` is *both* the origin discriminator *and* the capability secret. That is fine and in fact economical — the unguessable origin and the unguessable capability are the same secret — but it means the origin host must be derived from / gated by the `public_id`, and a revoked `public_id` must stop resolving at the edge.
- **Agent read (authenticated, via API):** `GET /d/<public_id-or-slug>` with `Accept` content negotiation. `Accept: text/html` (default) returns the **sanitized HTML** — the same stored bytes the browser gets, with internal links carried verbatim as their authored `/s/<slug>` URLs (§4), so an agent reading the bytes sees the same stable links a human would click. `Accept: text/markdown` is **reserved** for a future markdown projection (derive-on-read from the sanitized HTML rather than storing a second artifact, to avoid drift). Agents are trusted, so a future option to return `original` raw content is reserved but not default. Content negotiation is the standards-correct way to serve the dual-purpose (operator-artifact + agent-context) requirement from one resource.

**Re-sanitization (slimmed from platform §6.3b):** when the sanitizer profile hardens, **new writes self-heal** (they use the current profile) and stale stored versions are **re-sanitized lazily on fetch** (regenerate `sanitized_key` from `original_key` when a fetched version's `sanitizer_profile_version` is stale). No routine whole-corpus sweep. The `sanitizer_profile_version` column makes a targeted re-sanitization possible if ever needed. Re-sanitization updates `sanitized_hash`/`sanitizer_profile_version` in place and does **not** advance `version_no` (it is a cache regeneration, not a content change). **No link interaction:** because internal links are stored verbatim as `/s/<slug>` URLs and resolved by the public redirect on every read (§4), re-sanitization has nothing to re-resolve — the slug URL is just text that survives the pass unchanged, and a target revoked since the original write simply 404s on the next click. No write-time link resolution exists to repeat.

---

## 6. Write semantics

- **Create:** `POST /d` with `{ html, slug, model? }`. Mints `id` + `public_id` + version 1. Fails `409 slug_in_use` if the slug is taken by a live document. The create is one transaction: insert document (null `current_version_id`) → insert version 1 → update the pointer (the circular-FK order from platform §3.2a). Returns the `public_id` (the shareable URL) and `version_no: 1`.
- **Update:** `PUT /s/<slug>` (or `PUT /d/<id>`) writes a new version. Optimistic concurrency via `If-Match: "v<version_no>"`; stale → `412 Precondition Failed`. The ETag is `version_no` (monotonic int — answers "has this advanced past what I based my write on?").
- **Idempotency:** `Idempotency-Key` header dedupes retries (ephemeral, swept after 48h). New attempt ⇒ new key; retry of the same attempt ⇒ same key.
- **No reader-facing write path.** Only the operator (session) and agents (key) write.
- **Delete/revoke:** operator-only. `revoke` flips `revoked_at` (kill switch, §4). An optional hard purge nulls the object-store keys and removes the bytes. There is no soft-delete/restore/hold lifecycle — those were multi-tenant/preservation concerns now dropped.

---

## 7. Storage cap

A single configurable **storage cap**, value chosen at build time against the selected provider's free tier(s). Enforced at write: reject a write that would exceed the cap. Accounting is a single counter (or a `SUM(size_bytes)` — at one operator the scale doesn't warrant the platform's denormalized two-counter machinery; one denormalized integer updated in the write transaction is more than enough). No hold-aware or operator-invisible accounting — there are no holds and one operator.

---

## 8. The residual publisher posture (the honest, small legal note)

Descoping to single-operator removes the *host-of-third-party-content* duties (no DMCA safe-harbor apparatus needed — I am not hosting others' content; no report-intake/T&S surface — there is no adversarial author population). But publishing my own agent's output to public URLs is not zero-duty, and the honest residual is small and worth stating:

- **I am the publisher of record.** Content at a public `public_id` URL is published-by-me to the open web. That is the "personal website / I publish my own output" posture — far lighter than UGC hosting, but it means ordinary content-of-the-open-web norms apply to me as publisher.
- **CSAM law is not gated on tenancy.** It applies regardless of how few operators there are. At this scope there is no automated detection and no adversarial population feeding the surface — the realistic exposure is an agent being prompt-injected or malfunctioning into generating prohibited content, which I then would be publishing. The mitigation that exists is the **kill switch** (§4 revoke, instant) plus operator awareness. If this ever grows toward independent agents handling sensitive data or a real public population, the platform spec's §6.8/§13 preservation-and-reporting machinery is the blueprint to pull back in — *do not* grow the public surface without revisiting it.
- **Compromised-agent exfiltration** (operator-raised): a compromised/injected agent could write secrets to a document and leak the `public_id` to exfiltrate via the open web. Sized as minimal for now — a compromised agent with outbound network access has far easier exfil paths than this tool, and I am not yet running independent agents holding sensitive context. The future mitigation is the deferred draft/private state (§4) — born-private + explicit operator publish closes it. Tracked, not built.

This section is deliberately a paragraph, not a subsystem. If any of its "if this grows" conditions start to become true, that is the signal to consult the platform spec (and, per its own §10.1, counsel) before expanding the public surface.

---

## 9. What to lift directly from the platform spec when building

To avoid re-deriving solved problems, these parts of `agent-knowledge-host-spec-PLATFORM-v2.md` transfer almost verbatim (with multi-tenant references stripped):
- **§6.2 validate-then-sanitize** (the two-stage gate, the allowlist-is-the-boundary authority statement, the no-post-sanitize-mutation ordering rule, the `stripped[]` advisory).
- **§6.3/§6.3a** sanitizer hardening + the pinned profile artifact (jsdom shim, SVG allowlist, MathML/`<use>`/`<foreignObject>` handling).
- **§6.6** resource bounds (pre-parse SAX gate, killable worker + global concurrency bound).
- **§7.1–§7.4** the per-document origin model, iframe sandbox, CSP-as-network-boundary, and serve-time header attachment via the edge worker.
- **Nothing for slug → `public_id` link resolution.** SOLO deliberately does **not** lift the platform's §3.7 `doc:` resolver in any form (neither serve-time nor write-time). Internal links are authored as `/s/<slug>` URLs and resolved by the stateless public `/s/<slug>` 302 on each read (§3–§4) — so the `doc:` grammar, the write-time rewrite, and the drop-and-advise machinery are *not* built. The redirect is the whole resolver.
- **§11.3** write semantics (ETag = `version_no`, `If-Match`/`412`, `Idempotency-Key`, the new-attempt-new-key rule).

Everything else in the platform spec — access control, projects, sharing, admin/T&S, holds, quotas — is intentionally *not* carried.
