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
- **`slug` — the authoring/linking name.** Agent-chosen, human-meaningful (`north-island-report`), `unique`. It exists for **one reason: inter-document hyperlinks.** An agent authoring document A needs a stable, predictable name to link to document B — it cannot use B's server-minted random `public_id`. So the agent links to B *by slug*; the platform resolves that slug to B's `public_id` **at write time** (§4). A document needs a slug **only if it is (or may be) a link target** — standalone documents you only ever share by their `public_id` URL need none. The slug is purely an *authoring-time name*; it is **never externally visible** (see §4 — this is what keeps slugged and unslugged documents equally private).
- **`label` — optional cosmetic alias** the operator may set when sharing, purely for human readability. It resolves to the same document; it is never the security boundary and carries no uniqueness-collision machinery (two labels colliding is merely human-ambiguous, not a security problem). Deferred-nice-to-have; the model reserves it.

**Slug claim semantics (the POST/PUT distinction):**
- `POST` with a slug that already exists → **`409 slug_in_use`**. POST means "create a new document and claim this name"; the name must be novel. (A *revoked* document keeps its slug claimed — see §4 — so a `409` can come from a revoked name; this is deliberate, it prevents a new document from hijacking a revoked one's identity and inbound links. Agents handle `409` by choosing a different slug, e.g. appending a suffix, and retrying.)
- `PUT /d/by-slug/<slug>` → **create-or-update at this name**: if the slug exists, write a new version of that document; if not, create it. PUT is idempotent on the slug — the agent's "revise the doc at this name" verb.

So agents have a clean mental model: **POST to claim a name; PUT to revise the doc at a name.**

**No forward links (the simplifying constraint).** A link's target must **already exist** when the link is authored. The platform does **not** track pending links or backfill them later — this deliberately drops a whole class of machinery (a `pending_links` table, lazy serve-time patching, on-create backfill) that forward-reference support would require. The consequences and how multi-document/cyclic structures are still authored are in §4.

---

## 4. The capability-URL security model (this is THE security boundary)

Because there is no reader login, **possession of the `public_id` URL is authorization.** There is no second check. This concentrates the entire read-security of the public surface into one mechanism, so that mechanism is treated as first-class, not a detail:

- **High entropy, non-enumerable.** `public_id` is ≥128 bits of CSPRNG output. No sequential ids, no `/d/1`, no low-entropy tokens. It cannot be brute-forced or walked. (Contrast: in the platform spec the unguessable origin was *defense-in-depth* behind `can_access`; **here it is the sole boundary**, so the entropy requirement is load-bearing, not belt-and-suspenders.)
- **The slug is NEVER externally visible.** This is what makes slugged and unslugged documents *equally* private. Slugs live only in the database and in agents' authoring vocabulary; they appear in nothing a reader or the public can touch. There is no public `/d/by-slug/<slug>` endpoint to probe — so a memorable, guessable slug like `north-island-report` is **not** an enumeration surface. (Slugs resolve only for **authenticated** principals — operator/agent via API — and at **write time**, below; never for an anonymous reader.)
- **Internal links are authored by slug, resolved to `public_id` at WRITE time (Option 3, write-time form).** An agent writes `<a href="doc:section-1">`. When the document is written, the same sanitizer pass that already parses the DOM (§5) resolves each `doc:<slug>` reference to the target's `public_id` URL and stores the **already-resolved** `https://<host>/d/<public_id>` in `sanitized_key`. So the served bytes contain only unguessable URLs — there is no serve-time link rewriting, no per-read DB lookup, no public slug endpoint. Resolution is paid once per *write* (on the cold path, inside the parse we already do), not per *read* (the hot path). Agents reading via the API resolve `doc:` references the same way. Net: **agents link by memorable slug; the public web only ever sees unguessable capability URLs; the slug is never emitted anywhere.**
- **No forward links — resolve-what-exists, drop-and-advise the rest.** A link's target must already exist at write time (§3). At write, each `doc:<slug>`:
  - *target exists* → rewritten to the target's `public_id` URL (the normal case).
  - *target does not exist* (or is revoked) → the link is **dropped** (rendered as plain text, not a dead/inert href), and the write **succeeds** with a non-fatal advisory listing the dropped references (the `stripped[]`-style array from platform §6.2, reused here for links). The write is *not* rejected — dropping keeps the privacy model intact (no unresolved slug is ever stored) while letting authoring proceed.
  - This pushes the "second pass" for forward-references and cycles onto the **agent**, where it is cheap: the agent creates leaf documents first, or creates everything and then re-`PUT`s any document that came back with dropped links once the targets exist. Cycles (A↔B) are authored the same way — create A (link to B dropped), create B (link to A resolves), re-`PUT` A (link to B now resolves). The platform stays dumb; the agent does the ordering. (Agents should be prompted: *link only to documents you have already created; if you get a dropped-link advisory, create the target then re-PUT.*)
  - *Not supported:* atomic one-shot publish of a cross-linked set with all links live on first write — that would require the dropped forward-reference machinery, deliberately not built. Achieve the same end with create-then-re-PUT.
- **Born-live, no draft state (v1).** A document is reachable at its `public_id` URL from creation. "Sharing" is simply sending someone the URL; the entropy of the `public_id` *is* the privacy (it is *unlisted*, not access-controlled). There is no per-document public/private toggle in v1.
  - *The deferred seam:* a real draft/private state (born-private, explicit operator publish) is the natural future addition, and it is also the mitigation for the compromised-agent-exfiltration scenario (§8). Reserved, not built.
- **Revoke = the kill switch.** Setting `revoked_at` makes the `public_id` return `404` immediately (subject to the same edge-cache/TTL caveat as any served-bytes change — see §5), permanently. A revoked `public_id` is never reissued, and its slug stays claimed (so no later document can hijack its inbound resolved links — though note those links, already resolved to the revoked `public_id` in other documents' stored bytes, will now `404` on click; that is correct kill-switch behavior). This is the "nuke a live link" capability.
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
- **Agent read (authenticated, via API):** `GET /d/<public_id-or-slug>` with `Accept` content negotiation. `Accept: text/html` (default) returns the **sanitized HTML** — the same stored bytes the browser gets, with internal links already resolved to `public_id` URLs (§4). `Accept: text/markdown` is **reserved** for a future markdown projection (derive-on-read from the sanitized HTML rather than storing a second artifact, to avoid drift). Agents are trusted, so a future option to return `original` raw content (which still contains the authored `doc:<slug>` references, useful if an agent wants to see/edit the link structure) is reserved but not default. Content negotiation is the standards-correct way to serve the dual-purpose (operator-artifact + agent-context) requirement from one resource.

**Re-sanitization (slimmed from platform §6.3b):** when the sanitizer profile hardens, **new writes self-heal** (they use the current profile) and stale stored versions are **re-sanitized lazily on fetch** (regenerate `sanitized_key` from `original_key` when a fetched version's `sanitizer_profile_version` is stale). No routine whole-corpus sweep. The `sanitizer_profile_version` column makes a targeted re-sanitization possible if ever needed. Re-sanitization updates `sanitized_hash`/`sanitizer_profile_version` in place and does **not** advance `version_no` (it is a cache regeneration, not a content change). **Note the link interaction:** `original_key` holds the *authored* form with `doc:<slug>` references, so re-sanitizing from the original must **re-run write-time link resolution** (§4) — re-resolving each slug to its target's current `public_id` and applying the same drop-and-advise for any now-missing target. This is mostly a non-issue (a target's `public_id` is stable for its life), but a link whose target was revoked since the original write will correctly drop on re-sanitization.

---

## 6. Write semantics

- **Create:** `POST /d` with `{ html, slug, model? }`. Mints `id` + `public_id` + version 1. Fails `409 slug_in_use` if the slug is taken by a live document. The create is one transaction: insert document (null `current_version_id`) → insert version 1 → update the pointer (the circular-FK order from platform §3.2a). Returns the `public_id` (the shareable URL) and `version_no: 1`.
- **Update:** `PUT /d/by-slug/<slug>` (or `PUT /d/<id>`) writes a new version. Optimistic concurrency via `If-Match: "v<version_no>"`; stale → `412 Precondition Failed`. The ETag is `version_no` (monotonic int — answers "has this advanced past what I based my write on?").
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
- **§3.7-style `doc:` link resolution** (slug → `public_id`), but in the **write-time** form of §4 (resolve during the sanitizer's parse, store resolved links, drop-and-advise missing targets) — *not* the platform's serve-time resolver. The platform's resolver logic (the `doc:` grammar, dangling handling) is the reference; the timing differs (write, not serve) because there is no per-viewer access check forcing late resolution here.
- **§11.3** write semantics (ETag = `version_no`, `If-Match`/`412`, `Idempotency-Key`, the new-attempt-new-key rule).

Everything else in the platform spec — access control, projects, sharing, admin/T&S, holds, quotas — is intentionally *not* carried.
