// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Document endpoints — the operator JSON door plus the four reader/agent
 * twins (issue #72 phase 4: moved verbatim out of the former src/admin.ts).
 * Operator handlers await the shared `requireOperator` (src/session.ts) and
 * 401/403 before any other work; the reader twins gate on `requireReader`
 * (src/serve-policy.ts: any active agent key OR the operator, never anonymous).
 *
 *   GET    /admin/documents                    list documents (incl. revoked)
 *   POST   /admin/documents                    operator authors a new document (JSON body)
 *   GET    /admin/documents/search             full-text search over live documents
 *   GET    /admin/documents/:public_id         one listing row, BARE (incl. revoked) — the list's detail twin
 *   PUT    /admin/documents/:public_id         operator updates a document (new version; optional If-Match)
 *   GET    /admin/documents/:public_id/versions    version history (JSON twin of the manage-page table)
 *   POST   /admin/documents/:public_id/restore     restore version n as a NEW version (JSON twin of the manage-page form)
 *   POST   /admin/documents/:public_id/visibility  set a live doc public/private
 *   POST   /admin/documents/:public_id/promote     publish version n (what a PUBLIC doc renders)
 *   POST   /admin/documents/:public_id/slug        add/rename/clear a live doc's slug (rename auto-forwards)
 *   POST   /admin/documents/:public_id/tags        replace a live doc's tags (no version bump)
 *   POST   /admin/documents/:public_id/status      set a live doc's lifecycle status (active|deprecated; no version bump)
 *
 * Revoking a *document* lives on the public route (`DELETE /d/:public_id`)
 * since it shares the path with the resource. That endpoint is also
 * operator-auth.
 *
 * FIVE handlers here are NOT operator-gated; four are twins that share an
 * `*Impl` body with an `/admin/*` handler above, and `GET /d/pack` is the HTTP
 * twin of an MCP tool — only the auth door differs
 * (`requireReader`: any active agent key OR the operator, never anonymous):
 *
 *   GET  /d                        listDocumentsForReader     (→ GET /admin/documents)
 *   GET  /d/search                 searchDocumentsForReader   (→ GET /admin/documents/search)
 *   GET  /d/pack                   loadContextPackForReader   (MCP load_context_pack's HTTP twin)
 *   PUT  /d/:public_id/tags        curateDocumentTags         (→ POST /admin/documents/:id/tags)
 *   PUT  /d/:public_id/status      curateDocumentStatus       (→ POST /admin/documents/:id/status)
 *
 * The last two are WRITES on the agent door — see `curateDocumentStatus` for
 * why tags and lifecycle status belong there while `visibility`, revoke and
 * promotion emphatically do not. They also have MCP tools now
 * (`set_document_tags` / `set_document_status`), over the same cores.
 *
 * The `/admin/documents/:id/*` mutators dispatch by suffix-match in
 * src/index.ts — invisible to test/openapi.test.mjs's static path scan, so
 * their ROUTES entries in src/openapi.ts are hand-maintained.
 */

import type { Visibility } from "./access.js";
import { documentNotFound, jsonError } from "./admin-response.js";
import { parseIfMatch } from "./conditional.js";
import type { SourceFormat } from "./contract.js";
import {
  promoteVersionCore,
  setDocumentStatusCore,
  setDocumentTagsCore,
  setDocumentVisibilityCore,
} from "./document-lifecycle.js";
import { listDocumentsCore } from "./document-query.js";
import { listVersionsCore } from "./document-read.js";
import { setDocumentSlugCore } from "./document-slug.js";
import { publishDocumentCore, restoreVersionCore, updateDocumentCore } from "./document-write.js";
import type { Env } from "./env.js";
import { type DocumentMetadataInput, formatSlugReject } from "./metadata.js";
import { clampPackKnobs } from "./pack.js";
import { findDocumentByPublicIdCore, loadContextPackCore, packSearchHitsCore } from "./pack-core.js";
import { parseHttpListParams } from "./pagination.js";
import { searchDocumentsCore, type SearchMode } from "./search-core.js";
import { requireReader } from "./serve-policy.js";
import { requireOperator } from "./session.js";
import type { WaitUntil } from "./vector-io.js";
import { toWriteResponse } from "./wire.js";

// -- documents ----------------------------------------------------------------

/**
 * GET /admin/documents   →  { documents: [...], next_cursor }
 *
 * Cursor-paginated (see src/pagination.ts). Includes revoked documents
 * (with `revoked_at` set) so the operator can audit the history.
 * `current_size` is the size of the live version; null for revoked docs
 * (bytes were purged at revoke time).
 *
 * Thin wrapper: the actual SELECT lives in listDocumentsCore so the MCP
 * `list_documents` tool returns the same shape (single-tenant trust model;
 * see src/mcp.ts).
 */
export async function listDocuments(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  return listDocumentsImpl(req, env);
}

/**
 * GET /d   →  { documents: [...], next_cursor }
 *
 * The AGENT-reachable twin of `listDocuments` above: same shape, same core, but
 * gated by `requireReader` (agent key OR operator — never anonymous) instead of
 * `requireOperator`. This is the HTTP counterpart of the MCP `list_documents`
 * tool (which calls the identical `listDocumentsCore`), so a headless agent can
 * browse the fleet and resolve a slug → public_id (`GET /d?slug=…` returns the
 * 0-or-1 matching row) — closing the gap that left `update`/`/source`/`/links`
 * id-only with no slug lookup. Consistent with the single-tenant trust model:
 * any agent key already reads every doc's full content by id, so enumeration
 * discloses nothing new. Includes revoked docs (with `revoked_at` set), exactly
 * like the operator list and the MCP tool.
 */
export async function listDocumentsForReader(req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator token required");
  if (denied) return denied;
  return listDocumentsImpl(req, env);
}

/** Shared body of the operator + reader document-list handlers (auth already
 *  resolved by the caller). */
async function listDocumentsImpl(req: Request, env: Env): Promise<Response> {
  const params = parseHttpListParams(new URL(req.url));
  if (!params.ok) {
    return jsonError(400, params.code, params.message);
  }
  return Response.json(await listDocumentsCore(env, params));
}

/**
 * GET /admin/documents/search?q=…&tag=…&slug=…&limit=…
 *   →  { documents: [...hits] }
 *
 * Sibling to listDocuments, but ordered by BM25 relevance over the FTS5
 * index instead of by created_at. Each hit carries the same row shape as
 * listDocuments entries PLUS `score`, `matched_field`, and `snippet` —
 * see SearchHit in src/contract.ts.
 *
 * Tag and slug filters compose with `q` so "search for X within tag Y"
 * is a single request. `cursor` is silently ignored — search has no
 * cursor (see searchDocumentsCore for the rationale); `limit` is capped
 * at MAX_LIMIT just like the list endpoints.
 *
 * Operator-gated. The MCP `search_documents` tool is the agent-facing
 * twin and shares the core function.
 *
 * Status codes:
 *   200  hits returned (possibly empty)
 *   400  bad limit / bad tag-or-slug filter
 *   401  bad/missing operator auth
 *   422  `q` is missing or tokenizes to empty (e.g. only punctuation)
 */
export async function searchDocuments(req: Request, env: Env): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  return searchDocumentsImpl(req, env);
}

/**
 * GET /d/search?q=…   →  { documents: [...hits] }  (or a PackResponse with
 * ?include_bodies=true)
 *
 * The AGENT-reachable twin of `searchDocuments` above — same shape, same core,
 * `requireReader`-gated (agent key OR operator). The HTTP counterpart of the MCP
 * `search_documents` tool (identical `searchDocumentsCore`), so a headless agent
 * gets content discovery + context packs without the operator token.
 */
export async function searchDocumentsForReader(req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator token required");
  if (denied) return denied;
  return searchDocumentsImpl(req, env);
}

/** Shared body of the operator + reader document-search handlers (auth already
 *  resolved by the caller). */
async function searchDocumentsImpl(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const params = parseHttpListParams(url);
  if (!params.ok) {
    return jsonError(400, params.code, params.message);
  }
  const mode = parseSearchMode(url.searchParams.get("mode"));
  if (mode === null) {
    return jsonError(400, "bad_request", "mode must be one of: hybrid, keyword, semantic");
  }
  const q = url.searchParams.get("q");
  if (q === null || q === "") {
    return jsonError(422, "bad_query", "missing required `q` parameter");
  }
  // The raw query goes to core: it tokenizes internally for the keyword leg and
  // embeds the un-tokenized query for the semantic leg. bad_query now surfaces
  // only when no leg can carry the search (see searchDocumentsCore).
  const result = await searchDocumentsCore(env, q, params, mode);
  if (!result.ok) {
    return jsonError(
      422,
      "bad_query",
      "no usable search terms (queries need at least one 2+ character word; " +
        "operators and punctuation are dropped)",
    );
  }

  // ?include_bodies=true — the AUTOMATIC context pack (context-packs-design
  // §3.1 / issue #21): amplify this search into a budgeted bulk read. The 200
  // shape switches from { documents } to the PackResponse envelope
  // { pack, documents (with content), omitted }. Knobs are CLAMPED, not
  // rejected (clampPackKnobs); deprecated hits are omitted-and-reported unless
  // ?include_deprecated=true.
  if (url.searchParams.get("include_bodies") === "true") {
    const knobs = clampPackKnobs({
      budget_bytes: intParam(url, "budget_bytes"),
      max_documents: intParam(url, "max_documents"),
    });
    const packed = await packSearchHitsCore(env, q, result.documents, {
      budgetBytes: knobs.budgetBytes,
      maxDocuments: knobs.maxDocuments,
      includeDeprecated: url.searchParams.get("include_deprecated") === "true",
    });
    return Response.json(packed);
  }

  return Response.json({ documents: result.documents });
}

/**
 * GET /d/pack?from=<slug-or-public_id>   →  200 PackResponse
 *
 * The DOCUMENT/MANIFEST-root context pack — the HTTP twin of the MCP
 * `load_context_pack` tool (identical `loadContextPackCore`), `requireReader`-
 * gated like `GET /d` and `GET /d/search`. `from` takes a slug or a 22-char
 * public_id (live-slug-first resolution, same tiebreak as the tool); knobs are
 * CLAMPED, not rejected (clampPackKnobs). Sits on the exact-path `/d/pack`
 * dispatch ahead of `/d/:public_id` ("pack" is never a 22-char public_id).
 *
 *   400  missing `from`
 *   401  no/invalid credential
 *   404  `from` matches no live document
 *   410  `from` is a retired slug (same `gone` contract as GET /s/:slug)
 */
export async function loadContextPackForReader(req: Request, env: Env): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator token required");
  if (denied) return denied;
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  if (from === null || from === "") {
    return jsonError(
      400,
      "bad_request",
      "missing required `from` parameter (a live slug or a 22-char public_id)",
    );
  }
  const knobs = clampPackKnobs({
    budget_bytes: intParam(url, "budget_bytes"),
    max_documents: intParam(url, "max_documents"),
  });
  const result = await loadContextPackCore(
    env,
    from,
    {
      budgetBytes: knobs.budgetBytes,
      maxDocuments: knobs.maxDocuments,
      includeDeprecated: url.searchParams.get("include_deprecated") === "true",
      followRedirects: url.searchParams.get("follow_redirects") === "true",
    },
    // Same-host absolute links count as pack members; cross-site ones don't.
    url.host,
  );
  if (!result.ok) {
    if (result.code === "root_retired") {
      return jsonError(
        410,
        "gone",
        `the slug "${result.slug}" is retired: the document it pointed to was revoked, or ` +
          "the slug was renamed or released. Slugs are not reused, so this handle will not " +
          "resolve again. Find the current document via GET /d or GET /d/search.",
      );
    }
    return jsonError(
      404,
      "not_found",
      "no live document matches `from` (pass a live slug or a 22-char public_id)",
    );
  }
  const { ok: _ok, ...envelope } = result;
  return Response.json(envelope);
}

/** Parse an optional integer query param; undefined when absent/non-integer
 *  (clampPackKnobs then applies the default). */
function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/** Parse the optional `?mode=` search param. Absent → "hybrid"; an unrecognized
 *  value → null (the caller 400s). */
function parseSearchMode(raw: string | null): SearchMode | null {
  if (raw === null || raw === "") return "hybrid";
  if (raw === "hybrid" || raw === "keyword" || raw === "semantic") return raw;
  return null;
}

/**
 * POST /admin/documents/:public_id/visibility  { "visibility": "public" | "private" }
 *   →  200 { public_id, visibility }
 *
 * Operator-only — the ONLY principal that changes visibility (agents never do;
 * visibility-change is deliberately kept out of can_access, see src/access.ts).
 * Flips a LIVE document between public and private (migration 0011). Reversible,
 * no version bump, no tombstone. Idempotent: a no-op set returns 200.
 *
 * This is the curl/programmatic operator surface. (A future in-browser toolbar
 * toggle will be a separate revoke-style form with a form-field CSRF token —
 * see the plan / setDocumentVisibilityCore — reusing the same core function.)
 *
 * Status codes:
 *   200  visibility set (or already that value)
 *   400  invalid_visibility (body.visibility not "public"|"private") / bad JSON
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  no such live document (missing, revoked, or malformed public_id)
 */
export async function setDocumentVisibility(
  publicId: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const visibility = (body as { visibility?: unknown })?.visibility;
  if (visibility !== "public" && visibility !== "private") {
    return jsonError(400, "invalid_visibility", `'visibility' must be "public" or "private"`);
  }

  const result = await setDocumentVisibilityCore(env, publicId, visibility, waitUntil);
  if (!result.ok) {
    // invalid_visibility is already ruled out above; the reachable case is not_found.
    return documentNotFound(publicId);
  }
  return Response.json({ public_id: result.public_id, visibility: result.visibility });
}

/**
 * POST /admin/documents/:public_id/promote  { "version": n }
 *   →  200 { public_id, published_ver }
 *
 * Operator-only: choose WHICH version a document publishes (migration 0018).
 * The immediate sibling of the visibility flip above — between them the two
 * decide everything the anonymous internet sees: `visibility` opens the door,
 * `published_ver` picks the bytes behind it.
 *
 * WHY IT EXISTS: in the single-tenant trust model any active agent key can
 * overwrite any live document (document-write.ts deliberately does not scope writes by
 * `created_by`), and some documents are public — so without a promote step an
 * agent could push private content into a public document and have the world
 * served it on the next render. The HTML byte path for a PUBLIC document
 * therefore serves `published_ver` to EVERY caller (anonymous, agent and
 * operator alike) while `current_ver` keeps moving with each write. An agent
 * can still write; it just cannot publish.
 *
 * PRIVATE documents render `current_ver` unchanged, and every credentialed or
 * machine-readable surface (/text, /source, /links, MCP reads, search, packs,
 * FTS, vectors, the link graph) stays on `current_ver` regardless of visibility.
 * Promotion governs the browser byte path and nothing else.
 *
 * Promoting a PRIVATE document is allowed, and is the point: it stages the
 * choice before the door opens, and the later flip to public keeps it
 * (setDocumentVisibilityCore only fills `published_ver` when it is still NULL).
 *
 * No version bump, no FTS write, no vector sync, no tombstone — like the
 * visibility/tags/status mutators this sets one column and stamps `updated_at`.
 * Idempotent: re-promoting the current choice returns 200.
 *
 * Status codes:
 *   200  published_ver set (or already that version)
 *   400  bad JSON / missing-or-non-integer `version`
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  not_found — no such live document
 *   404  version_not_found — the document is live but has no version n (the body
 *        carries `version`). Same status class as the miss above, distinct
 *        discriminant: the remedy differs (pick another version vs. give up), so
 *        folding them onto one code made the difference a field's presence.
 *        Safe to distinguish only because `requireOperator` has already run —
 *        the operator can list every version at GET /admin/documents/:id/versions.
 */
export async function promoteDocumentVersion(
  publicId: string,
  req: Request,
  env: Env,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const version = (body as { version?: unknown })?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return jsonError(400, "bad_request", "missing or invalid 'version' (a positive integer)");
  }

  const result = await promoteVersionCore(env, publicId, version, waitUntil);
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return documentNotFound(publicId);
      case "version_not_found":
        // First-class code since the 2.0 window (ledger entry 7): `version` is a
        // declared, REQUIRED member of this arm rather than an optional field
        // bolted onto `not_found`. The shape guard above must stay — the core
        // returns this code for a non-integer or `< 1` version WITHOUT a DB read,
        // so dropping the guard would assert "this document exists" about a
        // public_id that does not.
        return jsonError(404, "version_not_found", `this document has no version v${version}`, {
          version,
        });
    }
  }
  return Response.json({ public_id: result.public_id, published_ver: result.published_ver });
}

/**
 * POST /admin/documents/:public_id/slug  { "slug": "<value>" }
 *   →  200 { public_id, slug, retired, redirected }
 *
 * Operator-only: add, rename, or clear a LIVE document's slug WITHOUT bumping a
 * version (slug is identity-adjacent — see setDocumentSlugCore). `slug` is a
 * required string; a non-empty value sets/renames (validated + uniqueness-
 * checked), an empty string `""` clears it.
 *
 * A RENAME (the doc already had a different slug) retires the old name AND
 * auto-forwards it to this document — exactly like an agent's `update_document`
 * slug change — so `redirected: true` and `/s/<old>` keeps resolving loudly. A
 * CLEAR retires the old name with NO redirect (`/s/<old>` 410s). A first-time
 * claim retires nothing.
 *
 * This is the programmatic twin of the browser slug form (`POST /d/:id/slug`);
 * both call setDocumentSlugCore. The agentic equivalent is the slug field on the
 * MCP/HTTP write tools — there is no separate MCP slug-change tool.
 *
 * Status codes:
 *   200  slug set / renamed / cleared (or unchanged no-op)
 *   400  bad JSON / missing-or-non-string `slug`
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  no such live document (missing, revoked, or malformed public_id)
 *   409  slug_taken (live collision) / slug_retired (previously used — not reusable)
 *   422  invalid_slug (charset/length — body has `reason`)
 */
export async function setDocumentSlug(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const slug = (body as { slug?: unknown })?.slug;
  if (typeof slug !== "string") {
    return jsonError(400, "bad_request", "missing or invalid 'slug' (string; pass \"\" to clear)");
  }

  const result = await setDocumentSlugCore(env, publicId, slug);
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return documentNotFound(publicId);
      case "invalid_slug":
        return jsonError(422, "invalid_slug", formatSlugReject(result.reason), {
          reason: result.reason,
        });
      case "slug_taken":
        return jsonError(409, "slug_taken", `slug "${result.slug}" is already in use`, {
          slug: result.slug,
        });
      case "slug_retired":
        return jsonError(
          409,
          "slug_retired",
          `slug "${result.slug}" was previously used and is retired; slugs are not reusable`,
          { slug: result.slug },
        );
    }
  }
  return Response.json({
    public_id: result.public_id,
    slug: result.slug,
    retired: result.retired,
    redirected: result.redirected,
  });
}

/**
 * POST /admin/documents/:public_id/status  { "status": "active" | "deprecated", "superseded_by"?: "<public_id>" }
 *   →  200 { public_id, status, superseded_by }
 *
 * Operator-only: set a LIVE document's lifecycle status (migration 0014 — the
 * "still findable, no longer current" axis context packs depend on) WITHOUT
 * bumping a version. Mirrors the visibility/tags/slug no-version-bump mutators;
 * see setDocumentStatusCore for the semantics:
 *   - `archived` is reserved (in the DB CHECK) and REJECTED until its behavior
 *     is wired — only "active" and "deprecated" are settable in v1.
 *   - `superseded_by` (optional, deprecated only) names the replacement doc by
 *     public_id. FULL-REPLACE per call; omitted → cleared. Must be a LIVE doc
 *     and not the doc itself. Setting "active" always clears it.
 *
 * Surfaces never auto-follow the pointer — search/list/pack carry it so the
 * reader decides (the loud slug-redirect stance, document-level).
 *
 * Status codes:
 *   200  status set (or already that value)
 *   400  bad JSON / invalid_status (not "active"|"deprecated")
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  no such live document (missing, revoked, or malformed public_id)
 *   422  bad_target (superseded_by malformed, not live, or self-pointing)
 */
export async function setDocumentStatus(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  return setDocumentStatusImpl(publicId, req, env);
}

/**
 * PUT /d/:public_id/status  { "status": "active" | "deprecated", "superseded_by"?: "<public_id>" }
 *
 * The AGENT-reachable twin of `setDocumentStatus` — same body, same core, same
 * response; only the door differs (`requireReader`: any active agent key OR the
 * operator, never anonymous).
 *
 * WHY THIS IS SAFE TO PUT ON THE AGENT DOOR: in the single-tenant whole-fleet
 * trust model an agent key already replaces any document's entire CONTENT via
 * `PUT /d/:public_id` (document-write.ts deliberately does not scope writes by
 * `created_by`). Marking that same document deprecated grants strictly less
 * authority than rewriting it, so this is not a widening of the trust model —
 * it just stops the model from being incoherent. An agent that can author a
 * corpus but can never curate it produces exactly the rot context packs exist
 * to avoid: superseded documents that still rank, with no way for the author to
 * say so.
 *
 * WHAT STAYS OPERATOR-ONLY, DELIBERATELY: `visibility` and `revoke`. Visibility
 * is the boundary between "private to the fleet" and "readable by the anonymous
 * internet" — a different KIND of authority from anything an agent key already
 * holds, since every agent-door power above is exercised inside the fleet.
 * Revoke is irreversible. Neither belongs here, and neither should be added by
 * analogy to this pair. (`POST /d/:id/status`, the manage-page HTML form, stays
 * operator-only too — this is PUT for exactly that reason.)
 *
 * Status codes are `setDocumentStatus`'s, with 401 meaning "no agent key and no
 * operator token" and no 403 (there is no cookie path here).
 */
export async function curateDocumentStatus(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator token required");
  if (denied) return denied;
  return setDocumentStatusImpl(publicId, req, env);
}

/** Shared body of the operator + agent-door status handlers (auth already
 *  resolved by the caller). */
async function setDocumentStatusImpl(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const b = body as { status?: unknown; superseded_by?: unknown };
  if (typeof b?.status !== "string") {
    return jsonError(400, "bad_request", `missing or invalid 'status' ("active" | "deprecated")`);
  }
  if (b.superseded_by !== undefined && b.superseded_by !== null && typeof b.superseded_by !== "string") {
    return jsonError(400, "bad_request", "'superseded_by' must be a public_id string when present");
  }

  const result = await setDocumentStatusCore(env, publicId, b.status, b.superseded_by ?? null);
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return documentNotFound(publicId);
      case "invalid_status":
        return jsonError(
          400,
          "invalid_status",
          `'status' must be "active" or "deprecated" ("archived" is reserved and not yet settable)`,
        );
      case "bad_target":
        return jsonError(
          422,
          "bad_target",
          `superseded_by "${result.target}" is not a live document (or points at this document itself)`,
          { target: result.target },
        );
    }
  }
  return Response.json({
    public_id: result.public_id,
    status: result.status,
    superseded_by: result.superseded_by,
  });
}

/**
 * POST /admin/documents/:public_id/tags  { "tags": ["a", "b", ...] }
 *   →  200 { public_id, tags }
 *
 * Operator-only: REPLACE a LIVE document's tags WITHOUT bumping a version (tags
 * are document-level classification since migration 0012 — see
 * setDocumentTagsCore). `tags` is a required array of strings; pass `[]` to
 * clear. Full replacement, not a merge. Input is charset-sanitized/deduped/
 * capped exactly like the publish/update tags field, so invalid chars are
 * silently stripped (not rejected) and the stored shape matches the write path.
 *
 * This is the operator JSON twin of the librarian's curation pass. The
 * agent-reachable twin is `PUT /d/:public_id/tags` (`curateDocumentTags`
 * below); the write tools' `tags` field remains the way to set them as part of
 * a content write.
 *
 * Status codes:
 *   200  tags replaced (or unchanged no-op)
 *   400  bad JSON / missing-or-non-array `tags`
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  no such live document (missing, revoked, or malformed public_id)
 */
export async function setDocumentTags(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;
  return setDocumentTagsImpl(publicId, req, env);
}

/**
 * PUT /d/:public_id/tags  { "tags": ["a", "b", ...] }
 *
 * The AGENT-reachable twin of `setDocumentTags` — same body, same core, same
 * response; only the door differs (`requireReader`: any active agent key OR the
 * operator, never anonymous). See `curateDocumentStatus` for the full rationale
 * — in short, an agent key already replaces this document's entire content
 * through `PUT /d/:public_id`, so re-classifying it grants strictly less
 * authority than it already has, while `visibility` and `revoke` stay
 * operator-only because they are a different KIND of authority.
 *
 * This is the write the librarian pass (docs/design/librarian-design.md) was
 * always going to need: retagging is the one curation verb that must be cheap,
 * because it is the one that runs over the whole corpus.
 */
export async function curateDocumentTags(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireReader(req, env, "valid agent key or operator token required");
  if (denied) return denied;
  return setDocumentTagsImpl(publicId, req, env);
}

/** Shared body of the operator + agent-door tags handlers (auth already
 *  resolved by the caller). */
async function setDocumentTagsImpl(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const tags = (body as { tags?: unknown })?.tags;
  if (!Array.isArray(tags)) {
    return jsonError(400, "bad_request", "missing or invalid 'tags' (array of strings; pass [] to clear)");
  }

  const result = await setDocumentTagsCore(env, publicId, tags);
  if (!result.ok) {
    return documentNotFound(publicId);
  }
  return Response.json({ public_id: result.public_id, tags: result.tags });
}

// -- operator version history + restore ---------------------------------------
//
// The JSON twins of the manage page's version-history table and Restore button
// (src/manage.ts: renderVersionHistory / handleRestoreForm). Both were HTML-form-
// only, so a scripted operator client — the Flutter app, a rollback script — had
// to scrape a page and parse a result card to use a first-class operator
// feature, while every other operator document mutator already had a JSON twin
// here. No new core, no migration: `listVersionsCore` / `restoreVersionCore`
// already back the MCP read knob and the browser form.
//
// OPERATOR-ONLY, both of them. Restore is a write that resurrects bytes an agent
// may have deliberately replaced, and version history is an operator axis that
// visibility deliberately does NOT govern (a public doc's history is as
// operator-only as a private one's — see serveVersionShell). There is no agent
// restore in v1; agents read history through MCP `read_document include_history`.

/**
 * GET /admin/documents/:public_id   →  200 <DocumentListing>
 *
 * The single-document twin of `GET /admin/documents` — one listing row, the
 * exact same projection (DOCUMENT_LISTING_COLUMNS), returned BARE rather than
 * wrapped: there is nothing to sit beside one row (the list wraps only because
 * it carries `next_cursor`), and the consuming app already does
 * `DocumentListing.fromJson(response.data)`.
 *
 * It exists because the list→tap→detail flow had no detail call: a consumer
 * refreshing one document's metadata after a write had to re-fetch the whole
 * list, or scrape the manage page. `GET /d/:id` is the RENDER surface (HTML,
 * visibility-gated), so the JSON reader twin cannot live there.
 *
 * REVOKED ROWS ARE RETURNED, deliberately. `findDocumentByPublicIdCore` carries
 * no `revoked_at is null` predicate, and `GET /admin/documents` lists revoked
 * documents for audit — so 404ing here on a row the list just rendered would be
 * a broken drill-down. Such a row degrades to nulls (revoke nulls `current_ver`,
 * `published_ver` and `slug`, so the version joins miss and the title/size/hash
 * columns come back null), identical to how it already appears in the list.
 *
 * OPERATOR-ONLY, and the gate is the first statement — an unauthenticated probe
 * must not be able to fingerprint document existence here. There is deliberately
 * no agent-door twin: an agent already reads the same rows through `GET /d`,
 * `GET /d?slug=` and MCP `list_documents`, so this adds no reach it lacks.
 *
 * Status codes (no 403: `requireOperator` demands CSRF only on unsafe methods):
 *   200  the listing row (possibly a revoked one)
 *   401  bad/missing operator auth
 *   404  not_found — no such document, or a malformed public_id
 */
export async function getDocument(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const row = await findDocumentByPublicIdCore(env, publicId);
  // Same opaque body as every other admin document 404: `documentNotFound` runs
  // the purely-syntactic `idShapeHint` (no DB read) and attaches the
  // service-desc Link header. Never enrich it with anything looked up above.
  if (!row) return documentNotFound(publicId);
  return Response.json(row);
}

/**
 * GET /admin/documents/:public_id/versions   →  200 { public_id, current_ver, versions[] }
 *
 * Newest-first version manifest for a LIVE document, capped at the 200 most
 * recent (VERSION_HISTORY_LIMIT in document-read.ts — the same bound every list surface
 * uses). Each row is the `VersionListing` shape from src/contract.ts:
 * `version_no`, `created_at`, sizes, `sanitizer_v`, `source_format`, `title`,
 * `is_current`, the per-version author (`author_kind` / `author_id` /
 * `author_name`, migration 0013), and `source_present` — the last being the one
 * a caller MUST check before offering Restore, since a pre-0008 version with no
 * retained source cannot be restored (the manage page shows a muted "no source"
 * in place of its button for exactly this).
 *
 * Status codes (no 403: `requireOperator` demands CSRF only on unsafe methods):
 *   200  history returned
 *   401  bad/missing operator auth
 *   404  no such live document (missing, revoked, or malformed public_id)
 */
export async function listDocumentVersions(
  publicId: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  const result = await listVersionsCore(env, publicId);
  if (!result.ok) return documentNotFound(publicId);
  const { ok: _ok, ...envelope } = result;
  return Response.json(envelope);
}

/**
 * POST /admin/documents/:public_id/restore  { "version": n }
 *   →  200 { public_id, url, version, restored_from, … }  (the write envelope)
 *
 * Re-publishes version `n`'s retained source as a NEW version, authored by the
 * `{ kind: "operator" }` principal. It is NEVER a `current_ver` rewind — see
 * restoreVersionCore: pointing `current_ver` backwards would make the next
 * ordinary update collide on the `(document_id, version_no)` primary key. The
 * response is the ordinary write envelope plus `restored_from`, so the caller's
 * existing publish/update handling applies unchanged.
 *
 * Body + title/description are restored. The document's CURRENT slug and tags
 * are left untouched — both are document-level (identity and classification),
 * not content, so a restore does not un-do a rename or a retag.
 *
 * Status codes:
 *   200  restored as a new version
 *   400  bad JSON / missing-or-non-integer `version` / that version has no content
 *   401  bad/missing operator auth
 *   403  csrf_failed (cookie-authed + missing/invalid X-CSRF-Token)
 *   404  not_found — no such live document
 *   404  version_not_found — that version doesn't exist (the body carries
 *        `version`). Same status class, distinct discriminant — see the twin in
 *        promoteDocumentVersion above for why the split is safe here.
 *   409  source_unavailable (that version predates source retention — revoke and
 *        republish, there is deliberately no fall-back-to-H; the body carries
 *        `version`) / precondition_failed
 *        (a concurrent write landed mid-restore; just retry)
 *   413  too_large / storage_cap_exceeded
 *   422  too_deep
 */
export async function restoreDocumentVersion(
  publicId: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const version = (body as { version?: unknown })?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return jsonError(400, "bad_request", "missing or invalid 'version' (a positive integer)");
  }

  const result = await restoreVersionCore(
    env,
    publicId,
    version,
    { kind: "operator" },
    new URL(req.url).origin,
    ctx.waitUntil.bind(ctx), // re-embed after the D1 batch commits
  );
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return documentNotFound(publicId);
      case "version_not_found":
        // First-class code since the 2.0 window (ledger entry 7) — `version` is
        // a declared, REQUIRED member of this arm, not an optional field on
        // `not_found`. Same shape-guard dependency as promoteDocumentVersion.
        return jsonError(404, "version_not_found", `this document has no version v${version}`, {
          version,
        });
      case "source_unavailable":
        return jsonError(
          409,
          "source_unavailable",
          `v${version} predates source retention, so it cannot be restored — revoke and republish the document instead`,
          { version },
        );
      case "version_conflict":
        return jsonError(
          409,
          "precondition_failed",
          `the document changed while restoring (it is now v${result.current_version}) — retry`,
          { current_version: result.current_version, expected: result.expected },
        );
      case "empty_body":
        return jsonError(400, "empty_body", `v${version} has no content to restore`);
      case "too_large":
        return jsonError(413, "too_large", `input exceeds ${result.limit} bytes`, {
          limit: result.limit,
        });
      case "too_deep":
        return jsonError(
          422,
          "too_deep",
          `document nesting too deep (${result.depth} levels; limit ${result.limit}) — flatten the markup`,
          { limit: result.limit, depth: result.depth },
        );
      case "storage_cap_exceeded":
        return jsonError(
          413,
          "storage_cap_exceeded",
          `fleet has used ${result.used} of ${result.cap} bytes; this write would exceed cap`,
          { used: result.used, cap: result.cap, this_write: result.this_write },
        );
      // The slug branches of UpdateErr are unreachable: a restore never changes
      // the slug (restoreMetaFrom carries title/description only), so nothing can
      // collide. Folded into a 500 rather than silently 200-ing.
      default:
        return jsonError(500, "internal", `unexpected restore failure: ${result.code}`);
    }
  }

  const { ok: _ok, ...envelope } = result;
  return Response.json(envelope);
}

// -- operator authoring -------------------------------------------------------
//
// The operator's OWN write door (POST /admin/documents, PUT /admin/documents/
// :public_id) — distinct from the agent write path (POST /d, PUT /d/:id) and
// from the MCP write tools. The operator authors as the `{ kind: "operator" }`
// principal (migration 0013): created_by/author_kind record "operator", no agent
// row is invented. Both route through the SAME core write path as every other
// door (publishDocumentCore / updateDocumentCore), so sanitize→cap→R2→D1→FTS
// runs exactly once and identically.
//
// JSON body (vs the agent path's raw text/html|text/markdown body + X-Doc-*
// headers): app-idiomatic and consistent with the rest of /admin/*. The
// operator app sends one object the mobile client codegens off /openapi.json.

/**
 * Validate and normalize the shared operator-write JSON body into the pieces
 * the core write functions take. `content` (string) and `format` ("html" |
 * "markdown") are required; title/description/tags/slug are optional and follow
 * the same omitted-vs-`""` inheritance semantics as every other write surface
 * (an absent key is left `undefined` so update inherits; an explicit `""`
 * clears). `visibility` is parsed only when `allowVisibility` (create) — on
 * update, visibility has its own no-version-bump endpoint
 * (POST /admin/documents/:id/visibility), so it is not accepted here.
 */
function parseOperatorWriteBody(
  body: unknown,
  allowVisibility: boolean,
):
  | { ok: true; content: string; format: SourceFormat; meta: DocumentMetadataInput; visibility?: Visibility }
  | { ok: false; response: Response } {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad = (msg: string) => ({ ok: false as const, response: jsonError(400, "bad_request", msg) });

  if (typeof b.content !== "string") return bad("missing or invalid 'content' (string)");
  if (b.format !== "html" && b.format !== "markdown") {
    return bad(`missing or invalid 'format' ("html" or "markdown")`);
  }

  const meta: DocumentMetadataInput = {};
  if (b.title !== undefined) {
    if (typeof b.title !== "string") return bad("'title' must be a string");
    meta.title = b.title;
  }
  if (b.description !== undefined) {
    if (typeof b.description !== "string") return bad("'description' must be a string");
    meta.description = b.description;
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || !b.tags.every((t) => typeof t === "string")) {
      return bad("'tags' must be an array of strings");
    }
    meta.tags = b.tags as string[];
  }
  if (b.slug !== undefined) {
    if (typeof b.slug !== "string") return bad(`'slug' must be a string (pass "" to clear)`);
    meta.slug = b.slug;
  }

  let visibility: Visibility | undefined;
  if (allowVisibility && b.visibility !== undefined) {
    if (b.visibility !== "public" && b.visibility !== "private") {
      return bad(`'visibility' must be "public" or "private"`);
    }
    visibility = b.visibility;
  }

  return { ok: true, content: b.content, format: b.format, meta, visibility };
}

/**
 * POST /admin/documents  { content, format, title?, description?, tags?, slug?, visibility? }
 *   →  201 { public_id, url, version, … }  (the shared WriteResponse)
 *
 * Operator-authored publish. Born at `visibility` when supplied (atomic, via
 * publishDocumentCore's operator-only override), else the deploy default. Same
 * success shape + Location/ETag headers as POST /d.
 *
 * Status codes:
 *   201  created
 *   400  bad JSON / invalid body (content, format, title, description, tags, slug, visibility)
 *   401  bad/missing operator auth        403  csrf_failed (cookie + missing X-CSRF-Token)
 *   409  slug_taken / slug_retired        413  too_large / storage_cap_exceeded
 *   422  invalid_slug
 */
export async function createDocumentAsOperator(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const parsed = parseOperatorWriteBody(raw, true);
  if (!parsed.ok) return parsed.response;

  const origin = new URL(req.url).origin;
  const result = await publishDocumentCore(
    env,
    parsed.content,
    { kind: "operator" },
    origin,
    parsed.format,
    parsed.meta,
    parsed.visibility,
    ctx.waitUntil.bind(ctx),
  );
  if (!result.ok) return mapWriteError(result);

  return Response.json(toWriteResponse(result), {
    status: 201,
    headers: { Location: result.url, ETag: `"v${result.version}"` },
  });
}

/**
 * PUT /admin/documents/:public_id  { content, format, title?, description?, tags?, slug? }
 *   →  200 { public_id, url, version, … }  (the shared WriteResponse)
 *
 * Operator-authored update — appends a new version authored by the operator
 * principal. `documents.created_by` is untouched (creator is immutable), so an
 * operator update of an agent-created doc yields creator=agent, this-version
 * author=operator (the full author list the version history surfaces).
 *
 * OPTIONAL If-Match (the deliberate, app-friendly divergence from PUT /d/:id's
 * REQUIRED If-Match): a `"v<n>"` (or `*`) header is honored for optimistic
 * concurrency (412 on mismatch); ABSENT means last-write-wins. visibility is
 * NOT accepted here — use POST /admin/documents/:id/visibility.
 *
 * Status codes:
 *   200  new version stored
 *   400  bad JSON / invalid body / malformed If-Match
 *   401  bad/missing operator auth        403  csrf_failed
 *   404  no such (missing or revoked) document
 *   409  slug_taken / slug_retired        412  If-Match version mismatch
 *   413  too_large / storage_cap_exceeded 422  invalid_slug
 */
export async function updateDocumentAsOperator(
  publicId: string,
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const denied = await requireOperator(req, env);
  if (denied) return denied;

  // Optional optimistic concurrency. Absent If-Match → null (clobber); `*` →
  // null; a version tag (`"v<n>"`, or the lenient `v<n>`/`<n>`/`"<n>"` forms) →
  // n; anything else → 400. (Required-If-Match is the agent path's contract —
  // POST /d; this operator/app path opts for last-write-wins when the header is
  // omitted.) Shares parseIfMatch with PUT /d/:id so both write doors accept the
  // same shapes (GitHub issue #32).
  let expectedVersion: number | null = null;
  const ifMatchRaw = req.headers.get("if-match");
  if (ifMatchRaw) {
    const ifMatch = parseIfMatch(ifMatchRaw);
    if (ifMatch.kind === "invalid") {
      return jsonError(400, "bad_request", `If-Match must be a version like "v3" (a bare v3 or 3 is also accepted) or "*"`);
    }
    expectedVersion = ifMatch.kind === "version" ? ifMatch.v : null;
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, "bad_json", "invalid JSON body");
  }
  const parsed = parseOperatorWriteBody(raw, false);
  if (!parsed.ok) return parsed.response;

  const origin = new URL(req.url).origin;
  const result = await updateDocumentCore(
    env,
    publicId,
    parsed.content,
    expectedVersion,
    { kind: "operator" },
    origin,
    parsed.format,
    parsed.meta,
    ctx.waitUntil.bind(ctx),
  );
  if (!result.ok) return mapWriteError(result, publicId);

  return Response.json(toWriteResponse(result), {
    status: 200,
    headers: { Location: result.url, ETag: `"v${result.version}"` },
  });
}

/**
 * Map a publish/update core failure to its HTTP response. The union is the same
 * one POST /d and PUT /d/:id map (see src/index.ts) — kept identical so the
 * operator door's error contract matches the agent door's exactly. `empty_body`
 * is reachable (the parser allows a `""` content through to core, which is the
 * authoritative emptiness check).
 *
 * `publicId` is the addressed document on the UPDATE path, used only to build
 * the `not_found` hint. Absent on the create path (POST /admin/documents
 * addresses nothing), where `not_found` is unreachable anyway.
 */
function mapWriteError(
  result:
    | Awaited<ReturnType<typeof publishDocumentCore>>
    | Awaited<ReturnType<typeof updateDocumentCore>>,
  publicId?: string,
): Response {
  if (result.ok) throw new Error("mapWriteError called on a success result");
  switch (result.code) {
    case "not_found":
      return publicId === undefined
        ? jsonError(404, "not_found", "no such document")
        : documentNotFound(publicId);
    case "empty_body":
      return jsonError(400, "empty_body", "body is empty");
    case "too_large":
      return jsonError(413, "too_large", `input exceeds ${result.limit} bytes`, {
        limit: result.limit,
      });
    case "too_deep":
      return jsonError(
        422,
        "too_deep",
        `document nesting too deep (${result.depth} levels; limit ${result.limit}) — flatten the markup`,
        { limit: result.limit, depth: result.depth },
      );
    case "storage_cap_exceeded":
      return jsonError(
        413,
        "storage_cap_exceeded",
        `fleet has used ${result.used} of ${result.cap} bytes; this write would exceed cap`,
        { used: result.used, cap: result.cap, this_write: result.this_write },
      );
    case "version_conflict":
      return jsonError(412, "precondition_failed", `current version is v${result.current_version}`, {
        current_version: result.current_version,
        expected: result.expected,
      });
    case "invalid_slug":
      return jsonError(422, "invalid_slug", formatSlugReject(result.reason), { reason: result.reason });
    case "slug_taken":
      return jsonError(409, "slug_taken", `slug "${result.slug}" is already in use`, {
        slug: result.slug,
      });
    case "slug_retired":
      return jsonError(
        409,
        "slug_retired",
        `slug "${result.slug}" was previously used and is retired; slugs are not reusable`,
        { slug: result.slug },
      );
    // Migration 0018 / issue #43. UNREACHABLE through this mapper in practice —
    // its only callers are the operator authoring handlers, which pass
    // `{kind:"operator"}`, and the lock fires only for `author.kind === "agent"`.
    // The arm exists because the switch is exhaustive over the core error union
    // (that exhaustiveness is what makes tsc catch a new code with no handler),
    // and because "unreachable today" is a property of the callers, not of the
    // type — a future operator-door caller that forwards an agent's author would
    // otherwise fall through to no return at all.
    case "slug_locked":
      return jsonError(
        403,
        "slug_locked",
        "this document is public; a public document's slug can only be changed by the operator",
      );
  }
}
