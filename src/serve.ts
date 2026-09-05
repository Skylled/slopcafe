// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Document DELIVERY for `/d/:public_id` and `/s/:slug` — the bytes, text,
 * source and link surfaces (issue #72 phase 4 split; the shell pages live in
 * src/serve-shell.ts, the retired-slug responses in src/serve-retired-slug.ts,
 * and the security constants + opaque refusals in src/serve-policy.ts).
 *
 * Split across two URLs because the action plan's strict CSP includes
 * `frame-ancestors`, which is header-only — there's no `<meta>` equivalent.
 * So the iframe content must come from an HTTP response, not from `srcdoc`.
 *
 *   GET /d/:public_id           → content-negotiated: shell (serve-shell.ts) or, with a credential, the bytes
 *   GET /d/:public_id/raw       → sanitized bytes streamed from R2, locked-down CSP (RAW_CSP)
 *   GET /d/:public_id/v/:n/raw  → operator-only bytes of a historical version
 *   GET /d/:public_id/text      → credentialed Markdown / JSON envelope (Accept-negotiated)
 *   GET /d/:public_id/source    → credentialed retained source S (unsanitized, with advisories)
 *   GET /d/:public_id/links     → credentialed link neighborhood
 *   GET /s/:slug, /s/:slug/text → the slug twins (+ `serveRetiredSlug` on a live-lookup miss)
 *   (The operator plane — GET/POST /d/:public_id/revoke, GET /d/:public_id/manage
 *   and its form POSTs — lives in manage.ts, which imports FROM serve-policy.ts;
 *   the edge is one-way.)
 *
 * Shell + raw 404 if the document is missing or `revoked_at` is set. All
 * routes send `Cache-Control: no-store` so a revoke really is the kill
 * switch the action plan promises.
 *
 * PUBLISHED-VERSION PINNING (issue #43, migration 0018) — the load-bearing rule
 * of this file. A public document does NOT render whatever an agent wrote last;
 * it renders the version an operator PROMOTED. Any active agent key can
 * overwrite any live document (single-tenant trust), so without this the
 * open-web surface of every public document is agent-writable: overwrite a
 * public doc with a private one's contents and it is exfiltrated to anonymous
 * readers. Decoupling "which bytes are published" from "which bytes are
 * current" closes that:
 *
 *   served version = (visibility === 'public' && published_ver !== null)
 *                      ? published_ver : current_ver
 *
 * `SERVED_VER_SQL` / `servedVersion` (src/served-version.ts) are the ONE copy
 * of that rule, and every HTML byte-path query — `/raw` here, the shell, the
 * homepage and the slug shell in serve-shell.ts / `serveBySlug` below —
 * resolves through it. Two families deliberately stay on `current_ver`: the
 * credentialed machine surfaces (`/text`, `/source`, `/links`, and everything
 * behind MCP / search / packs), which are the writing fleet's own view of its
 * own corpus and must show an agent what it last wrote; and the operator's
 * explicit version reads (`/d/:id/v/:n`), which name a version outright, so
 * there is nothing to resolve. Adding a new HTML render site means joining
 * through SERVED_VER_SQL — a site left on `current_ver` is a hole in the wall,
 * not a cosmetic inconsistency.
 */

import {
  canRead,
  type Principal,
  resolvePrincipal,
  type Visibility,
} from "./access.js";
import { etagForVersion, ifNoneMatchSatisfied } from "./conditional.js";
import { findDocumentBySlugCore, resolvePublicIdBySlug } from "./document-query.js";
import { readDocumentSourceCore, readDocumentTextCore } from "./document-read.js";
import { findSlugTombstoneCore, resolveRedirectTarget } from "./document-slug.js";
import type { Env } from "./env.js";
import { PUBLIC_ID_RE } from "./ids.js";
import { documentLinksCore } from "./links-core.js";
import { validateSlugInput } from "./metadata.js";
import {
  COMMON_HEADERS,
  idShapeHint,
  notFound,
  notFoundBrowser,
  notFoundJson,
  RAW_CSP,
  requireReader,
} from "./serve-policy.js";
import {
  goneHtml,
  goneJson,
  redirectInterstitial,
  redirectTargetReadableBy,
  slugRedirectedJson,
} from "./serve-retired-slug.js";
import {
  publishNoticeFor,
  READER_THEME_PREFIX,
  renderShell,
  serveShell,
  streamWithPrefix,
} from "./serve-shell.js";
import { SERVED_VER_SQL, servedVersion } from "./served-version.js";
import { authenticateOperatorRequest } from "./session.js";

/**
 * Resolve a retired slug to a Response for the shell surface (`GET /s/:slug`).
 * Called only after the live lookup misses. Three outcomes:
 *   - tombstone with a LIVE, READABLE redirect target → forward loudly: a
 *     browser gets the click-through interstitial; a credentialed caller
 *     (Authorization header) gets `409 slug_redirected`, or is served the
 *     target's bytes when it passed `?follow_redirects=true`;
 *   - plain tombstone (no redirect, or a dangling/revoked/unreadable target)
 *     → 410 Gone;
 *   - no tombstone → opaque 404.
 */
async function serveRetiredSlug(
  slug: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const tomb = await findSlugTombstoneCore(env, slug);
  // Never-claimed slug. Browser → the login-link 404 (so a private slugged doc's
  // 404 and a never-claimed slug's 404 stay byte-identical — no oracle); a
  // credentialed caller (Authorization header) → the plain body.
  if (!tomb) return req.headers.has("authorization") ? notFound() : notFoundBrowser(req);

  // "Authorization header present" == machine/credentialed caller (agent key or
  // operator token) → JSON/bytes; absent == browser → HTML interstitial/card.
  const hasAuthHeader = req.headers.has("authorization");

  if (tomb.redirect_to) {
    // Credential check FIRST, like the live-bytes branch: a present-but-invalid
    // key must stay loud (401) rather than degrading into the 410 below, which
    // is now also what an unreadable target produces.
    if (hasAuthHeader) {
      const denied = await requireReader(req, env, "invalid credentials — provide a valid agent key or operator token");
      if (denied) return denied;
    }
    const target = await resolveRedirectTarget(env, tomb.redirect_to);
    // Disclosure gate: a target this caller can't read is treated exactly like a
    // dangling one — we never name it, in HTML or in JSON.
    if (target && (await redirectTargetReadableBy(env, req, target))) {
      if (hasAuthHeader) {
        const follow =
          new URL(req.url).searchParams.get("follow_redirects") === "true";
        return follow ? serveRaw(target.public_id, req, env) : slugRedirectedJson(slug, target);
      }
      return redirectInterstitial(target);
    }
    // Dangling (revoked/unknown) or unreadable target → fall through to a 410.
  }

  return hasAuthHeader ? goneJson() : goneHtml();
}

/**
 * GET /d/:public_id — the URL agents share with humans. Content-negotiates
 * via `Authorization`:
 *
 *   - No header        → shell page (the browser case).
 *   - Valid credential → raw sanitized HTML, same bytes as `/raw`. Any
 *                        non-anonymous principal: an agent key OR the operator
 *                        token (operator ≥ agent — see `requireReader`).
 *   - Bad credential   → 401 (don't silently downgrade to shell — surface broken
 *                        keys/tokens).
 *
 * `/raw` is already publicly fetchable (the iframe needs it), so this auth
 * check isn't access control — it's the "one URL for agents and humans"
 * UX promise from the action plan.
 */
export async function serveDocument(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.has("authorization")) {
    // A credential was presented — accept any non-anonymous principal (agent key
    // or operator token) and serve the bytes (serveRaw re-gates on visibility).
    // A present-but-invalid credential 401s rather than downgrading to the shell.
    const denied = await requireReader(req, env, "invalid credentials — provide a valid agent key or operator token");
    if (denied) return denied;
    return serveRaw(publicId, req, env);
  }
  const origin = new URL(req.url).origin;
  return serveShell(publicId, req, env, origin);
}

/* ------------------------------------------------------------------------- *
 * Served-version resolution (issue #43, migration 0018) — see the file header
 * for WHY the render path is pinned. The rule itself lives in the leaf module
 * `served-version.ts` (`SERVED_VER_SQL` + `servedVersion`, imported above)
 * because the document cores need it too and cannot import this file.
 * ------------------------------------------------------------------------- */

/**
 * GET /d/:public_id/raw — what the iframe loads. Streams sanitized bytes
 * from R2 under the locked-down CSP. `frame-ancestors 'self'` ensures
 * only our own shell can embed it; direct navigation works (browsers
 * tolerate the bare HTML fragment), but third-party iframes are refused.
 *
 * VERSION PIN (issue #43) — this is the single chokepoint for the rendered
 * BYTES, so it is also where the published-version rule is enforced: a public
 * document serves `published_ver`, to EVERY caller, operator and agent
 * included. That uniformity is the point. A rule that served current bytes to
 * whoever held a credential would leave the operator reviewing a page no
 * visitor can see, and would put the decision of "what is published" back in
 * the hands of any key that can write. An agent that wants its own newest bytes
 * has `/text`, `/source` and the MCP reads, which all stay on `current_ver`.
 *
 * VISIBILITY GATE (migration 0011) — this is the single chokepoint for the
 * rendered bytes. Both the `/d/:id` shell AND the homepage embed
 * `/d/:id/raw` as an HTTP subresource, so gating HERE (not just at the shell)
 * is what actually withholds a private doc's bytes. We resolve the full
 * principal because this is reached uncredentialed by the iframe, by an agent
 * Bearer directly, and (via serveDocument/serveBySlug) after an agent already
 * authed — the redundant re-resolve in that last case is cheap and keeps one
 * gate. A private doc denies to anonymous with the SAME opaque 404 as
 * missing/revoked (no oracle).
 *
 * The operator-in-browser case works because the `awh_session` cookie reaches
 * this SAME-ORIGIN subresource request (SameSite=Lax only strips cross-SITE
 * requests). That property depends on `/d/:id/raw` staying same-origin — today
 * guaranteed by the shell's `frame-src 'self'` / RAW_CSP `frame-ancestors
 * 'self'`. If raw bytes ever move to a separate content domain, Lax would strip
 * the cookie and break the operator render — revisit the gate then.
 */
export async function serveRaw(publicId: string, req: Request, env: Env): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  // Single join to get document state + the R2 key for the SERVED version
  // (SERVED_VER_SQL — issue #43). This join is THE pin: it is the only place the
  // rendered bytes of a public document are chosen, so a public doc physically
  // cannot serve an unpromoted version, whoever asks. `r2_key` is read back from
  // the joined row rather than derived from (doc, version) — the key carries a
  // per-write nonce and is opaque by design. `source_format` decides whether to
  // inject the reading theme (Markdown) or serve the stored bytes verbatim
  // (HTML — author owns presentation), and is read from the SAME row, so a
  // document that changed format between versions renders under the format its
  // served version was written in. `visibility` drives the access gate below;
  // `current_ver` feeds the writer preflight header.
  const row = await env.META.prepare(
    `select d.revoked_at, d.visibility, d.current_ver, v.r2_key, v.version_no, v.source_format
     from documents d
     join versions v on v.document_id = d.id and v.version_no = ${SERVED_VER_SQL}
     where d.public_id = ?`,
  )
    .bind(publicId)
    .first<{
      revoked_at: string | null;
      visibility: Visibility;
      current_ver: number | null;
      r2_key: string;
      version_no: number;
      source_format: string;
    }>();
  // The `revoked_at` half of this guard is now SOLELY load-bearing, where it used
  // to be doubly covered. `revokeDocumentCore` nulls `current_ver` but leaves
  // `published_ver` standing, so on a revoked public document SERVED_VER_SQL still
  // resolves to that stale pointer and this INNER join MATCHES — whereas joining
  // on the nulled `current_ver` used to miss and 404 via `!row` on its own. The
  // kill switch is unaffected (the check runs before anything reads the row), but
  // do not reorder or weaken it on the theory that a dead document can't join.
  if (!row || row.revoked_at) return notFound();

  // Access gate: operator/agent read everything; anonymous reads only public.
  const principal = await resolvePrincipal(req, env);
  if (!canRead(principal, { visibility: row.visibility, revoked: false })) return notFound();

  // Writer preflight (issue #43): the document's NEWEST version, which on a
  // public doc can be ahead of the bytes we just served. A writer running
  // `--if-match auto` reads a document and needs the version to send back on the
  // next PUT — and the ETag now names the SERVED version, so the two genuinely
  // differ and the ETag alone would make it write against a stale expectation.
  //
  // Emitted ONLY to a credentialed principal. That an unpublished newer version
  // exists is exactly what the pinning withholds from readers, so for an
  // anonymous caller the header is ABSENT rather than clamped to the served
  // number: an absent header discloses nothing, a wrong number would be a lie
  // to any tool that later gains a credential. (`current_ver` is non-null on a
  // live document — revoke nulls it and 404s above — but the column is nullable,
  // so fall back to the served version rather than emit "null".)
  const writerHeaders: Record<string, string> =
    principal.kind === "anonymous"
      ? {}
      : { "x-doc-current-version": String(row.current_ver ?? row.version_no) };

  // Conditional GET: if the client already holds this version, answer a bodyless
  // 304 and skip the R2 GET + body transfer. MUST stay AFTER the revoke +
  // visibility gate above — a 304 confirms existence + version, so emitting one
  // earlier would turn a private/revoked doc's opaque 404 into an oracle.
  //
  // The tag validates the SERVED version, which is what makes it still correct
  // under publishing: promoting a different version changes these bytes without
  // writing a new one, and the tag moves with it; conversely a new UNpublished
  // version leaves the tag alone, because the bytes at this URL didn't change.
  // The preflight header rides the 304 too — a preflight is exactly the request
  // most likely to carry `If-None-Match`, and withholding it there would break
  // the caller it exists for (the 304 already discloses the served version via
  // the ETag, so this adds nothing beyond what the 200 does).
  if (ifNoneMatchSatisfied(req.headers.get("if-none-match"), row.version_no)) {
    return new Response(null, {
      status: 304,
      headers: { etag: etagForVersion(row.version_no), ...writerHeaders, ...COMMON_HEADERS },
    });
  }

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return notFound(); // shouldn't happen — D1 says it should exist

  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": RAW_CSP,
    etag: etagForVersion(row.version_no),
    ...writerHeaders,
    ...COMMON_HEADERS,
  };

  // Markdown docs get the reading theme + doctype spliced ahead of their bytes
  // (presentation only — never stored, never seen by the sanitizer or the
  // /text derivation; see READER_THEME_CSS). HTML docs pass through byte-for-
  // byte. Either way the document body streams straight from R2 — no buffering.
  const body =
    row.source_format === "markdown"
      ? streamWithPrefix(READER_THEME_PREFIX, obj.body)
      : obj.body;

  return new Response(body, { status: 200, headers });
}

/* ------------------------------------------------------------------------- *
 * Operator-only version history view (`/d/:public_id/v/:n` + `/v/:n/raw`).
 *
 * History is an OPERATOR surface, distinct from the public visibility axis:
 * these routes are gated by the operator check (Bearer OR cookie session), NOT
 * by canRead — a public doc's history and a private doc's history are equally
 * operator-only, and an agent reads old versions through MCP, never here. A
 * non-operator gets the same opaque 404 as a missing route (no oracle).
 *
 * The split mirrors the live shell/raw split: `/v/:n` is the framed shell with a
 * "historical version" banner; `/v/:n/raw` is the bytes the iframe loads under
 * RAW_CSP. The operator's awh_session cookie reaches the same-origin /raw
 * subresource (SameSite=Lax only strips cross-SITE), so the framed render works
 * for a cookie operator exactly like the live one.
 * ------------------------------------------------------------------------- */

/**
 * GET /d/:public_id/v/:n/raw — operator-only sanitized bytes of a specific
 * historical version, streamed straight from that version's retained R2 key.
 */
export async function serveVersionRaw(
  publicId: string,
  versionNo: number,
  req: Request,
  env: Env,
): Promise<Response> {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();

  const auth = await authenticateOperatorRequest(req, env);
  if (!auth.ok) return notFound(); // opaque — no version oracle for non-operators

  const row = await env.META.prepare(
    `select v.r2_key, v.version_no, v.source_format
       from documents d
       join versions v on v.document_id = d.id and v.version_no = ?
      where d.public_id = ? and d.revoked_at is null`,
  )
    .bind(versionNo, publicId)
    .first<{ r2_key: string; version_no: number; source_format: string }>();
  if (!row) return notFound();

  // Conditional GET (see serveRaw). Operator-gated + row-resolved above, so a
  // non-operator or an absent version still 404s opaquely before this point.
  // Historical versions are immutable, so a cached client always 304s here.
  if (ifNoneMatchSatisfied(req.headers.get("if-none-match"), row.version_no)) {
    return new Response(null, {
      status: 304,
      headers: { etag: etagForVersion(row.version_no), ...COMMON_HEADERS },
    });
  }

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return notFound();

  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": RAW_CSP,
    etag: etagForVersion(row.version_no),
    ...COMMON_HEADERS,
  };
  // Same reader-theme injection as serveRaw, keyed on THIS version's format.
  const body =
    row.source_format === "markdown"
      ? streamWithPrefix(READER_THEME_PREFIX, obj.body)
      : obj.body;
  return new Response(body, { status: 200, headers });
}

/**
 * Does this caller want the JSON read envelope instead of the raw Markdown?
 *
 * True ONLY for an explicit `application/json` media type in `Accept`. A
 * wildcard Accept (curl's default, and what the Dart clients send so
 * Cloudflare doesn't strip the ETag) and an absent header BOTH keep the
 * historical `text/markdown` body, so the negotiation adds a shape without
 * moving a single existing caller onto it. Quality values are ignored: this is
 * a two-way switch, not a preference ranking, and a caller that names JSON at
 * all wants JSON.
 */
function wantsJsonEnvelope(req: Request): boolean {
  const accept = req.headers.get("accept");
  if (!accept) return false;
  return accept
    .split(",")
    .some((part) => part.split(";")[0]!.trim().toLowerCase() === "application/json");
}

/**
 * Build the Markdown-derivation response for an already-resolved public_id.
 * No auth, no id-shape check — callers (`serveText`, `serveTextBySlug`) own
 * those gates; this is the single place the conversion + headers (ETag,
 * sanitizer/converter version tags, no-store) are produced.
 *
 * Conversion runs on every request (no per-version cache in v1); the underlying
 * bytes come from R2 via `readDocumentTextCore`, so a revoked doc still 404s.
 *
 * DELIBERATELY UNPINNED (issue #43): this reads `current_ver`, not the published
 * version the HTML byte path serves. `/text` is a credentialed ingestion channel
 * — the writing fleet's view of its own corpus — and an agent that just wrote a
 * version must be able to read it back. The pin exists to stop an agent
 * REACHING THE ANONYMOUS INTERNET through a public document, not to hide the
 * fleet's own writes from the fleet. Don't "align" this with `serveRaw`.
 *
 * TWO representations of the same read, chosen by `Accept` (`wantsJsonEnvelope`):
 *
 *   - `text/markdown` (default) — the body alone. What every existing caller
 *     gets, unchanged.
 *   - `application/json` — the `ReadTextResponse` envelope from src/contract.ts:
 *     body PLUS title/description/tags/slug/status/superseded_by, which
 *     `readDocumentTextCore` already returns and this route used to discard.
 *
 * The envelope exists because the metadata-less body pushed a caller that
 * wanted "body + is it deprecated?" toward one of two bad answers: two round
 * trips (`GET /d?slug=` then `/text`), or the shortcut to `/source` — which
 * hands back UNSANITIZED bytes to ingest as context. Rewarding that instinct is
 * the real cost, so the safe channel now answers in one call, exactly as MCP
 * `read_document` always has.
 *
 * Content negotiation rather than a new `/text.json` route: `/d/:id` and
 * `/s/:slug` already negotiate (on `Authorization`), the response shape already
 * existed in contract.ts, and `Accept` is where a client expresses this. A new
 * route would have added a name, a spec entry, and a second thing to keep in
 * sync for zero added expressiveness. `Vary: Accept` rides both branches so a
 * cache can never serve one shape for the other's request.
 */
async function renderTextResponse(publicId: string, env: Env, asJson: boolean): Promise<Response> {
  const result = await readDocumentTextCore(env, publicId);
  // The read core's error union includes `version_not_found`, but this caller
  // never passes a versionNo (always the current version), so only `not_found`
  // can arise here — the catch-all is intentional. If a versioned text route is
  // ever added, distinguish version_not_found the way the MCP layer and the
  // operator restore/promote routes do — but ONLY behind `requireReader`. On an
  // anonymous-reachable surface that code separates a live document from a
  // missing one, which is precisely the existence oracle this file works to
  // avoid everywhere else.
  if (!result.ok) return notFoundJson();

  const headers: Record<string, string> = {
    "content-type": asJson ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
    etag: `"v${result.version_no}"`,
    "x-sanitizer-version": result.sanitizer_v,
    "x-converter-version": result.converter_v,
    vary: "Accept",
    ...COMMON_HEADERS,
  };
  if (!asJson) return new Response(result.text, { status: 200, headers });

  // ReadTextResponse = the core Result minus its internal `ok` tag. Spelled out
  // rather than spread-minus-ok so a field added to the core Result can't leak
  // onto the wire without a decision here (the same discipline src/wire.ts
  // applies to the write responses).
  return new Response(
    JSON.stringify({
      text: result.text,
      version_no: result.version_no,
      sanitizer_v: result.sanitizer_v,
      converter_v: result.converter_v,
      title: result.title,
      description: result.description,
      tags: result.tags,
      slug: result.slug,
      status: result.status,
      superseded_by: result.superseded_by,
    }),
    { status: 200, headers },
  );
}

/**
 * GET /d/:public_id/text — Markdown derivation of the sanitized HTML, for an
 * agent or tooling that wants to ingest the document as context rather than
 * render it.
 *
 * **Requires a credential — an agent key OR operator (token/session)** (401 to
 * anonymous). The two `/text` endpoints are credentialed ingestion channels, not
 * public surfaces — both this and `/s/:slug/text` are gated identically, and
 * both honor the operator ≥ agent hierarchy (see `requireReader`). (Note: the
 * rendered bytes themselves stay publicly reachable at `/d/:public_id/raw`,
 * which the sandboxed iframe loads uncredentialed, so this gate keeps a clean
 * public Markdown API from existing rather than enforcing confidentiality of the
 * content.) The auth check runs before the id-shape check, matching
 * `/s/:slug/text`.
 *
 * Response carries the sanitizer + converter version tags as headers so a
 * caller can detect policy changes without parsing the body.
 *
 * `Accept: application/json` switches the body to the one-call read envelope
 * (body + title/tags/status/…) — see `renderTextResponse`. Anything else, or no
 * `Accept` at all, is unchanged.
 */
export async function serveText(publicId: string, req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator credentials required");
  if (denied) return denied;

  // Purely syntactic, so the hint costs no DB read and reveals nothing: a
  // slug in the id slot is the likeliest reason to land here.
  if (!PUBLIC_ID_RE.test(publicId)) {
    return notFoundJson(idShapeHint(publicId, (slug) => `/s/${slug}/text`));
  }
  return renderTextResponse(publicId, env, wantsJsonEnvelope(req));
}

/**
 * GET /s/:slug/text — the slug-addressed twin of `/d/:public_id/text`. Resolves
 * the slug to its live document, then delegates to `renderTextResponse` so the
 * Markdown derivation + headers are produced by exactly one code path.
 *
 * **Requires a credential — an agent key OR operator (token/session)** (401 to
 * anonymous), identical to `/d/:public_id/text`. On the slug surface the only
 * public variant is the browser-friendly shell at `/s/:slug`; every
 * machine-readable form by slug (the raw bytes via content negotiation on
 * `/s/:slug`, and this Markdown form) is gated. The auth check runs FIRST, before
 * slug validation or any DB hit, so an unauthenticated caller can't use this as a
 * slug-existence oracle.
 *
 * Resolution and the R2 fetch are two separate reads; `readDocumentTextCore`
 * (inside `renderTextResponse`) re-checks existence/revoked, so a revoke landing
 * between them still 404s rather than serving stale bytes.
 *
 * For an authenticated caller it rounds out the slug surface: fetch the Markdown
 * form in one hop (the HTTP analogue of the MCP `read_document` slug +
 * `format:"markdown"` route) instead of recovering the `public_id` first.
 */
export async function serveTextBySlug(slug: string, req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator credentials required");
  if (denied) return denied;

  const asJson = wantsJsonEnvelope(req);
  const v = validateSlugInput(slug);
  if (!v.ok) return notFoundJson();
  const publicId = await resolvePublicIdBySlug(env, v.slug);
  if (!publicId) {
    // This endpoint is credential-gated (auth checked above), so responses are
    // always machine JSON. A retired slug with a live redirect target → 409
    // slug_redirected, or the target's Markdown when ?follow_redirects=true; a
    // plain/dangling tombstone → 410 Gone; never-claimed → opaque 404.
    const tomb = await findSlugTombstoneCore(env, v.slug);
    if (!tomb) return notFoundJson();
    if (tomb.redirect_to) {
      const target = await resolveRedirectTarget(env, tomb.redirect_to);
      // Same disclosure gate as serveRetiredSlug, deliberately not skipped here
      // even though `requireReader` above already guarantees a non-anonymous
      // principal (so it always passes): the gate belongs on every path that
      // names a target, or the next surface added here inherits the leak.
      if (target && (await redirectTargetReadableBy(env, req, target))) {
        const follow = new URL(req.url).searchParams.get("follow_redirects") === "true";
        return follow
          ? renderTextResponse(target.public_id, env, asJson)
          : slugRedirectedJson(v.slug, target);
      }
    }
    return goneJson();
  }
  return renderTextResponse(publicId, env, asJson);
}

/**
 * GET /d/:public_id/source — the RETAINED, UNSANITIZED source S of the current
 * version, in its authored language (Markdown for a Markdown doc, original HTML
 * for an HTML doc). The HTTP twin of MCP `read_document representation:"source"`.
 * The read an agent does *before* `edit_document`, whose match runs against S.
 *
 * CURRENT version, deliberately — not the published one (issue #43). `edit_document`
 * patches the source it was handed and writes it forward from that base, so a
 * source-read pinned to an older published version would silently revert every
 * unpublished revision on the next edit. Same reasoning as `/text`: the pin
 * governs what the anonymous internet renders, not what the fleet reads back.
 *
 * **Requires a credential — an agent key OR operator (token/session)** (401 to
 * anonymous) — this is the FIRST credentialed GET on the `/d/:id` namespace.
 * `/d/:id`, `/d/:id/raw`, and `/s/:slug` are PUBLIC capability URLs that serve
 * only the sanitized H; this one is NOT public, because S is the pre-sanitization
 * bytes (it may contain markup the renderer would have stripped — treat it as
 * untrusted input). The auth check runs before the id-shape check, matching
 * `/d/:public_id/text`.
 *
 * Gated to ANY authenticated principal (operator ≥ agent, via `requireReader`),
 * NOT to agents only. Two guardrails, in tension, both deliberate:
 *   - Do NOT make it operator-only. In the single-tenant whole-fleet trust model
 *     any active agent key already reads and overwrites every document (document-write.ts
 *     does not scope by created_by), so a source-read discloses NO authority the
 *     caller lacks; narrowing to operator-only would break the only consumer this
 *     exists for (read-source → edit → republish) for zero real security.
 *   - Do NOT make it agent-only either (the bug this had at first): the operator
 *     is the apex principal and must never rank below an agent. Gating on
 *     `authenticateAgent` directly refused the operator token (it isn't an `awh_`
 *     key), so the operator couldn't read source over HTTP at all.
 * (Same guardrail discipline as src/session.ts's "don't fix the session signing
 * key to the pepper" note.)
 *
 * Returns the ReadSourceOk JSON shape plus an explicit `unsanitized: true`
 * provenance marker so a consuming agent can never silently treat S as the
 * safe/rendered view. `stripped[]` / `will_not_render[]` are re-derived from S
 * at read time (in core), surfacing where the live render diverges from this
 * source. Status codes (every error is the `{ error, message }` JSON envelope —
 * this route never emits a plain-text body):
 *   200  source returned
 *   401  anonymous / bad credential (neither a valid agent key nor operator)
 *   404  not_found — missing / revoked / malformed public_id (opaque; a
 *        slug-shaped id gets a hint naming `GET /d?slug=`, derived from the
 *        request alone)
 *   409  source_unavailable — the doc is live but its current version has no
 *        retained source (un-backfilled/legacy row, or the .src blob is gone).
 *        Distinct from 404 ON PURPOSE: it's a LOUD signal the §7 backfill
 *        missed this doc, not "no such document."
 */
export async function serveSource(publicId: string, req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator credentials required");
  if (denied) return denied;

  // No slug-addressed twin exists for /source (index.ts routes only /s/:slug and
  // /s/:slug/text), so the hint points at the resolver only.
  if (!PUBLIC_ID_RE.test(publicId)) return notFoundJson(idShapeHint(publicId, () => null));

  const result = await readDocumentSourceCore(env, publicId);
  if (!result.ok) {
    // No versionNo passed (current version only), so `version_not_found` from
    // the widened union can't occur here — `source_unavailable` and `not_found`
    // are the only reachable codes; everything else folds to the opaque 404.
    if (result.code === "source_unavailable") {
      return new Response(
        JSON.stringify({
          error: "source_unavailable",
          message:
            "document is live but its current version has no retained source — " +
            "it predates source retention and has not been backfilled",
        }),
        { status: 409, headers: { "content-type": "application/json", ...COMMON_HEADERS } },
      );
    }
    return notFoundJson();
  }

  return new Response(
    JSON.stringify({
      source: result.source,
      source_format: result.source_format,
      version_no: result.version_no,
      sanitizer_v: result.sanitizer_v,
      // SHA-256 of these source bytes (migration 0015) — the currency token an
      // agent caches for the cheap list-based "is my local copy current?" check (#35).
      source_sha256: result.source_sha256,
      stripped: result.stripped,
      will_not_render: result.will_not_render,
      // Explicit provenance: S is the pre-sanitization original. A consuming
      // agent must treat it as untrusted input (it may carry markup the
      // sanitizer would have stripped). See readDocumentSourceCore.
      unsanitized: true,
      title: result.title,
      description: result.description,
      tags: result.tags,
      slug: result.slug,
      status: result.status,
      superseded_by: result.superseded_by,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: `"v${result.version_no}"`,
        "x-sanitizer-version": result.sanitizer_v,
        ...COMMON_HEADERS,
      },
    },
  );
}

/**
 * GET /d/:public_id/links — the document's link-graph neighborhood (migration
 * 0016 / GitHub issue #40): `backlinks` (live docs whose bodies link here, as
 * full DocumentListing rows) + `outbound` (this doc's on-platform links with
 * their resolution state — the broken-link report). JSON only; the shape is
 * `DocumentLinksResponse` in src/contract.ts.
 *
 * Credential-gated like `/text` and `/source` (operator ≥ agent via
 * `requireReader`), NOT public: backlink rows are listing rows for OTHER
 * documents — including private ones — and the whole-fleet listing surface has
 * always been credentialed. Visibility never gates a credentialed read
 * (src/access.ts), so a private doc's neighborhood reads the same as a public
 * one's. Anonymous → 401; missing/revoked/malformed id → the opaque 404.
 *
 * Status codes (JSON envelope on every one — no plain-text bodies here):
 *   200  links returned
 *   401  anonymous / bad credential
 *   404  not_found — missing / revoked / malformed public_id (opaque; a
 *        slug-shaped id gets the `GET /d?slug=` hint)
 */
export async function serveLinks(publicId: string, req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator credentials required");
  if (denied) return denied;

  // Like /source: no slug-addressed twin, so the hint names only the resolver.
  if (!PUBLIC_ID_RE.test(publicId)) return notFoundJson(idShapeHint(publicId, () => null));

  const result = await documentLinksCore(env, publicId);
  if (!result.ok) return notFoundJson();

  return new Response(
    JSON.stringify({
      public_id: result.public_id,
      backlinks: result.backlinks,
      outbound: result.outbound,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", ...COMMON_HEADERS },
    },
  );
}

/**
 * GET /s/:slug — content-negotiates exactly like `serveDocument` does on
 * `/d/:public_id`, just resolved through the slug first:
 *
 *   - No `Authorization`  → shell page, with the pretty slug URL kept in the
 *                           address bar (no redirect). The browser case.
 *   - Valid credential    → raw sanitized bytes — the non-browser "bytes by
 *                           slug" API path (parity with `/d/:public_id`). Any
 *                           non-anonymous principal: an agent key OR the operator
 *                           token (operator ≥ agent — see `requireReader`).
 *   - Bad credential      → 401 (don't silently downgrade to shell — surface
 *                           broken keys/tokens, matching serveDocument).
 *
 * The auth'd-bytes path is the one a programmatic consumer (e.g. the Flutter
 * app) uses to fetch a document it only knows by slug. It used to work via the
 * old 302 → `/d/:public_id` redirect (curl preserves the Authorization header
 * across a same-host redirect, and serveDocument then content-negotiated to the
 * bytes); serving the shell directly would have removed it, so we negotiate
 * here instead — same contract, one fewer hop, slug stays in the bar for
 * browsers. (For the Markdown derivation by slug use `GET /s/:slug/text` — same
 * credential gate as the bytes branch here; or the MCP `read_document` slug+format
 * route. Only the no-auth shell above is public on the slug surface.)
 *
 * Slugs are agent/human-typeable handles, distinct from the unguessable
 * `public_id` capability. The endpoint is intentionally public: a slug is a
 * deliberate, lower-entropy capability — an opt-in to discoverability. A
 * document that carries one is, by design, reachable by anyone who can guess
 * or type the slug; one that omits a slug stays behind its unguessable
 * `public_id` alone. Most documents should NOT carry a slug — it's reserved
 * for content meant to be found by name or linked to from another document.
 * That matches the model documented in skills/publishing.md + the SOLO spec.
 *
 * On the shell branch the canonical / OG `og:url` point back at the slug — so a
 * re-shared link stays pretty and unfurls (Slack, Twitter) link to the slug,
 * not the capability id. This stable `/s/:slug` URL is also the cross-reference
 * mechanism: an agent can author `<a href="/s/other-doc">` in one document
 * before the other exists, and the link resolves at click/read time.
 *
 * Package A (deliberate): the shell's iframe still loads `/d/:public_id/raw` and
 * the toolbar's Manage link still targets `/d/:public_id/manage`, so the
 * `public_id` appears in the page's HTML source. That is NOT a privilege leak —
 * the slug already grants full read access to the same document, and manage/
 * revoke stay operator-gated — but it means "view source" reveals the id. (A
 * fully slug-native render with no public_id in the markup would need a
 * `/s/:slug/raw` endpoint; left out by choice.)
 *
 * Freshness is preserved without the redirect: `findDocumentBySlugCore`
 * re-resolves the slug on every request and `Cache-Control: no-store`
 * (COMMON_HEADERS, via renderShell / serveRaw) forbids caching, so a slug that
 * was live and then revoked serves the document while live and 410s once
 * retired, on each hit. (Slugs are no longer reusable — migration 0009 — so a
 * retired slug never starts resolving to a *different* document.)
 *
 * Validates the slug shape before hitting D1 so malformed input (`/s/Foo`,
 * `/s/`, trailing slash, etc.) 404s without burning a query — matching how
 * PUBLIC_ID_RE gates serveDocument upstream of the DB.
 */
export async function serveBySlug(slug: string, req: Request, env: Env): Promise<Response> {
  const v = validateSlugInput(slug);
  // A malformed slug is never a real doc, so it's outside the private-vs-absent
  // oracle set — but a human typo deserves the same browser 404 as a valid-shape
  // miss. Agents (Authorization header present) keep the plain body.
  if (!v.ok) return req.headers.has("authorization") ? notFound() : notFoundBrowser(req);
  const result = await findDocumentBySlugCore(env, v.slug);
  if (!result.ok) {
    // Live miss → a RETIRED slug (migration 0009/0010) forwards loudly if it
    // carries a redirect, else 410 Gone; a never-claimed slug stays an opaque
    // 404. serveRetiredSlug content-negotiates the same way as a live hit:
    // interstitial/JSON for browsers/agents respectively.
    return await serveRetiredSlug(v.slug, req, env);
  }

  const d = result.document;

  // Content negotiation, mirroring serveDocument: a credential (agent key or
  // operator token) takes the bytes-by-slug path (serveRaw re-checks revoked +
  // visibility and streams from R2 by public_id), no header takes the shell. A
  // present-but-invalid credential 401s rather than downgrading, so a broken
  // integration is loud, not silent.
  if (req.headers.has("authorization")) {
    const denied = await requireReader(req, env, "invalid credentials — provide a valid agent key or operator token");
    if (denied) return denied;
    return serveRaw(d.public_id, req, env);
  }

  // Shell branch (no Authorization header) → operator auth is cookie-only, same
  // as serveShell. Drives the toolbar menu's signed-in/out items.
  const op = await authenticateOperatorRequest(req, env);

  // Visibility gate (migration 0011), same shape as serveShell. A private doc
  // with a slug returns the opaque 404 here — NOT serveRetiredSlug's 410/redirect
  // (the slug is live, not retired; we mask discovery, not announce removal). The
  // slug stays claimed; making the doc public again relights it. Agent/operator
  // bytes already passed via the branch above (agent) or `op.ok` (operator).
  const principal: Principal = op.ok ? { kind: "operator" } : { kind: "anonymous" };
  if (!canRead(principal, { visibility: d.visibility, revoked: false })) return notFoundBrowser(req);

  // The iframe below loads `/d/:public_id/raw`, which pins to the SERVED version
  // (issue #43), so this shell's metadata has to resolve the same rule or the
  // page would describe bytes the visitor isn't seeing — and `<title>`/`og:title`
  // /`og:description` are a link-unfurl surface, so that's a correctness bug,
  // not a cosmetic one. The listing row carries the CURRENT version's
  // title/description (`DOCUMENT_LISTING_JOINS` pins `v.version_no = d.current_ver`),
  // which is already right whenever the served version IS current: every private
  // document, and every public one whose promoted pointer is caught up. Only a
  // public document serving an older promoted version costs the extra read.
  const servedVer = servedVersion(d) ?? 0; // live doc (revoked excluded by the lookup) → non-null
  let servedTitle = d.title;
  let servedDescription = d.description;
  if (d.current_ver !== null && servedVer !== d.current_ver) {
    const sv = await env.META.prepare(
      `select v.title, v.description
         from documents dd
         join versions v on v.document_id = dd.id and v.version_no = ?
        where dd.public_id = ?`,
    )
      .bind(servedVer, d.public_id)
      .first<{ title: string | null; description: string | null }>();
    // A miss is not reachable (the pointer is verified at promote time and
    // version rows survive until revoke), but fall back to the listing row's
    // metadata rather than blanking the page if it ever happens.
    if (sv) {
      servedTitle = sv.title;
      servedDescription = sv.description;
    }
  }

  const origin = new URL(req.url).origin;
  return renderShell(
    {
      createdAtIso: d.created_at,
      version: servedVer,
      agentName: d.created_by_name,
      title: servedTitle,
      description: servedDescription,
      visibility: d.visibility,
      publishNotice: publishNoticeFor(op.ok, d, d.public_id),
    },
    {
      // Package A: iframe + manage reuse the public_id surface (the management
      // endpoints are public_id-addressed); canonical + pagePath are the slug so
      // the shared/unfurled URL — and the post-login landing — stay pretty. See
      // the doc comment above.
      iframeSrc: `/d/${d.public_id}/raw`,
      manageHref: `/d/${d.public_id}/manage`,
      canonicalUrl: `${origin}/s/${v.slug}`,
      pagePath: `/s/${v.slug}`,
    },
    op.ok,
  );
}
