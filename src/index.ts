/**
 * agent-web-host — one Worker in front of D1 (metadata) + R2 (bytes).
 *
 * Routes implemented:
 *   GET  /                 — health/smoke endpoint
 *   POST /admin/agents     — operator-auth: mint a new agent + initial key
 *   POST /d                — agent-auth: sanitize + store, return public URL
 *
 * Still to come (steps 4–7 of action-plan-v1.md): GET /d/:public_id (web +
 * agent serve, content-negotiated), PUT /d/:public_id (new version),
 * DELETE /d/:public_id (revoke + purge), remaining admin endpoints.
 */

import { authenticateAgent, authenticateOperator, hmacSha256Hex } from "./auth.js";
import type { Env } from "./env.js";
import { newApiKey, newPublicId, newUuid } from "./ids.js";
import { sanitize, sanitizerVersion } from "./sanitizer.js";

export type { Env };

/** Per-document raw input cap. The per-agent storage cap is enforced separately. */
const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MiB

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /":
          return await hello(env);
        case "POST /admin/agents":
          return await mintAgent(request, env);
        case "POST /d":
          return await createDocument(request, env);
        default:
          return jsonError(404, "not_found", "no such route");
      }
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

  // Storage cap. Best-effort: the SUM runs outside the insert batch, so two
  // concurrent writes can both pass the check. v1 accepts the slight overrun;
  // see action-plan-v1.md "Follow-ups" for the strict-cap discussion.
  const cap = Number(env.STORAGE_CAP_BYTES);
  const usedRow = await env.META.prepare(
    `select coalesce(sum(v.size_bytes), 0) as used
     from versions v
     join documents d on d.id = v.document_id
     where d.created_by = ? and d.revoked_at is null`,
  )
    .bind(auth.agentId)
    .first<{ used: number }>();
  const used = Number(usedRow?.used ?? 0);
  if (used + cleanedBytes.byteLength > cap) {
    return jsonError(
      413,
      "storage_cap_exceeded",
      `agent has used ${used} of ${cap} bytes; this write would exceed cap`,
      { used, cap, this_write: cleanedBytes.byteLength },
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
