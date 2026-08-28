// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Coverage for src/cors.ts — the cross-origin transport layer.
//
// Four things are pinned here, in descending order of how badly they hurt when
// wrong:
//
//   1. THE CREDENTIALS RULE. The CORS credentials header must never be emitted,
//      and its literal name must not appear in any CODE position anywhere in
//      src/. Emitting it would let an allowlisted origin do a credentialed read
//      of an operator HTML page and lift the CSRF nonce out of it, which ends
//      the double-submit defence for every cookie-authed mutation in the
//      Worker. Two nets: a behavioural one (drive `withCors` and inspect what
//      comes out) and a crude source scan, which catches the header arriving by
//      any route — a helper, a spread, a copied snippet — rather than only
//      through the wrapper.
//   2. ORIGIN MATCHING. Exact, never prefix/suffix. The suffix bug —
//      `https://slopcafe.com.evil.example` passing an `endsWith` check — is the
//      canonical way this feature gets exploited, so it is asserted as an
//      attack, not as a spec detail.
//   3. ELIGIBILITY. Every cookie/HTML/operator-form surface stays out; the
//      machine-readable API stays in. Default deny, so the interesting
//      assertions are the negative ones.
//   4. THE WRAPPER'S BEHAVIOUR. `withCors` takes a handler and returns one, and
//      needs no D1/R2/WASM to run — so the preflight bytes, the header
//      stamping, the untouched-when-off path and the no-existence-oracle
//      property are all exercised here for real, against a stub inner handler.
//      test/e2e/cors.sh then proves the same properties survive the full
//      wrapper stack against a running Worker.
//
// Same Node strip-types harness as served-version/access/session.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CORS_ALLOWED_REQUEST_HEADERS,
  CORS_EXPOSED_RESPONSE_HEADERS,
  corsAllowedOrigins,
  isCorsEligible,
  normalizeOrigin,
  resolveAllowedOrigin,
  withCors,
} from "../src/cors.ts";

let fails = 0;

function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) fails++;
}

function eq(label, got, want) {
  const same = got === want;
  console.log(`${same ? "ok  " : "FAIL"} ${label}`);
  if (!same) {
    console.log(`  want: ${JSON.stringify(want)}`);
    console.log(`  got:  ${JSON.stringify(got)}`);
    fails++;
  }
}

// A stand-in public_id and slug, so the eligibility assertions read like real
// URLs. Nothing in cors.ts looks at their shape — that is deliberate (see the
// preflight/oracle assertions at the bottom).
const ID = "AbCdEfGhIjKlMnOpQrStUv";
const SLUG = "some-document-slug";

// ============================================================================
// 1. the credentials rule — a source scan over all of src/
// ============================================================================

// The rule has to be WRITTEN DOWN to survive, and writing it down means naming
// the header in prose. So the scan looks only at code: comments are stripped
// first, and what remains is everything that could actually reach a response.
// The stripper is quote-aware so a `//` inside a string literal is not mistaken
// for the start of a comment (which would silently swallow the rest of that
// line — a false NEGATIVE, the direction that matters here).
function stripComments(src) {
  let out = "";
  let i = 0;
  // code | line | block | sq (') | dq (") | tpl (`)
  let mode = "code";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") {
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (c === "'") mode = "sq";
      else if (c === '"') mode = "dq";
      else if (c === "`") mode = "tpl";
      out += c;
      i++;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      }
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") {
        mode = "code";
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    // Inside a string literal: copy through, honouring escapes, until its
    // matching quote.
    if (c === "\\") {
      out += c + (src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"') || (mode === "tpl" && c === "`")) {
      mode = "code";
    }
    out += c;
    i++;
  }
  return out;
}

// Sanity-check the stripper itself before trusting a clean result from it — an
// always-empty stripper would make the scan below pass vacuously, which is the
// same failure mode the sanitizer corpus guards against with its self-check.
check(
  "comment stripper removes comments but keeps string literals",
  stripComments('const a = "keep"; // drop\n/* drop */ const b = `keep2`;') ===
    'const a = "keep"; \n const b = `keep2`;',
);
check(
  "comment stripper does not treat // inside a string as a comment",
  stripComments('const u = "https://keep.example"; // drop').includes("https://keep.example"),
);

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const offenders = [];
for (const name of readdirSync(srcDir)) {
  // Every file, not just .ts — the MCP Apps HTML template is source too, and a
  // fetch() in it could ask for credentials just as easily. The template gets
  // scanned raw (a JS comment stripper would mangle HTML, and there is no prose
  // in it that needs the exemption).
  const raw = readFileSync(`${srcDir}/${name}`, "utf8");
  const code = name.endsWith(".ts") ? stripComments(raw) : raw;
  // Case-insensitive: HTTP header names are, so any casing would be honoured
  // by a browser.
  if (/access-control-allow-credentials/i.test(code)) offenders.push(name);
}
check(
  `the CORS credentials header appears in no code position in src/ (${offenders.length ? offenders.join(", ") : "clean"})`,
  offenders.length === 0,
);

// The rule is only as durable as its rationale, so assert the explanation is
// present too. A future reader deleting the header must step over the paragraph
// that says why it can't come back.
const corsSrc = readFileSync(`${srcDir}/cors.ts`, "utf8");
check(
  "src/cors.ts documents the credentials rule (mentions the CSRF nonce)",
  /csrf/i.test(corsSrc) && /credential/i.test(corsSrc),
);

// ============================================================================
// 2. the allowed-request-header list
// ============================================================================

check(
  "x-csrf-token is NOT an allowed cross-origin request header",
  !CORS_ALLOWED_REQUEST_HEADERS.some((h) => h.toLowerCase() === "x-csrf-token"),
);
check(
  "header allowlist is all-lowercase (compared case-insensitively by browsers, "
    + "but a mixed list reads as if casing mattered)",
  CORS_ALLOWED_REQUEST_HEADERS.every((h) => h === h.toLowerCase()),
);
// The headers the real browser client sends. `authorization` is the whole auth
// story cross-origin; `if-none-match`/`cache-control` are the reader's
// revalidation + hard-refresh paths; `if-match` is the write preflight;
// `content-type` is required on every write because text/html and
// application/json are not CORS-safelisted values.
for (const h of [
  "authorization",
  "cache-control",
  "content-type",
  "if-match",
  "if-none-match",
  "x-content-sha256",
  "x-doc-title",
  "x-doc-description",
  "x-doc-tags",
  "x-doc-slug",
]) {
  check(`allowed request header: ${h}`, CORS_ALLOWED_REQUEST_HEADERS.includes(h));
}

// ============================================================================
// 3. the exposed-response-header list — the SILENT failure
// ============================================================================
// Without these, a cross-origin read of `etag` / `x-doc-current-version`
// returns null with no error anywhere, and the client's whole
// published-vs-current version resolution degrades to "unknown". These two are
// the ones that break a feature rather than an affordance.
for (const h of [
  "etag",
  "x-doc-current-version",
  "x-converter-version",
  "x-sanitizer-version",
  "link",
]) {
  check(`exposed response header: ${h}`, CORS_EXPOSED_RESPONSE_HEADERS.includes(h));
}
check(
  "exposed list is all-lowercase",
  CORS_EXPOSED_RESPONSE_HEADERS.every((h) => h === h.toLowerCase()),
);

// The header names must match what src/serve.ts actually emits — a rename there
// with no rename here is exactly the silent degradation described above.
const serveSrc = readFileSync(`${srcDir}/serve.ts`, "utf8");
for (const h of ["x-doc-current-version", "x-converter-version", "x-sanitizer-version"]) {
  check(`src/serve.ts still emits ${h}`, serveSrc.includes(`"${h}"`));
}

// ============================================================================
// 4. origin normalization
// ============================================================================

eq("plain https origin", normalizeOrigin("https://app.example"), "https://app.example");
eq("origin with port", normalizeOrigin("http://localhost:5173"), "http://localhost:5173");
eq("trailing slash tolerated", normalizeOrigin("https://app.example/"), "https://app.example");
eq("scheme/host case-folded", normalizeOrigin("HTTPS://App.Example"), "https://app.example");
eq("default port dropped", normalizeOrigin("https://app.example:443"), "https://app.example");
eq("no scheme is not an origin", normalizeOrigin("app.example"), null);
eq("a path is not an origin", normalizeOrigin("https://app.example/x"), null);
eq("a fragment is not an origin", normalizeOrigin("https://evil.example/#https://app.example"), null);
eq("userinfo is rejected", normalizeOrigin("https://user:pw@app.example"), null);
eq("non-http scheme rejected", normalizeOrigin("app://slopcafe"), null);
// A sandboxed iframe sends the literal `Origin: null`. It must never resolve.
eq("the literal null origin is rejected", normalizeOrigin("null"), null);
eq("empty/absent", normalizeOrigin(""), null);
eq("undefined", normalizeOrigin(undefined), null);
// `*` is not a wildcard in this implementation — it simply isn't an origin.
eq("asterisk is not a wildcard", normalizeOrigin("*"), null);

// ============================================================================
// 5. resolveAllowedOrigin — EXACT match, and the suffix attack
// ============================================================================

const LIST = ["https://slopcafe.com", "http://localhost:5173"];

eq("exact match is allowed", resolveAllowedOrigin("https://slopcafe.com", LIST), "https://slopcafe.com");
eq(
  "exact match on the second entry",
  resolveAllowedOrigin("http://localhost:5173", LIST),
  "http://localhost:5173",
);
eq(
  "trailing slash on the request origin still matches",
  resolveAllowedOrigin("https://slopcafe.com/", LIST),
  "https://slopcafe.com",
);

// THE attacks. Each of these is admitted by one of the three matchers someone
// reaches for instead of an equality check, and rejected by exact matching. If
// any of them ever flips to allowed, the allowlist has stopped being one.
//
// A domain the attacker registers under a name that STARTS with the trusted
// one. Defeats `origin.startsWith(entry)` and `origin.includes(entry)`.
eq(
  "PREFIX-MATCH ATTACK: slopcafe.com.evil.example is rejected",
  resolveAllowedOrigin("https://slopcafe.com.evil.example", LIST),
  null,
);
eq(
  "PREFIX-MATCH ATTACK: slopcafe.compromised.example is rejected",
  resolveAllowedOrigin("https://slopcafe.compromised.example", LIST),
  null,
);
// A domain that ENDS with the trusted hostname without being a subdomain of it.
// Defeats `hostname.endsWith(allowedHostname)` — the single most common
// spelling of this bug, because it looks like it handles subdomains.
eq(
  "SUFFIX-MATCH ATTACK: evilslopcafe.com is rejected",
  resolveAllowedOrigin("https://evilslopcafe.com", LIST),
  null,
);
// A real subdomain is still a different origin. We list origins, not domains.
eq(
  "a subdomain of an allowed origin is NOT allowed",
  resolveAllowedOrigin("https://evil.slopcafe.com", LIST),
  null,
);
eq(
  "unrelated origin is rejected",
  resolveAllowedOrigin("https://evil.example", LIST),
  null,
);
// Scheme is part of an origin: an http:// copy of an https:// entry is a
// different origin and must not be admitted (a downgrade would otherwise let a
// network attacker on a coffee-shop wifi mint a trusted origin).
eq(
  "scheme downgrade is a different origin",
  resolveAllowedOrigin("http://slopcafe.com", LIST),
  null,
);
// Port is part of an origin too.
eq(
  "different port is a different origin",
  resolveAllowedOrigin("http://localhost:5174", LIST),
  null,
);
eq("no Origin header resolves to nothing", resolveAllowedOrigin(null, LIST), null);
eq("an empty allowlist allows nothing", resolveAllowedOrigin("https://slopcafe.com", []), null);

// ============================================================================
// 6. corsAllowedOrigins — the single [var] reader
// ============================================================================

const parse = (value) => corsAllowedOrigins({ CORS_ALLOWED_ORIGINS: value });

eq("unset [var] → CORS off", parse(undefined).length, 0);
eq("empty [var] → CORS off", parse("").length, 0);
eq("whitespace-only [var] → CORS off", parse("   ,  ,").length, 0);
check(
  "comma-separated list parses, trimming whitespace",
  JSON.stringify(parse(" https://a.example , http://localhost:5173 ")) ===
    JSON.stringify(["https://a.example", "http://localhost:5173"]),
);
check(
  "duplicates collapse (including via normalization)",
  JSON.stringify(parse("https://a.example, https://a.example/, HTTPS://A.example")) ===
    JSON.stringify(["https://a.example"]),
);
check(
  "a garbage entry is dropped, the rest survive",
  JSON.stringify(parse("not-an-origin, https://a.example")) === JSON.stringify(["https://a.example"]),
);
// The footgun that matters: an operator reaching for "allow everything" ends up
// with CORS OFF plus a log line, never an open API.
eq('"*" leaves CORS off rather than opening it up', parse("*").length, 0);

// ============================================================================
// 7. isCorsEligible — the exclusions first, because default-deny means the
//    negative assertions are the load-bearing ones
// ============================================================================

// --- cookie-session / operator-HTML surfaces: NEVER eligible ---------------
check("/authorize is not eligible (GET)", !isCorsEligible("GET", "/authorize"));
check("/authorize is not eligible (POST)", !isCorsEligible("POST", "/authorize"));
check("/login is not eligible (GET)", !isCorsEligible("GET", "/login"));
check("/login is not eligible (POST)", !isCorsEligible("POST", "/login"));
check("/logout is not eligible", !isCorsEligible("POST", "/logout"));
check("/admin/console/x is not eligible", !isCorsEligible("GET", "/admin/console/x"));
check("/admin/console/agents is not eligible", !isCorsEligible("GET", "/admin/console/agents"));
check(
  "/admin/console/agents/revoke is not eligible (POST)",
  !isCorsEligible("POST", "/admin/console/agents/revoke"),
);
check("bare /admin/console is not eligible", !isCorsEligible("GET", "/admin/console"));
check("bare /admin (302 to the console) is not eligible", !isCorsEligible("GET", "/admin"));
check(`/d/<id>/manage is not eligible`, !isCorsEligible("GET", `/d/${ID}/manage`));
check(`/d/<id>/revoke (confirm page) is not eligible`, !isCorsEligible("GET", `/d/${ID}/revoke`));
check(`/d/<id>/revoke (form POST) is not eligible`, !isCorsEligible("POST", `/d/${ID}/revoke`));

// The manage page's HTML form POSTs. Each has an operator-only JSON twin under
// /admin/documents/:id/… which IS eligible; these ones are forms.
for (const sub of ["visibility", "slug", "promote", "restore", "tags", "status"]) {
  check(`POST /d/<id>/${sub} (manage form) is not eligible`, !isCorsEligible("POST", `/d/${ID}/${sub}`));
}

// The OAuth-library endpoints: answered upstream of this wrapper, so claiming
// them here would be a promise we can't keep.
check("/mcp is not eligible", !isCorsEligible("POST", "/mcp"));
check("/token is not eligible", !isCorsEligible("POST", "/token"));
check("/register is not eligible", !isCorsEligible("POST", "/register"));
check(
  "/.well-known/oauth-authorization-server is not eligible",
  !isCorsEligible("GET", "/.well-known/oauth-authorization-server"),
);

// Browser HTML surfaces — embedded via iframe, which needs no CORS.
check("the homepage is not eligible", !isCorsEligible("GET", "/"));
check("/shell.js is not eligible", !isCorsEligible("GET", "/shell.js"));
check(
  "the historical-version SHELL is not eligible",
  !isCorsEligible("GET", `/d/${ID}/v/3`),
);

// Default deny for anything unrecognized.
check("an unknown route is not eligible", !isCorsEligible("GET", "/api/v1/whatever"));
check("an unknown /d sub-path is not eligible", !isCorsEligible("GET", `/d/${ID}/nope`));

// --- the machine-readable API: eligible ------------------------------------
check("GET /healthz is eligible", isCorsEligible("GET", "/healthz"));
check("GET /openapi.json is eligible", isCorsEligible("GET", "/openapi.json"));
check("GET /d (list) is eligible", isCorsEligible("GET", "/d"));
check("POST /d (publish) is eligible", isCorsEligible("POST", "/d"));
check("GET /d/search is eligible", isCorsEligible("GET", "/d/search"));
check("GET /d/pack is eligible", isCorsEligible("GET", "/d/pack"));
check("GET /stats is eligible", isCorsEligible("GET", "/stats"));
check("POST /stats is not eligible (read-only route)", !isCorsEligible("POST", "/stats"));
check(`GET /d/<id> is eligible`, isCorsEligible("GET", `/d/${ID}`));
check(`PUT /d/<id> is eligible`, isCorsEligible("PUT", `/d/${ID}`));
check(`DELETE /d/<id> is eligible`, isCorsEligible("DELETE", `/d/${ID}`));
check(`GET /d/<id>/raw is eligible`, isCorsEligible("GET", `/d/${ID}/raw`));
check(`GET /d/<id>/text is eligible`, isCorsEligible("GET", `/d/${ID}/text`));
check(`GET /d/<id>/source is eligible`, isCorsEligible("GET", `/d/${ID}/source`));
check(`GET /d/<id>/links is eligible`, isCorsEligible("GET", `/d/${ID}/links`));
check(
  "the historical-version BYTES are eligible (the review UI loads two)",
  isCorsEligible("GET", `/d/${ID}/v/3/raw`),
);
check(`GET /s/<slug> is eligible`, isCorsEligible("GET", `/s/${SLUG}`));
check(`GET /s/<slug>/text is eligible`, isCorsEligible("GET", `/s/${SLUG}/text`));
check("GET /admin/documents is eligible", isCorsEligible("GET", "/admin/documents"));
check("POST /admin/documents is eligible", isCorsEligible("POST", "/admin/documents"));
check(
  "POST /admin/documents/<id>/promote is eligible (the JSON twin)",
  isCorsEligible("POST", `/admin/documents/${ID}/promote`),
);
check("GET /admin/agents is eligible", isCorsEligible("GET", "/admin/agents"));
check("DELETE /admin/keys/<id> is eligible", isCorsEligible("DELETE", "/admin/keys/abc"));

// HEAD must be eligible in its own right: withCors sits OUTSIDE withHeadSupport,
// so it sees the literal HEAD before that layer rewrites it to a GET.
check(`HEAD /d/<id>/raw is eligible`, isCorsEligible("HEAD", `/d/${ID}/raw`));
check("HEAD /healthz is eligible", isCorsEligible("HEAD", "/healthz"));

// --- the method split on the two dual-door paths ---------------------------
// PUT is the agent/operator JSON twin; POST on the same path is the manage
// page's HTML form. This is the reason isCorsEligible takes a method at all.
check(`PUT /d/<id>/tags is eligible`, isCorsEligible("PUT", `/d/${ID}/tags`));
check(`PUT /d/<id>/status is eligible`, isCorsEligible("PUT", `/d/${ID}/status`));
check(`POST /d/<id>/tags is NOT eligible`, !isCorsEligible("POST", `/d/${ID}/tags`));
check(`POST /d/<id>/status is NOT eligible`, !isCorsEligible("POST", `/d/${ID}/status`));

// Methods the API doesn't have stay out even on eligible paths.
check("PATCH is never eligible", !isCorsEligible("PATCH", `/d/${ID}`));
check("PUT /healthz is not eligible", !isCorsEligible("PUT", "/healthz"));
check("DELETE /d (the collection) is not eligible", !isCorsEligible("DELETE", "/d"));

// Lower-case methods are normalized (a preflight's
// Access-Control-Request-Method is uppercase by spec, but nothing should hinge
// on that).
check("method comparison is case-insensitive", isCorsEligible("get", `/d/${ID}/raw`));

// --- the anti-oracle property ----------------------------------------------
// The preflight decision must not depend on anything about the document, so a
// private, a revoked and a nonexistent id are indistinguishable. The cheapest
// way to guarantee that is for eligibility to ignore the id entirely — assert
// that three wildly different id shapes agree.
const idShapes = [ID, "aaaaaaaaaaaaaaaaaaaaaa", "not-a-public-id-at-all"];
check(
  "eligibility ignores the id (no existence oracle in a preflight)",
  idShapes.every((x) => isCorsEligible("GET", `/d/${x}/raw`) === true) &&
    idShapes.every((x) => isCorsEligible("GET", `/d/${x}/manage`) === false),
);

// ============================================================================
// 8. withCors — the wrapper itself, driven against a stub inner handler
// ============================================================================
// It needs no bindings: it reads one [var] off `env`, inspects the request, and
// re-wraps whatever the inner handler returned. So the properties that actually
// ship — the preflight bytes, the header stamping, "off means untouched" — are
// testable here rather than only against a running Worker.

// The stub records how many times it was reached, which is how the preflight
// assertions prove no dispatch (and therefore no D1/R2 read) happened.
let innerCalls = 0;
const stubInner = {
  async fetch() {
    innerCalls++;
    return new Response('{"stub":true}', {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: '"v3"',
        // Pre-existing Vary, so the wrapper's append-don't-clobber behaviour is
        // observable (this is exactly what /d/:id/text emits).
        vary: "Accept",
      },
    });
  },
};
const wrapped = withCors(stubInner);
const ENV_ON = { CORS_ALLOWED_ORIGINS: "https://app.example" };
const ENV_OFF = {};
const CTX = { waitUntil() {}, passThroughOnException() {} };

const req = (method, path, headers = {}) =>
  new Request(`https://slopcafe.com${path}`, { method, headers });
const call = (env, request) => {
  innerCalls = 0;
  return wrapped.fetch(request, env, CTX);
};
const hasCreds = (res) => res.headers.has("access-control-allow-credentials");

// --- off / no-Origin: byte-identical to a build without this module ---------
{
  const res = await call(ENV_OFF, req("GET", "/d", { origin: "https://app.example" }));
  check("CORS off: no Allow-Origin", !res.headers.has("access-control-allow-origin"));
  eq("CORS off: Vary untouched", res.headers.get("vary"), "Accept");
  check("CORS off: no credentials header", !hasCreds(res));
}
{
  const res = await call(ENV_ON, req("GET", "/d"));
  check("no Origin header: no Allow-Origin", !res.headers.has("access-control-allow-origin"));
  eq("no Origin header: Vary untouched", res.headers.get("vary"), "Accept");
}

// --- allowed origin, eligible route ----------------------------------------
{
  const res = await call(ENV_ON, req("GET", `/d/${ID}/raw`, { origin: "https://app.example" }));
  eq(
    "allowed + eligible: Allow-Origin echoes the exact origin",
    res.headers.get("access-control-allow-origin"),
    "https://app.example",
  );
  check(
    "allowed + eligible: ETag is exposed (the silent-failure header)",
    (res.headers.get("access-control-expose-headers") ?? "").includes("etag"),
  );
  check(
    "allowed + eligible: x-doc-current-version is exposed",
    (res.headers.get("access-control-expose-headers") ?? "").includes("x-doc-current-version"),
  );
  const vary = res.headers.get("vary") ?? "";
  check("allowed + eligible: Vary keeps Accept AND gains Origin", /Accept/i.test(vary) && /Origin/i.test(vary));
  check("allowed + eligible: NO credentials header", !hasCreds(res));
  eq("allowed + eligible: status and body pass through", res.status, 200);
}

// --- the 304 path: a null-body status must survive the re-wrap --------------
// `serveRaw` answers a matched `If-None-Match` with a bodyless 304, and that is
// the browser reader's HOT path (a gated document's published bytes rarely
// change, so 304 is the likeliest answer it gets). Reconstructing a Response
// with a null-body status throws if a body is attached, so this is the shape
// most likely to blow up in production while every 200-based test stays green.
{
  const notModified = withCors({
    async fetch() {
      return new Response(null, { status: 304, headers: { etag: '"v3"' } });
    },
  });
  // Caught rather than allowed to propagate: the failure mode here is a THROW
  // (the Response constructor rejects a null-body status carrying a body), and
  // an uncaught one would abort the run with a stack trace instead of naming
  // the property that broke.
  let res;
  try {
    res = await notModified.fetch(
      req("GET", `/d/${ID}/raw`, { origin: "https://app.example", "if-none-match": '"v3"' }),
      ENV_ON,
      CTX,
    );
  } catch (err) {
    console.log(`FAIL 304 survives the re-wrap — threw: ${err}`);
    fails++;
    // A stand-in so the assertions below still run and report, rather than
    // cascading into a second, less informative crash.
    res = new Response(null, { status: 599 });
  }
  eq("304 survives the re-wrap", res.status, 304);
  eq(
    "304 carries Allow-Origin",
    res.headers.get("access-control-allow-origin"),
    "https://app.example",
  );
  check(
    "304 exposes the ETag (a revalidation that can't read its own validator is useless)",
    (res.headers.get("access-control-expose-headers") ?? "").includes("etag"),
  );
  check("304 has no credentials header", !hasCreds(res));
}

// --- disallowed origin: no grant, but still Vary ----------------------------
{
  const res = await call(
    ENV_ON,
    req("GET", `/d/${ID}/raw`, { origin: "https://slopcafe.com.evil.example" }),
  );
  check(
    "suffix-attack origin gets NO Allow-Origin",
    !res.headers.has("access-control-allow-origin"),
  );
  check(
    "disallowed origin still gets Vary: Origin (so a cache can't cross-serve the allowed variant)",
    /Origin/i.test(res.headers.get("vary") ?? ""),
  );
}

// --- allowed origin, INELIGIBLE route ---------------------------------------
{
  const res = await call(ENV_ON, req("GET", "/admin/console/agents", { origin: "https://app.example" }));
  check(
    "console page gets no Allow-Origin even from an allowlisted origin",
    !res.headers.has("access-control-allow-origin"),
  );
  eq("console page: Vary untouched", res.headers.get("vary"), "Accept");
}

// --- preflight: the happy path ----------------------------------------------
{
  const res = await call(
    ENV_ON,
    req("OPTIONS", `/d/${ID}`, {
      origin: "https://app.example",
      "access-control-request-method": "PUT",
      "access-control-request-headers": "authorization, if-match, content-type",
    }),
  );
  eq("preflight: 204", res.status, 204);
  eq("preflight: never reaches the inner handler (no dispatch, no DB)", innerCalls, 0);
  eq(
    "preflight: Allow-Origin",
    res.headers.get("access-control-allow-origin"),
    "https://app.example",
  );
  const allowHeaders = res.headers.get("access-control-allow-headers") ?? "";
  check("preflight: allows authorization", allowHeaders.includes("authorization"));
  check("preflight: allows if-match", allowHeaders.includes("if-match"));
  check("preflight: allows content-type", allowHeaders.includes("content-type"));
  check("preflight: does NOT allow x-csrf-token", !allowHeaders.includes("x-csrf-token"));
  check("preflight: advertises PUT", (res.headers.get("access-control-allow-methods") ?? "").includes("PUT"));
  check("preflight: sets a Max-Age", (res.headers.get("access-control-max-age") ?? "") !== "");
  check("preflight: NO credentials header", !hasCreds(res));
  const vary = res.headers.get("vary") ?? "";
  check(
    "preflight: Vary covers all three request headers it read",
    /Origin/i.test(vary) &&
      /Access-Control-Request-Method/i.test(vary) &&
      /Access-Control-Request-Headers/i.test(vary),
  );
}

// --- preflight: refusals fall through, they don't get a distinct status -----
{
  const res = await call(
    ENV_ON,
    req("OPTIONS", `/d/${ID}/manage`, {
      origin: "https://app.example",
      "access-control-request-method": "GET",
    }),
  );
  check("preflight for an ineligible route: no Allow-Origin", !res.headers.has("access-control-allow-origin"));
  eq("preflight for an ineligible route: falls through to the inner handler", innerCalls, 1);
}
{
  const res = await call(
    ENV_ON,
    req("OPTIONS", `/d/${ID}`, {
      origin: "https://evil.example",
      "access-control-request-method": "PUT",
    }),
  );
  check("preflight from a disallowed origin: no Allow-Origin", !res.headers.has("access-control-allow-origin"));
  eq("preflight from a disallowed origin: falls through", innerCalls, 1);
}
{
  // A bare OPTIONS is not a preflight (no Access-Control-Request-Method), so we
  // must not invent a 204 for it.
  const res = await call(ENV_ON, req("OPTIONS", `/d/${ID}`, { origin: "https://app.example" }));
  eq("a bare OPTIONS is not a preflight — inner handles it", innerCalls, 1);
  eq("a bare OPTIONS gets the inner status", res.status, 200);
}

// --- preflight: NOT an existence oracle -------------------------------------
// The same request shape against a private, a revoked and a nonexistent
// document must be indistinguishable. Since the preflight never dispatches,
// the strongest form of that is byte-equality of the whole response.
{
  const serialize = async (res) =>
    JSON.stringify({
      status: res.status,
      headers: [...res.headers].sort(),
      body: await res.text(),
    });
  const ids = ["AbCdEfGhIjKlMnOpQrStUv", "ZzZzZzZzZzZzZzZzZzZzZz", "0000000000000000000000"];
  const shots = [];
  for (const id of ids) {
    shots.push(
      await serialize(
        await call(
          ENV_ON,
          req("OPTIONS", `/d/${id}/raw`, {
            origin: "https://app.example",
            "access-control-request-method": "GET",
          }),
        ),
      ),
    );
  }
  check(
    "preflight bytes are identical for private / revoked / nonexistent ids",
    shots.every((s) => s === shots[0]),
  );
  eq("...and none of the three touched the inner handler", innerCalls, 0);
}

// ============================================================================

if (fails > 0) {
  console.error(`\n${fails} cors test(s) FAILED`);
  process.exit(1);
}
console.log("\nall cors tests passed");
