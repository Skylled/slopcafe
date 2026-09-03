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
 * JUDGEABLE CLIENT IDENTITY (see `renderClientIdentity`). `/register` (RFC 7591
 * DCR) is open and accepts PUBLIC clients, so ANYONE can mint a client_id with
 * their own redirect_uri and mail the operator an /authorize link. Consent is the
 * only human gate, so every consent card MUST show what is actually being
 * granted. The ordering is deliberate and load-bearing:
 *   - The **callback address** leads, visually prominent. It is the ONLY
 *     unforgeable signal on the page: it is where the authorization code is
 *     physically delivered, and the provider matched it against this client's
 *     registered redirect_uris. Everything else is self-asserted.
 *   - `clientName` is rendered as a CLAIM ("calls itself …"), explicitly marked
 *     self-reported, never styled as an identity assertion — a self-registered
 *     client can call itself "Claude".
 *   - `client_id`, registration age, and client type (public/confidential) are
 *     shown as raw facts. A client registered SECONDS ago and reached via a
 *     mailed link is the signature of the mail-the-operator-a-link attack; a
 *     public/secretless client is NOT suspicious on its own (native CLIs must be
 *     public — RFC 8252), so it is labelled, never flagged.
 * There is deliberately NO per-vendor allowlist in the rendering path: the card
 * works by showing the host, whatever it is, and letting the operator judge.
 * `logoUri` / `clientUri` / `tosUri` / `policyUri` are deliberately NOT rendered
 * — an attacker-supplied image or link is a phishing aid, not evidence.
 *
 * Anti-XSS: every dynamic value is HTML-escaped and interpolated only into
 * element text or double-quoted attributes; displayed URLs/hosts/agent/client
 * names are additionally bidi/zero-width-normalized (`displaySafe`). CSP is tight
 * (default-src 'none'; no JS, no images); `form-action` is the deliberately broad
 * `CONSENT_FORM_ACTION_SOURCES` — browser defense-in-depth, NOT the access gate.
 */

import type { ClientInfo } from "@cloudflare/workers-oauth-provider";

import { recordAudit, requestIdOf } from "./audit.js";
import { authenticateOperator } from "./auth.js";
import { APPROVABLE_CALLBACK_HOSTS } from "./admin-oauth.js";
import type { Env } from "./env.js";
import { newUuid, UUID_RE } from "./ids.js";
import type { AwhProps } from "./mcp-auth.js";
import type { WaitUntil } from "./vector-io.js";
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

export async function handleAuthorize(
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  if (req.method === "GET") return await getAuthorize(req, env);
  // `waitUntil` carries the audit ledger's writes (migration 0020 / issue #62).
  // Only the POST path decides anything: a GET renders a card and changes no
  // state, so it files nothing.
  if (req.method === "POST") return await postAuthorize(req, env, waitUntil);
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
    return new Response(
      renderApproveCallback(clientInfo, normalized, agent?.name ?? null, qs, csrf),
      { status: 200, headers: AUTHORIZE_HEADERS },
    );
  }

  // parseAuthRequest SUCCEEDED → the client exists AND the redirect_uri is one of
  // its REGISTERED uris (that match is what makes the address worth displaying).
  // lookupClient adds no existence signal here: we only reach this line when the
  // client provably exists, and a null result renders the same card minus the
  // self-asserted fields.
  const clientInfo = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
  const agent = await lookupAgentForClient(env, authReq.clientId);
  if (agent) {
    // BOUND client: the normal consent card, now session-aware + login link.
    return new Response(
      renderConsent(agent.name, clientInfo, authReq.redirectUri, qs, csrf, loginNext),
      { status: 200, headers: AUTHORIZE_HEADERS },
    );
  }

  // UNBOUND client with a registered redirect: bind-or-mint (operator only).
  if (!isOperator) return errorPage(400, GENERIC_AUTH_ERROR, req, loginNext);
  const agents = await listAgentsForPicker(env);
  return new Response(renderBindOrMint(agents, clientInfo, authReq.redirectUri, qs, csrf), {
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

async function postAuthorize(
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
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
      // Ledger (0020): the operator just taught this client a NEW address to
      // receive authorization codes at — the single highest-consequence edit
      // reachable from the consent screen, and it lives only in the provider's
      // KV record. The URI is the approved artifact, not a credential, so it is
      // exactly what a later reader needs.
      recordAudit(env, waitUntil, {
        kind: "callback_approved",
        principal_kind: "operator",
        client_id: rawClientId,
        callback_uri: normalized,
        request_id: requestIdOf(req),
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
    recordAudit(env, waitUntil, {
      kind: "consent_denied",
      principal_kind: "operator",
      client_id: authReq.clientId,
      request_id: requestIdOf(req),
    });
    const denyUrl = new URL(authReq.redirectUri); // registered → safe to redirect to
    denyUrl.searchParams.set("error", "access_denied");
    denyUrl.searchParams.set("error_description", "operator denied the request");
    if (authReq.state) denyUrl.searchParams.set("state", authReq.state);
    return Response.redirect(appendIssParam(denyUrl.toString(), url.origin), 302);
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

    // Ledger (0020): the moment a previously UNBOUND client — including any
    // self-registered DCR client, which arrives with no D1 row at all — gains
    // an identity and, with it, the whole corpus. `mode` distinguishes "pinned
    // to an agent that already existed" from "an agent was created for it right
    // here". Filed only after the binding is re-read back from D1, so the row
    // records the binding that actually landed, never the form's claim.
    recordAudit(env, waitUntil, {
      kind: "oauth_client_bound",
      principal_kind: "operator",
      client_id: authReq.clientId,
      agent_id: agent.id,
      mode: mode === "new" ? "new" : "existing",
      request_id: requestIdOf(req),
    });
  }

  // Issue the grant. props is the AwhProps that flows to every MCP tool call via
  // ctx.props (apiHandler path) — same shape Door B yields.
  //
  // `clientId` (migration 0019 / issue #63) is taken from `authReq`, the request
  // object the PROVIDER parsed and validated against the registered client — the
  // same object `authReq.redirectUri` (which we are about to redirect to) and
  // the binding lookup above come from. It is emphatically NOT read from `form`:
  // the consent form is submitted by whoever opened the link, so a form field
  // would let a requester write any string it liked into the audit trail. This
  // sits at the exact point `agent` is guaranteed to be the binding's agent, so
  // the pair (agentId, clientId) recorded on every version is consistent by
  // construction. Door B has no client and passes null.
  const props: AwhProps = { agentId: agent.id, clientId: authReq.clientId, via: "oauth" };
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
  // Ledger (0020), filed only once the grant actually exists: an "allowed" row
  // for a request that then failed to complete would be the ledger asserting
  // authority that was never issued. The pair (agent, client) is the one the
  // grant carries — `props` above, straight from the provider-validated
  // authorization request.
  recordAudit(env, waitUntil, {
    kind: "consent_allowed",
    principal_kind: "operator",
    agent_id: agent.id,
    client_id: authReq.clientId,
    request_id: requestIdOf(req),
  });
  return Response.redirect(appendIssParam(redirectTo, url.origin), 302);
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

/**
 * RFC 9207 (§2): stamp the `iss` parameter onto an authorization response
 * redirect, so a client talking to several authorization servers can verify
 * WHICH server answered before redeeming the code (the mix-up attack). Applied
 * to EVERY authorization response our code 302s to a client callback — the
 * allow path (bound consent AND bind-or-mint, which converge on one
 * completeAuthorization) and the deny path alike; error states that render
 * HTML in place never reach the callback, so `iss` does not apply to them.
 *
 * The issuer is the request origin, matching how the rest of the repo derives
 * self-URLs (/healthz, API_DISCOVERY_HINT), so dev/staging stamp themselves.
 *
 * Pure and defensive: parsed with the WHATWG URL API so custom schemes
 * (`vscode://…`) and loopback http both work; `searchParams.set` OVERWRITES an
 * existing `iss` (if the provider library ever starts emitting RFC 9207
 * natively — it does not as of 0.8.2 — we must not produce a duplicate or a
 * conflict) and leaves every other param (`code`, `state`) and any fragment
 * untouched. An unparseable location is returned unchanged rather than thrown
 * on — unreachable from the live paths, where the provider itself built the
 * URL from a registered redirect_uri.
 */
export function appendIssParam(location: string, issuer: string): string {
  let u: URL;
  try {
    u = new URL(location);
  } catch {
    return location;
  }
  u.searchParams.set("iss", issuer);
  return u.toString();
}

/** Host of a normalized https URL, for prominent display. */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

// -- client-identity description ----------------------------------------------
//
// Every value below is ATTACKER-CONTROLLED (a self-registered client picks its
// own name and redirect_uri). The pipeline for all of them is:
//   raw → displaySafe() [NFC + strip bidi/zero-width/controls + fold ws + cap]
//       → escapeHtml() at interpolation.
// Sentences are composed from ALREADY-normalized fragments so the fixed prose
// can never be truncated by the normalizer's length cap.

/** Length cap applied by `normalizeDescriptionForDisplay` (metadata.ts). */
const DISPLAY_CAP = 500;

/**
 * Display-normalize one untrusted fragment: NFC, strip C0/C1 + bidi overrides
 * and isolates + zero-width joiners/BOM, collapse whitespace, trim, cap.
 *
 * The cap is flagged rather than silent: for a hostname the registrable domain
 * lives at the END, so a quietly-truncated 600-char host could hide `.evil.com`
 * behind a wall of padding. (Marking a legitimately-500-char value is a harmless
 * false positive; hiding a tail would be a false negative.)
 */
function displaySafe(raw: string): string {
  const out = normalizeDescriptionForDisplay(raw);
  return out.length >= DISPLAY_CAP ? out + " [truncated]" : out;
}

/**
 * Loopback hostnames as WHATWG `URL.hostname` presents them — an IPv6 literal
 * keeps its brackets (`http://[::1]:9000` → `"[::1]"`), matching the same set in
 * session.ts. `127.0.0.0/8` is all loopback, and RFC 6761 reserves `.localhost`.
 */
function isLoopbackHostname(hostname: string): boolean {
  // EXACT `localhost` only — deliberately NOT `*.localhost`. A subdomain is
  // attacker-choosable, so `claude.ai.localhost:9999` would otherwise put a
  // familiar-looking name in the bold headline AND collect the reassuring "an
  // application on THIS machine" framing. RFC 6761 does reserve the whole
  // `.localhost` tree for loopback, but resolution is resolver-dependent, and
  // the OAuth library's own `isLoopbackUri` accepts only the exact name — two
  // components disagreeing about the same URI is worse than being strict here.
  if (hostname === "localhost") return true;
  if (hostname === "[::1]" || hostname === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Schemes that genuinely denote an OS-level handoff to a locally-installed
 * application, and so may carry the "an application on THIS machine" framing.
 *
 * Kept as a CLOSED list because that sentence is *reassuring*, and an
 * attacker picks the scheme: an open catch-all rendered `evilapp://claude.ai`
 * as a local handoff, putting an attacker-chosen familiar-looking string in the
 * bold headline under a sentence saying it stays on this machine. Anything not
 * listed here is described neutrally and cautioned instead.
 *
 * Mirrors the IDE schemes in `CONSENT_FORM_ACTION_SOURCES` — keep the two in
 * step when onboarding a client that uses a new scheme.
 */
const IDE_CALLBACK_SCHEMES = new Set(["vscode", "vscode-insiders", "cursor", "windsurf"]);

/**
 * Escaped host with its TRAILING labels emphasized and the leading ones muted.
 *
 * This is the single most important pixel on the card. Rendered as one uniform
 * bold string, `claude.ai.evil.example` reads left-to-right and a hurried eye
 * stops at `claude.ai` — which is the entire subdomain-confusion attack, and it
 * defeats every other signal here because the operator believes they have
 * already identified the destination.
 *
 * NOT a Public Suffix List lookup — it is a last-two-labels heuristic, so for a
 * multi-part suffix (`example.co.uk`) it emphasizes `co.uk` rather than the
 * registrable domain. That is why the surrounding copy says "the END of this
 * address decides where the code goes" rather than claiming to name the owner:
 * the tail is always the authoritative part, whatever the eye wants to read
 * first, and shipping a PSL into a Worker to sharpen a visual hint is not worth
 * the bytes.
 */
export function emphasizeHostTail(host: string): string {
  const [name, ...rest] = host.split(":");
  const port = rest.length ? `:${rest.join(":")}` : "";
  const hostname = name ?? "";
  // An IP literal or a single label has no meaningful split; bracketed IPv6
  // contains colons that are not a port, so it lands here too.
  const labels = hostname.split(".");
  if (hostname.startsWith("[") || labels.length < 3 || /^\d+$/.test(labels[labels.length - 1] ?? "")) {
    return escapeHtml(host);
  }
  const tail = labels.slice(-2).join(".");
  const lead = labels.slice(0, -2).join(".");
  return `<span class="sub">${escapeHtml(lead)}.</span>${escapeHtml(tail + port)}`;
}

type CallbackDisplay = {
  /**
   * The prominent, unforgeable line: where the code is physically delivered.
   * ALREADY-ESCAPED HTML — it carries the `emphasizeHostTail` markup — so the
   * render site interpolates it RAW. Every path that builds it must escape its
   * own dynamic parts; never assign an un-escaped value here.
   */
  headline: string;
  /** One sentence saying what that means in plain words. */
  where: string;
  /** The full callback URI, for the mono line. */
  uri: string;
  /** Extra warnings (cleartext, punycode, unparseable). Usually empty. */
  cautions: string[];
};

/**
 * Describe a callback URI for a human, with NO per-vendor allowlist — the card's
 * whole job is to show the host, whatever it is, and let the operator judge.
 *
 * Homograph/punycode: WHATWG `URL` applies IDNA ToASCII, so `URL.host` is already
 * the punycode (`xn--…`) form. That is exactly the form we want — `xn--pple-43d.com`
 * is unmistakably not `apple.com`, whereas the Unicode rendering is designed to be
 * mistakable. We display the ASCII form and additionally call out any `xn--` label,
 * since a punycode host in an OAuth callback is rare and worth a second look.
 */
export function describeCallback(rawUri: string): CallbackDisplay {
  let u: URL | null = null;
  try {
    u = new URL(rawUri);
  } catch {
    u = null;
  }
  if (!u) {
    return {
      headline: escapeHtml("unreadable address"),
      where: "This request's callback address could not be parsed as a URL. Do not continue.",
      uri: displaySafe(rawUri),
      cautions: ["The callback address is malformed."],
    };
  }

  const scheme = displaySafe(u.protocol.replace(/:$/, ""));
  const host = displaySafe(u.host);
  const uri = displaySafe(u.toString());
  const cautions: string[] = [];
  if (host.includes("xn--")) {
    cautions.push(
      'This host contains an internationalized ("xn--", punycode) label. Read it character by character — such names are usually built to resemble a familiar one.',
    );
  }
  // Embedded userinfo is the oldest URL-spoofing trick there is: everything
  // before the "@" is credentials, NOT the destination, so
  // `https://claude.ai@evil.example/cb` delivers the code to evil.example while
  // the full-URI line reads as claude.ai. The headline above already shows the
  // real host (URL.host excludes userinfo) — this caution exists because the
  // mono line prints the URI verbatim and reads as the authoritative detail.
  // `validateCallbackUri` (session.ts) rejects userinfo outright on the TOFU
  // path; a REGISTERED redirect_uri never passed through that gate, so this is
  // the only place the shape is surfaced.
  if (u.username !== "" || u.password !== "") {
    cautions.push(
      'This address embeds credentials before an "@" sign. Everything before the "@" is NOT the destination — only the host shown above is. This is the classic way a callback is dressed up to look like a familiar service.',
    );
  }

  if (u.protocol === "https:") {
    return {
      headline: emphasizeHostTail(host),
      where: `The authorization code for this connection will be sent to ${host} over https. The END of that address decides where it goes — only continue if it is the service you just asked to connect.`,
      uri,
      cautions,
    };
  }

  if (u.protocol === "http:" && isLoopbackHostname(u.hostname)) {
    return {
      headline: `${escapeHtml(host)} — an application on THIS machine`,
      where:
        "The authorization code will be handed to a program listening on this machine's loopback address. That is the normal shape for a command-line or desktop client you launched yourself a moment ago.",
      uri,
      cautions,
    };
  }

  if (u.protocol === "http:") {
    cautions.push(
      "This callback is plain http to a remote host, so the authorization code would cross the network unencrypted.",
    );
    return {
      headline: emphasizeHostTail(host),
      where: `The authorization code for this connection will be sent to ${host} over UNENCRYPTED http. The END of that address decides where it goes.`,
      uri,
      cautions,
    };
  }

  // Custom scheme — an OS-level handoff, not a network hop, but ONLY for the
  // schemes we actually recognize. The friendly "THIS machine" framing is
  // reassuring, and the scheme is attacker-chosen: an open catch-all rendered
  // `evilapp://claude.ai` as a local handoff, which is a familiar-looking
  // string in the bold headline under a sentence promising it stays local.
  const target = host ? `${scheme}://${host}` : `${scheme}:`;
  if (IDE_CALLBACK_SCHEMES.has(scheme)) {
    return {
      headline: `${escapeHtml(target)} — an application on THIS machine`,
      where: `The authorization code will be handed to whichever application on this machine has registered the "${scheme}:" URL scheme (typically an editor or IDE). Only continue if you started this connection from that application.`,
      uri,
      cautions,
    };
  }
  // Unrecognized scheme. The OAuth library rejects the actively dangerous ones
  // (javascript:, data:, file:, …) before we are ever reached, so this is a
  // defence-in-depth shape rather than a live path — described neutrally, with
  // no claim about where the code ends up, because we genuinely do not know.
  cautions.push(
    `This callback uses the unrecognized "${scheme}:" scheme. Slopcafe cannot tell you where a code sent there would end up. Do not continue unless you recognize it.`,
  );
  return {
    headline: escapeHtml(target),
    where: `The authorization code would be handed to whatever is registered to handle "${scheme}:" — this is not a shape Slopcafe recognizes.`,
    uri,
    cautions,
  };
}

/** A client registered within this window is "moments ago" — see renderClientIdentity. */
const FRESH_CLIENT_MS = 10 * 60 * 1000;

/**
 * Human age of a client registration. `registrationDate` is a UNIX time in
 * SECONDS, stamped by the provider library on BOTH `/register` (DCR) and
 * `createClient` (operator mint) — so it dates the record, it does not reveal
 * which door made it.
 */
function describeRegistration(
  registrationDate: number | undefined,
  nowMs: number,
): { text: string; fresh: boolean } {
  if (typeof registrationDate !== "number" || !Number.isFinite(registrationDate)) {
    return { text: "unknown", fresh: false };
  }
  const thenMs = registrationDate * 1000;
  const ageMs = nowMs - thenMs;
  if (ageMs < 0) return { text: "dated in the future (clock skew)", fresh: true };

  const day = new Date(thenMs).toISOString().slice(0, 10);
  const secs = Math.floor(ageMs / 1000);
  if (secs < 60) return { text: `${secs} second${secs === 1 ? "" : "s"} ago`, fresh: true };
  const mins = Math.floor(secs / 60);
  if (mins < 60) return { text: `${mins} minute${mins === 1 ? "" : "s"} ago`, fresh: ageMs < FRESH_CLIENT_MS };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { text: `${hours} hour${hours === 1 ? "" : "s"} ago (${day})`, fresh: false };
  const days = Math.floor(hours / 24);
  return { text: `${days} day${days === 1 ? "" : "s"} ago (${day})`, fresh: false };
}

/**
 * Client type from `tokenEndpointAuthMethod`. Deliberately NEUTRAL about public
 * clients: a native CLI has nowhere to keep a secret, so "public" is the required
 * shape for `claude mcp add`, not a red flag.
 */
function describeClientType(method: string | undefined): string {
  if (method === "none") {
    return "public — holds no client secret (the required shape for command-line and desktop clients)";
  }
  if (method === "client_secret_basic" || method === "client_secret_post") {
    return "confidential — authenticates with a client secret";
  }
  if (!method) return "unknown";
  return displaySafe(method);
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
  .host .sub{font-weight:400;color:#8a8a8a}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all;color:#333}
  label{display:block;margin:18px 0 6px;font-size:13px;color:#555}
  input[type=password],input[type=text],select{width:100%;box-sizing:border-box;padding:9px 10px;font:13px/1.4 system-ui,sans-serif;border:1px solid #ccc;border-radius:4px}
  .opt{margin:10px 0 4px;font-size:13px;color:#333}
  .opt input{margin-right:6px}
  /* row-reverse is LOAD-BEARING, not cosmetic. A form's "default button" (the
     one implicit submission fires when the operator presses Enter in a text
     field — the pasted operator_token box, or the new-agent-name box) is the
     FIRST submit button in DOM ORDER. Allow must therefore never be first in the
     markup, or Enter grants fleet-wide access without a deliberate click. The
     deny/cancel button is emitted first and this flips the visual order back, so
     Enter denies and tab lands on deny first. Keep them in sync: if you reorder
     the buttons in the markup, reorder this. */
  .row{display:flex;flex-direction:row-reverse;gap:8px;margin-top:18px}
  button{flex:1;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;cursor:pointer}
  button[value=allow],button[value=allow_callback],button.primary{background:#222;color:#fff}
  button[value=deny]{background:#fff;color:#222}
  a.btn{flex:1;display:inline-block;text-align:center;text-decoration:none;padding:10px 14px;border:1px solid #222;border-radius:4px;background:#222;color:#fff}
  .callout{background:#f6f8fa;border:1px solid #e5e5e5;border-radius:6px;padding:12px 14px;margin:0 0 16px}
  .callout div+div{margin-top:6px}
  .note{font-size:12px;color:#888;margin-top:18px}
  .note a,p a{color:#357}
  /* --- judgeable client identity (renderClientIdentity) --------------------- */
  .callout.cb{background:#fffaf2;border-color:#e8d5b0}
  .cblabel{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a6d3b}
  .callout.cb .host{display:block;font-size:16px;line-height:1.35;overflow-wrap:anywhere;word-break:break-word}
  .where{font-size:12.5px;color:#555}
  .warn{font-size:12.5px;color:#a00}
  .meta{font-size:12.5px;color:#555;overflow-wrap:anywhere}
  .meta .val{color:#222}
  /* A self-reported name is a CLAIM: quoted, never bolded like an identity. */
  .claim{font-style:italic;color:#333}
  .unver{font-size:11px;color:#8a6d3b;background:#fdf3e3;border:1px solid #e8d5b0;border-radius:3px;padding:1px 5px;white-space:nowrap}
  .fresh{color:#a00}
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

/**
 * The shared "who is actually asking" block, rendered on EVERY consent-shaped
 * card (bound consent, bind-or-mint, TOFU callback approval).
 *
 * Order is the security argument (see the file header): the callback address
 * leads because it is the only unforgeable thing here — it is where the code is
 * delivered, and the provider validated it against this client's registered
 * redirect_uris. The self-asserted fields follow, labelled as claims.
 *
 * @param client      the KV client record (null → render facts we still have)
 * @param callbackUri the address this request will deliver the code to
 * @param leadLabel   the small caps label above the address
 * @param nowMs       injected for determinism/testability
 */
function renderClientIdentity(
  client: ClientInfo | null,
  callbackUri: string,
  leadLabel = "Authorization code goes to",
  nowMs: number = Date.now(),
): string {
  const cb = describeCallback(callbackUri);
  const cautions = cb.cautions
    .map((c) => `<div class="warn">${escapeHtml(c)}</div>`)
    .join("");

  const rawName = client?.clientName ?? "";
  const name = rawName ? displaySafe(rawName) : "";
  // "Calls itself" + quotes + the unverified chip: a client naming itself after a
  // vendor should read as a claim under scrutiny, never as a badge of identity.
  const nameRow = name
    ? `<div class="meta">Calls itself <span class="claim">&ldquo;${escapeHtml(name)}&rdquo;</span> <span class="unver">self-reported</span></div>`
    : `<div class="meta">Calls itself <span class="claim">(no name supplied)</span> <span class="unver">self-reported</span></div>`;

  const clientId = client?.clientId ? displaySafe(client.clientId) : "(unavailable)";
  const reg = describeRegistration(client?.registrationDate, nowMs);
  const regRow = reg.fresh
    ? `<div class="meta">Registered <span class="val fresh">${escapeHtml(reg.text)}</span> — this client record was created moments ago. Expected if you started a connect flow just now; a warning sign if you arrived here from a link someone sent you.</div>`
    : `<div class="meta">Registered <span class="val">${escapeHtml(reg.text)}</span></div>`;

  return `<div class="callout cb">
<div class="cblabel">${escapeHtml(leadLabel)}</div>
<div class="host">${cb.headline}</div>
<div class="mono">${escapeHtml(cb.uri)}</div>
<div class="where">${escapeHtml(cb.where)}</div>
${cautions}
</div>
<div class="callout">
${nameRow}
<div class="meta">Client ID <span class="mono val">${escapeHtml(clientId)}</span></div>
${regRow}
<div class="meta">Client type: <span class="val">${escapeHtml(describeClientType(client?.tokenEndpointAuthMethod))}</span></div>
</div>
<p class="note">Anyone can register a client on this host and choose its own name, so the name above proves nothing — a hostile client can call itself after any vendor you trust. The callback address is the part it cannot fake: that is where the authorization code is delivered. Continue only if you started this connection yourself and recognize that address.</p>`;
}

function loginNote(loginNext: string | null): string {
  if (!loginNext) return "";
  return `<p class="note"><a href="${escapeHtml(loginNext)}">Log in as operator</a> to skip pasting the token.</p>`;
}

function renderConsent(
  agentName: string,
  client: ClientInfo | null,
  callbackUri: string,
  querystring: string,
  csrf: string | null,
  loginNext: string | null,
): string {
  const action = `/authorize${escapeHtml(querystring)}`;
  const who = escapeHtml(normalizeTitleForDisplay(agentName));
  return shell(`<h1>Authorize <span class="agent">${who}</span>?</h1>
<p>Allowing this lets the connector below publish, update, read, and list <strong>every document on this host</strong> as <span class="agent">${who}</span>. The agent is the unit of provenance and revocation.</p>
${renderClientIdentity(client, callbackUri)}
<form method="POST" action="${action}">
${authFormFields(csrf)}
<div class="row">
<button type="submit" name="action" value="deny">Deny</button>
<button type="submit" name="action" value="allow">Allow</button>
</div>
</form>
${loginNote(loginNext)}`);
}

function renderApproveCallback(
  client: ClientInfo | null,
  normalizedUri: string,
  agentName: string | null,
  querystring: string,
  csrf: string | null,
): string {
  const action = `/authorize${escapeHtml(querystring)}`;
  const who = agentName
    ? `Connector <span class="agent">${escapeHtml(normalizeTitleForDisplay(agentName))}</span> is`
    : "This connector is";
  return shell(`<h1>Approve a new callback?</h1>
<p>${who} requesting a redirect to a callback URL that isn't registered for it yet. Approving remembers this URL for this client.</p>
${renderClientIdentity(client, normalizedUri, "New callback to approve")}
<form method="POST" action="${action}">
${authFormFields(csrf)}
<div class="row">
<button type="submit" name="action" value="deny">Cancel</button>
<button type="submit" name="action" value="allow_callback" class="primary">Approve callback</button>
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
  client: ClientInfo | null,
  callbackUri: string,
  querystring: string,
  csrf: string | null,
): string {
  const action = `/authorize${escapeHtml(querystring)}`;
  const hasAgents = agents.length > 0;
  const options = agents
    .map(
      (a) =>
        `<option value="${escapeHtml(a.id)}">${escapeHtml(normalizeTitleForDisplay(a.name))}</option>`,
    )
    .join("");
  const existingBlock = hasAgents
    ? `<div class="opt"><label><input type="radio" name="agent_mode" value="existing" checked> Use an existing agent</label></div>
<select name="agent_id">${options}</select>`
    : "";
  return shell(`<h1>Bind this connector to an agent</h1>
<p>This OAuth client isn't bound to an agent yet — it may have registered itself. Allowing it grants it publish, update, read, and list access to <strong>every document on this host</strong>, as the agent you pick below. The agent is the unit of provenance and revocation.</p>
${renderClientIdentity(client, callbackUri)}
<p>Choose the identity it will publish as — pick an existing agent or mint a new one.</p>
<form method="POST" action="${action}">
${existingBlock}
<div class="opt"><label><input type="radio" name="agent_mode" value="new"${hasAgents ? "" : " checked"}> Mint a new agent</label></div>
<input type="text" name="agent_name" placeholder="New agent name" maxlength="200" autocomplete="off">
${authFormFields(csrf)}
<div class="row">
<button type="submit" name="action" value="deny">Deny</button>
<button type="submit" name="action" value="allow">Allow</button>
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
