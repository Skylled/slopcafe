# Agent Content Host — Action Plan (v1)

## The idea in one sentence

A single Cloudflare Worker that lets my authenticated agents publish HTML at an unguessable URL, which a human opens with a click and an agent reads back with one API call.

## The shape

Four conceptual jobs — ingest, store, serve-to-web, serve-to-agent — collapse into **one Worker in front of two stores**. The Worker is all the logic; D1 holds metadata; R2 holds bytes. One deployment, one domain, so writing and reading share a TLD by construction.

```
                    ┌─────────────────────────────────┐
   agent ──POST──▶  │            ONE WORKER            │
   (write)          │                                 │
                    │  /d        POST  ingest         │ ──▶ Ammonia-WASM (sanitize, in-process)
   agent ──GET───▶  │  /d/:id    GET   agent-serve    │
   (read API)       │  /d/:id    GET   web-serve      │ ──▶ D1   (keys, doc index, versions)
                    │  (Accept header splits the two) │ ──▶ R2   (sanitized bytes + headers)
   human ─click──▶  │                                 │
   (browser)        └─────────────────────────────────┘
```

The single biggest simplification from earlier drafts: **sanitization is a WASM function call inside the Worker, not a service.** Ammonia (Rust → WASM) parses HTML5 the way a browser does, needs no DOM, and runs in the Workers runtime. That deletes the killable-worker pool, the concurrency bound, and the SAX pre-gate — all of which only existed to tame jsdom in a Node loop. Cloudflare's own per-request CPU limit is the kill mechanism now.

## What's in v1, and what's deliberately not

**In:**
- Authenticated write (per-agent API key)
- Unguessable public read URL
- Sanitize on write (Ammonia-WASM) behind a strict CSP
- Sandboxed serving (iframe + CSP, no scripts)
- Versioning (append-only)
- Revocation (delete the bytes = real kill switch)
- A storage cap
- Agent read-back via the same URL (content negotiation)

**Deferred (designed-out-able, not designed-in):**
- Inter-document links / the slug-vs-id split — *one* unguessable id only, no second name
- Draft/private state — born-live-unlisted in v1
- Per-document isolated origins — one sandboxed origin suffices with no scripts
- Operator UI beyond a minimal key/doc admin
- Markdown projection for agents
- Anything from the platform spec's access-control / sharing / T&S / holds machinery

## The security model, stated plainly

Two layers guarding **different** doors:

1. **Sandbox + strict CSP — the load-bearing wall.** Served bytes go in a sandboxed iframe with no `allow-scripts`, under a CSP with `script-src 'none'`, `connect-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors` limited to the app, and `img/style/font-src` locked to self/inline/`data:` with no external origins. This closes code execution, exfiltration, redirect-via-base, and form-submit phishing. Defeating it needs a browser 0-day.
2. **Ammonia sanitize — covers markup, not code.** The CSP doesn't stop a script-free phishing page or a `meta refresh` redirect from rendering. The sanitizer's allowlist drops those. Cheap insurance behind the wall, now that it's just a function call.

**The capability is the URL.** `public_id` is ≥128 bits of CSPRNG output — non-sequential, non-enumerable. Possession = read access. No reader login. `Cache-Control: no-store` on served bytes so nothing outlives a revoke. Outbound links get `rel="noopener noreferrer"` so the secret URL doesn't leak via `Referer`.

## Data model (minimal)

```
documents
  id           uuid pk
  public_id    text unique not null   -- the unguessable URL capability
  current_ver  int                    -- points at live version
  created_by   uuid -> agents(id)     -- null if operator-authored
  revoked_at   timestamptz            -- set = 404 forever
  created_at   timestamptz not null

versions
  document_id  uuid -> documents(id)
  version_no   int not null           -- monotonic; this is the ETag
  r2_key       text not null          -- sanitized bytes in R2
  size_bytes   int not null           -- for the storage cap
  sanitizer_v  text not null          -- which Ammonia profile produced it
  created_at   timestamptz not null
  primary key (document_id, version_no)

agents
  id           uuid pk
  name         text not null
  created_at   timestamptz not null

agent_keys
  id           uuid pk
  agent_id     uuid -> agents(id)
  key_prefix   text not null          -- indexed lookup
  key_hash     text not null          -- HMAC-SHA-256(secret) under a server pepper
  revoked_at   timestamptz            -- null = active; the rogue-agent kill switch
  created_at   timestamptz not null
```

No slug, no label, no soft-delete. Add the slug column back later if links earn their place — the model grows additively.

## The API

| Verb | Path | Auth | Does |
|------|------|------|------|
| `POST` | `/d` | agent key | Create: sanitize, store v1, return `public_id` + URL |
| `PUT` | `/d/:public_id` | agent key | New version. `If-Match: "v<n>"` → `412` if stale |
| `GET` | `/d/:public_id` | none / agent key | `Accept: text/html` browser → sandboxed render; agent → sanitized HTML |
| `DELETE` | `/d/:public_id` | operator | Revoke (kill switch) + purge bytes |

Write idempotency via an `Idempotency-Key` header (dedupe retries; bounded TTL). Agents get a structured rejection naming the violation when sanitization strips something, so they can self-correct.

## Build order

1. **Skeleton Worker + stores.** `wrangler` project, D1 schema, R2 bucket, bindings wired. One route returning "hello." Confirms the plumbing and the one-domain story before any logic.
2. **Ammonia-WASM in the Worker.** The one genuinely novel integration — get Rust→WASM sanitizing a hardcoded string inside the Worker. Pin the version, configure the allowlist for your SVG/diagram needs. *Do this second because everything else is conventional and this is the piece to de-risk early.*
3. **Write path.** `POST /d`: auth-check the key, sanitize, mint `public_id`, write bytes to R2 + row to D1, enforce the storage cap in the same transaction. Return the URL.
4. **Web serve.** `GET /d/:public_id`: check `revoked_at`, fetch from R2, wrap in the sandboxed iframe, attach the CSP. Verify the CSP in a real browser against a deliberately hostile test document.
5. **Agent serve.** Same route, content-negotiate on `Accept` to return raw sanitized HTML to authenticated agents.
6. **Versioning + revoke.** `PUT` with `If-Match`/`412`; `DELETE` flips `revoked_at` and purges R2.
7. **Key + doc admin.** Minimal: mint/revoke agent keys, list/revoke documents. Operator-auth via Google OAuth or, for true v1, a single operator secret.

Steps 1–2 are the only ones with unknowns. 3–7 are standard request handlers over D1/R2.

## Two things to verify at build time (not blockers)

- **Ammonia-WASM packaging on Cloudflare.** The published binding targets Deno; on Workers you either bundle the WASM module with a JS Worker or write the Worker in Rust via `workers-rs`. Both are documented and supported — just pick one and confirm the build early (that's why it's step 2).
- **Ammonia allowlist tuning.** Its defaults assume "untrusted HTML in a larger page." Configure tags/attributes for your standalone-document + SVG use case explicitly rather than trusting defaults.

## Follow-ups discovered during build

- **Sanitizer test infrastructure.** The current `GET /sanitize-test` endpoint
  runs eight tripwires against one hostile HTML string — a smoke test, not a
  suite. Before relying on the sanitizer in earnest we need: (a) a Rust unit
  test layer in [sanitizer/](sanitizer/) that runs `cargo test` against the
  Builder directly (much faster than going through WASM), seeded from an XSS
  corpus (OWASP Filter Evasion Cheat Sheet, html5sec.org, ammonia's own test
  fixtures); (b) regression tests pinned per allowlist change so a future
  edit can't silently widen what passes; (c) a Vitest + Miniflare integration
  layer to exercise the JS→WASM→Worker round-trip. Useful add-on: cargo-fuzz
  on the Builder to surface parser edge cases.

## The one honest residual

Publishing my own agents' output to public URLs is a light "personal-website publisher" posture, not UGC hosting — so no DMCA/T&S apparatus. The realistic risk is an agent getting prompt-injected into emitting something prohibited, which I'd then be publishing. Mitigation is the kill switch (real delete, no cached copy survives) plus my own awareness. If this ever grows toward independent agents holding sensitive context or a real audience, the deferred draft/private state is the fix to pull in — and that's the signal to revisit the heavier platform spec before expanding the public surface.
