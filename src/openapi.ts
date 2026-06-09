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
  DocumentListingSchema,
  DocumentStatusSchema,
  ErrorBodySchema,
  HealthzResponseSchema,
  ListAgentKeysResponseSchema,
  ListAgentsResponseSchema,
  ListDocumentsResponseSchema,
  MintAgentKeyResponseSchema,
  ReadSourceResponseSchema,
  RedirectTargetSchema,
  ReleaseSlugTombstoneResponseSchema,
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
  VisibilitySchema,
  WriteResponseSchema,
} from "./contract.js";

// ============================================================================
// Component registry — the named #/components/schemas the doc exposes
// ============================================================================

/**
 * The canonical version of the published contract (semver — see design §14).
 * Pre-stable `0.x`: bump the MINOR for any notable shape change (breaking
 * included), the PATCH for doc/clarification-only edits. Cut `1.0.0` at launch,
 * then switch to strict semver (breaking → MAJOR).
 */
export const OPENAPI_INFO_VERSION = "0.7.0";

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
named("DocumentListing", DocumentListingSchema);
named("SearchHit", SearchHitSchema);
named("WriteResponse", WriteResponseSchema);
named("RevokeResponse", RevokeResponseSchema);
named("ReadSourceResponse", ReadSourceResponseSchema);
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
named("BackfillResponse", BackfillResponseSchema);
named("SetSlugRedirectResponse", SetSlugRedirectResponseSchema);
named("ClearSlugRedirectResponse", ClearSlugRedirectResponseSchema);
named("ReleaseSlugTombstoneResponse", ReleaseSlugTombstoneResponseSchema);
named("CreateOAuthClientResponse", CreateOAuthClientResponseSchema);
named("CreateUnboundOAuthClientResponse", CreateUnboundOAuthClientResponseSchema);
named("DeleteOAuthClientResponse", DeleteOAuthClientResponseSchema);
named("ErrorBody", ErrorBodySchema);

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
    | { markdown: true }
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
const markdown = (status: number, description: string): Resp => ({
  status,
  description,
  body: { markdown: true },
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
    summary: "Public landing page (homepage document, framed shell).",
    security: SEC.none,
    responses: [html(200, "HTML landing shell."), html(404, "Opaque 404 if the homepage doc is missing/revoked.")],
  },
  {
    method: "get",
    path: "/healthz",
    tag: "Public",
    summary: "Health/smoke check — confirms D1 + R2 bindings and migrations.",
    security: SEC.none,
    responses: [ok(HealthzResponseSchema, "Bindings reachable; exact counts are safe to expose.")],
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
      err(422, "invalid_slug | integrity_mismatch"),
    ],
  },
  {
    method: "get",
    path: "/d/{public_id}",
    tag: "Documents",
    summary:
      "Read a document. Content-negotiated on the Authorization header: no header → HTML shell; " +
      "valid agent key → raw sanitized bytes; bad key → 401. Private docs 404 to anonymous callers " +
      "(no existence oracle). The shell branch does NOT honor If-None-Match.",
    security: SEC.agentOptional,
    responses: [
      html(200, "HTML shell (no auth) or sanitized bytes (valid agent key)."),
      err(401, "unauthorized (a malformed/invalid key — not downgraded to the shell)."),
      html(404, "HTML 404 card (browser) or plain text (agent key) — same opaque 404 for missing/revoked/private."),
    ],
  },
  {
    method: "put",
    path: "/d/{public_id}",
    tag: "Documents",
    summary: "Update a document (new version). Agent key + If-Match required.",
    security: SEC.agent,
    params: [
      { name: "If-Match", in: "header", required: true, description: 'Required (428 if missing). Send `"v<n>"` or `*`.', schema: { type: "string" } },
      ...WRITE_METADATA_HEADERS,
    ],
    requestBody: rawDocumentBody(),
    responses: [
      ok(WriteResponseSchema, "New version stored. `Location` + `ETag` headers set."),
      err(400, "empty_body | bad_request | bad_integrity_header"),
      err(401, "unauthorized"),
      err(404, "not_found"),
      err(409, "slug_taken | slug_retired"),
      err(412, "precondition_failed (If-Match version mismatch)"),
      err(413, "too_large | storage_cap_exceeded"),
      err(415, "unsupported_media_type"),
      err(422, "invalid_slug | integrity_mismatch"),
      err(428, "precondition_required (If-Match missing)"),
    ],
  },
  {
    method: "delete",
    path: "/d/{public_id}",
    tag: "Documents",
    summary: "Revoke (kill) a document + purge R2 bytes. Operator-gated.",
    security: SEC.operator,
    params: [{ name: "X-CSRF-Token", in: "header", description: "Required when authed via session cookie.", schema: { type: "string" } }],
    responses: [
      ok(RevokeResponseSchema, "Revoked. A second DELETE on a revoked doc returns 404."),
      err(401, "unauthorized"),
      err(403, "csrf_failed"),
      err(404, "not_found"),
    ],
  },
  {
    method: "get",
    path: "/d/{public_id}/raw",
    tag: "Documents",
    summary:
      "Sanitized HTML bytes (what the sandboxed iframe loads). Honors If-None-Match → 304. " +
      "Visibility gate: private docs 404 to anonymous callers.",
    security: SEC.agentOptional,
    params: [{ name: "If-None-Match", in: "header", description: 'Send `"v<n>"`; a match returns a bodyless 304.', schema: { type: "string" } }],
    responses: [
      html(200, "Sanitized HTML (Markdown docs get a reading-theme prefix). `ETag` set."),
      empty(304, "If-None-Match satisfied (checked AFTER the visibility gate — never an oracle)."),
      html(404, "Plain-text 'Not Found' (opaque for missing/revoked/private)."),
    ],
  },
  {
    method: "get",
    path: "/d/{public_id}/text",
    tag: "Documents",
    summary:
      "Markdown derivation of the sanitized HTML, for agents ingesting as context. Agent key required. " +
      "(The MCP `read_document` format:\"markdown\" twin returns the JSON `ReadTextResponse` envelope; " +
      "this HTTP route returns raw text/markdown with the metadata in headers.)",
    security: SEC.agent,
    responses: [
      markdown(200, "text/markdown; sets `x-sanitizer-version`, `x-converter-version`, `ETag`."),
      err(401, "unauthorized"),
      html(404, "Plain-text 'Not Found'."),
    ],
  },
  {
    method: "get",
    path: "/d/{public_id}/source",
    tag: "Documents",
    summary:
      "The retained, UNSANITIZED source S + advisories re-derived from it (the read before edit_document). " +
      "Agent key required.",
    security: SEC.agent,
    responses: [
      ok(ReadSourceResponseSchema, "Source returned with an explicit `unsanitized: true` provenance marker."),
      err(401, "unauthorized"),
      html(404, "Plain-text 'Not Found'."),
      err(409, "source_unavailable (un-backfilled/legacy doc with no retained source)."),
    ],
  },

  // --- Slug surface ---------------------------------------------------------
  {
    method: "get",
    path: "/s/{slug}",
    tag: "Slugs",
    summary:
      "Slug-addressed twin of GET /d/{public_id} — content-negotiated identically (shell vs bytes vs 401), " +
      "keeping the pretty slug in the address bar (no 302). Retired slugs forward loudly or 410.",
    security: SEC.agentOptional,
    params: [FOLLOW_REDIRECTS_PARAM],
    responses: [
      html(200, "HTML shell (no auth) or sanitized bytes (valid agent key)."),
      err(401, "unauthorized"),
      html(404, "HTML 404 (browser) or plain text (agent key) — never-claimed slug, opaque."),
      err(409, "slug_redirected (agent, retired slug with a redirect, no follow_redirects)."),
      html(410, "HTML Gone (browser) or JSON (agent key) — retired slug, no redirect."),
    ],
  },
  {
    method: "get",
    path: "/s/{slug}/text",
    tag: "Slugs",
    summary: "Markdown derivation by slug (agent key required). Slug-addressed twin of /d/{id}/text.",
    security: SEC.agent,
    params: [FOLLOW_REDIRECTS_PARAM],
    responses: [
      markdown(200, "text/markdown."),
      err(401, "unauthorized"),
      html(404, "Plain-text 'Not Found'."),
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
    summary: "Operator form: set public/private (no version bump). Auth ladder: operator_token OR cookie+csrf_token.",
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
      "or Door B (awh_ bearer). Tools: publish_document, update_document, edit_document, read_document, " +
      "list_documents, search_documents, create_publish_credential. The request/response bodies are " +
      "JSON-RPC envelopes (optionally an SSE stream), not schema-validated here — see docs/http-api.md.",
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
    summary: "Maintenance page — the Vectorize backfill form. Sign-in card when logged out.",
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
    summary: "List all documents (incl. revoked). Cursor-paginated.",
    security: SEC.operator,
    params: [
      ...PAGINATION_PARAMS,
      { name: "tag", in: "query", description: "AND-filter by tag (repeatable).", schema: { type: "string" } },
      { name: "slug", in: "query", description: "Filter by slug (exact match; 0 or 1 rows).", schema: { type: "string" } },
      STATUS_FILTER_PARAM,
    ],
    responses: [ok(ListDocumentsResponseSchema, "Documents page."), err(400, "bad_limit | bad_cursor | bad_slug | bad_status"), err(401, "unauthorized"), err(403, "csrf_failed")],
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
      err(422, "invalid_slug"),
    ],
  },
  {
    method: "get",
    path: "/admin/documents/search",
    tag: "Admin: Documents",
    summary: "Hybrid (keyword + semantic) search over live documents. NOT paginated (no next_cursor).",
    security: SEC.operator,
    params: [
      { name: "q", in: "query", required: true, description: "Query. Keyword leg tokenizes it (words ≥2 chars, trailing * for prefix); semantic leg embeds it raw.", schema: { type: "string" } },
      { name: "mode", in: "query", description: "hybrid (default) | keyword | semantic.", schema: { type: "string", enum: ["hybrid", "keyword", "semantic"] } },
      { name: "tag", in: "query", description: "AND-filter by tag (repeatable). Applies to both legs.", schema: { type: "string" } },
      { name: "slug", in: "query", description: "Filter by slug. Applies to both legs.", schema: { type: "string" } },
      STATUS_FILTER_PARAM,
      { name: "limit", in: "query", description: "Cap (default 50, max 200).", schema: { type: "integer", minimum: 1, maximum: 200 } },
    ],
    responses: [ok(SearchDocumentsResponseSchema, "Hits (possibly empty), relevance-ranked."), err(400, "bad_limit | bad_status | bad_request (bad mode)"), err(401, "unauthorized"), err(403, "csrf_failed"), err(422, "bad_query (no leg could run)")],
  },
  {
    method: "put",
    path: "/admin/documents/{public_id}",
    tag: "Admin: Documents",
    summary: "Operator updates a document (new version, authored as operator). Optional If-Match.",
    security: SEC.operator,
    params: [
      { name: "If-Match", in: "header", description: 'OPTIONAL (unlike PUT /d/:id). Send `"v<n>"` or `*`; absent = last-write-wins.', schema: { type: "string" } },
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
      err(422, "invalid_slug"),
    ],
  },
  {
    method: "post",
    path: "/admin/documents/{public_id}/visibility",
    tag: "Admin: Documents",
    summary: "Set a live doc public/private (no version bump). Idempotent.",
    security: SEC.operator,
    requestBody: jsonBody({ type: "object", properties: { visibility: { type: "string", enum: ["public", "private"] } }, required: ["visibility"] }),
    responses: [ok(SetDocumentVisibilityResponseSchema, "Visibility set."), err(400, "bad_json | invalid_visibility"), err(401, "unauthorized"), err(403, "csrf_failed"), err(404, "not_found")],
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
  if ("markdown" in body) return { "text/markdown": { schema: { type: "string" } } };
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
      title: "Slopcafe (agent-web-host) HTTP API",
      version: OPENAPI_INFO_VERSION,
      description:
        "Generated from src/contract.ts (Zod). The narrative/behavioral contract " +
        "lives in docs/http-api.md; this document is the precise shape reference. " +
        "Some routes (content-negotiated reads, HTML/UI surfaces, the JSON-RPC /mcp " +
        "door, and OAuth-library endpoints) are only partly modelled here — see " +
        "their descriptions.",
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
