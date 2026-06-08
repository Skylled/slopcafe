# Phase 2 route table (the OpenAPI `paths` source)

> Working spec for Phase 2 of `api-contract-design.md`. Generated + adversarially
> verified by the `api-contract-phase2-routes` workflow (64 routes).
> This is the discovery artifact `src/openapi.ts` is built from — not a bundled doc.
> Once OpenAPI generation lands, the generated `openapi.json` is canonical and this
> file can be retired.

# Route Table: Slopcafe HTTP API

## Overview

| Total Routes | 64 |
| --- | --- |

---

## Document Surface

### Core Document Operations

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| POST | /d | agent_key | text/html, text/markdown (raw body); X-Doc-Title, X-Doc-Description, X-Doc-Tags, X-Doc-Slug, X-Content-SHA256 (headers) | 201 WriteOk (without `ok`); 400 empty_body \| bad_integrity_header \| bad_request; 401 unauthorized; 409 slug_taken \| slug_retired; 413 too_large \| storage_cap_exceeded; 415 unsupported_media_type; 422 invalid_slug \| integrity_mismatch | Body integrity checked via X-Content-SHA256. Metadata headers optional. Metadata headers are optional. Returns WriteOk shape minus ok field. |
| GET | /d/{public_id} | public\|operator\|agent_key | Authorization (optional Bearer) | 200 HTML shell (no auth) or sanitized bytes (valid agent key); 304 (shell branch never returns this); 401 unauthorized; 404 HTML 404 page (no auth) or plain text (agent key) | Content-negotiates on Authorization header. No header→shell HTML. Valid key→raw bytes. Bad key→401 JSON. Cache-Control: no-store, Vary: Cookie. Shell branch does NOT check If-None-Match; only serveRaw does. |
| PUT | /d/{public_id} | agent_key | text/html, text/markdown (raw body); If-Match (required), X-Doc-Title, X-Doc-Description, X-Doc-Tags, X-Doc-Slug, X-Content-SHA256 (headers) | 200 WriteOk (without `ok`); 400 empty_body \| bad_request \| bad_integrity_header; 401 unauthorized; 404 not_found; 409 slug_taken \| slug_retired; 412 precondition_failed (If-Match mismatch); 413 too_large \| storage_cap_exceeded; 415 unsupported_media_type; 422 invalid_slug \| integrity_mismatch; 428 precondition_required (If-Match missing) | If-Match header mandatory (RFC 6585). Metadata headers inherit from prior version if absent, clear if empty. ETag response header set. Returns WriteOk shape minus ok field. |
| DELETE | /d/{public_id} | operator | X-CSRF-Token (if cookie session); no body | 200 {revoked: true, public_id, r2_objects_purged}; 401 unauthorized; 403 csrf_failed; 404 not_found | Operator-gated via Bearer token OR session cookie + CSRF. Revoke is idempotent-ish: second DELETE on revoked doc returns 404. Wire shape remaps RevokeOk.ok→revoked. |
| GET | /d/{public_id}/raw | public\|operator\|agent_key | If-None-Match (optional) | 200 sanitized HTML bytes (Markdown docs get reading theme prefix); 304 (If-None-Match satisfied); 404 plain text 'Not Found' | Visibility gate: private docs 404 to anon, operator reads all. Sets ETag header. Markdown docs get reading theme injected at serve time. Streams from R2. |
| GET | /d/{public_id}/text | agent_key | Authorization (Bearer, required) | 200 Markdown derivation (ReadTextOk); 401 unauthorized; 404 plain text 'Not Found' | Agent-gated (not public). Returns ReadTextOk shape. Sets x-sanitizer-version, x-converter-version headers, ETag. |
| GET | /d/{public_id}/source | agent_key | Authorization (Bearer, required) | 200 ReadSourceOk (unsanitized source + advisories); 401 unauthorized; 404 plain text; 409 source_unavailable | Agent-gated. Returns retained UNSANITIZED source S + re-derived advisories. 409 for un-backfilled legacy docs. Wire includes explicit unsanitized:true marker. |

### Slug Surface

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| GET | /s/{slug} | public\|operator\|agent_key | Authorization (optional), follow_redirects (query param) | 200 HTML shell (no auth) or bytes (valid key); 401 unauthorized; 404 HTML 404 (no auth) or plain text (agent key); 409 slug_redirected (agent, retired slug, no follow_redirects); 410 HTML Gone (no auth, retired, no redirect) or JSON (agent key) | Content-negotiates like /d/:id. Retired slug handling: follow_redirects=true→target bytes; false/absent→409 or 410. Shell branch does NOT check If-None-Match. |
| GET | /s/{slug}/text | agent_key | Authorization (Bearer), follow_redirects (query param) | 200 Markdown; 401 unauthorized; 404 plain text; 409 slug_redirected; 410 JSON gone | Agent-gated. Slug-addressed twin of /d/:id/text. Retired slug handling mirrors /s/:slug. |

### Version History (Operator-Only)

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| GET | /d/{public_id}/v/{n} | operator | Cookie (session, optional) | 200 HTML shell with historical version banner; 404 HTML 404 | Operator-only history view. Non-operator gets opaque 404. Version n must be /^[1-9][0-9]*$/. |
| GET | /d/{public_id}/v/{n}/raw | operator | If-None-Match (optional), Cookie | 200 sanitized HTML bytes of historical version; 304 (If-None-Match satisfied); 404 plain text 'Not Found' | Operator-only. Sets ETag. Historical versions immutable→304 on cache hit. RAW_CSP applied. |

### Management UI (Operator-Only, Form-Based)

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| GET | /d/{public_id}/manage | operator | Cookie (session, required) | 200 HTML management page (visibility, slug, version history, revoke) or sign-in prompt (no cookie); 404 plain text | Operator-only. Cookie session required for controls. Non-cookie caller gets sign-in prompt. Vary: Cookie. |
| POST | /d/{public_id}/visibility | operator | form: visibility ('public'\|'private'), operator_token?, csrf_token? | 200 HTML manage page (cookie) or result card (bearer); 400 result card; 401 result card; 403 result card; 404 result card | Operator-auth ladder: pasted operator_token OR cookie+csrf_token. No version bump. |
| POST | /d/{public_id}/slug | operator | form: slug (string, empty to clear), operator_token?, csrf_token? | 200 HTML manage page or result card; 401 result card; 403 result card; 404 result card; 409 result card (slug_taken \| slug_retired); 422 result card (invalid_slug) | Add/rename/clear slug. No version bump. Rename auto-forwards old slug. |
| POST | /d/{public_id}/restore | operator | form: version (/^[1-9][0-9]*$/), operator_token?, csrf_token? | 200 HTML manage page or result card; 400 result card; 401 result card; 403 result card; 404 result card; 409 result card (source_unavailable \| version_conflict); 413 result card; 507 result card (storage_cap_exceeded) | Re-publish historical version as NEW version. Source required. Cookie→manage page; bearer→terminal card. |
| GET | /d/{public_id}/revoke | operator | Cookie (session, optional) | 200 HTML confirmation form; 404 plain text | Confirmation page. Session-aware: cookie→hidden CSRF form; no session→token field. Opaque 404. Vary: Cookie. |
| POST | /d/{public_id}/revoke | operator | form: operator_token?, csrf_token? | 200 HTML success card; 401 HTML error card; 403 HTML error card; 404 HTML error card | Two auth paths: operator_token OR cookie+csrf_token. Returns terminal HTML (never 302). Revoke is kill switch. |

---

## Public / Static Routes

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| GET | / | public | none | 200 HTML (shell with iframe to HOMEPAGE_PUBLIC_ID/raw); 404 plain text 'Not Found' | Public landing page. Homepage doc hardcoded. Opaque 404 if homepage doc missing/revoked. No noindex (intentionally searchable). |
| GET | /healthz | public | none | 200 {ok, service, sanitizer_version, storage_cap_bytes, d1, r2} | Health/smoke check. Confirms D1 and R2 bindings. Exact counts safe for new deploys. |
| GET | /shell.js | public | none | 200 text/javascript | Public toolbar enhancement script. Loaded under 'script-src self'. Progressive enhancement. |

---

## Authentication UI (Browser Session & OAuth)

### Session Management

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| GET | /login | public | next (query, validated same-origin path) | 200 HTML login form | Operator browser session sign-in. Renders password input for operator_token. |
| POST | /login | public | form: operator_token, next | 302 to next (with Set-Cookie: session + CSRF); 400 form re-rendered; 401 form re-rendered | Validates operator token (constant-time check). Sets signed session + readable CSRF cookies. |
| GET | /logout | public | none | 200 HTML confirmation form | Logout confirmation page. Confirm-before-logout defense. |
| POST | /logout | public | form: csrf_token? | 302 to / (clears cookies); 403 form re-rendered | Clears both session and CSRF cookies. CSRF check required. |

### OAuth 2.0

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| GET | /authorize | public | client_id, redirect_uri, state, response_type, scope, code_challenge?, code_challenge_method? (query) | 200 HTML consent card (bound agent), bind-or-mint card (unbound), TOFU callback card, or error card; 400 HTML error card | OAuth consent UI. Session-aware: operator sees repair cards; non-operators see generic errors + login link. Inline TOFU approval, bind-or-mint, login-from-/authorize. |
| POST | /authorize | operator | form: action ('allow'\|'deny'\|'allow_callback'), agent_mode?, agent_name?, agent_id?, operator_token?, csrf_token? | 200 HTML card ('Request denied' or 'Callback approved'); 302 to client redirect_uri (action=allow); 400 HTML card; 401 HTML card; 403 HTML card; 409 HTML card (bind race); 500 HTML card | Operator-auth (Bearer or session+CSRF). Handles allow/deny/approve_callback. Binds unbound clients at consent. Client ID + redirect_uri from query. |
| POST | /token | oauth_library | standard OAuth token request | 200 {access_token, token_type, expires_in, scope, ...}; 400 OAuth error | OAuth token endpoint. Issued by OAuthProvider library. Issues 900s TTL access tokens. |
| POST | /register | oauth_library | OAuth DCR request (if ENABLE_DCR=true) | 201 {client_id, client_secret, expires_at, ...}; 400 DCR error | Dynamic Client Registration (optional). Public self-registration. 90-day TTL. |
| GET | /.well-known/oauth-authorization-server | oauth_library | none | 200 {issuer, authorization_endpoint, token_endpoint, ...} | OAuth 2.1 discovery metadata. |
| GET | /.well-known/oauth-protected-resource | oauth_library | none | 200 {...} | OAuth protected resource metadata. |

---

## Agent MCP Surface

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| * | /mcp | agent_key (Door A: OAuth token; Door B: awh_ bearer) | application/json (JSON-RPC 2.0 request) | 200 application/json (JSON-RPC response, Server-Sent Events stream); 401 (rejected by OAuthProvider before reaching handler) | Streamable HTTP MCP. Serves tools: publish_document, update_document, edit_document, read_document, list_documents, search_documents, create_publish_credential. Resources: awh://publishing-guide. Not REST—JSON-RPC over HTTP. |

---

## Operator Admin: Agents

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| GET | /admin/agents | operator | limit?, cursor? (query) | 200 {agents: [{id, name, created_at, active_keys, total_keys, live_docs}], next_cursor}; 400 bad_limit \| bad_cursor; 401 unauthorized; 403 csrf_failed | List agents (created_at DESC, id DESC). Paginated. |
| POST | /admin/agents | operator | {name: string} | 201 {agent_id, key_id, key (plaintext), note}; 400 bad_json \| bad_request; 401 unauthorized; 403 csrf_failed; 500 misconfigured | Mint agent + initial key (one transaction). Plaintext key one-shot. |
| GET | /admin/agents/{agent_id}/keys | operator | limit?, cursor? (query) | 200 {agent_id, name, keys: [{id, key_prefix, created_at, revoked_at}], next_cursor}; 400 bad_limit \| bad_cursor; 401 unauthorized; 403 csrf_failed; 404 not_found | List keys for agent. Paginated. |
| POST | /admin/agents/{agent_id}/keys | operator | (empty body) | 201 {agent_id, key_id, key (plaintext), note}; 401 unauthorized; 403 csrf_failed; 404 not_found; 500 misconfigured | Mint additional key. Rotation. Plaintext one-shot. |
| DELETE | /admin/agents/{agent_id} | operator | none | 200 {revoked: true, agent_id, keys_revoked, oauth_clients_deleted}; 401 unauthorized; 403 csrf_failed; 404 not_found | Cascading kill: revokes all keys + OAuth clients. |
| DELETE | /admin/keys/{key_id} | operator | none | 200 {revoked: true, key_id, agent_id, key_prefix}; 401 unauthorized; 403 csrf_failed; 404 not_found | Per-key revoke. Idempotent-ish: second DELETE → 404. |

---

## Operator Admin: Documents

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| GET | /admin/documents | operator | limit?, cursor? (query) | 200 {documents: [DocumentListing], next_cursor}; 400 bad_limit \| bad_cursor; 401 unauthorized; 403 csrf_failed | List all documents (incl. revoked). Paginated. |
| GET | /admin/documents/search | operator | q (required, FTS query), tag?, slug?, limit? (query) | 200 {documents: [SearchHit]}; 400 bad_limit \| bad_query; 401 unauthorized; 403 csrf_failed; 422 bad_query (no usable terms) | BM25 search (live docs only). Tags/slug optional filters. |
| POST | /admin/documents/{public_id}/visibility | operator | {visibility: 'public'\|'private'} | 200 {public_id, visibility}; 400 bad_json \| invalid_visibility; 401 unauthorized; 403 csrf_failed; 404 not_found | Set doc visibility. No version bump. Idempotent. |
| POST | /admin/documents/{public_id}/slug | operator | {slug: string (empty to clear)} | 200 {public_id, slug, retired?, redirected?}; 400 bad_json \| bad_request; 401 unauthorized; 403 csrf_failed; 404 not_found; 409 slug_taken \| slug_retired; 422 invalid_slug | Add/rename/clear slug. No version bump. Rename auto-forwards. |
| POST | /admin/documents/{public_id}/tags | operator | {tags: [string]} | 200 {public_id, tags}; 400 bad_json \| bad_request; 401 unauthorized; 403 csrf_failed; 404 not_found | Replace doc-level tags (full replacement). No version bump. Idempotent. |

---

## Operator Admin: Slug Tombstones

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| POST | /admin/slugs/{slug}/redirect | operator | {target_public_id: string} | 200 {slug, redirect_to, target_slug, target_title}; 400 bad_json \| bad_request; 401 unauthorized; 403 csrf_failed; 404 not_found; 422 bad_target | Point retired slug at live doc (loud redirect). Migration 0010. |
| DELETE | /admin/slugs/{slug}/redirect | operator | none | 200 {slug, redirect_to: null}; 401 unauthorized; 403 csrf_failed; 404 not_found | Clear retired slug redirect (back to 410 Gone). |
| DELETE | /admin/slugs/{slug} | operator | none | 200 {released: true, slug}; 401 unauthorized; 403 csrf_failed; 404 not_found | Force-release retired slug (escape hatch). |

---

## Operator Admin: OAuth Clients

| Method | Path | Auth | Request | Responses | Notes |
|--------|------|------|---------|-----------|-------|
| POST | /admin/agents/{agent_id}/oauth-clients | operator | (empty body) | 201 {client_id, client_secret (plaintext), mcp_url, agent_id, agent_name, note}; 401 unauthorized; 403 csrf_failed; 404 not_found; 409 client_exists | Mint OAuth client bound to agent. One per agent. Plaintext secret one-shot. |
| POST | /admin/oauth-clients | operator | (empty body) | 201 {client_id, client_secret (plaintext), mcp_url, note}; 401 unauthorized; 403 csrf_failed | Mint UNBOUND OAuth client. Agent bound later at /authorize. Plaintext secret one-shot. |
| DELETE | /admin/oauth-clients/{client_id} | operator | none | 200 {revoked: true, client_id, agent_id?} or {revoked: true, client_id, unbound: true}; 401 unauthorized; 403 csrf_failed; 404 not_found | Cascading revoke: invalidates all grants + live tokens. Bound or unbound. |

---

## Content-Negotiated / Non-JSON Routes (OpenAPI Limitations)

The following routes support content-negotiation, conditional responses, or HTML form submissions that OpenAPI can only partly model. These remain in prose documentation (docs/http-api.md) and receive minimal OpenAPI entries:

- **GET /d/{public_id}** — Negotiates on `Authorization` header: returns shell HTML (no header), raw bytes (valid key), or 401 JSON (bad key). Varies by Cookie. No If-None-Match support on shell branch.
- **GET /s/{slug}** — Like /d/{public_id}; negotiates on Authorization. Shell does not support If-None-Match.
- **GET /d/{public_id}/raw** — Supports If-None-Match conditional with ETag. Can return 304.
- **GET /d/{public_id}/v/{n}/raw** — Supports If-None-Match conditional. Can return 304.
- **POST /d/{public_id}/visibility, /slug, /restore, /revoke** — Form-based (application/x-www-form-urlencoded) with dual response paths: cookie auth returns re-rendered HTML manage page; bearer token returns terminal result card.
- **GET /, /login, /logout, /authorize, /d/{public_id}/manage, /d/{public_id}/revoke** — Return HTML pages, not JSON. Not modeled in OpenAPI.
- **GET /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource** — OAuth standard discovery. Served by OAuthProvider library.

---

## Error Handling

All JSON error responses share the envelope `{error: ErrorCode, message: string, ...context}` where context fields are code-specific. The complete ErrorCode set (alphabetical):

bad_cursor, bad_integrity_header, bad_json, bad_limit, bad_query, bad_request, bad_slug, bad_target, client_exists, csrf_failed, empty_body, gone, integrity_mismatch, internal, invalid_slug, invalid_visibility, misconfigured, not_found, precondition_failed, precondition_required, slug_redirected, slug_retired, slug_taken, source_unavailable, storage_cap_exceeded, too_large, unauthorized, unsupported_media_type

---

## Summary by Area

- **Document Core (9 routes)** — POST/PUT/DELETE /d, GET /d/{id}, GET /d/{id}/raw, /text, /source
- **Slug Surface (2 routes)** — GET /s/{slug}, /s/{slug}/text
- **Version History (2 routes)** — GET /d/{id}/v/{n}, /v/{n}/raw
- **Management UI (7 routes)** — GET/POST /d/{id}/manage, /visibility, /slug, /restore, /revoke
- **Public / Static (3 routes)** — GET /, /healthz, /shell.js
- **Session & OAuth (7 routes)** — GET/POST /login, /logout, GET/POST /authorize, POST /token, GET /.well-known/*
- **MCP (1 route)** — * /mcp
- **Admin: Agents (6 routes)** — GET/POST /admin/agents, GET/POST /admin/agents/{id}/keys, DELETE /admin/agents, DELETE /admin/keys
- **Admin: Documents (5 routes)** — GET /admin/documents, /search, POST /admin/documents/{id}/visibility, /slug, /tags
- **Admin: Slugs (3 routes)** — POST/DELETE /admin/slugs/{slug}/redirect, DELETE /admin/slugs/{slug}
- **Admin: OAuth (3 routes)** — POST /admin/agents/{id}/oauth-clients, POST /admin/oauth-clients, DELETE /admin/oauth-clients

**Total: 64 routes**

---

## Wire schemas to add to `src/contract.ts`

The internal `{ok:true,...}` Result schemas exist (Phase 1); these are the **wire**
variants (handlers strip `ok`, remap a few names). Derive from existing schemas
where possible (`.omit({ ok: true })` / `.extend(...)`):

**Derived from Phase-1 schemas:**
- `WriteResponse` = `WriteOkSchema.omit({ ok: true })`
- `EditResponse` = `EditOkSchema.omit({ ok: true })`
- `RestoreResponse` = `RestoreOkSchema.omit({ ok: true })`
- `ReadTextResponse` = `ReadTextOkSchema.omit({ ok: true })`
- `ReadSourceResponse` = `ReadSourceOkSchema.omit({ ok: true }).extend({ unsanitized: z.literal(true) })` — the handler ADDS `unsanitized:true`
- `ListVersionsResponse` = `ListVersionsOkSchema.omit({ ok: true })`
- `RevokeResponse` = **new** `{ revoked: true, public_id, r2_objects_purged }` (RevokeOk remaps `ok`→`revoked`)

**Wrappers (new, but reference existing schemas):**
- `ListDocumentsResponse` = `{ documents: DocumentListing[], next_cursor: string | null }`
- `SearchDocumentsResponse` = `{ documents: SearchHit[] }` (NO `next_cursor` — search isn't paginated)

**New response shapes (currently inline object literals in handlers):**
- `HealthzResponse` = `{ ok: true, service, sanitizer_version, storage_cap_bytes, d1: { documents: number|null, agents: number|null }, r2: { bucket_reachable: boolean, sample_object_count: number } }`
- `ListAgentsResponse` = `{ agents: { id, name, created_at, active_keys, total_keys, live_docs }[], next_cursor: string|null }`
- `ListAgentKeysResponse` = `{ agent_id, name, keys: { id, key_prefix, created_at, revoked_at: string|null }[], next_cursor: string|null }`
- `MintAgentResponse` = `MintAgentKeyResponse` = `{ agent_id, key_id, key, note }` (`key` is a one-time plaintext secret)
- `RevokeAgentResponse` = `{ revoked: true, agent_id, keys_revoked, oauth_clients_deleted }`
- `RevokeKeyResponse` = `{ revoked: true, key_id, agent_id, key_prefix }`
- `SetDocumentVisibilityResponse` = `{ public_id, visibility: "public"|"private" }`
- `SetDocumentSlugResponse` = `{ public_id, slug: string|null, retired: string|null, redirected: boolean }`
- `SetDocumentTagsResponse` = `{ public_id, tags: string[] }`
- `SetSlugRedirectResponse` = `{ slug, redirect_to: string, target_slug: string|null, target_title: string|null }`
- `ClearSlugRedirectResponse` = `{ slug, redirect_to: null }`
- `ReleaseSlugTombstoneResponse` = `{ released: true, slug }`
- `CreateOAuthClientResponse` = `{ client_id, client_secret, mcp_url, agent_id, agent_name, note }` (`client_secret` one-time)
- `CreateUnboundOAuthClientResponse` = `{ client_id, client_secret, mcp_url, note }`
- `DeleteOAuthClientResponse` = `{ revoked: true, client_id, agent_id }` | `{ revoked: true, client_id, unbound: true }` (discriminated)

**Error union:**
- `ErrorBody` = discriminated union on `error` (the 28 `ErrorCode`s). Base `{ error, message }` + per-code context: `slug_taken`/`slug_retired` → `{slug}`; `precondition_failed` → `{current_version, expected}`; `invalid_slug` → `{reason: SlugReject}`; `too_large` → `{limit}`; `storage_cap_exceeded` → `{used, cap, this_write}`; `slug_redirected` → `{slug, redirect_to:{public_id,slug,title}, hint}`; `bad_target` → `{target}`; `client_exists` → `{client_id, hint}`; `integrity_mismatch` → `{expected_sha256, actual_sha256, received_bytes}`; rest → none.

## Zod 4 generation mechanism (VERIFIED against 4.4.3)

Probed directly against the real contract schemas — the code-first path works with our pinned version:
- `z.toJSONSchema(schema)` and `z.globalRegistry` both exist → a thin in-repo assembler suffices; **no `zod-openapi` dep needed.**
- Nullable renders as `{anyOf:[{type:T},{type:"null"}]}`; enums render as `{type:"string", enum:[...]}` — clean for client codegen.
- Default target = JSON Schema 2020-12 → **OpenAPI 3.1**. `z.toJSONSchema(s, { target: "openapi-3.0" })` also works if a 3.0 consumer needs `nullable:true` style.
- **`ReadOkSchema` is NOT JSON-Schema-representable** (`z.instanceof(Uint8Array)` → "Custom types cannot be represented"). Correct: it's never JSON on the wire (the HTML-read route returns `text/html` raw bytes). EXCLUDE it from the JSON components; model its routes as `content: text/html` with no schema. (`{ unrepresentable: "any" }` is the escape hatch if ever needed.)
- For `$ref` reuse (one named component per shape), register each schema in `z.globalRegistry` with an `id` (or `.meta({ id })`) before `toJSONSchema`, so shared shapes emit as `#/components/schemas/X` instead of inlining.

## Build notes for `src/openapi.ts` (from the verified synthesis)

- **Security schemes (3):** `ApiKeyBearer` (apiKey, header `Authorization`, "Bearer awh_KEY"); `OAuthBearer` (oauth2 authorizationCode, authorizationUrl `/authorize`, tokenUrl `/token`); `CookieSession` (apiKey, cookie `awh_session` + `X-CSRF-Token` for mutations). Tag each operation with which door(s) it accepts.
- **Conditional GET:** only `/d/{id}/raw` and `/d/{id}/v/{n}/raw` honor `If-None-Match`→`304`. The shell routes (`/d/{id}`, `/s/{slug}`) do NOT — don't model `If-None-Match` for them.
- **Content-negotiated routes** (`GET /d/{public_id}`, `GET /s/{slug}`): response varies on `Authorization` (no header→HTML shell; valid key→raw bytes; bad key→401 JSON; private+anon→opaque 404). Model multiple response objects + a prose note; the precise behavior stays in `docs/http-api.md`.
- **HTML/UI routes** (`/`, `/login`, `/logout`, `/authorize`, `/d/{id}/manage`, `/d/{id}/revoke`, the form POSTs): minimal entries (`200 text/html`, no schema); keep prose in `docs/http-api.md`.
- **`/mcp`**: JSON-RPC, not REST — single `POST /mcp` entry with a note; not schema-validated. **OAuth-library routes** (`/token`, `/register`, `/.well-known/*`): served by `@cloudflare/workers-oauth-provider`; document as standard OAuth 2.1, don't hand-model.
- **Pagination:** `/admin/*` list routes take `limit` (default 50, max 200) + opaque `cursor`. `/admin/documents/search` takes required `q` + optional `tag`/`slug`, returns NO `next_cursor`.

## Implementation checklist (Phase 2)

1. Add the wire schemas above to `src/contract.ts`; extend `test/contract.test.mjs` to round-trip representatives + assert `ErrorBody` discriminates on `error`.
2. `src/openapi.ts` — a route registry (one entry per route in the table above) + an assembler: register component schemas in `z.globalRegistry` with `id`s → emit `components.schemas` via `z.toJSONSchema`; build `paths` from the registry; add the 3 securitySchemes. Exclude `ReadOk` (raw-bytes routes get `text/html`/`text/markdown`, no schema).
3. `npm run build:openapi` → writes `openapi.json` (committed); add to `predeploy`.
4. `GET /openapi.json` route in `src/index.ts` (public, beside `/healthz`).
5. `test/openapi.test.mjs` — assert the doc parses as valid OpenAPI 3.1, every `index.ts` route appears in the registry (completeness), and regenerating equals the committed `openapi.json` (freshness). Wire into `npm test`.
6. CI drift gate: `git diff --exit-code openapi.json` after regenerate.
7. Docs-sync (same commit): `docs/http-api.md` gets a `GET /openapi.json` entry; `CLAUDE.md` "Where things live" gets `src/openapi.ts` + `openapi.json`; `api-contract-design.md` §13 phase 2 → mark built. (Phase 2 is still wire-invisible EXCEPT the new `/openapi.json` route — so the wire-contract docs only gain that one endpoint.)

> **Optional (Phase 2b, riskier — touches handlers):** the shared response-mapper
> that replaces the hand-re-listed fields in `createDocument`/`updateDocument`/etc.
> (index.ts:508-522) with `toWriteResponse(result)` typed against `WriteResponse` —
> output-identical, kills the drift surface. Do after the spec lands, not before.
