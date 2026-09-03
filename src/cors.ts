// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-origin access for browser clients (a Flutter Web build of the operator
 * app, served from its own origin, calling this Worker's JSON/byte API).
 *
 * ============================================================================
 * THE ONE RULE: THIS MODULE MUST NEVER EMIT `Access-Control-Allow-Credentials`.
 * ============================================================================
 *
 * Not "should not" — must not, and the reason is specific rather than generic
 * caution. The operator browser session is two host-only cookies
 * (`serializeSetCookie` in src/session.ts never sets `Domain`): `awh_session`,
 * an HttpOnly signed credential, and `awh_csrf`, a readable nonce. The CSRF
 * design is a stateless signed double-submit — the nonce lives *inside* the
 * signed session payload and is also rendered into every operator HTML form
 * (`/admin/console/*`, `/d/:id/manage`, `/login`, `/authorize`). What makes
 * that safe today is the same-origin policy: no other origin can read those
 * pages, so no other origin can learn the nonce.
 *
 * `Access-Control-Allow-Credentials: true` would hand exactly that away. An
 * allowlisted origin (or anything that ever gets onto the allowlist — a
 * forgotten staging host, a subdomain takeover, an operator pasting a URL they
 * were sent) could issue a credentialed cross-origin GET of a console page, the
 * browser would attach `awh_session`, and the page it read back would contain a
 * live CSRF nonce. Every cookie-authenticated mutation in the Worker is then
 * reachable from that origin, and the double-submit defence is gone. So: no
 * credentials, ever. Cross-origin callers authenticate with a **Bearer token**
 * (agent `awh_` key or the operator token) which the caller holds explicitly and
 * the browser never attaches on its own — that is the whole posture.
 *
 * Corollaries worth stating, because they are what keeps the rule cheap:
 *   - Without `Allow-Credentials`, a cross-origin request either carries no
 *     cookies (credentials mode omit/same-origin) or is blocked outright by the
 *     browser (credentials mode include). There is no third outcome, so the
 *     cookie-authenticated surfaces cannot be read cross-origin *even if* one
 *     of them were mistakenly marked eligible below.
 *   - `isCorsEligible` still excludes every cookie/HTML/operator-form surface.
 *     That is defence in depth, not the load-bearing wall — belt and braces on
 *     top of the rule above, in the same spirit as the sanitizer sitting behind
 *     the render CSP.
 *   - `test/cors.test.mjs` scans all of `src/` for the literal header name and
 *     fails the build if it ever appears. Deleting that assertion is how this
 *     rule quietly stops being true.
 *
 * ---------------------------------------------------------------------------
 * SCOPE. This wrapper sits INSIDE the OAuth provider (see the default export in
 * src/index.ts), so it governs the `defaultHandler` surface only — everything
 * except `/mcp`, `/token`, `/register`, `/.well-known/oauth-authorization-server`,
 * and `/.well-known/oauth-protected-resource`, which
 * `@cloudflare/workers-oauth-provider` intercepts and answers itself. The
 * library applies its own CORS to those (it reflects the request `Origin` back
 * with `Allow-Methods: *`; it does NOT set `Allow-Credentials`, so the rule
 * above is not violated there either). We deliberately do not try to override
 * it: two layers writing `Access-Control-Allow-Origin` on one response is how
 * you get a duplicated header and a hard browser failure, and the OAuth
 * endpoints have their own spec-mandated cross-origin behaviour that is not
 * ours to narrow. `/mcp` is therefore NOT eligible here — our allowlist could
 * not govern it even if we claimed it did, and a claim we cannot enforce is
 * worse than an honest omission.
 *
 * OFF BY DEFAULT. `CORS_ALLOWED_ORIGINS` unset or empty means this wrapper
 * returns the inner handler's response untouched, byte for byte — no `Vary`, no
 * preflight interception, nothing. A deployment that does not run a separate
 * web front end behaves exactly as it did before this module existed.
 */

import type { Env } from "./env.js";

/**
 * Request headers a cross-origin caller may send, echoed on every preflight as
 * `Access-Control-Allow-Headers`.
 *
 * A fixed allowlist rather than reflecting `Access-Control-Request-Headers`
 * back: reflection is `*` wearing a costume, and this list is short enough to
 * read. A caller sending something not listed here fails its preflight and the
 * request never leaves the browser — the fail-closed direction.
 *
 * Only headers the API actually reads are listed. The CORS-safelisted ones
 * (`Accept`, `Accept-Language`, `Content-Language`, `Range`) need no entry —
 * the browser sends them without a preflight. `Content-Type` DOES need one:
 * only three form-ish values are safelisted, and every write here is
 * `text/html`, `text/markdown` or `application/json`.
 *
 * **`x-csrf-token` is deliberately absent and must stay absent.** It is the
 * cookie-session surface (`requireOperator` in src/session.ts consults it only
 * when the caller authenticated via cookie), and a cross-origin caller has no
 * cookie session by construction — see the credentials rule above. Listing it
 * would advertise a door that only exists for the credentialed flow we refuse
 * to enable, and would invite a future reader to "complete" the pairing by
 * turning credentials on. `test/cors.test.mjs` pins its absence.
 */
export const CORS_ALLOWED_REQUEST_HEADERS: readonly string[] = [
  "authorization",
  // The reader's hard-refresh path sends `Cache-Control: no-cache` to force a
  // 200 body past any intermediary. Not safelisted, so without this entry the
  // *refresh* button preflight-fails while ordinary reads keep working — a
  // failure mode that reads as "sometimes broken" rather than "misconfigured".
  "cache-control",
  "content-type",
  "if-match",
  "if-none-match",
  "x-content-sha256",
  "x-doc-description",
  "x-doc-slug",
  "x-doc-tags",
  "x-doc-title",
];

/**
 * Response headers a cross-origin caller may READ, emitted as
 * `Access-Control-Expose-Headers`.
 *
 * THIS LIST IS LOAD-BEARING AND ITS FAILURE MODE IS SILENT. By default a
 * cross-origin response exposes only seven safelisted headers (`Cache-Control`,
 * `Content-Language`, `Content-Length`, `Content-Type`, `Expires`,
 * `Last-Modified`, `Pragma`). Everything else reads back as `null` — no error,
 * no console warning, just absent. For this API that means:
 *
 *   - no `etag` → no `If-None-Match` revalidation, no cache key, and no way to
 *     tell which version's bytes are in hand;
 *   - no `x-doc-current-version` → the published-vs-current comparison collapses
 *     (src/served-version.ts; `resolveCurrentVersion` in the Flutter client
 *     reads this header first and the ETag only as a fallback), so a client
 *     silently loses the ability to preflight a `PUT` correctly and 412s;
 *   - no `link` → the `service-desc` pointer on every error body is invisible,
 *     which is the one affordance a confused client has.
 *
 * A whole publication/version-resolution feature therefore degrades to nulls
 * with nothing in any log. Adding a response header that a browser client needs
 * means adding it here in the same change.
 */
export const CORS_EXPOSED_RESPONSE_HEADERS: readonly string[] = [
  "etag",
  // RFC 8631 `service-desc` → /openapi.json, attached to every JSON error.
  "link",
  // Set on the 201 from POST /d and the 200 from PUT /d/:id. Duplicated in the
  // response body's `url`, but a client that follows the header shouldn't have
  // to know that.
  "location",
  "x-converter-version",
  "x-doc-current-version",
  "x-sanitizer-version",
];

/**
 * Methods advertised on a preflight. The real gate is `isCorsEligible`, which
 * has already approved the specific (method, path) pair by the time this is
 * emitted; this list only has to be a superset so the browser's own check
 * passes. `OPTIONS` is not listed — it is the preflight, not a route.
 */
const CORS_ALLOWED_METHODS = "GET, HEAD, POST, PUT, DELETE";

/**
 * How long a browser may cache a preflight result. Two hours is Chromium's own
 * ceiling, so asking for more buys nothing; asking for much less makes every
 * document read pay two round trips, because our GETs carry `Authorization` and
 * `If-None-Match` and therefore always preflight.
 *
 * This is NOT a security window. Removing an origin from the allowlist takes
 * effect immediately regardless: the browser may skip the preflight, but the
 * REAL request's response then comes back without `Access-Control-Allow-Origin`
 * and the browser refuses to hand it to the page. The cache can only ever save
 * a round trip, never grant access.
 */
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 7200;

/**
 * Normalize a string to a canonical HTTP(S) origin (`scheme://host[:port]`), or
 * null if it isn't one.
 *
 * Used on BOTH sides of the comparison — the operator's configured allowlist
 * and the request's `Origin` header — so the two are compared in the same shape
 * and a trailing slash in wrangler.toml is a typo rather than an outage.
 * Scheme and host case-fold (they are case-insensitive), a default port is
 * dropped, and anything carrying a path, query, fragment or userinfo is
 * REJECTED rather than truncated: `https://evil.example/#https://slopcafe.com`
 * is not an origin and must not be quietly turned into one.
 *
 * `http:` is allowed alongside `https:` so a local dev server
 * (`http://localhost:5173`) works; nothing else is (no custom schemes, and the
 * literal `Origin: null` that a sandboxed iframe sends fails to parse and is
 * rejected here, which is the outcome we want).
 */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  // A configured entry may reasonably be pasted with a trailing slash; an
  // Origin header never has one. Strip before parsing so both spellings agree.
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "") return null;
  if (u.username !== "" || u.password !== "") return null;
  return u.origin;
}

/**
 * The SINGLE reader of the `CORS_ALLOWED_ORIGINS` [var] — the same discipline
 * `storageCapBytes` applies to `STORAGE_CAP_BYTES`, and for the same reason: a
 * raw inline `env.X` read is how a misconfigured value silently disables a
 * guard with nothing in the logs. Route every consumer (the wrapper below,
 * `/healthz`) through here so they cannot disagree about what a bad value means.
 *
 * Format: a comma-separated list of exact origins, e.g.
 * `"https://app.slopcafe.com, http://localhost:5173"`. Empty or unset means
 * **CORS is entirely off** — the wrapper then does nothing at all.
 *
 * Fail-closed on garbage: an entry that isn't a well-formed http(s) origin is
 * dropped with a log line and the rest of the list still applies. In particular
 * `*` is NOT a wildcard here — it fails to parse, gets logged, and contributes
 * nothing, so an operator reaching for "allow everything" ends up with CORS off
 * plus a loud reason, rather than an accidentally open API. `/healthz` reports
 * the resulting count, which is where that mistake becomes visible.
 *
 * The value is a public [var], never a secret, so logging it is safe (same
 * judgement as `storage_cap.misconfigured`).
 */
export function corsAllowedOrigins(env: Env): string[] {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const entry = piece.trim();
    if (entry === "") continue;
    const normalized = normalizeOrigin(entry);
    if (normalized === null) {
      console.error("cors.bad_origin", { value: entry });
      continue;
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * Match a request `Origin` against the allowlist, returning the canonical
 * origin to echo back or null.
 *
 * **EXACT MATCH, after normalization — never a prefix or suffix test.** A
 * `endsWith("slopcafe.com")` style check would admit
 * `https://slopcafe.com.evil.example`, and a `startsWith` one would admit
 * `https://slopcafe.com.evil.example` just as happily via
 * `https://slopcafe.compromised.example`. Both are the classic origin-matching
 * bug and both are pinned as attacks in test/cors.test.mjs.
 *
 * We return the ALLOWLIST's canonical spelling rather than reflecting the raw
 * header, so the value we emit is always one the operator wrote down. For a
 * conforming browser the two are byte-identical (an `Origin` header is already
 * a serialized origin); a non-conforming client that sent some other spelling
 * gets a mismatch and is blocked, which is the safe direction.
 */
export function resolveAllowedOrigin(
  origin: string | null | undefined,
  allowed: readonly string[],
): string | null {
  const candidate = normalizeOrigin(origin);
  if (candidate === null) return null;
  for (const entry of allowed) {
    if (entry === candidate) return entry;
  }
  return null;
}

/**
 * Is this (method, path) pair reachable cross-origin at all?
 *
 * DEFAULT DENY. An unrecognized path is not eligible, so a route added without
 * a decision here is simply unreachable from a browser on another origin —
 * annoying, visible, and safe. The opposite default would make forgetting this
 * function a silent widening.
 *
 * ELIGIBLE = the machine-readable API: JSON envelopes and document bytes,
 * authenticated (where authenticated at all) by a Bearer token the caller holds
 * explicitly.
 *
 * NOT ELIGIBLE = every surface whose door is the operator's browser session or
 * whose body is operator HTML: `/login`, `/logout`, `/authorize`, the whole
 * `/admin/console/*` tree, `/d/:id/manage`, `/d/:id/revoke`, and the manage
 * page's HTML form POSTs (`/visibility`, `/slug`, `/tags`, `/status`,
 * `/promote`, `/restore`, `/revoke`). Those pages carry CSRF nonces, and though
 * the no-credentials rule already means a cross-origin reader could never
 * authenticate to them, there is no reason to hand out the affordance. `/mcp`
 * and the OAuth-library endpoints are excluded too — the provider answers them
 * upstream of this wrapper (see the module header), so our allowlist has no say.
 * The HTML browse surfaces (`/`, the framed shells, `/shell.js`) are excluded
 * as well: a browser embeds those in an iframe, which needs no CORS.
 *
 * PURELY SYNTACTIC — it takes a method and a path and touches nothing else. No
 * database read, no id validation, no knowledge of whether a document exists.
 * That is what makes the preflight answer byte-identical for a private, a
 * revoked and a wholly imaginary `public_id`, which is the same
 * no-existence-oracle property every 404 in src/serve.ts is built around.
 */
export function isCorsEligible(method: string, path: string): boolean {
  const m = method.toUpperCase();
  const isRead = m === "GET" || m === "HEAD";

  // --- public static + discovery ---------------------------------------------
  if (path === "/healthz" || path === "/openapi.json") return isRead;

  // App Links / Universal Links verification (issue #50). Same reasoning as
  // the bundled docs below: anonymous JSON with no principal, no cookie, no
  // `Vary: Cookie`, no DB read — bytes identical for every caller (and
  // identical to the ordinary opaque 404 when unconfigured). Nothing here
  // depends on WHO is asking, so nothing is lost by letting a browser on
  // another origin read it too.
  if (path === "/.well-known/assetlinks.json" || path === "/.well-known/apple-app-site-association") {
    return isRead;
  }

  // Bundled platform documentation (issue #4). Eligible despite being HTML,
  // which looks like an exception to "the HTML browse surfaces are excluded" —
  // it isn't. Those are excluded because they are cookie-varying pages on the
  // operator's own session (the shell toolbar changes when signed in), so a
  // credentialed cross-origin read of one would matter. These have no principal
  // at all: no auth check, no cookie, no `Vary: Cookie`, no DB read, and bytes
  // identical for every caller and identical to the public repo they are built
  // from. A separate-origin web client rendering the quickstart is a real
  // consumer, and there is nothing here for a hostile origin to learn.
  //
  // The `/docs` literal is a DELIBERATE SECOND COPY of `PLATFORM_DOCS_PREFIX`
  // (src/platform-docs.ts), which is canonical. This module is a leaf on
  // purpose — test/cors.test.mjs runs it standalone under the strip-types
  // runner, and importing platform-docs.ts would drag the generated bundle's
  // `.md`/`.html` string imports in with it, which Node cannot resolve. Same
  // trade session.ts makes for SERVICE_DESC_LINK. The copy is pinned by a
  // source scan in test/cors.test.mjs, so drift fails the build.
  if (path === "/docs" || path.startsWith("/docs/")) return isRead;

  // --- the document API ------------------------------------------------------
  // Exact-path collection routes first, mirroring the dispatch order in
  // src/index.ts (they sit ahead of the /d/:public_id parse there too).
  if (path === "/d") return isRead || m === "POST";
  if (path === "/d/search" || path === "/d/pack") return isRead;

  if (path.startsWith("/d/")) {
    const tail = path.slice("/d/".length);
    const slash = tail.indexOf("/");
    // /d/:public_id — read the bytes, append a version, revoke.
    if (slash === -1) return isRead || m === "PUT" || m === "DELETE";

    const sub = tail.slice(slash);
    // Historical versions: the operator-only bytes at /d/:id/v/:n/raw are an
    // API read (the review UI loads two of them side by side); the framed
    // shell at /d/:id/v/:n is a browser page and stays out.
    if (sub.startsWith("/v/")) return isRead && sub.endsWith("/raw");

    switch (sub) {
      case "/raw":
      case "/text":
      case "/source":
      case "/links":
        return isRead;
      // Two doors share these two paths: PUT is the agent/operator JSON twin,
      // POST is the manage page's HTML form. Only the JSON one is API — which
      // is precisely why this function takes the method and not just the path.
      case "/tags":
      case "/status":
        return m === "PUT";
      default:
        // /manage, /revoke, /visibility, /slug, /promote, /restore.
        return false;
    }
  }

  // --- the slug twins --------------------------------------------------------
  if (path.startsWith("/s/")) {
    const tail = path.slice("/s/".length);
    const slash = tail.indexOf("/");
    if (slash === -1) return isRead;
    return isRead && tail.slice(slash) === "/text";
  }

  // --- the operator surface --------------------------------------------------
  // THE ORDER OF THESE TWO STATEMENTS IS LOAD-BEARING, in the same way the
  // `!== "search"` term in src/index.ts's admin dispatch is: the console tree
  // must be excluded BEFORE the /admin/ catch-all, or the no-JS HTML console —
  // the one cookie-authenticated, CSRF-nonce-bearing sub-tree under /admin —
  // becomes eligible. Do not regroup them.
  if (path === "/admin" || path === "/admin/console" || path.startsWith("/admin/console/")) {
    return false;
  }
  // Everything else under /admin/ is JSON over the operator Bearer token —
  // agents, keys, OAuth clients, documents, versions, vectors, links, slugs.
  // A catch-all rather than ~30 literals because the property that makes them
  // eligible is uniform (JSON + Bearer) and an enumeration would rot; the cost
  // is that a NEW cookie/HTML admin surface must be added to the exclusion
  // above in the same change that adds it.
  if (path.startsWith("/admin/")) {
    return isRead || m === "POST" || m === "PUT" || m === "DELETE";
  }

  return false;
}

/**
 * Wrap a handler so eligible responses carry CORS headers and eligible
 * preflights are answered here.
 *
 * Placement (src/index.ts): `wrapWithOAuth(withCors(withHeadSupport(inner)))`.
 *   - INSIDE the OAuth provider, because the provider owns `/mcp`, `/token`,
 *     `/register`, `/.well-known/oauth-authorization-server`, and
 *     `/.well-known/oauth-protected-resource`, and already applies its own CORS to
 *     them; wrapping outside would double-write `Access-Control-Allow-Origin`
 *     on those responses, which browsers treat as a hard failure. Everything
 *     the provider hands to `defaultHandler` — i.e. every route we actually own
 *     — passes through here.
 *   - OUTSIDE `withHeadSupport`, so CORS is the outermost of *our* layers and
 *     sees the final response for every route, including the body-stripped
 *     `HEAD` answers that layer synthesizes. (`HEAD` is therefore a method
 *     `isCorsEligible` must accept in its own right, which it does.)
 *
 * A preflight is answered WITHOUT calling the inner handler: no dispatch, no
 * D1, no R2. That is what guarantees an `OPTIONS` for a private, a revoked and
 * a nonexistent document produce identical bytes.
 */
export function withCors(inner: ExportedHandler<Env>): ExportedHandler<Env> {
  return {
    async fetch(
      request: Request<unknown, IncomingRequestCfProperties>,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const origin = request.headers.get("origin");
      // No Origin header — not a cross-origin browser request (curl, an agent,
      // a same-origin GET). Nothing to decide, and nothing added.
      if (origin === null) return inner.fetch!(request, env, ctx);

      const allowlist = corsAllowedOrigins(env);
      // CORS off. Return the inner response completely untouched — not even a
      // `Vary` — so a deployment without the [var] is byte-identical to one
      // built before this module existed.
      if (allowlist.length === 0) return inner.fetch!(request, env, ctx);

      const allowed = resolveAllowedOrigin(origin, allowlist);
      const path = new URL(request.url).pathname;

      // --- preflight ---------------------------------------------------------
      // A preflight is an OPTIONS carrying Access-Control-Request-Method. A bare
      // OPTIONS is not one and falls through to the inner handler (where it
      // matches no route and gets the ordinary 404), so we never invent a
      // response for a request the browser didn't ask us about.
      const requestedMethod =
        request.method === "OPTIONS" ? request.headers.get("access-control-request-method") : null;
      if (requestedMethod !== null) {
        if (allowed !== null && isCorsEligible(requestedMethod, path)) {
          return new Response(null, {
            status: 204,
            headers: {
              "access-control-allow-origin": allowed,
              "access-control-allow-methods": CORS_ALLOWED_METHODS,
              "access-control-allow-headers": CORS_ALLOWED_REQUEST_HEADERS.join(", "),
              "access-control-max-age": String(CORS_PREFLIGHT_MAX_AGE_SECONDS),
              // The answer depends on all three request headers we read, so a
              // shared cache must key on all three.
              vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
            },
          });
        }
        // Disallowed origin, or an ineligible route. Fall through rather than
        // emit a 403: the browser blocks the real request either way (no
        // Allow-Origin means no permission), and a distinct status here would
        // be a free signal about which routes exist.
        return inner.fetch!(request, env, ctx);
      }

      // --- the actual request ------------------------------------------------
      const res = await inner.fetch!(request, env, ctx);
      if (!isCorsEligible(request.method, path)) return res;

      // Reconstructing rather than mutating in place: a Response handed back
      // from an inner layer may carry immutable headers, and `new Response(body,
      // response)` is the idiom for this (it is what workers-oauth-provider does
      // for its own CORS pass). Status, statusText and existing headers are
      // carried over; a null-body status (the 304 that `serveRaw` answers an
      // `If-None-Match` with — the browser reader's hot path) stays bodyless and
      // is legal, since `res.body` is null there. No ELIGIBLE route sets a
      // cookie (every Set-Cookie surface — /login, /logout, the console and
      // consent forms — is excluded above), so the one header whose survival
      // through a Response copy is worth worrying about cannot reach here.
      const out = new Response(res.body, res);
      // `Vary: Origin` rides EVERY eligible response, allowed or not — the
      // response genuinely differs by origin in both directions, and a cache
      // that stored the allowed variant without this could serve it, headers
      // and all, to a different origin. `append` rather than `set` so an
      // existing `Vary: Accept` (the /text content negotiation) survives.
      out.headers.append("vary", "Origin");
      if (allowed !== null) {
        out.headers.set("access-control-allow-origin", allowed);
        out.headers.set(
          "access-control-expose-headers",
          CORS_EXPOSED_RESPONSE_HEADERS.join(", "),
        );
        // Note what is NOT set here, and read the module header before adding
        // anything: `Access-Control-Allow-Credentials`.
      }
      return out;
    },
  };
}
