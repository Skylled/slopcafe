// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for the pure session/cookie/CSRF core in src/session.ts — the signed
// browser-session cookie that lets the operator log in once instead of pasting
// OPERATOR_TOKEN on every request. Same Node-strip-types harness as the other
// test/*.test.mjs files; needs the .ts resolver because session.ts imports auth.ts.
//
// Most env-aware wrappers (authenticateOperatorRequest / requireOperator) read
// env + Date.now and are exercised end-to-end via wrangler dev; what we pin here
// is the crypto/cookie logic where a bug would forge a session, leak a redirect,
// or silently fail to clear a cookie.
//
// Two wrappers ARE covered here because their inputs are trivially fakeable (a
// Request + a `{OPERATOR_TOKEN}` stand-in for Env) and their behavior is an
// authorization decision: `isSecureRequest` (which decides whether a 30-day
// operator session cookie carries `Secure`) and `authorizeOperatorForm` (the
// form-field auth ladder behind every manage-page / console POST).

import {
  authorizeOperatorForm,
  buildLogoutSetCookies,
  buildSessionSetCookies,
  COOKIE_SESSION,
  csrfMatches,
  isSecureRequest,
  mintCsrfNonce,
  mintSessionCookieValue,
  parseCookies,
  serializeSetCookie,
  validateCallbackUri,
  validateNext,
  verifySessionCookieValue,
} from "../src/session.ts";

let fails = 0;

function check(label, got, want) {
  const okEq = got === want;
  console.log(`${okEq ? "ok  " : "FAIL"} ${label}`);
  if (!okEq) {
    console.log(`  want: ${JSON.stringify(want)}`);
    console.log(`  got:  ${JSON.stringify(got)}`);
    fails++;
  }
}

const NOW = Date.parse("2026-05-30T12:00:00.000Z");
const TTL = 3600; // 1h
const TOKEN = "operator-secret-abc";

// ----- mint → verify round-trip ---------------------------------------------

const cookie = await mintSessionCookieValue(TOKEN, "1", NOW, TTL, "nonce-123");
const payload = await verifySessionCookieValue(cookie, TOKEN, "1", NOW);
check("round-trip verifies", payload !== null, true);
check("round-trip preserves csrf nonce", payload?.csrf, "nonce-123");
check("round-trip exp = now + ttl*1000", payload?.exp, NOW + TTL * 1000);
check("round-trip iat = now", payload?.iat, NOW);
check("round-trip payload version", payload?.v, 1);

// ----- expiry boundary (valid strictly while now < exp) ---------------------

check(
  "valid 1ms before exp",
  (await verifySessionCookieValue(cookie, TOKEN, "1", NOW + TTL * 1000 - 1)) !== null,
  true,
);
check("expired exactly at exp", await verifySessionCookieValue(cookie, TOKEN, "1", NOW + TTL * 1000), null);
check(
  "expired 1ms after exp",
  await verifySessionCookieValue(cookie, TOKEN, "1", NOW + TTL * 1000 + 1),
  null,
);

// ----- tamper ---------------------------------------------------------------

const tamperedFirst = (cookie[0] === "Z" ? "Y" : "Z") + cookie.slice(1);
check("tampered payload byte rejected", await verifySessionCookieValue(tamperedFirst, TOKEN, "1", NOW), null);

const tamperedLast = cookie.slice(0, -1) + (cookie.endsWith("a") ? "b" : "a");
check("tampered signature byte rejected", await verifySessionCookieValue(tamperedLast, TOKEN, "1", NOW), null);

check("missing dot rejected", await verifySessionCookieValue("nodothere", TOKEN, "1", NOW), null);
check("empty value rejected", await verifySessionCookieValue("", TOKEN, "1", NOW), null);

// ----- revocation levers ----------------------------------------------------

// Bumping SESSION_EPOCH changes the signing key → every old cookie fails.
check("epoch bump revokes (1 → 2)", await verifySessionCookieValue(cookie, TOKEN, "2", NOW), null);
// Rotating OPERATOR_TOKEN changes the signing key → every old cookie fails.
check("token rotation revokes", await verifySessionCookieValue(cookie, "different-token", "1", NOW), null);
// Fail closed when there is no operator token at all.
check("empty operator token fails closed", await verifySessionCookieValue(cookie, "", "1", NOW), null);

// ----- csrfMatches ----------------------------------------------------------

check("csrf exact match", csrfMatches("abc123", "abc123"), true);
check("csrf mismatch", csrfMatches("abc123", "abc124"), false);
check("csrf length mismatch", csrfMatches("abc", "abcd"), false);
check("csrf empty submitted", csrfMatches("", "abc"), false);
check("csrf null submitted", csrfMatches(null, "abc"), false);
check("csrf undefined submitted", csrfMatches(undefined, "abc"), false);
check("csrf empty session nonce", csrfMatches("abc", ""), false);

// ----- mintCsrfNonce --------------------------------------------------------

const n1 = mintCsrfNonce();
const n2 = mintCsrfNonce();
check("nonce non-empty", n1.length > 0, true);
check("nonces differ", n1 !== n2, true);
check("nonce is base64url charset", /^[A-Za-z0-9_-]+$/.test(n1), true);

// ----- parseCookies ---------------------------------------------------------

check("null header → empty", JSON.stringify(parseCookies(null)), "{}");
check("empty header → empty", JSON.stringify(parseCookies("")), "{}");
const both = parseCookies("awh_session=aaa.bbb; awh_csrf=ccc");
check("parse session", both.awh_session, "aaa.bbb");
check("parse csrf", both.awh_csrf, "ccc");
check("whitespace trimmed around name/value", parseCookies("  a = b ").a, "b");
check("= preserved in value", parseCookies("k=a=b=c").k, "a=b=c");
check("missing cookie → undefined", parseCookies("a=b").z, undefined);
check("first occurrence wins", parseCookies("a=1; a=2").a, "1");
check("segment without = skipped", parseCookies("flag; a=b").a, "b");

// ----- serializeSetCookie ---------------------------------------------------

check(
  "basic cookie defaults Path=/ SameSite=Lax",
  serializeSetCookie("n", "v", { maxAge: 100 }),
  "n=v; Path=/; Max-Age=100; SameSite=Lax",
);
check(
  "httpOnly + secure flags",
  serializeSetCookie("n", "v", { maxAge: 100, httpOnly: true, secure: true }),
  "n=v; Path=/; Max-Age=100; HttpOnly; Secure; SameSite=Lax",
);
check(
  "no secure when false",
  serializeSetCookie("n", "v", { maxAge: 100, secure: false }),
  "n=v; Path=/; Max-Age=100; SameSite=Lax",
);
check(
  "clear shape (Max-Age=0, empty value)",
  serializeSetCookie("n", "", { maxAge: 0, httpOnly: true, secure: false }),
  "n=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
);

// ----- buildSessionSetCookies / buildLogoutSetCookies -----------------------

const [sessionCookie, csrfCookie] = buildSessionSetCookies("VAL", "NONCE", true);
check("session cookie name+value", sessionCookie.startsWith("awh_session=VAL;"), true);
check("session cookie is HttpOnly", sessionCookie.includes("HttpOnly"), true);
check("session cookie is Secure", sessionCookie.includes("Secure"), true);
check("session cookie SameSite=Lax", sessionCookie.includes("SameSite=Lax"), true);
check("session cookie 30-day Max-Age", sessionCookie.includes("Max-Age=2592000"), true);
check("csrf cookie name+value", csrfCookie.startsWith("awh_csrf=NONCE;"), true);
check("csrf cookie is NOT HttpOnly (page must read it)", csrfCookie.includes("HttpOnly"), false);
check("csrf cookie is Secure", csrfCookie.includes("Secure"), true);

const [insecureSession] = buildSessionSetCookies("V", "N", false);
check("no Secure on http (localhost dev)", insecureSession.includes("Secure"), false);

// ----- isSecureRequest (which requests may drop `Secure`) -------------------

// The exemption is for LOCAL DEV ONLY: a browser silently drops a `Secure`
// cookie set over http://localhost, so `wrangler dev` login would break. It is
// deliberately NOT scheme-only — a plain-http request to a real hostname is a
// misconfigured zone or an active downgrade, and must still get `Secure` (the
// browser then refuses to send the session back over cleartext).
const secureFor = (url) => isSecureRequest(new Request(url));

check("https custom domain → Secure", secureFor("https://slopcafe.com/login"), true);
check("https workers.dev → Secure", secureFor("https://agent-web-host.acme.workers.dev/login"), true);
check("http localhost → no Secure (wrangler dev)", secureFor("http://localhost:8787/login"), false);
check("http 127.0.0.1 → no Secure", secureFor("http://127.0.0.1:8787/login"), false);
check("http [::1] → no Secure", secureFor("http://[::1]:8787/login"), false);
check("https localhost → Secure (scheme wins)", secureFor("https://localhost:8787/login"), true);
// The regression this narrowing fixes: plain http to the production host used to
// mint the operator session WITHOUT `Secure`.
check("http custom domain → Secure anyway", secureFor("http://slopcafe.com/login"), true);
check("http LAN dev IP → Secure anyway (not loopback)", secureFor("http://192.168.1.5:8787/login"), true);
// Suffix/prefix lookalikes must not slip through the loopback set.
check("http localhost.evil.com → Secure anyway", secureFor("http://localhost.evil.com/login"), true);
check("http notlocalhost → Secure anyway", secureFor("http://notlocalhost/login"), true);

const [logoutSession, logoutCsrf] = buildLogoutSetCookies(true);
check("logout session empties value", logoutSession.startsWith("awh_session=;"), true);
check("logout session Max-Age=0", logoutSession.includes("Max-Age=0"), true);
check("logout session keeps HttpOnly (attrs match original)", logoutSession.includes("HttpOnly"), true);
check("logout csrf empties value", logoutCsrf.startsWith("awh_csrf=;"), true);
check("logout csrf Max-Age=0", logoutCsrf.includes("Max-Age=0"), true);

// ----- validateNext (open-redirect guard) -----------------------------------

check("next root", validateNext("/"), "/");
check("next simple path", validateNext("/d/abc"), "/d/abc");
check("next admin path", validateNext("/admin/agents"), "/admin/agents");
check("next path with query", validateNext("/admin/documents?limit=5"), "/admin/documents?limit=5");
check("next protocol-relative rejected", validateNext("//evil.com"), "/");
check("next backslash rejected", validateNext("/\\evil.com"), "/");
check("next absolute https rejected", validateNext("https://evil.com"), "/");
check("next double-backslash rejected", validateNext("\\\\evil.com"), "/");
check("next with newline (CRLF) rejected", validateNext("/foo\nbar"), "/");
check("next empty → /", validateNext(""), "/");
check("next null → /", validateNext(null), "/");
check("next undefined → /", validateNext(undefined), "/");

// A full /authorize URL must round-trip through /login?next= untouched so the
// operator returns to the exact in-flight OAuth request (Feature: login-from-
// /authorize). Multi-param + percent-encoding survive; an encoded slash must NOT
// be decoded (else %2f%2fevil.com could resolve to a protocol-relative target).
check(
  "next full /authorize URL round-trips",
  validateNext(
    "/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2Fabc&state=y",
  ),
  "/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2Fabc&state=y",
);
check("next keeps encoded slashes encoded", validateNext("/%2f%2fevil.com"), "/%2f%2fevil.com");

// Dot-segment resolution can MANUFACTURE a protocol-relative path from input
// that never looked scheme-relative: `/..//evil.com` parses same-origin against
// the placeholder, but its resolved pathname is `//evil.com`, which a browser
// re-reads as `https://evil.com` once it lands in a relative `Location:`. The
// origin check can't see this — the guard is on the resolved OUTPUT.
check("next dot-segment → protocol-relative rejected", validateNext("/..//evil.com"), "/");
check("next deep dot-segment → protocol-relative rejected", validateNext("/a/b/../..//evil.com"), "/");
check("next dot-segment to a real path still works", validateNext("/admin/../d/abc"), "/d/abc");
// A single leading slash after normalization is the ONLY accepted shape.
check("next single-slash path unaffected", validateNext("/d/abc?x=1"), "/d/abc?x=1");

// ----- validateCallbackUri (TOFU approval gate; the only gate before updateClient)

const ALLOWED = new Set(["claude.ai", "claude.com", "chatgpt.com"]);

check(
  "callback claude.ai accepted",
  validateCallbackUri("https://claude.ai/api/mcp/auth_callback", ALLOWED),
  "https://claude.ai/api/mcp/auth_callback",
);
check(
  "callback chatgpt.com accepted",
  validateCallbackUri("https://chatgpt.com/connector/oauth/LU3_gWQc0r-6", ALLOWED),
  "https://chatgpt.com/connector/oauth/LU3_gWQc0r-6",
);
check(
  "callback with query normalized + accepted",
  validateCallbackUri("https://claude.ai/cb?x=1", ALLOWED),
  "https://claude.ai/cb?x=1",
);
check("callback http rejected (non-https)", validateCallbackUri("http://claude.ai/cb", ALLOWED), null);
check(
  "callback userinfo rejected (effective host evil.com)",
  validateCallbackUri("https://claude.ai@evil.com/cb", ALLOWED),
  null,
);
check("callback fragment rejected", validateCallbackUri("https://claude.ai/cb#frag", ALLOWED), null);
check("callback off-allowlist host rejected", validateCallbackUri("https://evil.com/cb", ALLOWED), null);
check("callback javascript: rejected", validateCallbackUri("javascript:alert(1)", ALLOWED), null);
check("callback data: rejected", validateCallbackUri("data:text/html,x", ALLOWED), null);
check("callback protocol-relative rejected", validateCallbackUri("//claude.ai/cb", ALLOWED), null);
check(
  "callback control char rejected (caught pre-parse)",
  validateCallbackUri("https://claude.ai/cb\n", ALLOWED),
  null,
);
check(
  "callback punycode host not on allowlist rejected",
  validateCallbackUri("https://xn--80ak6aa92e.com/cb", ALLOWED),
  null,
);
check(
  "callback trailing-dot host rejected (claude.ai. ≠ claude.ai)",
  validateCallbackUri("https://claude.ai./cb", ALLOWED),
  null,
);
check("callback null → null", validateCallbackUri(null, ALLOWED), null);
check("callback undefined → null", validateCallbackUri(undefined, ALLOWED), null);
check("callback empty → null", validateCallbackUri("", ALLOWED), null);
// Dedup invariant: two spellings of the same default-port URL normalize equal,
// so the "already registered" check in authorize.ts can't be bypassed by :443.
check(
  "callback default-port normalizes to portless form",
  validateCallbackUri("https://claude.ai:443/cb", ALLOWED),
  validateCallbackUri("https://claude.ai/cb", ALLOWED),
);

// ----- authorizeOperatorForm (the no-JS form auth ladder) -------------------

// Three accepted credentials: a pasted `operator_token` field, an
// `Authorization: Bearer` header, or a session cookie + matching `csrf_token`
// field. The first two are CSRF-exempt (neither is ambient); only the cookie
// path demands the echo.

const ENV = { OPERATOR_TOKEN: TOKEN };
const FORM_URL = "https://slopcafe.com/d/aaaaaaaaaaaaaaaaaaaaaa/restore";

function formOf(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** A live session cookie header + the nonce its forms must echo. */
async function liveSession() {
  const nonce = mintCsrfNonce();
  const value = await mintSessionCookieValue(TOKEN, "1", Date.now(), TTL, nonce);
  return { header: `${COOKIE_SESSION}=${value}`, nonce };
}

const postReq = (headers = {}) => new Request(FORM_URL, { method: "POST", headers });

// 1. Pasted token.
const pasted = await authorizeOperatorForm(postReq(), ENV, formOf({ operator_token: TOKEN }));
check("form: pasted token authorizes", pasted.ok, true);
check("form: pasted token is via bearer", pasted.via, "bearer");

const pastedBad = await authorizeOperatorForm(postReq(), ENV, formOf({ operator_token: "nope" }));
check("form: wrong pasted token refused", pastedBad.ok, false);
check("form: wrong pasted token 401", pastedBad.status, 401);
check("form: wrong pasted token message", pastedBad.message, "Operator token incorrect.");

// 2. Header Bearer — the case that used to 401 despite authenticating fine, so
// an operator script had to move OPERATOR_TOKEN out of the header and into the
// body to reach POST /d/:id/restore (which has no JSON /admin twin).
const bearer = await authorizeOperatorForm(
  postReq({ authorization: `Bearer ${TOKEN}` }),
  ENV,
  formOf({ version: "3" }),
);
check("form: header Bearer authorizes", bearer.ok, true);
check("form: header Bearer is via bearer", bearer.via, "bearer");

const bearerBad = await authorizeOperatorForm(
  postReq({ authorization: "Bearer wrong-token" }),
  ENV,
  formOf({ version: "3" }),
);
check("form: wrong header Bearer refused", bearerBad.ok, false);
check("form: wrong header Bearer 401", bearerBad.status, 401);

// Bearer is resolved BEFORE the cookie, and is CSRF-exempt: a valid Bearer must
// win even when a stale cookie rides along with a mismatched csrf_token field.
const { header: staleCookie } = await liveSession();
const bearerWithStaleCookie = await authorizeOperatorForm(
  postReq({ authorization: `Bearer ${TOKEN}`, cookie: staleCookie }),
  ENV,
  formOf({ csrf_token: "wrong-nonce" }),
);
check("form: Bearer beats cookie (no CSRF demanded)", bearerWithStaleCookie.ok, true);
check("form: Bearer beats cookie → via bearer", bearerWithStaleCookie.via, "bearer");

// 3. Cookie + CSRF echo.
const { header: cookieHeader, nonce } = await liveSession();
const cookieOk = await authorizeOperatorForm(
  postReq({ cookie: cookieHeader }),
  ENV,
  formOf({ csrf_token: nonce }),
);
check("form: cookie + matching csrf authorizes", cookieOk.ok, true);
check("form: cookie path is via cookie", cookieOk.via, "cookie");
check("form: cookie path returns the verified nonce", cookieOk.csrf, nonce);

const cookieBadCsrf = await authorizeOperatorForm(
  postReq({ cookie: cookieHeader }),
  ENV,
  formOf({ csrf_token: "wrong-nonce" }),
);
check("form: cookie + wrong csrf refused", cookieBadCsrf.ok, false);
check("form: cookie + wrong csrf 403", cookieBadCsrf.status, 403);

const cookieNoCsrf = await authorizeOperatorForm(postReq({ cookie: cookieHeader }), ENV, formOf({}));
check("form: cookie + missing csrf 403", cookieNoCsrf.status, 403);

// 4. No credential at all.
const anon = await authorizeOperatorForm(postReq(), ENV, formOf({}));
check("form: anonymous refused", anon.ok, false);
check("form: anonymous 401", anon.status, 401);
check(
  "form: anonymous message",
  anon.message,
  "Sign in or paste the operator token to make changes.",
);

// Fail closed when the deployment has no operator token configured at all.
const noToken = await authorizeOperatorForm(
  postReq({ authorization: `Bearer ${TOKEN}` }),
  {},
  formOf({}),
);
check("form: unset OPERATOR_TOKEN fails closed", noToken.ok, false);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall session tests passed");
}
