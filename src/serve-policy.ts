// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Response + security POLICY for the document-serving surface (issue #72
 * phase 4: moved verbatim out of src/serve.ts). Nothing here reads a
 * document; this module is the set of constants and refusal responses every
 * serve-* module (and manage.ts, the admin-*.ts JSON handlers, index.ts) must
 * agree on byte-for-byte:
 *
 *   - `COMMON_HEADERS` — no-store / no-referrer / nosniff / noindex on every
 *     document response;
 *   - `SHELL_CSP` / `RAW_CSP` / `NOTFOUND_CSP` + `SANDBOX` — the two-URL
 *     render wall (docs/security-model.md quotes RAW_CSP + SANDBOX from HERE);
 *   - `notFound` / `notFoundJson` / `notFoundBrowser` — the opaque 404s
 *     (missing, revoked, private-to-anonymous and malformed all answer
 *     identically for the same URL; `idShapeHint` is purely syntactic);
 *   - `unauthorizedJson` + `requireReader` — the credentialed-read gate
 *     (operator ≥ agent, never anonymous) with the in-band discovery hints
 *     (`SERVICE_DESC_LINK`, `API_DISCOVERY_HINT`).
 *
 * Dependency direction: serve.ts, serve-shell.ts and serve-retired-slug.ts
 * import THIS module; it imports none of them. It imports session.ts (via
 * access.ts) — so session.ts keeps its own copy of SERVICE_DESC_LINK.
 */

import { resolvePrincipal } from "./access.js";
import type { Env } from "./env.js";
import { escapeHtml } from "./html.js";
import { PUBLIC_ID_RE } from "./ids.js";
import { SITE_BRAND, validateSlugInput } from "./metadata.js";

/** Headers shared by both routes. Browsers see HTML, no leaks, no caching.
 *  Exported for serve.ts / serve-shell.ts and manage.ts (the operator
 *  manage/revoke pages) so every response carries the identical set. */
export const COMMON_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  // Strip Referer so the secret URL doesn't leak to outbound link destinations.
  "referrer-policy": "no-referrer",
  // Defense-in-depth against MIME sniffing inside the rendered doc.
  "x-content-type-options": "nosniff",
  // noindex belt-and-suspenders: instruct search engines not to index these capability URLs
  "x-robots-tag": "noindex",
};

/**
 * Shell page CSP. Tight: we author this HTML, so it needs only inline styles
 * for layout, a frame source pointing at our own origin, and our own toolbar
 * script.
 *
 * `script-src 'self'` admits ONLY same-origin scripts (the toolbar enhancement
 * at `/shell.js`). This is safe and does NOT weaken the document sandbox, which
 * lives in a *separate* response: the framed bytes at `/d/:id/raw` are governed
 * by RAW_CSP (`default-src 'none'`, no script) AND by the `<iframe sandbox>`
 * attribute (no `allow-scripts`) — neither is touched here. Crucially we use
 * `'self'`, never `'unsafe-inline'`: the shell interpolates escaped document
 * metadata (title/description/author), and `'self'` means an injected inline
 * `<script>` (or `<script src>` pointing at a doc, which `nosniff` blocks from
 * executing) still can't run even if escaping ever failed. `base-uri 'none'`
 * keeps a `<base>` from repointing the relative script URL.
 *
 * `frame-ancestors 'none'` — the shell is the top-level page, never embedded.
 * `form-action 'none'` — the shell intentionally hosts no forms; the toolbar
 * menu items are links to dedicated pages (revoke confirm, login, logout) that
 * have their own CSP.
 */
export const SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Rendered-document CSP. The load-bearing wall from docs/design/action-plan-v1.md.
 *   - `script-src` is covered by `default-src 'none'`
 *   - `style-src 'unsafe-inline'` covers BOTH inline `style="…"` attributes
 *     AND `<style>` blocks — both are allowed through the sanitizer as of
 *     v1.4, and `'unsafe-inline'` permits each (CSS is inert under the
 *     no-`allow-scripts` sandbox; external CSS stays blocked by `default-src`)
 *   - `img/style/font` allow `data:` for inlined assets (e.g. `@font-face`
 *     with a `data:` font, `data:`-URI backgrounds)
 *   - `frame-ancestors 'self'` so only our shell may embed this URL
 */
export const RAW_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline' data:",
  "font-src 'self' data:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * CSP for the static link-only cards: the HTML 404 page (browser document
 * routes), the retired-slug 410 card, and the redirect interstitial. Each
 * hosts only links (sign-in / home / continue) — no forms, no scripts — so
 * `form-action 'none'`. Today these pages interpolate nothing or only
 * escaped+normalized values, so the CSP is defense-in-depth, not the wall —
 * but EVERY server-rendered HTML response must carry one (see the CLAUDE.md
 * convention) so a future edit can't silently ship an unprotected page.
 */
export const NOTFOUND_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Iframe sandbox flags. The two most dangerous capabilities stay OFF:
 *   - no `allow-scripts`     — the document can never run JavaScript
 *   - no `allow-same-origin` — it can never act as our origin / read storage
 * (and with both off it can't lift its own sandbox, either).
 *
 * We DO grant popups so external links can open in a new browser tab.
 * In-frame navigation to any off-origin URL is blocked by the shell's own
 * `frame-src 'self'` (and most sites also send frame-ancestors / XFO), so a
 * plain external link otherwise dead-ends. `allow-popups` lets a clicked
 * `<a target="_blank">` open a tab; `allow-popups-to-escape-sandbox` makes
 * that tab a normal, non-sandboxed top-level context so the destination
 * actually renders (without it the popup inherits the sandbox and loads
 * scriptless/broken).
 *
 * Why this is safe:
 *   - No `allow-scripts` ⇒ no programmatic `window.open`; the ONLY way to
 *     spawn a popup is a real user click on an anchor (forms are dead via
 *     CSP `form-action 'none'`).
 *   - The sanitizer forces `rel="noopener noreferrer"` on every link, so
 *     the escaped tab can't reach `window.opener`.
 *   - `Referrer-Policy: no-referrer` (COMMON_HEADERS) + the iframe's
 *     `referrerpolicy="no-referrer"` keep the secret `/raw` URL — the
 *     document capability — from leaking to the destination.
 *
 * Still OFF: `allow-top-navigation*` — a link must never replace the shell
 * itself; new tab only.
 */
export const SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/**
 * 404 used for both missing rows and revoked documents. Indistinguishable
 * by design — we don't want to confirm that an id ever existed.
 *
 * This is the BYTE/HTML-surface 404 (`/raw`, the version-raw route, the shells
 * that fall back from `notFoundBrowser`). The machine-readable routes use
 * `notFoundJson` below; the two must stay equally uninformative. Exported for
 * manage.ts, whose operator pages 404 with these exact bytes.
 */
export function notFound(): Response {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", ...COMMON_HEADERS },
  });
}

/**
 * `Link` header pointing at the generated OpenAPI document, using the IANA
 * `service-desc` relation (RFC 8631) — the standard "here is this API's machine
 * description" affordance. Attached to the JSON error responses an agent is
 * likeliest to hit while lost, so a caller holding nothing but a base URL and a
 * key can bootstrap from any failed probe. `/healthz` carries the same pointer
 * in its body. Relative-ref on purpose: it resolves against whatever origin
 * answered, so dev/staging/production each self-describe without a baked host.
 *
 * Exported because the `admin-*.ts` modules (the JSON admin + reader surfaces) and `index.ts`
 * (the agent write door + the catch-all) attach the same header. `session.ts`
 * keeps its own copy rather than importing this — this module imports `session.ts`,
 * so the reverse edge would be a module cycle.
 */
export const SERVICE_DESC_LINK = '</openapi.json>; rel="service-desc"';

/**
 * The tail every credentialed-route 401 carries, so an unauthenticated probe
 * teaches instead of just refusing. Same reasoning as SERVICE_DESC_LINK: the
 * only in-band path from "I have a key and a base URL" to "I know the routes"
 * used to be guessing.
 */
export const API_DISCOVERY_HINT =
  " — see /openapi.json for the routes and auth scheme, or /healthz for the API map";

/** The body of an opaque JSON 404 when the caller's own request gives us
 *  nothing safe to add. */
export const NOT_FOUND_MESSAGE =
  "no such document — it may never have existed, or it may have been revoked";

/**
 * Opaque JSON 404 for the CREDENTIALED, machine-readable routes: `/text`,
 * `/source`, `/links`.
 *
 * Same opacity contract as `notFound()` — missing, revoked, and malformed-id
 * all answer identically — but in the shape those routes' OTHER failures
 * already use. `unauthorizedJson`'s 401 and `/source`'s `source_unavailable`
 * 409 are both `{ error, message }`, so a bare `text/plain` body made the most
 * common failure ("that document isn't there") the one case a JSON client
 * couldn't parse; docs/http-api.md has documented these 404s as a `not_found`
 * error code all along. This is the code catching up to the contract.
 *
 * `message` is the only thing that varies, and callers derive it ONLY from the
 * caller's own path segment (see `idShapeHint`) — never from anything we looked
 * up. A private or revoked document's 404 stays byte-identical to a
 * nonexistent one's for the same URL.
 */
export function notFoundJson(message: string = NOT_FOUND_MESSAGE): Response {
  return new Response(JSON.stringify({ error: "not_found", message }), {
    status: 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
      link: SERVICE_DESC_LINK,
      ...COMMON_HEADERS,
    },
  });
}

/**
 * The one hint an id-shaped 404 may carry — built PURELY from the caller's own
 * path segment, with no DB read, so it can never become an existence oracle.
 *
 * The `/d/:public_id/*` routes take the 22-char capability id, but every
 * document in this corpus is *named* by its slug: `/s/<slug>` is the shareable
 * handle and every cross-document link uses it. So "I only know this doc as
 * `slopcafe-http-api`" is the overwhelmingly likely reason a segment fails
 * PUBLIC_ID_RE, and `GET /d?slug=…` exists precisely to close that gap (see
 * `listDocumentsForReader`). Naming it turns a dead end into the next call.
 * It has already bitten at the 22-char boundary, where a slug is
 * indistinguishable from an id by length alone.
 *
 * We deliberately do NOT auto-resolve a slug in the id slot: the two address
 * different things (a capability vs a public name), and silently accepting
 * either would make the distinction mushy — the caller would stop knowing which
 * one it holds, which is exactly how a shared `/s/<slug>` ends up treated as an
 * unguessable URL.
 *
 * `slugRoute` names the slug-addressed twin when one exists — `/text` has
 * `/s/:slug/text`; `/source`, `/links` and `PUT /d/:id` have none, so they
 * point only at the resolver. The echoed value is the slug-VALIDATED,
 * normalized form (≤64 chars of `[a-z0-9_-]`), so it is charset-safe and
 * length-bounded in both a URL and a JSON string — a segment that fails
 * validation is never echoed at all.
 *
 * Exported for `PUT /d/:public_id` (index.ts) and the `/admin/documents/:id/*`
 * mutators (admin-documents.ts), whose `not_found`s hit the same dead end for the same
 * reason. Those call sites reach here AFTER a DB miss rather than after a
 * shape check, so the PUBLIC_ID_RE guard below is load-bearing: a well-formed
 * lowercase public_id also satisfies the slug charset, and telling its owner
 * "that isn't a public_id" would be actively wrong.
 */
export function idShapeHint(id: string, slugRoute: (slug: string) => string | null): string {
  if (PUBLIC_ID_RE.test(id)) return NOT_FOUND_MESSAGE;
  const v = validateSlugInput(id);
  if (!v.ok) return NOT_FOUND_MESSAGE;
  const direct = slugRoute(v.slug);
  return (
    `"${v.slug}" is not a 22-character public_id. If it is a slug, resolve it with ` +
    `GET /d?slug=${v.slug} and use the row's public_id here` +
    (direct ? `, or read it directly at GET ${direct}` : "") +
    "."
  );
}

/**
 * HTML 404 for BROWSER document navigations (the `/d/:id` shell + the `/s/:slug`
 * shell surfaces). Carries a **Sign in** link that round-trips back to the
 * current URL via `/login?next=…`. The motivation: now that documents can be
 * `private` (migration 0011), a perfectly valid URL returns `404` to a
 * logged-out operator — signing in (`canRead(operator) == true`) then renders
 * the document, and the `next` lands them right back here.
 *
 * Shown UNIFORMLY on every browser doc 404 — nonexistent, revoked, malformed
 * id/slug, OR private-to-anonymous alike — so it is **not an existence oracle**:
 * a private document's 404 stays byte-identical to a nonexistent one. The copy
 * says a private document *can* read as "not found" here, never that THIS URL is
 * one. Agent/API 404s keep the plain `notFound()` body (they authenticate and
 * never want HTML); the dual-use slug sites choose by the `Authorization` header.
 */
export function notFoundBrowser(req: Request): Response {
  const url = new URL(req.url);
  const next = `${url.pathname}${url.search}`;
  // encodeURIComponent already yields no HTML-special chars for a path; escape is
  // belt-and-suspenders, matching renderShell's loginHref. /login re-validates
  // `next` via validateNext, so a hostile value can't survive to the redirect.
  const loginHref = escapeHtml(`/login?next=${encodeURIComponent(next)}`);
  return new Response(renderNotFoundPage(loginHref), {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": NOTFOUND_CSP,
      ...COMMON_HEADERS,
    },
  });
}

/** The 404 card (reuses the gone/revoke page chrome). Static copy — no per-URL
 *  detail — so it discloses nothing about whether the target exists. */
function renderNotFoundPage(loginHref: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Not found | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 12px;font-weight:600}
p{margin:0 0 16px;color:#555}
a.btn{display:inline-block;padding:9px 16px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;text-decoration:none}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
</style>
</head>
<body>
<div class="card">
<h1>Not found</h1>
<p>This link doesn't point to anything we can show you. It may never have existed, or it may have been removed.</p>
<p>If you're the operator: a valid link can read as "not found" when its document is <b>private</b>. Sign in to check.</p>
<p><a class="btn" href="${loginHref}">Sign in</a></p>
<p class="note"><a href="/">Go to ${SITE_BRAND}</a></p>
</div>
</body>
</html>
`;
}

/**
 * 401 JSON for the agent-auth read surfaces (serveDocument's bytes branch,
 * serveBySlug's bytes branch, and both `/text` endpoints). Message varies:
 * "invalid agent key" where a header was definitely present (content
 * negotiation only reaches auth when `Authorization` is set), "valid agent key
 * required" on the gated `/text` endpoints where the key may be absent entirely.
 *
 * Every message gets `API_DISCOVERY_HINT` appended HERE rather than at the
 * ~10 call sites, and the response carries the `service-desc` link header: a
 * 401 is the single most likely first response an agent that was handed only a
 * base URL and a key will ever see, so it is the cheapest place to teach it
 * where the routes are documented.
 */
export function unauthorizedJson(message: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", message: message + API_DISCOVERY_HINT }), {
    status: 401,
    headers: { "content-type": "application/json", link: SERVICE_DESC_LINK },
  });
}

/**
 * Gate the non-public read surfaces on "any authenticated principal" — operator
 * OR agent — refusing only anonymous. This is `canRead`'s hierarchy
 * (operator ≥ agent ≥ anonymous) minus the public-visibility branch: the
 * `/text`, `/source`, and slug-text channels, plus the content-negotiated bytes
 * branch of `/d/:id` + `/s/:slug`, are ingestion surfaces that always require a
 * credential (even for a public doc), but the OPERATOR must never rank below an
 * agent. These endpoints used to call `authenticateAgent` directly, which the
 * operator token can't satisfy (it isn't an `awh_` key) — so an operator was
 * refused outright (strictly worse than anonymous on the content-negotiation
 * branch, which downgrades a no-credential caller to the shell). Resolving the
 * full principal restores the hierarchy and lets the operator in via either door
 * (cookie or Bearer), since `resolvePrincipal` checks the operator first.
 *
 * Returns null when a credential resolved (operator or agent); otherwise a
 * ready-to-send 401 carrying the caller's message.
 *
 * ALSO gates the two agent-door classification WRITES (`PUT /d/:id/tags` and
 * `PUT /d/:id/status` in admin-documents.ts) despite the read-flavored name. That is not
 * a widening of authority: in the single-tenant whole-fleet model any active
 * agent key already overwrites every document's CONTENT through `PUT /d/:id`,
 * so letting it retag or deprecate one grants nothing it lacked — and the
 * operator-≥-agent hierarchy this helper exists to preserve is exactly what a
 * write surface needs too. What it deliberately does NOT gate is
 * `setDocumentVisibilityCore` or revoke: those stay `requireOperator`, because
 * visibility is the boundary between "private to the fleet" and "readable by
 * the anonymous internet" and revoke is irreversible. Adding a third surface
 * here means asking whether it belongs on the agent side of THAT line.
 */
export async function requireReader(req: Request, env: Env, message: string): Promise<Response | null> {
  const principal = await resolvePrincipal(req, env);
  return principal.kind === "anonymous" ? unauthorizedJson(message) : null;
}
