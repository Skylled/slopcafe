# Slopcafe HTTP API reference

The complete HTTP surface of the Slopcafe Worker (production:
**`https://slopcafe.com`**). This is the contract a consumer — a client app
(e.g. the Flutter app), a script, or an agent working on a connected project —
needs to publish, read, and manage documents **without** reading the Worker's
source.

- **New here?** [`http-api-quickstart.md`](http-api-quickstart.md) is the
  five-minute on-ramp — base URL, auth header, the four routes a script actually
  needs, and a pointer to `/openapi.json`. This document is the full reference.
- **Authoring rules** (what HTML/CSS/SVG is allowed in a document body) live in
  `skills/publishing.md` — that's a separate, body-content contract, not an
  endpoint reference. Read it before publishing anything with layout or inline
  SVG. It is also published on Slopcafe itself (slug `slopcafe-publishing-guide`)
  so a connected agent can read it without repo access.
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
  - [`HEAD` requests](#head-requests)
  - [Content types (write)](#content-types-write)
  - [Optional document metadata (write)](#optional-document-metadata-write)
  - [Published vs current version](#published-vs-current-version)
  - [Optimistic concurrency (`If-Match` / `ETag`)](#optimistic-concurrency-if-match--etag)
  - [Byte-exact integrity (`X-Content-SHA256`)](#byte-exact-integrity-x-content-sha256)
  - [Identifiers, slugs, pagination](#identifiers-slugs-pagination)
- [Document endpoints](#document-endpoints) — publish, list, search, packs, update, read, source, links, curate (tags/status), revoke
- [Listing & search](#listing--search) — list, hybrid search, vectors backfill, link-graph backfill + orphans, operator authoring (publish/update), version history + restore, set visibility, publish a version (promote), set slug, set tags, set lifecycle status
- [Admin endpoints](#admin-endpoints) — agents, keys, OAuth clients, slug redirects
- [Browser / session endpoints](#browser--session-endpoints)
- [Console (operator web UI)](#console-operator-web-ui)
- [Health](#health)
- [Machine-readable spec (`/openapi.json`)](#machine-readable-spec-openapijson)
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
(`POST /d`, `PUT /d/:id`), authenticated reads (`GET /d/:id` with the header),
and document discovery ([`GET /d`](#get-d) list + [`GET /d/search`](#get-dsearch)
+ [`GET /d/pack`](#get-dpack) context packs).
It does **not** grant access to the `/admin/*` surface or to `DELETE /d/:id` —
those need the operator token.

> **Listing/search/packs are reachable with an agent key — `GET /d` +
> `GET /d/search` + `GET /d/pack`.**
> These are the HTTP twins of the MCP `list_documents` / `search_documents` /
> `load_context_pack` tools (same response shapes, same cores), gated by an
> agent key OR the operator token. `GET /d?slug=<slug>` is the **slug → `public_id` lookup** a
> headless client uses to address the id-only [`PUT /d/:id`](#put-dpublic_id),
> [`/source`](#get-dpublic_idsource), and [`/links`](#get-dpublic_idlinks)
> routes. The `/admin/documents` and `/admin/documents/search` routes still
> exist and are operator-gated; they are byte-identical in shape — the only
> difference is the auth door (and the `403 csrf_failed` an operator cookie can
> raise, which the agent surface never returns).

Short-lived agent keys (with an expiry) also exist for the byte-exact publish
path; they're minted on demand via the MCP `create_publish_credential` tool and
behave identically to a normal `awh_` bearer until they expire. The tool's
returned `recipe` references the key via an `$AWH_KEY` env var (you `export
AWH_KEY=` the `key` field once) rather than inlining it, so the token stays off
the curl command line and shell history — the `recipe` itself carries no secret;
only the `key` field does.

### 2. Operator token — `OPERATOR_TOKEN` bearer  *(admin + revoke)*

The single shared operator secret. Send it the same way:

```
Authorization: Bearer <OPERATOR_TOKEN>
```

Required by every `/admin/*` endpoint and by `DELETE /d/:id`. Bearer-authed
operator calls are **CSRF-exempt** (so curl/scripts are unaffected).

> **Operator ≥ agent on the read surfaces.** The operator is the apex principal,
> so anywhere an agent key reads, the operator token reads too. It is **accepted**
> (not just the agent key) on the credentialed reads — the content-negotiated
> bytes of [`GET /d/:public_id`](#get-dpublic_id) / [`GET /s/:slug`](#get-sslug),
> [`GET /d/:public_id/text`](#get-dpublic_idtext),
> [`GET /d/:public_id/source`](#get-dpublic_idsource),
> [`GET /d/:public_id/links`](#get-dpublic_idlinks), and
> [`GET /s/:slug/text`](#get-sslugtext) — and on the discovery surfaces
> [`GET /d`](#get-d) / [`GET /d/search`](#get-dsearch) / [`GET /d/pack`](#get-dpack)
> and the two agent-door classification writes
> [`PUT /d/:id/tags`](#put-dpublic_idtags) / [`PUT /d/:id/status`](#put-dpublic_idstatus).
> On `/text`, `/source`, `/links`, and `/s/:slug/text`
> the operator **browser-session cookie** is accepted on those `GET`s as well (they
> resolve the full principal, operator-first). Only **anonymous** is refused.

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
pre-registration-only. See [`dcr-design.md`](design/dcr-design.md).
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

**`message` is prose and may change.** Several codes now carry a *hint* in the
message rather than a new field — a `401` names `/openapi.json` and `/healthz`,
and a document `404` whose path segment looks like a **slug** rather than a
22-char `public_id` names [`GET /d?slug=…`](#get-d) as the conversion. Hints are
derived **only from the caller's own request** (never from anything the server
looked up), so a private or revoked document's `404` stays byte-identical to a
nonexistent one's for the same URL.

**Every JSON error also carries a `Link` header** pointing at the machine-readable
spec, using the IANA `service-desc` relation (RFC 8631):

```
Link: </openapi.json>; rel="service-desc"
```

It is a relative reference, so it resolves against whichever origin answered —
a client holding nothing but a base URL and a key can bootstrap from any failed
request. [`GET /healthz`](#get-healthz) carries the same pointers in its body.
(The OAuth provider library's own endpoints — `/token`, `/register`,
`/.well-known/*` — are outside this convention.)

### `HEAD` requests

Every `GET` endpoint also answers `HEAD`: the request is routed through the same
`GET` handler, so the response carries **identical status and headers**
(`Content-Type`, `ETag`, `Content-Security-Policy`, …) with an **empty body**.
So `curl -I https://slopcafe.com/d/:id/raw` reports the document's real
`text/html` (or an opaque `404` for a missing/private/revoked doc), not a stand-in
`application/json`. All gates run unchanged — visibility/auth still apply (a
private doc `HEAD`s as the same opaque `404` as a missing one), and
`If-None-Match` still yields a bodyless `304`. Because the headers are the real
ones, a credentialed `HEAD` on `/raw` is also the cheapest way to read the
writer-preflight `x-doc-current-version` (see [optimistic
concurrency](#optimistic-concurrency-if-match--etag)). There is no body to
compute a `Content-Length` from, so (as with `GET`) the rendered-byte responses
don't set one. `HEAD` is not modelled separately in `openapi.json` — it mirrors
the `GET`.

### Content types (write)

`POST /d` and `PUT /d/:id` require a body `Content-Type` of:

- `text/html` — raw HTML, sanitized then stored.
- `text/markdown` (or `text/x-markdown`) — parsed as CommonMark + GFM to HTML,
  then sanitized.

Any other type → **`415 unsupported_media_type`**. Charset parameters
(`; charset=utf-8`) are ignored. Either way, the stored bytes are **sanitized
static HTML** — see `skills/publishing.md` for what survives sanitization.

**Character encoding is UTF-8 end to end.** The request body and the `X-Doc-*`
headers below are read as UTF-8; the sanitizer decodes character references to
literal UTF-8 on storage (`&mdash;` → `—`), leaving only `&amp; &lt; &gt; &quot;`
and `&nbsp;` encoded. Served responses declare it: rendered HTML is
`text/html; charset=utf-8` (`/d/:id/raw`, `/s/:slug`), the text view is
`text/markdown; charset=utf-8`, and JSON is UTF-8. Send non-ASCII literally —
there's no need to entity-encode or ASCII-fold, including in `X-Doc-Title` /
`X-Doc-Description`. See `skills/publishing.md` §"Character encoding".

### Optional document metadata (write)

Set via request headers on `POST /d` / `PUT /d/:id` (the MCP write tools take
the same values as named fields):

| Header | Meaning |
|---|---|
| `X-Doc-Title` | Title (≤300 chars). **Omitted** → derive from the first `<h1>` (or first ~80 chars of text). **Empty** → re-derive. Shown as `{title} \| Slopcafe` in the browser tab. |
| `X-Doc-Description` | Short description (≤500 chars). Omitted → null. Empty → null. Surfaces in `<meta name=description>` and link previews. |
| `X-Doc-Tags` | Comma-separated tags. Charset restricted to `[A-Za-z0-9_-]` — invalid chars are **silently stripped**. Max 10 tags × 32 chars; deduped. **Document-level** (like `slug`): on `PUT`, **omitting** the header leaves the document's tags untouched (no version bump, no `ETag` churn); an explicit value **replaces** them; an empty value **clears** them. |
| `X-Doc-Slug` | Optional unique handle, charset `/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/`. Invalid → **`422 invalid_slug`**; in use by a live doc → **`409 slug_taken`**; previously used and retired → **`409 slug_retired`** (slugs are **not reusable** — see [slugs](#identifiers-slugs-pagination)). On an update to a **`public`** document an agent key **may not change it at all** → **`403 slug_locked`** (see [`PUT /d/:id`](#put-dpublic_id)); the operator write doors are unaffected. |

**Inheritance on update** (`PUT`): an *omitted* `X-Doc-Title` /
`X-Doc-Description` header inherits the prior version's value (these are
**per-version**); an *omitted* `X-Doc-Tags` / `X-Doc-Slug` leaves the
**document-level** value untouched (tags and slug are document-level, not
per-version — see [Optional document metadata](#optional-document-metadata-write)).
An explicit **empty** value clears the field (and for title, re-derives from the
new content; for slug, drops the current slug; for tags, clears them). Note that
renaming or dropping a slug **retires** the old value permanently — it is not
freed for reuse. See [slugs](#identifiers-slugs-pagination). Re-sending a
document's *existing* slug on every update stays a clean no-op (it's what
publishing scripts do); only an actual rename or clear counts as a change — which
is the distinction the `slug_locked` rule above is keyed on.

### Published vs current version

A document carries **two** version pointers, and on the browser byte path they
are not always the same number (migration 0018):

- **`current_ver`** — what was written last. Every publish / update / edit /
  restore advances it, on either door.
- **`published_ver`** — what a **`public`** document *renders*. Only the operator
  moves it, via
  [`POST /admin/documents/:id/promote`](#post-admindocumentspublic_idpromote).

The serving rule, in full:

```
served version = (visibility === "public" && published_ver !== null)
                   ? published_ver
                   : current_ver
```

Equivalently: **a `public` document serves `published_ver ?? current_ver`; a
`private` document always serves `current_ver`.** Note what the rule does *not*
contain — a term for who is asking. A public document serves its published
version to anonymous visitors, agent keys and the operator alike, so the bytes on
the open web are the bytes anyone can check.

**Why the split exists.** Under the single-tenant trust model any active agent
key may overwrite any live document ([`PUT /d/:id`](#put-dpublic_id) is
deliberately not scoped by creator), and some documents are `public`. With one
pointer, a single ordinary, fully-authorized write would push whatever an agent
produced onto the anonymous internet — never touching the operator-only
[`visibility`](#post-admindocumentspublic_idvisibility) flag, and with no human
in between. So writing and publishing were separated: an agent still writes any
document it likes, it just no longer decides what the world reads.

**What is pinned, and what is not.** Only the **HTML byte path** moved —
[`GET /d/:id`](#get-dpublic_id), [`/d/:id/raw`](#get-dpublic_idraw),
[`GET /s/:slug`](#get-sslug), and the landing page `GET /`. Everything
machine-readable stays on `current_ver`, deliberately:
[`/text`](#get-dpublic_idtext), [`/source`](#get-dpublic_idsource),
[`/links`](#get-dpublic_idlinks), every MCP read, list, search, context packs,
the search index and the link graph. An agent reading its own newest work back
sees it immediately; only *readers* wait.
[`/d/:id/v/:n`](#get-dpublic_idvn-and-get-dpublic_idvnraw) is an explicit version
read and is likewise untouched — it's how the operator previews an unpublished
version before promoting it.

**How a version becomes published.** Three ways, none of them an agent:

- **Born public** — a document created `public` (an operator
  [`POST /admin/documents`](#post-admindocuments) with `visibility: "public"`, or
  a deployment whose `DEFAULT_DOCUMENT_VISIBILITY` is `public`) publishes `v1` at
  birth, so it is never public with nothing to serve.
- **Flipped public** — [the visibility
  flip](#post-admindocumentspublic_idvisibility) fills `published_ver` from
  `current_ver` **if nothing was published yet**; a pointer already staged is
  kept.
- **Promoted** — the operator names a version outright
  ([`POST /admin/documents/:id/promote`](#post-admindocumentspublic_idpromote)),
  on a public *or* a private document.

Revoking a document clears both pointers along with the bytes.

**What a consumer sees.** Every [`DocumentListing`](#documentlisting) row carries
`published_ver` (and `published_source_sha256`); every
[`VersionListing`](#versionlisting) row carries `is_published`; every MCP write
and read envelope echoes `published_version`. A `published_ver` **below**
`current_ver` on a public document is the signal that a write is stored but not
live — report it as awaiting the operator, not as "the page is updated". On a
private document the pointer is a *staged choice*, not a description of what is
being served today.

### Optimistic concurrency (`If-Match` / `ETag`)

- Every write returns an `ETag` of the form `"v<n>"` (e.g. `"v3"`) — the version
  it just wrote, which is also the new `current_ver`. (A *read* `ETag` is a
  different question on the render path; see the preflight note below.)
- **`PUT /d/:id` requires an `If-Match` header** (omitting it → **`428
  precondition_required`**). Send the version you expect to replace as a strong
  tag — `If-Match: "v3"` — or `If-Match: *` to skip the check (last-write-wins).
- **Accepted `If-Match` forms.** The quoted strong tag `"v<n>"` is canonical,
  but three lenient spellings of "version `n`" are also accepted, so the integer
  `version` a read returns can be sent as-is: `If-Match: v3`, `If-Match: 3`, and
  `If-Match: "3"` all mean the same as `If-Match: "v3"`. (This mirrors the
  `If-None-Match` tolerances on the conditional-GET render path.)
- Single tag only. No weak (`W/`) tags, no multi-tag lists. A malformed value →
  **`400 bad_request`**; a stale version → **`412 precondition_failed`** with
  `current_version` in the body.

**Preflighting `If-Match` from a read — use `x-doc-current-version`, not the
render `ETag`.** A client that derives `If-Match` by reading the document first
(a `HEAD /d/:id/raw` + `ETag`, which is what an `--if-match auto` mode does) must
stop reading it off `/raw`: that route now tags the **served** version
([published vs current](#published-vs-current-version)), so on a public document
with a pending promote the `ETag` names an *older* version than the one a `PUT`
would replace, and the write comes back `412` for no real reason.
[`GET /d/:id/raw`](#get-dpublic_idraw) therefore also returns
**`x-doc-current-version: <n>`** — the document's newest version, which is
exactly the number `If-Match` wants. Prefer that header; fall back to the `ETag`
when it's absent. The fallback stays correct for private documents (the two
numbers are equal by construction) and for any server predating this change.

> **The header is emitted only to a credentialed caller** — an agent key or the
> operator — on both the `200` and the `304`. An anonymous request gets **no such
> header** rather than a clamped one: the existence of unpublished newer bytes is
> precisely what the pinning withholds from readers, and a number that lied to
> whoever later gained a credential would be worse than silence.

**`/raw` and `/text` can advertise different `ETag`s for the same document, and
that is correct.** They are different representations of it: `/raw` tags the
bytes it served (the published version on a public doc), `/text` tags the current
version it converted. On a private document — or a public one whose promote is
caught up — they agree. When they don't, neither is stale: read the pair as "what
the world sees" vs "what was last written", and don't reconcile them by
preferring one.

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
  — never construct or modify them. Default ordering is
  `(created_at DESC, id DESC)`. **Search is not paginated** (see
  [search](#get-admindocumentssearch)).
- **Ordering / the change feed (`?order=`, migration 0017).** The two **document**
  list surfaces ([`GET /d`](#get-d) and [`GET /admin/documents`](#get-admindocuments))
  also walk `(updated_at DESC, id DESC)` with `?order=updated` — most-recently-**changed**
  first, where a change is a new version *or* a classification edit (tags / slug /
  visibility / status / a [publish](#post-admindocumentspublic_idpromote), none of
  which bump a version) *or* a revoke. Combined with
  `?updated_since=<ISO-8601>` (inclusive window on `updated_at`) that turns the
  list into a **corpus change feed**: "what moved since I last looked", in the
  call a consumer was already making. An unknown `order` or an unparseable
  `updated_since` → **`400 bad_request`** (reject, never a silent fallback).
  A **cursor carries the ordering that minted it**, so replaying an
  `order=updated` cursor under the default ordering is a hard **`400 bad_cursor`**
  — reading the wrong column's timestamp would skip or repeat an arbitrary slice
  with no signal. The other lists (agents, keys, the backfill sweeps) have only
  the created ordering and ignore `order`; search accepts `updated_since` (it's a
  filter) but **not** `order` (relevance ranking is its ordering, which is also
  why it has no cursor).

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
  "source_sha256": "e3b0c4…b855",
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
- `source_sha256` — SHA-256 of the **retained source** bytes you just wrote
  (`null` only on a legacy/un-backfilled doc). For a byte-exact publish this
  equals `sha256sum` of the file you sent, so you can cache it and later confirm
  a local copy is still the current source — compare it to the same file's
  `sha256sum`, or to a list row's `current_source_sha256` — and skip a source
  re-read before an edit. (Matches `sha256sum file` only for well-formed UTF-8
  published as-is; a reformatted or non-UTF-8 file won't match — a safe miss that
  just costs a re-read.)
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
| 422 | `too_deep` | sanitized render nests past 512 levels — body has `limit`/`depth`. Flatten the markup (fewer wrapper elements). `depth` is exact when the post-sanitize check rejects, but **saturates at `513`** ("at least this deep") when the cheap pre-parse screen rejects first — treat it as a floor, not a measurement. |
| 409 | `slug_taken` | slug in use by another **live** doc — body has `slug` |
| 409 | `slug_retired` | slug was used before and is permanently reserved — body has `slug` (slugs are not reusable) |

### `GET /d`

List documents (including revoked, with `revoked_at` set), newest first.
**Auth: agent key OR operator** (`requireReader` — never anonymous). This is the
HTTP twin of the MCP `list_documents` tool and of the operator-gated
[`GET /admin/documents`](#get-admindocuments) — **same response shape, same
core**. Cursor-paginated.

**Query params** are identical to [`GET /admin/documents`](#get-admindocuments):
`limit` (1–200, default 50), `cursor`, `order` (`created` (default) | `updated`),
`updated_since` (ISO-8601), `tag` (repeatable; AND), `slug` (exact match),
`status` (`active` | `deprecated`).

`GET /d?slug=<slug>` is the **slug → `public_id` resolver**: it returns the
0-or-1 row whose slug matches, so a headless client can discover the `public_id`
it needs for the id-only [`PUT /d/:id`](#put-dpublic_id),
[`/source`](#get-dpublic_idsource), [`/links`](#get-dpublic_idlinks),
[`/tags`](#put-dpublic_idtags), and [`/status`](#put-dpublic_idstatus) routes.

**Change feed (migration 0017).** `?order=updated` sorts by `updated_at`
(most-recently-changed first) instead of `created_at`, and `?updated_since=` is
an **inclusive** window on the same column:

```
GET /d?order=updated&updated_since=2026-07-01T00:00:00Z&limit=200
```

Every mutator stamps `updated_at` — a new version, a
tags/slug/visibility/status/publish change (none of which bump a version), and a
revoke — so the feed reports reclassification, promotion and death, not just
content writes. It is **inclusive** on purpose: a resuming consumer re-sees the
boundary row rather than risking a skip
at a shared millisecond. Revoked documents **do** appear (revoke is a change), so
check `revoked_at` before treating a row as readable. Each row also carries
`current_version_at`; an `updated_at` well ahead of it means the last change was
classification, not content. See
[the pagination conventions](#identifiers-slugs-pagination) for the cursor
ordering rule.

**`200 OK`**

```json
{
  "documents": [ /* DocumentListing rows — see Shared response shapes */ ],
  "next_cursor": "eyJ0cyI6Li4ufQ"
}
```

Errors: `400 bad_limit` / `400 bad_cursor` (including a cursor replayed under a
different `order`) / `400 bad_slug` / `400 bad_status` / `400 bad_request`
(unknown `order`, or unparseable `updated_since`); `401 unauthorized`.

### `GET /d/search`

**Hybrid (keyword + semantic) search** over **live** documents.
**Auth: agent key OR operator** (`requireReader`). The HTTP twin of the MCP
`search_documents` tool and of [`GET /admin/documents/search`](#get-admindocumentssearch)
— **same response shape, same core, same query params** (`q` **required**,
`mode`, `limit`, `tag`, `slug`, `status`, `updated_since`, and the
`include_bodies` / `budget_bytes` / `max_documents` / `include_deprecated`
**context-pack** knobs). See
[`GET /admin/documents/search`](#get-admindocumentssearch) for the full
query-syntax, fusion, and pack semantics. **Not cursor-paginated, and there is
no `order`** — relevance rank *is* the ordering (`updated_since` still applies:
it is a filter, in the same class as `tag`/`slug`/`status`).

**`200 OK`** — `{ "documents": [ /* SearchHit rows */ ] }`, or the
[`PackResponse`](#packresponse) envelope when `include_bodies=true`. Errors:
`400 bad_limit` / `400 bad_status` / `400 bad_request` (bad `mode`, or
unparseable `updated_since`); `401`; `422 bad_query`.

### `GET /d/pack`

**Load a document/manifest-rooted [context pack](#packresponse)** (issue #21):
the root document's own prose **plus the full markdown bodies** of the
documents it references, budget-filled in one call. **Auth: agent key OR
operator** (`requireReader`). The HTTP twin of the MCP `load_context_pack`
tool — same core, same envelope. This is the one-call "get up to speed from a
known starting doc" read; for "brief me on TOPIC" with no starting doc, use
[`GET /d/search?include_bodies=true`](#get-dsearch) instead.

```
GET /d/pack?from=pack-onboarding&budget_bytes=131072&max_documents=12
Authorization: Bearer awh_...
```

| Param | Meaning |
|---|---|
| `from` | **Required.** The root: a live slug (curated packs are conventionally `pack-<name>`) or a 22-char `public_id`. Live-slug-first resolution when a value could be either. |
| `budget_bytes` | Body budget in **stored render** bytes (default 65536, ~16K tokens; max 262144). Clamped, not rejected. |
| `max_documents` | Cap on included member bodies (default 8, max 25). Clamped, not rejected. |
| `include_deprecated` | `true` → deprecated members join the fill instead of being omitted-and-reported. |
| `follow_redirects` | `true` → a deprecated member with a `superseded_by` pointer is replaced by its target in the fill; the original stays visible in `omitted[]` (single-hop). |

**Members** come from the root two ways — a manifest always wins: a fenced
` ```pack ` block in the root's retained source (one slug-or-public_id per
line, `#` comments, an `[optional]` line switching later members to the
optional tier, per-entry free-text hints), else the root's outbound
`/d/<id>` + `/s/<slug>` links in order of appearance. Bodies are included
**whole or omitted-and-reported** (never truncated); the root's own prose
returns as `pack.root.content` and is not counted against the budget.
Self-references are dropped; member resolution caps at 200 refs.

**`200 OK`** — the [`PackResponse`](#packresponse) envelope
(`pack.source` is `"manifest"` or `"document"`, `pack.root` is set).

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | `from` missing |
| 401 | `unauthorized` | no/invalid credential |
| 404 | `not_found` | `from` matches no live document |
| 410 | `gone` | `from` is a retired slug (slugs are never reused) |

### `PUT /d/:public_id`

Append a new version to an existing document. The body **replaces** the prior
version (no merge/patch). **Auth: agent key.** Any active key under the operator
may update any document (single-tenant trust model).

**Request** — same as `POST /d`, plus a **required** `If-Match`:

```
PUT /d/hdbOcFnhL1y9fe0tWpBvXA
Authorization: Bearer awh_...
Content-Type: text/markdown
If-Match: "v1"                 # required — current version ("v1", or bare v1/1), or * to skip
[X-Doc-* / X-Content-SHA256]   # optional; metadata inherits-on-omit (see above)

<new body bytes>
```

**`200 OK`** — same response shape as `POST /d` (with the incremented
`version`), `Location` + `ETag: "v<n>"` headers.

**On a `public` document this does not change what readers see.** The write
advances `current_ver`; the rendered page keeps serving `published_ver` until the
operator promotes it (see [published vs
current](#published-vs-current-version)). Nothing about the write itself differs
— the `200`, the `ETag`, and every machine-readable read reflect the new version
at once — but don't report "the page is updated" off the response alone. The
row's `published_ver` (via [`GET /d?slug=…`](#get-d), or the `published_version`
echo on the MCP write tools) is what tells you whether it went live.

**An agent may not change a `public` document's slug** → **`403 slug_locked`**.
Re-sending the document's *existing* slug is still a clean no-op; a **rename** or
an explicit **clear** is refused, because shedding a name retires it forever
([slugs](#identifiers-slugs-pagination)) — an irreversible, outward-facing change
to an address the world already holds, which puts it on the same side of the line
as `visibility` and revoke. Content is untouched by the rule: re-send the update
**without** the `X-Doc-Slug` header to change the body, or ask the operator to
rename it via
[`POST /admin/documents/:id/slug`](#post-admindocumentspublic_idslug). A
`private` document's slug stays agent-writable, and the operator write doors
never hit this.

**Errors** — the `POST /d` errors, plus:

| Status | `error` | When |
|---|---|---|
| 428 | `precondition_required` | `If-Match` header missing |
| 400 | `bad_request` | malformed `If-Match` |
| 403 | `slug_locked` | an **agent** key sent a slug **rename or clear** on a **`public`** document — see above (operator doors are exempt; re-sending the same slug is a no-op, not a failure) |
| 404 | `not_found` | no such document (or revoked). If the path segment is **slug-shaped** rather than a 22-char `public_id`, the `message` names [`GET /d?slug=…`](#get-d) — there is no `PUT /s/:slug`, so resolve the slug first |
| 412 | `precondition_failed` | `If-Match` version ≠ current — body has `current_version`, `expected` |

### `PUT /d/:public_id/tags`

Replace a document's **tags** — full replacement, `[]` clears, **no version
bump**. **Auth: agent key OR operator** (`requireReader` — never anonymous).
This is the agent-door twin of
[`POST /admin/documents/:public_id/tags`](#post-admindocumentspublic_idtags):
same core, byte-identical response.

`PUT` rather than `POST` because `POST /d/:id/tags` is already the manage page's
HTML form (operator-only), and `PUT` is the honest verb — this replaces a
subresource outright rather than appending to it. There is no `If-Match`: no
version is created, so concurrent retags are last-write-wins.

**Body:** `{ "tags": ["a", "b"] }` — entries sanitized to `[A-Za-z0-9_-]`
(invalid chars silently stripped, not rejected), capped at 10 tags × 32 chars,
deduped. Identical to the `X-Doc-Tags` write header's semantics.

**`200 OK`** — `{ "public_id": "…", "tags": ["a", "b"] }`

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` / `bad_json` | `tags` missing or not an array / unparseable body |
| 401 | `unauthorized` | neither a valid agent key nor the operator token |
| 404 | `not_found` | no such **live** document (missing, revoked, or malformed `public_id`) |

> **Why an agent may write this.** Under the single-tenant whole-fleet trust
> model an agent key already replaces any document's entire **content** via
> [`PUT /d/:id`](#put-dpublic_id), so re-classifying that document grants
> strictly less authority than it already holds. **`visibility`, publishing
> ([promote](#post-admindocumentspublic_idpromote)) and revoke stay
> operator-only** — visibility is the boundary between "private to the fleet" and
> "readable by the anonymous internet", promotion decides *which bytes* cross
> that boundary, and revoke is irreversible. Don't read this pair as precedent
> for a third: the test is whether the write reaches an anonymous surface, and
> tags and status don't.

### `PUT /d/:public_id/status`

Set a document's **lifecycle status** (migration 0014) — no version bump.
**Auth: agent key OR operator** (`requireReader`). The agent-door twin of
[`POST /admin/documents/:public_id/status`](#post-admindocumentspublic_idstatus)
— same body, same core, same response — and the way an agent retires its own
superseded work instead of leaving stale truth ranking in search.

**Body:** `{ "status": "active" | "deprecated", "superseded_by"?: "<public_id>" }`
— see the operator twin for the full field semantics (`"archived"` is reserved
and rejected; `superseded_by` is full-replace per call, must name a live
document, and is never auto-followed).

**`200 OK`** —
`{ "public_id": "…", "status": "deprecated", "superseded_by": "…" }`

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_status` / `bad_request` / `bad_json` | not `"active"`/`"deprecated"` (incl. reserved `"archived"`) / `status` missing or `superseded_by` not a string / unparseable body |
| 401 | `unauthorized` | neither a valid agent key nor the operator token |
| 404 | `not_found` | no such **live** document |
| 422 | `bad_target` | `superseded_by` is malformed, names no live document, or points at this document — body has `target` |

Status **gates nothing**: a deprecated document still serves and still ranks in
search (marked per row), but [context packs](#packresponse) skip it by default.

### `GET /d/:public_id`

The URL agents share with humans. **Content-negotiated by `Authorization`:**

- **No `Authorization` header** → `200` HTML **shell** page: a toolbar (created
  time, the **served** version, author, and a **kebab "⋮" actions menu**) wrapping
  a sandboxed `<iframe>` that loads `/raw`. This is the browser experience. The menu is
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
- **Valid credential** (an agent key **or** the operator token) → `200` the raw
  sanitized HTML bytes (same as `/raw`). Operator ≥ agent: the operator token is
  accepted here, not just agent keys.
- **Invalid credential** → `401` (broken keys/tokens surface rather than silently
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

**Which version the page shows.** The shell frames the **served** version — the
published one on a `public` document, the current one on a `private` one (see
[published vs current](#published-vs-current-version)) — and its toolbar version,
`<title>`, and link-preview metadata all describe *those* bytes, so the page
never labels itself with a version it isn't showing. The same holds on the
credentialed branch: a public document hands its published bytes to an agent key
and to the operator too. With an operator session, a document whose two pointers
disagree also gets a banner naming both and linking to the other one; no
non-operator sees it, and nothing on the anonymous surface hints that staged work
exists.

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

**This route is also the publish pin.** The bytes are chosen by the
[served-version rule](#published-vs-current-version) — `published_ver` on a
`public` document, `current_ver` on a `private` one — in the very query that
reads the access gate, so a public document *cannot* serve an unpromoted version
to anybody, including the agent that just wrote it. The `ETag`, the version the
shell reports, and the `source_format` that decides the reading theme all come
from that one row, so the response describes the bytes it actually returned.
Because the shell (`GET /d/:public_id`), the slug page
([`GET /s/:slug`](#get-sslug)) and the landing page (`GET /`) all embed `/raw`,
all three inherit the pin along with the visibility gate.

**`x-doc-current-version` — the writer's preflight (credentialed callers only).**
Since the `ETag` now names the *served* version, it is no longer a valid
`If-Match` preflight. This response header carries the document's **newest**
version instead — the one a `PUT` would be replacing — as a decimal string, on
both the `200` and the `304`. It is **absent for an anonymous caller** by design,
not clamped: see [optimistic
concurrency](#optimistic-concurrency-if-match--etag) for the full preflight rule
and why silence beats a number that would later read as a lie.

**Conditional GET (`If-None-Match` → `304`).** Send `If-None-Match: "v<n>"`
(the `ETag` from a prior response) and, if it still names the version this
document **serves** (published on a public doc, current on a private one), the
server returns **`304 Not Modified`** with no body — echoing the `ETag` and
skipping the R2 read entirely. This is the bandwidth-cheap revalidation path for
a client caching the rendered bytes (e.g. the mobile operator app's offline
cache): one conditional request confirms "still v\<n\>" instead of re-downloading
the document. The match also accepts `*`, a comma-separated list, and the weak
`W/"v<n>"` form. **The conditional check runs *after* the visibility/auth gate**,
so a `private`/revoked/missing document still returns the same opaque `404` to a
caller who can't read it — a `304` is never an existence-or-version oracle. The
`ETag` keys on the served version only: a **promote** changes the served bytes
without writing a version, so it *does* move the tag, while a new unpublished
version on a public document does *not* — correct in both directions, since the
cached bytes really are still the ones on offer. It also does **not** change when
a server-side reading-theme or converter deploy alters the bytes for an unchanged
version. The same conditional behavior applies to
[`GET /d/:public_id/v/:n/raw`](#get-dpublic_idvn-and-get-dpublic_idvnraw), which
addresses a version explicitly and is untouched by the publish pin.

**Link targets.** At write time the sanitizer injects `target="_blank"` on
external `http(s)` links **and** on on-platform `/d/<public_id>` / `/s/<slug>`
links; `#fragment` and other relative links stay in-frame. Both injected cases
would otherwise dead-end: an off-origin navigation inside the iframe is refused
by `frame-src 'self'`, and an in-frame hop to another document on this service
is refused by the shell's own `frame-ancestors`. Because the injection happens on
**write**, a document published before this behavior shipped keeps its in-frame
cross-links until it is re-published.

**Reading theme for Markdown documents.** When the **served** version's
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

The theme decision keys on the **served** version's `source_format`, read from
the same row as its bytes — so a document that changed authoring language between
versions renders under the format the version on screen was written in, not
whichever one is current. Because the **retained source**
(see [`GET /d/:public_id/source`](#get-dpublic_idsource)) is
re-rendered and re-sanitized on every `edit_document` *in its authored
language*, a Markdown document stays `source_format: markdown` across edits and
keeps its reading theme — editing no longer flips it to HTML.

### `GET /d/:public_id/text`

The document converted to **GFM Markdown** — for agents/tooling ingesting the
document as context rather than rendering it. **Auth: any authenticated reader —
an `awh_` agent key OR the operator (token or browser-session cookie)**; only
**anonymous** gets `401`. Operator ≥ agent: the operator is never ranked below an
agent here. Both `/text` endpoints (this and `/s/:slug/text`) are credentialed
ingestion channels, not public surfaces, so they're gated identically. The auth
check runs before the id-shape check.

> Note this gate is about not exposing a clean public Markdown API, not about
> confidentiality of the content: the rendered bytes stay publicly reachable at
> [`GET /d/:public_id/raw`](#get-dpublic_idraw) (the sandboxed iframe loads it
> uncredentialed), so a determined caller could fetch `/raw` and convert it.

**This route always reads the `current_ver`**, whatever a public document happens
to be publishing — it is a credentialed ingestion channel, not the public page,
and an agent must be able to read back what it just wrote. So on a public
document with a pending promote, `/text` and `/raw` describe *different*
versions and carry different `ETag`s; that is two representations disagreeing,
not one of them being stale. See [published vs
current](#published-vs-current-version).

With a valid key: `200 text/markdown; charset=utf-8`, with:

- `ETag: "v<n>"`
- `X-Sanitizer-Version`, `X-Converter-Version` — so a caller can detect when the
  sanitizer or markdown-converter policy changed without parsing the body.
- `Vary: Accept` (both branches — see below).

**Content-negotiated on `Accept`.** Send **`Accept: application/json`** and the
same read comes back as the [`ReadTextResponse`](#readtextresponse) envelope —
the body **plus** `title` / `description` / `tags` / `slug` / `status` /
`superseded_by`, which the route already had in hand and used to discard. That is
exactly what MCP `read_document format:"markdown"` has always returned, so the
two doors now answer the same question in one call each.

Anything else — a wildcard `Accept` (curl's default, and what the Dart clients
send so Cloudflare doesn't strip the `ETag`) or **no `Accept` header at all** —
keeps the historical `text/markdown` body. Quality values are ignored: this is a
two-way switch, not a preference ranking. No existing caller moves.

> **Why this exists.** A metadata-less body pushed a caller that wanted "the text
> *and* is it deprecated?" toward one of two bad answers: two round trips
> (`GET /d?slug=` then `/text`), or the shortcut to
> [`/source`](#get-dpublic_idsource) — which hands back **unsanitized** bytes to
> ingest as context. Rewarding that instinct was the real cost.

`401 unauthorized` if the caller is anonymous (no valid agent key or operator
credential). `404 not_found` if missing or revoked — a **JSON** `{ error,
message }` body (this route no longer emits a plain-text 404), opaque across
missing / revoked / private / malformed-id, with the slug-shaped-id hint
described under [the error envelope](#error-envelope).

### `GET /d/:public_id/source`

The **retained, unsanitized source `S`** of the current version, in its authored
language — Markdown for a Markdown document, the original HTML for an HTML
document. This is the read an agent does *before* `edit_document`, whose match
runs against `S` (not the rendered bytes). The HTTP twin of the MCP
`read_document representation:"source"` route.

**Current, not published.** Like [`/text`](#get-dpublic_idtext) this always
serves `current_ver` — which is the right source to patch, since an edit builds
the *next* version forward from the last one written, not from whatever a public
document is currently showing the world ([published vs
current](#published-vs-current-version)).

**Auth: any authenticated reader — an `awh_` agent key OR the operator (token or
browser-session cookie)**; only **anonymous** gets `401`. This is the **first
credentialed `GET` on the `/d/:public_id` namespace** — in deliberate contrast to
the public capability URLs, which serve only the sanitized `H`:

- [`GET /d/:public_id`](#get-dpublic_id) and
  [`GET /d/:public_id/raw`](#get-dpublic_idraw) — **public** (no `Authorization`
  → shell / raw bytes).
- [`GET /s/:slug`](#get-sslug) — **public** (no-auth shell branch).
- `GET /d/:public_id/source` — **never public, never unauthed.** The source is
  the *pre-sanitization* bytes: it may contain markup the sanitizer would have
  stripped, so it is gated like `/text`. The auth check runs before the id-shape
  check. (Operator **and** agent both read it — operator ≥ agent. Not
  operator-only: in the single-tenant whole-fleet trust model any active agent
  key already reads and overwrites every document, so a source read discloses no
  authority the caller lacks, and agents are the primary consumer. Not agent-only
  either: the operator is the apex principal and must never rank below an agent.)

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
  "source_sha256": "e3b0c4…b855",
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
- `source_sha256` — SHA-256 of these exact `source` bytes (`null` on a pre-0015
  version). Equals `sha256sum` of `source` saved as UTF-8, so it's the currency
  token to cache for the cheap list-based check (see `current_source_sha256` on
  [`DocumentListing`](#documentlisting)).
- `stripped[]` / `will_not_render[]` — re-derived from `S` (render-or-identity →
  sanitize → diff), so they reflect this source, not a cached write-time value.
- `unsanitized` — always `true`. (For HTML documents backfilled with `S := H`,
  the bytes are technically already sanitized, so this marker over-warns — a
  harmless, fail-safe direction, not a bug.)

**Errors**

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | missing/invalid agent key |
| 404 | `not_found` | no such document, revoked, or malformed `public_id` — opaque across all four. There is no slug-addressed `/source`, so a slug-shaped path segment gets a `message` naming [`GET /d?slug=…`](#get-d) |
| 409 | `source_unavailable` | the document is **live** but its current version has **no retained source** — a legacy/un-backfilled row (predates source retention) or the `.src` blob is gone. **Distinct from `404` on purpose:** a loud signal that the one-time source backfill missed this document, not "no such document." |

### `GET /d/:public_id/links`

The document's **link-graph neighborhood** (issue #40) — both directions of the
wiki graph, resolved at read time:

- **`backlinks[]`** — live documents whose *current version* links here (by
  `/d/<public_id>` or this doc's live `/s/<slug>`), as full
  [`DocumentListing`](#documentlisting) rows, newest first, capped at 200. The
  "referenced by…" / "what else references this?" traversal primitive. A link
  authored against a since-**renamed** slug is *not* counted (it reaches this
  doc only through the loud tombstone redirect, which is never followed
  implicitly); it appears on the source doc's `outbound` list as `redirected`
  instead.
- **`outbound[]`** — this document's own on-platform links in authored order,
  each with the state its raw target resolves to **right now** (targets are
  stored as the raw addressed name — *late binding* — and resolved per read):

| `state` | Meaning |
|---|---|
| `live` | a live document answers here (`target_public_id` + `title` carried) |
| `redirected` | a retired slug that **loudly forwards** (`target_public_id` = the forward target; update the link) |
| `retired` | a retired slug with no redirect — `/s/<slug>` is 410 Gone; the link is dead |
| `revoked` | a `/d/` link whose document was destroyed |
| `missing` | nothing has ever answered here (unclaimed slug / unknown `public_id`) |

`retired` / `revoked` / `missing` are the **broken-link report**.

**Auth: any authenticated reader** — an `awh_` agent key OR the operator (token
or session), exactly like [`/text`](#get-dpublic_idtext) and
[`/source`](#get-dpublic_idsource); **never public**. Backlink rows are listing
rows for *other* documents (including private ones), and the whole-fleet listing
surface has always been credentialed. The MCP twin is `read_document` with
`include_links: true` (see [The MCP surface](#the-mcp-surface)).

**`200 OK`** — `application/json; charset=utf-8` (the
[`DocumentLinksResponse`](#documentlinksresponse) shape):

```json
{
  "public_id": "0EtsEq6cnCeuOhBKO6ICzA",
  "backlinks": [ /* DocumentListing rows */ ],
  "outbound": [
    { "kind": "slug", "value": "slopcafe-spec-solo", "state": "live",
      "target_public_id": "ClcgZMaOEcworHzhr17gVQ", "title": "Agent knowledge host — SOLO spec" },
    { "kind": "slug", "value": "old-name", "state": "redirected",
      "target_public_id": "W_uEmb8XXwnV8nn3sbWYRQ", "title": null }
  ]
}
```

The graph is synced **in the same D1 batch as every write** (publish / update /
edit / restore; revoke deletes the doc's outbound rows), so it always reflects
each document's **current** version — including on a public document that is
still publishing an older one, whose rendered page may therefore carry links the
graph doesn't list yet (and vice versa). Documents published **before** the link
graph shipped have no rows until the operator runs
[`POST /admin/links/backfill`](#post-adminlinksbackfill).

**Errors**

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | anonymous / invalid credential |
| 404 | `not_found` | no such document, revoked, or malformed `public_id` (opaque). Like `/source`, a slug-shaped path segment gets a `message` naming [`GET /d?slug=…`](#get-d) |

### `GET /d/:public_id/v/:n` and `GET /d/:public_id/v/:n/raw`

**Operator-only version history.** Every update/edit appends a new version and
the prior bytes are retained in R2 (until the document is revoked, which purges
them). These two routes view any historical version `:n` (a positive integer),
mirroring the live shell/raw split:

- `GET /d/:public_id/v/:n` → the framed **shell** for version `n`, with a banner
  marking it as historical (`v<n>` of the document's `v<current>`) and links back
  to the live document + the manage page.
- `GET /d/:public_id/v/:n/raw` → the **sanitized bytes** of version `n` (what the
  shell's iframe loads, under the same `RAW_CSP`). Carries `ETag: "v<n>"` and
  honors `If-None-Match` → **`304 Not Modified`** exactly like
  [`/d/:public_id/raw`](#get-dpublic_idraw) (the check runs after the operator
  gate). Historical versions are immutable, so a cached client always revalidates
  to `304`.

**Auth: operator only** — Bearer (`OPERATOR_TOKEN`) **or** a cookie
[session](#browser--session-endpoints). This is an **operator** surface, *not*
the public visibility axis: a public document's history and a private
document's history are equally operator-only, and an agent reads old versions
through the MCP `read_document` `version` parameter, never here. A non-operator
gets the same opaque **`404`** as a missing route (no version oracle); the shell
route's 404 carries the sign-in affordance, the raw route's is plain.

These two address a version **explicitly**, so they are the one render path the
[publish pin](#published-vs-current-version) doesn't touch: `:n` is served
whether or not it is the published version. That is how the operator previews
staged bytes before deciding to
[promote](#post-admindocumentspublic_idpromote) them.

| Status | When |
|---|---|
| `200` | the version exists and the caller is the operator |
| `404` | non-operator caller; no such `public_id`; revoked document; **or no such version `n`** (all opaque — indistinguishable) |

> **No restore here.** Restoring a historical version is
> [`POST /admin/documents/:public_id/restore`](#post-admindocumentspublic_idrestore)
> (JSON) or [`POST /d/:public_id/restore`](#browser--session-endpoints) (the
> manage-page form) — both re-publish it as a *new* version. There is no agent
> restore in v1. The JSON manifest of what's restorable is
> [`GET /admin/documents/:public_id/versions`](#get-admindocumentspublic_idversions).

### `GET /s/:slug`

Resolve a slug, then **content-negotiate exactly like
[`GET /d/:public_id`](#get-dpublic_id)** — the slug is just the lookup handle in
front of the same behavior:

| Request | Response |
|---|---|
| **No `Authorization`** | `200 text/html` — the document's **shell page**, served directly (the pretty slug URL stays in the address bar; no redirect). The browser case. |
| **`Authorization: Bearer …`** (valid agent key **or** operator token) | `200 text/html` — the **raw sanitized bytes**, same as `/d/:public_id/raw`. The non-browser "bytes by slug" path. Operator ≥ agent: the operator token is accepted, not just agent keys. |
| Present but invalid credential | `401 unauthorized` (no silent downgrade to the shell). |
| Live doc but **`private`** ([visibility](#post-admindocumentspublic_idvisibility)), **no `Authorization`** | **`404`** — the same opaque 404 as "matches nothing". The private doc is masked; its slug stays **claimed** (NOT retired, so **not** `410`). Serves normally to an operator session cookie or an agent key. Make the doc public to relight the name. |
| Slug **retired** with a **redirect** set (operator redirect or rename auto-forward), **no `Authorization`** | `200 text/html` — a **loud interstitial card** the human must click through to the target's canonical URL. Never an automatic 3xx. |
| Slug **retired** with a redirect, **credentialed** (agent key or operator token), no `follow_redirects` | **`409 slug_redirected`** — JSON `{ "redirect_to": { "public_id", "slug", "title" }, "hint" }`. Not a 3xx (so curl `-L`/clients don't auto-follow); opt in to follow. |
| Slug **retired** with a redirect, **credentialed**, `?follow_redirects=true` | `200 text/html` — the **target's raw bytes** (re-checks the credential first). |
| Slug **retired** with a redirect whose **target the caller can't read** (a `private` target + an anonymous browser) | **`410 Gone`** — byte-identical to the dangling-target row below. The interstitial and the `409 slug_redirected` body both *name* a document, so refusing to emit them is the same no-oracle rule the rest of the visibility axis follows: a target you couldn't fetch directly is indistinguishable from a dead one. Operator and agent callers read the whole fleet, so they see the normal redirect response. |
| Slug **retired**, no redirect (or a dangling/revoked target) | **`410 Gone`** — HTML "this link is retired" card for a browser, `{"error":"gone"}` JSON for a credentialed (agent key or operator token) caller. Never resolves again, never reused. |
| Slug matches nothing / malformed | `404`. |

The auth'd-bytes path is how a programmatic consumer fetches a document it only
knows by slug — one call, no redirect-follow. (It previously worked via the old
`302 → /d/:public_id` redirect; content negotiation here preserves it after the
slug page started rendering directly.)

**Served version.** Both branches resolve through the same [served-version
rule](#published-vs-current-version) as `/d/:public_id`: the shell's `<title>`
and `og:` metadata describe the **published** version on a public document (at
the cost of one extra metadata read when the pointer lags), and the bytes branch
*is* [`/d/:public_id/raw`](#get-dpublic_idraw), so it carries the identical
`ETag` semantics and the same credentialed `x-doc-current-version` header. A
retired slug's redirect interstitial likewise names the target's published title
— nothing on the anonymous slug surface reports a version the reader can't see.

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
(below) — the slug twin of `/d/:public_id/text`. Both require a credential (an
agent key or the operator); on the slug surface only the no-auth shell here is
public.

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
`public_id`. **Auth: any authenticated reader — an `awh_` agent key OR the
operator (token/session)** (`401` to anonymous), exactly like
`/d/:public_id/text` — both `/text` endpoints are credentialed ingestion
channels, not public. On the slug surface specifically, the only public variant
is the browser-friendly shell at `GET /s/:slug`; every machine-readable form *by
slug* (the raw bytes via content negotiation on `/s/:slug`, and this Markdown
form) is gated.

The auth check runs **before** slug validation or any DB hit, so an
unauthenticated caller can't use this endpoint as a slug-existence oracle.

**`200 text/markdown`** (with a valid key) — identical body and headers to
`/d/:public_id/text` (`ETag: "v<n>"`, `X-Sanitizer-Version`,
`X-Converter-Version`, `Vary: Accept`, `Cache-Control: no-store`), **including
the same `Accept: application/json` switch** to the
[`ReadTextResponse`](#readtextresponse) envelope (and it applies to a followed
redirect's body too). `401 unauthorized` if the
caller is anonymous (no valid agent key or operator credential). A retired slug
behaves like `GET /s/:slug` for a credentialed caller:
**`409 slug_redirected`** (JSON, with `redirect_to`) if it carries a redirect —
or, with `?follow_redirects=true`, the **target's Markdown**; **`410 Gone`**
(`{"error":"gone"}`) if it's a plain/dangling tombstone **or the redirect target
isn't readable by this caller** (same no-oracle rule as the `/s/:slug` table
above); `404 not_found` (JSON) if the slug
matches nothing or is malformed. The slug is re-resolved and the bytes re-fetched
on each request, so a revoke landing mid-request still fails closed rather than
serving stale Markdown.

This is the one place the `/s/` and `/d/` text paths differ: it's the HTTP
analogue of the MCP `read_document` slug + `format: "markdown"` route (also an
authenticated channel), for a caller that has a key but only knows the slug.

### `DELETE /d/:public_id`

Revoke (kill switch). **Auth: operator token** (Bearer) **or** browser session
cookie + `X-CSRF-Token`. Sets `revoked_at` (making the doc 404 instantly), clears
**both** version pointers (`current_ver` and `published_ver` — a revoked document
publishes nothing), then purges the R2 bytes. The `versions` audit trail is
retained; only the rendered
bytes are destroyed. The document's slug (if any) is **retired**, not freed:
`/s/:slug` flips to `410 Gone` and the handle can never be reclaimed by another
document (see [slugs](#identifiers-slugs-pagination)).

**`200 OK`**

```json
{ "revoked": true, "public_id": "hdbOcFnhL1y9fe0tWpBvXA", "r2_objects_purged": 3 }
```

`r2_objects_purged` counts the **rendered** blobs (one per version); each
version's retained `.src` sibling is purged alongside it and is not counted
separately.

**Idempotent.** Re-issuing the `DELETE` on an already-revoked document returns
`200` with the same body and **re-runs the R2 purge**, without re-stamping
`revoked_at`. That is deliberate: the purge runs *after* the kill has already
landed in D1 and can fail loudly, so "revoke again" has to be the recovery — and
a `404` there would have told the operator the retry was pointless. Only an
**unknown or malformed** `public_id` returns `404 not_found`. `401`/`403` on
auth/CSRF failure.

A browser-friendly confirmation form for the same action lives at
`GET/POST /d/:public_id/revoke` (see Browser / session endpoints).

---

## Listing & search

> The `/admin/documents` + `/admin/documents/search` routes below are
> **operator-token auth.** Agents don't need them: the **agent-reachable twins**
> [`GET /d`](#get-d) and [`GET /d/search`](#get-dsearch) (and the MCP
> `list_documents` / `search_documents` tools) return byte-identical shapes from
> the same cores. Reach for the `/admin/*` forms when you're already operating
> as the operator (e.g. alongside the rest of this section's authoring routes).

### `GET /admin/documents`

List documents (including revoked, with `revoked_at` set), newest first.
**Auth: operator.** Cursor-paginated. (Agent-reachable twin:
[`GET /d`](#get-d).)

**Query params:** `limit` (1–200, default 50), `cursor` (opaque),
`order` (`created` (default) | `updated`), `updated_since` (inclusive ISO-8601
window on `updated_at`),
`tag` (repeatable or comma-joined; AND semantics; silently sanitized to
`[A-Za-z0-9_-]`), `slug` (exact match; validated, `400 bad_slug` on bad charset),
`status` (lifecycle filter — `active` | `deprecated`; omit to include
everything, with deprecated rows marked via their `status` field; invalid value
→ `400 bad_status`).

`?order=updated` + `?updated_since=` make this the operator-side **change feed**
— see [`GET /d`](#get-d) for the semantics, and
[the pagination conventions](#identifiers-slugs-pagination) for the cursor
ordering rule (a cursor minted under one ordering is rejected under the other).

**`200 OK`**

```json
{
  "documents": [ /* DocumentListing rows — see Shared response shapes */ ],
  "next_cursor": "eyJ0cyI6Li4ufQ"
}
```

Errors: `400 bad_limit` / `400 bad_cursor` (including a cursor replayed under a
different `order`) / `400 bad_slug` / `400 bad_status` / `400 bad_request`
(unknown `order`, or unparseable `updated_since`); `401`/`403` auth.

### `GET /admin/documents/search`

**Hybrid (keyword + semantic) search** over **live** documents. The keyword leg
is BM25 over title/description/body (title weighted highest); the semantic leg
embeds the query and matches against per-document chunk vectors (Cloudflare
Vectorize + Workers AI). The two rankings are fused with Reciprocal Rank Fusion,
so an exact term and a paraphrase both surface the right doc. Tags are **not**
full-text-indexed, but the `tag` filter still narrows results (it applies to
both legs). **Auth: operator.** (Agent-reachable twin:
[`GET /d/search`](#get-dsearch).) **Not cursor-paginated.**

**Query params:** `q` (**required**), `mode` (`hybrid` (default) | `keyword` |
`semantic`), `limit` (1–200, default 50), `tag`, `slug`, `status`,
`updated_since` (same as list; compose with `q` and apply to both legs). There is
no `order` and no `cursor` — relevance rank is the ordering. **Deprecated documents are
included and ranked normally** — each hit carries `status`/`superseded_by` so
the caller can discount it; pass `status=active` to exclude them.

- **`hybrid`** (default) — both legs, RRF-fused. Best recall.
- **`keyword`** — FTS only (deterministic exact-match escape hatch).
- **`semantic`** — vector only (pure concept match).

The query embed is **best-effort**: if Workers AI is briefly unavailable,
`hybrid`/`semantic` fall back to the keyword leg rather than failing. Semantic
hits are re-joined through the database (`revoked_at IS NULL` + the tag/slug
filters), so Vectorize is a candidate ranker, never an access gate — a stale or
not-yet-purged vector can never surface a revoked or filtered-out doc.

**Query syntax (keyword leg):** space-separated terms, each ≥2 chars, implicit
AND. Trailing `*` for prefix match. Diacritics and case folded; light-English
stemming. Phrase queries, Boolean operators, and column filters are **not**
supported (silently stripped). The semantic leg ignores this syntax and embeds
the raw query, so natural-language phrasing helps it.

**`200 OK`** — note **no `next_cursor`**:

```json
{ "documents": [ /* SearchHit rows: DocumentListing + score/matched_field/snippet */ ] }
```

See [`SearchHit`](#searchhit) for the per-mode `score` scale and the
`matched_field: "semantic"` case.

**Context pack — `?include_bodies=true`** (issue #21,
`docs/design/context-packs-design.md`): turns the search into a **budgeted bulk
read**. The server walks the ranked hits best-first and includes each **whole**
body (as markdown) until a knob binds; everything else is **reported, never
truncated**. Extra query params (all clamped, not rejected):

- `budget_bytes` — body budget, counted on **stored** document sizes (~4
  chars/token; returned markdown is typically smaller). Default `65536` (~16K
  tokens), max `262144`, min `1024`.
- `max_documents` — cap on included bodies. Default `8`, max `25`.
- `include_deprecated=true` — deprecated docs join the fill instead of being
  omitted-and-reported (the default excludes them — the stale-onboarding
  guard; their `omitted[]` entries carry `superseded_by` so you can read the
  replacement instead).

The `200` shape switches to the [`PackResponse`](#packresponse) envelope:
`{ pack: { source: "query", query, budget_bytes, max_documents, used_bytes },
documents: [hit + content/format/converter_v/version], omitted: [...] }`. A
doc that doesn't fit is skipped with reason `budget` (the walk continues, so
smaller later docs still fill the room); when even the #1 hit exceeds the whole
budget the pack comes back **empty** with that hit in `omitted[]` (read it
directly, or raise `budget_bytes`) — there is deliberately no force-include and
no truncation.

Errors: `422 bad_query` (missing `q`, or — for a leg that needs tokens — no
usable terms and embedding unavailable); `400 bad_request` (bad `mode`, or
unparseable `updated_since`), `bad_limit`/`bad_slug`/`bad_status`; `401`/`403`
auth.

### `POST /admin/vectors/backfill`

Backfill / reconcile the Vectorize semantic index. **Operator-invoked**, manual
in v1 (no scheduler). Live docs published before semantic search shipped have no
vectors; this is the one-time migration, and the same endpoint reconciles
anything a transient sync failure dropped. Idempotent and resumable.
**Auth: operator.**

**Query params:** `mode` (`missing` (default) | `rebuild`), `limit` (docs per
page, 1–200, default 50), `cursor` (resume from a prior page).

- **`missing`** (default) — incremental: embeds only docs whose vectors are
  absent (presence-only — does **not** detect *stale* vectors from a content
  change whose re-sync silently failed; use `rebuild` for that).
- **`rebuild`** — re-embed every live doc (after a model/chunk-size change, or
  to repair suspected staleness).

**`200 OK`:**

```json
{ "mode": "missing", "scanned": 50, "embedded": 3, "vectors": 21, "skipped": 47, "next_cursor": "<opaque>" }
```

A non-null `next_cursor` means more pages — re-invoke with `?cursor=<that>`.
`vectors` is the chunk vectors actually upserted; `vectors` ≪ `embedded` signals
a transient Vectorize/Workers AI failure (re-run). Errors: `400 bad_request`
(bad `mode`)/`bad_limit`/`bad_cursor`; `401`/`403` auth.

### `POST /admin/links/backfill`

Backfill the **link graph** (issue #40): re-extracts each live document's
on-platform links (`/d/…` and `/s/…` hrefs) from its **stored render** into the
`document_links` table behind [`GET /d/:public_id/links`](#get-dpublic_idlinks)
and [orphan detection](#get-adminlinksorphans). The write path keeps the graph
current from here on; this sweep exists for the write-once corpus published
before the graph shipped — run it once after deploying, or any time to
reconcile. Always rebuild-semantics (extraction is cheap and deterministic);
idempotent and resumable. **Auth: operator.**

**Query params:** `limit` (docs per page, 1–200, default 50), `cursor` (resume
from a prior page).

**`200 OK`:**

```json
{ "scanned": 50, "updated": 50, "links": 87, "next_cursor": "<opaque>" }
```

`updated` counts docs whose rows were rewritten this page (a doc whose render
couldn't be fetched is scanned-but-not-updated — re-run to retry); `links` is
the total rows stored. A non-null `next_cursor` means more pages. Errors:
`400 bad_limit`/`bad_cursor`; `401`/`403` auth. (Also available as a form on the
console [Maintenance page](#console-operator-web-ui).)

### `GET /admin/links/orphans`

**Orphan detection** (issue #40): live documents **no live document links to** —
neither by `public_id` nor by current slug (self-links don't count). Newest
first, capped at 200, deliberately **no cursor** (a curation worklist, not a
browse surface). **Auth: operator.**

An orphan is a *librarian's* signal, not an error — a doc only ever shared by
URL is a perfectly fine orphan. Run the
[links backfill](#post-adminlinksbackfill) first, or every pre-backfill doc
reads as an orphan (no graph rows yet to say otherwise).

**`200 OK`:** `{ "documents": [ /* DocumentListing rows */ ] }` · Errors: `401`.

### `POST /admin/documents`

**Operator authoring — publish.** The operator's own write door, distinct from
the agent path ([`POST /d`](#post-d), raw body + `X-Doc-*` headers) and the MCP
write tools. The document is authored as the **operator principal** (migration
0013): its `created_by_kind` is `"operator"` and `created_by_id`/`_name` are
null. Routes through the same sanitize→store core as every other write door.
**Auth: operator.** **Body: JSON** (vs the agent path's raw bytes — app-friendly
and consistent with the rest of `/admin/*`).

**Body:**

| Field | Type | Notes |
|---|---|---|
| `content` | string | **required.** The document body — HTML or Markdown per `format`. |
| `format` | `"html" \| "markdown"` | **required.** How `content` is parsed (Markdown → CommonMark+GFM → sanitized; HTML → sanitized). |
| `title` | string | optional. Omit to derive from the first `<h1>`. |
| `description` | string | optional. |
| `tags` | string[] | optional. Charset-sanitized like every write surface (`[A-Za-z0-9_-]`). |
| `slug` | string | optional. Unique handle `/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/`. |
| `visibility` | `"public" \| "private"` | optional. **Birth** visibility (atomic), else the deploy default (`DEFAULT_DOCUMENT_VISIBILITY`, normally `private`). A document born `public` also **publishes `v1` at birth**, so it is never public with nothing to serve ([published vs current](#published-vs-current-version)). |

**`201 Created`** — the shared [`WriteResponse`](#shared-response-shapes) shape
(`{ public_id, url, version, size_bytes, sanitizer_v, modified, stripped,
will_not_render, title, description, tags, slug }`), with `Location` + `ETag:
"v1"` headers — identical to [`POST /d`](#post-d).

| Status | `error` | When |
|---|---|---|
| `400` | `bad_json` / `bad_request` / `empty_body` | unparseable JSON, invalid/missing field, or empty `content` |
| `401`/`403` | `unauthorized` / `csrf_failed` | operator auth (cookie-authed mutations need `X-CSRF-Token`) |
| `409` | `slug_taken` / `slug_retired` | slug in use by a live doc, or previously used and retired |
| `413` | `too_large` / `storage_cap_exceeded` | input or fleet cap exceeded |
| `422` | `invalid_slug` / `too_deep` | slug validation failure (carries `reason`), or sanitized render nests past 512 levels (carries `limit`/`depth`) |

### `PUT /admin/documents/:public_id`

**Operator authoring — update.** Appends a new version authored by the operator
principal. `documents.created_by` is **untouched** (creator is immutable), so an
operator update of an agent-created doc yields creator = agent, this-version
author = operator — the full per-version author list that
`read_document`'s `include_history` and the operator version-history surfaces
expose. **Auth: operator.**
**Body: JSON**, same fields as `POST /admin/documents` **minus `visibility`**
(visibility has its own no-version-bump endpoint below); on update an omitted
field inherits the prior value and an explicit `""` clears (same inheritance as
[`PUT /d/:id`](#put-dpublic_id)).

**Optimistic concurrency — optional `If-Match`** (the deliberate, app-friendly
divergence from [`PUT /d/:id`](#put-dpublic_id), where it is **required**): send
`If-Match: "v<n>"` (or the lenient `v<n>`/`<n>` forms, or `*`) to guard against a
racing write (**`412`** on mismatch); **omit it for last-write-wins**. A
malformed `If-Match` → `400`.

**`200 OK`** — the shared [`WriteResponse`](#shared-response-shapes) shape with
the incremented `version`, plus `Location` + `ETag` headers.

**An operator update doesn't publish itself either.** The [served-version
rule](#published-vs-current-version) has no principal term, so on a `public`
document this appends a version readers won't see until you
[promote](#post-admindocumentspublic_idpromote) it. That is deliberate: one
place decides what the world reads, whoever wrote the bytes. (Authoring a *new*
public document is different — birth publishes `v1`.)

| Status | `error` | When |
|---|---|---|
| `400` | `bad_json` / `bad_request` / `empty_body` | unparseable JSON, invalid field, malformed `If-Match`, or empty `content` |
| `401`/`403` | `unauthorized` / `csrf_failed` | operator auth |
| `404` | `not_found` | no such (missing or revoked) document |
| `409` | `slug_taken` / `slug_retired` | slug conflict |
| `412` | `precondition_failed` | `If-Match` version mismatch (carries `current_version`) |
| `413` | `too_large` / `storage_cap_exceeded` | input or fleet cap exceeded |
| `422` | `invalid_slug` / `too_deep` | slug validation failure, or sanitized render nests past 512 levels |

### `GET /admin/documents/:public_id/versions`

**Version history** for a live document — the JSON twin of the manage page's
history table. **Auth: operator.** Newest first, capped at the **200 most
recent** (the same bound every list surface uses); deliberately **no cursor** —
it's a per-document manifest, not a browse surface.

Operator-only like every history view: a public document's history is as
operator-only as a private one's, and visibility does not govern this axis
(agents read history through MCP `read_document include_history`).

**`200 OK`** — `{ public_id, current_ver, versions: [ /* VersionListing */ ] }`;
see [`VersionListing`](#versionlisting) for the row shape.

```json
{
  "public_id": "JSH5jUYHvVGU6o-Tzg1cww",
  "current_ver": 4,
  "versions": [
    { "version_no": 4, "created_at": "2026-07-20T09:12:03.221Z", "size_bytes": 4096,
      "source_size_bytes": 3910, "sanitizer_v": "1.2.3", "source_format": "markdown",
      "title": "My document", "is_current": true, "is_published": false,
      "source_present": true, "source_sha256": "e3b0c4…b855",
      "author_kind": "agent", "author_id": "<uuid>", "author_name": "my-app" },
    { "version_no": 3, "created_at": "2026-07-18T14:02:55.107Z", "size_bytes": 3980,
      "source_size_bytes": 3801, "sanitizer_v": "1.2.3", "source_format": "markdown",
      "title": "My document", "is_current": false, "is_published": true,
      "source_present": true, "source_sha256": "a94a8f…3b0f",
      "author_kind": "operator", "author_id": null, "author_name": null }
  ]
}
```

**Check `source_present` before offering Restore** — a pre-0008 version with no
retained source cannot be restored (see below).

**`is_published` marks what the public page serves** (the version
`documents.published_ver` names). It is orthogonal to `is_current`: the two rows
diverge exactly when a document has staged work — which is the state this history
is most often opened to inspect, and the one the example above shows (v4 written,
v3 still facing the world). It describes the *pointer*, so on a `private`
document it says which version *would* go live, while the page renders the
current one regardless. Move it with
[`POST /admin/documents/:public_id/promote`](#post-admindocumentspublic_idpromote).

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | missing/invalid operator auth |
| 404 | `not_found` | no such **live** document (missing, revoked, or malformed `public_id`) |

### `POST /admin/documents/:public_id/restore`

**Restore a historical version** as a **new** version — the JSON twin of the
manage page's Restore button. **Auth: operator.** There is no agent restore in
v1.

Restore is *mandatorily* restore-as-new, never a `current_ver` rewind: an update
computes `next = current_ver + 1`, so pointing the pointer backward would make
the next ordinary write collide on the `(document_id, version_no)` primary key.
Version `n`'s retained **source** is re-published forward through the ordinary
write path, so it is re-sanitized like any other write and stays in its own
`source_format`.

**Body:** `{ "version": <positive integer> }`

**`200 OK`** — the ordinary [`WriteResponse`](#shared-response-shapes) plus
`restored_from` (the version it came from), so existing publish/update handling
applies unchanged.

```json
{
  "public_id": "JSH5jUYHvVGU6o-Tzg1cww",
  "url": "https://slopcafe.com/d/JSH5jUYHvVGU6o-Tzg1cww",
  "version": 5,
  "restored_from": 2,
  "size_bytes": 4096,
  "sanitizer_v": "1.2.3",
  "source_sha256": "e3b0c4…b855",
  "modified": false,
  "stripped": [],
  "will_not_render": [],
  "title": "My document",
  "description": null,
  "tags": ["metrics"],
  "slug": "north-island-report"
}
```

**What is and isn't restored:** the body and the version's `title`/`description`.
The document's current **slug and tags are kept** — both are document-level
(identity and classification), not part of a version's content, so a restore does
not undo a rename or a retag. A restore is an ordinary write, so on a `public`
document the restored bytes are **not live** until you
[promote](#post-admindocumentspublic_idpromote) the new version — if the point
was to fix the public page, promoting the *old* version directly is the shorter
route and writes nothing.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_json` / `bad_request` / `empty_body` | unparseable body / `version` missing or not a positive integer / that version has no content |
| 401 | `unauthorized` | missing/invalid operator auth |
| 403 | `csrf_failed` | cookie-authed + missing/invalid `X-CSRF-Token` |
| 404 | `not_found` | no such **live** document, **or** no such version of it — the two are told apart by the body: the version case carries `version` |
| 409 | `source_unavailable` | that version predates source retention (body has `version`). **Not restorable** — there is deliberately no fall-back to its rendered HTML (same rule as `edit_document`); revoke and republish instead |
| 409 | `precondition_failed` | a concurrent write landed mid-restore (body has `current_version`, `expected`) — just retry |
| 413 | `too_large` / `storage_cap_exceeded` | the restored bytes exceed the per-doc or fleet cap |
| 422 | `too_deep` | the restored render nests past 512 levels |

### `POST /admin/documents/:public_id/visibility`

Set a live document's [visibility](#get-dpublic_id) — `public` or `private`.
**Auth: operator** — the **only** principal that *changes* visibility. Agents
**read** it (it rides every listing row and every MCP write/read envelope, so an
agent knows whether the link it's about to share opens for a logged-out human)
but have no surface that sets it. Reversible, no version bump, no slug tombstone:
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

**Flipping to `public` publishes something.** Visibility opens the door;
[`published_ver`](#published-vs-current-version) picks the bytes behind it — so a
document with nothing published gets `published_ver` filled from `current_ver` in
the same statement, and can never be public with nothing to serve. A pointer
already staged by a [promote](#post-admindocumentspublic_idpromote) is **kept**,
which is how you open the door onto a chosen version rather than the newest one.
Flipping back to `private` leaves `published_ver` standing: the document
immediately renders `current_ver` again (private is already the gate), and the
stored pointer waits for the next time it goes public.

---

### `POST /admin/documents/:public_id/promote`

**Publish a version** — choose which one a document renders (migration 0018).
The immediate sibling of the [visibility flip](#post-admindocumentspublic_idvisibility)
above: between them the two decide everything the anonymous internet sees.
`visibility` opens the door, `published_ver` picks the bytes behind it.
**Auth: operator** — the only principal that publishes. No version bump, no
re-render, no re-index: like the visibility/slug/tags/status mutators this sets
one column and stamps `updated_at`. Idempotent (re-promoting the current choice
returns `200`).

Agents have **no** promote surface, over HTTP or MCP, and none is planned. It is
the anonymous-surface-**expanding** verb — the same class as `visibility` and
revoke — and the entire reason the pointer exists is that an agent key can
already write any document in the fleet (see [published vs
current](#published-vs-current-version)).

**Body:** `{ "version": <positive integer> }`

**`200 OK`**

```json
{ "public_id": "JSH5jUYHvVGU6o-Tzg1cww", "published_ver": 4 }
```

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | `version` missing, not a number, not an integer, or `< 1` |
| 400 | `bad_json` | unparseable body |
| 401 | `unauthorized` | missing/invalid operator auth |
| 403 | `csrf_failed` | cookie-authed + missing/invalid `X-CSRF-Token` |
| 404 | `not_found` | no such **live** document, **or** no such version of it — the two are told apart by the body: the version case carries `version` (the same convention [restore](#post-admindocumentspublic_idrestore) uses) |

**Promoting a `private` document is allowed, and is the point:** it stages the
choice before the door opens, and the later flip to `public` keeps the pointer it
finds. The named version has to exist, but nothing else about it is re-checked —
a promote is a pointer move, not a write, so it never re-sanitizes and never
touches the search index or the link graph (both of which track `current_ver`
regardless). It can also point **backwards**: naming an earlier version
un-publishes a bad one instantly, writing nothing — every version's bytes are
retained in R2 until the document is revoked, so any row the history lists is a
legal target.

Read the pointer back from any listing row (`published_ver` on
[`DocumentListing`](#documentlisting)), or per version from
[`GET /admin/documents/:public_id/versions`](#get-admindocumentspublic_idversions),
whose rows carry `is_published`.

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

### `POST /admin/documents/:public_id/tags`

Replace a live document's tags **without bumping a version** (tags are
document-level, like slug and visibility). **Auth: operator.** The
**agent-reachable twin is [`PUT /d/:public_id/tags`](#put-dpublic_idtags)** —
same body, same core, byte-identical response, only the auth door differs; the
`tags` field on the [write tools](#optional-document-metadata-write) remains the
way to set them as part of a content write.
**Full replacement, not a merge** — the supplied array becomes the document's
tags outright; `[]` clears them. Idempotent (setting the current value returns
`200`).

**Body:** `{ "tags": ["a", "b"] }` — an array of strings. Entries are sanitized
to `[A-Za-z0-9_-]` (invalid chars silently stripped), capped at 10 tags × 32
chars, and deduped, the same as the write path. `[]` clears all tags.

**`200 OK`**

```json
{ "public_id": "JSH5jUYHvVGU6o-Tzg1cww", "tags": ["metrics", "q2"] }
```

- `tags` — the document's tags after the change (`[]` after a clear).

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | `tags` missing or not an array |
| 400 | `bad_json` | unparseable body |
| 401 | `unauthorized` | missing/invalid operator auth |
| 403 | `csrf_failed` | cookie-authed + missing/invalid `X-CSRF-Token` |
| 404 | `not_found` | no such **live** document (missing, revoked, or malformed `public_id`) |

Agents reach the same mutator at [`PUT /d/:public_id/tags`](#put-dpublic_idtags)
(an agent key already replaces the document's whole content, so re-classifying it
grants strictly less authority). This `/admin/*` form is the operator's door onto
the same core — reach for it when you're already operating as the operator.

---

### `POST /admin/documents/:public_id/status`

Set a live document's **lifecycle status** (migration 0014) **without bumping a
version**. **Auth: operator.** The third per-document state axis, orthogonal to
revoke (existence) and visibility (anonymous read): `deprecated` means *still
findable, no longer current* — the document keeps rendering and keeps ranking in
search (marked via its `status` field), but **context packs exclude it by
default**, so it can't mis-onboard an agent with stale truth. Idempotent.

**Body:** `{ "status": "active" | "deprecated", "superseded_by"?: "<public_id>" }`

- `status` — `"archived"` is **reserved** (pinned in the DB CHECK for a future
  hide-from-default-search state) and **rejected** in v1.
- `superseded_by` — optional pointer to the replacement document (deprecated
  only). **Full-replace per call**: the supplied value (or its absence) becomes
  the stored value; setting `"active"` always clears it. Must name a **live**
  document and not the document itself. Single-hop by construction; **no
  surface ever auto-follows it** — search/list/read/pack carry the pointer so
  the reader decides (the loud slug-redirect stance, document-level).

**`200 OK`**

```json
{ "public_id": "JSH5jUYHvVGU6o-Tzg1cww", "status": "deprecated", "superseded_by": "hdbOcFnhL1y9fe0tWpBvXA" }
```

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_status` | `status` is not `"active"` or `"deprecated"` (incl. the reserved `"archived"`) |
| 400 | `bad_request` | `status` missing / `superseded_by` present but not a string |
| 400 | `bad_json` | unparseable body |
| 401 | `unauthorized` | missing/invalid operator auth |
| 403 | `csrf_failed` | cookie-authed + missing/invalid `X-CSRF-Token` |
| 404 | `not_found` | no such **live** document (missing, revoked, or malformed `public_id`) |
| 422 | `bad_target` | `superseded_by` is malformed, names no live document, or points at this document — body has `target` |

**Agent-reachable self-deprecation shipped** as
[`PUT /d/:public_id/status`](#put-dpublic_idstatus) — an agent that publishes a
replacement can retire its own superseded work instead of leaving stale truth
ranking in search. `visibility`,
[promotion](#post-admindocumentspublic_idpromote) and revoke remain
**operator-only**; status and tags are the only two classification writes on the
agent door. The browser twin
is the Status section of the [manage page](#browser--session-endpoints)
(`POST /d/:public_id/status`, operator-only — which is why the agent form is
`PUT`).

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

`active_keys` counts keys that can still authenticate — i.e. **neither revoked
nor expired**. `total_keys` counts every key row ever minted for the agent
(revoked and expired included), so `total_keys − active_keys` is the inert
tail (revoked keys + lapsed short-lived publish credentials, which are
[never auto-pruned in v1](#get-adminagentsagent_idkeys)).

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

List an agent's keys (including revoked and expired). Cursor-paginated.

```json
{
  "agent_id": "<uuid>",
  "name": "my-app",
  "keys": [
    { "id": "<uuid>", "key_prefix": "awh_abcd", "created_at": "...",
      "revoked_at": null, "expires_at": null, "expired": false }
  ],
  "next_cursor": null
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | key id (the handle for [`DELETE /admin/keys/:id`](#delete-adminkeyskey_id)) |
| `key_prefix` | string | the non-secret `awh_…` prefix; the secret half is never returned after mint |
| `created_at` | string \| null | ISO 8601 |
| `revoked_at` | string \| null | ISO timestamp when revoked, else null |
| `expires_at` | string \| null | ISO expiry for a short-lived publish credential (migration 0007); **null = never expires** (every operator-minted key and all legacy rows) |
| `expired` | boolean | server-computed at read time from `expires_at` (same rule auth enforces). `true` = past its TTL and no longer authenticates, even though `revoked_at` is still null |

A key authenticates only while `revoked_at is null` **and** `expired` is
false. Expired and revoked rows are retained (they linger as inert
tombstones — auth rejects them) and are **not auto-pruned in v1**; cleanup is
a deferred operator-housekeeping decision tracked in the repo. Use
[`DELETE /admin/keys/:id`](#delete-adminkeyskey_id) to remove one early.

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
| `GET /d/:public_id/manage` | Operator **document-management** page — visibility toggle, custom-link (slug) editor, lifecycle-status control (active/deprecated + optional `superseded_by`), tags editor, **version history** (a newest-first table marking which version is *current* and which is *published*, with a View link per version and a Restore button on every non-current one), and revoke, folded into one page (reached from the shell topbar's **Manage…** item). It also reports the [publish state](#published-vs-current-version) — whether readers are seeing the newest bytes, and on a public document with nothing published, that the page has nothing to serve. The controls render only for a live **cookie session** (their CSRF nonce comes from it); a Bearer-only or anonymous caller gets a sign-in prompt that discloses no document state. |
| `GET /d/:public_id/v/:n`, `GET /d/:public_id/v/:n/raw` | Operator-only historical-version view (shell + raw bytes). See [`GET /d/:public_id/v/:n`](#get-dpublic_idvn-and-get-dpublic_idvnraw). |
| `POST /d/:public_id/visibility` | Set public/private via the manage form (no version bump). Auth: session cookie + `csrf_token` field, or pasted `operator_token`. Programmatic equivalent: [`POST /admin/documents/:public_id/visibility`](#post-admindocumentspublic_idvisibility). |
| `POST /d/:public_id/slug` | Add/rename/clear the slug via the manage form (no version bump; a rename auto-forwards the old name). Auth: session cookie + `csrf_token` field, or pasted `operator_token`. Programmatic equivalent: [`POST /admin/documents/:public_id/slug`](#post-admindocumentspublic_idslug). |
| `POST /d/:public_id/tags` | Replace the document's tags via the manage form (no version bump; tags are document-level). Body: `tags=` a **comma-separated** list (same shape as the `X-Doc-Tags` write header — charset-sanitized to `[A-Za-z0-9_-]`, capped, deduped; an empty value clears), plus `csrf_token` (session cookie) **or** pasted `operator_token`. JSON twin: [`POST /admin/documents/:public_id/tags`](#post-admindocumentspublic_idtags) (which takes a JSON `tags` **array**). |
| `POST /d/:public_id/status` | Set the document's lifecycle status via the manage form (no version bump). Body: `status=active\|deprecated`, optional `superseded_by=` (replacement doc's `public_id`, deprecate only), plus `csrf_token` **or** pasted `operator_token`. JSON twin: [`POST /admin/documents/:public_id/status`](#post-admindocumentspublic_idstatus). |
| `POST /d/:public_id/restore` | Restore a historical version via the manage form's history table. Re-publishes that version's content + title/description as a **NEW version** (never a `current_ver` rewind — that would collide with the monotonic version numbering); the document's current slug **and tags are kept** (both are document-level, not part of a version's content). Body: `version=<n>` (+ `csrf_token`, or pasted `operator_token`). Operator-only; **no MCP/agent equivalent** in v1 (agents read history and can *propose* a restore). On success the new version number is reported. A version with **no retained source** (a pre-0008 / un-backfilled version) returns `source_unavailable` and **cannot be restored** — there's no fall-back to its rendered HTML (same rule as `edit_document`); revoke-and-republish such a document instead. JSON twin: [`POST /admin/documents/:public_id/restore`](#post-admindocumentspublic_idrestore). |
| `GET /d/:public_id/revoke` | Revoke confirmation page. **Operator resolved before any DB read**, so the page is not an existence oracle for a private document: an operator (session cookie *or* `Authorization: Bearer <OPERATOR_TOKEN>`) gets the confirm card — a CSRF-token button on the cookie path, a token-paste field on the Bearer path — and `404` for a missing/revoked id; a caller **carrying a failed `Authorization` header** gets the same opaque `404` every agent surface gives; and a plain browser with no credential gets the token-paste confirm card, rendered with **no query at all** (so its bytes are identical for a live, private, revoked, or never-existent id). Also reachable as the revoke section of the manage page. |
| `POST /d/:public_id/revoke` | Revoke via form (pasted `operator_token` field, or session cookie + `csrf_token` field). **The one manage-form POST that does *not* accept an `Authorization: Bearer` header** — the single irreversible action stays strictly narrower than the reversible ones. Scripts use the JSON [`DELETE /d/:public_id`](#delete-dpublic_id), which does take the header. |
| `/token`, `/.well-known/*` | Served by the OAuth provider library (token issuance + discovery). |
| `POST /register` | Served by the OAuth provider library: Dynamic Client Registration (RFC 7591), confidential-only, 90-day client TTL. Present only when `ENABLE_DCR` is set (see §3). |

**Form-POST auth ladder.** The manage-page forms
(`/d/:id/visibility`, `/slug`, `/tags`, `/status`, `/restore`) and every console
`POST` accept **three** credentials, in order: a pasted `operator_token` form
field (CSRF-exempt — the token *is* the inline credential), a real
`Authorization: Bearer <OPERATOR_TOKEN>` header (also CSRF-exempt — a bearer
header is never ambient the way a cookie is, and `requireOperator` accepts the
identical header on the JSON routes), or a session cookie **plus** a matching
`csrf_token` form field. `POST /d/:id/revoke` is the deliberate exception noted
above (no header path).

Session cookies are host-only, `SameSite=Lax`. `Secure` is conditional on the
request's **protocol *and* host**: always set over https, and also set over plain
`http` to a **non-loopback** host (a misconfigured zone or an active downgrade
must never mint a cleartext-transportable operator session). It is omitted *only*
over loopback `http` (`localhost` / `127.0.0.1` / `[::1]`), because a blanket
`Secure` is silently rejected on `http` and would break `wrangler dev`. CSRF is
stateless signed double-submit — a cookie-authed mutating request must echo the
nonce (`X-CSRF-Token` header or `csrf_token` form field).

---

## Console (operator web UI)

The **operator console** is the server-rendered (no-JS) admin UI — a thin HTML
skin over the same `*Core` functions the JSON [admin endpoints](#admin-endpoints)
call. It lives under `/admin/console/*` and returns **HTML**, never JSON; a
programmatic consumer should use the Bearer-auth admin endpoints above and won't
normally touch these. The **JSON `/admin/*` API is unchanged** by the console —
the `*Core` extraction kept those responses byte-identical.

**Auth: operator browser session** (cookie + CSRF). A `GET` page renders a
sign-in card (no DB hit) when there's no live cookie session, so a logged-out
visitor leaks nothing. Every console **`POST`** self-authorizes via the
**form-field auth ladder** — a pasted `operator_token` field (CSRF-exempt), an
`Authorization: Bearer <OPERATOR_TOKEN>` header (also CSRF-exempt), **or** a
cookie session plus a matching `csrf_token` form field. This is the same ladder
the manage-page forms (`/d/:id/visibility|/slug|/tags|/status|/restore`) use —
see [Browser / session endpoints](#browser--session-endpoints), including the one
exception, `POST /d/:id/revoke`. It is deliberately **not** the `X-CSRF-Token`
header `requireOperator` wants: a no-JS HTML form can't set request headers.

> **POST-not-DELETE divergence.** Several console actions are **`POST` twins of
> JSON `DELETE` admin endpoints** — a no-JS HTML form can only `GET`/`POST`, so
> the destructive console routes use `POST` with the target id carried as a
> **form field** (`agent_id` / `key_id` / `client_id`) rather than in the path.
> They call the same `*Core` teardown as their JSON `DELETE` counterparts.

| Route | Purpose |
|---|---|
| `GET /admin` | 302 → `/admin/console` (so an operator can type the short path). |
| `GET /admin/console` | Dashboard. Sign-in card when logged out. |
| `GET /admin/console/agents` | Agents list page. |
| `POST /admin/console/agents` | Mint an agent + initial key (`name` field). POST twin of [`POST /admin/agents`](#post-adminagents). |
| `POST /admin/console/agents/revoke` | Revoke an agent and cascade its keys + OAuth clients (`agent_id` field). POST twin of [`DELETE /admin/agents/:agent_id`](#delete-adminagentsagent_id). |
| `GET /admin/console/agents/:id` | Agent detail page (keys + bound OAuth clients). `:id` is UUID-shape-validated. |
| `POST /admin/console/agents/:id/keys` | Mint an additional key for the agent. POST twin of [`POST /admin/agents/:agent_id/keys`](#post-adminagentsagent_idkeys). |
| `POST /admin/console/agents/:id/oauth-clients` | Mint a **bound** OAuth client for the agent. POST twin of [`POST /admin/agents/:agent_id/oauth-clients`](#post-adminagentsagent_idoauth-clients). |
| `POST /admin/console/keys/revoke` | Revoke a single key (`key_id` field). POST twin of [`DELETE /admin/keys/:key_id`](#delete-adminkeyskey_id). |
| `POST /admin/console/oauth-clients` | Mint an **unbound** OAuth client. POST twin of [`POST /admin/oauth-clients`](#post-adminoauth-clients). |
| `POST /admin/console/oauth-clients/delete` | Delete an OAuth client, bound or unbound (`client_id` field). POST twin of [`DELETE /admin/oauth-clients/:client_id`](#delete-adminoauth-clientsclient_id). |
| `GET /admin/console/documents` | Documents browser. Query: `?q=` (when set, runs [hybrid search](#get-admindocumentssearch); empty = newest-first [list](#get-admindocuments)), `?tag=`, `?slug=`, `?cursor=`, `?limit=` (same filters/pagination as the JSON list/search). Each row shows a **Public/Private badge** — the list/search cores are untouched (no server-side visibility filtering). |
| `GET /admin/console/maintenance` | Maintenance page (Vectorize + link-graph backfill controls). |
| `POST /admin/console/vectors/backfill` | Run a Vectorize backfill (`mode` field: `missing` \| `rebuild`). POST equivalent of [`POST /admin/vectors/backfill`](#post-adminvectorsbackfill). |
| `POST /admin/console/links/backfill` | Run a link-graph backfill. POST equivalent of [`POST /admin/links/backfill`](#post-adminlinksbackfill). |

Document tags are editable from the console **manage page**
([`POST /d/:public_id/tags`](#browser--session-endpoints), comma-separated form
field) as well as via the JSON
[`POST /admin/documents/:public_id/tags`](#post-admindocumentspublic_idtags)
(array body) — both atop `setDocumentTagsCore` (no version bump).

---

## Health

### `GET /healthz`

Public smoke check — confirms bindings reach D1 + R2 and migrations ran. Also the
API's **in-band discovery document**: `/healthz` is the path an agent probes
unprompted, so it carries the three pointers that get a caller from "I have a
base URL" to "I know the calls."

```json
{
  "ok": true,
  "service": "slopcafe",
  "sanitizer_version": "1.2.3",
  "storage_cap_bytes": 2147483648,
  "openapi": "https://slopcafe.com/openapi.json",
  "docs": "https://slopcafe.com/s/slopcafe-http-api-quickstart",
  "mcp": "https://slopcafe.com/mcp",
  "d1": { "documents": 12, "agents": 3 },
  "r2": { "bucket_reachable": true, "sample_object_count": 1 }
}
```

- `openapi` / `docs` / `mcp` — absolute URLs built from the **request** origin,
  not a baked host, so a dev or staging deploy points at itself. `docs` names
  the on-platform mirror of the [HTTP
  quickstart](http-api-quickstart.md); it is *instance-specific* (a fork either
  mirrors its own copy under that slug or drops the field) and advisory — never a
  route this API depends on.
- `storage_cap_bytes` — the **enforced** cap, normalized through the same reader
  the write path's cap check uses, so a misconfigured or missing
  `STORAGE_CAP_BYTES` reports the 2 GiB fallback here rather than `null`.
- The response also carries the `Link: </openapi.json>; rel="service-desc"`
  header every JSON error carries.

---

## Machine-readable spec (`/openapi.json`)

### `GET /openapi.json`

Public, no auth. Returns the **generated OpenAPI 3.1 document** for this API —
the machine-readable companion to this prose reference. Point a client generator
(`openapi-generator`, `openapi-typescript`, `swagger_dart_code_generator`, …) at
it to bootstrap a typed client in any language.

```sh
curl https://slopcafe.com/openapi.json
```

The spec is **code-first**: it is generated from the Zod schemas in
`src/contract.ts` (the single source of truth), so the response/error shapes it
describes are the same ones the server is type-checked against — they cannot
drift. It is served fresh on each request, with `servers[0].url` set to the
origin you fetched it from (so dev/staging codegen targets the right host). A
committed `openapi.json` at the repo root is the CI freshness target.

### Versioning (`info.version`)

The spec's `info.version` follows semver. The contract went stable at `1.0.0` at
the public launch and is **currently `2.0.0`** — under **strict semver**, so read
the bump rules literally:

- **`MAJOR`** (`2.0.0`) for any **breaking** change — a removed / retyped field,
  a changed error code or status, a tightened constraint that rejects
  previously-valid input.
- **`MINOR`** (`2.1.0`) for **additive, backward-compatible** changes — a new
  optional field, a new endpoint, a new enum member a tolerant client ignores.
- **`PATCH`** (`2.0.1`) for documentation / clarification edits that don't move
  the wire.
- **A caret range is safe** *once a major has landed*. `^2.0.0` shields you from
  breaks (they bump MAJOR) while still picking up additive minors.

> Before `1.0.0` the contract was pre-stable `0.x`, where a *minor* bump could
> carry a break and caret ranges were unsafe. That relaxed phase is over; the
> rules above are the only ones in force between majors.

**`2.0.0` IS CURRENTLY AN OPEN MAJOR — pin exactly, not with a caret.** It is
being cut on a dedicated breaking-change branch where breaks **accumulate** under
one version rather than each taking their own. So while that window is open,
`2.0.0` denotes a *moving* contract: the same version string can describe
different wire behaviour a week apart, and `^2.0.0` promises you nothing. If you
are integrating today, **pin the `openapi.json` bytes** rather than the version
string, and re-pin once when the window closes and `2.0.0` freezes. (The
first-party Dart CLI does exactly this — `cli/tool/CONTRACT_VERSION` deliberately
sits back at `1.5.0`, tracking the last frozen contract rather than the moving
one.)

**What `2.0.0` changes, cumulatively.** Everything below is a break from `1.x`;
everything not listed is additive:

1. **[`DELETE /d/:id`](#delete-dpublic_id)** is idempotent on an already-revoked
   document — `200` and a re-run purge where it used to `404`. Re-issuing the
   revoke is the documented recovery from a partial R2 purge, so a `404` told the
   operator a retry was pointless while unsanitized `.src` bytes stayed resident.
2. **`GET /d/:id/revoke`** narrowed to operator-only — it previously branched
   200-vs-404 on existence, an oracle for exactly the private documents
   `/d/:id` hides.
3. **[`GET /s/:slug`](#get-sslug)** answers `410` where it answered `200`, for a
   retired slug.
4. **`/d/:id/text`, `/d/:id/source` and `/d/:id/links`** answer their `404` as a
   JSON error body instead of `text/plain` — the most common failure was the one
   case a JSON client couldn't parse.
5. **[`GET /d/:id/raw`](#get-dpublic_idraw)** (and the shell, slug and homepage
   surfaces that render the same bytes) serves a `public` document's
   `published_ver` rather than its `current_ver` — the [published/current version
   split](#published-vs-current-version), migration 0018. Same URL, same
   credential, **different bytes** and a different `ETag` the moment an agent has
   written a version the operator hasn't promoted. A client that cached v3
   re-reads v2, and the `ETag` it would have replayed as `If-Match` on the next
   `PUT` now names the published version and earns a `412`. The replacement
   preflight is the `x-doc-current-version` header — see [optimistic
   concurrency](#optimistic-concurrency-if-match--etag).
6. **[`PUT /d/:id`](#put-dpublic_id)** answers `403 slug_locked` where it
   answered `200`, for an agent-authored slug rename or clear on a `public`
   document.

All of these are deliberate security or correctness changes, not regressions.
**Consumers re-pin once, when the window closes**, re-run codegen, and — if they
do optimistic concurrency — **move the preflight to `x-doc-current-version`,
falling back to the `ETag` when the header is absent** (correct for a private
document, and for any server predating this contract).


**What made `2.0.0` a MAJOR** (the prior line, for anyone still pinned to `^1`):
two required non-nullable fields joined every listing row — `updated_at` and
`current_version_at` (migration 0017) — and two routes changed a *status class*
for a caller who had been getting a success:
[`DELETE /d/:public_id`](#delete-dpublic_id) began answering `200` rather than
`404` on an already-revoked document, and [`GET /s/:slug`](#get-sslug) began
answering `410` where an unreadable redirect target previously produced a named
interstitial. A strict reading of "changed code or status ⇒ MAJOR" made that a
`2.0.0` even though every one of those changes was a fix.

> **Contributors & review agents — this bump is a human obligation, not
> test-enforced.** The freshness gate (`test/openapi.test.mjs` +
> `git diff --exit-code openapi.json`) only checks *spec-matches-source*; it has
> **no opinion on the version constant**, so a shape change can land with the
> version untouched and the suite still green (during `0.x` the spec drifted this
> way more than once). Any change that touches a request / response /
> error shape, a header, or a status code **must** also bump
> `OPENAPI_INFO_VERSION` (`src/openapi.ts`) per the rules above and regenerate
> (`npm run build:openapi`). See [`api-contract-design.md`](design/api-contract-design.md) §14 and the
> API-surface-change checklist in `CLAUDE.md`.

**What it does and doesn't model.** Every JSON request/response shape and error
(`ErrorBody`, a `oneOf` discriminated on `error`) is in the spec, with one named
`#/components/schemas/X` per shape. A few routes can only be **partly** modelled
and keep their full contract in this prose doc — see each route's `description`
in the spec:

- **Content-negotiated reads** (`GET /d/:public_id`, `GET /s/:slug`) — the
  HTML-shell-vs-raw-bytes-vs-401 split on the `Authorization` header is prose.
  (The `/text` routes' `Accept`-based split *is* modelled: one `200` with two
  entries in its `content` map, `text/markdown` and
  `application/json` → `ReadTextResponse`.)
- **HTML / UI surfaces** (`/`, `/login`, `/logout`, `/authorize`, the
  `/d/:id/manage` + form POSTs) — modelled as `text/html` with no schema.
- **`/mcp`** — JSON-RPC over Streamable HTTP, not REST; a single minimal entry.
- **OAuth-library routes** (`/token`, `/register`, `/.well-known/*`) — standard
  OAuth 2.1, served by `@cloudflare/workers-oauth-provider`; minimal entries.

This is **Phase 2** of the code-first API-contract work
([`api-contract-design.md`](design/api-contract-design.md)). Three shapes that
were MCP-only became HTTP components when their twins landed —
`ReadTextResponse` (the `Accept: application/json` branch of both `/text`
routes), `ListVersionsResponse` and `RestoreResponse` (the operator version
history + restore routes) — so a generated client shares one
`VersionListing` class with the manage page rather than re-deriving it. What
remains MCP-only in the contract module, and outside the OpenAPI surface: the
`edit_document` envelope, `read_document`'s combined document/redirect envelope,
the MCP write/edit `visibility` echo, and `create_publish_credential`.

---

## Shared response shapes

> **The OpenAPI spec is canonical.** Each shape below mirrors a generated
> `#/components/schemas/X` component in
> [`/openapi.json`](#machine-readable-spec-openapijson) — the machine-readable
> source of truth, generated from `src/contract.ts` (Zod). These tables are a
> human-readable companion; if one ever disagrees with the spec, **the spec
> wins** (that's a bug to fix). Generate clients from the spec, not from these
> tables.

### `DocumentListing`

Returned by `GET /admin/documents`, `GET /s/:slug`'s backing lookup, and (as the
base of each hit) by search. **Canonical:** `#/components/schemas/DocumentListing`.

| Field | Type | Notes |
|---|---|---|
| `public_id` | string | 22-char capability id |
| `current_ver` | number \| null | null on a revoked doc |
| `created_at` | string | ISO 8601 (`YYYY-MM-DDTHH:MM:SS.sssZ`) |
| `updated_at` | string | **Never null.** When this document last changed in *any* way (migration 0017): a new version, a tags/slug/visibility/status/publish change (none of which bump a version), or a revoke. The sort key behind `?order=updated` and the column `?updated_since=` windows. Pre-0017 rows were backfilled from the current version's write time, so a *classification* change made before the migration under-reports — the first post-migration touch corrects the row for good. |
| `current_version_at` | string \| null | When the **current version's bytes** were written; null when revoked (the version join misses, like its `current_*` siblings). Compare it to `updated_at` for **meaning, not an exact inequality** — the two are stamped by different statements of one D1 batch, so a pure content write can leave them a millisecond apart either way. An `updated_at` well *ahead* of it means the last change was classification, not content. |
| `created_by_id` | string \| null | creator agent id; null for an operator-created doc, or if the agent was deleted |
| `created_by_name` | string \| null | creator agent name; null for operator or if deleted |
| `created_by_kind` | `"agent" \| "operator"` | the creator's principal kind (migration 0013). `"operator"` when the operator authored the doc (`created_by_id`/`_name` are then null); disambiguates a null `created_by_id` that means "operator" from one that means "agent since deleted" |
| `current_size` | number \| null | bytes of the **current** version; null when revoked (bytes purged) |
| `current_source_sha256` | string \| null | SHA-256 of the current version's **retained source** (migration 0015); null when revoked (bytes purged) or on a pre-0015 version. The cheap currency check: `sha256sum` a local copy and compare — a match means it's the current source, so an edit can skip the source re-read (#35). For a byte-exact publish this equals the file's `sha256sum` (well-formed UTF-8 only; a reformatted/non-UTF-8 file is a safe miss → just re-read). |
| `published_ver` | number \| null | **What a `public` document renders**, to every reader (migration 0018); `null` = nothing published. Only the operator moves it ([promote](#post-admindocumentspublic_idpromote)), so a value **below** `current_ver` means bytes are stored but not yet facing the world — the write landed, the page didn't change. Read it together with `visibility`: a **private** document always renders `current_ver` whatever this says, so a pointer there is a choice *staged* for the moment it goes public, not a description of what is being served. See [published vs current](#published-vs-current-version). |
| `published_source_sha256` | string \| null | SHA-256 of the **published** version's retained source — the `published_ver` twin of `current_source_sha256`, answering "is the copy the world has the copy I have?" without a second read. Null when nothing is published, or when that version predates source retention/hashing. It equals `current_source_sha256` exactly when the published and current versions carry identical source bytes (the common case); an inequality is the cheap signal that a promote is pending. |
| `revoked_at` | string \| null | ISO timestamp when revoked, else null |
| `title` | string \| null | current version's title |
| `description` | string \| null | current version's description |
| `tags` | string[] | the document's tags (document-level; `[]` when unset) |
| `slug` | string \| null | document slug; null when unset or after revocation |
| `status` | `"active" \| "deprecated" \| "archived"` | lifecycle status (migration 0014; see [`POST …/status`](#post-admindocumentspublic_idstatus)). `deprecated` = still served/findable but no longer current — discount it and prefer `superseded_by` when named. `archived` is reserved; nothing sets it in v1. |
| `superseded_by` | string \| null | a replacement document's `public_id`, set only on a deprecated doc with a named successor. **Never auto-followed** by any surface — the reader decides. |
| `visibility` | `"public" \| "private"` | whether an **anonymous** visitor can open this document's URL (see [`POST …/visibility`](#post-admindocumentspublic_idvisibility)). Present on **every** listing row, operator and agent surfaces alike, and deliberately part of the agent-facing contract: documents are born `private`, an agent key reads them regardless, so without this field an agent would hand a human a link that `404`s. **Read-only to agents** — only the operator flips it. |

### `SearchHit`

`DocumentListing` **plus** the fields below. **Canonical:** `#/components/schemas/SearchHit`.

| Field | Type | Notes |
|---|---|---|
| `score` | number | **bigger = better**, but the **scale differs by `mode`** and is only comparable *within one result set*: fused RRF score in `hybrid`, negated BM25 in `keyword`, cosine similarity in `semantic`. |
| `matched_field` | `"title" \| "description" \| "body" \| "semantic"` | for a keyword hit, which column matched (priority title > description > body); `"semantic"` for a vector-only (concept) hit with no matched term to attribute. A hit matched by **both** legs keeps its keyword attribution (the more informative signal). Tags are not full-text-indexed, so they never appear here — use the `tag` filter instead. |
| `snippet` | string | for a keyword hit, the matched column with `[bracketed]` match terms; for a `"semantic"` hit, the matched passage's excerpt, **not** bracketed (the missing brackets signal "concept match, not term match"). |

### `PackResponse`

The **context-pack envelope** (issue #21) — returned by
[`GET /d/pack`](#get-dpack), [`GET /d/search?include_bodies=true`](#get-dsearch)
(and its operator twin
[`GET /admin/documents/search?include_bodies=true`](#get-admindocumentssearch)),
the MCP `search_documents` tool with `include_bodies: true`, and the MCP
`load_context_pack` tool. **Canonical:** `#/components/schemas/PackResponse`
(members: `PackInfo` / `PackRoot` / `PackDocument` / `PackOmitted`).

| Field | Type | Notes |
|---|---|---|
| `pack.source` | `"query" \| "document" \| "manifest"` | what the root was: a search query, a plain document (outbound-link expansion), or a document with an explicit ` ```pack ` manifest block |
| `pack.query` | string \| null | the query (query packs only) |
| `pack.root` | `PackRoot` \| null | document/manifest packs only: the root's `public_id`/`slug`/`title` **plus its own `content`** (markdown — the manifest prose explains why these members; **not** counted against the budget) |
| `pack.budget_bytes`, `pack.max_documents` | number | the (clamped) knobs the fill ran with |
| `pack.used_bytes` | number | stored-render bytes committed by the included members — the budget currency. Returned markdown is typically smaller, so `used_bytes` ≥ summed content lengths by design |
| `documents[]` | `PackDocument` | a full [`DocumentListing`](#documentlisting) row **plus** `content` (markdown body, always whole), `format: "markdown"`, `converter_v`, `version` (the version read), nullable query attribution (`score`/`matched_field`/`snippet` — non-null on query packs), and nullable manifest fields (`tier: "required" \| "optional"`, `hint`) |
| `omitted[]` | `PackOmitted` | every candidate left out: `public_id`, `title`, `reason` (`budget` \| `max_documents` \| `deprecated` \| `unavailable` \| `revoked`), `size_bytes` (what the budget decision saw), `superseded_by` (deprecated members — prefer the replacement), `hint` (manifest optional-tier note — the pack's "menu") |

Bodies are **whole-or-omitted, never truncated** (loud-over-silent), and a pack
serves **markdown only** — no `format`/`representation` axis; drop to
`read_document` for one doc's HTML or unsanitized source.

### `ReadTextResponse`

The one-call Markdown read envelope: returned by
[`GET /d/:public_id/text`](#get-dpublic_idtext) and
[`GET /s/:slug/text`](#get-sslugtext) when the caller sends
`Accept: application/json`, and by MCP `read_document format:"markdown"`.
**Canonical:** `#/components/schemas/ReadTextResponse`.

| Field | Type | Notes |
|---|---|---|
| `text` | string | the GFM Markdown derivation of the sanitized HTML — the same bytes the `text/markdown` branch returns as the whole body |
| `version_no` | number | the version read (matches the `ETag`) |
| `sanitizer_v` | string | sanitizer profile that produced the stored bytes |
| `converter_v` | string | HTML→Markdown converter version; compare across reads to detect a converter policy change |
| `title` | string \| null | the version's title |
| `description` | string \| null | the version's description |
| `tags` | string[] | the document's tags (document-level) |
| `slug` | string \| null | document slug; null when unset |
| `status` | `"active" \| "deprecated" \| "archived"` | the document's lifecycle status |
| `superseded_by` | string \| null | replacement doc's `public_id` (deprecated only; never auto-followed) |

### `VersionListing`

One row of a document's version history: returned by
[`GET /admin/documents/:public_id/versions`](#get-admindocumentspublic_idversions),
and (trimmed) by MCP `read_document include_history`.
**Canonical:** `#/components/schemas/VersionListing`; the wrapper is
`ListVersionsResponse` (`{ public_id, current_ver, versions[] }`).

| Field | Type | Notes |
|---|---|---|
| `version_no` | number | this version's number |
| `created_at` | string | when these bytes were written |
| `size_bytes` | number | rendered-HTML byte count |
| `source_size_bytes` | number \| null | retained-source byte count; null on a pre-0008 version |
| `sanitizer_v` | string | sanitizer profile that produced this version's bytes |
| `source_format` | `"markdown" \| "html"` | the language this version's source was authored in |
| `title` | string \| null | this version's title |
| `is_current` | boolean | true for the document's **current** version — the one written last, and the one the next write builds on. Not necessarily the one on screen: see `is_published`. |
| `is_published` | boolean | true for the version [`published_ver`](#published-vs-current-version) names — **what a `public` document serves**. Orthogonal to `is_current`: the two land on different rows exactly when a document has staged work, which is the state a reviewer opens this history to see. False on every row when nothing is published. It describes the **pointer**, not the bytes on screen — a private document renders its current version whatever this says. |
| `source_present` | boolean | **check this before offering Restore** — false means the retained source is gone (pre-0008 / un-backfilled), and restore hard-fails `source_unavailable` |
| `source_sha256` | string \| null | SHA-256 of *this* version's retained source; null on a pre-0015 version and always null when `source_present` is false. The per-version twin of a listing row's `current_source_sha256` / `published_source_sha256` — it identifies which history row a local file corresponds to before you decide what to promote or restore, without fetching any source bytes. |
| `author_kind` | `"agent" \| "operator"` | who wrote this version (migration 0013) |
| `author_id` | string \| null | the writing agent's id; null for an operator-written version, an agent since deleted, or a pre-0013 version |
| `author_name` | string \| null | that agent's display name; null in the same cases |

### `RestoreResponse`

Returned by
[`POST /admin/documents/:public_id/restore`](#post-admindocumentspublic_idrestore):
the ordinary [`WriteResponse`](#shared-response-shapes) **plus `restored_from`**
(number — the version the content came from). **Canonical:**
`#/components/schemas/RestoreResponse`.

### `ReadSourceOk`

Returned by [`GET /d/:public_id/source`](#get-dpublic_idsource) (and, as a JSON
envelope, by the MCP `read_document representation:"source"` route).
**Canonical:** `#/components/schemas/ReadSourceResponse` — the wire shape. The
fields match; the internal `ok: true` discriminant is stripped on the wire, so
the generated component is named `ReadSourceResponse`, not `ReadSourceOk`.

| Field | Type | Notes |
|---|---|---|
| `source` | string | the retained, **unsanitized** source bytes, in `source_format` |
| `source_format` | `"markdown" \| "html"` | the language `source` is authored in / the pipeline `edit_document` re-renders it through |
| `version_no` | number | the version the source belongs to |
| `sanitizer_v` | string | sanitizer profile stamped on the current version (not a re-sanitize of `S`) |
| `source_sha256` | string \| null | SHA-256 of these exact `source` bytes (null on a pre-0015 version) — the currency token to cache; see `current_source_sha256` on [`DocumentListing`](#documentlisting) |
| `stripped` | string[] | constructs the sanitizer removes from `S` (re-derived at read time) |
| `will_not_render` | string[] | constructs that survive sanitization but the render CSP blocks (re-derived at read time) |
| `unsanitized` | `true` | always `true` — provenance marker; the bytes are pre-sanitization (see the caveat under [`/source`](#get-dpublic_idsource)) |
| `title` | string \| null | the source version's title |
| `description` | string \| null | the source version's description |
| `tags` | string[] | the document's tags (document-level; `[]` when unset) |
| `slug` | string \| null | document slug; null when unset |
| `status` | `"active" \| "deprecated" \| "archived"` | the document's lifecycle status (document-level — see [`DocumentListing`](#documentlisting)) |
| `superseded_by` | string \| null | replacement doc's `public_id` (deprecated only; never auto-followed) |

### `DocumentLinksResponse`

Returned by [`GET /d/:public_id/links`](#get-dpublic_idlinks); the same
`backlinks`/`outbound` pair rides the MCP `read_document` envelope under
`include_links: true` (there named `backlinks` / `outbound_links`).
**Canonical:** `#/components/schemas/DocumentLinksResponse` (member:
`OutboundLink`).

| Field | Type | Notes |
|---|---|---|
| `public_id` | string | the document whose neighborhood this is |
| `backlinks[]` | [`DocumentListing`](#documentlisting) | live docs whose current version links here, newest first, capped at 200 |
| `outbound[]` | `OutboundLink` | this doc's on-platform links in authored order |

`OutboundLink`:

| Field | Type | Notes |
|---|---|---|
| `kind` | `"public_id" \| "slug"` | which namespace the href addressed (`/d/` or `/s/`) |
| `value` | string | the raw addressed name as authored (late binding — stored unresolved) |
| `state` | `"live" \| "redirected" \| "retired" \| "revoked" \| "missing"` | what the target resolves to **now** (see the state table under [`/links`](#get-dpublic_idlinks)); the last three are broken links |
| `target_public_id` | string \| null | the resolved live target (`live`: itself; `redirected`: the forward target); else null |
| `title` | string \| null | the live target's title, when one resolves |

---

## The MCP surface

`/mcp` is a **Streamable-HTTP MCP transport**, not a REST endpoint — it speaks
JSON-RPC and is consumed by MCP clients (hosted Claude, Cowork), authenticated
via OAuth (Door A) or a static `awh_` bearer (Door B). It exposes **eight
agent-scoped tools**:

`publish_document` · `update_document` · `edit_document` · `read_document` ·
`list_documents` · `search_documents` · `load_context_pack` ·
`create_publish_credential`

The tools share the same write path (and thus the same sanitization, metadata
inheritance, slug rules, and error codes) documented above — HTML vs Markdown is
a `format` parameter rather than separate tools. Their full input schemas live in
`src/mcp.ts` (each field is self-documented) and the authoring contract is the
on-platform publishing guide (slug `slopcafe-publishing-guide`), which mirrors
`skills/publishing.md`. Read it with the document tools in one call —
`read_document slug:"slopcafe-publishing-guide"` (it is **not** an MCP resource;
resources aren't surfaced to most connector models, so the guide lives on the
document surface every agent already uses).

**Tool failures are code-prefixed.** An MCP error result's text is
`"<code>: <message>"` — e.g. `slug_taken: …`, `edit_not_unique: …`,
`version_conflict: …`. `isError` results skip `outputSchema` validation, so that
prefix is the only machine-readable contract a *failure* has, and it is what
makes the codes the tool descriptions advertise actually branchable. The
vocabulary overlaps the HTTP [`error` codes](#error-envelope) but is not
identical: MCP also surfaces core-internal conditions with no HTTP twin
(`version_conflict`, `edit_not_unique`, `version_not_found`), which the HTTP door
maps onto status codes instead.

**Write and read envelopes echo `visibility`.** Every successful
`publish_document` / `update_document` / `edit_document` / `read_document`
carries the document's anonymous-readability (`"public"` | `"private"`).
Documents are born `private` on this deployment while an agent key reads
everything, so without the echo an agent has no way to know the URL it is about
to hand a human `404`s for them. It is **read-only over MCP by decision**: no
tool takes `visibility` as an input, and only the operator flips it (the
[manage page](#browser--session-endpoints), or
[`POST /admin/documents/:id/visibility`](#post-admindocumentspublic_idvisibility)).

**They also echo `published_version`.** A `public` document renders its
**published** version, which only the operator moves ([published vs
current](#published-vs-current-version)), so a successful write does not by
itself mean the live page changed. The echo is the version the page is serving:
when it is `null` or lower than the `version` the tool just wrote on a public
document, the bytes are stored and **awaiting the operator's promote** — say
that, rather than reporting the page as updated. On a private document the page
always renders the current version, so the field is informational there.
Read-only for the same reason as `visibility`, and more so: publishing is the
anonymous-surface-expanding verb, so there is no MCP promote tool and no plan for
one. (Note the spelling — MCP envelopes write version numbers in full,
`published_version`, while listing rows carry the D1 column name,
`published_ver`. Both are correct in their own place.)

**Every tool also declares an `outputSchema` and returns `structuredContent`**
(MCP structured tool output). The response envelopes are pinned by the MCP
envelope schemas in `src/contract.ts` — the same Zod module the HTTP wire shapes
and OpenAPI components are generated from — and the SDK validates every
non-error result against them before it leaves the server. Clients that don't
understand structured output are unaffected: the identical JSON rides in the
legacy text content block. Shape documentation lives in those schemas (surfaced
through `tools/list`); the tool descriptions carry only the behavioral contract.

**All three document-addressing tools take a slug** (exactly one identifier per
call — the pair is an XOR, which JSON Schema can't express, so the server
enforces it and answers `bad_request` otherwise):

- `read_document` — `public_id` **or** `slug`.
- `update_document` / `edit_document` — `public_id` **or** **`document_slug`**.
  The identity field is spelled `document_slug`, *not* `slug`, because on these
  two tools `slug` is already the **rename** field — and a rename retires the old
  name forever, so one name for two meanings would put a permanent slug
  retirement one confusion away. `document_slug` only *addresses*; it never
  changes anything.

A write is never routed through a retired slug's redirect (that would patch a
document the caller never named): a retired `document_slug` is a hard
`slug_retired`, naming the forward target for reads only.

**An agent cannot rename a `public` document.** `update_document` /
`edit_document` fail **`slug_locked`** when the `slug` field would change or clear
a public document's slug (re-sending the same value stays a no-op) — the same
rule as the HTTP `403` on [`PUT /d/:id`](#put-dpublic_id), for the same reason:
shedding a name retires it forever, and a public document's name is one the world
already holds. Re-send without `slug` to change the content, or ask the operator
to rename it. A `private` document's slug is still an agent's to set.

Both read formats also have a one-hop HTTP analogue by slug, **each requiring a
credential (an agent key or the operator)**: `GET /s/:slug` (with the credential)
for the **raw HTML** bytes, and [`GET /s/:slug/text`](#get-sslugtext) for the
**Markdown** derivation. (Only the no-auth `GET /s/:slug` shell is public on the
slug surface.) Every read envelope still echoes the resolved `public_id`, so a
slug-initiated read→write loop can use either handle.

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

**`read_document` version history.** Documents are versioned (each update/edit
appends a version; prior bytes are retained). Two optional, additive parameters:

- **`version`** (positive integer) reads a *specific* historical version instead
  of the current one — works with any `representation`/`format`. A version that
  doesn't exist → `version_not_found`. Omit for the current version. The body,
  `title`, and `description` are that version's; **`tags` and `slug` are the
  document's *current* values** (both are document-level, not part of a version's
  content), so a version-pinned read reflects today's tags — the same way slug
  already behaves on a historical read.
- **`include_history`** (boolean, default false) adds `current_version` (the
  live version number) and a newest-first `history[]` to the envelope — each
  entry `{ version, created_at, size_bytes, source_format, title, is_current,
  author_kind, author_id, author_name }`, capped at the **200 most recent**
  versions (an older one is still readable by its `version` number).
  `author_kind` is `"agent"` or `"operator"` (the operator authors via the
  browser/app, not MCP); `author_id`/`author_name` identify the writing agent
  and are null for an operator-written version (or a pre-0013 version, whose
  writer survives only in R2 metadata). Metadata only (no extra body fetch). Use
  it to see what changed, who wrote each version, or to pick a `version` to read.

**`read_document` link graph** (issue #40). A third optional, additive flag —
**`include_links`** (boolean, default false) — attaches the document's
link-graph neighborhood to the envelope: `backlinks[]` (live documents whose
bodies link to this one, as full listing rows — the "what else references
this?" traversal primitive) and `outbound_links[]` (this doc's on-platform
links with resolution states; `retired`/`revoked`/`missing` are broken links
worth fixing, `redirected` means "update the link"). The same data as the HTTP
[`GET /d/:public_id/links`](#get-dpublic_idlinks) endpoint. Metadata only, no
body fetches; the graph is per-document (current version), so a version-pinned
read still reports the doc's current links — like tags/slug/status.

Restoring a version is **operator-only** — the JSON
[`POST /admin/documents/:public_id/restore`](#post-admindocumentspublic_idrestore)
or the manage page's
[`POST /d/:public_id/restore`](#browser--session-endpoints). There is no agent
restore in v1 — an agent reads history and can *propose* one. There is no HTTP
twin of the *agent-facing* `version`/`include_history` read knobs (they are
MCP-only); the operator's HTTP views are
[`GET /d/:public_id/v/:n`](#get-dpublic_idvn-and-get-dpublic_idvnraw) (bytes) and
[`GET /admin/documents/:public_id/versions`](#get-admindocumentspublic_idversions)
(JSON manifest).

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

**`edit_document`'s concurrency default differs from `update_document`'s.** An
explicit `expected_version` behaves identically on both, but *omitting* it is
**not** a clobber here: the edit is guarded against the version whose source it
actually matched, so a write that landed in between surfaces as
`version_conflict` instead of silently reverting it. Recover by re-reading with
`representation:"source"`, re-applying, and retrying. (`update_document` replaces
the whole body, so an omitted `expected_version` there is last-write-wins by
design — see [`PUT /d/:id`](#put-dpublic_id), whose `If-Match` is required for
exactly the same reason.)

**`list_documents` is also the change feed.** It takes the same
`order: "created" | "updated"` and `updated_since` knobs as
[`GET /d`](#get-d) — `order:"updated"` walks most-recently-changed first
(content writes, reclassification, publishes, *and* revokes), `updated_since`
windows it inclusively, and a cursor carries the ordering that minted it (replaying one
under the other ordering is a hard `bad_cursor`). `search_documents` accepts
`updated_since` but has no `order`. That pair is what lets an agent maintaining a
knowledgebase ask "what moved since I last looked" without re-reading the corpus.

**`load_context_pack`.** The document/manifest-rooted [context
pack](#packresponse) (issue #21): `from` (a slug — curated packs are
conventionally `pack-<name>` — or a public_id) resolves the root; its members
are the root's fenced ` ```pack ` **manifest block** when present (parsed from
the retained source `S`; one slug-or-public_id per line, `#` comments, an
`[optional]` line switching to the optional tier, per-entry free-text hints),
else its **outbound `/d/`+`/s/` links** in order of appearance (any index page
is a pack with zero ceremony; a manifest always wins). Same budget knobs and
omit-and-report contract as `?include_bodies=true` on search, plus
`follow_redirects: true` to substitute a deprecated member's `superseded_by`
replacement into the fill (the original still appears in `omitted[]` — the swap
is never silent; single-hop). The root's own prose returns as
`pack.root.content`, un-budgeted. Self-references are dropped; member
resolution caps at 200 refs. The HTTP twin is [`GET /d/pack`](#get-dpack)
(same core, same envelope); automatic query-rooted packs ride
`?include_bodies=true` on either search door.

For wiring a connector, see `skills/connector-guide.md` in the repo.
