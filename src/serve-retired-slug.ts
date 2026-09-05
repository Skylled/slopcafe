// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Retired-slug responses (migrations 0009/0010; issue #72 phase 4: moved
 * verbatim out of src/serve.ts): the 410 Gone pair, the loud redirect pair
 * (browser interstitial / `409 slug_redirected`) and the disclosure gate
 * `redirectTargetReadableBy`.
 *
 * Invariants:
 *   - a redirect is NEVER an automatic 3xx — the human clicks through, the
 *     agent opts in with `?follow_redirects=true`;
 *   - a target the caller cannot `canRead` is indistinguishable from a
 *     dangling one (plain 410, never named), so refusing is not an oracle;
 *   - the 410 card discloses only that a slug once existed, never what it
 *     pointed to.
 *
 * The orchestrator `serveRetiredSlug` stays in src/serve.ts: it hands off to
 * `serveRaw` on a followed redirect, and that edge would otherwise be a
 * runtime import cycle (serve.ts → here → serve.ts). This module imports
 * serve-policy only.
 */

import { canRead, resolvePrincipal, type Visibility } from "./access.js";
import type { RedirectTarget } from "./contract.js";
import type { Env } from "./env.js";
import { escapeHtml } from "./html.js";
import { normalizeTitleForDisplay, SITE_BRAND } from "./metadata.js";
import { COMMON_HEADERS, NOTFOUND_CSP } from "./serve-policy.js";

/**
 * 410 Gone for a RETIRED slug — a slug some document once carried that is now
 * permanently reserved (migration 0009): the doc was revoked, or the slug was
 * renamed/released. Distinct from notFound()'s 404 (a slug no document ever
 * claimed), and the distinction is intentional: a slug is a PUBLIC, shareable
 * handle, so "this was removed" is honest UX worth disclosing — unlike a
 * capability `public_id`, where existence itself is the secret.
 *
 * Two bodies, chosen by the caller from the request's `Authorization` header so
 * the slug surface's content-negotiation contract is preserved: a friendly HTML
 * card for browsers, machine-readable JSON for agent-key callers. (Chunk 2 will
 * branch earlier on a tombstone that carries a redirect — this is the
 * no-redirect terminal case.)
 */
export function goneHtml(): Response {
  const html = renderGonePage();
  return new Response(html, {
    status: 410,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": NOTFOUND_CSP,
      ...COMMON_HEADERS,
    },
  });
}

export function goneJson(): Response {
  return new Response(
    JSON.stringify({
      error: "gone",
      message:
        "this slug is retired: the document it pointed to was revoked, or the slug was " +
        "renamed or released. Slugs are not reused, so this handle will not resolve again.",
    }),
    { status: 410, headers: { "content-type": "application/json", ...COMMON_HEADERS } },
  );
}

/**
 * Friendly 410 card for a retired slug, reusing the revoke page's card chrome.
 * No per-slug detail (no title, no origin doc) — a retired slug discloses only
 * that it once existed, not what it pointed to. Static, so no escaping needed.
 */
function renderGonePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Link retired | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 12px;font-weight:600}
p{margin:0 0 16px;color:#555}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
</style>
</head>
<body>
<div class="card">
<h1>This link is retired</h1>
<p>The document that lived at this address was removed, or its handle was changed. This link will not be reused for a different document, so it won't start pointing somewhere unexpected.</p>
<p class="note"><a href="/">Go to ${SITE_BRAND}</a></p>
</div>
</body>
</html>
`;
}

/**
 * Canonical same-origin path for a redirect target: its pretty `/s/<slug>` if it
 * still carries a slug, else the capability `/d/<public_id>`. Both components
 * are charset-validated at the source (slug regex / PUBLIC_ID_RE), so the path
 * is safe to build; callers still escape it before putting it in HTML.
 */
function targetCanonicalPath(target: RedirectTarget): string {
  return target.slug ? `/s/${target.slug}` : `/d/${target.public_id}`;
}

/**
 * Machine-readable response for a retired slug that carries a redirect, when the
 * caller has NOT opted into following it. `409 slug_redirected`, deliberately
 * NOT a 3xx: curl `-L` and most HTTP libraries auto-follow 3xx silently, which
 * is the opposite of the loud, opt-in behavior we want. A 4xx makes the client
 * stop and read the body; 409 (vs 410's terminal "gone") signals "recoverable —
 * opt in to follow." The agent follows by re-requesting with
 * `?follow_redirects=true` (HTTP) or reading the target's public_id directly.
 */
export function slugRedirectedJson(slug: string, target: RedirectTarget): Response {
  return new Response(
    JSON.stringify({
      error: "slug_redirected",
      message: `this slug now redirects to another document; it is not served here`,
      slug,
      redirect_to: {
        public_id: target.public_id,
        slug: target.slug,
        title: target.title,
      },
      hint: "retry with ?follow_redirects=true to be served the target, or read it by its public_id",
    }),
    { status: 409, headers: { "content-type": "application/json", ...COMMON_HEADERS } },
  );
}

/**
 * Loud browser interstitial for a retired slug that redirects: a card the human
 * must click through, never an automatic 3xx. This is the deliberate "this name
 * moved — go there?" gate (operator branding/consolidation, or a rename's
 * auto-forward). The link points at the target's current canonical URL.
 */
export function redirectInterstitial(target: RedirectTarget): Response {
  const href = escapeHtml(targetCanonicalPath(target));
  const titleRaw = target.title ? normalizeTitleForDisplay(target.title) : "";
  const label = escapeHtml(titleRaw.length > 0 ? titleRaw : targetCanonicalPath(target));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Link moved | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 12px;font-weight:600}
p{margin:0 0 16px;color:#555}
.row{display:flex;gap:8px;margin-top:18px}
a.go{flex:1;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;text-align:center;text-decoration:none;box-sizing:border-box}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
</style>
</head>
<body>
<div class="card">
<h1>This link has moved</h1>
<p>The document that used to live here now points to <b>${label}</b>. Continue to follow the redirect.</p>
<div class="row"><a class="go" href="${href}">Continue →</a></div>
<p class="note"><a href="/">Go to ${SITE_BRAND} instead</a></p>
</div>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": NOTFOUND_CSP,
      ...COMMON_HEADERS,
    },
  });
}

/**
 * May THIS caller be told anything about a resolved redirect target?
 *
 * `resolveRedirectTarget` filters on `revoked_at` but NOT on `visibility` — it
 * predates migration 0011 — so on its own it will happily hand a target's title
 * and canonical path (`/s/<slug>`, or the bare capability `/d/<public_id>` when
 * the target carries no slug) to an anonymous browser. That is a real leak, and
 * an easily-armed one: every rename tombstones the OLD slug with `redirect_to`
 * pointing at the doc's own `public_id` (document-slug.ts `tombstoneSlug`), and new docs
 * are born private — so renaming a private doc's slug would otherwise turn the
 * old, low-entropy, probably-already-shared handle into a title-and-address
 * oracle for a document whose `/d/:id` and `/s/:new-slug` both 404 to that same
 * caller.
 *
 * The gate is `canRead`, exactly as on every other metadata-serving surface.
 * Operator and agent read the whole fleet (single-tenant trust), so they short-
 * circuit without the extra query and their branches — the `409 slug_redirected`
 * JSON, the `?follow_redirects=true` follow — behave exactly as before; the
 * check lives on ONE path rather than being a browser-branch special case, so a
 * future credentialed surface can't reintroduce the leak by forgetting it.
 *
 * `false` is deliberately indistinguishable from a dangling target: the caller
 * falls through to the plain 410, the same answer a revoked target gives, so
 * refusing to name the target doesn't itself become an oracle.
 *
 * (Fixing this inside `resolveRedirectTarget` would be tidier, but `visibility`
 * is not part of the wire `RedirectTarget` shape and shouldn't be — see the
 * follow-up note in the design docs.)
 */
export async function redirectTargetReadableBy(
  env: Env,
  req: Request,
  target: RedirectTarget,
): Promise<boolean> {
  const principal = await resolvePrincipal(req, env);
  if (principal.kind !== "anonymous") return true;
  const row = await env.META.prepare(
    "select visibility, revoked_at from documents where public_id = ?",
  )
    .bind(target.public_id)
    .first<{ visibility: Visibility; revoked_at: string | null }>();
  // No row at all means the id never existed — revoke TOMBSTONES the `documents`
  // row (sets `revoked_at`), it never deletes it — so this is belt-and-suspenders
  // after `resolveRedirectTarget` just matched the same id. `revoked` is READ
  // rather than hardcoded false so the predicate is correct standing alone:
  // `resolveRedirectTarget` filters revoked rows today, but a revoke landing
  // between the two reads must still resolve to "don't name it."
  if (!row) return false;
  return canRead(principal, { visibility: row.visibility, revoked: row.revoked_at !== null });
}
