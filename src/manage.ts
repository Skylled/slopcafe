// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator document-management UI — the browser-only, cookie-session plane over
 * ONE document. Split out of serve.ts as a pure move (GitHub issue #53); the
 * render wall (`serveRaw` / `serveShell` / `serveBySlug` / `serveHomepage`, the
 * CSP + sandbox constants, `requireReader`, the 404 helpers, `/text` `/source`
 * `/links`, the operator version-raw/shell routes) stays there.
 *
 *   GET  /d/:public_id/revoke     → operator-ONLY confirmation page (opaque 404 to
 *                                   anyone else, resolved before any DB hit)
 *   POST /d/:public_id/revoke     → verifies operator_token / session and calls
 *                                   revokeDocumentCore
 *   GET  /d/:public_id/manage     → the manage page (sign-in card, no DB hit,
 *                                   without a cookie session)
 *   POST /d/:public_id/visibility → flip public/private (setDocumentVisibilityCore)
 *   POST /d/:public_id/slug       → add/rename/clear the slug (setDocumentSlugCore)
 *   POST /d/:public_id/tags       → full-replace tags (setDocumentTagsCore)
 *   POST /d/:public_id/status     → lifecycle status (setDocumentStatusCore)
 *   POST /d/:public_id/restore    → restore a version as a NEW version
 *   POST /d/:public_id/promote    → promote a version to `published_ver`
 *
 * Edges are strictly one-way: this module imports serve.ts (`COMMON_HEADERS` +
 * `notFound`, so its 404s stay byte-identical to the render wall's), core.ts,
 * session.ts and html.ts — serve.ts never imports it. Every HTML response here
 * carries REVOKE_CSP (below): every server-rendered page needs a CSP constant.
 */

import type { Visibility } from "./access.js";
import { authenticateOperator } from "./auth.js";
import {
  type DocumentStatus,
  listVersionsCore,
  promoteVersionCore,
  restoreVersionCore,
  revokeDocumentCore,
  type SetSlugOk,
  setDocumentSlugCore,
  setDocumentStatusCore,
  setDocumentTagsCore,
  setDocumentVisibilityCore,
  type VersionListing,
} from "./core.js";
import { parseStoredTags } from "./document-listing.js";
import type { Env } from "./env.js";
import { escapeHtml, formatCreatedAt } from "./html.js";
import { PUBLIC_ID_RE } from "./ids.js";
import { documentLinksCore } from "./links-core.js";
import { formatSlugReject, normalizeTitleForDisplay, SITE_BRAND } from "./metadata.js";
import { COMMON_HEADERS, notFound } from "./serve.js";
import { authenticateOperatorRequest, authorizeOperatorForm, csrfMatches } from "./session.js";
import type { WaitUntil } from "./vector-io.js";

/**
 * CSP for the revoke confirmation + result pages. Identical to SHELL_CSP
 * except `form-action 'self'` so the confirmation form can POST same-origin.
 * No iframe is loaded from these pages, so `frame-src` is irrelevant.
 */
const REVOKE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/**
 * GET /d/:public_id/revoke — confirmation page for an operator about to
 * revoke a document. Mirrors the /authorize consent shape: card layout,
 * Confirm/Cancel.
 *
 * OPERATOR-ONLY, and the check runs BEFORE the DB hit — same discipline as
 * `serveManagePage`. It used to read `documents` first and branch 200-vs-404 on
 * existence for ANY caller, which made this the one `/d/:id/*` GET that told a
 * `public_id` holder whether the document was still alive: `/d/:id`, `/d/:id/raw`
 * and `/s/:slug` all hide a private doc behind the opaque 404 (migration 0011),
 * but this page still answered `200 text/html` for it — and, by polling, leaked
 * the exact moment of a revoke. Resolving the operator first makes live, private
 * and never-existed byte-identical to everyone else.
 *
 * (Not deleted despite the manage page absorbing revoke: `GET /d/:id/revoke` is
 * still a published route — openapi.json / docs/http-api.md — and the POST's
 * error card links back here as the retry target.)
 *
 * Session-aware: if the operator already has a valid browser session cookie,
 * the form is a plain Revoke button carrying a hidden CSRF token (the *verified*
 * session nonce — no token paste). A Bearer-authed operator gets the token-paste
 * field instead (no session nonce to embed). `Vary: Cookie` because the rendered
 * body depends on the cookie (already `no-store`, so this is belt-and-suspenders).
 *
 * Returns the same opaque 404 as the shell for missing/revoked docs so an
 * operator can't probe whether an id ever existed either — and the non-operator
 * 404 is the browser login-link card (`notFoundBrowser`), which reads no
 * document state, so signing in and coming back is the recovery path.
 */
export async function serveRevokeConfirm(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  // Auth FIRST — before any query, so a non-operator's response can't depend on
  // document state. This route used to read D1 up front and branch 200-vs-404
  // on existence, which made it an existence oracle for PRIVATE documents that
  // `/d/:id` correctly hides.
  const auth = await authenticateOperatorRequest(req, env);

  if (!auth.ok) {
    // A caller that tried a credential (Authorization header) is an API client:
    // give it the same opaque 404 every other agent surface gives.
    if (req.headers.has("authorization")) return notFound();
    // A plain browser gets the paste-the-token confirm form — the flow
    // `handleRevokeForm` documents, and the target of the "Try again" link on
    // its error cards. Rendering it costs NO query, so the bytes are identical
    // for a live, private, revoked, or never-existent id: still no oracle. A
    // wrong id simply fails at POST time with "not found or already revoked".
    return new Response(renderRevokePage("confirm", publicId, undefined, false, undefined, null), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": REVOKE_CSP,
        vary: "Cookie",
        ...COMMON_HEADERS,
      },
    });
  }

  // Authenticated operator: now the document state is theirs to see, so a
  // missing/already-revoked id can 404 honestly. A cookie session also lets
  // them confirm without re-pasting the token — the hidden field carries the
  // session-bound CSRF nonce.
  const csrfToken = auth.via === "cookie" ? auth.csrf : null;

  const row = await env.META.prepare(
    "select revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ revoked_at: string | null }>();
  if (!row || row.revoked_at) return notFound();

  return new Response(renderRevokePage("confirm", publicId, undefined, false, undefined, csrfToken), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": REVOKE_CSP,
      vary: "Cookie",
      ...COMMON_HEADERS,
    },
  });
}

/**
 * POST /d/:public_id/revoke — authorizes via EITHER path, then forwards to
 * `revokeDocumentCore`:
 *
 *   - Pasted token: a non-empty `operator_token` form field is validated via
 *     `authenticateOperator` (synthetic Bearer header, the same primitive that
 *     gates the JSON DELETE route and the OAuth consent flow). No CSRF token is
 *     required — the pasted token IS the inline credential, not an ambient one.
 *   - Browser session: if no token was pasted, a valid session cookie plus a
 *     matching `csrf_token` form field authorizes the revoke. CSRF is required
 *     here precisely because the cookie is ambient.
 *
 * Returns terminal HTML — never 302s, since the underlying doc is gone.
 * Result pages share REVOKE_CSP even though they host no form; cheaper
 * than authoring a third CSP for a one-shot screen.
 */
export async function handleRevokeForm(
  publicId: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) {
    return revokeResultResponse(
      404,
      renderRevokePage("error", publicId, "Document not found or already revoked."),
    );
  }

  const form = await req.formData();
  const operatorToken = String(form.get("operator_token") ?? "");

  if (operatorToken) {
    // Pasted-token path. Mirror authorize.ts: build a synthetic Bearer request
    // so the same operator-auth primitive backs every operator-facing surface.
    const synth = new Request(req.url, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    if (!authenticateOperator(synth, env)) {
      return revokeResultResponse(
        401,
        renderRevokePage("error", publicId, "Operator token incorrect.", true),
      );
    }
  } else {
    // Browser-session path: valid cookie + matching CSRF token.
    const auth = await authenticateOperatorRequest(req, env);
    if (!auth.ok || auth.via !== "cookie") {
      return revokeResultResponse(
        401,
        renderRevokePage("error", publicId, "Sign in or paste the operator token to revoke.", true),
      );
    }
    if (!csrfMatches(String(form.get("csrf_token") ?? ""), auth.csrf)) {
      return revokeResultResponse(
        403,
        renderRevokePage("error", publicId, "CSRF check failed — reload and try again.", true),
      );
    }
  }

  const result = await revokeDocumentCore(env, publicId, ctx.waitUntil.bind(ctx));
  if (!result.ok) {
    return revokeResultResponse(
      404,
      renderRevokePage("error", publicId, "Document not found or already revoked."),
    );
  }

  return revokeResultResponse(
    200,
    renderRevokePage("success", publicId, undefined, false, result.r2_objects_purged),
  );
}

function revokeResultResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": REVOKE_CSP,
      ...COMMON_HEADERS,
    },
  });
}

/**
 * Single template for the confirm page and the two result pages — they all
 * share the same card chrome from /authorize. `mode` picks the body.
 *
 *  - `confirm`: warning + form. `error`/`success`: terminal screens.
 *  - `retryLink` (error only): link target is the confirmation page so the
 *    operator can re-paste the token; omit for definitive errors (bad id,
 *    already-revoked) where retrying makes no sense.
 *  - `purged` (success only): number of R2 objects deleted.
 *  - `csrfToken` (confirm only): when set, the operator has a live browser
 *    session, so the form is a plain Revoke button carrying this hidden CSRF
 *    token — no password field. When null, fall back to the token-paste field.
 */
function renderRevokePage(
  mode: "confirm" | "error" | "success",
  publicId: string,
  errorMessage?: string,
  retryLink?: boolean,
  purged?: number,
  csrfToken?: string | null,
): string {
  const safeId = escapeHtml(publicId);
  let body: string;
  if (mode === "confirm") {
    const formInner = csrfToken
      ? `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
<p class="note">Signed in as operator — no token needed.</p>`
      : `<label for="operator_token">Operator token</label>
<input id="operator_token" name="operator_token" type="password" required autocomplete="off">`;
    body = `<h1>Revoke <span class="mono">${safeId}</span>?</h1>
<p>Bytes are purged from R2 immediately and the URL will <b>404 forever</b>. The <code>versions</code> audit trail is kept; only the rendered HTML is destroyed. This cannot be undone.</p>
<form method="POST" action="/d/${publicId}/revoke">
${formInner}
<div class="row">
<a class="cancel" href="/d/${publicId}">Cancel</a>
<button type="submit">Revoke</button>
</div>
</form>`;
  } else if (mode === "error") {
    const retry = retryLink
      ? `<p class="note"><a href="/d/${publicId}/revoke">Try again</a></p>`
      : "";
    body = `<h1>Revoke failed</h1>
<p>${escapeHtml(errorMessage ?? "Unknown error.")}</p>
${retry}`;
  } else {
    const n = purged ?? 0;
    body = `<h1>Document revoked</h1>
<p><span class="mono">${safeId}</span> is gone. <b>${n}</b> R2 object${n === 1 ? "" : "s"} purged. This URL will now 404.</p>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Revoke document | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 12px;font-weight:600}
p{margin:0 0 16px;color:#555}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#222}
label{display:block;margin:18px 0 6px;font-size:13px;color:#555}
input[type=password]{width:100%;box-sizing:border-box;padding:9px 10px;font:13px/1.4 system-ui,sans-serif;border:1px solid #ccc;border-radius:4px}
.row{display:flex;gap:8px;margin-top:18px}
button,a.cancel{flex:1;padding:10px 14px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;cursor:pointer;text-align:center;text-decoration:none;box-sizing:border-box}
button{background:#a00;color:#fff;border-color:#a00}
a.cancel{background:#fff;color:#222}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
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

/* ------------------------------------------------------------------------- *
 * Operator document-management page (`/d/:public_id/manage`).
 *
 * One page, every per-document operator action folded together (the "Manage…"
 * toolbar item replaces the old standalone "Revoke…"): toggle visibility,
 * add/rename/clear the slug, set lifecycle status, edit tags, publish or restore
 * a version, and revoke. All are operator-only and reversible EXCEPT revoke.
 * Publishing (issue #43) is the one that decides what the open web actually
 * renders, so it lives next to the version history it acts on rather than in its
 * own section. The page renders its CONTROLS only for a live browser SESSION
 * (cookie) — the CSRF nonce the forms echo comes from that session, and this is
 * browser-only UI; a Bearer-only or anonymous caller gets a sign-in prompt
 * instead. The POST handlers still accept a pasted operator token too (parity
 * with handleRevokeForm), so a hand-built curl form works.
 *
 * Shares REVOKE_CSP (`form-action 'self'`) so the page's POST forms submit
 * same-origin. The revoke form posts to the EXISTING `/d/:id/revoke`
 * (handleRevokeForm) verbatim — no new revoke code.
 * ------------------------------------------------------------------------- */

/** Current state the manage page renders. */
type ManageState = {
  publicId: string;
  visibility: Visibility;
  /** The document's newest version, and the one promoted for the public page
   *  (migration 0018; `publishedVer` is null when nothing is published yet). */
  currentVer: number | null;
  publishedVer: number | null;
  slug: string | null;
  /** Document-level classification (migration 0012); [] when unset. */
  tags: string[];
  /** Lifecycle status (migration 0014) + the optional replacement pointer. */
  status: DocumentStatus;
  supersededBy: string | null;
  title: string | null;
  /** Full version history, newest first (listVersionsCore). */
  versions: VersionListing[];
  /** Link-graph neighborhood (migration 0016 / issue #40): live docs that link
   * here + this doc's outbound links with resolution states. */
  backlinks: Array<{ public_id: string; slug: string | null; title: string | null }>;
  outbound: Array<{
    kind: "public_id" | "slug";
    value: string;
    state: "live" | "redirected" | "retired" | "revoked" | "missing";
    target_public_id: string | null;
    title: string | null;
  }>;
};

/** A one-line banner above the manage sections after a POST. */
type ManageNotice = { kind: "ok" | "err"; message: string };

/**
 * Load the live document's management-relevant state. Returns null for a
 * missing or revoked document (callers map that to the opaque 404 / a
 * "not found" notice). Same LEFT JOIN shape as serveShell, trimmed.
 */
async function loadManageState(env: Env, publicId: string): Promise<ManageState | null> {
  // Titles here label the operator's own working copy, so this join stays on
  // `current_ver` (the version-history table below labels each row from its own
  // `versions` row anyway). The published pointer rides along as a number — the
  // page reports the two pointers, it doesn't render either version's bytes.
  const row = await env.META.prepare(
    `select d.revoked_at, d.visibility, d.current_ver, d.published_ver, d.slug, d.tags,
       d.status, d.superseded_by, v.title as doc_title
       from documents d
       left join versions v on v.document_id = d.id and v.version_no = d.current_ver
      where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      revoked_at: string | null;
      visibility: Visibility;
      current_ver: number | null;
      published_ver: number | null;
      slug: string | null;
      tags: string | null;
      status: DocumentStatus;
      superseded_by: string | null;
      doc_title: string | null;
    }>();
  if (!row || row.revoked_at) return null;
  // History is cheap (D1-only). listVersionsCore re-checks liveness; on the rare
  // race where the doc revokes between the two reads it returns [], which the
  // page renders as "no history" rather than throwing.
  const history = await listVersionsCore(env, publicId);
  // Link graph (migration 0016) — D1-only too; same revoke-race posture: a
  // not_found here renders as an empty panel rather than throwing.
  const links = await documentLinksCore(env, publicId);
  return {
    publicId,
    visibility: row.visibility,
    currentVer: row.current_ver,
    publishedVer: row.published_ver,
    slug: row.slug,
    // Stored as a JSON array string (NULL when unset) — parseStoredTags is the
    // same reader the list/search cores use, so the editor field round-trips
    // exactly what those surfaces see.
    tags: parseStoredTags(row.tags),
    status: row.status,
    supersededBy: row.superseded_by,
    title: row.doc_title,
    versions: history.ok ? history.versions : [],
    backlinks: links.ok
      ? links.backlinks.map((b) => ({ public_id: b.public_id, slug: b.slug, title: b.title }))
      : [],
    outbound: links.ok ? links.outbound : [],
  };
}

/** Standard manage-surface Response: HTML, REVOKE_CSP, Vary: Cookie, no-store. */
function manageResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": REVOKE_CSP,
      vary: "Cookie",
      ...COMMON_HEADERS,
    },
  });
}

/**
 * GET /d/:public_id/manage — the operator management page. Cookie session
 * required to see the controls; a non-cookie caller gets a sign-in prompt
 * rendered WITHOUT a DB hit, so it discloses nothing about whether the id
 * exists (no existence oracle for a guessed public_id — the public_id is
 * already the read capability, so this adds nothing the shell doesn't).
 */
export async function serveManagePage(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok || auth.via !== "cookie") {
    return manageResponse(renderManageSignin(publicId));
  }

  const state = await loadManageState(env, publicId);
  if (!state) return notFound();
  return manageResponse(renderManagePage(state, auth.csrf));
}

/**
 * POST /d/:public_id/visibility — operator flips a live doc public/private via
 * the manage page's toggle form. No version bump. On the cookie path the page
 * re-renders with a notice; on the pasted-token path a terminal result card.
 */
export async function handleVisibilityForm(
  publicId: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) return manageResultCard(publicId, authz.status, { kind: "err", message: authz.message });

  const target = String(form.get("visibility") ?? "");
  const result = await setDocumentVisibilityCore(env, publicId, target, waitUntil);
  if (!result.ok) {
    const msg =
      result.code === "invalid_visibility"
        ? "Invalid visibility value."
        : "Document not found.";
    const status = result.code === "not_found" ? 404 : 400;
    return finishManage(publicId, env, authz, { kind: "err", message: msg }, status);
  }
  const msg =
    result.visibility === "public"
      ? "Document is now public — anyone with the link can view it."
      : "Document is now private — hidden from the open web (you and your agents still see it).";
  return finishManage(publicId, env, authz, { kind: "ok", message: msg });
}

/**
 * POST /d/:public_id/slug — operator add/rename/clear a live doc's slug via the
 * manage page's slug form. No version bump; a rename auto-forwards the old name
 * (setDocumentSlugCore). On the cookie path the page re-renders with a notice;
 * on the pasted-token path a terminal result card.
 */
export async function handleSlugForm(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) return manageResultCard(publicId, authz.status, { kind: "err", message: authz.message });

  const slug = String(form.get("slug") ?? "");
  const result = await setDocumentSlugCore(env, publicId, slug);
  if (!result.ok) {
    let msg: string;
    let status: number;
    switch (result.code) {
      case "not_found":
        msg = "Document not found.";
        status = 404;
        break;
      case "invalid_slug":
        msg = formatSlugReject(result.reason);
        status = 422;
        break;
      case "slug_taken":
        msg = `That link (/s/${result.slug}) is already in use by another live document.`;
        status = 409;
        break;
      case "slug_retired":
        msg =
          `That link (/s/${result.slug}) was used before and is retired — links are never ` +
          `reused. (Free it with DELETE /admin/slugs/${result.slug} only if you really mean to.)`;
        status = 409;
        break;
    }
    return finishManage(publicId, env, authz, { kind: "err", message: msg }, status);
  }
  return finishManage(publicId, env, authz, { kind: "ok", message: slugSuccessMessage(result) });
}

/**
 * POST /d/:public_id/tags — operator full-replaces a live doc's tags via the
 * manage page's tags form. Document-level classification (migration 0012): no
 * version bump, no FTS write (since 0012 tags aren't FTS-indexed). The "tags"
 * field is comma-separated; we split + trim + drop empties before handing the
 * list to setDocumentTagsCore, which sanitizes charset / dedupes / caps it the
 * same way the publish/update write path does (so the stored bytes match). On
 * the cookie path the page re-renders with a notice; on the pasted-token path a
 * terminal result card. This is the browser twin of POST /admin/documents/:id/tags.
 */
export async function handleTagsForm(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) return manageResultCard(publicId, authz.status, { kind: "err", message: authz.message });

  // Comma-separated → trimmed list, empties dropped. Charset/length/dedupe/cap
  // enforcement (and the silent drop of invalid chars) is setDocumentTagsCore's
  // job, so this only normalizes the comma-list shape — never rejects.
  const tags = String(form.get("tags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const result = await setDocumentTagsCore(env, publicId, tags);
  if (!result.ok) {
    return finishManage(publicId, env, authz, { kind: "err", message: "Document not found." }, 404);
  }
  const msg = `Tags updated: ${result.tags.length ? result.tags.join(", ") : "(none)"}.`;
  return finishManage(publicId, env, authz, { kind: "ok", message: msg });
}

/**
 * POST /d/:public_id/status — operator sets a live doc's lifecycle status via
 * the manage page's status form (migration 0014). No version bump; mirrors the
 * visibility/tags forms. The optional `superseded_by` field (deprecate only)
 * names the replacement doc by public_id — full-replace per submit, validated
 * by setDocumentStatusCore (live target, no self-pointer).
 */
export async function handleStatusForm(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) return manageResultCard(publicId, authz.status, { kind: "err", message: authz.message });

  const status = String(form.get("status") ?? "");
  const supersededBy = String(form.get("superseded_by") ?? "").trim();
  const result = await setDocumentStatusCore(env, publicId, status, supersededBy || null);
  if (!result.ok) {
    let msg: string;
    let httpStatus: number;
    switch (result.code) {
      case "not_found":
        msg = "Document not found.";
        httpStatus = 404;
        break;
      case "invalid_status":
        msg = "Invalid status value.";
        httpStatus = 400;
        break;
      case "bad_target":
        msg = `"${result.target}" is not a live document's public_id (or is this document itself), so it can't be the replacement.`;
        httpStatus = 422;
        break;
    }
    return finishManage(publicId, env, authz, { kind: "err", message: msg }, httpStatus);
  }
  const msg =
    result.status === "deprecated"
      ? result.superseded_by
        ? `Document marked deprecated — superseded by /d/${result.superseded_by}. It stays readable and searchable (marked), but context packs skip it.`
        : "Document marked deprecated. It stays readable and searchable (marked), but context packs skip it."
      : "Document marked active again.";
  return finishManage(publicId, env, authz, { kind: "ok", message: msg });
}

/**
 * POST /d/:public_id/restore — operator restores a historical version via the
 * manage page's history table. restoreVersionCore re-publishes that version's
 * content + metadata as a NEW version (never a current_ver rewind). Same auth
 * ladder as the other manage forms. The writer is the `{ kind: "operator" }`
 * principal (migration 0013) — the restored version records author_kind
 * "operator"; documents.created_by is untouched, exactly like any update.
 */
export async function handleRestoreForm(
  publicId: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) return manageResultCard(publicId, authz.status, { kind: "err", message: authz.message });

  const verStr = String(form.get("version") ?? "");
  if (!/^[1-9][0-9]*$/.test(verStr)) {
    return finishManage(publicId, env, authz, { kind: "err", message: "Invalid version number." }, 400);
  }
  const versionNo = Number(verStr);
  const origin = new URL(req.url).origin;
  const result = await restoreVersionCore(
    env,
    publicId,
    versionNo,
    { kind: "operator" },
    origin,
    ctx.waitUntil.bind(ctx),
  );
  if (!result.ok) {
    let msg: string;
    let status: number;
    switch (result.code) {
      case "not_found":
        msg = "Document not found.";
        status = 404;
        break;
      case "version_not_found":
        msg = `Version v${versionNo} does not exist.`;
        status = 404;
        break;
      case "source_unavailable":
        msg =
          `Version v${versionNo} predates source retention, so it can't be restored. ` +
          `Revoke and republish the document to refresh it.`;
        status = 409;
        break;
      case "version_conflict":
        msg = "The document changed while restoring — reload and try again.";
        status = 409;
        break;
      case "empty_body":
        msg = "That version has no content to restore.";
        status = 400;
        break;
      case "too_large":
        msg = "That version exceeds the size limit and can't be restored.";
        status = 413;
        break;
      case "too_deep":
        msg = "That version is nested too deeply and can't be restored.";
        status = 422;
        break;
      case "storage_cap_exceeded":
        msg = "Storage cap exceeded — restoring would push the fleet over its budget.";
        status = 507;
        break;
      default:
        // slug_taken / slug_retired / invalid_slug — restore never touches the
        // slug, so these shouldn't occur; map defensively rather than leak codes.
        msg = "Could not restore that version.";
        status = 400;
    }
    return finishManage(publicId, env, authz, { kind: "err", message: msg }, status);
  }
  return finishManage(
    publicId,
    env,
    authz,
    { kind: "ok", message: `Restored v${versionNo} as new version v${result.version}.` },
  );
}

/**
 * POST /d/:public_id/promote — operator promotes a version to the one the
 * public page serves (`documents.published_ver`, migration 0018 / issue #43),
 * via the Publish button in the manage page's history table. Same auth ladder as
 * the other manage forms.
 *
 * Writes NO new version: promoting is a pointer move, so it bumps nothing,
 * re-renders nothing, and re-indexes nothing (`promoteVersionCore` stamps
 * `updated_at` and stops). That's the whole shape of the feature — publishing is
 * an operator decision about EXISTING bytes, never an authoring act.
 *
 * Allowed on a private document too: staging the pointer before the door opens
 * is the safe order of operations, and `setDocumentVisibilityCore` preserves the
 * explicit choice when the document is later made public.
 */
export async function handlePromoteForm(
  publicId: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const form = await req.formData();
  const authz = await authorizeOperatorForm(req, env, form);
  if (!authz.ok) return manageResultCard(publicId, authz.status, { kind: "err", message: authz.message });

  // Same shape check handleRestoreForm uses — version numbers start at 1 and the
  // core takes a number, so reject anything else before the DB read.
  const verStr = String(form.get("version") ?? "");
  if (!/^[1-9][0-9]*$/.test(verStr)) {
    return finishManage(publicId, env, authz, { kind: "err", message: "Invalid version number." }, 400);
  }
  const versionNo = Number(verStr);

  const result = await promoteVersionCore(env, publicId, versionNo, waitUntil);
  if (!result.ok) {
    const msg =
      result.code === "version_not_found"
        ? `Version v${versionNo} does not exist.`
        : "Document not found.";
    return finishManage(publicId, env, authz, { kind: "err", message: msg }, 404);
  }
  // One message for both visibility states: the sentence is true either way, and
  // re-reading the row just to pick a tense would cost a query for wording.
  return finishManage(publicId, env, authz, {
    kind: "ok",
    message:
      `Published v${result.published_ver} — that is the version the public page serves. ` +
      `(A private document serves it the moment you make it public.)`,
  });
}

/** Human-readable success line for a slug change, by which transition occurred. */
function slugSuccessMessage(r: SetSlugOk): string {
  if (r.slug === null) {
    return r.retired
      ? `Link removed. The old link /s/${r.retired} is retired and will not forward.`
      : "No custom link is set.";
  }
  if (r.redirected && r.retired) {
    return `Link changed to /s/${r.slug}. The old link /s/${r.retired} now forwards here.`;
  }
  return `Link set to /s/${r.slug}.`;
}

/**
 * After a POST: re-render the manage page with a notice (cookie path, where we
 * have a CSRF nonce to put back into the forms), or fall back to a terminal
 * result card (pasted-token path — no session nonce to embed). A doc revoked
 * out from under a cookie-path re-render falls back to the result card too.
 */
async function finishManage(
  publicId: string,
  env: Env,
  authz: { ok: true; via: "bearer" } | { ok: true; via: "cookie"; csrf: string },
  notice: ManageNotice,
  status = 200,
): Promise<Response> {
  if (authz.via === "cookie") {
    const state = await loadManageState(env, publicId);
    if (!state) return manageResultCard(publicId, 404, { kind: "err", message: "Document not found." });
    return manageResponse(renderManagePage(state, authz.csrf, notice), status);
  }
  return manageResultCard(publicId, status, notice);
}

/** Shared doctype/head/styles for the manage page and its sign-in/result cards. */
function manageHtmlDoc(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} | ${SITE_BRAND}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#222;background:#fafafa}
.card{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px}
h1{font-size:18px;margin:0 0 4px;font-weight:600}
.sub{font-size:13px;color:#777;margin:0 0 8px;word-break:break-word}
h2{font-size:14px;margin:0 0 8px;font-weight:600}
p{margin:0 0 14px;color:#555}
section{padding:20px 0;border-top:1px solid #eee}
section:first-of-type{border-top:0}
section.danger h2{color:#a00}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#222;word-break:break-all}
.mono{text-decoration:none}
a.mono:hover{text-decoration:underline}
label{display:block;margin:0 0 6px;font-size:13px;color:#555}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:9px 10px;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid #ccc;border-radius:4px}
.hint{font-size:12px;color:#888;margin:8px 0 14px}
.hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
button{padding:9px 16px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;cursor:pointer}
button.danger-btn{background:#a00;border-color:#a00}
a.btn{display:inline-block;padding:9px 16px;font:13px/1.4 system-ui,sans-serif;border-radius:4px;border:1px solid #222;background:#222;color:#fff;text-decoration:none}
.notice{padding:9px 12px;border-radius:4px;font-size:13px;margin:0 0 16px}
.notice.ok{background:#eef7ee;border:1px solid #cfe6cf;color:#256029}
.notice.err{background:#fdecec;border:1px solid #f3c2c2;color:#a02020}
/* Amber, deliberately distinct from .err: the stale-stage warning describes a
   surprising-but-legal outcome the operator is about to cause, not a failure
   that already happened. Red here would train the eye to ignore red. */
.notice.warn{background:#fdf6e3;border:1px solid #ecd9a0;color:#7a5c12}
.note{font-size:12px;color:#888;margin-top:18px}
.note a{color:#555}
.vers-wrap{max-height:340px;overflow:auto;border:1px solid #eee;border-radius:4px}
table.vers{width:100%;border-collapse:collapse;font-size:13px}
table.vers th,table.vers td{text-align:left;padding:6px 9px;border-bottom:1px solid #eee;vertical-align:middle;white-space:nowrap}
table.vers tr:last-child td{border-bottom:0}
table.vers th{position:sticky;top:0;background:#fafafa;color:#888;font-weight:600;font-size:12px}
table.vers td:nth-child(3){white-space:normal;max-width:180px;overflow:hidden;text-overflow:ellipsis}
table.vers .cur{color:#256029;font-weight:600;font-size:12px}
table.vers .pub{color:#1d4f8a;font-weight:600;font-size:12px}
table.vers .nosrc{color:#999;font-size:12px}
table.vers .client{color:#999;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
table.vers td:nth-child(6){white-space:normal;max-width:170px;overflow:hidden;text-overflow:ellipsis}
table.vers form{display:inline;margin:0 6px 0 0}
table.vers form:last-child{margin-right:0}
button.link-restore,button.link-publish{padding:4px 11px;font-size:12px}
button.link-publish{background:#1d4f8a;border-color:#1d4f8a}
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

/**
 * The Version history section of the manage page: a newest-first table with a
 * View link (→ the operator version shell) per version, a State column marking
 * which version is current and which is published, a Client column naming the
 * OAuth client that authorized the write when one did (migration 0019 / issue
 * #63 — the only surface where an operator can see two connectors sharing an
 * agent pull apart), and the two actions that act on a row — Publish (promote it
 * to the version the public page serves) and Restore (re-publish its content as
 * a NEW version).
 *
 * The two actions are easy to confuse and do opposite things, which is why they
 * sit in one cell with the state beside them: Publish moves a POINTER and writes
 * nothing; Restore WRITES a new version and leaves the pointer alone. Publishing
 * is the operator's release control (issue #43) — an agent can overwrite this
 * document freely, but only this button changes what the open web renders.
 *
 * Both POST with the session CSRF nonce (`csrf` is already escaped by the
 * caller). publicId is PUBLIC_ID_RE-checked and version_no is an integer, so
 * both interpolate safely.
 */
function renderVersionHistory(state: ManageState, csrf: string): string {
  const rows = state.versions
    .map((ver) => {
      const when = escapeHtml(formatCreatedAt(ver.created_at));
      const tRaw = ver.title ? normalizeTitleForDisplay(ver.title) : "";
      const t = escapeHtml(tRaw.length > 0 ? tRaw : "(untitled)");
      const sizeKb = `${(ver.size_bytes / 1024).toFixed(1)} KB`;
      const viewHref = `/d/${state.publicId}/v/${ver.version_no}`;

      // Two independent axes — a version is commonly both (the steady state), and
      // the whole point of the feature is that it can be neither or either one.
      const badges =
        (ver.is_current ? `<span class="cur">current</span>` : "") +
        (ver.is_current && ver.is_published ? " " : "") +
        (ver.is_published ? `<span class="pub">published</span>` : "");

      // Publish: offered on every version that isn't already the published one.
      // No source needed — promoting reads nothing, it repoints published_ver at
      // bytes that are already sitting in R2.
      const publishBtn = ver.is_published
        ? ""
        : `<form method="POST" action="/d/${state.publicId}/promote"><input type="hidden" name="csrf_token" value="${csrf}"><input type="hidden" name="version" value="${ver.version_no}"><button type="submit" class="link-publish">Publish</button></form>`;
      // Restore needs the retained source. Pre-0008 versions (no `.src`) can't be
      // restored — restoreVersionCore hard-fails source_unavailable, so don't offer
      // the button; show a muted note instead (those docs are revoke-and-republished).
      const restoreBtn = ver.is_current
        ? ""
        : ver.source_present
          ? `<form method="POST" action="/d/${state.publicId}/restore"><input type="hidden" name="csrf_token" value="${csrf}"><input type="hidden" name="version" value="${ver.version_no}"><button type="submit" class="link-restore">Restore</button></form>`
          : `<span class="nosrc" title="Predates source retention — can't be restored; revoke &amp; republish instead.">no source</span>`;

      // Which OAuth client authorized this write (migration 0019 / issue #63).
      // Muted and shown only when non-null: null is the ordinary case for an
      // operator write, a static `awh_` bearer write, and every pre-0019
      // version, so an empty cell is information, not a gap. Escaped because the
      // value is stored verbatim from the authorization request and may name a
      // client that no longer exists — it is never interpolated raw.
      const clientCell = ver.author_client_id
        ? `<span class="client" title="OAuth client that authorized this write">${escapeHtml(ver.author_client_id)}</span>`
        : "";

      return `<tr><td><a class="mono" href="${viewHref}">v${ver.version_no}</a></td><td>${when}</td><td>${t}</td><td>${sizeKb}</td><td>${badges}</td><td>${clientCell}</td><td>${publishBtn}${restoreBtn}</td></tr>`;
    })
    .join("");
  const count = state.versions.length;
  const plural = count === 1 ? "" : "s";

  // One line answering "what do readers actually get?" — the question the two
  // pointers exist to separate. Silent in the steady state (published ===
  // current), which is most documents most of the time.
  const isPublic = state.visibility === "public";
  let pubLine = "";
  if (state.publishedVer === null) {
    pubLine = isPublic
      ? `<p class="notice err">No version is published — the public page has nothing to serve. Publish one below.</p>`
      : `<p class="hint">No version is published yet. Publishing one decides what the open web sees the moment this document is made public.</p>`;
  } else if (state.publishedVer !== state.currentVer) {
    pubLine = isPublic
      ? `<p class="notice err">Readers see <b>v${state.publishedVer}</b>. <b>v${state.currentVer}</b> is newer and is <b>not</b> visible to them.</p>`
      : `<p class="hint"><b>v${state.publishedVer}</b> is the published version — that's what goes live when this document is made public, not the newer <b>v${state.currentVer}</b>.</p>`;
  }

  return `<section>
<h2>Version history</h2>
<p>${count} version${plural}. <b>View</b> opens that version (operator-only). <b>Publish</b> makes it the version the public page serves — a pointer move, no new version is written. <b>Restore</b> re-publishes that version's content and title/description as a NEW version — the current custom link and tags are kept. <b>Client</b> names the OAuth client whose grant authorized the write, when one did — blank for your own writes, for a static <code>awh_</code> key, and for versions written before this was recorded. Older bytes stay in R2 until the document is revoked.</p>
${pubLine}
<div class="vers-wrap"><table class="vers"><thead><tr><th>Version</th><th>When</th><th>Title</th><th>Size</th><th>State</th><th>Client</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

/**
 * The link-graph panel (migration 0016 / issue #40): who references this doc,
 * and where this doc's own links point — with the broken ones called out.
 * Read-only curation view; the fix for a broken link is editing the SOURCE
 * document, so there's no form here.
 */
function renderLinkGraph(state: ManageState): string {
  const backItems = state.backlinks
    .map((b) => {
      const tRaw = b.title ? normalizeTitleForDisplay(b.title) : "";
      const t = escapeHtml(tRaw.length > 0 ? tRaw : "(untitled)");
      const slugNote = b.slug ? ` <span class="mono">/s/${escapeHtml(b.slug)}</span>` : "";
      return `<li><a href="/d/${escapeHtml(b.public_id)}">${t}</a>${slugNote}</li>`;
    })
    .join("");
  const backHtml =
    state.backlinks.length > 0
      ? `<ul>${backItems}</ul>`
      : `<p class="hint">Nothing links here yet. (If this corpus predates the link graph, run the links backfill from the admin API first.)</p>`;

  const outItems = state.outbound
    .map((l) => {
      const addr = l.kind === "slug" ? `/s/${l.value}` : `/d/${l.value}`;
      const safeAddr = escapeHtml(addr);
      let stateHtml: string;
      switch (l.state) {
        case "live": {
          const tRaw = l.title ? normalizeTitleForDisplay(l.title) : "";
          const t = escapeHtml(tRaw.length > 0 ? tRaw : "(untitled)");
          stateHtml = `→ <a href="${safeAddr}">${t}</a>`;
          break;
        }
        case "redirected":
          stateHtml = `<b>redirected</b> — forwards to <a class="mono" href="/d/${escapeHtml(l.target_public_id ?? "")}">/d/${escapeHtml(l.target_public_id ?? "")}</a> (update the link in this document)`;
          break;
        case "retired":
          stateHtml = `<b>retired</b> — the slug is permanently spent (410); the link is dead`;
          break;
        case "revoked":
          stateHtml = `<b>revoked</b> — the target document was destroyed; the link is dead`;
          break;
        default:
          stateHtml = `<b>missing</b> — nothing answers at this address (unclaimed slug or unknown id)`;
      }
      return `<li><span class="mono">${safeAddr}</span> ${stateHtml}</li>`;
    })
    .join("");
  const outHtml =
    state.outbound.length > 0
      ? `<ul>${outItems}</ul>`
      : `<p class="hint">This document has no on-platform links.</p>`;

  return `<section>
<h2>Link graph</h2>
<p><b>Referenced by</b> — live documents whose current version links here:</p>
${backHtml}
<p><b>Outbound</b> — this document's on-platform links and what they resolve to now:</p>
${outHtml}
</section>`;
}

/** The full management page: visibility toggle, slug editor, status, tags, link
 *  graph, version history (publish + restore), revoke. */
function renderManagePage(state: ManageState, csrfToken: string, notice?: ManageNotice): string {
  const safeId = escapeHtml(state.publicId);
  const titleRaw = state.title ? normalizeTitleForDisplay(state.title) : "";
  const subtitle = escapeHtml(titleRaw.length > 0 ? titleRaw : "(untitled)");
  const csrf = escapeHtml(csrfToken);
  const isPrivate = state.visibility === "private";

  const noticeHtml = notice
    ? `<p class="notice ${notice.kind === "err" ? "err" : "ok"}">${escapeHtml(notice.message)}</p>`
    : "";

  // Visibility: current state + a single button that flips to the other value.
  // The blurb names the PUBLISHED version on the public branch (issue #43): what
  // "public" exposes is the promoted version, not whatever an agent wrote last,
  // and an operator reading this page shouldn't have to infer that.
  const visTarget = isPrivate ? "public" : "private";
  const visButton = isPrivate ? "Make public" : "Make private";
  const visState = isPrivate
    ? "<b>Private</b> — hidden from the open web. You and your agents can open it; the public URL returns 404 to anyone else."
    : state.publishedVer !== null
      ? `<b>Public</b> — anyone with the link reads <b>v${state.publishedVer}</b>, the published version. Agents can write new versions; none of them reach readers until you publish one.`
      : "<b>Public</b> — but nothing is published, so the page has no version to serve. Publish one from the version history below.";

  // STALE-STAGE WARNING (issue #43). Going public runs
  // `published_ver = coalesce(published_ver, current_ver)`, so a version staged
  // earlier SURVIVES the flip and becomes what the world sees. That is the
  // deliberate behaviour — it is what lets an operator pick the outward-facing
  // revision BEFORE opening the door, with no window where unreviewed current
  // bytes are briefly public. The cost is that a stage made long ago and
  // forgotten silently wins over dozens of newer versions.
  //
  // So the flip discloses its own outcome, but only when the outcome is
  // surprising: a document with no stage (the overwhelmingly common case) and
  // one staged exactly at `current_ver` both publish what the operator is
  // looking at, and a warning there would be noise that teaches them to click
  // through this one.
  const staleStage =
    isPrivate && state.publishedVer !== null && state.publishedVer !== state.currentVer
      ? state.publishedVer
      : null;
  const stagedRow =
    staleStage === null ? undefined : state.versions.find((v) => v.version_no === staleStage);
  const stagedWhen = stagedRow ? ` written ${escapeHtml(formatCreatedAt(stagedRow.created_at))},` : "";
  const visWarn =
    staleStage === null
      ? ""
      : `\n<p class="notice warn">Making this public will publish <b>v${staleStage}</b> —${stagedWhen} not the current <b>v${state.currentVer}</b>. A version was staged earlier and going public keeps that choice. Publish v${state.currentVer} from the version history below first if that is what you meant.</p>`;

  // Slug: current link + a text field (prefilled). The HTML pattern mirrors the
  // server SLUG_RE; an empty field clears (pattern is not checked when empty).
  const slugVal = state.slug ? escapeHtml(state.slug) : "";
  const slugCurrent = state.slug
    ? `Current link: <a class="mono" href="/s/${state.slug}">/s/${escapeHtml(state.slug)}</a>`
    : `No custom link — this document is reachable only by its <span class="mono">/d/${safeId}</span> capability URL.`;

  // Status: current lifecycle state + a flip form (migration 0014). Deprecating
  // exposes the optional superseded_by field; re-activating clears the pointer.
  const isDeprecated = state.status === "deprecated";
  const statusState = isDeprecated
    ? state.supersededBy
      ? `<b>Deprecated</b> — superseded by <a class="mono" href="/d/${escapeHtml(state.supersededBy)}">/d/${escapeHtml(state.supersededBy)}</a>. Still readable and searchable (marked), but context packs skip it.`
      : "<b>Deprecated</b> — still readable and searchable (marked), but context packs skip it."
    : "<b>Active</b> — current. Included in search, lists, and context packs normally.";
  const statusForm = isDeprecated
    ? `<form method="POST" action="/d/${state.publicId}/status">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="status" value="active">
<button type="submit">Mark active</button>
</form>`
    : `<form method="POST" action="/d/${state.publicId}/status">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="status" value="deprecated">
<label for="superseded_by">Superseded by (optional public_id)</label>
<input id="superseded_by" name="superseded_by" type="text" value="" autocomplete="off" spellcheck="false" placeholder="e.g. 0EtsEq6cnCeuOhBKO6ICzA" pattern="[A-Za-z0-9_-]{22}" title="A live document's 22-char public_id. Leave empty if there's no replacement.">
<p class="hint">Names the replacement document. Readers are told loudly — nothing auto-follows the pointer.</p>
<button type="submit">Mark deprecated</button>
</form>`;

  // Tags: a comma-separated field prefilled with the document's current tags.
  // Tags are document-level classification (like slug) — they survive content
  // updates and never bump a version. The field is plain text (no pattern); the
  // server sanitizes the charset and caps the count/length, dropping anything
  // invalid rather than rejecting, so an over-strict pattern would only confuse.
  const tagsVal = escapeHtml(state.tags.join(", "));

  const body = `<h1>Manage <span class="mono">${safeId}</span></h1>
<p class="sub">${subtitle}</p>
${noticeHtml}
<section>
<h2>Visibility</h2>
<p>${visState}</p>${visWarn}
<form method="POST" action="/d/${state.publicId}/visibility">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="visibility" value="${visTarget}">
<button type="submit">${visButton}</button>
</form>
</section>
<section>
<h2>Custom link</h2>
<p>${slugCurrent}</p>
<form method="POST" action="/d/${state.publicId}/slug">
<input type="hidden" name="csrf_token" value="${csrf}">
<label for="slug">Slug</label>
<input id="slug" name="slug" type="text" value="${slugVal}" autocomplete="off" spellcheck="false" placeholder="e.g. north-island-report" pattern="[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?" title="Lowercase letters, digits, - and _; 1–64 chars; must start and end alphanumeric. Leave empty to clear.">
<p class="hint">Lowercase letters, digits, <code>-</code>, <code>_</code>; 1–64 chars. Renaming <b>retires</b> the old link and auto-forwards it here. Clear the field to remove the link (the old name is retired but won't forward). Links are never reused.</p>
<button type="submit">Save link</button>
</form>
</section>
<section>
<h2>Status</h2>
<p>${statusState}</p>
${statusForm}
</section>
<section>
<h2>Tags</h2>
<p>Document-level classification — tags survive content updates and never bump a version. They drive the <span class="mono">?tags=</span> filter on the list/search surfaces.</p>
<form method="POST" action="/d/${state.publicId}/tags">
<input type="hidden" name="csrf_token" value="${csrf}">
<label for="tags">Tags</label>
<input id="tags" name="tags" type="text" value="${tagsVal}" autocomplete="off" spellcheck="false" placeholder="e.g. research, north-island, draft">
<p class="hint">Comma-separated. Letters, digits, <code>-</code> and <code>_</code>; up to 10 tags, 32 chars each. Invalid characters are dropped. Leave empty to clear.</p>
<button type="submit">Save tags</button>
</form>
</section>
${renderLinkGraph(state)}
${renderVersionHistory(state, csrf)}
<section class="danger">
<h2>Revoke</h2>
<p>Permanently destroy this document. Bytes are purged from R2, the URL will <b>404 forever</b>, and any slug is retired. This cannot be undone.</p>
<form method="POST" action="/d/${state.publicId}/revoke">
<input type="hidden" name="csrf_token" value="${csrf}">
<button type="submit" class="danger-btn">Revoke document</button>
</form>
</section>
<p class="note"><a href="/d/${state.publicId}">← Back to document</a></p>`;

  return manageHtmlDoc("Manage document", body);
}

/** Sign-in prompt for a non-cookie caller of the manage page. Discloses no
 *  document state (rendered without a DB hit). */
function renderManageSignin(publicId: string): string {
  const loginHref = escapeHtml(`/login?next=${encodeURIComponent(`/d/${publicId}/manage`)}`);
  const body = `<h1>Sign in to manage</h1>
<p>Managing a document (visibility, custom link, revoke) needs an operator browser session.</p>
<p><a class="btn" href="${loginHref}">Sign in</a></p>
<p class="note"><a href="/d/${escapeHtml(publicId)}">← Back to document</a></p>`;
  return manageHtmlDoc("Manage document", body);
}

/**
 * Terminal result card for the manage POST handlers' non-re-render paths: an
 * auth failure, or a pasted-token (no-session) success/error where there's no
 * CSRF nonce to seed a fresh form. Links back to the manage page to retry.
 * `publicId` is PUBLIC_ID_RE-validated by every caller, so it's safe to
 * interpolate into the link.
 */
function manageResultCard(publicId: string, status: number, notice: ManageNotice): Response {
  const body = `<h1>Manage document</h1>
<p class="notice ${notice.kind === "err" ? "err" : "ok"}">${escapeHtml(notice.message)}</p>
<p class="note"><a href="/d/${publicId}/manage">← Back to manage <span class="mono">${escapeHtml(publicId)}</span></a></p>`;
  return manageResponse(manageHtmlDoc("Manage document", body), status);
}
