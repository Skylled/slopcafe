// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * src/openapi.ts — Phase 2 of docs/design/api-contract-design.md.
 *
 * Turns the Zod source of truth (src/contract.ts) into an OpenAPI 3.1 document.
 * Two halves:
 *
 *   1. A schema REGISTRY — every wire shape from contract.ts registered with a
 *      stable id, so `z.toJSONSchema()` emits one named `#/components/schemas/X`
 *      per shape (and `$ref`s between them) instead of inlining copies. That is
 *      what makes a generated client get one `DocumentListing` class, not four
 *      anonymous ones (design §2.3).
 *
 *   2. A route REGISTRY — one entry per HTTP route in the verified route table
 *      (docs/design/api-contract-phase2-routes.md), carrying method/path/auth/request/
 *      responses. `buildOpenApiDocument()` walks it and assembles `paths`.
 *
 * Deliberately a thin, standalone-ish module: its only heavy dep is the
 * contract schemas + zod. It does NOT import D1/R2/WASM, so the build script
 * (`scripts/build-openapi.mjs`) and `test/openapi.test.mjs` run it under the
 * Node strip-types runner.
 *
 * We use a DEDICATED `z.registry()` rather than `z.globalRegistry` so emitting
 * the spec has no global side effects (nothing else in the Worker calls
 * `z.toJSONSchema(globalRegistry)`, but a private registry keeps it that way and
 * makes the component set explicit + ordered here).
 *
 * The OpenAPI doc can only PARTLY model some routes — content-negotiated reads
 * (`GET /d/{id}`, `/s/{slug}`), the HTML/UI surfaces, the JSON-RPC `/mcp`, and
 * the OAuth-library endpoints. Those get minimal entries + a prose `description`;
 * the behavioral contract stays in docs/http-api.md (design §6).
 */
import { z } from "zod";
import {
  BackfillResponseSchema,
  ClearSlugRedirectResponseSchema,
  CreateOAuthClientResponseSchema,
  CreateUnboundOAuthClientResponseSchema,
  DeleteOAuthClientResponseSchema,
  DocumentLinksResponseSchema,
  DocumentListingSchema,
  DocumentStatusSchema,
  ErrorBodySchema,
  HealthzResponseSchema,
  ListAgentKeysResponseSchema,
  ListAgentsResponseSchema,
  LinksBackfillResponseSchema,
  SeedPlatformDocsResponseSchema,
  ListDocumentsResponseSchema,
  ListVersionsResponseSchema,
  MintAgentKeyResponseSchema,
  OrphanDocumentsResponseSchema,
  OutboundLinkSchema,
  PackDocumentSchema,
  PackInfoSchema,
  PackOmittedSchema,
  PackResponseSchema,
  PackRootSchema,
  PromoteResponseSchema,
  ReadSourceResponseSchema,
  ReadTextResponseSchema,
  RedirectTargetSchema,
  ReleaseSlugTombstoneResponseSchema,
  RestoreResponseSchema,
  RevokeAgentResponseSchema,
  RevokeKeyResponseSchema,
  RevokeResponseSchema,
  SearchDocumentsResponseSchema,
  SearchHitSchema,
  SetDocumentSlugResponseSchema,
  SetDocumentStatusResponseSchema,
  SetDocumentTagsResponseSchema,
  SetDocumentVisibilityResponseSchema,
  SetSlugRedirectResponseSchema,
  SlugRejectSchema,
  SourceFormatSchema,
  VersionListingSchema,
  VisibilitySchema,
  WriteResponseSchema,
} from "./contract.js";

// ============================================================================
// Component registry — the named #/components/schemas the doc exposes
// ============================================================================

/**
 * The canonical version of the published contract (semver — see design §14).
 * Stable as of `1.0.0` (cut at the public launch): strict semver applies —
 * PATCH for doc/clarification-only edits, MINOR for additive/backward-compatible
 * shape changes, MAJOR for any break (removed/retyped field, changed code/status).
 *
 * `3.0.0` — OPEN WINDOW. Opened 2026-09-03 on branch `mcp-2026-07-28`, which
 * lands on `main` AS the v3.0.0 release. Until that merge, breaks ACCUMULATE
 * under this single frozen `3.0.0`: a second break does NOT make it `4.0.0`,
 * and takes no MINOR/PATCH bump either (applying the per-change rule literally
 * mid-window produced a wrong `3.0.0` cut in 2026-07 that had to be walked back
 * across seven files). Every break gets a numbered entry in THE `3.0` LEDGER,
 * in the order it was made; additive changes need no entry. Consumers pin the
 * `openapi.json` BYTES, not this string, and re-pin ONCE at the landing
 * (`cli/` three-pin procedure in CLAUDE.md; `slopcafe_ui` from `main`'s
 * `openapi.json`). Migrate the remote D1 BEFORE deploying any of it.
 *
 * THE `3.0` LEDGER — what `3.0.0` means to a consumer moving up from `2.x`.
 * Breaks, in the order they were made:
 *
 *   (none yet — the window opened on the unchanged `2.4.0` surface; the MCP
 *   2026-07-28 / MCP Apps work already on this branch is outside this document)
 *
 * Additive since `2.4.0` (no ledger entry needed): (none yet)
 *
 * ---------------------------------------------------------------------------
 * FROZEN HISTORY BELOW — the `2.x` line. `2.0.0` was the previous breaking
 * window (merged to `main` 2026-07-25, `b94c49a`); `2.1.0`–`2.4.0` were the
 * additive releases on top of it. Leave it; a `4.0.0` window opens its own.
 * ---------------------------------------------------------------------------
 *
 * SINCE `2.0.0`:
 *   `2.3.0` — additive, and mostly TRANSPORT rather than shape: cross-origin
 *     (CORS) support for a browser client on a separate origin, off unless the
 *     `CORS_ALLOWED_ORIGINS` [var] is set (src/cors.ts). No route, status code,
 *     error code or request/response body changed; what moved is which response
 *     HEADERS a cross-origin caller may read, and the fact that eligible routes
 *     now answer an `OPTIONS` preflight. The preflight is deliberately NOT
 *     modelled as per-route `OPTIONS` operations below: it is answered by a
 *     wrapper before dispatch, is identical for every eligible route, and
 *     spelling it out would double the operation count of this document to
 *     describe one uniform transport rule — the prose in `info.description` and
 *     docs/http-api.md carries it instead. Credentials are never allowed
 *     cross-origin (no `Access-Control-Allow-Credentials`), so the cookie
 *     session stays same-origin-only and bearer auth is the only cross-origin
 *     door. One genuine shape addition rides along: `HealthzResponse` gains a
 *     `cors` diagnostic block AND finally declares the `openapi`/`docs`/`mcp`
 *     discovery pointers it has emitted, undeclared, since the discovery block
 *     shipped — the schema said `additionalProperties: false` while the handler
 *     sent three more fields, so this corrects a spec that was wrong rather than
 *     merely incomplete.
 *   `2.2.0` — additive: the `visibility` and `publication` query filters on the
 *     two document LIST surfaces (`GET /d`, `GET /admin/documents`), the two
 *     SEARCH surfaces (`GET /d/search`, `GET /admin/documents/search`), and MCP
 *     `list_documents`. No response shape moved. `?visibility=public&
 *     publication=pending` is the review queue — the public documents whose
 *     newest version has not been promoted — which previously required paging
 *     the whole corpus and comparing `published_ver` to `current_ver` client-
 *     side. An unknown value for either is `400 bad_request` (the migration-0017
 *     precedent for enum-valued params, not a new error code), so nothing in the
 *     `ErrorBody` union changed. Note `publication` EXCLUDES revoked rows in both
 *     directions — the one filter on this surface that does, because revoke nulls
 *     both pointers and a dead row has no publication state to report.
 *   `2.1.0` — additive: `unchanged` on the write/edit responses (hence on the
 *     MCP write/edit envelopes). It carries a BEHAVIORAL change that is worth
 *     more attention than its MINOR classification suggests: `PUT /d/:id` — and
 *     every door that delegates to the same core (MCP `update_document` /
 *     `edit_document`, `PUT /admin/documents/:id`, restore) — now COLLAPSES a
 *     write whose source bytes, title, description, tags and slug all match what
 *     the document already holds. Such a call returns `200` with
 *     `unchanged: true` and `version` naming the version that was already there,
 *     having stored nothing. A successful write is therefore no longer a
 *     guarantee that the version number advanced. This is additive rather than
 *     breaking because no field changed type, no status or code moved, and the
 *     collapsed response describes the document's true state — but a consumer
 *     that counted versions to detect change, or asserted `v+1` after a write,
 *     must read `unchanged` instead. Publish is never collapsed.
 *
 * THE LEDGER — what `2.0.0` means to a consumer moving up from `1.x`. Breaks,
 * in the order they were made:
 *
 *   1. `DELETE /d/:id` is idempotent on an already-revoked document: `200` and a
 *      re-run purge where it used to `404`. Re-issuing the revoke is the
 *      documented recovery from a partial R2 purge, so telling the operator a
 *      retry was pointless left unsanitized `.src` bytes resident forever.
 *   2. `GET /d/:id/revoke` narrowed to operator-only — it read D1 up front and
 *      branched 200-vs-404 on existence, an oracle for exactly the private
 *      documents `/d/:id` hides.
 *   3. `GET /s/:slug` answers `410` where it answered `200`, for a retired slug.
 *   4. `/d/:id/text`, `/source` and `/links` answer their `404` as a JSON error
 *      body instead of `text/plain`, making the most common failure the one a
 *      JSON client could not parse.
 *   5. `GET /d/:id/raw` — and the shell, slug and homepage surfaces rendering the
 *      same bytes — serves a PUBLIC document's `published_ver`, not its
 *      `current_ver` (issue #43 / migration 0018). Same URL, same credential,
 *      DIFFERENT BYTES and a different `ETag` the moment an agent has written a
 *      version the operator has not promoted. A client that cached v3 re-reads
 *      v2, and the `ETag` it would have replayed as `If-Match` on the next
 *      `PUT /d/:id` now names the published version and earns a `412`. The
 *      replacement preflight is the `x-doc-current-version` response header on
 *      `/raw` (credentialed callers only). A deliberate security change, not a
 *      regression — see src/served-version.ts.
 *   6. `PUT /d/:id` answers `403 slug_locked` where it answered `200`, for an
 *      agent-authored slug change or clear on a PUBLIC document. A public slug is
 *      ~60 characters of agent-chosen text on an anonymous surface, so it moved
 *      into the operator-only class `visibility` already occupied.
 *   7. `POST /admin/documents/:id/restore` and `POST /admin/documents/:id/promote`
 *      answer `404 version_not_found` where they answered `404 not_found`, and
 *      the `version` context field moves off `ErrorBody`'s `not_found` member
 *      onto the new one, where it is REQUIRED. Same status class; the break is
 *      the discriminant. Folding "no such document" and "no such version of it"
 *      onto one code made the difference a field's PRESENCE — invisible to a
 *      client switching on `error` — and forced `not_found` to declare an
 *      optional `version` no other emitter ever set. A consumer switching on
 *      `error` adds one arm; one reading `not_found.version` must move to
 *      `version_not_found.version`. Safe to distinguish because both routes are
 *      behind `requireOperator`, and the agent door has surfaced this exact
 *      token through MCP `read_document` all along — see contract.ts.
 *
 * Everything else in the window is additive and needs no ledger entry — most
 * recently `POST /admin/documents/:id/promote` (+ the `PromoteResponse`
 * component), `published_ver` + `published_source_sha256` on `DocumentListing`
 * (hence on `SearchHit` and `PackDocument`), `is_published` + `source_sha256` on
 * `VersionListing`, the `slug_locked` member of `ErrorBody`, the declared
 * `version` context on `source_unavailable` (restore has emitted it, undeclared,
 * since before contract.ts existed), `GET /admin/documents/{public_id}`, and the
 * `set_document_tags` / `set_document_status` MCP tools.
 *
 * CONSUMERS RE-PIN ONCE, AT THIS LANDING. The in-repo CLI has done so
 * (`cli/tool/CONTRACT_VERSION` = `2.0.0`); out-of-repo consumers (the Flutter
 * app `slopcafe_ui`) re-pin from here: `cp openapi.json <consumer>/openapi.json`
 * + its contract-version marker, then regenerate (see the cli/ bullet in
 * CLAUDE.md for the three-pin procedure).
 *
 * A consumer doing optimistic concurrency MUST move its preflight to
 * `x-doc-current-version`, falling back to the `ETag` when that header is absent
 * (correct for a private document, and for any server predating this contract).
 * Re-pinning alone does NOT do this — it is hand-written client code, and a
 * client that keeps preflighting from the `ETag` will `412` on every public
 * document with unpublished work.
 */
export const OPENAPI_INFO_VERSION = "3.0.0";

/** The server URL baked into the committed openapi.json (overridable per-request). */
export const DEFAULT_SERVER_URL = "https://slopcafe.com";

const registry = z.registry<{ id: string }>();
const idOf = new Map<z.ZodType, string>();

/** Register a schema as a named component and remember its id for `$ref`s. */
function named<T extends z.ZodType>(id: string, schema: T): T {
  registry.add(schema, { id });
  idOf.set(schema, id);
  return schema;
}

// Order here is cosmetic only — components are sorted alphabetically on emit.
// Enums first (small, shared), then models, then wire-response shapes.
named("Visibility", VisibilitySchema);
named("SourceFormat", SourceFormatSchema);
named("SlugReject", SlugRejectSchema);
named("DocumentStatus", DocumentStatusSchema);
named("RedirectTarget", RedirectTargetSchema);
named("OutboundLink", OutboundLinkSchema);
named("DocumentListing", DocumentListingSchema);
named("SearchHit", SearchHitSchema);
named("VersionListing", VersionListingSchema);
named("PackInfo", PackInfoSchema);
named("PackRoot", PackRootSchema);
named("PackDocument", PackDocumentSchema);
named("PackOmitted", PackOmittedSchema);
named("PackResponse", PackResponseSchema);
named("WriteResponse", WriteResponseSchema);
named("RevokeResponse", RevokeResponseSchema);
named("ReadSourceResponse", ReadSourceResponseSchema);
// These three were contract.ts's "MCP-only" envelopes until the operator/agent
// HTTP twins landed: `ReadTextResponse` is now the `Accept: application/json`
// branch of GET /d/:id/text (+ the /s/:slug/text twin), and ListVersions/Restore
// back GET /admin/documents/:id/versions + POST .../restore. Registering them
// here is what makes a generated client share ONE VersionListing class with the
// manage-page shape instead of re-deriving it.
named("ReadTextResponse", ReadTextResponseSchema);
named("ListVersionsResponse", ListVersionsResponseSchema);
named("RestoreResponse", RestoreResponseSchema);
named("DocumentLinksResponse", DocumentLinksResponseSchema);
named("OrphanDocumentsResponse", OrphanDocumentsResponseSchema);
named("LinksBackfillResponse", LinksBackfillResponseSchema);
named("SeedPlatformDocsResponse", SeedPlatformDocsResponseSchema);
named("ListDocumentsResponse", ListDocumentsResponseSchema);
named("SearchDocumentsResponse", SearchDocumentsResponseSchema);
named("HealthzResponse", HealthzResponseSchema);
named("ListAgentsResponse", ListAgentsResponseSchema);
named("ListAgentKeysResponse", ListAgentKeysResponseSchema);
named("MintAgentKeyResponse", MintAgentKeyResponseSchema);
named("RevokeAgentResponse", RevokeAgentResponseSchema);
named("RevokeKeyResponse", RevokeKeyResponseSchema);
named("SetDocumentVisibilityResponse", SetDocumentVisibilityResponseSchema);
named("SetDocumentSlugResponse", SetDocumentSlugResponseSchema);
named("SetDocumentStatusResponse", SetDocumentStatusResponseSchema);
named("SetDocumentTagsResponse", SetDocumentTagsResponseSchema);
// The publication act (migration 0018), and the immediate sibling of
// SetDocumentVisibilityResponse above: visibility opens the door, this picks the
// bytes behind it. A two-field acknowledgement rather than a WriteResponse
// because nothing was written — only which existing version faces outward.
named("PromoteResponse", PromoteResponseSchema);
named("BackfillResponse", BackfillResponseSchema);
named("SetSlugRedirectResponse", SetSlugRedirectResponseSchema);
named("ClearSlugRedirectResponse", ClearSlugRedirectResponseSchema);
named("ReleaseSlugTombstoneResponse", ReleaseSlugTombstoneResponseSchema);
named("CreateOAuthClientResponse", CreateOAuthClientResponseSchema);
named("CreateUnboundOAuthClientResponse", CreateUnboundOAuthClientResponseSchema);
named("DeleteOAuthClientResponse", DeleteOAuthClientResponseSchema);
named("ErrorBody", ErrorBodySchema);

// The search 200 is shape-switched by ?include_bodies: the plain hit list, or
// the context-pack envelope. Registered as a named union so the route's 200
// $refs one component whose members $ref the two real shapes.
const SearchOrPackResponseSchema = z.union([SearchDocumentsResponseSchema, PackResponseSchema]);
named("SearchOrPackResponse", SearchOrPackResponseSchema);

function refFor(schema: z.ZodType): { $ref: string } {
  const id = idOf.get(schema);
  if (!id) throw new Error("openapi: schema not registered as a component");
  return { $ref: `#/components/schemas/${id}` };
}

/** Emit `components.schemas` from the registry, stripped of JSON-Schema noise. */
function buildComponentSchemas(): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(registry, {
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Record<string, unknown>> };
  const out: Record<string, unknown> = {};
  // Sort alphabetically so the committed file is stable regardless of
  // registration order, and drop the per-schema `$schema`/`$id` keys (OpenAPI
  // components don't carry them; `$ref`s resolve by the components map key).
  for (const id of Object.keys(schemas).sort()) {
    const { $schema, $id, ...rest } = schemas[id]!;
    void $schema;
    void $id;
    out[id] = rest;
  }
  return out;
}

// ============================================================================
// Security schemes (3) — the credential mechanisms a client wires up
// ============================================================================

const SECURITY_SCHEMES = {
  // `Authorization: Bearer <token>` — covers the agent `awh_` key (Door B) AND
  // the operator token (admin/revoke). Same header mechanism; which token a
  // route accepts is in its `security` + summary.
  ApiKeyBearer: {
    type: "apiKey",
    in: "header",
    name: "Authorization",
    description:
      "Bearer token in the Authorization header: `Authorization: Bearer awh_<key>` " +
      "for an agent key, or `Authorization: Bearer <OPERATOR_TOKEN>` for operator-only " +
      "routes. (OpenAPI models the header mechanism; the two token kinds differ only " +
      "in which routes accept them.)",
  },
  // The `/mcp` connector path (Door A) — OAuth 2.1 authorization-code + PKCE.
  OAuthBearer: {
    type: "oauth2",
    description: "OAuth 2.1 authorization-code + PKCE flow used by the /mcp connector door (Door A).",
    flows: {
      authorizationCode: {
        authorizationUrl: "/authorize",
        tokenUrl: "/token",
        scopes: {},
      },
    },
  },
  // The operator browser session — a signed `awh_session` cookie. Mutating
  // (cookie-authed) requests must additionally send `X-CSRF-Token`.
  CookieSession: {
    type: "apiKey",
    in: "cookie",
    name: "awh_session",
    description:
      "Operator browser session: the signed `awh_session` cookie. Cookie-authed " +
      "mutating requests must also send the `X-CSRF-Token` header (value from the " +
      "readable `awh_csrf` cookie).",
  },
} as const;

// Security requirement presets (each array element is an OR alternative; an
// empty object `{}` means "no credential required").
type SecurityRequirement = Record<string, string[]>;
const SEC: Record<string, SecurityRequirement[]> = {
  none: [],
  agent: [{ ApiKeyBearer: [] }],
  agentOptional: [{}, { ApiKeyBearer: [] }],
  // Any authenticated reader — an agent key OR the operator (Bearer token or
  // browser-session cookie); anonymous is refused. The credentialed READ
  // ingestion surfaces (/text, /source, /s/:slug/text) honor operator ≥ agent,
  // so unlike `agent` they also accept the operator cookie. Same value as
  // `operator`, kept distinct in name because the INTENT differs (these are not
  // operator-only — agents are the primary consumer).
  reader: [{ ApiKeyBearer: [] }, { CookieSession: [] }],
  operator: [{ ApiKeyBearer: [] }, { CookieSession: [] }],
  operatorOptional: [{}, { CookieSession: [] }],
  mcp: [{ ApiKeyBearer: [] }, { OAuthBearer: [] }],
  oauthLibrary: [],
};

// ============================================================================
// Route registry — one entry per route in the verified route table
// ============================================================================

type Json = Record<string, unknown>;

/** A single response: status + description + an optional body descriptor. */
type Resp = {
  status: number;
  description: string;
  body?:
    | { json: z.ZodType } // application/json referencing a registered component
    | { error: true } // application/json ErrorBody
    | { html: true }
    // ONE status, TWO content types, chosen by the request's `Accept` — the
    // /text routes' content negotiation (there is no markdown-only response
    // left; both /text routes negotiate). This is exactly what OpenAPI's
    // per-response `content` map is for, so it needs no second status entry.
    | { markdownOrJson: z.ZodType }
    | { javascript: true }
    | { openapi: true }; // the OpenAPI doc itself (this endpoint)
};

type RouteParam = {
  name: string;
  in: "query" | "header";
  required?: boolean;
  description: string;
  schema?: Json;
};

type Route = {
  method: "get" | "post" | "put" | "delete";
  path: string; // OpenAPI path template with {curly} params
  tag: string;
  summary: string;
  security: Array<Record<string, string[]>>;
  params?: RouteParam[];
  requestBody?: Json;
  responses: Resp[];
};

// -- response helpers ---------------------------------------------------------

const ok = (schema: z.ZodType, description: string, status = 200): Resp => ({
  status,
  description,
  body: { json: schema },
});
const created = (schema: z.ZodType, description: string): Resp => ok(schema, description, 201);
const err = (status: number, description: string): Resp => ({
  status,
  description,
  body: { error: true },
});
const html = (status: number, description: string): Resp => ({
  status,
  description,
  body: { html: true },
});
/** A markdown read that also answers JSON when the caller sends `Accept: application/json`. */
const markdownOrJson = (status: number, description: string, schema: z.ZodType): Resp => ({
  status,
  description,
  body: { markdownOrJson: schema },
});
const javascript = (status: number, description: string): Resp => ({
  status,
  description,
  body: { javascript: true },
});
const empty = (status: number, description: string): Resp => ({ status, description });

// -- request-body helpers -----------------------------------------------------

/** A raw document upload — text/html OR text/markdown, sanitized server-side. */
const rawDocumentBody = (): Json => ({
  required: true,
  description: "Raw document bytes. `text/html` is sanitized; `text/markdown` is parsed then sanitized.",
  content: {
    "text/html": { schema: { type: "string" } },
    "text/markdown": { schema: { type: "string" } },
  },
});

const jsonBody = (schema: Json, required = true): Json => ({
  required,
  content: { "application/json": { schema } },
});

const formBody = (properties: Json, required: string[] = []): Json => ({
  required: true,
  content: {
    "application/x-www-form-urlencoded": {
      schema: { type: "object", properties, ...(required.length ? { required } : {}) },
    },
  },
});

// -- common parameter fragments ----------------------------------------------

const PAGINATION_PARAMS: RouteParam[] = [
  {
    name: "limit",
    in: "query",
    description: "Page size (default 50, max 200).",
    schema: { type: "integer", minimum: 1, maximum: 200 },
  },
  {
    name: "cursor",
    in: "query",
    description: "Opaque base64url cursor from a prior page's `next_cursor`.",
    schema: { type: "string" },
  },
];

const WRITE_METADATA_HEADERS: RouteParam[] = [
  { name: "X-Doc-Title", in: "header", description: "Document title. Omit to derive from the first <h1>; empty to re-derive.", schema: { type: "string" } },
  { name: "X-Doc-Description", in: "header", description: "Short description. Omit/empty for none.", schema: { type: "string" } },
  { name: "X-Doc-Tags", in: "header", description: "Comma-separated tags ([A-Za-z0-9_-]; invalid chars stripped).", schema: { type: "string" } },
  { name: "X-Doc-Slug", in: "header", description: "Unique slug /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/. Invalid→422, in use→409.", schema: { type: "string" } },
  { name: "X-Content-SHA256", in: "header", description: "Optional byte-exact integrity check (64-hex, optional `sha256:` prefix) over the raw body.", schema: { type: "string" } },
];

const STATUS_FILTER_PARAM: RouteParam = {
  name: "status",
  in: "query",
  description:
    "Filter by lifecycle status (migration 0014). Omit to include everything — deprecated docs " +
    "are then included and marked per row. Invalid value → 400 bad_status.",
  schema: { type: "string", enum: ["active", "deprecated", "archived"] },
};

/**
 * The two publication-axis filters (migrations 0011 + 0018), shared by both
 * document LIST surfaces and both SEARCH surfaces. Together they answer the
 * operator's review-queue question — "which public documents are readers seeing
 * stale bytes for?" — in ONE request: `?visibility=public&publication=pending`.
 * Without them a consumer had to page the whole corpus and compare
 * `published_ver` to `current_ver` per row.
 *
 * Neither discloses anything: every caller of these surfaces is credentialed
 * (agent key or operator) and both values already ride every listing row. And
 * neither grants anything — flipping visibility and moving the publication
 * pointer are operator-only writes on entirely different routes.
 */
const VISIBILITY_FILTER_PARAM: RouteParam = {
  name: "visibility",
  in: "query",
  description:
    "Filter by anonymous readability (migration 0011). Omit for both. Invalid value → 400 bad_request.",
  schema: { type: "string", enum: ["public", "private"] },
};

const PUBLICATION_FILTER_PARAM: RouteParam = {
  name: "publication",
  in: "query",
  description:
    "Filter on the publication pointer vs the newest version (migration 0018). `pending` = " +
    "`published_ver IS NOT current_ver` (a public doc owed a promote; on a private doc this also " +
    "covers never-published). `current` = the published version is the newest, so a promote would " +
    "be a no-op. REVOKED DOCS MATCH NEITHER (revoke nulls both pointers). Combine with " +
    "`visibility=public` for the review queue. Invalid value → 400 bad_request.",
  schema: { type: "string", enum: ["pending", "current"] },
};

/**
 * The change-feed knobs (migration 0017), shared by the two document LIST
 * surfaces. `updated_since` also rides the two SEARCH surfaces; `order` does
 * NOT — search ranks by relevance, so there is no sort field to switch.
 */
const ORDER_PARAM: RouteParam = {
  name: "order",
  in: "query",
  description:
    "Sort field: `created` (default — newest published first) or `updated`, which walks " +
    "`documents.updated_at` so classification changes (retag/rename/visibility/status/revoke) " +
    "surface too. A cursor carries the ordering that minted it: replaying one under the other " +
    "ordering is a hard 400 bad_cursor, not a silent re-sort.",
  schema: { type: "string", enum: ["created", "updated"] },
};

const UPDATED_SINCE_PARAM: RouteParam = {
  name: "updated_since",
  in: "query",
  description:
    "Inclusive change window: `updated_at >= this`. Accepts a bare date (2026-07-01), a `…Z` " +
    "instant, or an offset stamp; normalized server-side. Inclusive on purpose so a resuming " +
    "consumer re-delivers the boundary row rather than skipping one at a shared millisecond. " +
    "Unparseable → 400 bad_request.",
  schema: { type: "string" },
};

const ACCEPT_JSON_PARAM: RouteParam = {
  name: "Accept",
  in: "header",
  description:
    "`application/json` switches the 200 to the ReadTextResponse envelope (body + metadata in " +
    "one call). Anything else — including a wildcard, and an absent header — keeps the historical " +
    "`text/markdown` body. Both branches send `Vary: Accept`.",
  schema: { type: "string" },
};

const FOLLOW_REDIRECTS_PARAM: RouteParam = {
  name: "follow_redirects",
  in: "query",
  description: "On a retired slug with a redirect target, `true` serves the target instead of 409/410.",
  schema: { type: "string", enum: ["true", "false"] },
};

// -- the routes ---------------------------------------------------------------

const ROUTES: Route[] = [
  // --- Public / static ------------------------------------------------------
  {
    method: "get",
    path: "/",
    tag: "Public",
    summary:
      "Public landing page (homepage document, framed shell). Like every HTML byte surface it " +
      "renders the SERVED version (migration 0018): a public document shows its `published_ver` — " +
      "the version an operator promoted — not whatever an agent wrote last.",
    security: SEC.none,
    responses: [
      html(
        200,
        "HTML landing shell (the homepage document's published version) — or, when the " +
          "`HOMEPAGE_PUBLIC_ID` var is unset/malformed or names a document that is missing, " +
          "revoked, or not publicly readable, a short placeholder page carrying `noindex`. " +
          "This route no longer 404s: a deployment with no homepage configured yet is a normal " +
          "state, not an error.",
      ),
    ],
  },
  {
    method: "get",
    path: "/healthz",
    tag: "Public",
    summary:
      "Health/smoke check — confirms D1 + R2 bindings and migrations. Also the API's in-band " +
      "DISCOVERY document: the 200 carries absolute `openapi` / `docs` / `mcp` pointers built " +
      "from the request origin, so an agent holding only a base URL can find the contract.",
    security: SEC.none,
    responses: [
      ok(
        HealthzResponseSchema,
        "Bindings reachable; exact counts are safe to expose. Also carries the three discovery " +
          "pointers (`openapi`, `docs`, `mcp`) named in the summary.",
      ),
    ],
  },
  {
    method: "get",
    path: "/shell.js",
    tag: "Public",
    summary: "Toolbar enhancement script for the document shell (progressive enhancement).",
    security: SEC.none,
    responses: [javascript(200, "text/javascript, loaded under the shell's `script-src 'self'`.")],
  },
  {
    method: "get",
    path: "/openapi.json",
    tag: "Public",
    summary: "This OpenAPI 3.1 document (generated from src/contract.ts).",
    security: SEC.none,
    responses: [{ status: 200, description: "The OpenAPI 3.1 spec.", body: { openapi: true } }],
  },
  // Bundled platform documentation (GitHub issue #4). Built from the repo at
  // deploy time by scripts/build-docs.mjs and served straight from the Worker,
  // so these pages describe the build serving them. Minimal entries: the
  // payloads are HTML/Markdown prose, not wire shapes.
  {
    method: "get",
    path: "/docs",
    tag: "Public",
    summary: "Index of the platform documentation bundled with this deployment.",
    security: SEC.none,
    responses: [html(200, "HTML index listing every bundled doc and the repo path it is built from.")],
  },
  {
    method: "get",
    path: "/docs/{name}",
    tag: "Public",
    summary:
      "One bundled documentation page. Content-negotiated: `Accept: text/markdown` returns the Markdown source (what an agent ingests as context), anything else the HTML shell. `Vary: Accept`.",
    security: SEC.none,
    responses: [
      html(200, "HTML shell framing /docs/{name}/raw, or `text/markdown` source when negotiated. Strong `ETag`."),
      err(404, "No such documentation page in THIS build."),
    ],
  },
  {
    method: "get",
    path: "/docs/{name}/raw",
    tag: "Public",
    summary: "The framed bytes for a bundled documentation page, sanitized at build time.",
    security: SEC.none,
    responses: [
      html(200, "Sanitized HTML under the render CSP. Strong `ETag`; conditional GET returns 304."),
      err(404, "No such documentation page in THIS build."),
    ],
  },

  // --- Document core --------------------------------------------------------
  {
    method: "post",
    path: "/d",
    tag: "Documents",
    summary: "Publish a document (sanitize + store). Agent key required.",
    security: SEC.agent,
    params: WRITE_METADATA_HEADERS,
    requestBody: rawDocumentBody(),
    responses: [
      created(WriteResponseSchema, "Stored. `Location` + `ETag` headers set."),
      err(400, "empty_body | bad_integrity_header | bad_request"),
      err(401, "unauthorized"),
      err(409, "slug_taken | slug_retired"),
      err(413, "too_large | storage_cap_exceeded"),
      err(415, "unsupported_media_type"),
      err(422, "invalid_slug | integrity_mismatch | too_deep"),
    ],
  },
  {
    method: "get",
    path: "/d",
    tag: "Documents",
    summary:
      "List documents (incl. revoked, with `revoked_at` set), newest-first, cursor-paginated. " +
      "Agent-reachable twin of `GET /admin/documents` (same shape/core), gated by agent key OR operator. " +
      "`?slug=…` returns the 0-or-1 matching row — the slug → public_id lookup for the id-only PUT /d/:id, /source, /links routes. " +
      "With `?order=updated` (+ optional `?updated_since=`) this is also the corpus CHANGE FEED (migration 0017), and " +
      "`?visibility=public&publication=pending` is the REVIEW QUEUE — public docs whose newest version has not been promoted " +
      "(migration 0018) — without walking the corpus.",
    security: SEC.reader,
    params: [
      ...PAGINATION_PARAMS,
      ORDER_PARAM,
      UPDATED_SINCE_PARAM,
      { name: "tag", in: "query", description: "AND-filter by tag (repeatable).", schema: { type: "string" } },
      { name: "slug", in: "query", description: "Filter by slug (exact match; 0 or 1 rows) — the slug→public_id resolver.", schema: { type: "string" } },
      STATUS_FILTER_PARAM,
      VISIBILITY_FILTER_PARAM,
      PUBLICATION_FILTER_PARAM,
    ],
    responses: [ok(ListDocumentsResponseSchema, "Documents page."), err(400, "bad_limit | bad_cursor (incl. a cursor replayed under the other `order`) | bad_slug | bad_status | bad_request (unknown `order` / `visibility` / `publication`, or unparseable `updated_since`)"), err(401, "unauthorized")],
  },
  {
    method: "get",
    path: "/d/search",
    tag: "Documents",
    summary:
      "Hybrid (keyword + semantic) search over live documents. Agent-reachable twin of `GET /admin/documents/search` " +
      "(same shape/core), gated by agent key OR operator. NOT paginated. With ?include_bodies=true the 200 becomes a " +
      "CONTEXT PACK (PackResponse): full markdown bodies best-first under budget_bytes/max_documents, the rest in omitted[].",
    security: SEC.reader,
    params: [
      { name: "q", in: "query", required: true, description: "Query. Keyword leg tokenizes it (words ≥2 chars, trailing * for prefix); semantic leg embeds it raw.", schema: { type: "string" } },
      { name: "mode", in: "query", description: "hybrid (default) | keyword | semantic.", schema: { type: "string", enum: ["hybrid", "keyword", "semantic"] } },
      { name: "tag", in: "query", description: "AND-filter by tag (repeatable). Applies to both legs.", schema: { type: "string" } },
      { name: "slug", in: "query", description: "Filter by slug. Applies to both legs.", schema: { type: "string" } },
      STATUS_FILTER_PARAM,
      VISIBILITY_FILTER_PARAM,
      PUBLICATION_FILTER_PARAM,
      // Search honors the change WINDOW (it's a filter, same class as tags/slug)
      // but not `order` — relevance rank is the ordering here, which is also why
      // these routes have no cursor.
      UPDATED_SINCE_PARAM,
      { name: "limit", in: "query", description: "Cap (default 50, max 200).", schema: { type: "integer", minimum: 1, maximum: 200 } },
      { name: "include_bodies", in: "query", description: "true → return a context pack (PackResponse) instead of bare hits.", schema: { type: "string", enum: ["true", "false"] } },
      { name: "budget_bytes", in: "query", description: "Pack body budget in STORED bytes (default 65536, ~16K tokens; max 262144). Clamped, not rejected.", schema: { type: "integer" } },
      { name: "max_documents", in: "query", description: "Pack body-count cap (default 8, max 25). Clamped, not rejected.", schema: { type: "integer" } },
      { name: "include_deprecated", in: "query", description: "true → deprecated docs join the pack fill instead of being omitted-and-reported.", schema: { type: "string", enum: ["true", "false"] } },
    ],
    responses: [ok(SearchOrPackResponseSchema, "Hits (possibly empty), relevance-ranked — or, with include_bodies=true, the PackResponse envelope."), err(400, "bad_limit | bad_status | bad_request (bad `mode` / `visibility` / `publication`, or unparseable `updated_since`)"), err(401, "unauthorized"), err(422, "bad_query (no leg could run)")],
  },
  {
    method: "get",
    path: "/d/pack",
    tag: "Documents",
    summary:
      "Load a DOCUMENT/MANIFEST-root context pack: the root's own prose plus the full markdown bodies of the " +
      "documents it references, budget-filled in one call. HTTP twin of the MCP `load_context_pack` tool " +
      "(same core), gated by agent key OR operator. Members come from a fenced ```pack manifest block in the " +
      "root's source when present (authored order, required tier first), else from the root's outbound " +
      "/d/<id> + /s/<slug> links in order of appearance. Bodies are included WHOLE or omitted-and-reported " +
      "(never truncated); the root's own prose is not counted against the budget.",
    security: SEC.reader,
    params: [
      { name: "from", in: "query", required: true, description: "The root document: a live slug (curated packs are conventionally `pack-<name>`) or a 22-char public_id. Live-slug-first resolution.", schema: { type: "string" } },
      { name: "budget_bytes", in: "query", description: "Pack body budget in STORED bytes (default 65536, ~16K tokens; max 262144). Clamped, not rejected.", schema: { type: "integer" } },
      { name: "max_documents", in: "query", description: "Pack body-count cap (default 8, max 25). Clamped, not rejected.", schema: { type: "integer" } },
      { name: "include_deprecated", in: "query", description: "true → deprecated members join the fill instead of being omitted-and-reported.", schema: { type: "string", enum: ["true", "false"] } },
      { name: "follow_redirects", in: "query", description: "true → a deprecated member with a `superseded_by` pointer is replaced by its target in the fill (the original stays visible in omitted[]; single-hop).", schema: { type: "string", enum: ["true", "false"] } },
    ],
    responses: [
      ok(PackResponseSchema, "The pack envelope: accounting + root prose (`pack`), included bodies (`documents`), and the omitted-members menu (`omitted`)."),
      err(400, "bad_request (missing `from`)"),
      err(401, "unauthorized"),
      err(404, "not_found (`from` matches no live document)"),
      err(410, "gone (`from` is a retired slug — slugs are never reused)"),
    ],
  },
  {
    method: "get",
    path: "/d/{public_id}",
    tag: "Documents",
    summary:
      "Read a document. Content-negotiated on the Authorization header: no header → HTML shell; " +
      "valid credential (agent key OR operator token) → raw sanitized bytes; bad credential → 401. " +
      "Private docs 404 to anonymous callers (no existence oracle). The shell branch does NOT honor If-None-Match. " +
      "BOTH branches render the SERVED version (migration 0018): a PUBLIC document serves its " +
      "`published_ver` to every caller alike — anonymous, agent and operator — while a private one " +
      "serves `current_ver`. The shell's title, description and version banner describe those same " +
      "bytes, so they too can trail `current_ver`; the bytes branch delegates to /raw and inherits " +
      "its ETag and `x-doc-current-version` header.",
    security: SEC.agentOptional,
    responses: [
      html(200, "HTML shell (no auth) or sanitized bytes (agent key or operator token) — the served version in both cases."),
      err(401, "unauthorized (a malformed/invalid credential — not downgraded to the shell)."),
      html(404, "HTML 404 card (browser) or plain text (credential present) — same opaque 404 for missing/revoked/private."),
    ],
  },
  {
    method: "put",
    path: "/d/{public_id}",
    tag: "Documents",
    summary:
      "Update a document (new version). Agent key + If-Match required. On a PUBLIC document the new " +
      "version is STORED but not rendered: the byte path stays pinned to `published_ver` until the " +
      "operator promotes it (POST /admin/documents/{public_id}/promote), so a successful 200 here " +
      "does not mean readers see it. For the same reason an agent may not change or clear a public " +
      "document's slug (403 slug_locked) — content writes are unaffected. Preflight `If-Match` from " +
      "the `x-doc-current-version` header on /raw, NOT from its ETag, which now names the published " +
      "version.",
    security: SEC.agent,
    params: [
      { name: "If-Match", in: "header", required: true, description: 'Required (428 if missing). Send `"v<n>"` (or the lenient `v<n>`/`<n>` forms) or `*`. On a public document `v<n>` is the version from `x-doc-current-version`, not the served ETag.', schema: { type: "string" } },
      ...WRITE_METADATA_HEADERS,
    ],
    requestBody: rawDocumentBody(),
    responses: [
      ok(WriteResponseSchema, "New version stored (on a public doc: stored, not yet published). `Location` + `ETag` headers set."),
      err(400, "empty_body | bad_request | bad_integrity_header"),
      err(401, "unauthorized"),
      err(403, "slug_locked (an agent sending a slug change/clear for a PUBLIC document — re-send without the slug field, or ask the operator to rename it)"),
      err(404, "not_found"),
      err(409, "slug_taken | slug_retired"),
      err(412, "precondition_failed (If-Match version mismatch)"),
      err(413, "too_large | storage_cap_exceeded"),
      err(415, "unsupported_media_type"),
      err(422, "invalid_slug | integrity_mismatch | too_deep"),
      err(428, "precondition_required (If-Match missing)"),
    ],
  },
  {
    method: "delete",
    path: "/d/{public_id}",
    tag: "Documents",
    summary:
      "Revoke (kill) a document + purge R2 bytes. Operator-gated. IDEMPOTENT: re-issuing the " +
      "DELETE on an already-revoked document re-runs the purge and returns 200 (it does NOT " +
      "re-stamp `revoked_at`) — the purge throws loudly on an R2 failure after the kill has " +
      "landed, so retrying has to be the recovery.",
    security: SEC.operator,
    params: [{ name: "X-CSRF-Token", in: "header", description: "Required when authed via session cookie.", schema: { type: "string" } }],
    responses: [
      ok(RevokeResponseSchema, "Revoked — or re-purged, if it was already revoked. `r2_objects_purged` counts H blobs (one per version)."),
      err(401, "unauthorized"),
      err(403, "csrf_failed"),
      err(404, "not_found (unknown or malformed public_id — NOT 'already revoked')"),
    ],
  },
  {
    method: "put",
    path: "/d/{public_id}/tags",
    tag: "Documents",
    summary:
      "Replace a document's tags (full replacement; `[]` clears). AGENT-reachable — an active " +
      "agent key OR the operator, never anonymous — and the agent-door twin of " +
      "`POST /admin/documents/{public_id}/tags` (same core, byte-identical response). No version " +
      "bump, so no If-Match: concurrent retags are last-write-wins. PUT rather than POST because " +
      "POST on this path is the manage page's HTML form.",
    security: SEC.reader,
    requestBody: jsonBody({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" }, description: "Charset [A-Za-z0-9_-]; invalid chars are silently stripped, not rejected." } },
      required: ["tags"],
    }),
    responses: [ok(SetDocumentTagsResponseSchema, "Tags replaced."), err(400, "bad_json | bad_request"), err(401, "unauthorized"), err(404, "not_found")],
  },
  {
    method: "put",
    path: "/d/{public_id}/status",
    tag: "Documents",
    summary:
      "Set a document's lifecycle status (active|deprecated; archived reserved). AGENT-reachable " +
      "twin of `POST /admin/documents/{public_id}/status` — this is how an agent retires its own " +
      "superseded work. No version bump, no If-Match. Status gates nothing: a deprecated doc still " +
      "serves and still ranks in search (marked per row), but context-pack fills skip it by default. " +
      "`visibility` and revoke stay OPERATOR-only — do not add a third mutator here by analogy.",
    security: SEC.reader,
    requestBody: jsonBody({
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "deprecated"], description: '"archived" is reserved and rejected in v1.' },
        superseded_by: { type: "string", description: "Replacement doc's public_id (deprecated only). Full-replace per call; omitted/null clears. Must be live, not self." },
      },
      required: ["status"],
    }),
    responses: [ok(SetDocumentStatusResponseSchema, "Status set."), err(400, "bad_json | bad_request | invalid_status"), err(401, "unauthorized"), err(404, "not_found"), err(422, "bad_target (superseded_by not a live doc / self-pointer)")],
  },
  {
    method: "get",
    path: "/d/{public_id}/raw",
    tag: "Documents",
    summary:
      "Sanitized HTML bytes (what the sandboxed iframe loads). Honors If-None-Match → 304. " +
      "Visibility gate: private docs 404 to anonymous callers. THE version pin (migration 0018): a " +
      "PUBLIC document serves `published_ver` here — to anonymous, agent and operator alike — so no " +
      "agent write alone can change what the open web reads; a private document serves `current_ver`. " +
      "The `ETag` therefore names the SERVED version, which means promoting a different version " +
      "changes it without a write, an unpublished new version leaves it alone, and it is NO LONGER a " +
      "valid `If-Match` preflight for `PUT /d/{public_id}`. Use the `x-doc-current-version` response " +
      "header instead: the document's NEWEST version — the one a PUT would be updating — as a decimal " +
      "string, sent on the 200 AND the 304, and emitted ONLY to a credentialed caller (that staged, " +
      "unpublished work exists is precisely what the pin withholds from readers, so for an anonymous " +
      "caller it is absent rather than clamped). A client predating this contract, or reading a " +
      "private document, correctly falls back to the ETag.",
    security: SEC.agentOptional,
    params: [{ name: "If-None-Match", in: "header", description: 'Send `"v<n>"` — the SERVED version, i.e. whatever the last ETag said; a match returns a bodyless 304.', schema: { type: "string" } }],
    responses: [
      html(200, "Sanitized HTML of the served version (Markdown docs get a reading-theme prefix). `ETag` set; `x-doc-current-version` set for a credentialed caller."),
      empty(304, "If-None-Match satisfied (checked AFTER the visibility gate — never an oracle). Carries `ETag` + `x-doc-current-version` (credentialed only), so a preflight need not fetch the body."),
      html(404, "Plain-text 'Not Found' (opaque for missing/revoked/private)."),
    ],
  },
  {
    method: "get",
    path: "/d/{public_id}/text",
    tag: "Documents",
    summary:
      "Markdown derivation of the sanitized HTML, for agents ingesting as context. Requires a credential — " +
      "an agent key OR operator (token/session); operator ≥ agent. " +
      "CONTENT-NEGOTIATED on `Accept`: raw `text/markdown` by default, or the `ReadTextResponse` " +
      "envelope (body + title/description/tags/slug/status/superseded_by in ONE call, exactly what " +
      "MCP `read_document` format:\"markdown\" returns) when the caller asks for `application/json`.",
    security: SEC.reader,
    params: [ACCEPT_JSON_PARAM],
    responses: [
      markdownOrJson(
        200,
        "text/markdown (default) or the ReadTextResponse envelope (Accept: application/json). " +
          "Both set `x-sanitizer-version`, `x-converter-version`, `ETag` and `Vary: Accept`.",
        ReadTextResponseSchema,
      ),
      err(401, "unauthorized"),
      err(404, "not_found (opaque for missing/revoked/private; `message` may name `GET /d?slug=…` when the path segment is slug-shaped)"),
    ],
  },
  {
    method: "get",
    path: "/d/{public_id}/source",
    tag: "Documents",
    summary:
      "The retained, UNSANITIZED source S + advisories re-derived from it (the read before edit_document). " +
      "Requires a credential — an agent key OR operator (token/session); operator ≥ agent.",
    security: SEC.reader,
    responses: [
      ok(ReadSourceResponseSchema, "Source returned with an explicit `unsanitized: true` provenance marker."),
      err(401, "unauthorized"),
      err(404, "not_found (opaque for missing/revoked/private; `message` may name `GET /d?slug=…` when the path segment is slug-shaped)"),
      err(409, "source_unavailable (un-backfilled/legacy doc with no retained source)."),
    ],
  },
  {
    method: "get",
    path: "/d/{public_id}/links",
    tag: "Documents",
    summary:
      "The document's link-graph neighborhood (issue #40): `backlinks` (live docs whose current version " +
      "links here, as listing rows) + `outbound` (this doc's on-platform links with resolution states — " +
      "retired/revoked/missing are the broken-link report). Requires a credential — an agent key OR " +
      "operator (token/session); operator ≥ agent.",
    security: SEC.reader,
    responses: [
      ok(DocumentLinksResponseSchema, "Backlinks + outbound link health."),
      err(401, "unauthorized"),
      err(404, "not_found (opaque for missing/revoked/malformed; `message` may name `GET /d?slug=…` when the path segment is slug-shaped)"),
    ],
  },

  // --- Slug surface ---------------------------------------------------------
  {
    method: "get",
    path: "/s/{slug}",
    tag: "Slugs",
    summary:
      "Slug-addressed twin of GET /d/{public_id} — content-negotiated identically (shell vs bytes vs 401), " +
      "keeping the pretty slug in the address bar (no 302). Retired slugs forward loudly or 410. Renders the " +
      "SERVED version like every byte surface (migration 0018): a public document shows `published_ver`, and " +
      "the shell's title/description come from that same version. The bytes branch delegates to " +
      "/d/{public_id}/raw, so it inherits that route's served-version ETag and `x-doc-current-version` header.",
    security: SEC.agentOptional,
    params: [FOLLOW_REDIRECTS_PARAM],
    responses: [
      html(200, "HTML shell (no auth) or sanitized bytes (agent key or operator token) — the served version in both cases."),
      err(401, "unauthorized"),
      html(404, "HTML 404 (browser) or plain text (credential present) — never-claimed slug, opaque."),
      err(409, "slug_redirected (credentialed caller, retired slug with a redirect, no follow_redirects)."),
      html(410, "HTML Gone (browser) or JSON (credentialed caller) — retired slug, no redirect."),
    ],
  },
  {
    method: "get",
    path: "/s/{slug}/text",
    tag: "Slugs",
    summary:
      "Markdown derivation by slug (requires a credential — agent key OR operator; operator ≥ agent). " +
      "Slug-addressed twin of /d/{id}/text, content-negotiated on `Accept` the same way.",
    security: SEC.reader,
    params: [ACCEPT_JSON_PARAM, FOLLOW_REDIRECTS_PARAM],
    responses: [
      markdownOrJson(
        200,
        "text/markdown (default) or the ReadTextResponse envelope (Accept: application/json). Both send `Vary: Accept`.",
        ReadTextResponseSchema,
      ),
      err(401, "unauthorized"),
      err(404, "not_found (never-claimed slug, opaque)."),
      err(409, "slug_redirected"),
      err(410, "gone (retired slug, no redirect)."),
    ],
  },

  // --- Version history (operator-only) --------------------------------------
  {
    method: "get",
    path: "/d/{public_id}/v/{n}",
    tag: "Versions",
    summary: "Operator-only: framed shell for historical version n. Non-operator → opaque 404.",
    security: SEC.operatorOptional,
    responses: [html(200, "HTML shell with a historical-version banner."), html(404, "HTML 404.")],
  },
  {
    method: "get",
    path: "/d/{public_id}/v/{n}/raw",
    tag: "Versions",
    summary: "Operator-only: sanitized bytes of historical version n. Honors If-None-Match → 304.",
    security: SEC.operatorOptional,
    params: [{ name: "If-None-Match", in: "header", description: 'Send `"v<n>"` for a 304.', schema: { type: "string" } }],
    responses: [
      html(200, "Sanitized HTML of version n. `ETag` set."),
      empty(304, "If-None-Match satisfied."),
      html(404, "Plain-text 'Not Found' (also the non-operator opaque 404)."),
    ],
  },

  // --- Management UI (operator-only, form-based) -----------------------------
  {
    method: "get",
    path: "/d/{public_id}/manage",
    tag: "Management",
    summary: "Operator document-management page (visibility, slug, version history, revoke). Cookie session.",
    security: SEC.operatorOptional,
    responses: [html(200, "HTML management page, or a sign-in card when logged out (no DB hit)."), html(404, "Plain-text 'Not Found'.")],
  },
  {
    method: "post",
    path: "/d/{public_id}/visibility",
    tag: "Management",
    summary:
      "Operator form: set public/private (no version bump; a flip to public also fills `published_ver` " +
      "from `current_ver` when unset). Auth ladder: operator_token OR cookie+csrf_token.",
    security: SEC.operator,
    requestBody: formBody(
      {
        visibility: { type: "string", enum: ["public", "private"] },
        operator_token: { type: "string" },
        csrf_token: { type: "string" },
      },
      ["visibility"],
    ),
    responses: [html(200, "Re-rendered manage page (cookie) or result card (bearer)."), html(400, "Result card."), html(401, "Result card."), html(403, "Result card."), html(404, "Result card.")],
  },
  {
    method: "post",
    path: "/d/{public_id}/slug",
    tag: "Management",
    summary: "Operator form: add/rename/clear the slug (no version bump; rename auto-forwards).",
    security: SEC.operator,
    requestBody: formBody(
      { slug: { type: "string" }, operator_token: { type: "string" }, csrf_token: { type: "string" } },
      ["slug"],
    ),
    responses: [html(200, "Manage page or result card."), html(401, "Result card."), html(403, "Result card."), html(404, "Result card."), html(409, "Result card (slug_taken | slug_retired)."), html(422, "Result card (invalid_slug).")],
  },
  {
    method: "post",
    path: "/d/{public_id}/tags",
    tag: "Management",
    summary: "Operator form: replace a doc's tags (comma-separated `tags` field; full replacement, no version bump).",
    security: SEC.operator,
    requestBody: formBody(
      { tags: { type: "string", description: "Comma-separated tags ([A-Za-z0-9_-]; invalid chars stripped). Empty clears all." }, operator_token: { type: "string" }, csrf_token: { type: "string" } },
      ["tags"],
    ),
    responses: [html(200, "Manage page or result card."), html(401, "Result card."), html(403, "Result card."), html(404, "Result card.")],
  },
  {
    method: "post",
    path: "/d/{public_id}/status",
    tag: "Management",
    summary: "Operator form: set lifecycle status active|deprecated (no version bump). Optional superseded_by pointer.",
    security: SEC.operator,
    requestBody: formBody(
      {
        status: { type: "string", enum: ["active", "deprecated"] },
        superseded_by: { type: "string", description: "Replacement doc's public_id (deprecated only; empty = none)." },
        operator_token: { type: "string" },
        csrf_token: { type: "string" },
      },
      ["status"],
    ),
    responses: [html(200, "Manage page or result card."), html(400, "Result card (invalid_status)."), html(401, "Result card."), html(403, "Result card."), html(404, "Result card."), html(422, "Result card (bad superseded_by target).")],
  },
  {
    method: "post",
    path: "/d/{public_id}/restore",
    tag: "Management",
    summary: "Operator form: re-publish historical version n as a NEW version (source required).",
    security: SEC.operator,
    requestBody: formBody(
      { version: { type: "string", pattern: "^[1-9][0-9]*$" }, operator_token: { type: "string" }, csrf_token: { type: "string" } },
      ["version"],
    ),
    responses: [html(200, "Manage page or result card."), html(400, "Result card."), html(401, "Result card."), html(403, "Result card."), html(404, "Result card."), html(409, "Result card (source_unavailable | version_conflict)."), html(413, "Result card."), html(507, "Result card (storage_cap_exceeded).")],
  },
  {
    method: "get",
    path: "/d/{public_id}/revoke",
    tag: "Management",
    summary: "Operator revoke confirmation page. Session-aware (CSRF form vs token field). Opaque 404.",
    security: SEC.operatorOptional,
    responses: [html(200, "HTML confirmation form."), html(404, "Plain-text 'Not Found'.")],
  },
  {
    method: "post",
    path: "/d/{public_id}/revoke",
    tag: "Management",
    summary: "Operator form: revoke + purge. Returns terminal HTML (never a 302).",
    security: SEC.operator,
    requestBody: formBody({ operator_token: { type: "string" }, csrf_token: { type: "string" } }),
    responses: [html(200, "HTML success card."), html(401, "HTML error card."), html(403, "HTML error card."), html(404, "HTML error card.")],
  },

  // --- Session & OAuth UI ----------------------------------------------------
  {
    method: "get",
    path: "/login",
    tag: "Session",
    summary: "Operator browser sign-in form.",
    security: SEC.none,
    params: [{ name: "next", in: "query", description: "Same-origin path to return to (validated).", schema: { type: "string" } }],
    responses: [html(200, "HTML login form.")],
  },
  {
    method: "post",
    path: "/login",
    tag: "Session",
    summary: "Validate operator token (constant-time) → set signed session + CSRF cookies → 302 to next.",
    security: SEC.none,
    requestBody: formBody({ operator_token: { type: "string" }, next: { type: "string" } }, ["operator_token"]),
    responses: [empty(302, "Redirect to `next` with Set-Cookie: session + CSRF."), html(400, "Form re-rendered."), html(401, "Form re-rendered.")],
  },
  {
    method: "get",
    path: "/logout",
    tag: "Session",
    summary: "Logout confirmation page (confirm-before-logout).",
    security: SEC.operatorOptional,
    responses: [html(200, "HTML confirmation form.")],
  },
  {
    method: "post",
    path: "/logout",
    tag: "Session",
    summary: "Clear session + CSRF cookies. CSRF-checked.",
    security: SEC.operator,
    requestBody: formBody({ csrf_token: { type: "string" } }),
    responses: [empty(302, "Redirect to / (cookies cleared)."), html(403, "Form re-rendered.")],
  },
  {
    method: "get",
    path: "/authorize",
    tag: "OAuth",
    summary:
      "OAuth consent UI (Door A). Session-aware: operators see inline repair cards (TOFU callback, " +
      "bind-or-mint, login link); non-operators see a generic consent/error card.",
    security: SEC.operatorOptional,
    params: [
      { name: "client_id", in: "query", required: true, description: "OAuth client id.", schema: { type: "string" } },
      { name: "redirect_uri", in: "query", required: true, description: "Post-grant callback.", schema: { type: "string" } },
      { name: "state", in: "query", description: "Opaque client state.", schema: { type: "string" } },
      { name: "response_type", in: "query", description: "`code`.", schema: { type: "string" } },
      { name: "scope", in: "query", description: "Requested scope.", schema: { type: "string" } },
      { name: "code_challenge", in: "query", description: "PKCE challenge.", schema: { type: "string" } },
      { name: "code_challenge_method", in: "query", description: "PKCE method (`S256`).", schema: { type: "string" } },
    ],
    responses: [html(200, "HTML consent / repair / error card."), html(400, "HTML error card.")],
  },
  {
    method: "post",
    path: "/authorize",
    tag: "OAuth",
    summary: "Operator consent decision (allow/deny/allow_callback). Binds unbound clients at consent.",
    security: SEC.operator,
    requestBody: formBody({
      action: { type: "string", enum: ["allow", "deny", "allow_callback"] },
      agent_mode: { type: "string" },
      agent_name: { type: "string" },
      agent_id: { type: "string" },
      operator_token: { type: "string" },
      csrf_token: { type: "string" },
    }),
    responses: [html(200, "HTML card (denied / callback approved)."), empty(302, "Redirect to the client redirect_uri (action=allow)."), html(400, "HTML card."), html(401, "HTML card."), html(403, "HTML card."), html(409, "HTML card (bind race)."), html(500, "HTML card.")],
  },
  {
    method: "post",
    path: "/token",
    tag: "OAuth",
    summary: "OAuth token endpoint — served by @cloudflare/workers-oauth-provider. Standard OAuth 2.1.",
    security: SEC.oauthLibrary,
    responses: [{ status: 200, description: "Standard OAuth 2.1 token response (access_token, token_type, expires_in, …)." }],
  },
  {
    method: "post",
    path: "/register",
    tag: "OAuth",
    summary: "Dynamic Client Registration (optional, ENABLE_DCR) — served by the OAuth provider library.",
    security: SEC.oauthLibrary,
    responses: [{ status: 201, description: "Standard OAuth DCR response (client_id, client_secret, …)." }],
  },
  {
    method: "get",
    path: "/.well-known/oauth-authorization-server",
    tag: "OAuth",
    summary: "OAuth 2.1 authorization-server discovery metadata (OAuth provider library).",
    security: SEC.oauthLibrary,
    responses: [{ status: 200, description: "Standard OAuth discovery metadata." }],
  },
  {
    method: "get",
    path: "/.well-known/oauth-protected-resource",
    tag: "OAuth",
    summary: "OAuth protected-resource metadata (OAuth provider library).",
    security: SEC.oauthLibrary,
    responses: [{ status: 200, description: "Standard OAuth protected-resource metadata." }],
  },

  // --- MCP ------------------------------------------------------------------
  {
    method: "post",
    path: "/mcp",
    tag: "MCP",
    summary:
      "Streamable-HTTP MCP transport (JSON-RPC 2.0, NOT REST). Agent-authed via Door A (OAuth token) " +
      "or Door B (awh_ bearer). Tools: publish_document, update_document, edit_document, " +
      "set_document_tags, set_document_status, read_document, list_documents, search_documents, " +
      "load_context_pack, create_publish_credential. The " +
      "request/response bodies are JSON-RPC envelopes (optionally an SSE stream), not schema-validated " +
      "here — see docs/http-api.md. Every tool declares an `outputSchema` and returns " +
      "`structuredContent`; a tool FAILURE comes back as an error result whose text is " +
      "`<code>: <message>`, so the code is machine-readable without parsing prose.",
    security: SEC.mcp,
    responses: [
      { status: 200, description: "JSON-RPC 2.0 response (may be a Server-Sent-Events stream)." },
      { status: 401, description: "Rejected by the OAuth provider before reaching the handler." },
    ],
  },

  // --- Operator console (HTML, no-JS) ---------------------------------------
  // The browser-UI surface over the JSON /admin/* API. All pages are cookie-
  // session gated (a logged-out GET renders a sign-in card, no DB hit), and all
  // POSTs use the FORM-FIELD CSRF ladder (operator_token OR cookie+csrf_token),
  // NOT the X-CSRF-Token header — a no-JS HTML form can't send a custom header.
  // Several POSTs are twins of the JSON admin DELETEs (revoke key/agent, delete
  // OAuth client) because an HTML form can only GET/POST. Responses are HTML.
  {
    method: "get",
    path: "/admin",
    tag: "Console",
    summary: "Bare /admin → 302 to the console dashboard.",
    security: SEC.none,
    responses: [empty(302, "Redirect to /admin/console.")],
  },
  {
    method: "get",
    path: "/admin/console",
    tag: "Console",
    summary: "Console dashboard — fleet counts + storage-used bar. Sign-in card when logged out.",
    security: SEC.operatorOptional,
    responses: [html(200, "HTML dashboard, or a sign-in card when logged out (no DB hit).")],
  },
  {
    method: "get",
    path: "/admin/console/agents",
    tag: "Console",
    summary: "Agents table + a mint-agent form. Sign-in card when logged out.",
    security: SEC.operatorOptional,
    responses: [html(200, "HTML agents page, or a sign-in card when logged out."), html(400, "HTML notice card (bad list params).")],
  },
  {
    method: "post",
    path: "/admin/console/agents",
    tag: "Console",
    summary: "Mint an agent + its initial key (form). Plaintext key shown once on a secret card.",
    security: SEC.operator,
    requestBody: formBody(
      { name: { type: "string", maxLength: 200 }, operator_token: { type: "string" }, csrf_token: { type: "string" } },
      ["name"],
    ),
    responses: [html(200, "HTML secret card (key shown once) or an error card."), html(400, "HTML error card (bad name)."), html(401, "HTML error card."), html(403, "HTML error card."), html(500, "HTML error card (misconfigured).")],
  },
  {
    method: "get",
    path: "/admin/console/agents/{agent_id}",
    tag: "Console",
    summary: "Agent detail — keys, OAuth clients, and a danger zone (revoke). Sign-in card when logged out.",
    security: SEC.operatorOptional,
    responses: [html(200, "HTML agent-detail page, or a sign-in card when logged out."), html(404, "HTML notice card (no such agent).")],
  },
  {
    method: "post",
    path: "/admin/console/agents/{agent_id}/keys",
    tag: "Console",
    summary: "Mint an additional key for an agent (rotation, form). Plaintext key shown once.",
    security: SEC.operator,
    requestBody: formBody({ operator_token: { type: "string" }, csrf_token: { type: "string" } }),
    responses: [html(200, "HTML secret card or error card."), html(401, "HTML error card."), html(403, "HTML error card."), html(404, "HTML error card."), html(500, "HTML error card (misconfigured).")],
  },
  {
    method: "post",
    path: "/admin/console/agents/{agent_id}/oauth-clients",
    tag: "Console",
    summary: "Mint an OAuth client bound to this agent (form). Secret shown once on a secret card.",
    security: SEC.operator,
    requestBody: formBody({ operator_token: { type: "string" }, csrf_token: { type: "string" } }),
    responses: [html(200, "HTML secret card or error card."), html(401, "HTML error card."), html(403, "HTML error card."), html(404, "HTML error card."), html(409, "HTML error card (client_exists).")],
  },
  {
    method: "post",
    path: "/admin/console/agents/revoke",
    tag: "Console",
    summary: "Cascading agent kill (form; agent_id field). POST twin of DELETE /admin/agents/{id}.",
    security: SEC.operator,
    requestBody: formBody(
      { agent_id: { type: "string" }, operator_token: { type: "string" }, csrf_token: { type: "string" } },
      ["agent_id"],
    ),
    responses: [html(200, "Re-rendered agents list, or an error card."), html(401, "HTML error card."), html(403, "HTML error card."), html(404, "HTML error card (no such agent).")],
  },
  {
    method: "post",
    path: "/admin/console/keys/revoke",
    tag: "Console",
    summary: "Revoke a single key (form; key_id field). POST twin of DELETE /admin/keys/{id}.",
    security: SEC.operator,
    requestBody: formBody(
      { key_id: { type: "string" }, operator_token: { type: "string" }, csrf_token: { type: "string" } },
      ["key_id"],
    ),
    responses: [html(200, "Re-rendered agent detail, or an error card."), html(401, "HTML error card."), html(403, "HTML error card."), html(404, "HTML error card.")],
  },
  {
    method: "post",
    path: "/admin/console/oauth-clients",
    tag: "Console",
    summary: "Mint an UNBOUND OAuth client (form; agent chosen at /authorize). Secret shown once.",
    security: SEC.operator,
    requestBody: formBody({ operator_token: { type: "string" }, csrf_token: { type: "string" } }),
    responses: [html(200, "HTML secret card or error card."), html(401, "HTML error card."), html(403, "HTML error card.")],
  },
  {
    method: "post",
    path: "/admin/console/oauth-clients/delete",
    tag: "Console",
    summary: "Cascading OAuth-client revoke (form; client_id field). POST twin of DELETE /admin/oauth-clients/{id}.",
    security: SEC.operator,
    requestBody: formBody(
      { client_id: { type: "string" }, agent_id: { type: "string" }, operator_token: { type: "string" }, csrf_token: { type: "string" } },
      ["client_id"],
    ),
    responses: [html(200, "Re-rendered page, or an error card."), html(401, "HTML error card."), html(403, "HTML error card."), html(404, "HTML error card.")],
  },
  {
    method: "get",
    path: "/admin/console/documents",
    tag: "Console",
    summary:
      "Documents page — newest-first list (cursor-paginated) or hybrid search when ?q= is set, with " +
      "tag/slug filters and a Public/Private badge per row. Sign-in card when logged out.",
    security: SEC.operatorOptional,
    params: [
      { name: "q", in: "query", description: "Hybrid search query (when set, switches from list to search mode; not paginated).", schema: { type: "string" } },
      { name: "tag", in: "query", description: "AND-filter by tag.", schema: { type: "string" } },
      { name: "slug", in: "query", description: "Filter by slug.", schema: { type: "string" } },
      ...PAGINATION_PARAMS,
    ],
    responses: [html(200, "HTML documents page, or a sign-in card when logged out."), html(400, "HTML notice card (bad list params)."), html(422, "HTML notice card (search query had no usable terms — bad_query).")],
  },
  {
    method: "get",
    path: "/admin/console/maintenance",
    tag: "Console",
    summary: "Maintenance page — the Vectorize + link-graph backfill forms. Sign-in card when logged out.",
    security: SEC.operatorOptional,
    responses: [html(200, "HTML maintenance page, or a sign-in card when logged out.")],
  },
  {
    method: "post",
    path: "/admin/console/vectors/backfill",
    tag: "Console",
    summary: "Run one Vectorize backfill page (form; mode field). Notice + a continue button while more remain.",
    security: SEC.operator,
    requestBody: formBody(
      {
        mode: { type: "string", enum: ["missing", "rebuild"] },
        cursor: { type: "string", description: "Resume cursor (from the continue button)." },
        operator_token: { type: "string" },
        csrf_token: { type: "string" },
      },
      ["mode"],
    ),
    responses: [html(200, "HTML notice card (one page processed; continue button while next_cursor is non-null)."), html(400, "HTML error card."), html(401, "HTML error card."), html(403, "HTML error card.")],
  },
  {
    method: "post",
    path: "/admin/console/links/backfill",
    tag: "Console",
    summary: "Run one link-graph backfill page (form; issue #40). Notice + a continue button while more remain.",
    security: SEC.operator,
    requestBody: formBody(
      {
        cursor: { type: "string", description: "Resume cursor (from the continue button)." },
        operator_token: { type: "string" },
        csrf_token: { type: "string" },
      },
      [],
    ),
    responses: [html(200, "HTML notice card (one page processed; continue button while next_cursor is non-null)."), html(400, "HTML error card."), html(401, "HTML error card."), html(403, "HTML error card.")],
  },

  // --- Admin: agents --------------------------------------------------------
  {
    method: "get",
    path: "/admin/agents",
    tag: "Admin: Agents",
    summary: "List agents (created_at DESC, id DESC). Cursor-paginated.",
    security: SEC.operator,
    params: PAGINATION_PARAMS,
    responses: [ok(ListAgentsResponseSchema, "Agents page."), err(400, "bad_limit | bad_cursor"), err(401, "unauthorized"), err(403, "csrf_failed")],
  },
  {
    method: "post",
    path: "/admin/agents",
    tag: "Admin: Agents",
    summary: "Mint an agent + its initial key (one transaction). Plaintext key shown once.",
    security: SEC.operator,
    requestBody: jsonBody({ type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 200 } }, required: ["name"] }),
    responses: [created(MintAgentKeyResponseSchema, "Agent + key minted."), err(400, "bad_json | bad_request"), err(401, "unauthorized"), err(403, "csrf_failed"), err(500, "misconfigured")],
  },
  {
    method: "get",
    path: "/admin/agents/{agent_id}/keys",
    tag: "Admin: Agents",
    summary: "List keys for an agent. Cursor-paginated.",
    security: SEC.operator,
    params: PAGINATION_PARAMS,
    responses: [ok(ListAgentKeysResponseSchema, "Keys page."), err(400, "bad_limit | bad_cursor"), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found")],
  },
  {
    method: "post",
    path: "/admin/agents/{agent_id}/keys",
    tag: "Admin: Agents",
    summary: "Mint an additional key for an agent (rotation). Plaintext key shown once.",
    security: SEC.operator,
    responses: [created(MintAgentKeyResponseSchema, "Key minted."), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found"), err(500, "misconfigured")],
  },
  {
    method: "delete",
    path: "/admin/agents/{agent_id}",
    tag: "Admin: Agents",
    summary: "Cascading agent kill — revokes all keys + deletes all OAuth clients.",
    security: SEC.operator,
    responses: [ok(RevokeAgentResponseSchema, "Agent killed."), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found")],
  },
  {
    method: "delete",
    path: "/admin/keys/{key_id}",
    tag: "Admin: Agents",
    summary: "Revoke a single key (rotation). A second DELETE returns 404.",
    security: SEC.operator,
    responses: [ok(RevokeKeyResponseSchema, "Key revoked."), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found")],
  },

  // --- Admin: documents -----------------------------------------------------
  {
    method: "get",
    path: "/admin/documents",
    tag: "Admin: Documents",
    summary:
      "List all documents (incl. revoked). Cursor-paginated. With `?order=updated` " +
      "(+ optional `?updated_since=`) this is the corpus change feed (migration 0017); with " +
      "`?visibility=public&publication=pending` it is the operator's REVIEW QUEUE — every public " +
      "document whose newest version has not been promoted (migration 0018), in one request.",
    security: SEC.operator,
    params: [
      ...PAGINATION_PARAMS,
      ORDER_PARAM,
      UPDATED_SINCE_PARAM,
      { name: "tag", in: "query", description: "AND-filter by tag (repeatable).", schema: { type: "string" } },
      { name: "slug", in: "query", description: "Filter by slug (exact match; 0 or 1 rows).", schema: { type: "string" } },
      STATUS_FILTER_PARAM,
      VISIBILITY_FILTER_PARAM,
      PUBLICATION_FILTER_PARAM,
    ],
    responses: [ok(ListDocumentsResponseSchema, "Documents page."), err(400, "bad_limit | bad_cursor (incl. a cursor replayed under the other `order`) | bad_slug | bad_status | bad_request (unknown `order` / `visibility` / `publication`, or unparseable `updated_since`)"), err(401, "unauthorized"), err(403, "csrf_failed")],
  },
  {
    method: "post",
    path: "/admin/documents",
    tag: "Admin: Documents",
    summary: "Operator authors a new document (JSON body). Authored as the operator principal.",
    security: SEC.operator,
    requestBody: jsonBody({
      type: "object",
      properties: {
        content: { type: "string", description: "Document body — HTML or Markdown per `format`." },
        format: { type: "string", enum: ["html", "markdown"] },
        title: { type: "string", description: "Omit to derive from the first <h1>." },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        slug: { type: "string", description: "Unique slug /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/." },
        visibility: { type: "string", enum: ["public", "private"], description: "Birth visibility (else the deploy default)." },
      },
      required: ["content", "format"],
    }),
    responses: [
      created(WriteResponseSchema, "Stored. `Location` + `ETag` headers set."),
      err(400, "bad_json | bad_request | empty_body"),
      err(401, "unauthorized"),
      err(403, "csrf_failed"),
      err(409, "slug_taken | slug_retired"),
      err(413, "too_large | storage_cap_exceeded"),
      err(422, "invalid_slug | too_deep"),
    ],
  },
  {
    method: "get",
    path: "/admin/documents/search",
    tag: "Admin: Documents",
    summary:
      "Hybrid (keyword + semantic) search over live documents. NOT paginated (no next_cursor). " +
      "With ?include_bodies=true the 200 becomes a CONTEXT PACK (PackResponse): full markdown bodies " +
      "included best-first under budget_bytes/max_documents, the rest reported in omitted[] (never truncated).",
    security: SEC.operator,
    params: [
      { name: "q", in: "query", required: true, description: "Query. Keyword leg tokenizes it (words ≥2 chars, trailing * for prefix); semantic leg embeds it raw.", schema: { type: "string" } },
      { name: "mode", in: "query", description: "hybrid (default) | keyword | semantic.", schema: { type: "string", enum: ["hybrid", "keyword", "semantic"] } },
      { name: "tag", in: "query", description: "AND-filter by tag (repeatable). Applies to both legs.", schema: { type: "string" } },
      { name: "slug", in: "query", description: "Filter by slug. Applies to both legs.", schema: { type: "string" } },
      STATUS_FILTER_PARAM,
      VISIBILITY_FILTER_PARAM,
      PUBLICATION_FILTER_PARAM,
      UPDATED_SINCE_PARAM,
      { name: "limit", in: "query", description: "Cap (default 50, max 200).", schema: { type: "integer", minimum: 1, maximum: 200 } },
      { name: "include_bodies", in: "query", description: "true → return a context pack (PackResponse) instead of bare hits.", schema: { type: "string", enum: ["true", "false"] } },
      { name: "budget_bytes", in: "query", description: "Pack body budget in STORED bytes (default 65536, ~16K tokens; max 262144). Clamped, not rejected.", schema: { type: "integer" } },
      { name: "max_documents", in: "query", description: "Pack body-count cap (default 8, max 25). Clamped, not rejected.", schema: { type: "integer" } },
      { name: "include_deprecated", in: "query", description: "true → deprecated docs join the pack fill instead of being omitted-and-reported.", schema: { type: "string", enum: ["true", "false"] } },
    ],
    responses: [ok(SearchOrPackResponseSchema, "Hits (possibly empty), relevance-ranked — or, with include_bodies=true, the PackResponse envelope."), err(400, "bad_limit | bad_status | bad_request (bad `mode` / `visibility` / `publication`, or unparseable `updated_since`)"), err(401, "unauthorized"), err(403, "csrf_failed"), err(422, "bad_query (no leg could run)")],
  },
  {
    method: "get",
    path: "/admin/documents/{public_id}",
    tag: "Admin: Documents",
    // Prefix-dispatched, so test/openapi.test.mjs's static route scan cannot see
    // it — this entry is a hand-maintained obligation, gated only by
    // EXPECTED_ROUTES. Its index.ts guard carries an explicit `!== "search"`
    // term, since GET /admin/documents/search matches the same shape.
    summary:
      "Operator reads one document's listing row — the single-document twin of GET /admin/documents. Returns the row BARE, not wrapped.",
    security: SEC.operator,
    responses: [
      ok(
        DocumentListingSchema,
        "The document's listing row — the same projection GET /admin/documents returns per row. " +
          "REVOKED documents are returned here too, exactly as the list reports them: the row degrades to nulls " +
          "(`current_ver`, `published_ver`, `slug`, `title`, the sizes and hashes) with `revoked_at` set, so a " +
          "list→tap→detail flow needs no special case.",
      ),
      err(401, "unauthorized"),
      err(404, "not_found — no such document, or a malformed public_id"),
    ],
  },
  {
    method: "put",
    path: "/admin/documents/{public_id}",
    tag: "Admin: Documents",
    summary: "Operator updates a document (new version, authored as operator). Optional If-Match.",
    security: SEC.operator,
    params: [
      { name: "If-Match", in: "header", description: 'OPTIONAL (unlike PUT /d/:id). Send `"v<n>"` (or the lenient `v<n>`/`<n>` forms) or `*`; absent = last-write-wins.', schema: { type: "string" } },
    ],
    requestBody: jsonBody({
      type: "object",
      properties: {
        content: { type: "string", description: "Document body — HTML or Markdown per `format`." },
        format: { type: "string", enum: ["html", "markdown"] },
        title: { type: "string", description: 'Omit to inherit prior; "" re-derives from the first <h1>.' },
        description: { type: "string", description: 'Omit to inherit prior; "" clears.' },
        tags: { type: "array", items: { type: "string" } },
        slug: { type: "string", description: 'Omit to keep current; "" clears.' },
      },
      required: ["content", "format"],
    }),
    responses: [
      ok(WriteResponseSchema, "New version stored. `Location` + `ETag` headers set."),
      err(400, "bad_json | bad_request | empty_body (incl. malformed If-Match)"),
      err(401, "unauthorized"),
      err(403, "csrf_failed"),
      err(404, "not_found"),
      err(409, "slug_taken | slug_retired"),
      err(412, "precondition_failed (If-Match version mismatch)"),
      err(413, "too_large | storage_cap_exceeded"),
      err(422, "invalid_slug | too_deep"),
    ],
  },
  {
    method: "get",
    path: "/admin/documents/{public_id}/versions",
    tag: "Admin: Documents",
    summary:
      "Version history for a live document — the JSON twin of the manage page's history table. " +
      "Newest first, capped at the 200 most recent (the same bound every list surface uses), no " +
      "cursor. Check each row's `source_present` before offering Restore: a pre-0008 version with " +
      "no retained source cannot be restored. `is_published` marks the row `documents.published_ver` " +
      "names — what a PUBLIC document actually renders — and is what a Publish control keys on; it is " +
      "orthogonal to `is_current`, and false on every row when nothing has been published. " +
      "Operator-only, like every history view — a public doc's history is as operator-only as a " +
      "private one's.",
    security: SEC.operator,
    responses: [ok(ListVersionsResponseSchema, "Version manifest."), err(401, "unauthorized"), err(404, "not_found")],
  },
  {
    method: "post",
    path: "/admin/documents/{public_id}/restore",
    tag: "Admin: Documents",
    summary:
      "Re-publish historical version n as a NEW version — the JSON twin of the manage page's " +
      "Restore button. Restore is mandatorily restore-as-new (never a `current_ver` rewind, which " +
      "would collide on the next ordinary update), and restores body + title/description/tags " +
      "while KEEPING the document's current slug (slug is identity, not content). Operator-only: " +
      "there is no agent restore in v1.",
    security: SEC.operator,
    requestBody: jsonBody({
      type: "object",
      properties: { version: { type: "integer", minimum: 1, description: "The version number to restore." } },
      required: ["version"],
    }),
    responses: [
      ok(RestoreResponseSchema, "Restored as a new version; `restored_from` names the source version."),
      err(400, "bad_json | bad_request (missing/non-integer `version`) | empty_body"),
      err(401, "unauthorized"),
      err(403, "csrf_failed"),
      err(404, "not_found (no such live document) | version_not_found (the document is live but has no version n; the body carries `version`)"),
      err(409, "source_unavailable (that version predates source retention; the body carries `version`) | precondition_failed"),
      err(413, "too_large | storage_cap_exceeded"),
      err(422, "too_deep"),
      err(500, "internal (defensive — the slug branches of the update error union are unreachable from a restore)"),
    ],
  },
  {
    method: "post",
    path: "/admin/documents/{public_id}/visibility",
    tag: "Admin: Documents",
    summary:
      "Set a live doc public/private (no version bump). Idempotent. Flipping to `public` also fills " +
      "`published_ver` from `current_ver` when it is still null, so a newly-public document always " +
      "has bytes to serve; flipping back to private deliberately leaves the pointer standing.",
    security: SEC.operator,
    requestBody: jsonBody({ type: "object", properties: { visibility: { type: "string", enum: ["public", "private"] } }, required: ["visibility"] }),
    responses: [ok(SetDocumentVisibilityResponseSchema, "Visibility set."), err(400, "bad_json | invalid_visibility"), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found")],
  },
  {
    method: "post",
    path: "/admin/documents/{public_id}/promote",
    tag: "Admin: Documents",
    summary:
      "Publish version n — point `documents.published_ver` at it (migration 0018). The immediate " +
      "sibling of the visibility flip above: between them they decide everything the anonymous " +
      "internet sees, `visibility` opening the door and `published_ver` picking the bytes behind it. " +
      "It exists because any active agent key may overwrite any live document (single-tenant trust), " +
      "so without a promote step an agent could push content into a public document and have the " +
      "world served it on the next render — the HTML byte path for a public doc therefore renders " +
      "`published_ver` while agent writes keep advancing `current_ver`. An agent can write; it " +
      "cannot publish, and there is deliberately no agent-reachable twin of this route. Not a write: " +
      "no version bump, no FTS/vector/link resync, just the column plus `updated_at`. Idempotent, and " +
      "ALLOWED on a private document — that stages the choice before the door opens, and the later " +
      "flip to public keeps it.",
    security: SEC.operator,
    requestBody: jsonBody({
      type: "object",
      properties: { version: { type: "integer", minimum: 1, description: "The version number to publish; must exist on this document." } },
      required: ["version"],
    }),
    responses: [
      ok(PromoteResponseSchema, "`published_ver` now names this version (a public doc renders it from here on)."),
      err(400, "bad_json | bad_request (missing/non-integer `version`)"),
      err(401, "unauthorized"),
      err(403, "csrf_failed"),
      err(404, "not_found (no such live document) | version_not_found (the document is live but has no version n; the body carries `version`)"),
    ],
  },
  {
    method: "post",
    path: "/admin/documents/{public_id}/slug",
    tag: "Admin: Documents",
    summary: "Add/rename/clear a live doc's slug (no version bump; rename auto-forwards).",
    security: SEC.operator,
    requestBody: jsonBody({ type: "object", properties: { slug: { type: "string", description: 'empty string clears' } }, required: ["slug"] }),
    responses: [ok(SetDocumentSlugResponseSchema, "Slug set/renamed/cleared."), err(400, "bad_json | bad_request"), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found"), err(409, "slug_taken | slug_retired"), err(422, "invalid_slug")],
  },
  {
    method: "post",
    path: "/admin/documents/{public_id}/status",
    tag: "Admin: Documents",
    summary: "Set a live doc's lifecycle status (active|deprecated; archived reserved). No version bump. Idempotent.",
    security: SEC.operator,
    requestBody: jsonBody({
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "deprecated"], description: '"archived" is reserved and rejected in v1.' },
        superseded_by: { type: "string", description: "Replacement doc's public_id (deprecated only). Full-replace per call; omitted clears. Must be live, not self." },
      },
      required: ["status"],
    }),
    responses: [ok(SetDocumentStatusResponseSchema, "Status set."), err(400, "bad_json | bad_request | invalid_status"), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found"), err(422, "bad_target (superseded_by not a live doc / self-pointer)")],
  },
  {
    method: "post",
    path: "/admin/documents/{public_id}/tags",
    tag: "Admin: Documents",
    summary: "Replace a live doc's tags (full replacement, no version bump). Idempotent.",
    security: SEC.operator,
    requestBody: jsonBody({ type: "object", properties: { tags: { type: "array", items: { type: "string" } } }, required: ["tags"] }),
    responses: [ok(SetDocumentTagsResponseSchema, "Tags replaced."), err(400, "bad_json | bad_request"), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found")],
  },

  // --- Admin: vectors -------------------------------------------------------
  {
    method: "post",
    path: "/admin/vectors/backfill",
    tag: "Admin: Documents",
    summary: "Backfill / reconcile the Vectorize semantic index. Operator-invoked, resumable.",
    security: SEC.operator,
    params: [
      { name: "mode", in: "query", description: "missing (default — embed only un-vectorized docs) | rebuild (re-embed every live doc).", schema: { type: "string", enum: ["missing", "rebuild"] } },
      { name: "limit", in: "query", description: "Docs scanned per page (default 50, max 200).", schema: { type: "integer", minimum: 1, maximum: 200 } },
      { name: "cursor", in: "query", description: "Resume cursor from a prior page's next_cursor.", schema: { type: "string" } },
    ],
    responses: [ok(BackfillResponseSchema, "One page processed; re-invoke with ?cursor= while next_cursor is non-null."), err(400, "bad_request | bad_limit | bad_cursor"), err(401, "unauthorized"), err(403, "csrf_failed")],
  },

  // --- Admin: link graph ----------------------------------------------------
  {
    method: "post",
    path: "/admin/links/backfill",
    tag: "Admin: Documents",
    summary:
      "Backfill the link graph (issue #40): re-extract document_links from each live doc's stored render. " +
      "Idempotent (always rebuild-semantics), resumable. Run once after the 0016 migration.",
    security: SEC.operator,
    params: [
      { name: "limit", in: "query", description: "Docs scanned per page (default 50, max 200).", schema: { type: "integer", minimum: 1, maximum: 200 } },
      { name: "cursor", in: "query", description: "Resume cursor from a prior page's next_cursor.", schema: { type: "string" } },
    ],
    responses: [ok(LinksBackfillResponseSchema, "One page processed; re-invoke with ?cursor= while next_cursor is non-null."), err(400, "bad_limit | bad_cursor"), err(401, "unauthorized"), err(403, "csrf_failed")],
  },
  {
    method: "post",
    path: "/admin/docs/seed",
    tag: "Admin: Documents",
    summary:
      "Seed the bundled platform documentation into the corpus (issue #4). Idempotent — a pass with nothing to do writes nothing. Also runs automatically off /mcp, latched once per isolate; this route is the immediate lever and the per-doc report.",
    security: SEC.operator,
    responses: [
      ok(SeedPlatformDocsResponseSchema, "Every doc created, updated or already current."),
      ok(SeedPlatformDocsResponseSchema, "Partial: at least one doc came back `blocked` (its reserved slug is retired) or `failed`. Same body; `ok` is false.", 207),
      err(401, "unauthorized"),
      err(403, "csrf_failed"),
    ],
  },
  {
    method: "get",
    path: "/admin/links/orphans",
    tag: "Admin: Documents",
    summary:
      "Live documents NO live document links to (neither by public_id nor current slug) — the link-graph " +
      "curation view. Newest first, capped at 200, no cursor.",
    security: SEC.operator,
    responses: [ok(OrphanDocumentsResponseSchema, "Orphan listing rows."), err(401, "unauthorized")],
  },

  // --- Admin: slug tombstones -----------------------------------------------
  {
    method: "post",
    path: "/admin/slugs/{slug}/redirect",
    tag: "Admin: Slugs",
    summary: "Point a retired slug at a live doc (loud redirect).",
    security: SEC.operator,
    requestBody: jsonBody({ type: "object", properties: { target_public_id: { type: "string" } }, required: ["target_public_id"] }),
    responses: [ok(SetSlugRedirectResponseSchema, "Redirect set."), err(400, "bad_json | bad_request"), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found (slug not retired)"), err(422, "bad_target")],
  },
  {
    method: "delete",
    path: "/admin/slugs/{slug}/redirect",
    tag: "Admin: Slugs",
    summary: "Drop a retired slug's redirect (back to 410 Gone). Slug stays retired.",
    security: SEC.operator,
    responses: [ok(ClearSlugRedirectResponseSchema, "Redirect cleared."), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found")],
  },
  {
    method: "delete",
    path: "/admin/slugs/{slug}",
    tag: "Admin: Slugs",
    summary: "Force-release a retired slug (escape hatch — the only un-retire path).",
    security: SEC.operator,
    responses: [ok(ReleaseSlugTombstoneResponseSchema, "Slug released."), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found")],
  },

  // --- Admin: OAuth clients -------------------------------------------------
  {
    method: "post",
    path: "/admin/agents/{agent_id}/oauth-clients",
    tag: "Admin: OAuth",
    summary: "Mint an OAuth client bound to an agent (one per agent). Secret shown once.",
    security: SEC.operator,
    responses: [created(CreateOAuthClientResponseSchema, "Bound client minted."), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found"), err(409, "client_exists")],
  },
  {
    method: "post",
    path: "/admin/oauth-clients",
    tag: "Admin: OAuth",
    summary: "Mint an UNBOUND OAuth client (agent chosen at /authorize). Secret shown once.",
    security: SEC.operator,
    responses: [created(CreateUnboundOAuthClientResponseSchema, "Unbound client minted."), err(401, "unauthorized"), err(403, "csrf_failed")],
  },
  {
    method: "delete",
    path: "/admin/oauth-clients/{client_id}",
    tag: "Admin: OAuth",
    summary: "Cascading OAuth-client revoke (invalidates grants + live tokens). Bound or unbound.",
    security: SEC.operator,
    responses: [ok(DeleteOAuthClientResponseSchema, "Client revoked."), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found")],
  },
];

// ============================================================================
// Assembler
// ============================================================================

const TAG_ORDER = [
  "Public",
  "Documents",
  "Slugs",
  "Versions",
  "Management",
  "Session",
  "OAuth",
  "MCP",
  "Console",
  "Admin: Agents",
  "Admin: Documents",
  "Admin: Slugs",
  "Admin: OAuth",
];

const TAG_DESCRIPTIONS: Record<string, string> = {
  Public: "Unauthenticated landing, health, static, and this spec.",
  Documents: "Publish/update/read/revoke documents by public_id.",
  Slugs: "Slug-addressed read surface (the /s/ namespace).",
  Versions: "Operator-only version-history views.",
  Management: "Operator browser management + form POSTs (HTML).",
  Session: "Operator browser sign-in/out.",
  OAuth: "OAuth 2.1 consent + provider-library endpoints.",
  MCP: "Streamable-HTTP MCP (JSON-RPC) connector door.",
  Console:
    "Operator browser console (HTML, no JS), cookie-session authed; form-field CSRF; " +
    "POST twins of the JSON admin DELETEs.",
  "Admin: Agents": "Operator agent + key administration.",
  "Admin: Documents": "Operator document listing, search, and mutators.",
  "Admin: Slugs": "Operator slug-tombstone redirect/release.",
  "Admin: OAuth": "Operator OAuth-client administration.",
};

function pathParams(path: string): Json[] {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  return names.map((name) => ({
    name,
    in: "path",
    required: true,
    description: name === "n" ? "Version number (positive integer)." : `Path parameter \`${name}\`.`,
    schema: { type: "string" },
  }));
}

function bodyToContent(body: Resp["body"]): Json | undefined {
  if (!body) return undefined;
  if ("json" in body) return { "application/json": { schema: refFor(body.json) } };
  if ("error" in body) return { "application/json": { schema: refFor(ErrorBodySchema) } };
  if ("html" in body) return { "text/html": { schema: { type: "string" } } };
  if ("markdownOrJson" in body) {
    return {
      "text/markdown": { schema: { type: "string" } },
      "application/json": { schema: refFor(body.markdownOrJson) },
    };
  }
  if ("javascript" in body) return { "text/javascript": { schema: { type: "string" } } };
  if ("openapi" in body) return { "application/json": { schema: { type: "object" } } };
  return undefined;
}

function buildResponses(responses: Resp[]): Json {
  const out: Json = {};
  for (const r of responses) {
    const content = bodyToContent(r.body);
    out[String(r.status)] = content ? { description: r.description, content } : { description: r.description };
  }
  return out;
}

function buildOperation(route: Route): Json {
  const params = [...pathParams(route.path), ...(route.params ?? [])];
  const op: Json = {
    tags: [route.tag],
    summary: route.summary,
    security: route.security,
    responses: buildResponses(route.responses),
  };
  if (params.length) op.parameters = params;
  if (route.requestBody) op.requestBody = route.requestBody;
  return op;
}

function buildPaths(): Json {
  const paths: Json = {};
  for (const route of ROUTES) {
    const item = (paths[route.path] as Json | undefined) ?? (paths[route.path] = {});
    (item as Json)[route.method] = buildOperation(route);
  }
  return paths;
}

/**
 * Assemble the full OpenAPI 3.1 document. Deterministic: same code → byte-equal
 * output (sorted components, fixed route order), which is what the freshness CI
 * gate (`git diff --exit-code openapi.json`) relies on.
 *
 * @param serverUrl  Base URL to advertise in `servers` — defaults to the
 *   canonical production origin so the committed file is stable; the live
 *   `GET /openapi.json` route passes the request origin so dev/staging codegen
 *   points at the right host.
 */
export function buildOpenApiDocument(serverUrl: string = DEFAULT_SERVER_URL): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "Slopcafe HTTP API",
      version: OPENAPI_INFO_VERSION,
      description:
        "Generated from src/contract.ts (Zod). The narrative/behavioral contract " +
        "lives in docs/http-api.md; this document is the precise shape reference. " +
        "Some routes (content-negotiated reads, HTML/UI surfaces, the JSON-RPC /mcp " +
        "door, and OAuth-library endpoints) are only partly modelled here — see " +
        "their descriptions.\n\n" +
        "Two properties hold across every error response this Worker emits itself " +
        "(i.e. each `ErrorBody` response below — not the OAuth provider library's " +
        "own endpoints), so they are stated once here rather than repeated on ~200 " +
        "response entries: the body is always the `ErrorBody` shape (a discriminated " +
        "union on `error`, whose members add their own context fields), and the " +
        "response carries `Link: </openapi.json>; rel=\"service-desc\"` (RFC 8631) so " +
        "even a failed request teaches a client where the contract lives. " +
        "`GET /healthz` is the in-band discovery document.\n\n" +
        // The CORS paragraph deliberately does not spell the credentials header
        // out. Its exact name (and the reason it can never be emitted) lives in
        // one place, src/cors.ts, and test/cors.test.mjs scans src/ for that
        // literal in any CODE position — a documentation string is code as far
        // as that scan is concerned, and a second copy of the spelling here
        // would be one more place for the rule to rot.
        "CROSS-ORIGIN (CORS). Off by default; a deployment enables it by listing exact " +
        "origins in the `CORS_ALLOWED_ORIGINS` var. When on, the machine-readable routes " +
        "below — the document API under `/d` and `/s`, the JSON operator API under " +
        "`/admin` (but NOT the HTML console at `/admin/console`), `/healthz`, " +
        "`/openapi.json` and the bundled documentation under `/docs` — answer a " +
        "preflight and carry `Access-Control-Allow-Origin` for " +
        "an allowlisted origin. The browser/HTML surfaces (`/login`, `/logout`, " +
        "`/authorize`, `/admin/console/*`, `/d/{public_id}/manage`, `/d/{public_id}/revoke` " +
        "and the manage page's form POSTs) are excluded. **Credentials are never allowed**: " +
        "the CORS credentials header is not emitted on any response, so the operator's " +
        "session cookies are unusable cross-origin and a cross-origin caller " +
        "authenticates with a Bearer token (`ApiKeyBearer`) only. Only these response " +
        "headers are readable cross-origin: `etag`, `link`, `location`, " +
        "`x-converter-version`, `x-doc-current-version`, `x-sanitizer-version` — a client " +
        "doing optimistic concurrency needs the third and fifth of those. Preflights are " +
        "handled by a wrapper ahead of routing and are therefore not modelled as " +
        "per-route `OPTIONS` operations; `GET /healthz` reports whether the caller's own " +
        "origin is allowed. Full details in docs/http-api.md.",
    },
    servers: [{ url: serverUrl }],
    tags: TAG_ORDER.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
    paths: buildPaths(),
    components: {
      securitySchemes: SECURITY_SCHEMES,
      schemas: buildComponentSchemas(),
    },
  };
}

/** The route registry, exposed for the completeness test. */
export function listRegisteredRoutes(): Array<{ method: string; path: string }> {
  return ROUTES.map((r) => ({ method: r.method.toUpperCase(), path: r.path }));
}
