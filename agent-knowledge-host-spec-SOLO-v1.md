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
- **The sandbox + strict-CSP serving model** (platform §7), but **not** the platform's per-document origins. SOLO documents are served sandboxed under a strict CSP; the isolation that matters here is **document-bytes-from-the-service-origin** (achieved by serving documents from a single separate content domain — intended; see §5), *not* documents-from-each-other. The earlier "per-document origin doubling as the capability" idea is dropped: the capability is the `public_id`/`slug` URL (§4), and the serving origin no longer carries it.

---

## 1. Principals and authentication

- **Operator** — authenticates with a static **operator token** (`OPERATOR_TOKEN`, a high-entropy server secret, constant-time compared). For browser convenience there is also a **signed-cookie session** derived from that same token — log in once instead of pasting the token on every action — resolved *after* a bearer token, so programmatic callers are unchanged. The single owner; the only principal who can mint/revoke agent keys and delete or revoke documents. **There is no third-party IdP / Google-OAuth login for the operator** (formally cancelled): the operator token is the sole operator trust root, and the cookie session adds no new root (rotating the token, or bumping the session epoch, ends every session). *(An OAuth 2.1 + PKCE flow does exist, but it authenticates **agent** connectors — e.g. Claude / Cowork / ChatGPT — and resolves to an agent identity, never to operator authority. A connector's agent identity is established either when its OAuth client is minted **bound** to an existing agent, or — for a client minted **unbound**, *or one that self-registered via dynamic client registration* (RFC 7591; a DCR client writes no `client_id ↔ agent_id` row, so it is unbound by definition) — at the consent screen, where the operator picks an existing agent or mints a new one; the `client_id ↔ agent_id` binding is then written and `props.agentId` is re-derived from that binding, never trusted from the submitted form. Dynamic client registration therefore confers **no authority** — it only removes the manual client_id paste from the connect flow; the agent is still chosen at the operator-gated consent screen, and a dynamically-registered client expires 90 days after registration (an absolute ceiling, not reset by use). The consent screen is itself operator-gated and session-aware (the same cookie session, or a pasted token), and it lets the operator inline-approve a connector's new redirect callback — limited to a small allowlist of pre-trusted vendor hosts that doubles as the consent page's CSP `form-action` source, so a host the browser would block on the post-grant redirect can never be approved. None of these paths confers operator authority; each resolves only to an agent identity.)*
- **Agent** — authenticates with a per-agent API key: a ≥32-byte CSPRNG secret, stored as HMAC-SHA-256 under a server pepper, constant-time compared (a key-verification construction, **not** a password hash). The key resolves to an agent identity owned by the operator. Revoking a key (`revoked_at`) fails it closed on the next request — the rogue-agent kill switch.
- **Link-holder** — not authenticated. Presents an unguessable document URL; possession is the capability (§4). Read-only, always.

There is no cross-principal access logic to evaluate. A request is operator (session), agent (key), or anonymous (public read) — and what each may do is fixed by the lists above, not computed per-document.

---

## 2. The document model

A **document** is an agent- or operator-authored HTML artifact, versioned, with an unguessable `public_id` and an optional discovery/linking `slug` (§3). Both the sanitized **served** bytes and the **pre-sanitized source** are stored, one of each per version (convert-and-discard has been **reversed**; §5); only the sanitized bytes are ever served to a browser.

The schema below is the as-built shape (Cloudflare **D1** / SQLite, hence `text`/`integer` columns; ids are TEXT UUIDs and `public_id`s are 22-char base64url tokens):

```
documents
  id              text pk               -- internal row id (UUID)
  public_id       text unique not null  -- the UNGUESSABLE capability (§4). 22-char base64url CSPRNG; the shareable URL.
  slug            text                  -- OPTIONAL discovery/linking name (§3). NULL = no slug.
                                        --   Uniqueness is a PARTIAL unique index (where slug is not null); released on revoke.
  current_ver     integer               -- monotonic version pointer; the ETag (§6). Null only transiently at create.
  created_by      text references agents(id) on delete set null  -- provenance; null if operator-authored
  revoked_at      text                  -- null = live. Set = the kill switch: public_id 404s + slug released (§4).
  created_at      text not null default (strftime now)

versions
  document_id     text not null references documents(id) on delete cascade
  version_no      integer not null      -- monotonic per document; the ETag (§6)
  r2_key          text not null         -- R2 object key for the served sanitized bytes H (§5)  [key shape <id>/v<n>]
  size_bytes      integer not null      -- rendered H byte count, for the storage cap (§7)
  source_r2_key   text                  -- R2 key for the retained pre-sanitized source S (§5)  [key shape <r2_key>.src]
                                        --   NULL = legacy/un-backfilled (loud source_unavailable on source-read; no fallback to H).
  source_size_bytes integer             -- source S byte count; also counts toward the cap (§7). NULL on legacy rows (coalesced to 0).
  sanitizer_v     text not null         -- which sanitizer profile produced the served bytes (§5); the re-heal trigger/stamp
  source_format   text not null default 'html'  -- 'html' | 'markdown' — which input path produced this version; the source's language
  title           text                  -- per-version metadata (nullable)
  description     text                  -- per-version metadata (nullable)
  tags            text                  -- per-version metadata, JSON-encoded array (nullable)
  created_at      text not null default (strftime now)
  primary key (document_id, version_no)
  -- NOTE: no sanitized_hash / model column. The pre-sanitized source IS retained (source_r2_key, §5);
  --   the writing agent's identity is recorded in R2 customMetadata, not D1; there is no LLM-model column.

agents
  id              text pk
  name            text not null
  created_at      text not null default (strftime now)

agent_keys
  id              text pk
  agent_id        text not null references agents(id) on delete cascade
  key_prefix      text not null         -- indexed lookup
  key_hash        text not null         -- HMAC-SHA-256(secret) under server pepper
  revoked_at      text                  -- null = active
  expires_at      text                  -- null = never; non-null only on short-lived publish credentials
  created_at      text not null default (strftime now)
```

`public_id` is globally unique; `slug` is optional, so its uniqueness is a **partial** unique index (`where slug is not null`) binding only live, slugged documents (and the slug is released on revoke — §4). There is one operator, so no tenant partition. No `deleted_at`/soft-delete machinery: deletion is revoke (§4) plus, if the operator chooses, an actual purge of the bytes.

**Storage & auxiliary tables (implementation).** Metadata lives in **D1** (above); the one sanitized blob per version lives in **R2** (`DOCS` binding, key `<id>/v<n>`); the agent-OAuth provider's state lives in **KV**. Two tables exist beyond the core model: `oauth_clients` (a `client_id ↔ agent_id` join backing the agent connector OAuth door — §1; the row is **optional** — a client minted *unbound* lives only in KV until the operator binds it to an agent at the consent screen, so absence of a row *is* "unbound," and `UNIQUE(agent_id)` keeps it one-client-per-agent) and `documents_fts` (an FTS5 virtual table over `title`/`description`/`tags`/`body`, one row per live document, backing full-text search). Neither changes the access model; both are noted so the schema matches the build.

---

## 3. Two names, two jobs — `public_id` and `slug`

This is the crux of the design and the part most worth getting right, because it is what lets documents both be shared by link *and* hyperlink to each other.

- **`public_id` — the unguessable capability.** High-entropy (≥128 bits; UUIDv4 or a ≥22-char base62 CSPRNG token). It *is* the security boundary (§4): the public share URL is `https://<host>/d/<public_id>`. Unguessable, non-enumerable, never sequential. This is what I copy and send to someone.
- **`slug` — the discovery + linking name.** Agent-chosen, human-meaningful (`north-island-report`), `unique`. It does two jobs. **(1) Discoverability** — a slugged document is reachable at the short, typeable `https://<host>/s/<slug>` URL, which **serves the document in place** — the slug stays in the address bar, content-negotiated exactly like the `public_id` URL (§5); there is no redirect. This is for documents *meant* to be found by name: paste a clean link, print it on something physical, point a human at it without the opaque id. **(2) Inter-document links** — an agent authoring document A needs a stable, predictable name to link to document B, since it cannot use B's server-minted random `public_id`. So A links to B by its `/s/<slug>` URL, which the public `/s/<slug>` route serves in place at click/read time (§4). Because that URL is stable and predictable, A can link to B *before B exists*; the two can be authored in either order, or at once. **A slug is opt-in, not a default.** Unlike `public_id`, a slug is **low-entropy and externally visible** — the `/s/<slug>` endpoint is public (§4), so a slug is a deliberate, *weaker* capability traded for findability. **Most documents should not carry one:** a document you only ever share by its `public_id` URL is strictly more private without a slug, and that is the right default. Reserve slugs for documents that are meant to be found by name or linked to from another document.
- **`label` — optional cosmetic alias** the operator might one day set when sharing, purely for human readability. It would resolve to the same document, never be the security boundary, and carry no uniqueness-collision machinery. **Not built:** there is no `label` column in the as-built schema (§2); it is a possible later addition, not a reserved column.

**Slug claim and addressing semantics:**
- **Claiming a name.** A slug is set via the optional slug field/header on a write. `POST /d` (create) with a slug already held by a **live** document → **`409 slug_taken`**; the agent picks a different name and retries. There is **no** "revoked-but-still-claimed" state: revoke **releases** the slug (§4), so a freed name is immediately reclaimable (the partial unique index excludes NULL).
- **Reads address by `public_id` *or* slug, interchangeably.** `GET /d/<public_id>` and `GET /s/<slug>` serve the same document with the same content negotiation (§5), and the MCP `read_document` tool accepts either identifier (echoing back the resolved `public_id`). This read symmetry is the slug↔`public_id` "unification."
- **Writes address by `public_id` only.** `PUT /d/<public_id>` revises an existing document; there is **no** create-or-update-*by-slug* verb (no `PUT /s/<slug>`). On a write the slug is a *settable attribute*, never a write-addressing key.

So the mental model is: **`POST` to create (optionally claiming a slug); `PUT /d/<public_id>` to revise; read by slug or `public_id`.**

**Forward links just work — no pending-link machinery.** Because internal links are authored as `/s/<slug>` URLs resolved at click/read time by the public `/s/<slug>` route (which serves the target in place — §4), a link's target does **not** need to exist when the link is written. A link to an unclaimed slug 404s until that slug is published, then resolves; a link to a revoked slug 404s again. The platform tracks no `pending_links` table and does no serve-time patching or backfill — the `/s/<slug>` lookup *is* the late binding. This is exactly what lets a cross-linked set, cycles included (A↔B), be authored in any order or all at once. The details are in §4.

---

## 4. The capability-URL security model (this is THE security boundary)

Because there is no reader login, **possession of the `public_id` URL is authorization.** There is no second check. This concentrates the entire read-security of the public surface into one mechanism, so that mechanism is treated as first-class, not a detail:

- **High entropy, non-enumerable.** `public_id` is ≥128 bits of CSPRNG output. No sequential ids, no `/d/1`, no low-entropy tokens. It cannot be brute-forced or walked. (Contrast: in the platform spec the unguessable origin was *defense-in-depth* behind `can_access`; **here it is the sole boundary**, so the entropy requirement is load-bearing, not belt-and-suspenders.)
- **The slug is a deliberate, weaker capability — and that asymmetry is the design, not a leak.** A slugged document is reachable at the public `https://<host>/s/<slug>` endpoint, which serves the document in place with no auth (content-negotiated exactly like the `public_id` URL — §5; the slug stays in the address bar, no redirect). So slugged and unslugged documents are **not** equally private: a slug trades part of the `public_id`'s ≥128-bit unguessability for a short, typeable, linkable name. A memorable slug like `north-island-report` *is* guessable, so a slugged document is discoverable by anyone who guesses or is told the name. **This is acceptable precisely because the slug is opt-in and rare.** The default — and the posture for the overwhelming majority of documents — is *no slug*: a document shared only by its `public_id` URL keeps the full capability boundary. Give a document a slug only when it is *meant* to be found by name or to serve as a link target (next bullet); for everything else the unguessable `public_id` alone is the stronger, correct posture. The lever against an over-shared slug is the same kill switch as any document — revoke releases the slug and 404s the `/s/` lookup (§4 revoke bullet).
- **Internal links are authored as `/s/<slug>` URLs and resolved at click/read time by the public `/s/<slug>` route (served in place).** An agent writes `<a href="/s/section-1">` — a normal same-origin relative link the sanitizer passes through unchanged. There is **no write-time link rewriting, no `doc:` scheme, no stored `public_id` substitution**: the authored slug URL is exactly what gets stored and served, and the `/s/<slug>` endpoint (above) resolves it to the current target on every click or agent read. The cost is paid per *read* (a cheap serve-time lookup), not per *write*, and the served bytes carry the slug, not a resolved `public_id`. This is what makes cross-references and cycles trivial — because `/s/<slug>` is stable and predictable, an agent can write A linking to B and B linking to A in either order, or publish both at once, without knowing either `public_id` in advance. A link to a slug that isn't claimed yet simply 404s until the target is published (and again if the target is later revoked); there is **no** forward-reference bookkeeping, **no** drop-and-advise pass, and **no** leaf-first ordering constraint. Net: **agents link by memorable slug; the slug URL is public and stable; resolution is a serve-time lookup, not a write-time rewrite.**
- **Born-live, no draft state (v1).** A document is reachable at its `public_id` URL from creation. "Sharing" is simply sending someone the URL; the entropy of the `public_id` *is* the privacy (it is *unlisted*, not access-controlled). There is no per-document public/private toggle in v1.
  - *The deferred seam:* a real draft/private state (born-private, explicit operator publish) is the natural future addition, and it is also the mitigation for the compromised-agent-exfiltration scenario (§8). Reserved, not built.
- **Revoke = the kill switch.** Setting `revoked_at` makes the `public_id` return `404` immediately (subject to the same edge-cache/TTL caveat as any served-bytes change — see §5), permanently. A revoked `public_id` is never reissued. Its **slug is released** — the `/s/<slug>` lookup 404s and the name becomes immediately available for a future document to claim. Because internal links are `/s/<slug>` URLs resolved at click time (above), any inbound links to a revoked document's slug 404 until/unless that slug is re-claimed, at which point they would resolve to the *new* document. That late re-binding is inherent to naming things by slug; it is acceptable because slugs are opt-in and rare and the operator controls reuse. (If a name must never silently re-point, don't reuse it — mint a fresh slug.) This is the "nuke a live link" capability.
- **`Referer` leakage is closed.** External links in served documents carry `rel="noopener noreferrer"` (carried from platform §6.5). The `noreferrer` does double duty here: besides opener-protection, it stops a document's own secret `public_id` URL from leaking to an external site via the `Referer` header when a reader clicks an outbound link. Without it, the capability secret would leak on every outbound click.

---

## 5. Sanitize and serve (carried from platform §6/§7, slimmed)

Anything reachable at a public URL is published to the open web, so the sanitize-then-sandbox pipeline is retained. It is simpler than the platform's only in that there is no adversarial-author threat model and no scripted tier — but the mechanics are the same and should be lifted from platform §6/§7 directly.

**Write path (validate → sanitize → store):**
- **Validate (loud, agent-facing ergonomics):** check against a named blocklist (`<script>`, `on*` handlers, `javascript:`/`data:` hrefs, `<iframe>`/`<object>`/`<embed>`/`<form>`, `<img>`/SVG `<image>`, SVG `<foreignObject>`/`<use>`, `<meta http-equiv=refresh>`, `<base>`, MathML). On a hit, reject with a structured error naming the violation, so the agent can self-correct. This is feedback, **not** the security boundary.
- **Sanitize (the security boundary — allowlist):** run an allowlist-based sanitizer (the build uses **Ammonia**, compiled to WASM, as a pinned profile) — only allowed tags/attributes/SVG-subset survive; everything else is dropped. The allowlist, not the blocklist, is what makes it safe (safe against *unknown* constructs). **The sanitizer's serialized output is the bytes stored at `r2_key`, unchanged** — no markup mutation after the sanitizer's final serialization (the platform §6.2 ordering rule; re-serialization after the last security decision manufactures mutation-XSS). Forced link attributes (`rel="noopener noreferrer"`, `target="_blank"`) are applied *inside* the sanitizer profile (a hook), never as a post-pass.
- **SVG** is admitted as an explicit diagram/chart **allowlist**, not "SVG minus the bad parts"; `<use>` and `<foreignObject>` dropped (platform §6.3).
- **Store** the sanitized bytes **plus the pre-sanitized source** — **two** R2 objects per version: the served form **H** at `r2_key` and the submitted **source S** at the sibling key `<r2_key>.src` (Markdown for a Markdown doc, the original HTML for an HTML doc), alongside the `sanitizer_v` stamp (so "which docs used a now-vulnerable profile" stays a `WHERE` clause). **Convert-and-discard has been reversed** (as-built): source retention is the model now, because retaining S is what lets `edit_document` patch the *source* (a Markdown doc edits its Markdown, re-renders, stays Markdown and keeps its reader theme — the bug that motivated the reversal; §6) and what unblocks lazy re-sanitization (below). The source counts toward the storage cap (§7) — single-tenant, so every stored byte is real budget. **Only H ever reaches a browser; S is never served on the public render path.** Source-read surfaces (the agent-key-gated `read_document representation:"source"` knob, and an agent-key-gated `GET /d/<public_id>/source`) are **authenticated, never public** — same auth floor as the agent read below, never operator-only (in this whole-fleet single-tenant model any active agent key already reads and overwrites every document, so a source-read discloses no authority the caller lacks). Each source-read response carries `unsanitized: true` plus the `stripped[]` / `will_not_render[]` advisories, so a consuming agent is told the bytes are pre-sanitization and where the live render diverges. (Legacy/un-backfilled versions retain no source and fail loud — a structured `source_unavailable`, never a silent fall back to H.)
- **Resource bounds:** per-document size cap; a cheap pre-parse depth/node/attribute gate before the heavy parser; sanitize in a **killable worker** with a global concurrency bound (a wall-clock timeout cannot preempt synchronous parse work on the Node event loop — platform §6.6). These survive because a compromised/injected agent can still submit a pathological document.

**Serve path (two readers, two representations):**
- **Browser read (public, via `public_id` or `slug`):** the request returns a tiny HTML **shell** that embeds a **sandboxed `<iframe>`**; the iframe loads the document bytes from a sibling `/raw` URL that carries the strict CSP — `connect-src 'none'` (no exfiltration), `frame-ancestors 'self'`, `base-uri 'none'`, `form-action 'none'`, `img/font/style-src` self/inline/`data:` with no external origins, `sandbox` with **no** `allow-scripts` and **no** `allow-same-origin` (static, no script, no ambient origin), `Cache-Control: no-store`. Two URLs are deliberate: `frame-ancestors` is header-only, so the bytes must come from an HTTP response, not `srcdoc`. **No per-document origin.** Documents are **not** isolated from one another (they don't need to be — my agents aren't adversarial to each other). What they *do* need is isolation **from the service's own origin** — its cookies, its session, its DOM — which matters most if a scripted tier is ever allowed. The intended hardening for that is to serve all document bytes from a **single separate content domain** (distinct registrable domain from the app/service origin), not a per-document origin. *(Current build serves same-origin under the sandbox + strict CSP, which is the load-bearing wall; the separate content domain is the planned next layer.)* A revoked `public_id`/`slug` stops resolving and returns `404`.
- **Agent read (authenticated, via API):** an agent presenting its key on `GET /d/<public_id>` (or `GET /s/<slug>`) receives the raw **sanitized HTML** — the same stored bytes the iframe loads — with internal links carried verbatim as their authored `/s/<slug>` URLs (§4), so an agent sees the same stable links a human would click. A **Markdown** projection (for ingest-as-context) is a *separate* endpoint — `GET /d/<public_id>/text` (and `GET /s/<slug>/text`), agent-key-gated — and is **built, not reserved**: it is **derived on read** from the sanitized HTML (no second stored artifact, so no drift). The split is by **path** (`/` vs `/text`), not by `Accept` header. The MCP surface mirrors this with one `read_document` tool taking a `format: "html" | "markdown"` knob (default `markdown`).

**Re-sanitization is now unblocked, but still deferred — not built.** When the sanitizer profile hardens, **new writes self-heal** (they use the current `sanitizer_v`). Re-healing *already-stored* versions requires the pre-sanitized original, and the build now retains it (source S per version, above) — so the foreclosure is gone: reversing the no-original-retention decision was the prerequisite, and that reversal has **landed**. What remains deferred is the *re-heal mechanism itself* — **[RESEARCH NEEDED]**. The leading (operator-preferred) proposal is **lazy re-heal on first read after a profile bump**: on read, if a version's stored `sanitizer_v` is behind the current profile, re-render from the retained source, re-sanitize, re-store H, and bump the stamp — so the first reader pays the heal and everyone after gets the healed bytes, with no batch job. The open questions are where the heal fires given the streaming serve path (a re-sanitize needs buffer + WASM, which the stream can't do inline), thundering-herd idempotency on the first read after a bump, and whether a heal mints a new `versions` row or rewrites H in place under the same version with a new `sanitizer_v`. The `sanitizer_v` stamp still records which profile produced each stored blob, so "which docs used a now-vulnerable profile" remains a `WHERE` clause — and *acting* on that answer is now a buildable re-heal rather than a foreclosed one. **No link interaction either way:** internal links are stored verbatim as `/s/<slug>` URLs resolved by the public `/s/<slug>` route on every read (§4), so there is nothing to re-resolve — and no write-time link resolution ever existed to repeat.

---

## 6. Write semantics

- **Create:** `POST /d` with the body (`Content-Type: text/html` or `text/markdown`; Markdown is parsed to HTML before sanitizing) and an optional `slug` (plus optional `title`/`description`/`tags`). Mints `id` + `public_id` + version 1. Fails **`409 slug_taken`** if the slug is held by a live document. The create is one transaction: insert document (null `current_ver`) → insert version 1 → update the pointer (the circular-FK order from platform §3.2a). Returns the `public_id` (the shareable URL) and `version: 1`. *(No `model` field is accepted or stored — the writing agent's identity is captured in R2 `customMetadata`, not an LLM-model column.)*
- **Update:** `PUT /d/<public_id>` writes a new version (addressed by `public_id` only — there is no `PUT /s/<slug>`; §3). `If-Match` is **required** (omit it → `428 Precondition Required`); send `"v<version_no>"` for optimistic concurrency (stale → `412`) or `*` to force. The ETag is `version_no` (monotonic int — "has this advanced past what I based my write on?").
- **No idempotency keys.** `Idempotency-Key` is **descoped** in this single-tenant build — `If-Match`/ETag optimistic concurrency is the only write-safety mechanism. (An optional `X-Content-SHA256` byte-exact integrity check on the *received body* exists separately, for the byte-exact curl publish path.)
- **No reader-facing write path.** Only the operator (token/session) and agents (key) write.
- **Delete/revoke:** operator-only. `revoke` flips `revoked_at` (the kill switch, §4), **releases the slug** (so the name is immediately reusable), drops the search index row, and purges the R2 bytes. There is no soft-delete/restore/hold lifecycle — those were multi-tenant/preservation concerns now dropped.

---

## 7. Storage cap

A single configurable **storage cap**, value chosen at build time against the selected provider's free tier(s). Enforced at write: reject a write that would exceed the cap. Accounting is a single counter (or a `SUM(size_bytes)` — at one operator the scale doesn't warrant the platform's denormalized two-counter machinery; one denormalized integer updated in the write transaction is more than enough). No hold-aware or operator-invisible accounting — there are no holds and one operator.

---

## 8. The residual publisher posture (the honest, small legal note)

Descoping to single-operator removes the *host-of-third-party-content* duties (no DMCA safe-harbor apparatus needed — I am not hosting others' content; no report-intake/T&S surface — there is no adversarial author population). But publishing my own agent's output to public URLs is not zero-duty, and the honest residual is small and worth stating:

- **I am the publisher of record.** Content at a public `public_id` URL is published-by-me to the open web. That is the "personal website / I publish my own output" posture — far lighter than UGC hosting, but it means ordinary content-of-the-open-web norms apply to me as publisher.
- **CSAM law is not gated on tenancy.** It applies regardless of how few operators there are. At this scope there is no automated detection and no adversarial population feeding the surface — the realistic exposure is an agent being prompt-injected or malfunctioning into generating prohibited content, which I then would be publishing. The mitigation that exists is the **kill switch** (§4 revoke, instant) plus operator awareness. If this ever grows toward independent agents handling sensitive data or a real public population, the platform spec's §6.8/§13 preservation-and-reporting machinery is the blueprint to pull back in — *do not* grow the public surface without revisiting it.
- **Compromised-agent exfiltration** (operator-raised): a compromised/injected agent could write secrets to a document and leak the `public_id` to exfiltrate via the open web. Sized as minimal for now — a compromised agent with outbound network access has far easier exfil paths than this tool, and I am not yet running independent agents holding sensitive context. The future mitigation is the deferred draft/private state (§4) — born-private + explicit operator publish closes it. Tracked, not built.
- **Source retention (§5) leaves this analysis unmoved.** The retained pre-sanitized source **S** is **never published** — only the sanitized **H** ever reaches a public URL, so the publisher-of-record and CSAM postures above (which are about what is *published*, i.e. H) are unchanged. The new raw-source channel is **agent-key-gated, never public** and is strictly *less* reachable than H (which already has a public render URL), so it adds no exfiltration path the open-web `public_id` doesn't already present. The one genuinely new exposure is narrow: an agent that requests source ingests *markup-form* bytes the sanitizer would have stripped from the render — an XSS/markup-shape payload an HTML-naive context window might misread as instructions. That increment is covered by the `unsanitized: true` provenance marker + advisories on every source-read and the agent-key gate; it is not a new natural-language-injection surface (adversarial prose already survives into H and the Markdown projection today). Holding unsanitized bytes at rest creates **no** new at-rest-scanning obligation here — single-tenant, operator-owned R2 holding the operator's own agents' bytes, with no third-party UGC ingestion and no execution of stored bytes (a decided non-action, not an omission).

This section is deliberately a paragraph, not a subsystem. If any of its "if this grows" conditions start to become true, that is the signal to consult the platform spec (and, per its own §10.1, counsel) before expanding the public surface.

---

## 9. What to lift directly from the platform spec when building

To avoid re-deriving solved problems, these parts of `agent-knowledge-host-spec-PLATFORM-v2.md` transfer almost verbatim (with multi-tenant references stripped):
- **§6.2 validate-then-sanitize** (the two-stage gate, the allowlist-is-the-boundary authority statement, the no-post-sanitize-mutation ordering rule, the `stripped[]` advisory).
- **§6.3/§6.3a** sanitizer hardening + the **pinned, versioned profile** discipline (SVG allowlist, MathML/`<use>`/`<foreignObject>` handling) — though the SOLO build realizes that profile as **Ammonia compiled to WASM** (no DOMPurify, no jsdom shim); the `sanitizer_v` stamp (§2) is the pinned-version handle.
- **§6.6** resource bounds (pre-parse SAX gate, killable worker + global concurrency bound).
- **§7.2–§7.4** the iframe sandbox, CSP-as-network-boundary, and serve-time header attachment via the edge worker — **but not §7.1's per-document origins.** SOLO does not isolate documents from each other; the only origin isolation is document-bytes-from-the-service, via a single separate content domain (§5).
- **Nothing for slug → `public_id` link resolution.** SOLO deliberately does **not** lift the platform's §3.7 `doc:` resolver in any form (neither serve-time nor write-time). Internal links are authored as `/s/<slug>` URLs and resolved by the stateless public `/s/<slug>` route, which serves the target in place on each read (§3–§4) — so the `doc:` grammar, the write-time rewrite, and the drop-and-advise machinery are *not* built. The `/s/<slug>` route is the whole resolver.
- **§11.3** write semantics (ETag = `version_no`, `If-Match`/`412`), **minus** the `Idempotency-Key` / new-attempt-new-key rule — idempotency keys are descoped at single-tenant scale (§6).

Everything else in the platform spec — access control, projects, sharing, admin/T&S, holds, quotas — is intentionally *not* carried.
