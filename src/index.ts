/**
 * agent-web-host — one Worker in front of D1 (metadata) + R2 (bytes).
 *
 * Routes implemented:
 *   GET  /                              — health/smoke endpoint
 *   POST /d                             — agent-auth: sanitize + store
 *   PUT  /d/:public_id                  — agent-auth + If-Match: new version
 *   DELETE /d/:public_id                — operator-auth: revoke + purge bytes (JSON)
 *   GET  /d/:public_id                  — public (or agent-auth): shell or raw
 *   GET  /d/:public_id/raw              — public: sanitized bytes (iframe src)
 *   GET  /d/:public_id/text             — public: Markdown derivation (for agents reading as context)
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
 *
 * Operator admin lives in src/admin.ts and src/admin-oauth.ts:
 *   GET    /admin/agents                       — list agents
 *   POST   /admin/agents                       — mint agent + initial key
 *   DELETE /admin/agents/:id                   — cascading kill (keys + OAuth clients)
 *   GET    /admin/agents/:id/keys              — list keys for an agent
 *   POST   /admin/agents/:id/keys              — mint additional key for an agent
 *   POST   /admin/agents/:id/oauth-clients     — mint an OAuth client for an agent
 *   DELETE /admin/keys/:id                     — revoke a single key (rotation)
 *   DELETE /admin/oauth-clients/:client_id     — revoke an OAuth client (rotation)
 *   GET    /admin/documents                    — list documents (incl. revoked)
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
  listAgentKeys,
  listAgents,
  listDocuments,
  mintAgent,
  mintAgentKey,
  revokeAgent,
  revokeKey,
} from "./admin.js";
import { createOAuthClient, deleteOAuthClient } from "./admin-oauth.js";
import { authenticateAgent, authenticateOperator } from "./auth.js";
import { handleAuthorize } from "./authorize.js";
import {
  publishDocumentCore,
  revokeDocumentCore,
  updateDocumentCore,
} from "./core.js";
import type { Env } from "./env.js";
import { handleMcp } from "./mcp.js";
import type { AwhProps } from "./mcp-auth.js";
import { wrapWithOAuth } from "./oauth.js";
import {
  handleRevokeForm,
  serveDocument,
  serveRaw,
  serveRevokeConfirm,
  serveText,
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
      if (method === "GET" && path === "/") return await hello(env);
      if (method === "POST" && path === "/d") return await createDocument(request, env);

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

      // Admin surface (operator-auth on every handler).
      if (path === "/admin/agents") {
        if (method === "GET") return await listAgents(request, env);
        if (method === "POST") return await mintAgent(request, env);
      }
      if (path === "/admin/documents" && method === "GET") {
        return await listDocuments(request, env);
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
      if (path.startsWith("/admin/oauth-clients/") && method === "DELETE") {
        const clientId = path.slice("/admin/oauth-clients/".length);
        return await deleteOAuthClient(clientId, request, env);
      }

      // Dynamic /d/:public_id and /d/:public_id/raw.
      if (path.startsWith("/d/")) {
        const tail = path.slice(3);
        const slash = tail.indexOf("/");
        if (slash === -1) {
          if (method === "GET") return await serveDocument(tail, request, env);
          if (method === "PUT") return await updateDocument(tail, request, env);
          if (method === "DELETE") return await revokeDocument(tail, request, env);
        } else if (method === "GET" && tail.slice(slash) === "/raw") {
          return await serveRaw(tail.slice(0, slash), env);
        } else if (method === "GET" && tail.slice(slash) === "/text") {
          return await serveText(tail.slice(0, slash), env);
        } else if (method === "GET" && tail.slice(slash) === "/revoke") {
          return await serveRevokeConfirm(tail.slice(0, slash), env);
        } else if (method === "POST" && tail.slice(slash) === "/revoke") {
          return await handleRevokeForm(tail.slice(0, slash), request, env);
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

export default wrapWithOAuth(innerHandler);

// -- helpers ------------------------------------------------------------------

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error: code, message, ...extra }, { status });
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
    service: "agent-web-host",
    sanitizer_version: env.SANITIZER_VERSION,
    storage_cap_bytes: Number(env.STORAGE_CAP_BYTES),
    d1: { documents: d1?.documents ?? null, agents: d1?.agents ?? null },
    r2: { bucket_reachable: true, sample_object_count: r2.objects.length },
  });
}

/**
 * POST /d   (Authorization: Bearer awh_...)   body: text/html
 *   →  201 { public_id, url, version, size_bytes, sanitizer_v, modified,
 *           stripped[], will_not_render[] }
 *
 * Thin HTTP wrapper: auth, content-type, body-decode, then delegate to
 * publishDocumentCore. All sanitization, cap checks, R2 + D1 writes, and
 * rollback live in core so the MCP path runs the same code.
 *
 * `stripped[]` and `will_not_render[]` are advisory — see src/advisories.ts.
 * The former lists constructs the sanitizer removed; the latter lists
 * constructs that survived but the served CSP will block (notably external
 * <img src>), so an agent gets a learnable signal instead of a silent
 * broken-image render.
 */
async function createDocument(req: Request, env: Env): Promise<Response> {
  const auth = await authenticateAgent(req, env);
  if (!auth) return jsonError(401, "unauthorized", "valid agent key required");

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("text/html")) {
    return jsonError(415, "unsupported_media_type", "expected Content-Type: text/html");
  }

  const html = await req.text();
  const origin = new URL(req.url).origin;
  const result = await publishDocumentCore(env, html, auth.agentId, origin);
  if (!result.ok) {
    switch (result.code) {
      case "empty_body":
        return jsonError(400, "empty_body", "body is empty");
      case "too_large":
        return jsonError(413, "too_large", `input exceeds ${result.limit} bytes`, {
          limit: result.limit,
        });
      case "storage_cap_exceeded":
        return jsonError(
          413,
          "storage_cap_exceeded",
          `fleet has used ${result.used} of ${result.cap} bytes; this write would exceed cap`,
          { used: result.used, cap: result.cap, this_write: result.this_write },
        );
    }
  }

  return Response.json(
    {
      public_id: result.public_id,
      url: result.url,
      version: result.version,
      size_bytes: result.size_bytes,
      sanitizer_v: result.sanitizer_v,
      modified: result.modified,
      stripped: result.stripped,
      will_not_render: result.will_not_render,
    },
    {
      status: 201,
      headers: {
        Location: result.url,
        ETag: `"v${result.version}"`,
      },
    },
  );
}

/**
 * Parse an `If-Match` header value into one of:
 *   { kind: "any" }        - the `*` wildcard
 *   { kind: "version", v } - a strong ETag like `"v3"`
 *   { kind: "invalid" }    - anything else
 *
 * We don't support multi-tag lists or weak tags — we only ever issue
 * single strong tags of the form `"v<n>"`, so callers should send the
 * same.
 */
function parseIfMatch(headerValue: string): { kind: "any" } | { kind: "version"; v: number } | { kind: "invalid" } {
  const trimmed = headerValue.trim();
  if (trimmed === "*") return { kind: "any" };
  const m = /^"v(\d+)"$/.exec(trimmed);
  if (!m) return { kind: "invalid" };
  return { kind: "version", v: parseInt(m[1]!, 10) };
}

/**
 * PUT /d/:public_id   (Authorization: Bearer awh_..., If-Match: "v<n>")
 *   body: text/html  →  200 { public_id, url, version, … }
 *
 * Thin HTTP wrapper around updateDocumentCore. The HTTP-specific bits
 * (auth, content-type, If-Match parsing) live here; the actual update
 * logic (existence + revoked check, version comparison, sanitize + cap +
 * R2 + D1) is shared with the MCP path via core.ts.
 *
 * `If-Match` is required (428 if missing) — any agent key under this
 * operator can write the new version. See updateDocumentCore for the
 * cross-agent-write rationale.
 *
 * Status codes:
 *   200  new version stored
 *   400  empty body / bad If-Match
 *   401  bad/missing agent auth
 *   404  missing or revoked
 *   412  If-Match version doesn't match current_ver
 *   413  body too large / storage cap exceeded
 *   415  wrong content type
 *   428  If-Match header missing
 */
async function updateDocument(publicId: string, req: Request, env: Env): Promise<Response> {
  const auth = await authenticateAgent(req, env);
  if (!auth) return jsonError(401, "unauthorized", "valid agent key required");

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("text/html")) {
    return jsonError(415, "unsupported_media_type", "expected Content-Type: text/html");
  }

  // If-Match is required so callers can't silently clobber a newer version
  // they didn't know about. 428 (Precondition Required) is RFC 6585.
  const ifMatchRaw = req.headers.get("if-match");
  if (!ifMatchRaw) {
    return jsonError(428, "precondition_required", `If-Match header required (e.g. "v1" or "*")`);
  }
  const ifMatch = parseIfMatch(ifMatchRaw);
  if (ifMatch.kind === "invalid") {
    return jsonError(400, "bad_request", `If-Match must be a strong ETag like "v3" or "*"`);
  }
  const expectedVersion = ifMatch.kind === "version" ? ifMatch.v : null;

  const html = await req.text();
  const origin = new URL(req.url).origin;
  const result = await updateDocumentCore(
    env,
    publicId,
    html,
    expectedVersion,
    auth.agentId,
    origin,
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
    }
  }

  return Response.json(
    {
      public_id: result.public_id,
      url: result.url,
      version: result.version,
      size_bytes: result.size_bytes,
      sanitizer_v: result.sanitizer_v,
      modified: result.modified,
      stripped: result.stripped,
      will_not_render: result.will_not_render,
    },
    {
      status: 200,
      headers: {
        Location: result.url,
        ETag: `"v${result.version}"`,
      },
    },
  );
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
async function revokeDocument(publicId: string, req: Request, env: Env): Promise<Response> {
  if (!authenticateOperator(req, env)) {
    return jsonError(401, "unauthorized", "operator token required");
  }

  const result = await revokeDocumentCore(env, publicId);
  if (!result.ok) {
    return jsonError(404, "not_found", "no such document");
  }

  return Response.json({
    revoked: true,
    public_id: result.public_id,
    r2_objects_purged: result.r2_objects_purged,
  });
}
