/**
 * agent-web-host — one Worker in front of D1 (metadata) + R2 (bytes).
 *
 * Routes implemented:
 *   GET  /                              — public landing page (homepage doc, toolbar-less shell)
 *   GET  /healthz                       — health/smoke endpoint (bindings + migration check)
 *   POST /d                             — agent-auth: sanitize + store
 *   PUT  /d/:public_id                  — agent-auth + If-Match: new version
 *   DELETE /d/:public_id                — operator-auth (Bearer, or session cookie + X-CSRF-Token): revoke + purge (JSON)
 *   GET  /d/:public_id                  — public (or agent-auth): shell or raw
 *   GET  /d/:public_id/raw              — public: sanitized bytes (iframe src)
 *   GET  /d/:public_id/text             — public: Markdown derivation (for agents reading as context)
 *   GET  /s/:slug                       — public (or agent-auth): shell page direct (slug stays in the bar) or raw bytes — same content negotiation as /d/:public_id
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
 *   POST   /admin/agents/:id/oauth-clients     — mint an OAuth client for an agent
 *   DELETE /admin/keys/:id                     — revoke a single key (rotation)
 *   DELETE /admin/oauth-clients/:client_id     — revoke an OAuth client (rotation)
 *   GET    /admin/documents                    — list documents (incl. revoked)
 *   GET    /admin/documents/search              — full-text search over live documents
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
  searchDocuments,
} from "./admin.js";
import { createOAuthClient, deleteOAuthClient } from "./admin-oauth.js";
import { authenticateAgent } from "./auth.js";
import { handleAuthorize } from "./authorize.js";
import { handleLogin, handleLogout } from "./login.js";
import { requireOperator } from "./session.js";
import {
  publishDocumentCore,
  revokeDocumentCore,
  type SourceFormat,
  updateDocumentCore,
} from "./core.js";
import type { Env } from "./env.js";
import { normalizeExpectedSha256, verifyContentIntegrity } from "./integrity.js";
import { handleMcp } from "./mcp.js";
import type { AwhProps } from "./mcp-auth.js";
import { parseMetadataHeaders } from "./metadata.js";
import { wrapWithOAuth } from "./oauth.js";
import { sanitizerVersion } from "./sanitizer.js";
import {
  handleRevokeForm,
  serveBySlug,
  serveDocument,
  serveHomepage,
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
      if (method === "GET" && path === "/") return await serveHomepage(env, url.origin);
      if (method === "GET" && path === "/healthz") return await hello(env);
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
      if (path === "/admin/documents/search" && method === "GET") {
        return await searchDocuments(request, env);
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

      // Slug lookup: GET /s/:slug content-negotiates exactly like /d/:public_id
      // — no auth serves the shell directly (keeps the pretty slug URL in the
      // address bar; no redirect), a valid agent key returns the raw bytes (the
      // non-browser "bytes by slug" API path). The slug is
      // a deliberate, lower-entropy lookup handle — opt-in discoverability and
      // the cross-document link target (see skills/publishing.md + SOLO spec
      // §3-4), distinct from the unguessable public_id. It lives in its own
      // /s/ namespace, clear of the public_id space (whose base64url charset
      // overlaps the slug charset). Slug charset excludes '/', so any extra
      // path segments mean a malformed slug, which serveBySlug 404s on.
      if (method === "GET" && path.startsWith("/s/")) {
        return await serveBySlug(path.slice(3), request, env);
      }

      // Dynamic /d/:public_id and /d/:public_id/{raw,text,revoke}.
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
          return await serveRevokeConfirm(tail.slice(0, slash), request, env);
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

/**
 * Render an `invalid_slug` rejection reason as a human/agent-readable
 * message. Shared by POST and PUT — the underlying SlugReject codes from
 * src/metadata.ts validateSlugInput are stable, so a single switch covers
 * both routes and the MCP path uses an equivalent translator.
 */
function formatSlugReject(reason: import("./metadata.js").SlugReject): string {
  switch (reason) {
    case "empty":
      return "slug must be non-empty (pass an empty value via X-Doc-Slug to clear an existing slug)";
    case "too_long":
      return "slug exceeds 64 characters";
    case "bad_charset":
      return "slug may only contain lowercase letters, digits, '-', '_'";
    case "must_start_alnum":
      return "slug must start with a lowercase letter or digit";
    case "must_end_alnum":
      return "slug must end with a lowercase letter or digit";
  }
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
 *                          Invalid → 422; already in use → 409.
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
async function createDocument(req: Request, env: Env): Promise<Response> {
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
  const result = await publishDocumentCore(env, body, auth.agentId, origin, format, meta);
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
      case "invalid_slug":
        return jsonError(422, "invalid_slug", formatSlugReject(result.reason), {
          reason: result.reason,
        });
      case "slug_taken":
        return jsonError(409, "slug_taken", `slug "${result.slug}" is already in use`, {
          slug: result.slug,
        });
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
      title: result.title,
      description: result.description,
      tags: result.tags,
      slug: result.slug,
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
 *   409  X-Doc-Slug requested a slug already in use by another doc
 *   412  If-Match version doesn't match current_ver
 *   413  body too large / storage cap exceeded
 *   415  wrong content type
 *   422  X-Doc-Slug failed validation, or X-Content-SHA256 integrity_mismatch
 *   428  If-Match header missing
 */
async function updateDocument(publicId: string, req: Request, env: Env): Promise<Response> {
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
    return jsonError(400, "bad_request", `If-Match must be a strong ETag like "v3" or "*"`);
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
    auth.agentId,
    origin,
    format,
    meta,
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
      case "invalid_slug":
        return jsonError(422, "invalid_slug", formatSlugReject(result.reason), {
          reason: result.reason,
        });
      case "slug_taken":
        return jsonError(409, "slug_taken", `slug "${result.slug}" is already in use`, {
          slug: result.slug,
        });
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
      title: result.title,
      description: result.description,
      tags: result.tags,
      slug: result.slug,
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
  // Operator-gated via the shared guard: Bearer token (curl/scripts, no CSRF) OR
  // a browser session cookie (which then requires X-CSRF-Token since DELETE is
  // a state-changing method). 401 unauthorized / 403 csrf_failed.
  const denied = await requireOperator(req, env);
  if (denied) return denied;

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
