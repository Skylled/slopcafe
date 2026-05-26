/**
 * agent-web-host — one Worker in front of D1 (metadata) + R2 (bytes).
 *
 * Routes implemented:
 *   GET  /                  — health/smoke endpoint
 *   POST /admin/agents      — operator-auth: mint a new agent + initial key
 *   POST /d                 — agent-auth: sanitize + store, return public URL
 *   GET  /d/:public_id      — public (or agent-auth): shell, or raw HTML
 *   GET  /d/:public_id/raw  — public: sanitized bytes (the iframe's src)
 *   PUT  /d/:public_id      — agent-auth + If-Match: append new version
 *   DELETE /d/:public_id    — operator-auth: revoke + purge R2 bytes
 *
 * Still to come (step 7 of action-plan-v1.md): remaining admin endpoints
 * for listing/revoking keys and listing documents.
 */

import { authenticateAgent, authenticateOperator, hmacSha256Hex } from "./auth.js";
import type { Env } from "./env.js";
import { newApiKey, newPublicId, newUuid } from "./ids.js";
import { sanitize, sanitizerVersion } from "./sanitizer.js";
import { PUBLIC_ID_RE, serveDocument, serveRaw } from "./serve.js";

export type { Env };

/** Per-document raw input cap. The per-agent storage cap is enforced separately. */
const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MiB

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const route = `${method} ${path}`;
    try {
      // Static routes — cheap exact-match dispatch.
      if (method === "GET" && path === "/") return await hello(env);
      if (method === "POST" && path === "/admin/agents") return await mintAgent(request, env);
      if (method === "POST" && path === "/d") return await createDocument(request, env);

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
} satisfies ExportedHandler<Env>;

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
 * Global storage cap. Sums `size_bytes` across every non-revoked version,
 * regardless of which agent created the document — v1 is single-operator,
 * so the cap is a fleet-wide guardrail rather than a per-agent quota.
 * (See action-plan-v1.md and the conversation around step 6 for rationale.)
 */
async function checkStorageCap(
  env: Env,
  addBytes: number,
): Promise<{ ok: true } | { ok: false; used: number; cap: number }> {
  const cap = Number(env.STORAGE_CAP_BYTES);
  const row = await env.META.prepare(
    `select coalesce(sum(v.size_bytes), 0) as used
     from versions v
     join documents d on d.id = v.document_id
     where d.revoked_at is null`,
  ).first<{ used: number }>();
  const used = Number(row?.used ?? 0);
  if (used + addBytes > cap) return { ok: false, used, cap };
  return { ok: true };
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
 * POST /admin/agents  { "name": "<label>" }  →  201 { agent_id, key, ... }
 *
 * Mints an agent and its initial API key. The plaintext key is returned
 * exactly once — only the prefix and HMAC survive in the DB.
 */
async function mintAgent(req: Request, env: Env): Promise<Response> {
  if (!authenticateOperator(req, env)) {
    return jsonError(401, "unauthorized", "operator token required");
  }
  if (!env.HMAC_PEPPER) {
    return jsonError(500, "misconfigured", "HMAC_PEPPER not set");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const name = (body as { name?: unknown })?.name;
  if (typeof name !== "string" || name.length === 0 || name.length > 200) {
    return jsonError(400, "bad_request", "missing or invalid 'name' (string, 1-200 chars)");
  }

  const agentId = newUuid();
  const keyId = newUuid();
  const key = newApiKey();
  const keyHash = await hmacSha256Hex(key.secret, env.HMAC_PEPPER);

  // Single batch = single SQL transaction in D1, so a failure here leaves
  // neither the agent nor the key behind.
  await env.META.batch([
    env.META.prepare("insert into agents (id, name) values (?, ?)").bind(agentId, name),
    env.META.prepare(
      "insert into agent_keys (id, agent_id, key_prefix, key_hash) values (?, ?, ?, ?)",
    ).bind(keyId, agentId, key.prefix, keyHash),
  ]);

  return Response.json(
    {
      agent_id: agentId,
      key_id: keyId,
      key: key.plaintext,
      note: "store this key now — the secret half is never returned again",
    },
    { status: 201 },
  );
}

/**
 * POST /d   (Authorization: Bearer awh_...)   body: text/html
 *   →  201 { public_id, url, version, size_bytes, sanitizer_v, modified }
 *
 * Sanitizes the input, enforces the per-agent storage cap, writes the
 * cleaned bytes to R2 and a (document, version) pair to D1, and returns
 * the public URL.
 */
async function createDocument(req: Request, env: Env): Promise<Response> {
  const auth = await authenticateAgent(req, env);
  if (!auth) return jsonError(401, "unauthorized", "valid agent key required");

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("text/html")) {
    return jsonError(415, "unsupported_media_type", "expected Content-Type: text/html");
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return jsonError(400, "empty_body", "body is empty");
  if (buf.byteLength > MAX_INPUT_BYTES) {
    return jsonError(413, "too_large", `input exceeds ${MAX_INPUT_BYTES} bytes`, {
      limit: MAX_INPUT_BYTES,
    });
  }
  const inputHtml = new TextDecoder().decode(buf);

  // Sanitize first so the cap check reflects what would actually be stored.
  const cleanedHtml = sanitize(inputHtml);
  const cleanedBytes = new TextEncoder().encode(cleanedHtml);
  const sanitizerV = sanitizerVersion();

  // Best-effort: the SUM runs outside the insert batch, so two concurrent
  // writes can both pass the check. v1 accepts the slight overrun.
  const capCheck = await checkStorageCap(env, cleanedBytes.byteLength);
  if (!capCheck.ok) {
    return jsonError(
      413,
      "storage_cap_exceeded",
      `fleet has used ${capCheck.used} of ${capCheck.cap} bytes; this write would exceed cap`,
      { used: capCheck.used, cap: capCheck.cap, this_write: cleanedBytes.byteLength },
    );
  }

  const docId = newUuid();
  const publicId = newPublicId();
  const versionNo = 1;
  const r2Key = `${docId}/v${versionNo}`;

  // R2 first. If the D1 batch fails we attempt to delete the blob so we
  // don't accumulate orphans. R2 keys are unique per (docId, version), so a
  // retry harmlessly overwrites.
  await env.DOCS.put(r2Key, cleanedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      document_id: docId,
      version: String(versionNo),
      sanitizer_v: sanitizerV,
      agent_id: auth.agentId,
    },
  });

  try {
    await env.META.batch([
      env.META.prepare(
        "insert into documents (id, public_id, created_by) values (?, ?, ?)",
      ).bind(docId, publicId, auth.agentId),
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v)
         values (?, ?, ?, ?, ?)`,
      ).bind(docId, versionNo, r2Key, cleanedBytes.byteLength, sanitizerV),
      env.META.prepare("update documents set current_ver = ? where id = ?").bind(
        versionNo,
        docId,
      ),
    ]);
  } catch (err) {
    await env.DOCS.delete(r2Key).catch(() => {
      /* best effort; surfaced via logs if it matters */
    });
    throw err;
  }

  const url = new URL(req.url);
  const publicUrl = `${url.origin}/d/${publicId}`;
  return Response.json(
    {
      public_id: publicId,
      url: publicUrl,
      version: versionNo,
      size_bytes: cleanedBytes.byteLength,
      sanitizer_v: sanitizerV,
      modified: inputHtml !== cleanedHtml,
    },
    {
      status: 201,
      headers: {
        Location: publicUrl,
        ETag: `"v${versionNo}"`,
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
 * Append-only new version. Any valid agent key under this operator can
 * write: v1 is single-tenant (one operator owns the whole fleet of agents),
 * so requiring the *original* creator's key would mean revoking a
 * compromised key permanently strands its documents. Cross-agent writes
 * are the right call as long as the trust boundary is the operator.
 *
 * If we ever grow into a multi-tenant model, the check belongs on an
 * `agents.operator_id` column (any agent under the document's operator
 * can write), not on `documents.created_by`.
 *
 * `If-Match` is required; pass `"v<current>"` for optimistic concurrency,
 * or `*` to skip the version check.
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
  if (!PUBLIC_ID_RE.test(publicId)) return jsonError(404, "not_found", "no such document");

  const auth = await authenticateAgent(req, env);
  if (!auth) return jsonError(401, "unauthorized", "valid agent key required");

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("text/html")) {
    return jsonError(415, "unsupported_media_type", "expected Content-Type: text/html");
  }

  // If-Match is required so callers can't silently clobber a newer version
  // they didn't know about. 428 (Precondition Required) is the RFC 6585
  // status for this case.
  const ifMatchRaw = req.headers.get("if-match");
  if (!ifMatchRaw) {
    return jsonError(428, "precondition_required", `If-Match header required (e.g. \"v1\" or "*")`);
  }
  const ifMatch = parseIfMatch(ifMatchRaw);
  if (ifMatch.kind === "invalid") {
    return jsonError(400, "bad_request", "If-Match must be a strong ETag like \"v3\" or \"*\"");
  }

  // Look up document + current version + owner in one go.
  const row = await env.META.prepare(
    "select id, current_ver, revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ id: string; current_ver: number | null; revoked_at: string | null }>();
  if (!row || row.revoked_at) return jsonError(404, "not_found", "no such document");

  // A document with no current_ver shouldn't normally happen (POST sets it
  // to 1 atomically), but guard anyway — the precondition can't be met.
  if (row.current_ver === null) {
    return jsonError(412, "precondition_failed", "document has no current version", {
      current_version: null,
    });
  }

  if (ifMatch.kind === "version" && ifMatch.v !== row.current_ver) {
    return jsonError(
      412,
      "precondition_failed",
      `current version is v${row.current_ver}`,
      { current_version: row.current_ver, expected: ifMatch.v },
    );
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return jsonError(400, "empty_body", "body is empty");
  if (buf.byteLength > MAX_INPUT_BYTES) {
    return jsonError(413, "too_large", `input exceeds ${MAX_INPUT_BYTES} bytes`, {
      limit: MAX_INPUT_BYTES,
    });
  }
  const inputHtml = new TextDecoder().decode(buf);

  const cleanedHtml = sanitize(inputHtml);
  const cleanedBytes = new TextEncoder().encode(cleanedHtml);
  const sanitizerV = sanitizerVersion();

  const capCheck = await checkStorageCap(env, cleanedBytes.byteLength);
  if (!capCheck.ok) {
    return jsonError(
      413,
      "storage_cap_exceeded",
      `fleet has used ${capCheck.used} of ${capCheck.cap} bytes; this write would exceed cap`,
      { used: capCheck.used, cap: capCheck.cap, this_write: cleanedBytes.byteLength },
    );
  }

  const nextVer = row.current_ver + 1;
  const r2Key = `${row.id}/v${nextVer}`;

  await env.DOCS.put(r2Key, cleanedBytes, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      document_id: row.id,
      version: String(nextVer),
      sanitizer_v: sanitizerV,
      agent_id: auth.agentId,
    },
  });

  try {
    await env.META.batch([
      env.META.prepare(
        `insert into versions (document_id, version_no, r2_key, size_bytes, sanitizer_v)
         values (?, ?, ?, ?, ?)`,
      ).bind(row.id, nextVer, r2Key, cleanedBytes.byteLength, sanitizerV),
      env.META.prepare("update documents set current_ver = ? where id = ?").bind(nextVer, row.id),
    ]);
  } catch (err) {
    await env.DOCS.delete(r2Key).catch(() => {
      /* best effort; we'd rather not leak orphan blobs but D1 is the source of truth */
    });
    throw err;
  }

  const url = new URL(req.url);
  const publicUrl = `${url.origin}/d/${publicId}`;
  return Response.json(
    {
      public_id: publicId,
      url: publicUrl,
      version: nextVer,
      size_bytes: cleanedBytes.byteLength,
      sanitizer_v: sanitizerV,
      modified: inputHtml !== cleanedHtml,
    },
    {
      status: 200,
      headers: {
        Location: publicUrl,
        ETag: `"v${nextVer}"`,
      },
    },
  );
}

/**
 * DELETE /d/:public_id   (Authorization: Bearer <operator>)
 *   →  200 { revoked, r2_objects_purged }
 *
 * The kill switch promised by the action plan: flips `revoked_at` first
 * (so a subsequent GET 404s even if R2 cleanup hangs), then batch-deletes
 * every version's R2 object. Keeps `versions` rows as an audit trail of
 * what existed; the bytes themselves are the irrecoverable part.
 *
 * Idempotent-ish: a second DELETE on an already-revoked doc returns 404
 * (matches the GET semantics — at that point it's gone).
 */
async function revokeDocument(publicId: string, req: Request, env: Env): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return jsonError(404, "not_found", "no such document");
  if (!authenticateOperator(req, env)) {
    return jsonError(401, "unauthorized", "operator token required");
  }

  const row = await env.META.prepare(
    "select id, revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ id: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) return jsonError(404, "not_found", "no such document");

  // Gather every version's R2 key. Bounded by how many writes the agent
  // has performed against this doc — pathological case for v1 is "agent
  // wrote 100k versions before revoke," which we'd cap separately.
  const versions = await env.META.prepare(
    "select r2_key from versions where document_id = ? order by version_no",
  )
    .bind(row.id)
    .all<{ r2_key: string }>();
  const r2Keys = (versions.results ?? []).map((v) => v.r2_key);

  // Mark revoked BEFORE purging R2 so the doc is unreachable instantly,
  // even if the bucket call hangs or fails.
  await env.META.prepare(
    "update documents set revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), current_ver = null where id = ?",
  )
    .bind(row.id)
    .run();

  if (r2Keys.length > 0) {
    // R2's `delete()` accepts an array for batch delete.
    await env.DOCS.delete(r2Keys);
  }

  return Response.json({
    revoked: true,
    public_id: publicId,
    r2_objects_purged: r2Keys.length,
  });
}
