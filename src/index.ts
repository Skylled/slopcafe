// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Slopcafe — one Worker in front of D1 (metadata) + R2 (bytes).
 *
 * Routes implemented:
 *   GET  /                              — public landing page (homepage doc, toolbar-less shell)
 *   GET  /healthz                       — health/smoke endpoint (bindings + migration check)
 *   GET  /openapi.json                  — public: generated OpenAPI 3.1 spec (assembled on demand)
 *   GET  /shell.js                      — public: toolbar enhancement script for the document shell
 *   GET  /.well-known/assetlinks.json   — public: Android App Links verification (issue #50; 404 unless APP_LINKS_ANDROID_* set)
 *   GET  /.well-known/apple-app-site-association — public: iOS Universal Links verification (404 unless APP_LINKS_APPLE_APP_ID set)
 *   GET  /docs                          — public: index of the bundled platform documentation
 *   GET  /docs/:name                    — public: bundled doc shell (Accept: text/markdown → the source)
 *   GET  /docs/:name/raw                — public: bundled doc bytes, sanitized at build time
 *   POST /d                             — agent-auth: sanitize + store
 *   GET  /d                             — agent/operator-auth: list documents (HTTP twin of MCP list_documents; ?slug= resolves slug→public_id)
 *   GET  /d/search                      — agent/operator-auth: hybrid search (HTTP twin of MCP search_documents; ?include_bodies= context pack)
 *   GET  /d/pack                        — agent/operator-auth: document/manifest-root context pack (HTTP twin of MCP load_context_pack; ?from=slug-or-id)
 *   PUT  /d/:public_id                  — agent-auth + If-Match: new version
 *   PUT  /d/:public_id/tags             — agent/operator-auth: replace a live doc's tags (JSON; no version bump)
 *   PUT  /d/:public_id/status           — agent/operator-auth: set lifecycle status active|deprecated (JSON; no version bump)
 *   DELETE /d/:public_id                — operator-auth (Bearer, or session cookie + X-CSRF-Token): revoke + purge (JSON)
 *   GET  /d/:public_id                  — shell or raw; public only if visibility=public, else operator/agent only (404 to anon)
 *   GET  /d/:public_id/raw              — sanitized bytes (iframe src); same visibility gate as above
 *   GET  /d/:public_id/v/:n             — operator-only: framed shell for historical version n
 *   GET  /d/:public_id/v/:n/raw         — operator-only: sanitized bytes of historical version n (iframe src)
 *   GET  /d/:public_id/text             — agent-auth: Markdown derivation (for agents reading as context)
 *   GET  /d/:public_id/source           — agent-auth: retained unsanitized source S (for read-source → edit → republish)
 *   GET  /d/:public_id/links            — agent/operator-auth: link-graph neighborhood — backlinks + outbound link health (issue #40)
 *   GET  /s/:slug                       — shell page direct (slug stays in the bar) or raw bytes — same content negotiation + visibility gate as /d/:public_id (private → 404 to anon, slug stays claimed)
 *   GET  /s/:slug/text                  — agent-auth: Markdown derivation by slug (gated, same as /d/:public_id/text)
 *   GET  /d/:public_id/manage           — operator browser page: visibility toggle + slug editor + version history + revoke (cookie session required for the controls)
 *   POST /d/:public_id/visibility       — operator-auth via form field: set public/private (no version bump)
 *   POST /d/:public_id/slug             — operator-auth via form field: add/rename/clear the slug (no version bump; rename auto-forwards)
 *   POST /d/:public_id/status           — operator-auth via form field: set lifecycle status active|deprecated (no version bump)
 *   POST /d/:public_id/promote          — operator-auth via form field: publish version n (what a PUBLIC doc renders)
 *   POST /d/:public_id/restore          — operator-auth via form field: restore historical version n as a new version
 *   GET  /d/:public_id/revoke           — operator-paste confirmation form (HTML)
 *   POST /d/:public_id/revoke           — operator-auth via form field: revoke + purge
 *   *    /mcp                           — Streamable HTTP MCP surface, agent-auth
 *                                          via Door A (OAuth, ctx.props from
 *                                          OAuthProvider) or Door B (static
 *                                          `awh_` bearer — same key path POST
 *                                          /d uses). Optional ?tools=a,b
 *                                          narrows the toolset for that
 *                                          connection (absent = all eleven;
 *                                          unknown name → 400). See
 *                                          src/mcp.ts + src/mcp-toolset.ts.
 *   GET|POST /authorize                 — consent UI for Door A (src/authorize.ts).
 *                                          /token and /.well-known/* are handled
 *                                          by the OAuthProvider wrap itself.
 *   GET|POST /login                     — operator browser session: sign-in form + mint signed cookie (src/login.ts)
 *   GET|POST /logout                    — sign-out confirm form + clear cookie
 *
 * Operator admin lives in src/admin.ts and src/admin-oauth.ts:
 *   GET    /admin/agents                       — list agents
 *   POST   /admin/agents                       — mint agent + initial key
 *   DELETE /admin/agents/:id                   — cascading kill (keys + OAuth clients)
 *   GET    /admin/agents/:id/keys              — list keys for an agent
 *   POST   /admin/agents/:id/keys              — mint additional key for an agent
 *   POST   /admin/agents/:id/oauth-clients     — mint an OAuth client bound to an agent
 *   POST   /admin/oauth-clients                — mint an UNBOUND OAuth client (bind agent at /authorize)
 *   DELETE /admin/keys/:id                     — revoke a single key (rotation)
 *   POST   /admin/keys/prune                   — hard-delete expired/long-revoked agent_keys rows (issue #13)
 *   DELETE /admin/oauth-clients/:client_id     — revoke an OAuth client (rotation)
 *   GET    /admin/audit                        — append-only operator audit ledger (issue #62; cursor-paginated, filters kind/agent_id/document_id/since)
 *   GET    /admin/documents                    — list documents (incl. revoked)
 *   POST   /admin/documents                    — operator authors a new document (JSON body)
 *   GET    /admin/documents/search              — hybrid (keyword + semantic) search over live documents
 *   GET    /admin/documents/:public_id         — operator single-document read (one DocumentListing row, incl. revoked)
 *   PUT    /admin/documents/:public_id         — operator updates a document (new version; optional If-Match)
 *   GET    /admin/documents/:public_id/versions — operator version history (JSON twin of the manage-page table)
 *   POST   /admin/documents/:public_id/restore — operator restores version n as a NEW version (JSON twin of the manage-page form)
 *   POST   /admin/documents/:public_id/visibility — operator sets a live doc public/private
 *   POST   /admin/documents/:public_id/promote — operator publishes version n (the bytes a PUBLIC doc renders)
 *   POST   /admin/documents/:public_id/slug    — operator adds/renames/clears a live doc's slug (rename auto-forwards)
 *   POST   /admin/documents/:public_id/tags    — operator replaces a live doc's tags (no version bump)
 *   POST   /admin/documents/:public_id/status  — operator sets a live doc's lifecycle status (active|deprecated; no version bump)
 *   POST   /admin/vectors/backfill             — operator backfills/reconciles the Vectorize index
 *   POST   /admin/links/backfill               — operator backfills the link graph from stored renders (issue #40)
 *   POST   /admin/docs/seed                   — operator seeds the bundled platform docs into the corpus (issue #4)
 *   GET    /admin/backup                       — operator streams one page of the corpus backup (NDJSON, cursor-paginated; issue #9)
 *   POST   /admin/restore                      — operator verifies/applies one backup page (identity re-asserted; H re-rendered from S)
 *   GET    /admin/links/orphans                — live docs nothing links to (link-graph curation view)
 *   POST   /admin/slugs/:slug/redirect         — point a retired slug at a live doc (loud redirect)
 *   DELETE /admin/slugs/:slug/redirect         — drop a retired slug's redirect (back to 410)
 *   DELETE /admin/slugs/:slug                  — force-release a retired slug (escape hatch)
 *
 * Write-path internals live in src/core.ts: HTTP and MCP both forward to
 * the same publish/update/read/revoke functions, so sanitization runs
 * exactly once regardless of door.
 *
 * The default export wraps this inner fetch with the OAuthProvider so
 * /mcp gains Door A and discovery/token endpoints are auto-served. The
 * inner handler is registered for BOTH apiHandler and defaultHandler;
 * the only difference is whether ctx.props.agentId is populated.
 *
 * Cross-origin (CORS) is a transport layer between the two — see the
 * default export at the bottom of this file and src/cors.ts. It answers
 * OPTIONS preflights and stamps the response headers a browser on another
 * origin needs; it is OFF unless CORS_ALLOWED_ORIGINS is set, and it never
 * emits Access-Control-Allow-Credentials. Every route added above must be
 * classified in `isCorsEligible` (default deny), so a new cookie/HTML
 * surface can't drift into the cross-origin API by accident.
 */

import {
  backfillLinks,
  backfillVectors,
  seedPlatformDocs,
  clearSlugRedirect,
  createDocumentAsOperator,
  curateDocumentStatus,
  curateDocumentTags,
  getDocument,
  listAgentKeys,
  listAgents,
  listAuditEvents,
  listDocuments,
  listDocumentsForReader,
  listDocumentVersions,
  listOrphanDocuments,
  loadContextPackForReader,
  mintAgent,
  mintAgentKey,
  promoteDocumentVersion,
  pruneKeys,
  releaseSlugTombstone,
  restoreDocumentVersion,
  revokeAgent,
  revokeKey,
  searchDocuments,
  searchDocumentsForReader,
  setDocumentSlug,
  setDocumentStatus,
  setDocumentTags,
  setDocumentVisibility,
  setSlugRedirect,
  updateDocumentAsOperator,
} from "./admin.js";
import { createOAuthClient, createUnboundOAuthClient, deleteOAuthClient } from "./admin-oauth.js";
import { appLinksConfig, buildAndroidAssetLinks, buildAppleAppSiteAssociation } from "./app-links.js";
import { recordAudit, requestIdOf, writeAuditEvent } from "./audit.js";
import { authenticateAgent } from "./auth.js";
import { exportBackup, restoreBackup } from "./backup.js";
import {
  handleConsoleBackfill,
  handleConsoleDeleteClient,
  handleConsoleLinksBackfill,
  handleConsoleMintAgent,
  handleConsoleMintBoundClient,
  handleConsoleMintKey,
  handleConsoleMintUnboundClient,
  handleConsoleKeysPrune,
  handleConsoleRestore,
  handleConsoleRevokeAgent,
  handleConsoleRevokeKey,
  serveConsoleAgentDetail,
  serveConsoleAgents,
  serveConsoleAudit,
  serveConsoleDashboard,
  serveConsoleDocuments,
  serveConsoleMaintenance,
} from "./console.js";
import { handleAuthorize } from "./authorize.js";
import { parseIfMatch } from "./conditional.js";
import type { ErrorCode } from "./contract.js";
import { corsAllowedOrigins, normalizeOrigin, resolveAllowedOrigin, withCors } from "./cors.js";
import { handleLogin, handleLogout } from "./login.js";
import { requireOperator } from "./session.js";
import {
  publishDocumentCore,
  revokeDocumentCore,
  type SourceFormat,
  storageCapBytes,
  updateDocumentCore,
} from "./core.js";
import type { Env } from "./env.js";
import { UUID_RE } from "./ids.js";
import { normalizeExpectedSha256, verifyContentIntegrity } from "./integrity.js";
import { handleMcp } from "./mcp.js";
import { parseToolsetParam } from "./mcp-toolset.js";
import type { AwhProps } from "./mcp-auth.js";
import { buildOpenApiDocument } from "./openapi.js";
import { formatSlugReject, parseMetadataHeaders } from "./metadata.js";
import { DCR_REGISTRATION_ENDPOINT, TOKEN_ENDPOINT, wrapWithOAuth } from "./oauth.js";
import { sanitizerVersion } from "./sanitizer.js";
import { toRevokeResponse, toWriteResponse } from "./wire.js";
import {
  handleRevokeForm,
  handlePromoteForm,
  handleRestoreForm,
  handleSlugForm,
  handleStatusForm,
  handleTagsForm,
  handleVisibilityForm,
  serveManagePage,
  serveRevokeConfirm,
} from "./manage.js";
import {
  API_DISCOVERY_HINT,
  idShapeHint,
  SERVICE_DESC_LINK,
  serveBySlug,
  serveDocument,
  serveHomepage,
  serveRaw,
  serveShellScript,
  serveLinks,
  serveSource,
  serveText,
  serveTextBySlug,
  serveVersionRaw,
  serveVersionShell,
} from "./serve.js";
import {
  servePlatformDoc,
  servePlatformDocRaw,
  servePlatformDocsIndex,
} from "./platform-docs.js";
import { maybeSeedPlatformDocs } from "./seed-docs.js";

export type { Env };

const innerHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const route = `${method} ${path}`;
    // Threaded into every handler that files an audit-ledger row (migration
    // 0020): the write rides the request's lifetime instead of the response
    // path. Handlers take it as an OPTIONAL trailing parameter, so a call site
    // that has no ExecutionContext still compiles — it just loses the row,
    // which the ledger's best-effort contract permits (src/audit.ts).
    const waitUntil = ctx.waitUntil.bind(ctx);
    try {
      // Static routes — cheap exact-match dispatch.
      if (method === "GET" && path === "/") return await serveHomepage(env, url.origin);
      if (method === "GET" && path === "/healthz") {
        // The Origin header rides along so the CORS block can answer the one
        // question a browser client actually has ("is MY origin allowed?")
        // without publishing the whole allowlist. See hello().
        return await hello(env, url.origin, request.headers.get("origin"));
      }
      // Public OpenAPI 3.1 spec, generated from src/contract.ts (Phase 2 of
      // docs/design/api-contract-design.md). The committed openapi.json is the CI freshness
      // target; this route assembles the same doc on demand so a consumer's
      // codegen can point straight at production. The request origin is baked
      // into `servers` so dev/staging codegen targets the right host.
      if (method === "GET" && path === "/openapi.json") {
        return Response.json(buildOpenApiDocument(url.origin));
      }
      // Toolbar enhancement script for the document shell. Static, public,
      // cacheable; loaded under the shell's `script-src 'self'`. See serve.ts.
      if (method === "GET" && path === "/shell.js") return serveShellScript();

      // App Links / Universal Links verification (issue #50): lets the
      // operator's mobile app register as the in-app handler for /d/… and
      // /s/… links instead of always opening a browser tab. Anonymous, no DB
      // read — off unless the operator has configured the matching [var]s
      // (see appLinksConfig in src/app-links.ts). Unset/malformed answers the
      // exact same opaque 404 the catch-all serves for any unmatched route,
      // so a fresh fork is byte-identical to one built before this shipped.
      if (method === "GET" && path === "/.well-known/assetlinks.json") {
        return serveAndroidAssetLinks(env);
      }
      if (method === "GET" && path === "/.well-known/apple-app-site-association") {
        return serveAppleAppSiteAssociation(env);
      }

      // Bundled platform documentation (issue #4). Static, public, anonymous —
      // the bytes are build output, identical for every caller, so there is no
      // auth check here and none belongs. Exact-match on the index, then the
      // `/docs/<name>` + `/docs/<name>/raw` pair; an unknown name 404s because
      // it names a route absent from THIS build, which the index already
      // discloses. Sits ahead of nothing it could shadow: no other route root
      // begins `/docs`.
      // The "/docs" LITERAL is deliberate, not a missed use of
      // PLATFORM_DOCS_PREFIX: test/openapi.test.mjs scans this file for
      // `path === "<literal>"` and asserts each one is in the OpenAPI registry.
      // Writing the constant here would quietly opt the route out of that gate.
      // The copy is pinned against the canonical constant by test/cors.test.mjs.
      if (method === "GET" && path === "/docs") return servePlatformDocsIndex();
      if (method === "GET" && path.startsWith("/docs/")) {
        const rest = path.slice("/docs/".length);
        if (rest.endsWith("/raw")) return servePlatformDocRaw(rest.slice(0, -"/raw".length), request);
        if (!rest.includes("/")) return servePlatformDoc(rest, request);
      }
      if (method === "POST" && path === "/d") return await createDocument(request, env, ctx);

      // Agent-reachable document discovery — the HTTP twins of the MCP
      // list_documents / search_documents tools (same cores), gated by
      // requireReader (agent key OR operator, never anonymous) rather than the
      // operator-only /admin/documents surface. `GET /d?slug=…` is also the
      // slug → public_id lookup a headless agent needs to address the id-only
      // PUT /d/:id, /source, and /links routes. Exact-path matches, so they sit
      // ahead of the `/d/:public_id` dispatch below ("search" is never a 22-char
      // public_id, but order keeps it unambiguous).
      if (method === "GET" && path === "/d") return await listDocumentsForReader(request, env);
      if (method === "GET" && path === "/d/search") {
        return await searchDocumentsForReader(request, env);
      }
      if (method === "GET" && path === "/d/pack") {
        return await loadContextPackForReader(request, env);
      }

      // Streamable HTTP MCP. The OAuthProvider wrap intercepts every
      // /mcp request, validates the token (either as an internal OAuth
      // grant from OAUTH_KV or via the resolveExternalToken callback
      // that handles awh_ bearers), populates ctx.props, then calls us
      // as apiHandler. Invalid-token and no-token requests are 401'd by
      // the provider itself — we only see authorized requests here.
      if (path === "/mcp") {
        const props = (ctx as ExecutionContext & { props?: AwhProps }).props;
        // Gate on `agentId` ONLY. props.clientId (migration 0019 / issue #63)
        // is attribution, and null is a legal, expected value on Door B (a
        // static awh_ bearer has no OAuth client) — checking it here would 500
        // every curl-shaped MCP call.
        if (!props?.agentId) {
          // Belt-and-suspenders: unreachable in the OAuthProvider apiHandler
          // contract. If we ever see this, the wrap upstream broke.
          console.error("apiHandler /mcp without props");
          // Recorded even though it should be impossible: an authorized-looking
          // /mcp request arriving with no identity is exactly the shape of a
          // broken (or defeated) auth wrap, and the ledger is where an operator
          // would go looking. The ordinary rejected-token case is caught one
          // layer out, in withAudit — the provider 401s it before dispatch runs.
          recordAudit(env, waitUntil, {
            kind: "mcp_auth_failed",
            principal_kind: "anonymous",
            reason: "missing_props",
            request_id: requestIdOf(request),
          });
          return jsonError(500, "internal", "apiHandler invoked without props");
        }
        // Derived-index upkeep, latched to once per isolate and scheduled off
        // the response path: make sure the docs an MCP tool description tells
        // an agent to read actually exist in the corpus on THIS instance.
        // See src/seed-docs.ts — never load-bearing, /docs/<name> serves either
        // way.
        maybeSeedPlatformDocs(env, url.origin, ctx.waitUntil.bind(ctx));
        // Optional toolset gating (issue #59): `?tools=a,b` narrows tools/list
        // and tools/call to that subset for this connection; absent = all
        // eleven. Rejected HERE, before the MCP transport, so a typo in a
        // host's configured URL fails at connect time with a message naming
        // the bad name — a silently narrowed toolset would surface months
        // later as "Slopcafe can't do X". It is a context-budget preference,
        // never an authorization boundary: the credential's authority is
        // unchanged (src/mcp-toolset.ts).
        const toolset = parseToolsetParam(url.searchParams.get("tools"));
        if (!toolset.ok) {
          return jsonError(400, "bad_request", toolset.message);
        }
        return await handleMcp(request, env, ctx, props, toolset.allow);
      }

      // Consent UI for Door A. The OAuthProvider routes /authorize to
      // defaultHandler (us); /token and /.well-known/oauth-authorization-server
      // and /.well-known/oauth-protected-resource it serves itself.
      if (path === "/authorize") return await handleAuthorize(request, env, waitUntil);

      // Operator browser session (a second door onto the same operator check;
      // see src/session.ts). Reaches us via defaultHandler — the OAuth wrap
      // only intercepts /mcp + /authorize + /token + /.well-known/oauth-authorization-server
      // and /.well-known/oauth-protected-resource.
      if (path === "/login") return await handleLogin(request, env, waitUntil);
      if (path === "/logout") return await handleLogout(request, env);

      // Admin surface (operator-auth on every handler).
      if (path === "/admin/agents") {
        if (method === "GET") return await listAgents(request, env);
        if (method === "POST") return await mintAgent(request, env, waitUntil);
      }
      if (path === "/admin/documents" && method === "GET") {
        return await listDocuments(request, env);
      }
      // GET /admin/audit — the append-only operator ledger (migration 0020 /
      // issue #62). Operator-only, cursor-paginated newest-first. Exact-path
      // match, ahead of nothing it could shadow.
      if (path === "/admin/audit" && method === "GET") {
        return await listAuditEvents(request, env);
      }
      // POST /admin/documents — operator AUTHORS a new document (migration 0013;
      // the operator's own write door, JSON body). Exact-path match, so it never
      // collides with the GET list above or the /:id PUT below.
      if (path === "/admin/documents" && method === "POST") {
        return await createDocumentAsOperator(request, env, ctx);
      }
      if (path === "/admin/documents/search" && method === "GET") {
        return await searchDocuments(request, env);
      }
      // POST /admin/vectors/backfill — operator-invoked Vectorize backfill /
      // reconciliation (docs/design/vector-search-design.md §8). Exact-path match.
      // POST /admin/docs/seed — operator-invoked platform-documentation seed
      // pass (issue #4). Also runs automatically off /mcp; this is the "now,
      // and tell me what happened" lever. Exact-path match.
      if (path === "/admin/docs/seed" && method === "POST") {
        return await seedPlatformDocs(request, env, ctx);
      }
      if (path === "/admin/vectors/backfill" && method === "POST") {
        return await backfillVectors(request, env);
      }
      // POST /admin/links/backfill — operator-invoked link-graph backfill
      // (migration 0016 / issue #40): re-extract document_links from stored H.
      if (path === "/admin/links/backfill" && method === "POST") {
        return await backfillLinks(request, env);
      }
      // GET /admin/backup — one page of the corpus backup (issue #9), streamed
      // NDJSON with every live version's blobs inline; POST /admin/restore —
      // verify (default) or apply one page, re-asserting recorded identity and
      // re-rendering every live version from its source (src/backup.ts). Both
      // exact-path, both operator-only; no agent door exists or may be added.
      if (path === "/admin/backup" && method === "GET") {
        return await exportBackup(request, env);
      }
      if (path === "/admin/restore" && method === "POST") {
        return await restoreBackup(request, env, ctx);
      }
      // GET /admin/links/orphans — live docs nothing (live) links to (issue #40).
      if (path === "/admin/links/orphans" && method === "GET") {
        return await listOrphanDocuments(request, env);
      }
      // PUT /admin/documents/:public_id — operator updates a document (new
      // version authored by the operator principal). The public_id charset has
      // no '/', so an exact "no further slash" check distinguishes this from the
      // POST /visibility|/slug|/tags suffix routes below (which are POST anyway).
      if (
        path.startsWith("/admin/documents/") &&
        method === "PUT" &&
        !path.slice("/admin/documents/".length).includes("/")
      ) {
        const publicId = path.slice("/admin/documents/".length);
        return await updateDocumentAsOperator(publicId, request, env, ctx);
      }
      // GET /admin/documents/:public_id — operator single-document read (one
      // DocumentListing row, revoked rows included, like the list above).
      //
      // THE `!== "search"` TERM IS LOAD-BEARING, not belt-and-braces: unlike the
      // PUT twin above — which is safe purely because its method differs —
      // `/admin/documents/search` is itself a GET whose remainder contains no
      // slash, so it satisfies this predicate exactly. Statement order (the
      // exact-match search route runs earlier) is what saves it today, and
      // ordering is not a property anyone maintains. Without this term, someone
      // regrouping the admin block turns operator search into a confidently
      // wrong 404 that says "search" is not a 22-character public_id — and no
      // test catches it, because the openapi route scan never executes dispatch.
      if (
        path.startsWith("/admin/documents/") &&
        method === "GET" &&
        !path.slice("/admin/documents/".length).includes("/") &&
        path.slice("/admin/documents/".length) !== "search"
      ) {
        const publicId = path.slice("/admin/documents/".length);
        return await getDocument(publicId, request, env);
      }
      // POST /admin/documents/:public_id/visibility — operator sets a live doc
      // public/private (migration 0011). The `/visibility` suffix disambiguates
      // from the list/search routes above; public_id charset has no '/'.
      if (path.startsWith("/admin/documents/") && path.endsWith("/visibility") && method === "POST") {
        const publicId = path.slice("/admin/documents/".length, -"/visibility".length);
        return await setDocumentVisibility(publicId, request, env, waitUntil);
      }
      // POST /admin/documents/:public_id/promote — operator picks WHICH version a
      // document publishes (migration 0018). The visibility flip above opens the
      // door; this chooses the bytes behind it — a PUBLIC doc's byte path serves
      // published_ver while every machine surface stays on current_ver. Same
      // suffix-disambiguation trick as /visibility.
      if (path.startsWith("/admin/documents/") && path.endsWith("/promote") && method === "POST") {
        const publicId = path.slice("/admin/documents/".length, -"/promote".length);
        return await promoteDocumentVersion(publicId, request, env, waitUntil);
      }
      // POST /admin/documents/:public_id/slug — operator add/rename/clear a live
      // doc's slug (no version bump; rename auto-forwards the old name). Same
      // suffix-disambiguation trick as /visibility above.
      if (path.startsWith("/admin/documents/") && path.endsWith("/slug") && method === "POST") {
        const publicId = path.slice("/admin/documents/".length, -"/slug".length);
        return await setDocumentSlug(publicId, request, env);
      }
      // POST /admin/documents/:public_id/tags — operator replaces a live doc's
      // tags (no version bump; document-level since migration 0012). Same
      // suffix-disambiguation trick as /visibility and /slug above.
      if (path.startsWith("/admin/documents/") && path.endsWith("/tags") && method === "POST") {
        const publicId = path.slice("/admin/documents/".length, -"/tags".length);
        return await setDocumentTags(publicId, request, env);
      }
      // POST /admin/documents/:public_id/status — operator sets a live doc's
      // lifecycle status (migration 0014; active|deprecated, optional
      // superseded_by pointer). Same suffix-disambiguation trick as above.
      if (path.startsWith("/admin/documents/") && path.endsWith("/status") && method === "POST") {
        const publicId = path.slice("/admin/documents/".length, -"/status".length);
        return await setDocumentStatus(publicId, request, env);
      }
      // GET /admin/documents/:public_id/versions — the JSON twin of the manage
      // page's version-history table, and POST .../restore the twin of its
      // Restore button. Version history was HTML-form-only, so a scripted
      // operator client (the Flutter app) had to scrape a page to offer a
      // first-class operator feature; every other operator document mutator
      // already has a JSON twin here. Same suffix-disambiguation trick as above.
      if (path.startsWith("/admin/documents/") && path.endsWith("/versions") && method === "GET") {
        const publicId = path.slice("/admin/documents/".length, -"/versions".length);
        return await listDocumentVersions(publicId, request, env);
      }
      if (path.startsWith("/admin/documents/") && path.endsWith("/restore") && method === "POST") {
        const publicId = path.slice("/admin/documents/".length, -"/restore".length);
        return await restoreDocumentVersion(publicId, request, env, ctx);
      }
      if (path.startsWith("/admin/agents/")) {
        const rest = path.slice("/admin/agents/".length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          // /admin/agents/:id — Step 9's cascade kill.
          if (method === "DELETE") return await revokeAgent(rest, request, env, waitUntil);
        } else {
          const agentId = rest.slice(0, slash);
          const sub = rest.slice(slash);
          if (sub === "/keys") {
            if (method === "GET") return await listAgentKeys(agentId, request, env);
            if (method === "POST") return await mintAgentKey(agentId, request, env, waitUntil);
          }
          if (sub === "/oauth-clients" && method === "POST") {
            return await createOAuthClient(agentId, request, env, waitUntil);
          }
        }
      }
      if (path.startsWith("/admin/keys/") && method === "DELETE") {
        const keyId = path.slice("/admin/keys/".length);
        return await revokeKey(keyId, request, env, waitUntil);
      }
      // POST /admin/keys/prune — hard-delete expired/long-revoked agent_keys
      // rows (issue #13). Exact-path match, ahead of nothing it could collide
      // with: the DELETE twin above is scoped to a different method, and
      // "prune" can never be mistaken for a UUID key id.
      if (path === "/admin/keys/prune" && method === "POST") {
        return await pruneKeys(request, env, waitUntil);
      }
      if (path === "/admin/oauth-clients" && method === "POST") {
        return await createUnboundOAuthClient(request, env, waitUntil);
      }
      if (path.startsWith("/admin/oauth-clients/") && method === "DELETE") {
        const clientId = path.slice("/admin/oauth-clients/".length);
        return await deleteOAuthClient(clientId, request, env, waitUntil);
      }
      // Operator console — the server-rendered (no-JS) admin UI (src/console.ts).
      // It is a thin HTML skin over the SAME *Core functions the JSON admin
      // handlers above call; the namespace is /admin/console/*. GET pages
      // self-gate on a *cookie* session (sign-in card, no DB hit, when absent);
      // POST handlers self-authorize via the form-field CSRF ladder
      // (authorizeOperatorForm) — so, unlike the JSON admin routes, we do NOT
      // pre-wrap them in requireOperator (which wants an X-CSRF-Token header a
      // no-JS form can't send). Every console handler parses its own formData().
      //
      // Bare GET /admin redirects to the dashboard so an operator can type the
      // short path. Exact-match before the /admin/console prefix checks.
      if (method === "GET" && path === "/admin") {
        return new Response(null, { status: 302, headers: { location: "/admin/console" } });
      }
      if (path === "/admin/console") {
        if (method === "GET") return await serveConsoleDashboard(request, env);
      }
      if (path.startsWith("/admin/console/")) {
        // Sub-dispatch the console tail. Match the literal fixed paths
        // (agents/revoke, keys/revoke, keys/prune, restore, oauth-clients[/delete],
        // vectors/backfill, links/backfill, documents, maintenance, the bare
        // "agents") BEFORE the parametric
        // /agents/:id forms, so e.g. "agents/revoke" is never parsed as an agent
        // id of "revoke". The :id segment is UUID-shape-validated before it
        // reaches a handler that interpolates it into an href (the cores re-check
        // too, but this yields a clean 404 rather than leaning on a core).
        const sub = path.slice("/admin/console/".length);
        if (sub === "agents") {
          if (method === "GET") return await serveConsoleAgents(request, env);
          if (method === "POST") return await handleConsoleMintAgent(request, env, waitUntil);
        } else if (sub === "agents/revoke") {
          if (method === "POST") return await handleConsoleRevokeAgent(request, env, waitUntil);
        } else if (sub === "keys/revoke") {
          if (method === "POST") return await handleConsoleRevokeKey(request, env, waitUntil);
        } else if (sub === "oauth-clients") {
          if (method === "POST") return await handleConsoleMintUnboundClient(request, env, waitUntil);
        } else if (sub === "oauth-clients/delete") {
          if (method === "POST") return await handleConsoleDeleteClient(request, env, waitUntil);
        } else if (sub === "documents") {
          if (method === "GET") return await serveConsoleDocuments(request, env);
        } else if (sub === "audit") {
          if (method === "GET") return await serveConsoleAudit(request, env);
        } else if (sub === "maintenance") {
          if (method === "GET") return await serveConsoleMaintenance(request, env);
        } else if (sub === "vectors/backfill") {
          if (method === "POST") return await handleConsoleBackfill(request, env);
        } else if (sub === "links/backfill") {
          if (method === "POST") return await handleConsoleLinksBackfill(request, env);
        } else if (sub === "keys/prune") {
          if (method === "POST") return await handleConsoleKeysPrune(request, env, waitUntil);
        } else if (sub === "restore") {
          // multipart upload of one backup page → the same restore core as
          // POST /admin/restore (issue #9).
          if (method === "POST") return await handleConsoleRestore(request, env, ctx);
        } else if (sub.startsWith("agents/")) {
          // Parametric: /agents/:id  and  /agents/:id/{keys,oauth-clients}.
          const rest = sub.slice("agents/".length);
          const slash = rest.indexOf("/");
          if (slash === -1) {
            // /admin/console/agents/:id — the agent detail page (GET only).
            if (method === "GET" && UUID_RE.test(rest)) {
              return await serveConsoleAgentDetail(rest, request, env);
            }
          } else {
            const agentId = rest.slice(0, slash);
            const tail = rest.slice(slash);
            if (UUID_RE.test(agentId)) {
              if (tail === "/keys" && method === "POST") {
                return await handleConsoleMintKey(agentId, request, env, waitUntil);
              }
              if (tail === "/oauth-clients" && method === "POST") {
                return await handleConsoleMintBoundClient(agentId, request, env, waitUntil);
              }
            }
          }
        }
        // Any unmatched method/path under /admin/console/* falls through to the
        // generic 404 below — mirroring how the /d/ block leaves its misses to
        // the catch-all.
      }

      if (path.startsWith("/admin/slugs/")) {
        // Operator slug-tombstone surface (migration 0010). The slug charset has
        // no "/", so the `/redirect` suffix disambiguates cleanly:
        //   POST   /admin/slugs/:slug/redirect → set a redirect target
        //   DELETE /admin/slugs/:slug/redirect → clear the redirect (back to 410)
        //   DELETE /admin/slugs/:slug          → force-release (un-retire)
        const rest = path.slice("/admin/slugs/".length);
        if (rest.endsWith("/redirect")) {
          const slug = rest.slice(0, -"/redirect".length);
          if (method === "POST") return await setSlugRedirect(slug, request, env, waitUntil);
          if (method === "DELETE") return await clearSlugRedirect(slug, request, env, waitUntil);
        } else if (rest.indexOf("/") === -1) {
          if (method === "DELETE") return await releaseSlugTombstone(rest, request, env, waitUntil);
        }
      }

      // Slug surface: the slug-addressed twin of the /d/:public_id surface.
      //   GET /s/:slug       → content-negotiates exactly like /d/:public_id —
      //                        no auth serves the shell directly (keeps the
      //                        pretty slug in the address bar; no redirect),
      //                        a valid agent key returns the raw bytes.
      //   GET /s/:slug/text  → Markdown derivation, twin of /d/:public_id/text;
      //                        agent-key-gated (both /text endpoints are — they're
      //                        agent ingestion channels, not public). On the slug
      //                        surface only the no-auth shell at /s/:slug is public.
      // The slug is a deliberate, lower-entropy lookup handle — opt-in
      // discoverability and the cross-document link target (see
      // skills/publishing.md + SOLO spec §3-4), distinct from the unguessable
      // public_id. It lives in its own /s/ namespace, clear of the public_id
      // space (whose base64url charset overlaps the slug charset). Slug charset
      // excludes '/', so we split on the first '/' to peel off the sub-path;
      // an unrecognized sub-path falls through to the 404 below.
      if (path.startsWith("/s/")) {
        const tail = path.slice(3);
        const slash = tail.indexOf("/");
        if (slash === -1) {
          if (method === "GET") return await serveBySlug(tail, request, env);
        } else if (method === "GET" && tail.slice(slash) === "/text") {
          return await serveTextBySlug(tail.slice(0, slash), request, env);
        }
      }

      // Dynamic /d/:public_id and /d/:public_id/{raw,text,revoke}.
      if (path.startsWith("/d/")) {
        const tail = path.slice(3);
        const slash = tail.indexOf("/");
        if (slash === -1) {
          if (method === "GET") return await serveDocument(tail, request, env);
          if (method === "PUT") return await updateDocument(tail, request, env, ctx);
          if (method === "DELETE") return await revokeDocument(tail, request, env, ctx);
        } else if (method === "GET" && tail.slice(slash) === "/raw") {
          return await serveRaw(tail.slice(0, slash), request, env);
        } else if (method === "GET" && tail.slice(slash).startsWith("/v/")) {
          // Operator-only version history: /d/:id/v/:n (shell) and
          // /d/:id/v/:n/raw (bytes). Parse :n as a positive integer; an invalid
          // version number falls through to the generic 404 below.
          const id = tail.slice(0, slash);
          const rest = tail.slice(slash + "/v/".length);
          const isRaw = rest.endsWith("/raw");
          const verStr = isRaw ? rest.slice(0, -"/raw".length) : rest;
          if (/^[1-9][0-9]*$/.test(verStr)) {
            const versionNo = Number(verStr);
            return isRaw
              ? await serveVersionRaw(id, versionNo, request, env)
              : await serveVersionShell(id, versionNo, request, env, url.origin);
          }
        } else if (method === "GET" && tail.slice(slash) === "/text") {
          return await serveText(tail.slice(0, slash), request, env);
        } else if (method === "GET" && tail.slice(slash) === "/source") {
          return await serveSource(tail.slice(0, slash), request, env);
        } else if (method === "GET" && tail.slice(slash) === "/links") {
          // Link-graph neighborhood: backlinks + outbound link health
          // (migration 0016 / issue #40). Credentialed like /text + /source.
          return await serveLinks(tail.slice(0, slash), request, env);
        } else if (method === "PUT" && tail.slice(slash) === "/tags") {
          // The AGENT-reachable classification writes (JSON), deliberately PUT
          // rather than POST: POST on these two paths is already taken by the
          // manage page's HTML forms (handleTagsForm / handleStatusForm), and
          // PUT is the honest verb anyway — both are full replacements of a
          // subresource, not appends. See curateDocumentTags in admin.ts for
          // why the agent door may set these two and NOT visibility.
          return await curateDocumentTags(tail.slice(0, slash), request, env);
        } else if (method === "PUT" && tail.slice(slash) === "/status") {
          return await curateDocumentStatus(tail.slice(0, slash), request, env);
        } else if (method === "GET" && tail.slice(slash) === "/manage") {
          // Operator-only document-management page (visibility toggle, slug
          // editor, revoke). Reached from the shell topbar's "Manage…" item.
          return await serveManagePage(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/visibility") {
          return await handleVisibilityForm(tail.slice(0, slash), request, env, waitUntil);
        } else if (method === "POST" && tail.slice(slash) === "/slug") {
          return await handleSlugForm(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/tags") {
          return await handleTagsForm(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/status") {
          return await handleStatusForm(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/promote") {
          // Operator promotes a version to `published_ver` (migration 0018 /
          // issue #43) — the manage page's Publish button. The JSON twin is
          // POST /admin/documents/:id/promote. Deliberately has NO agent-door
          // counterpart the way /tags and /status do: promotion is the verb that
          // expands what the anonymous internet can read, so it sits with
          // visibility and revoke, not with classification.
          return await handlePromoteForm(tail.slice(0, slash), request, env, waitUntil);
        } else if (method === "POST" && tail.slice(slash) === "/restore") {
          return await handleRestoreForm(tail.slice(0, slash), request, env, ctx);
        } else if (method === "GET" && tail.slice(slash) === "/revoke") {
          return await serveRevokeConfirm(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/revoke") {
          return await handleRevokeForm(tail.slice(0, slash), request, env, ctx);
        }
      }

      // The catch-all. An agent that was handed a base URL and a key and is
      // probing (/api, /v1, /docs, …) lands HERE more often than anywhere else,
      // so it is the highest-leverage place in the Worker to say where the
      // routes are written down. The `service-desc` Link header rides along via
      // jsonError.
      return jsonError(404, "not_found", `no such route${API_DISCOVERY_HINT}`);
    } catch (err) {
      // Top-level guard so an unexpected throw becomes a 500 we can grep
      // for in `wrangler tail` instead of a generic 1101.
      console.error("unhandled", route, err);
      return jsonError(500, "internal", "unexpected error");
    }
  },
};

/**
 * HEAD is "GET without a response body." Re-issue a HEAD as a GET so it runs the
 * same dispatch and inherits the GET's status + headers (content-type, `ETag`,
 * CSP, …), then drop the body. Without this, a HEAD matches no `method === "GET"`
 * route and falls through to the JSON `404` — so `curl -I /d/:id/raw` reports
 * `application/json` instead of the document's real `text/html` (GitHub issue
 * #36). The re-issued GET carries the original headers (Authorization, cookies),
 * so the visibility/auth gates and the `If-None-Match` → `304` path behave
 * identically; the body strip is belt-and-suspenders (the runtime also drops
 * HEAD bodies). Wrapped INSIDE the OAuth provider so it covers every inner route
 * (the provider's own `/token` + discovery endpoints are POST/own-served).
 */
function withHeadSupport(inner: ExportedHandler<Env>): ExportedHandler<Env> {
  return {
    async fetch(
      request: Request<unknown, IncomingRequestCfProperties>,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      if (request.method !== "HEAD") return inner.fetch!(request, env, ctx);
      // `new Request` types as the constructed-request `cf` variant; cast back to
      // the incoming-request shape the handler signature expects (cf is carried
      // through unchanged at runtime).
      const asGet = new Request(request, {
        method: "GET",
      }) as unknown as Request<unknown, IncomingRequestCfProperties>;
      const res = await inner.fetch!(asGet, env, ctx);
      return res.body === null
        ? res
        : new Response(null, { status: res.status, headers: res.headers });
    },
  };
}

/**
 * The wrapper stack, outermost first: audit → OAuth provider → CORS → HEAD →
 * routes.
 *
 * `withAudit` is OUTSIDE the provider and is observe-only — it is the only
 * layer that can see `/register` and `/token`, which the provider answers
 * itself. It changes no response; see its own docblock below.
 *
 * `wrapWithOAuth` must be the outermost SECURITY layer — it owns `/mcp`, `/token`, `/register`,
 * `/.well-known/oauth-authorization-server`, and `/.well-known/oauth-protected-resource`,
 * and never delegates them, so nothing inside it can see those requests.
 *
 * `withCors` sits INSIDE it, deliberately. The provider already applies its own
 * CORS pass to the four endpoints it answers (reflecting the request `Origin`;
 * notably NOT setting `Allow-Credentials`), and a second layer writing
 * `Access-Control-Allow-Origin` on the same response is a duplicated header,
 * which browsers reject outright. Inside the provider, `withCors` sees exactly
 * the `defaultHandler` surface — every route this file dispatches — which is
 * precisely the set our allowlist can actually govern. `/mcp` is correspondingly
 * NOT eligible in `isCorsEligible`: claiming an allowlist we cannot enforce
 * would be worse than the honest omission.
 *
 * `withHeadSupport` is innermost so CORS is the outermost of *our* layers and
 * stamps the final response for every route, including the body-stripped `HEAD`
 * answers that layer synthesizes from a re-issued `GET`.
 */
/**
 * The observe-only audit layer — the OUTERMOST wrapper, and the only one that
 * exists purely to watch (migration 0020 / issue #62).
 *
 * It is outside `wrapWithOAuth` because that is the only place these events are
 * visible. The provider ANSWERS `/register` and `/token` itself and never
 * delegates them, so nothing inside the wrap — not `withCors`, not
 * `innerHandler` — ever sees a DCR self-registration or a token exchange. A DCR
 * registration writes no `oauth_clients` row either (a self-registered client is
 * deliberately unbound until consent), so before this layer existed, "anyone may
 * register a client against this deployment" left NO durable trace anywhere.
 *
 * OBSERVE-ONLY is a hard contract, and the reason this can sit outside the
 * security stack safely:
 *
 *   - it never modifies, replaces or delays a response — the inner response
 *     object is returned unchanged, and the only body access is on a `clone()`;
 *   - it never rejects, redirects or short-circuits a request;
 *   - it reads only the response STATUS and, for a successful registration, the
 *     `client_id` out of the cloned body. Never `client_secret`, never the
 *     request body, never an Authorization header — and `recordAudit`'s typed
 *     union has no field that could carry one anyway (see src/audit.ts);
 *   - every write rides `ctx.waitUntil`, so the response is not held up.
 *
 * The `/mcp` 401 case is here rather than in the dispatch below for the same
 * structural reason: an invalid or absent token is refused by the PROVIDER, so
 * the dispatch never runs. (The dispatch's own `mcp_auth_failed` covers the
 * different, should-be-impossible case where the provider hands us a request
 * with no identity at all.) Both are auth FAILURES only — a successful tool call
 * is traffic, not an event, and stays out of the ledger.
 */
function withAudit(inner: ExportedHandler<Env>): ExportedHandler<Env> {
  return {
    async fetch(
      request: Request<unknown, IncomingRequestCfProperties>,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const res = await inner.fetch!(request, env, ctx);
      // Cheap precondition before parsing anything: the only events this layer
      // can file come from a POST (the two provider-answered endpoints) or from
      // a 401. That skips the URL allocation for the entire document read path,
      // which is every GET this Worker serves.
      if (request.method !== "POST" && res.status !== 401) return res;

      const path = new URL(request.url).pathname;
      const waitUntil = ctx.waitUntil.bind(ctx);
      const request_id = requestIdOf(request);

      if (request.method === "POST" && path === DCR_REGISTRATION_ENDPOINT) {
        if (res.status >= 200 && res.status < 300) {
          // The clone is read inside waitUntil so the response goes out
          // immediately; the original stream is untouched. `writeAuditEvent`
          // (not `recordAudit`) so the read and the INSERT ride ONE waitUntil
          // rather than scheduling a second from inside the first. A body we
          // cannot parse still gets a row — a registration happened, and losing
          // the event is worse than losing the id.
          waitUntil(
            res
              .clone()
              .json()
              .then((body: unknown) => clientIdOf(body))
              .catch(() => undefined)
              .then((client_id) =>
                writeAuditEvent(env, {
                  kind: "client_registered",
                  principal_kind: "anonymous",
                  client_id,
                  request_id,
                }),
              ),
          );
        }
        return res;
      }

      if (request.method === "POST" && path === TOKEN_ENDPOINT) {
        const issued = res.status >= 200 && res.status < 300;
        recordAudit(
          env,
          waitUntil,
          issued
            ? { kind: "token_issued", principal_kind: "anonymous", status: res.status, request_id }
            : { kind: "token_denied", principal_kind: "anonymous", status: res.status, request_id },
        );
        return res;
      }

      if (path === "/mcp" && res.status === 401) {
        recordAudit(env, waitUntil, {
          kind: "mcp_auth_failed",
          principal_kind: "anonymous",
          reason: "token_rejected",
          request_id,
        });
      }
      return res;
    },
  };
}

/**
 * Pull `client_id` out of a DCR registration response body, or undefined.
 * Reads exactly that one field — `client_secret` sits beside it in the same
 * object and must never be touched.
 */
function clientIdOf(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const id = (body as { client_id?: unknown }).client_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

export default withAudit(wrapWithOAuth(withCors(withHeadSupport(innerHandler))));

// -- helpers ------------------------------------------------------------------

/**
 * The agent-door JSON error envelope. `code` is typed against the canonical
 * `ErrorCode` enum in src/contract.ts, so a typo'd or unlisted code is a
 * compile error rather than a wire surprise.
 *
 * Every error carries the `service-desc` Link header pointing at
 * `/openapi.json` (see SERVICE_DESC_LINK in serve.ts). It costs one header and
 * makes every failed request self-teaching: a client that only ever gets a 401
 * or a 404 still learns where the machine-readable contract lives.
 */
function jsonError(
  status: number,
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: code, message, ...extra },
    { status, headers: { link: SERVICE_DESC_LINK } },
  );
}

/**
 * Read the request body, optionally verifying it against an `X-Content-SHA256`
 * integrity header before decoding to text. Shared by POST /d and PUT /d/:id.
 *
 * The hash is checked against the RAW received bytes (from arrayBuffer), not
 * `req.text()` re-encoded — so it's genuinely byte-exact even if the body
 * isn't well-formed UTF-8. The check runs before sanitization: it verifies
 * the wire ("what I sent arrived intact"), independent of any sanitizer
 * transformation the `modified` flag later reports. See src/integrity.ts.
 *
 * Returns the decoded body on success, or a ready-to-send error Response:
 *   400 bad_integrity_header  — header present but not 64-hex (± `sha256:`)
 *   422 integrity_mismatch    — body hash ≠ expected (truncated / altered)
 */
async function readVerifiedBody(
  req: Request,
): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  const expected = normalizeExpectedSha256(req.headers.get("x-content-sha256"));
  if (!expected.ok) {
    return {
      ok: false,
      response: jsonError(
        400,
        "bad_integrity_header",
        'X-Content-SHA256 must be 64 lowercase hex characters (an optional "sha256:" prefix is allowed)',
      ),
    };
  }

  const raw = new Uint8Array(await req.arrayBuffer());
  const verdict = await verifyContentIntegrity(raw, expected.value);
  if (!verdict.ok) {
    return {
      ok: false,
      response: jsonError(
        422,
        "integrity_mismatch",
        `received ${verdict.received_bytes} bytes hashing to ${verdict.actual}, but ` +
          `X-Content-SHA256 expected ${verdict.expected} — the body was truncated or ` +
          `altered in transit; resend the full document`,
        {
          expected_sha256: verdict.expected,
          actual_sha256: verdict.actual,
          received_bytes: verdict.received_bytes,
        },
      ),
    };
  }

  return { ok: true, body: new TextDecoder().decode(raw) };
}

// -- routes -------------------------------------------------------------------

/**
 * Route of the bundled HTTP quickstart (docs/http-api-quickstart.md — the
 * five-minute on-ramp). Named here so `/healthz` can point an agent at prose as
 * well as at the spec: `/openapi.json` says what the routes ARE, the quickstart
 * says which four to use first.
 *
 * NO LONGER INSTANCE-SPECIFIC (issue #4). This used to be a slug naming a
 * document in one operator's corpus, which meant the discovery document — the
 * thing an agent probes precisely because it knows nothing yet — could
 * confidently advertise a 404 on any deployment that had not run a publish
 * script. It is now a route served by this Worker from its own build, so it
 * resolves on every instance including a fresh fork with an empty database.
 */
const QUICKSTART_PATH = "/docs/http-api-quickstart";

/**
 * Health smoke: confirms bindings reach both stores and the migration ran.
 * Cheap enough to leave public; D1 returns counts of empty tables for a new
 * deploy, so no information leak.
 *
 * ALSO the API's in-band discovery document. `/healthz` is the path an agent
 * probes unprompted, and it used to answer with counts and nothing else — so an
 * agent holding a base URL and a key had no path to the routes at all (the root
 * is HTML, and the error bodies pointed nowhere). The three pointers below are
 * absolute, built from the REQUEST origin rather than a baked host, so a
 * dev/staging deploy points at itself.
 *
 * The `cors` block is the self-diagnosis channel for the OTHER kind of confused
 * caller: a browser app on a separate origin whose every request fails with a
 * CORS error the browser deliberately makes opaque. It reports whether CORS is
 * configured at all, how many origins are listed, and — keyed on the caller's
 * OWN `Origin` header — whether that specific origin is allowed. It does NOT
 * publish the allowlist: the count answers "did my [var] parse?" and the
 * per-origin verdict answers "is it me?", which is everything needed to debug,
 * without broadcasting an internal staging hostname on a public endpoint.
 *
 * Read it with curl rather than from the failing app, since a blocked origin
 * cannot read this response either:
 *
 *     curl -H 'Origin: https://app.example' https://slopcafe.com/healthz
 *
 * `request_origin` echoes the header only after it normalizes to a canonical
 * origin (so a trailing-slash or scheme typo shows up as `null` rather than
 * being reflected verbatim); `request_origin_allowed` is the verdict the
 * wrapper itself would reach.
 */
async function hello(
  env: Env,
  origin: string,
  requestOrigin: string | null,
): Promise<Response> {
  const d1 = await env.META.prepare(
    "select (select count(*) from documents) as documents, " +
      "(select count(*) from agents) as agents",
  ).first<{ documents: number; agents: number }>();
  const r2 = await env.DOCS.list({ limit: 1 });

  // Normalized through cors.ts's single reader, so a misconfigured
  // CORS_ALLOWED_ORIGINS reports the count actually enforced (zero, for a value
  // like `*`) rather than the number of comma-separated pieces the operator typed.
  const corsOrigins = corsAllowedOrigins(env);

  return Response.json(
    {
      ok: true,
      service: "slopcafe",
      // Single source of truth: the WASM allowlist's own version, the same value
      // stamped on every write's `sanitizer_v`. (Previously a hand-maintained
      // SANITIZER_VERSION [var] that drifted out of sync with the actual build.)
      sanitizer_version: sanitizerVersion(),
      // Normalized through core's `storageCapBytes`, the same reader the write
      // path's cap check uses — so a misconfigured [var] reports the enforced
      // fallback here instead of the raw `NaN` this used to print.
      storage_cap_bytes: storageCapBytes(env),
      // --- in-band discovery ------------------------------------------------
      // Machine contract, human on-ramp, and the MCP endpoint. Everything an
      // agent needs to go from "I have a base URL" to "I know the calls."
      openapi: `${origin}/openapi.json`,
      docs: `${origin}${QUICKSTART_PATH}`,
      mcp: `${origin}/mcp`,
      // Cross-origin state — see the doc comment above for why this is here and
      // how to read it. Bearer-only by construction: credentials are never
      // allowed cross-origin, so there is no cookie mode to report.
      cors: {
        enabled: corsOrigins.length > 0,
        allowed_origin_count: corsOrigins.length,
        request_origin: normalizeOrigin(requestOrigin),
        request_origin_allowed: resolveAllowedOrigin(requestOrigin, corsOrigins) !== null,
      },
      d1: { documents: d1?.documents ?? null, agents: d1?.agents ?? null },
      r2: { bucket_reachable: true, sample_object_count: r2.objects.length },
    },
    { headers: { link: SERVICE_DESC_LINK } },
  );
}

/**
 * GET /.well-known/assetlinks.json — Android App Links verification
 * (issue #50). Answers the standard "statement list" naming the operator's
 * app when BOTH `APP_LINKS_ANDROID_PACKAGE` and `APP_LINKS_ANDROID_SHA256`
 * are set and valid (appLinksConfig in src/app-links.ts is the single
 * reader/validator). Unset, empty, or malformed → the SAME opaque 404 the
 * catch-all serves for any unmatched route — byte-identical to a deployment
 * that predates this feature, so a fresh fork changes nothing.
 *
 * Cached for an hour: the file only changes when the operator redeploys with
 * a different signing certificate, and Android re-verifies periodically on
 * its own schedule regardless of this header.
 */
function serveAndroidAssetLinks(env: Env): Response {
  const config = appLinksConfig(env);
  if (!config.android) return jsonError(404, "not_found", `no such route${API_DISCOVERY_HINT}`);
  return Response.json(buildAndroidAssetLinks(config.android), {
    headers: { "cache-control": "public, max-age=3600" },
  });
}

/**
 * GET /.well-known/apple-app-site-association — iOS Universal Links
 * verification (issue #50), the modern `components` form. Same off-by-default
 * shape as the Android twin above: `APP_LINKS_APPLE_APP_ID` unset or
 * malformed → the ordinary opaque 404. Served with NO file extension, as
 * `application/json` (Response.json's default), and with NO redirect —
 * Apple's and Google's verifiers fetch these directly and follow neither.
 */
function serveAppleAppSiteAssociation(env: Env): Response {
  const config = appLinksConfig(env);
  if (!config.apple) return jsonError(404, "not_found", `no such route${API_DISCOVERY_HINT}`);
  return Response.json(buildAppleAppSiteAssociation(config.apple), {
    headers: { "cache-control": "public, max-age=3600" },
  });
}

/**
 * POST /d   (Authorization: Bearer awh_...)
 *   body: text/html   — raw HTML, sanitized then stored
 *   body: text/markdown — parsed (CommonMark + GFM) to HTML, then sanitized
 *   optional headers (see parseMetadataHeaders in src/metadata.ts):
 *     X-Doc-Title        - omitted → derive from first <h1>; empty → derive
 *     X-Doc-Description  - omitted → null; empty → null
 *     X-Doc-Tags         - comma-separated; charset restricted to
 *                          [A-Za-z0-9_-] (invalid chars silently stripped)
 *     X-Doc-Slug         - optional unique handle; charset
 *                          /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.
 *                          Invalid → 422; in use by a live doc → 409 slug_taken;
 *                          previously used and retired → 409 slug_retired
 *                          (slugs are not reusable — migration 0009).
 *     X-Content-SHA256   - optional byte-exact integrity check (64-hex,
 *                          optional `sha256:` prefix). Hashed against the RAW
 *                          received body before sanitization; malformed → 400
 *                          bad_integrity_header, mismatch → 422
 *                          integrity_mismatch. The companion to the
 *                          `curl --data-binary @file` byte-exact publish path
 *                          — catches a truncated/altered upload loudly. See
 *                          src/integrity.ts.
 *   →  201 { public_id, url, version, size_bytes, sanitizer_v, modified,
 *           stripped[], will_not_render[], title, description, tags[], slug }
 *
 * Thin HTTP wrapper: auth, content-type, body-decode, then delegate to
 * publishDocumentCore. All conversion, sanitization, cap checks, R2 + D1
 * writes, and rollback live in core so the MCP path runs the same code.
 *
 * For Markdown input the sanitizer is still the trust boundary — the
 * parser's HTML output flows straight into `sanitize()` with no separate
 * filter. Raw `<script>` in a Markdown document gets stripped exactly the
 * same way as `<script>` in an HTML document.
 *
 * `stripped[]` and `will_not_render[]` are advisory — see src/advisories.ts.
 * The former lists constructs the sanitizer removed; the latter lists
 * constructs that survived but the served CSP will block (notably external
 * <img src>), so an agent gets a learnable signal instead of a silent
 * broken-image render.
 *
 * The response's `title`/`description`/`tags` reflect what was actually
 * stored — useful when title was derived, or when input was sanitized
 * (e.g. invalid tag chars stripped).
 */
async function createDocument(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authenticateAgent(req, env);
  if (!auth)
    return jsonError(401, "unauthorized", `valid agent key required (Authorization: Bearer awh_…)${API_DISCOVERY_HINT}`);

  const format = parseInputFormat(req.headers.get("content-type"));
  if (!format) {
    return jsonError(
      415,
      "unsupported_media_type",
      "expected Content-Type: text/html or text/markdown",
    );
  }

  const verified = await readVerifiedBody(req);
  if (!verified.ok) return verified.response;
  const body = verified.body;
  const origin = new URL(req.url).origin;
  const meta = parseMetadataHeaders(req);
  const result = await publishDocumentCore(
    env,
    body,
    // No `clientId` (migration 0019 / issue #63): the HTTP door authenticates a
    // static `awh_` key, which is not an OAuth grant and has no client to
    // attribute. Omitted, not null-stamped — Author's field is optional and
    // absent means exactly "no client", which is what versions.author_client_id
    // records.
    { kind: "agent", agentId: auth.agentId },
    origin,
    format,
    meta,
    undefined, // visibilityOverride — agents never set birth visibility
    ctx.waitUntil.bind(ctx), // schedule the vector sync after the D1 batch commits
  );
  if (!result.ok) {
    switch (result.code) {
      case "empty_body":
        return jsonError(400, "empty_body", "body is empty");
      case "too_large":
        return jsonError(413, "too_large", `input exceeds ${result.limit} bytes`, {
          limit: result.limit,
        });
      case "too_deep":
        return jsonError(
          422,
          "too_deep",
          `document nesting too deep (${result.depth} levels; limit ${result.limit}) — flatten the markup`,
          { limit: result.limit, depth: result.depth },
        );
      case "storage_cap_exceeded":
        return jsonError(
          413,
          "storage_cap_exceeded",
          `fleet has used ${result.used} of ${result.cap} bytes; this write would exceed cap`,
          { used: result.used, cap: result.cap, this_write: result.this_write },
        );
      case "invalid_slug":
        return jsonError(422, "invalid_slug", formatSlugReject(result.reason), {
          reason: result.reason,
        });
      case "slug_taken":
        return jsonError(409, "slug_taken", `slug "${result.slug}" is already in use`, {
          slug: result.slug,
        });
      case "slug_retired":
        return jsonError(
          409,
          "slug_retired",
          `slug "${result.slug}" was previously used and is retired; slugs are not reusable`,
          { slug: result.slug },
        );
    }
  }

  return Response.json(toWriteResponse(result), {
    status: 201,
    headers: {
      Location: result.url,
      ETag: `"v${result.version}"`,
    },
  });
}

/**
 * Map a request's Content-Type onto the SourceFormat the core write
 * functions expect. Returns null for an unrecognized type so the caller
 * can emit a 415 with a consistent message.
 *
 * We match on the bare media type and ignore parameters (`; charset=…`).
 * Either spelling of Markdown's RFC 7763 media type works; both are common
 * in the wild and we'd rather accept than nitpick.
 */
function parseInputFormat(contentTypeHeader: string | null): SourceFormat | null {
  const ct = (contentTypeHeader ?? "").toLowerCase().split(";")[0]!.trim();
  if (ct === "text/html") return "html";
  if (ct === "text/markdown" || ct === "text/x-markdown") return "markdown";
  return null;
}

/**
 * PUT /d/:public_id   (Authorization: Bearer awh_..., If-Match: "v<n>")
 *   body: text/html or text/markdown  →  200 { public_id, url, version, … }
 *   optional X-Doc-Title / X-Doc-Description / X-Doc-Tags / X-Doc-Slug headers
 *     - HEADER ABSENT → inherit value from the prior version (or, for slug,
 *                       keep the current document's slug)
 *     - HEADER EMPTY  → clear (description/tags/slug) or re-derive (title)
 *     - HEADER VALUE  → use after validation (tags charset-stripped; slug
 *                       rejected on invalid charset → 422, on collision → 409)
 *
 * Thin HTTP wrapper around updateDocumentCore. The HTTP-specific bits
 * (auth, content-type, If-Match parsing, header parsing) live here; the
 * actual update logic (existence + revoked check, version comparison,
 * convert + sanitize + cap + R2 + D1, metadata inheritance) is shared
 * with the MCP path via core.ts. A document authored in HTML can be
 * updated with a Markdown body and vice versa — `versions.source_format`
 * records the input format per version.
 *
 * `If-Match` is required (428 if missing) — any agent key under this
 * operator can write the new version. See updateDocumentCore for the
 * cross-agent-write rationale.
 *
 * Optional `X-Content-SHA256` byte-exact integrity check (same semantics as
 * POST /d): hashed against the raw body before sanitization; malformed → 400,
 * mismatch → 422.
 *
 * Status codes:
 *   200  new version stored
 *   400  empty body / bad If-Match / bad X-Content-SHA256 header
 *   401  bad/missing agent auth
 *   404  missing or revoked
 *   409  X-Doc-Slug requested a slug in use by another live doc (slug_taken),
 *        or one previously used and now retired (slug_retired — not reusable)
 *   412  If-Match version doesn't match current_ver
 *   413  body too large / storage cap exceeded
 *   415  wrong content type
 *   422  X-Doc-Slug failed validation, or X-Content-SHA256 integrity_mismatch
 *   428  If-Match header missing
 */
async function updateDocument(
  publicId: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticateAgent(req, env);
  if (!auth)
    return jsonError(401, "unauthorized", `valid agent key required (Authorization: Bearer awh_…)${API_DISCOVERY_HINT}`);

  const format = parseInputFormat(req.headers.get("content-type"));
  if (!format) {
    return jsonError(
      415,
      "unsupported_media_type",
      "expected Content-Type: text/html or text/markdown",
    );
  }

  // If-Match is required so callers can't silently clobber a newer version
  // they didn't know about. 428 (Precondition Required) is RFC 6585.
  const ifMatchRaw = req.headers.get("if-match");
  if (!ifMatchRaw) {
    return jsonError(428, "precondition_required", `If-Match header required (e.g. "v1" or "*")`);
  }
  const ifMatch = parseIfMatch(ifMatchRaw);
  if (ifMatch.kind === "invalid") {
    return jsonError(400, "bad_request", `If-Match must be a version like "v3" (a bare v3 or 3 is also accepted) or "*"`);
  }
  const expectedVersion = ifMatch.kind === "version" ? ifMatch.v : null;

  const verified = await readVerifiedBody(req);
  if (!verified.ok) return verified.response;
  const body = verified.body;
  const origin = new URL(req.url).origin;
  const meta = parseMetadataHeaders(req);
  const result = await updateDocumentCore(
    env,
    publicId,
    body,
    expectedVersion,
    { kind: "agent", agentId: auth.agentId }, // no clientId — awh_ key, no OAuth client (0019)
    origin,
    format,
    meta,
    ctx.waitUntil.bind(ctx), // re-embed after the D1 batch commits
  );
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        // The hint is derived from the caller's OWN path segment (never from
        // anything we looked up), so it discloses nothing — a slug-shaped id
        // simply cannot be a public_id, and `GET /d?slug=` exists to convert
        // one. A well-formed id that merely isn't there falls back to the plain
        // message (idShapeHint's own PUBLIC_ID_RE guard). There is no
        // `PUT /s/:slug`, so the resolver is the only alternative to name; see
        // idShapeHint for why we hint instead of auto-resolving.
        return jsonError(404, "not_found", idShapeHint(publicId, () => null));
      case "empty_body":
        return jsonError(400, "empty_body", "body is empty");
      case "too_large":
        return jsonError(413, "too_large", `input exceeds ${result.limit} bytes`, {
          limit: result.limit,
        });
      case "too_deep":
        return jsonError(
          422,
          "too_deep",
          `document nesting too deep (${result.depth} levels; limit ${result.limit}) — flatten the markup`,
          { limit: result.limit, depth: result.depth },
        );
      case "storage_cap_exceeded":
        return jsonError(
          413,
          "storage_cap_exceeded",
          `fleet has used ${result.used} of ${result.cap} bytes; this write would exceed cap`,
          { used: result.used, cap: result.cap, this_write: result.this_write },
        );
      case "version_conflict":
        return jsonError(
          412,
          "precondition_failed",
          `current version is v${result.current_version}`,
          { current_version: result.current_version, expected: result.expected },
        );
      case "invalid_slug":
        return jsonError(422, "invalid_slug", formatSlugReject(result.reason), {
          reason: result.reason,
        });
      case "slug_taken":
        return jsonError(409, "slug_taken", `slug "${result.slug}" is already in use`, {
          slug: result.slug,
        });
      case "slug_retired":
        return jsonError(
          409,
          "slug_retired",
          `slug "${result.slug}" was previously used and is retired; slugs are not reusable`,
          { slug: result.slug },
        );
      // Migration 0018 / issue #43. This is the ONLY door where an agent can hit
      // the lock: the operator write door authors as `{kind:"operator"}`, and
      // setDocumentSlugCore is operator-gated. So the message has to tell the
      // agent what to do next, not just name the rule. 403 rather than 409 —
      // nothing is conflicting, the caller lacks the authority.
      case "slug_locked":
        return jsonError(
          403,
          "slug_locked",
          "this document is public; a public document's slug can only be changed by the operator. " +
            "Re-send the update without a slug field to change the content, or ask the operator to rename it.",
        );
    }
  }

  return Response.json(toWriteResponse(result), {
    status: 200,
    headers: {
      Location: result.url,
      ETag: `"v${result.version}"`,
    },
  });
}

/**
 * DELETE /d/:public_id   (Authorization: Bearer <operator>)
 *   →  200 { revoked, r2_objects_purged }
 *
 * The kill switch promised by the action plan. Operator-gated here at the
 * HTTP layer; revokeDocumentCore does the actual work (revoked_at flip
 * first, R2 purge second).
 *
 * IDEMPOTENT: a second DELETE on an already-revoked doc returns 200 with the
 * same body and RE-RUNS the R2 purge, without re-stamping `revoked_at`. That is
 * deliberate — the purge can fail loudly (it throws) after the kill has already
 * landed, so "revoke again" has to be the recovery, and a 404 there would have
 * told the operator the retry was pointless. Only an unknown or malformed
 * public_id 404s.
 */
async function revokeDocument(
  publicId: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Operator-gated via the shared guard: Bearer token (curl/scripts, no CSRF) OR
  // a browser session cookie (which then requires X-CSRF-Token since DELETE is
  // a state-changing method). 401 unauthorized / 403 csrf_failed.
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const result = await revokeDocumentCore(env, publicId, ctx.waitUntil.bind(ctx));
  if (!result.ok) {
    return jsonError(404, "not_found", "no such document");
  }

  return Response.json(toRevokeResponse(result));
}
