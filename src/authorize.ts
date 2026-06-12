// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * /authorize — the operator-facing consent screen for Door A.
 *
 * v1 is single-operator: the OAuth flow always lands the same human (the
 * operator) on this page, no matter which agent's connector is authorizing.
 * Auth is EITHER a pasted OPERATOR_TOKEN (synthetic Bearer, CSRF-exempt) OR a
 * browser session cookie (then a `csrf_token` form field is required) — the same
 * ladder `handleRevokeForm` (src/serve.ts) / `postLogout` (src/login.ts) use.
 *
 * Beyond the basic bound-client consent, this page is operator-session-aware and
 * offers three inline repairs so an operator never has to drop to curl:
 *
 *   1. TOFU callback approval — a KNOWN client presenting an UNREGISTERED but
 *      allowlisted-host https redirect_uri gets an "Approve callback" card; on
 *      approve we append it to the client's redirectUris (via updateClient) and
 *      show a Continue interstitial (a human-paced second step that also dodges
 *      KV read-after-write staleness). Never issues a token in the same POST.
 *   2. Bind-or-mint at consent — a client with NO oauth_clients row (an
 *      "unbound" client, minted via POST /admin/oauth-clients) gets a card to
 *      pick an existing agent or mint a new one; "allow" writes the binding row
 *      THEN completes authorization. The binding is the single source of truth
 *      for props.agentId (re-derived after the INSERT, never read from a form).
 *   3. Login-from-/authorize — a requester who isn't authed sees a "Log in as
 *      operator" link to /login?next=<this url>. The link is shown purely on the
 *      requester's own auth state (never on whether the client exists), so it
 *      discloses nothing; after login the operator returns to the same URL and
 *      the repair card renders.
 *
 * Non-operators get a single byte-identical GENERIC error in every repairable
 * state (unbound / unknown-client / bad-redirect) so client existence in KV is
 * never disclosed.
 *
 * Anti-XSS: every dynamic value is HTML-escaped and interpolated only into
 * element text or double-quoted attributes; displayed URLs/hosts/agent names are
 * additionally bidi/zero-width-normalized. CSP is tight (default-src 'none'; no
 * JS); `form-action` is derived from the SAME host allowlist that gates callback
 * approval, so a host the CSP would block can never be approved.
 */

import { authenticateOperator } from "./auth.js";
import { APPROVABLE_CALLBACK_HOSTS } from "./admin-oauth.js";
import type { Env } from "./env.js";
import { newUuid, UUID_RE } from "./ids.js";
import type { AwhProps } from "./mcp-auth.js";
import { normalizeDescriptionForDisplay, normalizeTitleForDisplay } from "./metadata.js";
import {
  authenticateOperatorRequest,
  csrfMatches,
  validateCallbackUri,
} from "./session.js";

/** The one error string returned to every non-operator in any repairable state,
 *  so KV client-existence is never disclosed by differing messages. */
const GENERIC_AUTH_ERROR = "invalid authorization request";

/**
 * `form-action` sources for the consent page — the redirect targets the Allow/Deny
 * form may 302 to. CSP form-action is enforced on EVERY URL in the redirect chain,
 * so a legitimate callback shape MISSING here is BLOCKED in-browser even though the
 * server already issued the code (that's the bug that silently broke the Claude Code
 * CLI loopback connect: 302 returned, browser refused to deliver the code).
 *
 * This is **browser defense-in-depth, NOT the access gate.** The real gate is the
 * OAuth library's per-client registered-`redirect_uri` exact-match + mandatory S256
 * PKCE + the operator consent screen — the form can only ever 302 to a client's
 * provider-VALIDATED registered redirect_uri. So this list's job is just to cover
 * every LEGITIMATE OAuth callback *shape* while still blocking gross targets
 * (`javascript:` / `data:`). It deliberately does **NOT** mirror
 * `APPROVABLE_CALLBACK_HOSTS` (the narrow vendor TOFU allowlist): a validly-
 * registered client routinely uses a target no vendor list would contain (a CLI's
 * loopback, an IDE's custom scheme), so coupling the two is what caused the per-
 * client treadmill. The shapes:
 *   - `https:`                         hosted/web + mobile claimed-https clients
 *   - `http://localhost|127.0.0.1|[::1]:*`   native loopback clients (RFC 8252)
 *   - `vscode:`/`cursor:`/…            IDE custom-scheme deep-link callbacks
 * **Onboarding a client with a new custom scheme?** Add it here (and only here);
 * the library still independently validates the registered redirect_uri. The `[::1]`
 * loopback is best-effort (CSP IPv6 host-source support varies; harmless if ignored).
 */
const CONSENT_FORM_ACTION_SOURCES = [
  "'self'",
  "https:",
  "http://localhost:*",
  "http://127.0.0.1:*",
  "http://[::1]:*",
  // IDE / editor custom-scheme callbacks (best-effort seed list — extend as needed).
  "vscode:",
  "vscode-insiders:",
  "cursor:",
  "windsurf:",
].join(" ");

const AUTHORIZE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `form-action ${CONSENT_FORM_ACTION_SOURCES}`,
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
  const opAuth = await authenticateOperatorRequest(req, env);
  const isOperator = opAuth.ok;
  const csrf = opAuth.ok && opAuth.via === "cookie" ? opAuth.csrf : null;
  const url = new URL(req.url);
  const qs = url.search;
  // The login link is keyed ONLY on the requester's own auth state, never on
  // client state — so it's byte-identical whether or not the client exists.
  const loginNext = isOperator ? null : loginNextFor(url);

  let authReq;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(req);
  } catch {
    // parseAuthRequest throws on unknown/revoked client, malformed params, or an
    // unregistered redirect_uri. Re-derive state from the raw query + lookupClient
    // ourselves — never trust the thrown message string.
    const rawClientId = url.searchParams.get("client_id") ?? "";
    const rawRedirect = url.searchParams.get("redirect_uri");
    const clientInfo = rawClientId ? await env.OAUTH_PROVIDER.lookupClient(rawClientId) : null;

    if (!clientInfo) return errorPage(400, GENERIC_AUTH_ERROR, req, loginNext); // unknown → dead end for all
    if (!isOperator) return errorPage(400, GENERIC_AUTH_ERROR, req, loginNext); // repairs are operator-only

    const normalized = validateCallbackUri(rawRedirect, APPROVABLE_CALLBACK_HOSTS);
    if (!normalized) {
      return errorPage(
        400,
        "callback must be https, on an approved host, with no embedded credentials or fragment",
        req,
        null,
      );
    }
    if (clientInfo.redirectUris.includes(normalized)) {
      // Already registered → the throw was some OTHER param; don't offer TOFU.
      return errorPage(400, GENERIC_AUTH_ERROR, req, null);
    }
    const agent = await lookupAgentForClient(env, rawClientId);
    return new Response(renderApproveCallback(normalized, agent?.name ?? null, qs, csrf), {
      status: 200,
      headers: AUTHORIZE_HEADERS,
    });
  }

  // parseAuthRequest SUCCEEDED → the redirect_uri is registered.
  const agent = await lookupAgentForClient(env, authReq.clientId);
  if (agent) {
    // BOUND client: the normal consent card, now session-aware + login link.
    return new Response(renderConsent(agent.name, qs, csrf, loginNext), {
      status: 200,
      headers: AUTHORIZE_HEADERS,
    });
  }

  // UNBOUND client with a registered redirect: bind-or-mint (operator only).
  if (!isOperator) return errorPage(400, GENERIC_AUTH_ERROR, req, loginNext);
  const agents = await listAgentsForPicker(env);
  return new Response(renderBindOrMint(agents, qs, csrf), {
    status: 200,
    headers: AUTHORIZE_HEADERS,
  });
}

/**
 * Resolve the operator principal for an HTML POST to /authorize. Returns a
 * ready error Response, or null when authorized. Strict, mutually-exclusive
 * ladder (mirrors handleRevokeForm / postLogout) — `requireOperator` is NOT used
 * here because it demands an X-CSRF-Token *header*, which a no-JS form under
 * default-src 'none' cannot send:
 *   1. non-empty operator_token field → synthetic Bearer, CSRF-exempt. Wrong
 *      token → 401 (never silently demote to the cookie path).
 *   2. else valid session cookie → REQUIRE a matching csrf_token form field.
 *   3. else 401.
 */
async function authorizePostOperator(
  req: Request,
  form: FormData,
  env: Env,
): Promise<Response | null> {
  const pasted = String(form.get("operator_token") ?? "");
  if (pasted) {
    const synth = new Request(req.url, { headers: { authorization: `Bearer ${pasted}` } });
    if (!authenticateOperator(synth, env)) return errorPage(401, "operator token incorrect", req, null);
    return null; // bearer-equivalent, CSRF-exempt
  }
  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok || auth.via !== "cookie") {
    return errorPage(401, "operator authentication required", req, loginNextFor(new URL(req.url)));
  }
  if (!csrfMatches(String(form.get("csrf_token") ?? ""), auth.csrf)) {
    return errorPage(403, "CSRF check failed — reload and try again", req, null);
  }
  return null;
}

async function postAuthorize(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const denied = await authorizePostOperator(req, form, env);
  if (denied) return denied;

  const action = String(form.get("action") ?? "");
  const url = new URL(req.url);

  // SINGLE SOURCE OF TRUTH for OAuth params is the request URL (the form action
  // preserves the query). client_id / redirect_uri are NEVER read from form
  // fields — only action / operator_token / csrf_token / agent_* come from body.

  if (action === "allow_callback") {
    const rawClientId = url.searchParams.get("client_id") ?? "";
    const rawRedirect = url.searchParams.get("redirect_uri");
    const clientInfo = rawClientId ? await env.OAUTH_PROVIDER.lookupClient(rawClientId) : null;
    if (!clientInfo) return errorPage(400, GENERIC_AUTH_ERROR, req, null);
    const normalized = validateCallbackUri(rawRedirect, APPROVABLE_CALLBACK_HOSTS);
    if (!normalized) {
      return errorPage(
        400,
        "callback must be https, on an approved host, with no embedded credentials or fragment",
        req,
        null,
      );
    }
    if (!clientInfo.redirectUris.includes(normalized)) {
      await env.OAUTH_PROVIDER.updateClient(rawClientId, {
        redirectUris: [...clientInfo.redirectUris, normalized], // APPEND, never replace
      });
    }
    // Success interstitial with a Continue link — distinct from issuing a grant,
    // and the human click absorbs KV propagation delay before the re-parse.
    return new Response(renderCallbackApproved(normalized, "/authorize" + url.search), {
      status: 200,
      headers: AUTHORIZE_HEADERS,
    });
  }

  // allow / deny need a parsed (registered) authReq.
  let authReq;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(req);
  } catch {
    // Throw-state: redirect not registered/visible yet. NEVER redirect to a raw URI.
    if (action === "deny") {
      return new Response(renderInfo("Request denied", "The authorization request was denied."), {
        status: 200,
        headers: AUTHORIZE_HEADERS,
      });
    }
    return errorPage(409, "callback not yet active — wait a moment and use Continue to retry", req, null);
  }

  if (action === "deny") {
    const denyUrl = new URL(authReq.redirectUri); // registered → safe to redirect to
    denyUrl.searchParams.set("error", "access_denied");
    denyUrl.searchParams.set("error_description", "operator denied the request");
    if (authReq.state) denyUrl.searchParams.set("state", authReq.state);
    return Response.redirect(denyUrl.toString(), 302);
  }
  if (action !== "allow") return errorPage(400, "missing or invalid action", req, null);

  // Resolve / mint the agent, derive a SINGLE agentId, bind, then complete.
  let agent = await lookupAgentForClient(env, authReq.clientId);
  if (!agent) {
    // UNBOUND bind-or-mint. We only reach durable state AFTER the successful
    // re-parse above (which proves the redirect is registered + KV-visible).
    const mode = String(form.get("agent_mode") ?? "");
    let resolvedAgentId: string;

    if (mode === "new") {
      const name = String(form.get("agent_name") ?? "").trim();
      if (name.length === 0 || name.length > 200) {
        return errorPage(400, "agent name must be 1–200 characters", req, null);
      }
      resolvedAgentId = newUuid();
      // Single batch: agents INSERT + binding INSERT are all-or-nothing, so a
      // failed bind (e.g. client_id already bound in a race) leaves no orphan
      // agent. UNIQUE(agent_id) can't collide for a brand-new id.
      try {
        await env.META.batch([
          env.META.prepare("insert into agents (id, name) values (?, ?)").bind(resolvedAgentId, name),
          env.META.prepare("insert into oauth_clients (client_id, agent_id) values (?, ?)").bind(
            authReq.clientId,
            resolvedAgentId,
          ),
        ]);
      } catch {
        return errorPage(409, "this client was just bound — reload to continue", req, null);
      }
    } else if (mode === "existing") {
      const agentId = String(form.get("agent_id") ?? "");
      if (!UUID_RE.test(agentId)) return errorPage(400, "invalid agent selection", req, null);
      const exists = await env.META.prepare("select id from agents where id = ?")
        .bind(agentId)
        .first<{ id: string }>();
      if (!exists) return errorPage(400, "invalid agent selection", req, null);
      resolvedAgentId = agentId;
      try {
        await env.META.prepare("insert into oauth_clients (client_id, agent_id) values (?, ?)")
          .bind(authReq.clientId, resolvedAgentId)
          .run();
      } catch {
        // UNIQUE(agent_id) or client_id PK → already bound. The constraint is the
        // authority, never a pre-check (avoids a check-then-act race).
        return errorPage(409, "that agent is already bound to another OAuth client", req, null);
      }
    } else {
      return errorPage(400, "choose an existing agent or mint a new one", req, null);
    }

    // The binding is the SINGLE source of truth for props — re-derive it, never
    // trust the submitted agent id directly.
    agent = await lookupAgentForClient(env, authReq.clientId);
    if (!agent || agent.id !== resolvedAgentId) {
      return errorPage(500, "bind verification failed", req, null);
    }
  }

  // Issue the grant. props is the AwhProps that flows to every MCP tool call via
  // ctx.props (apiHandler path) — same shape Door B yields.
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
    return errorPage(500, `completeAuthorization failed: ${String((err as Error).message ?? err)}`, req, null);
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

/** Newest-first agents for the bind-or-mint picker. Capped at 100 (v1 — single
 *  operator, small fleet); add pagination/free-text id entry if it grows. */
async function listAgentsForPicker(env: Env): Promise<{ id: string; name: string }[]> {
  const r = await env.META.prepare(
    "select id, name from agents order by created_at desc, id desc limit 100",
  ).all<{ id: string; name: string }>();
  return r.results ?? [];
}

/** Build a safe /login?next= back to this exact /authorize URL (path+query). */
function loginNextFor(url: URL): string {
  return "/login?next=" + encodeURIComponent(url.pathname + url.search);
}

/** Host of a normalized https URL, for prominent display. */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
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

// -- rendering ----------------------------------------------------------------

const PAGE_STYLE = `
  body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
  .card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
  h1{font-size:18px;margin:0 0 12px;font-weight:600}
  .card.err h1{font-size:16px;color:#a00}
  p{margin:0 0 16px;color:#555}
  .agent,.host{font-weight:600;color:#222}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all;color:#333}
  label{display:block;margin:18px 0 6px;font-size:13px;color:#555}
  input[type=password],input[type=text],select{width:100%;box-sizing:border-box;padding:9px 10px;font:13px/1.4 system-ui,sans-serif;border:1px solid #ccc;border-radius:4px}
  .opt{margin:10px 0 4px;font-size:13px;color:#333}
  .opt input{margin-right:6px}
  .row{display:flex;gap:8px;margin-top:18px}
  button{flex:1;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;cursor:pointer}
  button[value=allow],button[value=allow_callback],button.primary{background:#222;color:#fff}
  button[value=deny]{background:#fff;color:#222}
  a.btn{flex:1;display:inline-block;text-align:center;text-decoration:none;padding:10px 14px;border:1px solid #222;border-radius:4px;background:#222;color:#fff}
  .callout{background:#f6f8fa;border:1px solid #e5e5e5;border-radius:6px;padding:12px 14px;margin:0 0 16px}
  .callout div+div{margin-top:6px}
  .note{font-size:12px;color:#888;margin-top:18px}
  .note a,p a{color:#357}
`;

function shell(inner: string, cardClass = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Slopcafe — authorize</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="card${cardClass ? " " + cardClass : ""}">
${inner}
</div>
</body>
</html>
`;
}

/** The auth portion of any consent form: hidden CSRF echo (cookie session) or a
 *  pasted-token field (no session / bearer). */
function authFormFields(csrf: string | null): string {
  if (csrf) return `<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">`;
  return `<label for="operator_token">Operator token</label>
<input id="operator_token" name="operator_token" type="password" required autocomplete="off">`;
}

function loginNote(loginNext: string | null): string {
  if (!loginNext) return "";
  return `<p class="note"><a href="${escapeHtml(loginNext)}">Log in as operator</a> to skip pasting the token.</p>`;
}

function renderConsent(
  agentName: string,
  querystring: string,
  csrf: string | null,
  loginNext: string | null,
): string {
  const action = `/authorize${escapeHtml(querystring)}`;
  return shell(`<h1>Authorize <span class="agent">${escapeHtml(agentName)}</span>?</h1>
<p>This connector will be able to publish, update, read, and list documents on this host as <span class="agent">${escapeHtml(agentName)}</span>. The agent is the unit of provenance and revocation.</p>
<form method="POST" action="${action}">
${authFormFields(csrf)}
<div class="row">
<button type="submit" name="action" value="allow">Allow</button>
<button type="submit" name="action" value="deny">Deny</button>
</div>
</form>
${loginNote(loginNext)}`);
}

function renderApproveCallback(
  normalizedUri: string,
  agentName: string | null,
  querystring: string,
  csrf: string | null,
): string {
  const action = `/authorize${escapeHtml(querystring)}`;
  const who = agentName
    ? `Connector <span class="agent">${escapeHtml(agentName)}</span> is`
    : "This connector is";
  return shell(`<h1>Approve a new callback?</h1>
<p>${who} requesting a redirect to a callback URL that isn't registered for it yet. Approving remembers this URL for this client.</p>
<div class="callout">
<div>Callback host: <span class="host">${escapeHtml(normalizeTitleForDisplay(hostOf(normalizedUri)))}</span></div>
<div class="mono">${escapeHtml(normalizeDescriptionForDisplay(normalizedUri))}</div>
</div>
<p>Only approve if you recognize this host as the connector you are setting up — authorization codes will be sent here.</p>
<form method="POST" action="${action}">
${authFormFields(csrf)}
<div class="row">
<button type="submit" name="action" value="allow_callback" class="primary">Approve callback</button>
<button type="submit" name="action" value="deny">Cancel</button>
</div>
</form>`);
}

function renderCallbackApproved(normalizedUri: string, continueHref: string): string {
  return shell(`<h1>Callback approved</h1>
<p>Registered <span class="host">${escapeHtml(normalizeTitleForDisplay(hostOf(normalizedUri)))}</span> for this client. Continue to finish authorizing — if it isn't active yet, wait a moment and try again.</p>
<div class="row">
<a class="btn" href="${escapeHtml(continueHref)}">Continue</a>
</div>`);
}

function renderBindOrMint(
  agents: { id: string; name: string }[],
  querystring: string,
  csrf: string | null,
): string {
  const action = `/authorize${escapeHtml(querystring)}`;
  const hasAgents = agents.length > 0;
  const options = agents
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`)
    .join("");
  const existingBlock = hasAgents
    ? `<div class="opt"><label><input type="radio" name="agent_mode" value="existing" checked> Use an existing agent</label></div>
<select name="agent_id">${options}</select>`
    : "";
  return shell(`<h1>Bind this connector to an agent</h1>
<p>This OAuth client isn't bound to an agent yet. Choose the identity it will publish as — pick an existing agent or mint a new one. The agent is the unit of provenance and revocation.</p>
<form method="POST" action="${action}">
${existingBlock}
<div class="opt"><label><input type="radio" name="agent_mode" value="new"${hasAgents ? "" : " checked"}> Mint a new agent</label></div>
<input type="text" name="agent_name" placeholder="New agent name" maxlength="200" autocomplete="off">
${authFormFields(csrf)}
<div class="row">
<button type="submit" name="action" value="allow">Allow</button>
<button type="submit" name="action" value="deny">Deny</button>
</div>
</form>`);
}

function renderInfo(title: string, message: string): string {
  return shell(`<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>`);
}

function errorPage(
  status: number,
  message: string,
  req: Request,
  loginNext: string | null,
): Response {
  const inner = `<h1>${status} ${escapeHtml(req.method)} /authorize</h1>
<p>${escapeHtml(message)}</p>
${loginNext ? `<p class="note"><a href="${escapeHtml(loginNext)}">Log in as operator</a> and retry.</p>` : ""}`;
  return new Response(shell(inner, "err"), { status, headers: AUTHORIZE_HEADERS });
}
