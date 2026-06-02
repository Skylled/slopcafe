# Slopcafe HTTP API reference

The complete HTTP surface of the `agent-web-host` Worker (production:
**`https://slopcafe.com`**). This is the contract a consumer — a client app
(e.g. the Flutter app), a script, or an agent working on a connected project —
needs to publish, read, and manage documents **without** reading the Worker's
source.

- **Authoring rules** (what HTML/CSS/SVG is allowed in a document body) live in
  `skills/publishing.md` — that's a separate, body-content contract, not an
  endpoint reference. Read it before publishing anything with layout or inline
  SVG. (On MCP it is the `awh://publishing-guide` resource.)
- **MCP tools** (the `/mcp` Streamable-HTTP transport used by Claude/Cowork
  connectors) are a different surface — see [The MCP surface](#the-mcp-surface)
  at the bottom. This document covers the **REST/HTTP** API.

> Keep this document in lockstep with the code. Any change to an HTTP surface —
> new route, header, field, status code, or semantics — must update the
> reference in the same commit (the canonical copy is `docs/http-api.md` in the
> repo; this published copy carries slug `slopcafe-http-api`).

---

## Contents

- [Base URL](#base-url)
- [Authentication](#authentication)
- [Conventions](#conventions)
  - [Error envelope](#error-envelope)
  - [Content types (write)](#content-types-write)
  - [Optional document metadata (write)](#optional-document-metadata-write)
  - [Optimistic concurrency (`If-Match` / `ETag`)](#optimistic-concurrency-if-match--etag)
  - [Byte-exact integrity (`X-Content-SHA256`)](#byte-exact-integrity-x-content-sha256)
  - [Identifiers, slugs, pagination](#identifiers-slugs-pagination)
- [Document endpoints](#document-endpoints) — publish, update, read, source, revoke
- [Listing & search](#listing--search) — list, search, set visibility, set slug
- [Admin endpoints](#admin-endpoints) — agents, keys, OAuth clients, slug redirects
- [Browser / session endpoints](#browser--session-endpoints)
- [Health](#health)
- [Shared response shapes](#shared-response-shapes)
- [The MCP surface](#the-mcp-surface)

---

## Base URL

| Environment | Origin |
|---|---|
| Production | `https://slopcafe.com` |
| Fallback (during cutover) | `https://agent-web-host.skylled.workers.dev` |

All paths below are relative to the origin. Every example uses `https://slopcafe.com`.

---

## Authentication

There are **three** credential types. Which one an endpoint wants is listed per
endpoint below.

### 1. Agent key — `awh_` bearer  *(publish/update/read documents)*

A long-lived secret string beginning `awh_`, minted by the operator
([`POST /admin/agents`](#post-adminagents) or
[`POST /admin/agents/:id/keys`](#post-adminagentsidkeys)). Send it as:

```
Authorization: Bearer awh_xxxxxxxxxxxxxxxxxxxxxxxx
```

This is the credential a connected app embeds. It authorizes **writes**
(`POST /d`, `PUT /d/:id`) and authenticated reads (`GET /d/:id` with the
header). It does **not** grant access to the `/admin/*` surface or to
`DELETE /d/:id` — those need the operator token.

> **Listing/search over HTTP is operator-gated.** An agent key can publish,
> update, and read by `public_id`, but the HTTP listing/search endpoints live
> under `/admin/*`. An agent that needs to *enumerate or search* documents
> programmatically should use the MCP `list_documents` / `search_documents`
> tools (agent-scoped), not the HTTP admin routes.

Short-lived agent keys (with an expiry) also exist for the byte-exact publish
path; they're minted on demand via the MCP `create_publish_credential` tool and
behave identically to a normal `awh_` bearer until they expire.

### 2. Operator token — `OPERATOR_TOKEN` bearer  *(admin + revoke)*

The single shared operator secret. Send it the same way:

```
Authorization: Bearer <OPERATOR_TOKEN>
```

Required by every `/admin/*` endpoint and by `DELETE /d/:id`. Bearer-authed
operator calls are **CSRF-exempt** (so curl/scripts are unaffected).

### 3. OAuth 2.1 + PKCE  *(the `/mcp` connector path — "Door A")*

Used by hosted Claude / Cowork / ChatGPT connectors. A client can be obtained
three ways: minted **bound** via
[`POST /admin/agents/:id/oauth-clients`](#post-adminagentsidoauth-clients);
minted **unbound** via [`POST /admin/oauth-clients`](#post-adminoauth-clients); or
**self-registered** via Dynamic Client Registration (RFC 7591) when a connector is
given only the MCP URL with no client_id. Unbound and DCR-registered clients are
bound to an agent at the `/authorize` consent screen on first connect (a
DCR-registered client has no `oauth_clients` row, so it is unbound by definition).
A connector presenting a redirect URI that isn't yet registered can have it
approved inline at `/authorize` by the operator (trust-on-first-use, restricted to
an allowlist of approvable hosts). The token, registration, and discovery endpoints
(`/token`, `/register`, `/.well-known/*`) are served by the OAuth provider library.

**DCR notes.** Registration is **confidential-only** (a request for
`token_endpoint_auth_method: "none"` is rejected). A dynamically-registered client
**expires 90 days after registration** — an absolute ceiling, *not* reset by use —
after which the next token refresh fails `invalid_client` and the user must
re-authenticate. For a permanent connector that must not expire, mint a client via
`POST /admin/oauth-clients` instead (operator-minted clients are immune to the DCR
TTL) and paste its client_id. DCR is gated by a build-time flag (`ENABLE_DCR` in
`src/oauth.ts`); when disabled, the `/register` endpoint and its
`registration_endpoint` metadata entry disappear and the surface is
pre-registration-only. See `dcr-design.md`.
See [The MCP surface](#the-mcp-surface).

### Operator browser session  *(cookie, for the web UI only)*

The operator can log in once at `/login` and get a signed `awh_session` cookie
instead of pasting the token on every browser action. This is an alternative
front-end onto the **operator** check — it never affects `/mcp` or any document
tool. Cookie-authed **mutating** requests must also send the CSRF nonce
(`X-CSRF-Token` header for JSON/admin, `csrf_token` form field for HTML forms).
See [Browser / session endpoints](#browser--session-endpoints).

---

## Conventions

### Error envelope

Every JSON error response has this shape (extra fields vary by error):

```json
{ "error": "<machine_code>", "message": "<human-readable explanation>" }
```

`error` is a stable machine code (e.g. `slug_taken`, `version_conflict`); switch
on it, not on `message`. Some errors add context fields — documented per
endpoint (e.g. `version_conflict` adds `current_version`).

### Content types (write)

`POST /d` and `PUT /d/:id` require a body `Content-Type` of:

- `text/html` — raw HTML, sanitized then stored.
- `text/markdown` (or `text/x-markdown`) — parsed as CommonMark + GFM to HTML,
  then sanitized.

Any other type → **`415 unsupported_media_type`**. Charset parameters
(`; charset=utf-8`) are ignored. Either way, the stored bytes are **sanitized
static HTML** — see `skills/publishing.md` for what survives sanitization.

### Optional document metadata (write)

Set via request headers on `POST /d` / `PUT /d/:id` (the MCP write tools take
the same values as named fields):

| Header | Meaning |
|---|---|
| `X-Doc-Title` | Title (≤300 chars). **Omitted** → derive from the first `<h1>` (or first ~80 chars of text). **Empty** → re-derive. Shown as `{title} \| Slopcafe` in the browser tab. |
| `X-Doc-Description` | Short description (≤500 chars). Omitted → null. Empty → null. Surfaces in `<meta name=description>` and link previews. |
| `X-Doc-Tags` | Comma-separated tags. Charset restricted to `[A-Za-z0-9_-]` — invalid chars are **silently stripped**. Max 10 tags × 32 chars; deduped. |
| `X-Doc-Slug` | Optional unique handle, charset `/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/`. Invalid → **`422 invalid_slug`**; in use by a live doc → **`409 slug_taken`**; previously used and retired → **`409 slug_retired`** (slugs are **not reusable** — see [slugs](#identifiers-slugs-pagination)). |

**Inheritance on update** (`PUT`): an *omitted* metadata header inherits the
prior version's value (slug inherits the current document's value); an explicit
**empty** value clears it (and for title, re-derives from the new content; for
slug, drops the current slug). Note that renaming or dropping a slug **retires**
the old value permanently — it is not freed for reuse. See
[slugs](#identifiers-slugs-pagination).

### Optimistic concurrency (`If-Match` / `ETag`)

- Every write returns an `ETag` of the form `"v<n>"` (e.g. `"v3"`).
- **`PUT /d/:id` requires an `If-Match` header** (omitting it → **`428
  precondition_required`**). Send the version you expect to replace as a strong
  tag — `If-Match: "v3"` — or `If-Match: *` to skip the check (last-write-wins).
- Strong tags only. No weak tags, no multi-tag lists. A malformed value →
  **`400 bad_request`**; a stale version → **`412 precondition_failed`** with
  `current_version` in the body.

### Byte-exact integrity (`X-Content-SHA256`)

Optional on `POST /d` / `PUT /d/:id`. Send the SHA-256 of the **raw request
body** (64 lowercase hex, optional `sha256:` prefix). The server hashes the
received bytes **before sanitization** and rejects a corrupted/truncated upload:

- Malformed header → **`400 bad_integrity_header`**.
- Hash mismatch → **`422 integrity_mismatch`** (body includes `expected_sha256`,
  `actual_sha256`, `received_bytes`).

This is the companion to the `curl --data-binary @file` publish path. It
verifies the *wire*, independent of any sanitizer transformation (which the
`modified` flag reports separately). **HTTP-only** — there is no MCP equivalent
(the hash must come from the same tool that streams the file).

### Identifiers, slugs, pagination

- **`public_id`** — a 22-char URL-safe base64 string (`/^[A-Za-z0-9_-]{22}$/`).
  The unguessable capability handle for a document. Anyone with the URL can read
  the rendered document **if it is `public`** — a `private` document `404`s to
  unauthenticated callers (see [visibility](#post-admindocumentspublic_idvisibility)).
- **`slug`** — an optional, lower-entropy, human-typeable handle. **Publicly
  resolvable without auth** via [`GET /s/:slug`](#get-sslug) **when the document
  is `public`** (a `private` slugged doc `404`s to anon, serves to operator/agent,
  and keeps its slug claimed), so it is a deliberately *weaker* capability than
  `public_id`. Opt in only for documents
  meant to be found by name or linked from another document. Unique across live
  documents. **Claiming a slug is semi-permanent**: once used it is reserved
  forever — revoking, renaming, or clearing a slug **retires** it (it resolves
  to **`410 Gone`**) but never frees it for another document. Reusing any slug
  ever claimed → **`409 slug_retired`**. This is deliberate (a shared/bookmarked
  `/s/:slug` must never silently start serving unrelated content); don't mint
  slugs frivolously. To change what a name serves, update *that* document. The
  legitimate "this name moved" case (a rename, or an operator consolidating two
  docs) is met by a **loud redirect**, not reuse: a retired slug can forward to
  another document, but only with a click (browser) or `follow_redirects`
  (agent) — see [`GET /s/:slug`](#get-sslug) and
  [`POST /admin/slugs/:slug/redirect`](#post-adminslugsslugredirect).
- **Pagination** — list endpoints are cursor-paginated. Pass `?limit=N`
  (default 50, max 200) and `?cursor=<opaque>` (echo back the `next_cursor` from
  the previous response; `null` means end-of-list). Cursors are opaque base64url
  — never construct or modify them. Ordering is `(created_at DESC, id DESC)`.
  **Search is not paginated** (see [search](#get-admindocumentssearch)).

---

## Document endpoints

### `POST /d`

Publish a new document. **Auth: agent key.**

**Request**

```
POST /d
Authorization: Bearer awh_...
Content-Type: text/html        # or text/markdown
[X-Doc-Title: ...]             # optional metadata (see above)
[X-Doc-Description: ...]
[X-Doc-Tags: foo,bar]
[X-Doc-Slug: my-doc]
[X-Content-SHA256: <64-hex>]   # optional integrity check

<body bytes>
```

**`201 Created`** — `Location` + `ETag: "v1"` headers, body:

```json
{
  "public_id": "hdbOcFnhL1y9fe0tWpBvXA",
  "url": "https://slopcafe.com/d/hdbOcFnhL1y9fe0tWpBvXA",
  "version": 1,
  "size_bytes": 2048,
  "sanitizer_v": "1.2.3",
  "modified": false,
  "stripped": [],
  "will_not_render": [],
  "title": "My document",
  "description": null,
  "tags": [],
  "slug": null
}
```

- `modified` — `true` if the sanitizer changed your input.
- `stripped[]` — best-effort summary of removed constructs.
- `will_not_render[]` — constructs that survived the sanitizer but the render
  CSP will block (most importantly **external `<img src>`** — it would otherwise
  be a silent broken image).
- `title`/`description`/`tags`/`slug` — the values actually stored (useful when
  `title` was derived or tags were sanitized).

**Errors**

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | missing/invalid agent key |
| 415 | `unsupported_media_type` | `Content-Type` not html/markdown |
| 400 | `empty_body` | empty body |
| 400 | `bad_integrity_header` | malformed `X-Content-SHA256` |
| 413 | `too_large` | body exceeds per-doc cap (5 MiB) — body has `limit` |
| 413 | `storage_cap_exceeded` | fleet storage cap hit — body has `used`/`cap`/`this_write` |
| 422 | `invalid_slug` | slug failed charset/length — body has `reason` |
| 422 | `integrity_mismatch` | body hash ≠ `X-Content-SHA256` |
| 409 | `slug_taken` | slug in use by another **live** doc — body has `slug` |
| 409 | `slug_retired` | slug was used before and is permanently reserved — body has `slug` (slugs are not reusable) |

### `PUT /d/:public_id`

Append a new version to an existing document. The body **replaces** the prior
version (no merge/patch). **Auth: agent key.** Any active key under the operator
may update any document (single-tenant trust model).

**Request** — same as `POST /d`, plus a **required** `If-Match`:

```
PUT /d/hdbOcFnhL1y9fe0tWpBvXA
Authorization: Bearer awh_...
Content-Type: text/markdown
If-Match: "v1"                 # required — send current version, or * to skip
[X-Doc-* / X-Content-SHA256]   # optional; metadata inherits-on-omit (see above)

<new body bytes>
```

**`200 OK`** — same response shape as `POST /d` (with the incremented
`version`), `Location` + `ETag: "v<n>"` headers.

**Errors** — the `POST /d` errors, plus:

| Status | `error` | When |
|---|---|---|
| 428 | `precondition_required` | `If-Match` header missing |
| 400 | `bad_request` | malformed `If-Match` |
| 404 | `not_found` | no such document (or revoked) |
| 412 | `precondition_failed` | `If-Match` version ≠ current — body has `current_version`, `expected` |

### `GET /d/:public_id`

The URL agents share with humans. **Content-negotiated by `Authorization`:**

- **No `Authorization` header** → `200` HTML **shell** page: a toolbar (created
  time, version, author, and a **kebab "⋮" actions menu**) wrapping a sandboxed
  `<iframe>` that loads `/raw`. This is the browser experience. The menu is
  operator-session-aware (`Vary: Cookie`): with a valid [operator session
  cookie](#browser--session-endpoints) the toolbar also shows the document's
  **visibility** (`Public`/`Private`) and the menu offers **Manage…** (→ the
  [document-management page](#browser--session-endpoints): visibility toggle,
  custom-link editor, and revoke) and **Sign out** (→ `/logout`); without one it
  offers **Sign in** (→ `/login`, returning to this page after auth). The menu is
  a native `<details>` element enhanced by a small same-origin script
  (`/shell.js`) and degrades to a working click-to-toggle menu if that script is
  unavailable. The items only reflect session state — each target re-checks auth
  server-side.
- **Valid agent key** → `200` the raw sanitized HTML bytes (same as `/raw`).
- **Invalid agent key** → `401` (broken keys surface rather than silently
  downgrading to the shell).

**Visibility (a private document 404s to the open web).** Whether the
no-`Authorization` shell renders depends on the document's `visibility` (see
[`POST /admin/documents/:public_id/visibility`](#post-admindocumentspublic_idvisibility)).
A **`public`** document behaves as above. A **`private`** one returns the same
opaque **`404`** as a missing/revoked document to an unauthenticated browser —
**not** a `401`, so a private doc is indistinguishable from a nonexistent one and
the capability URL discloses nothing. It still serves to an **operator** (valid
[session cookie](#browser--session-endpoints), which the browser sends on the
same-origin iframe request) and to any **valid agent key**. New documents are
**born `private` by default** (a deploy-time toggle, `DEFAULT_DOCUMENT_VISIBILITY`);
only the operator makes one public.

The no-`Authorization` (browser) `404` is an **HTML page with an operator "Sign
in" link** that round-trips back to the requested URL (`/login?next=…`) — so a
logged-out operator who hits a valid-but-`private` URL can sign in and land back
on it. It is shown **uniformly** on every browser doc `404` (nonexistent,
revoked, malformed, or private-to-anon), so it preserves the no-oracle property.
Requests that carry an `Authorization` header (agents/API) still get the plain
`text/plain` `Not Found` body. (Same for [`GET /s/:slug`](#get-sslug).)

### `GET /d/:public_id/raw`

The sanitized HTML bytes the iframe loads. `200 text/html; charset=utf-8`,
`ETag: "v<n>"`, served under a strict locked-down CSP. `404` if missing or
revoked. **Visibility-gated:** a **`public`** document needs no auth (the
`public_id` is the capability); a **`private`** one returns `404` to an anonymous
caller and serves only to the operator (session cookie — it reaches this
same-origin iframe subresource) or a valid agent key. This single byte path is
the gate the shell and the homepage both inherit (both embed `/raw`).

**Reading theme for Markdown documents.** When the current version's
`source_format` is `markdown`, the response prepends a `<!doctype html>` and a
server-side reading stylesheet — a centered ~44rem column, system-sans
typography, a soft background, and **automatic light/dark via
`prefers-color-scheme`** — ahead of the stored bytes. This is presentation only:
it's injected at serve time, never stored, never seen by the sanitizer, and
never present in the `/text` (Markdown) derivation or the `/source` (retained
source) channel. The stylesheet uses low-specificity element selectors, so any
inline `style=` the content carries overrides it. **HTML-authored documents are
served byte-for-byte as stored** — their author owns presentation and gets no
injected theme. The shell page (`GET /d/:public_id`) toolbar and the landing
page (`GET /`) follow the same automatic light/dark.

The theme decision keys on the current version's `source_format`. Because the
**retained source** (see [`GET /d/:public_id/source`](#get-dpublic_idsource)) is
re-rendered and re-sanitized on every `edit_document` *in its authored
language*, a Markdown document stays `source_format: markdown` across edits and
keeps its reading theme — editing no longer flips it to HTML.

### `GET /d/:public_id/text`

The document converted to **GFM Markdown** — for agents/tooling ingesting the
document as context rather than rendering it. **Auth: a valid `awh_` agent key
required** (`401` otherwise). Both `/text` endpoints (this and `/s/:slug/text`)
are agent-facing ingestion channels, not public surfaces, so they're gated
identically. The auth check runs before the id-shape check.

> Note this gate is about not exposing a clean public Markdown API, not about
> confidentiality of the content: the rendered bytes stay publicly reachable at
> [`GET /d/:public_id/raw`](#get-dpublic_idraw) (the sandboxed iframe loads it
> uncredentialed), so a determined caller could fetch `/raw` and convert it.

With a valid key: `200 text/markdown; charset=utf-8`, with:

- `ETag: "v<n>"`
- `X-Sanitizer-Version`, `X-Converter-Version` — so a caller can detect when the
  sanitizer or markdown-converter policy changed without parsing the body.

`401 unauthorized` if the key is missing or invalid. `404` if missing or revoked.

### `GET /d/:public_id/source`

The **retained, unsanitized source `S`** of the current version, in its authored
language — Markdown for a Markdown document, the original HTML for an HTML
document. This is the read an agent does *before* `edit_document`, whose match
runs against `S` (not the rendered bytes). The HTTP twin of the MCP
`read_document representation:"source"` route.

**Auth: a valid `awh_` agent key required** (`401` otherwise). This is the
**first authenticated `GET` on the `/d/:public_id` namespace** — in deliberate
contrast to the public capability URLs, which serve only the sanitized `H`:

- [`GET /d/:public_id`](#get-dpublic_id) and
  [`GET /d/:public_id/raw`](#get-dpublic_idraw) — **public** (no `Authorization`
  → shell / raw bytes).
- [`GET /s/:slug`](#get-sslug) — **public** (no-auth shell branch).
- `GET /d/:public_id/source` — **never public, never unauthed.** The source is
  the *pre-sanitization* bytes: it may contain markup the sanitizer would have
  stripped, so it is gated like `/text`. The auth check runs before the
  id-shape check. (Agent-key — not operator-only — is intentional: in the
  single-tenant whole-fleet trust model any active key already reads and
  overwrites every document, so a source read discloses no authority the caller
  lacks.)

> **The returned bytes are unsanitized — treat them as untrusted input.** The
> response carries `"unsanitized": true` precisely so a consuming agent's
> context never silently treats `S` as the safe, rendered view. The
> `stripped[]` / `will_not_render[]` arrays are re-derived from `S` at read time
> and show where the live render diverges from this source.

**`200 OK`** — `application/json; charset=utf-8`, with `ETag: "v<n>"` and an
`X-Sanitizer-Version` header. Body (the `ReadSourceOk` shape — see
[Shared response shapes](#readsourceok)):

```json
{
  "source": "## My document\n\nbody in its authored language…",
  "source_format": "markdown",
  "version_no": 3,
  "sanitizer_v": "1.2.3",
  "stripped": [],
  "will_not_render": [],
  "unsanitized": true,
  "title": "My document",
  "description": null,
  "tags": [],
  "slug": null
}
```

- `source` — the retained source bytes as a string, in `source_format`.
- `source_format` — `"markdown"` or `"html"`; the language `source` is authored
  in and the pipeline `edit_document` re-renders it through.
- `stripped[]` / `will_not_render[]` — re-derived from `S` (render-or-identity →
  sanitize → diff), so they reflect this source, not a cached write-time value.
- `unsanitized` — always `true`. (For HTML documents backfilled with `S := H`,
  the bytes are technically already sanitized, so this marker over-warns — a
  harmless, fail-safe direction, not a bug.)

**Errors**

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | missing/invalid agent key |
| 404 | `not_found` | no such document, revoked, or malformed `public_id` |
| 409 | `source_unavailable` | the document is **live** but its current version has **no retained source** — a legacy/un-backfilled row (predates source retention) or the `.src` blob is gone. **Distinct from `404` on purpose:** a loud signal that the one-time source backfill missed this document, not "no such document." |

### `GET /s/:slug`

Resolve a slug, then **content-negotiate exactly like
[`GET /d/:public_id`](#get-dpublic_id)** — the slug is just the lookup handle in
front of the same behavior:

| Request | Response |
|---|---|
| **No `Authorization`** | `200 text/html` — the document's **shell page**, served directly (the pretty slug URL stays in the address bar; no redirect). The browser case. |
| **`Authorization: Bearer awh_…`** (valid agent key) | `200 text/html` — the **raw sanitized bytes**, same as `/d/:public_id/raw`. The non-browser "bytes by slug" path. |
| Present but invalid key | `401 unauthorized` (no silent downgrade to the shell). |
| Live doc but **`private`** ([visibility](#post-admindocumentspublic_idvisibility)), **no `Authorization`** | **`404`** — the same opaque 404 as "matches nothing". The private doc is masked; its slug stays **claimed** (NOT retired, so **not** `410`). Serves normally to an operator session cookie or an agent key. Make the doc public to relight the name. |
| Slug **retired** with a **redirect** set (operator redirect or rename auto-forward), **no `Authorization`** | `200 text/html` — a **loud interstitial card** the human must click through to the target's canonical URL. Never an automatic 3xx. |
| Slug **retired** with a redirect, **agent key**, no `follow_redirects` | **`409 slug_redirected`** — JSON `{ "redirect_to": { "public_id", "slug", "title" }, "hint" }`. Not a 3xx (so curl `-L`/clients don't auto-follow); opt in to follow. |
| Slug **retired** with a redirect, **agent key**, `?follow_redirects=true` | `200 text/html` — the **target's raw bytes** (re-checks the agent key first). |
| Slug **retired**, no redirect (or a dangling/revoked target) | **`410 Gone`** — HTML "this link is retired" card for a browser, `{"error":"gone"}` JSON for an agent-key caller. Never resolves again, never reused. |
| Slug matches nothing / malformed | `404`. |

The auth'd-bytes path is how a programmatic consumer fetches a document it only
knows by slug — one call, no redirect-follow. (It previously worked via the old
`302 → /d/:public_id` redirect; content negotiation here preserves it after the
slug page started rendering directly.)

The **`410` vs `404`** split is deliberate: a retired slug discloses that it
once existed (honest "this was removed" UX for a public, shareable handle),
whereas a never-claimed slug stays an opaque `404`. A slug is permanently
reserved once claimed — see [slugs](#identifiers-slugs-pagination).

**Redirects are loud, never silent.** A retired slug can be pointed at another
live document — automatically when a document is renamed (the old slug forwards
to the same document's new location), or by the operator via
[`POST /admin/slugs/:slug/redirect`](#post-adminslugsslugredirect) (the
branding/consolidation case). Forwarding is never an automatic 3xx: a browser
gets a click-through interstitial, and an agent gets `409 slug_redirected` and
must opt in with `?follow_redirects=true` to be served the target. This keeps the
legitimate "this name moved" case while still preventing the silent-repurposing
the retire-on-revoke rule exists to stop. The redirect target is stored as a
`public_id`, so resolution is single-hop and loop-free; if the target is later
revoked the redirect dangles and the slug falls back to `410`.

On the **shell** branch, the canonical / `og:url` point back at `/s/:slug`, so a
re-shared link stays pretty and link-unfurls (Slack, Twitter) reference the slug
rather than the capability id. The framed bytes still load from
`/d/:public_id/raw` and the toolbar's Revoke menu item still targets
`/d/:public_id/revoke`, so
the `public_id` is present in the page's HTML source — not a privilege leak (the
slug already grants the same read access, and revoke stays operator-gated), but
visible to "view source".

For the Markdown derivation by slug, use [`GET /s/:slug/text`](#get-sslugtext)
(below) — the slug twin of `/d/:public_id/text`. Both require an agent key; on
the slug surface only the no-auth shell here is public.

Freshness is preserved without the redirect: the slug is re-resolved every
request and every response is `Cache-Control: no-store`, so a slug serves its
document while live and flips to `410` once retired, on each hit. Because slugs
are never reused, a retired slug never starts resolving to a *different*
document.

This is also the **cross-reference mechanism** — author `<a href="/s/other-doc">`
and it resolves at click/read time, no `public_id` needed in advance.

### `GET /s/:slug/text`

The slug-addressed twin of [`GET /d/:public_id/text`](#get-dpublic_idtext):
the Markdown derivation of the sanitized HTML, resolved by slug instead of
`public_id`. **Auth: a valid `awh_` agent key required**, exactly like
`/d/:public_id/text` — both `/text` endpoints are agent ingestion channels, not
public. On the slug surface specifically, the only public variant is the
browser-friendly shell at `GET /s/:slug`; every machine-readable form *by slug*
(the raw bytes via content negotiation on `/s/:slug`, and this Markdown form) is
gated.

The auth check runs **before** slug validation or any DB hit, so an
unauthenticated caller can't use this endpoint as a slug-existence oracle.

**`200 text/markdown`** (with a valid key) — identical body and headers to
`/d/:public_id/text` (`ETag: "v<n>"`, `X-Sanitizer-Version`,
`X-Converter-Version`, `Cache-Control: no-store`). `401 unauthorized` if the key
is missing or invalid. A retired slug behaves like `GET /s/:slug` for an agent:
**`409 slug_redirected`** (JSON, with `redirect_to`) if it carries a redirect —
or, with `?follow_redirects=true`, the **target's Markdown**; **`410 Gone`**
(`{"error":"gone"}`) if it's a plain/dangling tombstone; `404` if the slug
matches nothing or is malformed. The slug is re-resolved and the bytes re-fetched
on each request, so a revoke landing mid-request still fails closed rather than
serving stale Markdown.

This is the one place the `/s/` and `/d/` text paths differ: it's the HTTP
analogue of the MCP `read_document` slug + `format: "markdown"` route (also an
authenticated channel), for a caller that has a key but only knows the slug.

### `DELETE /d/:public_id`

Revoke (kill switch). **Auth: operator token** (Bearer) **or** browser session
cookie + `X-CSRF-Token`. Sets `revoked_at` (making the doc 404 instantly), then
purges the R2 bytes. The `versions` audit trail is retained; only the rendered
bytes are destroyed. The document's slug (if any) is **retired**, not freed:
`/s/:slug` flips to `410 Gone` and the handle can never be reclaimed by another
document (see [slugs](#identifiers-slugs-pagination)).

**`200 OK`**

```json
{ "revoked": true, "public_id": "hdbOcFnhL1y9fe0tWpBvXA", "r2_objects_purged": 3 }
```

`404 not_found` if missing or already revoked. `401`/`403` on auth/CSRF failure.

A browser-friendly confirmation form for the same action lives at
`GET/POST /d/:public_id/revoke` (see Browser / session endpoints).

---

## Listing & search

> Both are under `/admin/*` — **operator-token auth.** For agent-scoped
> enumeration/search, use the MCP `list_documents` / `search_documents` tools.

### `GET /admin/documents`

List documents (including revoked, with `revoked_at` set), newest first.
**Auth: operator.** Cursor-paginated.

**Query params:** `limit` (1–200, default 50), `cursor` (opaque),
`tag` (repeatable or comma-joined; AND semantics; silently sanitized to
`[A-Za-z0-9_-]`), `slug` (exact match; validated, `400 bad_slug` on bad charset).

**`200 OK`**

```json
{
  "documents": [ /* DocumentListing rows — see Shared response shapes */ ],
  "next_cursor": "eyJ0cyI6Li4ufQ"
}
```

Errors: `400 bad_limit` / `400 bad_cursor` / `400 bad_slug`; `401`/`403` auth.

### `GET /admin/documents/search`

Full-text search (BM25 over title, description, tags, body — title weighted
highest) over **live** documents. **Auth: operator.** **Not cursor-paginated.**

**Query params:** `q` (**required**), `limit` (1–200, default 50), `tag`, `slug`
(same as list; compose with `q`).

**Query syntax:** space-separated terms, each ≥2 chars, implicit AND. Trailing
`*` for prefix match. Diacritics and case folded; light-English stemming.
Phrase queries, Boolean operators, and column filters are **not** supported
(silently stripped).

**`200 OK`** — note **no `next_cursor`**:

```json
{ "documents": [ /* SearchHit rows: DocumentListing + score/matched_field/snippet */ ] }
```

Errors: `422 bad_query` (missing `q`, or tokenizes to empty);
`400 bad_limit`/`bad_slug`; `401`/`403` auth.

### `POST /admin/documents/:public_id/visibility`

Set a live document's [visibility](#get-dpublic_id) — `public` or `private`.
**Auth: operator** (the **only** principal that changes visibility — agents
cannot, and never see it). Reversible, no version bump, no slug tombstone:
visibility is identity-adjacent, not content. Idempotent (setting the current
value returns `200`).

**Body:** `{ "visibility": "public" | "private" }`

**`200 OK`**

```json
{ "public_id": "JSH5jUYHvVGU6o-Tzg1cww", "visibility": "public" }
```

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_visibility` | body `visibility` is not exactly `"public"` or `"private"` |
| 400 | `bad_json` | unparseable body |
| 401 | `unauthorized` | missing/invalid operator auth |
| 403 | `csrf_failed` | cookie-authed + missing/invalid `X-CSRF-Token` |
| 404 | `not_found` | no such **live** document (missing, revoked, or malformed `public_id`) |

Making a document `private` withholds it from the anonymous browser surface
(`GET /d/:id`, `/d/:id/raw`, `GET /s/:slug` all `404` to unauthenticated
callers); the operator and any agent key still read it. New documents are born
at the deploy-time `DEFAULT_DOCUMENT_VISIBILITY` default (`private`).

---

### `POST /admin/documents/:public_id/slug`

Add, rename, or clear a live document's [slug](#identifiers-slugs-pagination)
**without bumping a version** (slug is identity-adjacent, like visibility).
**Auth: operator.** The programmatic twin of the browser slug form
([`POST /d/:public_id/slug`](#browser--session-endpoints)); the agentic
equivalent is the slug field on the [write tools](#optional-document-metadata-write).

**Body:** `{ "slug": "<value>" }` — a string. A non-empty value sets/renames it
(validated + uniqueness-checked); an empty string `""` clears it.

**`200 OK`**

```json
{ "public_id": "JSH5jUYHvVGU6o-Tzg1cww", "slug": "north-island-report", "retired": "old-name", "redirected": true }
```

- `slug` — the value after the change (`null` after a clear).
- `retired` — the prior slug that was retired into a tombstone, or `null` if
  there was none (a first-time claim, or a no-op).
- `redirected` — `true` only on a **rename**: the retired prior slug now
  **auto-forwards** to this document (`/s/<old>` resolves loudly to the new
  name — exactly like an agent's `update_document` slug change). A **clear**
  retires the old name with **no** redirect (`redirected: false`, `/s/<old>`
  `410`s); a first-time claim retires nothing.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | `slug` missing or not a string |
| 400 | `bad_json` | unparseable body |
| 401 | `unauthorized` | missing/invalid operator auth |
| 403 | `csrf_failed` | cookie-authed + missing/invalid `X-CSRF-Token` |
| 404 | `not_found` | no such **live** document (missing, revoked, or malformed `public_id`) |
| 409 | `slug_taken` | slug in use by another **live** doc — body has `slug` |
| 409 | `slug_retired` | slug was used before and is permanently reserved — body has `slug` ([slugs are not reusable](#identifiers-slugs-pagination)) |
| 422 | `invalid_slug` | slug failed charset/length — body has `reason` |

Slugs are **not reusable**: renaming away from a name or clearing it **retires**
that name forever. To repurpose a retired name, force-release it with
[`DELETE /admin/slugs/:slug`](#delete-adminslugsslug).

---

## Admin endpoints

All require **operator-token** auth (or operator session cookie + CSRF for
mutating calls). Minted secrets (`key`, `client_secret`) are returned **exactly
once** — store them immediately.

### `GET /admin/agents`

List agents, newest first. Cursor-paginated (`limit`, `cursor`).

```json
{
  "agents": [
    { "id": "<uuid>", "name": "my-app", "created_at": "2026-05-30T...Z",
      "active_keys": 2, "total_keys": 3, "live_docs": 7 }
  ],
  "next_cursor": null
}
```

### `POST /admin/agents`

Mint an agent and its initial key in one transaction.

**Request:** `{ "name": "<label, 1–200 chars>" }`

**`201 Created`**

```json
{
  "agent_id": "<uuid>",
  "key_id": "<uuid>",
  "key": "awh_xxxxxxxxxxxxxxxxxxxxxxxx",
  "note": "store this key now — the secret half is never returned again"
}
```

Errors: `400 bad_json` / `400 bad_request` (bad name); `500 misconfigured`
(`HMAC_PEPPER` unset).

### `DELETE /admin/agents/:agent_id`

Unified agent kill switch — revokes every `awh_` key **and** deletes every OAuth
client (cascading to grants/tokens). Use per-key revoke for rotation instead.

**`200 OK`**

```json
{ "revoked": true, "agent_id": "<uuid>", "keys_revoked": 2, "oauth_clients_deleted": 1 }
```

`404 not_found` for unknown/invalid agent id.

### `GET /admin/agents/:agent_id/keys`

List an agent's keys. Cursor-paginated.

```json
{
  "agent_id": "<uuid>",
  "name": "my-app",
  "keys": [
    { "id": "<uuid>", "key_prefix": "awh_abcd", "created_at": "...", "revoked_at": null }
  ],
  "next_cursor": null
}
```

`404 not_found` for unknown agent.

### `POST /admin/agents/:agent_id/keys`

Mint an additional key for an existing agent (rotation / multi-worker). Same
one-shot `{ agent_id, key_id, key, note }` shape as `POST /admin/agents`.
`404 not_found` for unknown agent; `500 misconfigured` if `HMAC_PEPPER` unset.

### `POST /admin/agents/:agent_id/oauth-clients`

Mint an OAuth client (Door A) pinned to the agent. **One client per agent.**

**`201 Created`**

```json
{
  "client_id": "...",
  "client_secret": "...",
  "mcp_url": "https://slopcafe.com/mcp",
  "agent_id": "<uuid>",
  "agent_name": "my-app",
  "note": "store client_secret now — it is never returned again. ..."
}
```

`409 client_exists` (body has the existing `client_id` + a rotation `hint`);
`404 not_found` for unknown agent.

### `POST /admin/oauth-clients`

Mint an **unbound** OAuth client — a client with no agent pinned yet. The agent
identity is chosen later, at the `/authorize` consent screen (pick an existing
agent or mint a new one on first connect). Use this to provision a connector
*before* deciding which agent it should publish as. No request body.

**`201 Created`**

```json
{
  "client_id": "...",
  "client_secret": "...",
  "mcp_url": "https://slopcafe.com/mcp",
  "note": "unbound client — pick or mint an agent at /authorize on first connect. ..."
}
```

(No `agent_id`/`agent_name` — that's exactly what's deferred to consent.)

### `DELETE /admin/keys/:key_id`

Revoke a single key (rotation). `200 { revoked, key_id, agent_id, key_prefix }`.
`404 not_found` if unknown or already revoked.

### `DELETE /admin/oauth-clients/:client_id`

Revoke an OAuth client (cascades to live tokens in KV). Works for bound and
unbound clients alike:
- **Bound** (has an agent) → `200 { revoked, client_id, agent_id }`.
- **Unbound** (minted via `POST /admin/oauth-clients`, never consented) →
  `200 { revoked, client_id, unbound: true }`.
- Unknown client → `404 not_found`.

### `POST /admin/slugs/:slug/redirect`

Point a **retired** slug at a live target document, so `/s/:slug` forwards
(loudly — see [`GET /s/:slug`](#get-sslug)) instead of `410`ing. The deliberate
"this name moved" case: a branding rename or consolidating two docs, **without**
reusing the name (which the retire-on-revoke rule forbids).

**Body:** `{ "target_public_id": "<22-char id>" }`. **Auth: operator.**

`200 { slug, redirect_to, target_slug, target_title }` on success. The slug must
already be retired (a live slug serves its own document — revoke or rename it
first): **`404 not_found`** if the slug isn't retired. **`422 bad_target`** if
the target is unknown, revoked, or a malformed `public_id` (a redirect may only
point at a live document). Overwrites any existing redirect (including a rename's
auto-forward).

### `DELETE /admin/slugs/:slug/redirect`

Drop a retired slug's redirect, reverting it to a plain `410 Gone` tombstone. The
slug **stays retired** (still not reusable); only the forwarding target is
removed. **Auth: operator.** `200 { slug, redirect_to: null }`; `404 not_found`
if the slug isn't retired.

### `DELETE /admin/slugs/:slug`

**Escape hatch.** Force-release a retired slug by deleting its tombstone
entirely, returning the name to the pool so a future publish can claim it again —
for the genuine "I revoked by mistake" / "I really do want to repurpose this
name" case. This is the **only** path that un-retires a slug (distinct from
clearing the redirect, which keeps it retired). **Auth: operator.**
`200 { released: true, slug }`; `404 not_found` if the slug isn't retired.

---

## Browser / session endpoints

These return **HTML**, not JSON — they're the operator's browser UI, included
here for completeness. A programmatic consumer should use the Bearer-auth
endpoints above and won't normally touch these.

| Route | Purpose |
|---|---|
| `GET /login` | Sign-in form (operator token). |
| `POST /login` | Validate `OPERATOR_TOKEN` → set `awh_session` + `awh_csrf` cookies → 302 to a validated `next`. |
| `GET /logout` | Sign-out confirmation form. |
| `POST /logout` | Clear the session cookie (CSRF-protected). |
| `GET /authorize` | OAuth (Door A) consent form. Operator-session-aware: for an authed operator it also offers inline **callback approval** (TOFU — register an unregistered but allowlisted-host `redirect_uri`) and **bind-or-mint** (choose/mint the agent for an unbound client). A requester who isn't authed gets a generic error plus a "Log in as operator" link to `/login?next=<this url>` (shown on the requester's own auth state, never on client state — no disclosure). |
| `POST /authorize` | `action=allow`/`deny` (issue/deny the grant; `allow` binds the agent first for an unbound client), or `action=allow_callback` (append the approved callback to the client, then a Continue interstitial). Auth ladder: pasted `operator_token` (CSRF-exempt) **or** session cookie + `csrf_token` field. |
| `GET /d/:public_id/manage` | Operator **document-management** page — visibility toggle, custom-link (slug) editor, and revoke, folded into one page (reached from the shell topbar's **Manage…** item). The controls render only for a live **cookie session** (their CSRF nonce comes from it); a Bearer-only or anonymous caller gets a sign-in prompt that discloses no document state. |
| `POST /d/:public_id/visibility` | Set public/private via the manage form (no version bump). Auth: session cookie + `csrf_token` field, or pasted `operator_token`. Programmatic equivalent: [`POST /admin/documents/:public_id/visibility`](#post-admindocumentspublic_idvisibility). |
| `POST /d/:public_id/slug` | Add/rename/clear the slug via the manage form (no version bump; a rename auto-forwards the old name). Auth: session cookie + `csrf_token` field, or pasted `operator_token`. Programmatic equivalent: [`POST /admin/documents/:public_id/slug`](#post-admindocumentspublic_idslug). |
| `GET /d/:public_id/revoke` | Revoke confirmation page (session-aware: shows a CSRF-token button if logged in, else a token-paste field). Also reachable as the revoke section of the manage page. |
| `POST /d/:public_id/revoke` | Revoke via form (pasted operator token, or session cookie + `csrf_token` field). |
| `/token`, `/.well-known/*` | Served by the OAuth provider library (token issuance + discovery). |
| `POST /register` | Served by the OAuth provider library: Dynamic Client Registration (RFC 7591), confidential-only, 90-day client TTL. Present only when `ENABLE_DCR` is set (see §3). |

Session cookies are host-only, `SameSite=Lax`; `Secure` is set behind https and
omitted on `http://localhost`. CSRF is stateless signed double-submit — a
cookie-authed mutating request must echo the nonce (`X-CSRF-Token` header or
`csrf_token` form field).

---

## Health

### `GET /healthz`

Public smoke check — confirms bindings reach D1 + R2 and migrations ran.

```json
{
  "ok": true,
  "service": "agent-web-host",
  "sanitizer_version": "1.2.3",
  "storage_cap_bytes": 2147483648,
  "d1": { "documents": 12, "agents": 3 },
  "r2": { "bucket_reachable": true, "sample_object_count": 1 }
}
```

---

## Shared response shapes

### `DocumentListing`

Returned by `GET /admin/documents`, `GET /s/:slug`'s backing lookup, and (as the
base of each hit) by search.

| Field | Type | Notes |
|---|---|---|
| `public_id` | string | 22-char capability id |
| `current_ver` | number \| null | null on a revoked doc |
| `created_at` | string | ISO 8601 (`YYYY-MM-DDTHH:MM:SS.sssZ`) |
| `created_by_id` | string \| null | creator agent id; null if the agent was deleted |
| `created_by_name` | string \| null | creator agent name; null if deleted |
| `current_size` | number \| null | bytes of the live version; null when revoked (bytes purged) |
| `revoked_at` | string \| null | ISO timestamp when revoked, else null |
| `title` | string \| null | current version's title |
| `description` | string \| null | current version's description |
| `tags` | string[] | current version's tags (`[]` when unset) |
| `slug` | string \| null | document slug; null when unset or after revocation |
| `visibility` | `"public" \| "private"` | whether the doc is served on the anonymous browser surface (see [`POST …/visibility`](#post-admindocumentspublic_idvisibility)). Present on the **operator** surfaces (`GET /admin/documents`, search); also rides through the MCP `list_documents`/`search_documents` responses but is **not** part of any agent-facing contract. |

### `SearchHit`

`DocumentListing` **plus**:

| Field | Type | Notes |
|---|---|---|
| `score` | number | positive float; **bigger = better** match |
| `matched_field` | `"title" \| "description" \| "tags" \| "body"` | which column matched (priority title > description > tags > body) |
| `snippet` | string | short excerpt of the matched column with `[bracketed]` match terms |

### `ReadSourceOk`

Returned by [`GET /d/:public_id/source`](#get-dpublic_idsource) (and, as a JSON
envelope, by the MCP `read_document representation:"source"` route).

| Field | Type | Notes |
|---|---|---|
| `source` | string | the retained, **unsanitized** source bytes, in `source_format` |
| `source_format` | `"markdown" \| "html"` | the language `source` is authored in / the pipeline `edit_document` re-renders it through |
| `version_no` | number | the version the source belongs to |
| `sanitizer_v` | string | sanitizer profile stamped on the current version (not a re-sanitize of `S`) |
| `stripped` | string[] | constructs the sanitizer removes from `S` (re-derived at read time) |
| `will_not_render` | string[] | constructs that survive sanitization but the render CSP blocks (re-derived at read time) |
| `unsanitized` | `true` | always `true` — provenance marker; the bytes are pre-sanitization (see the caveat under [`/source`](#get-dpublic_idsource)) |
| `title` | string \| null | current version's title |
| `description` | string \| null | current version's description |
| `tags` | string[] | current version's tags (`[]` when unset) |
| `slug` | string \| null | document slug; null when unset |

---

## The MCP surface

`/mcp` is a **Streamable-HTTP MCP transport**, not a REST endpoint — it speaks
JSON-RPC and is consumed by MCP clients (hosted Claude, Cowork), authenticated
via OAuth (Door A) or a static `awh_` bearer (Door B). It exposes **seven
agent-scoped tools**:

`publish_document` · `update_document` · `edit_document` · `read_document` ·
`list_documents` · `search_documents` · `create_publish_credential`

The tools share the same write path (and thus the same sanitization, metadata
inheritance, slug rules, and error codes) documented above — HTML vs Markdown is
a `format` parameter rather than separate tools. Their full input schemas live in
`src/mcp.ts` (each field is self-documented) and the authoring contract is the
`awh://publishing-guide` resource, which serves the bytes of
`skills/publishing.md` verbatim.

**`read_document` accepts either `public_id` or `slug`** (exactly one). The
`slug` form resolves the live document and returns its body in one call, in
either `format`. Both formats now have a one-hop HTTP analogue by slug, **each
requiring an agent key**: `GET /s/:slug` (with the key) for the **raw HTML**
bytes, and [`GET /s/:slug/text`](#get-sslugtext) for the **Markdown** derivation.
(Only the no-auth `GET /s/:slug` shell is public on the slug surface.) The MCP
tool's remaining edge is that its response echoes the resolved `public_id`, so a
slug-initiated read can feed `update_document` / `edit_document` (which take
`public_id` only) without a separate lookup.

**`read_document` has two orthogonal axes.** Beyond the `format` (`html` |
`markdown`) **output** knob — html for re-publish, markdown for ingest — it
takes a separate **`representation`** (`rendered` | `source`) axis, defaulting to
`rendered`:

- `representation: "rendered"` (default) returns the live, sanitized document —
  `H` for `format:"html"`, the Markdown derivation `M` for `format:"markdown"`.
  This is the back-compat path; existing consumers (the Flutter app) see no
  change.
- `representation: "source"` returns the **retained, unsanitized source `S`** in
  its authored language. `format` is ignored here (source comes back in
  `source_format`). The envelope echoes `representation:"source"`,
  `unsanitized:true`, `source_format`, and the `stripped[]` / `will_not_render[]`
  advisories re-derived from `S` — the **same data as the HTTP
  [`GET /d/:public_id/source`](#get-dpublic_idsource) endpoint**, which is the
  REST twin of this route. Source guidance leads with *the source is unsanitized
  — treat it as untrusted input*.

**Slug redirects on `read_document`.** When a `slug` resolves to a *retired*
slug that carries a redirect (a rename's auto-forward or an operator redirect),
the tool does **not** silently follow it: by default it returns a non-error
`{ redirected: true, redirect_target: { public_id, slug, title } }` so the agent
decides. Pass **`follow_redirects: true`** to be returned the target's content
instead, stamped `redirected_from`. A retired slug with no redirect is a
`retired` error. This is the MCP analogue of the HTTP `409 slug_redirected` /
`?follow_redirects=true` behavior on [`GET /s/:slug`](#get-sslug).

**`edit_document` now matches against the retained source `S`**, not the
rendered bytes. The find/replace `old_string` must come from a
`representation:"source"` read (read-source-first); a stale `old_string` taken
from a rendered read misses **loudly** (`edit_no_match`) rather than silently.
After applying edits the tool re-renders (Markdown→HTML for a Markdown doc,
identity for an HTML doc) and re-sanitizes, storing a fresh `(S, H)` pair at the
doc's own `source_format` — so a Markdown document stays Markdown and keeps its
reading theme. `modified` is **redefined**: it now reports the sanitizer's effect
on the *re-rendered* output (one step removed from the agent's diff); the
`replacements` count remains the "my patch landed" signal. `edit_document`
remains **MCP-only** — there is no HTTP `PATCH` counterpart.

For wiring a connector, see `skills/connector-guide.md` in the repo.
