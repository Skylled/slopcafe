// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * agent-web-host — one Worker in front of D1 (metadata) + R2 (bytes).
 *
 * Routes implemented:
 *   GET  /                              — public landing page (homepage doc, toolbar-less shell)
 *   GET  /healthz                       — health/smoke endpoint (bindings + migration check)
 *   GET  /openapi.json                  — public: generated OpenAPI 3.1 spec (assembled on demand)
 *   GET  /shell.js                      — public: toolbar enhancement script for the document shell
 *   POST /d                             — agent-auth: sanitize + store
 *   PUT  /d/:public_id                  — agent-auth + If-Match: new version
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
 *   POST /d/:public_id/restore          — operator-auth via form field: restore historical version n as a new version
 *   GET  /d/:public_id/revoke           — operator-paste confirmation form (HTML)
 *   POST /d/:public_id/revoke           — operator-auth via form field: revoke + purge
 *   *    /mcp                           — Streamable HTTP MCP surface, agent-auth
 *                                          via Door A (OAuth, ctx.props from
 *                                          OAuthProvider) or Door B (static
 *                                          `awh_` bearer — same key path POST
 *                                          /d uses). See src/mcp.ts.
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
 *   DELETE /admin/oauth-clients/:client_id     — revoke an OAuth client (rotation)
 *   GET    /admin/documents                    — list documents (incl. revoked)
 *   POST   /admin/documents                    — operator authors a new document (JSON body)
 *   GET    /admin/documents/search              — hybrid (keyword + semantic) search over live documents
 *   PUT    /admin/documents/:public_id         — operator updates a document (new version; optional If-Match)
 *   POST   /admin/documents/:public_id/visibility — operator sets a live doc public/private
 *   POST   /admin/documents/:public_id/slug    — operator adds/renames/clears a live doc's slug (rename auto-forwards)
 *   POST   /admin/documents/:public_id/tags    — operator replaces a live doc's tags (no version bump)
 *   POST   /admin/documents/:public_id/status  — operator sets a live doc's lifecycle status (active|deprecated; no version bump)
 *   POST   /admin/vectors/backfill             — operator backfills/reconciles the Vectorize index
 *   POST   /admin/links/backfill               — operator backfills the link graph from stored renders (issue #40)
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
 */

import {
  backfillLinks,
  backfillVectors,
  clearSlugRedirect,
  createDocumentAsOperator,
  listAgentKeys,
  listAgents,
  listDocuments,
  listOrphanDocuments,
  mintAgent,
  mintAgentKey,
  releaseSlugTombstone,
  revokeAgent,
  revokeKey,
  searchDocuments,
  setDocumentSlug,
  setDocumentStatus,
  setDocumentTags,
  setDocumentVisibility,
  setSlugRedirect,
  updateDocumentAsOperator,
} from "./admin.js";
import { createOAuthClient, createUnboundOAuthClient, deleteOAuthClient } from "./admin-oauth.js";
import { authenticateAgent } from "./auth.js";
import {
  handleConsoleBackfill,
  handleConsoleDeleteClient,
  handleConsoleLinksBackfill,
  handleConsoleMintAgent,
  handleConsoleMintBoundClient,
  handleConsoleMintKey,
  handleConsoleMintUnboundClient,
  handleConsoleRevokeAgent,
  handleConsoleRevokeKey,
  serveConsoleAgentDetail,
  serveConsoleAgents,
  serveConsoleDashboard,
  serveConsoleDocuments,
  serveConsoleMaintenance,
} from "./console.js";
import { handleAuthorize } from "./authorize.js";
import { parseIfMatch } from "./conditional.js";
import type { ErrorCode } from "./contract.js";
import { handleLogin, handleLogout } from "./login.js";
import { requireOperator } from "./session.js";
import {
  publishDocumentCore,
  revokeDocumentCore,
  type SourceFormat,
  updateDocumentCore,
} from "./core.js";
import type { Env } from "./env.js";
import { UUID_RE } from "./ids.js";
import { normalizeExpectedSha256, verifyContentIntegrity } from "./integrity.js";
import { handleMcp } from "./mcp.js";
import type { AwhProps } from "./mcp-auth.js";
import { buildOpenApiDocument } from "./openapi.js";
import { formatSlugReject, parseMetadataHeaders } from "./metadata.js";
import { wrapWithOAuth } from "./oauth.js";
import { sanitizerVersion } from "./sanitizer.js";
import { toRevokeResponse, toWriteResponse } from "./wire.js";
import {
  handleRevokeForm,
  handleRestoreForm,
  handleSlugForm,
  handleStatusForm,
  handleTagsForm,
  handleVisibilityForm,
  serveBySlug,
  serveDocument,
  serveHomepage,
  serveManagePage,
  serveRaw,
  serveRevokeConfirm,
  serveShellScript,
  serveLinks,
  serveSource,
  serveText,
  serveTextBySlug,
  serveVersionRaw,
  serveVersionShell,
} from "./serve.js";

export type { Env };

const innerHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const route = `${method} ${path}`;
    try {
      // Static routes — cheap exact-match dispatch.
      if (method === "GET" && path === "/") return await serveHomepage(env, url.origin);
      if (method === "GET" && path === "/healthz") return await hello(env);
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
      if (method === "POST" && path === "/d") return await createDocument(request, env, ctx);

      // Streamable HTTP MCP. The OAuthProvider wrap intercepts every
      // /mcp request, validates the token (either as an internal OAuth
      // grant from OAUTH_KV or via the resolveExternalToken callback
      // that handles awh_ bearers), populates ctx.props, then calls us
      // as apiHandler. Invalid-token and no-token requests are 401'd by
      // the provider itself — we only see authorized requests here.
      if (path === "/mcp") {
        const props = (ctx as ExecutionContext & { props?: AwhProps }).props;
        if (!props?.agentId) {
          // Belt-and-suspenders: unreachable in the OAuthProvider apiHandler
          // contract. If we ever see this, the wrap upstream broke.
          console.error("apiHandler /mcp without props");
          return jsonError(500, "internal", "apiHandler invoked without props");
        }
        return await handleMcp(request, env, ctx, props);
      }

      // Consent UI for Door A. The OAuthProvider routes /authorize to
      // defaultHandler (us); /token and /.well-known/* it serves itself.
      if (path === "/authorize") return await handleAuthorize(request, env);

      // Operator browser session (a second door onto the same operator check;
      // see src/session.ts). Reaches us via defaultHandler — the OAuth wrap
      // only intercepts /mcp + /authorize + /token + /.well-known/*.
      if (path === "/login") return await handleLogin(request, env);
      if (path === "/logout") return await handleLogout(request, env);

      // Admin surface (operator-auth on every handler).
      if (path === "/admin/agents") {
        if (method === "GET") return await listAgents(request, env);
        if (method === "POST") return await mintAgent(request, env);
      }
      if (path === "/admin/documents" && method === "GET") {
        return await listDocuments(request, env);
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
      if (path === "/admin/vectors/backfill" && method === "POST") {
        return await backfillVectors(request, env);
      }
      // POST /admin/links/backfill — operator-invoked link-graph backfill
      // (migration 0016 / issue #40): re-extract document_links from stored H.
      if (path === "/admin/links/backfill" && method === "POST") {
        return await backfillLinks(request, env);
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
      // POST /admin/documents/:public_id/visibility — operator sets a live doc
      // public/private (migration 0011). The `/visibility` suffix disambiguates
      // from the list/search routes above; public_id charset has no '/'.
      if (path.startsWith("/admin/documents/") && path.endsWith("/visibility") && method === "POST") {
        const publicId = path.slice("/admin/documents/".length, -"/visibility".length);
        return await setDocumentVisibility(publicId, request, env);
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
      if (path.startsWith("/admin/agents/")) {
        const rest = path.slice("/admin/agents/".length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          // /admin/agents/:id — Step 9's cascade kill.
          if (method === "DELETE") return await revokeAgent(rest, request, env);
        } else {
          const agentId = rest.slice(0, slash);
          const sub = rest.slice(slash);
          if (sub === "/keys") {
            if (method === "GET") return await listAgentKeys(agentId, request, env);
            if (method === "POST") return await mintAgentKey(agentId, request, env);
          }
          if (sub === "/oauth-clients" && method === "POST") {
            return await createOAuthClient(agentId, request, env);
          }
        }
      }
      if (path.startsWith("/admin/keys/") && method === "DELETE") {
        const keyId = path.slice("/admin/keys/".length);
        return await revokeKey(keyId, request, env);
      }
      if (path === "/admin/oauth-clients" && method === "POST") {
        return await createUnboundOAuthClient(request, env);
      }
      if (path.startsWith("/admin/oauth-clients/") && method === "DELETE") {
        const clientId = path.slice("/admin/oauth-clients/".length);
        return await deleteOAuthClient(clientId, request, env);
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
        // (agents/revoke, keys/revoke, oauth-clients[/delete], vectors/backfill,
        // documents, maintenance, the bare "agents") BEFORE the parametric
        // /agents/:id forms, so e.g. "agents/revoke" is never parsed as an agent
        // id of "revoke". The :id segment is UUID-shape-validated before it
        // reaches a handler that interpolates it into an href (the cores re-check
        // too, but this yields a clean 404 rather than leaning on a core).
        const sub = path.slice("/admin/console/".length);
        if (sub === "agents") {
          if (method === "GET") return await serveConsoleAgents(request, env);
          if (method === "POST") return await handleConsoleMintAgent(request, env);
        } else if (sub === "agents/revoke") {
          if (method === "POST") return await handleConsoleRevokeAgent(request, env);
        } else if (sub === "keys/revoke") {
          if (method === "POST") return await handleConsoleRevokeKey(request, env);
        } else if (sub === "oauth-clients") {
          if (method === "POST") return await handleConsoleMintUnboundClient(request, env);
        } else if (sub === "oauth-clients/delete") {
          if (method === "POST") return await handleConsoleDeleteClient(request, env);
        } else if (sub === "documents") {
          if (method === "GET") return await serveConsoleDocuments(request, env);
        } else if (sub === "maintenance") {
          if (method === "GET") return await serveConsoleMaintenance(request, env);
        } else if (sub === "vectors/backfill") {
          if (method === "POST") return await handleConsoleBackfill(request, env);
        } else if (sub === "links/backfill") {
          if (method === "POST") return await handleConsoleLinksBackfill(request, env);
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
                return await handleConsoleMintKey(agentId, request, env);
              }
              if (tail === "/oauth-clients" && method === "POST") {
                return await handleConsoleMintBoundClient(agentId, request, env);
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
          if (method === "POST") return await setSlugRedirect(slug, request, env);
          if (method === "DELETE") return await clearSlugRedirect(slug, request, env);
        } else if (rest.indexOf("/") === -1) {
          if (method === "DELETE") return await releaseSlugTombstone(rest, request, env);
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
        } else if (method === "GET" && tail.slice(slash) === "/manage") {
          // Operator-only document-management page (visibility toggle, slug
          // editor, revoke). Reached from the shell topbar's "Manage…" item.
          return await serveManagePage(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/visibility") {
          return await handleVisibilityForm(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/slug") {
          return await handleSlugForm(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/tags") {
          return await handleTagsForm(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/status") {
          return await handleStatusForm(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/restore") {
          return await handleRestoreForm(tail.slice(0, slash), request, env, ctx);
        } else if (method === "GET" && tail.slice(slash) === "/revoke") {
          return await serveRevokeConfirm(tail.slice(0, slash), request, env);
        } else if (method === "POST" && tail.slice(slash) === "/revoke") {
          return await handleRevokeForm(tail.slice(0, slash), request, env, ctx);
        }
      }

      return jsonError(404, "not_found", "no such route");
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

export default wrapWithOAuth(withHeadSupport(innerHandler));

// -- helpers ------------------------------------------------------------------

function jsonError(
  status: number,
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error: code, message, ...extra }, { status });
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
 * Health smoke: confirms bindings reach both stores and the migration ran.
 * Cheap enough to leave public; D1 returns counts of empty tables for a new
 * deploy, so no information leak.
 */
async function hello(env: Env): Promise<Response> {
  const d1 = await env.META.prepare(
    "select (select count(*) from documents) as documents, " +
      "(select count(*) from agents) as agents",
  ).first<{ documents: number; agents: number }>();
  const r2 = await env.DOCS.list({ limit: 1 });

  return Response.json({
    ok: true,
    service: "slopcafe",
    // Single source of truth: the WASM allowlist's own version, the same value
    // stamped on every write's `sanitizer_v`. (Previously a hand-maintained
    // SANITIZER_VERSION [var] that drifted out of sync with the actual build.)
    sanitizer_version: sanitizerVersion(),
    storage_cap_bytes: Number(env.STORAGE_CAP_BYTES),
    d1: { documents: d1?.documents ?? null, agents: d1?.agents ?? null },
    r2: { bucket_reachable: true, sample_object_count: r2.objects.length },
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
  if (!auth) return jsonError(401, "unauthorized", "valid agent key required");

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
  if (!auth) return jsonError(401, "unauthorized", "valid agent key required");

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
    { kind: "agent", agentId: auth.agentId },
    origin,
    format,
    meta,
    ctx.waitUntil.bind(ctx), // re-embed after the D1 batch commits
  );
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return jsonError(404, "not_found", "no such document");
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
 * Idempotent-ish: a second DELETE on an already-revoked doc returns 404,
 * matching the GET semantics — at that point it's gone.
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
