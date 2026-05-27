/**
 * /authorize — the operator-facing consent screen for Door A.
 *
 * v1 is single-operator: the OAuth flow always lands the same human
 * (the operator) on this page, no matter which agent's connector is
 * authorizing. So the consent UI is a single password field for the
 * existing OPERATOR_TOKEN plus Allow / Deny.
 *
 * Flow:
 *   GET  /authorize?...   → parse auth request via OAUTH_PROVIDER,
 *                           look up oauth_clients.client_id → agents.name,
 *                           render the form (action=POST to the same URL
 *                           so query params survive the round trip).
 *   POST /authorize?...   → re-parse the same auth request, verify
 *                           operator_token, on allow call
 *                           OAUTH_PROVIDER.completeAuthorization with
 *                           props.agentId pinned to the agents row for
 *                           this client. 302 to the returned redirectTo.
 *
 * Anti-XSS: the only dynamic value rendered into HTML is the agent name,
 * which is HTML-escaped. CSP is tight (default-src 'none'; no JS).
 */

import { authenticateOperator } from "./auth.js";
import type { Env } from "./env.js";
import type { AwhProps } from "./mcp-auth.js";

const AUTHORIZE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  // form-action must allow the redirect target after a successful POST.
  // The worker 302s to the OAuth client's redirect_uri (https://claude.ai
  // for hosted Claude / Cowork), and CSP form-action is checked on EVERY
  // URL in the redirect chain — not just the initial submit target. The
  // hosted-Claude callback also redirects to claude.com once Anthropic
  // finishes wiring; allowlist both. (deny path also redirects to the
  // client's redirect_uri.)
  "form-action 'self' https://claude.ai https://claude.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const AUTHORIZE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": AUTHORIZE_CSP,
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") return await getAuthorize(req, env);
  if (req.method === "POST") return await postAuthorize(req, env);
  return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
}

async function getAuthorize(req: Request, env: Env): Promise<Response> {
  let authReq;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(req);
  } catch (err) {
    // parseAuthRequest throws on unknown / revoked client_id, or on malformed
    // OAuth params. Show a friendly page rather than a generic 500.
    return errorPage(400, `invalid authorization request: ${String((err as Error).message ?? err)}`, req);
  }
  const agent = await lookupAgentForClient(env, authReq.clientId);
  if (!agent) return errorPage(400, "unknown OAuth client", req);

  // Preserve the original query string so the POST can re-parse it.
  const qs = new URL(req.url).search;
  const body = renderConsent(agent.name, qs);
  return new Response(body, { status: 200, headers: AUTHORIZE_HEADERS });
}

async function postAuthorize(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const operatorToken = String(form.get("operator_token") ?? "");

  // Build a synthetic Authorization-bearing Request so we can reuse the
  // existing constant-time operator check without re-implementing it.
  const synth = new Request(req.url, {
    headers: { authorization: `Bearer ${operatorToken}` },
  });
  if (!authenticateOperator(synth, env)) {
    return errorPage(401, "operator token incorrect", req);
  }

  // Re-parse the OAuth request from the URL the form posted to (query
  // params preserved by getAuthorize).
  let authReq;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(req);
  } catch (err) {
    return errorPage(400, `invalid authorization request: ${String((err as Error).message ?? err)}`, req);
  }
  const agent = await lookupAgentForClient(env, authReq.clientId);
  if (!agent) return errorPage(400, "unknown OAuth client", req);

  if (action === "deny") {
    const denyUrl = new URL(authReq.redirectUri);
    denyUrl.searchParams.set("error", "access_denied");
    denyUrl.searchParams.set("error_description", "operator denied the request");
    if (authReq.state) denyUrl.searchParams.set("state", authReq.state);
    return Response.redirect(denyUrl.toString(), 302);
  }
  if (action !== "allow") return errorPage(400, "missing or invalid action", req);

  // Issue the grant. props is the AwhProps that flows to every MCP tool
  // call via ctx.props (apiHandler path) — same shape Door B yields.
  // completeAuthorization can throw on bad PKCE / unknown scope / etc;
  // catch and render a friendly page so the operator sees the actual
  // problem instead of a generic 500 bubbling through the top-level catch.
  const props: AwhProps = { agentId: agent.id, via: "oauth" };
  let redirectTo: string;
  try {
    ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authReq,
      userId: agent.id,
      scope: ["agent"],
      metadata: { agent_name: agent.name, client_id: authReq.clientId },
      props,
    }));
  } catch (err) {
    return errorPage(500, `completeAuthorization failed: ${String((err as Error).message ?? err)}`, req);
  }
  return Response.redirect(redirectTo, 302);
}

// -- helpers ------------------------------------------------------------------

async function lookupAgentForClient(
  env: Env,
  clientId: string,
): Promise<{ id: string; name: string } | null> {
  const row = await env.META.prepare(
    `select a.id, a.name
     from oauth_clients oc
     join agents a on a.id = oc.agent_id
     where oc.client_id = ?`,
  )
    .bind(clientId)
    .first<{ id: string; name: string }>();
  return row ?? null;
}

/** HTML-escape minimal entity set for safe interpolation into element text. */
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderConsent(agentName: string, querystring: string): string {
  // querystring already starts with `?` (or is empty)
  const action = `/authorize${querystring}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>agent-web-host — authorize</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
  .card{max-width:420px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
  h1{font-size:18px;margin:0 0 12px;font-weight:600}
  p{margin:0 0 16px;color:#555}
  .agent{font-weight:600;color:#222}
  label{display:block;margin:18px 0 6px;font-size:13px;color:#555}
  input[type=password]{width:100%;box-sizing:border-box;padding:9px 10px;font:13px/1.4 system-ui,sans-serif;border:1px solid #ccc;border-radius:4px}
  .row{display:flex;gap:8px;margin-top:18px}
  button{flex:1;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;cursor:pointer}
  button[value=allow]{background:#222;color:#fff}
  button[value=deny]{background:#fff;color:#222}
  .note{font-size:12px;color:#888;margin-top:18px}
</style>
</head>
<body>
<div class="card">
<h1>Authorize <span class="agent">${escapeHtml(agentName)}</span>?</h1>
<p>This connector will be able to publish, update, read, and list documents on this host as <span class="agent">${escapeHtml(agentName)}</span>. The agent is the unit of provenance and revocation.</p>
<form method="POST" action="${escapeHtml(action)}">
<label for="operator_token">Operator token</label>
<input id="operator_token" name="operator_token" type="password" required autocomplete="off">
<div class="row">
<button type="submit" name="action" value="allow">Allow</button>
<button type="submit" name="action" value="deny">Deny</button>
</div>
</form>
<p class="note">Single-operator v1. To revoke later: <code>DELETE /admin/agents/${escapeHtml(agentName)}</code> (cascades to every key and OAuth client) or <code>DELETE /admin/oauth-clients/&lt;client_id&gt;</code> (rotate this connector only).</p>
</div>
</body>
</html>
`;
}

function errorPage(status: number, message: string, req: Request): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>agent-web-host — error</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222}
.card{max-width:420px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:16px;margin:0 0 12px;color:#a00}p{margin:0;color:#555}</style></head>
<body><div class="card"><h1>${status} ${escapeHtml(req.method)} /authorize</h1>
<p>${escapeHtml(message)}</p></div></body></html>
`;
  return new Response(html, { status, headers: AUTHORIZE_HEADERS });
}
