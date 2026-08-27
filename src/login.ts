// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * /login + /logout — browser session entry/exit for the OPERATOR and for the
 * read-only READER tier.
 *
 * `/login` is a one-field page that takes an EXISTING key and validates it, in
 * order, against `OPERATOR_TOKEN` (the same constant-time check the API uses,
 * via a synthetic Bearer Request — the same trick authorize.ts/serve.ts use) and
 * then against each entry of `READER_TOKENS` (`matchReaderToken`, the same
 * constant-time primitive). On success it mints the signed session cookie +
 * readable CSRF cookie (see src/session.ts) — an OPERATOR session for the
 * operator token, a READER session (payload carries `r`) for a reader token. No
 * new trust root, no IdP: the keys are still the underlying secrets; the cookie
 * is just a second door for browsers.
 *
 * ONE FORM, ONE ERROR. The field is labelled "Access key" and a wrong value says
 * only "Key incorrect." — it never reveals whether the value was close to the
 * operator token, close to a reader token, or whether the reader tier exists at
 * all. Order matters: operator first, so an operator token that (by
 * misconfiguration) also appears in `READER_TOKENS` still yields the operator
 * session rather than being downgraded.
 *
 * `/logout` clears both cookies. The state change is behind a POST (a bare GET
 * logout would be CSRF-able via `<img src=/logout>` and triggerable by link
 * prefetchers); GET renders a one-button confirm form instead.
 *
 * Anti-XSS: the only dynamic value rendered is the (already same-origin
 * validated) `next` path and the CSRF nonce, both HTML-escaped. CSP is tight
 * (default-src 'none'; no JS).
 */

import { authenticateOperator, matchReaderToken } from "./auth.js";
import type { Env } from "./env.js";
import { escapeHtml } from "./html.js";
import {
  authenticateSessionRequest,
  buildLogoutSetCookies,
  buildSessionSetCookies,
  csrfMatches,
  deriveReaderId,
  isSecureRequest,
  mintCsrfNonce,
  mintSessionCookieValue,
  SESSION_TTL_SECONDS,
  sessionEpoch,
  validateNext,
} from "./session.js";

const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": PAGE_CSP,
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};

// -- /login -------------------------------------------------------------------

export async function handleLogin(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") return getLogin(req);
  if (req.method === "POST") return await postLogin(req, env);
  return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
}

function getLogin(req: Request): Response {
  const next = validateNext(new URL(req.url).searchParams.get("next"));
  return new Response(renderLogin(next, null), { status: 200, headers: PAGE_HEADERS });
}

async function postLogin(req: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response(renderLogin("/", "Malformed form submission."), {
      status: 400,
      headers: PAGE_HEADERS,
    });
  }
  // Re-validate next on the way out; never trust the round-tripped value.
  const next = validateNext(String(form.get("next") ?? ""));
  // FIELD NAME IS WIRE FORMAT — still `operator_token` even though the field now
  // also accepts a reader key. `authorizeOperatorForm`'s pasted-token rung reads
  // the same name on every manage/console form, and renaming it here would fork
  // the two spellings for a cosmetic gain. The LABEL is what the human reads.
  const operatorToken = String(form.get("operator_token") ?? "");

  // Synthetic Bearer Request so the same constant-time operator check backs
  // every operator surface. Never log or rethrow the token.
  const synth = new Request(req.url, { headers: { authorization: `Bearer ${operatorToken}` } });
  const expected = env.OPERATOR_TOKEN;
  const isOperator = Boolean(expected) && authenticateOperator(synth, env);
  // Reader tier (insight fork): only consulted when the value is NOT the
  // operator token, so an operator can never be downgraded to a reader session.
  // Returns the matched token, whose fingerprint becomes the cookie's `r`.
  const readerToken = isOperator ? null : matchReaderToken(operatorToken, env);
  if (!expected || (!isOperator && readerToken === null)) {
    // ONE message for every failure: wrong operator token, wrong reader token,
    // no reader tier configured, `OPERATOR_TOKEN` unset. A visitor learns only
    // that this key doesn't work here.
    return new Response(renderLogin(next, "Key incorrect."), {
      status: 401,
      headers: PAGE_HEADERS,
    });
  }

  const epoch = sessionEpoch(env);
  const readerId =
    readerToken === null ? undefined : await deriveReaderId(readerToken, expected, epoch);
  const csrf = mintCsrfNonce();
  const value = await mintSessionCookieValue(
    expected,
    epoch,
    Date.now(),
    SESSION_TTL_SECONDS,
    csrf,
    readerId,
  );
  const [sessionCookie, csrfCookie] = buildSessionSetCookies(value, csrf, isSecureRequest(req));

  const headers = new Headers({
    location: next,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  // Two cookies → two Set-Cookie headers; Headers.set would clobber the first.
  headers.append("set-cookie", sessionCookie);
  headers.append("set-cookie", csrfCookie);
  return new Response(null, { status: 302, headers });
}

// -- /logout ------------------------------------------------------------------

export async function handleLogout(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") return await getLogout(req, env);
  if (req.method === "POST") return await postLogout(req, env);
  return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
}

async function getLogout(req: Request, env: Env): Promise<Response> {
  // Tier-agnostic: a reader signs out through the same page, with the same CSRF
  // echo. `authenticateSessionRequest` (not the operator-narrowed twin) is what
  // makes the confirm form render for a reader instead of the "not signed in"
  // card that would leave their cookie in place.
  const auth = await authenticateSessionRequest(req, env);
  if (!auth.ok || auth.via !== "cookie") {
    // Nothing to log out (no browser session). Offer a way back to /login.
    return new Response(renderLogoutInfo(), { status: 200, headers: PAGE_HEADERS });
  }
  return new Response(renderLogoutConfirm(auth.csrf), { status: 200, headers: PAGE_HEADERS });
}

async function postLogout(req: Request, env: Env): Promise<Response> {
  const auth = await authenticateSessionRequest(req, env);
  // If authed via cookie, require the CSRF token (defense in depth; SameSite=Lax
  // already blocks the cross-site POST that would carry the cookie). A request
  // with no valid cookie session just clears whatever's there — idempotent.
  if (auth.ok && auth.via === "cookie") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      form = new FormData();
    }
    if (!csrfMatches(String(form.get("csrf_token") ?? ""), auth.csrf)) {
      return new Response(renderLogoutConfirm(auth.csrf, "CSRF check failed — try again."), {
        status: 403,
        headers: PAGE_HEADERS,
      });
    }
  }

  const [sessionCookie, csrfCookie] = buildLogoutSetCookies(isSecureRequest(req));
  const headers = new Headers({ location: "/", "cache-control": "no-store" });
  headers.append("set-cookie", sessionCookie);
  headers.append("set-cookie", csrfCookie);
  return new Response(null, { status: 302, headers });
}

// -- templates ----------------------------------------------------------------

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
  .card{max-width:420px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
  h1{font-size:18px;margin:0 0 12px;font-weight:600}
  p{margin:0 0 16px;color:#555}
  label{display:block;margin:18px 0 6px;font-size:13px;color:#555}
  input[type=password]{width:100%;box-sizing:border-box;padding:9px 10px;font:13px/1.4 system-ui,sans-serif;border:1px solid #ccc;border-radius:4px}
  .row{display:flex;gap:8px;margin-top:18px}
  button,a.btn{flex:1;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;cursor:pointer;text-align:center;text-decoration:none;box-sizing:border-box}
  button{background:#222;color:#fff}
  a.btn{background:#fff;color:#222}
  .err{color:#a00;font-size:13px;margin:0 0 4px}
  .note{font-size:12px;color:#888;margin-top:18px}
</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>
`;
}

function renderLogin(next: string, error: string | null): string {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  return page(
    "Slopcafe — sign in",
    `<h1>Sign in</h1>
<p>Enter your access key once to start a browser session. An operator key unlocks management; a reader key is read-only. Programmatic access still uses the <code>Authorization: Bearer</code> header — this is just for the web.</p>
${err}<form method="POST" action="/login">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="operator_token">Access key</label>
<input id="operator_token" name="operator_token" type="password" required autocomplete="off" autofocus>
<div class="row">
<button type="submit">Sign in</button>
</div>
</form>
<p class="note">Sessions last 30 days. Sign out at <code>/logout</code>; rotating the operator token or bumping <code>SESSION_EPOCH</code> ends every session, and removing one reader key ends only that reader's.</p>`,
  );
}

function renderLogoutConfirm(csrf: string, error?: string): string {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  return page(
    "Slopcafe — sign out",
    `<h1>Sign out?</h1>
<p>This clears your browser session on this host. Programmatic <code>Bearer</code> access is unaffected.</p>
${err}<form method="POST" action="/logout">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
<div class="row">
<a class="btn" href="/">Cancel</a>
<button type="submit">Sign out</button>
</div>
</form>`,
  );
}

function renderLogoutInfo(): string {
  return page(
    "Slopcafe — sign out",
    `<h1>Not signed in</h1>
<p>There's no active browser session on this host.</p>
<div class="row"><a class="btn" href="/login">Go to sign in</a></div>`,
  );
}
