// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Slug identity: claim resolution, tombstoning, redirect resolution and the
 * operator slug mutators (migrations 0005 / 0009 / 0010).
 *
 * Key invariants:
 *   - `resolveSlug` is the ONE claim path every writer goes through: charset
 *     validation → reserved-prefix check (`allowReservedSlug` only for the
 *     seeder) → live-collision → tombstone check. Invalid input is REJECTED,
 *     never sanitized.
 *   - A shed slug (revoke, rename, release) is retired FOREVER via
 *     `tombstoneSlug` (`INSERT OR IGNORE`, so the revoke batch can never roll
 *     back on it); only `releaseSlugTombstoneCore` un-retires.
 *   - Redirects are LOUD and single-hop; `resolveRedirectTarget` filters
 *     `revoked_at is null` but NOT visibility — every caller gates the result.
 *     Its `title` joins the SERVED version (the one non-byte query reaching an
 *     anonymous reader).
 *   - `setDocumentSlugCore` is operator-only; the agent-side `slug_locked` rule
 *     lives in document-write's updateDocumentCore.
 */

import { recordAudit } from "./audit.js";
import { TOUCH_UPDATED_AT } from "./document-listing.js";
import type { PublishErr } from "./document-write.js";
import type { Env } from "./env.js";
import { PUBLIC_ID_RE } from "./ids.js";
import { isReservedSlug, type SlugReject, validateSlugInput } from "./metadata.js";
import { SERVED_VER_SQL } from "./served-version.js";
import type { WaitUntil } from "./vector-io.js";
import type { RedirectTarget, SlugTombstone } from "./contract.js";

/**
 * Resolve agent slug input against the current state of the document.
 *
 * Three shapes the caller can produce:
 *   - `undefined`     → keep `priorSlug` unchanged (no-op)
 *   - `""` (empty)    → release (slug becomes NULL — the doc has no slug)
 *   - non-empty text  → validate; if equal to `priorSlug` it's a no-op,
 *                       otherwise check the partial unique index for a
 *                       collision and stage the claim.
 *
 * Returns an "action" the caller applies in its D1 batch — separating
 * the decision from the SQL keeps publish and update branches readable
 * and centralizes the validation/uniqueness path.
 *
 * `selfId` is set on update so a no-op rewrite (same slug as before) and
 * the uniqueness check both know to ignore the current document's own row.
 * On publish there is no row yet, so `selfId` is null.
 */
type SlugAction =
  | { kind: "noop"; slug: string | null }
  // `retire` is the prior slug to tombstone (null on a first-time claim, where
  // there's nothing to retire; non-null on a rename, where the old slug must
  // be permanently reserved per migration 0009).
  | { kind: "set"; slug: string; retire: string | null }
  // An explicit `""` release. `retire` is the slug being released — also
  // tombstoned (a released slug is just as spent as a renamed one; "release"
  // un-publishes it from this doc, it does NOT free it for reuse).
  | { kind: "clear"; retire: string };
export async function resolveSlug(
  env: Env,
  input: string | undefined,
  priorSlug: string | null,
  selfId: string | null,
  /**
   * Set ONLY by the platform-documentation seeder (`seedPlatformDocsCore`),
   * which is the one writer allowed to claim a slug under
   * `RESERVED_SLUG_PREFIX`. Defaults to false, so every ordinary door — HTTP,
   * MCP, operator, edit, restore — is covered by the check below without
   * having to know the check exists.
   *
   * A flag rather than an absence of a check: the exemption is visible in one
   * place instead of being implied by which call site was used.
   */
  allowReservedSlug = false,
): Promise<{ ok: true; action: SlugAction } | Extract<PublishErr, { code: "invalid_slug" | "slug_taken" | "slug_retired" }>> {
  // Field absent → carry through whatever's already there.
  if (input === undefined) return { ok: true, action: { kind: "noop", slug: priorSlug } };

  // Empty value → release. Cheap and unambiguous; no uniqueness check needed
  // since NULL slugs aren't covered by the partial unique index. The released
  // slug is tombstoned by the caller (priorSlug is non-null on this branch).
  if (input.trim().length === 0) {
    // If the doc already has no slug, this is a no-op — avoid the UPDATE.
    if (priorSlug === null) return { ok: true, action: { kind: "noop", slug: null } };
    return { ok: true, action: { kind: "clear", retire: priorSlug } };
  }

  const v = validateSlugInput(input);
  if (!v.ok) return { ok: false, code: "invalid_slug", reason: v.reason };
  const slug = v.slug;

  // Reserved namespace (issue #4). Checked HERE, after charset validation and
  // before the uniqueness queries, because it is a property of the NAME rather
  // than of the corpus: it costs no DB round trip and it must answer the same
  // way whether or not a seeded doc happens to exist yet on this instance.
  // Reported as `invalid_slug` with its own reason rather than a new ErrorCode
  // — it is a rule about which slugs are well-formed for this caller, and
  // reusing the code keeps `formatSlugReject` the one copy of the wording.
  if (!allowReservedSlug && isReservedSlug(slug)) {
    return { ok: false, code: "invalid_slug", reason: "reserved_prefix" };
  }

  // Same slug as the existing one — skip the uniqueness query AND the UPDATE.
  if (slug === priorSlug) return { ok: true, action: { kind: "noop", slug } };

  // Uniqueness pre-check, across BOTH the live set and the retired set
  // (migration 0009). The partial UNIQUE INDEX on documents(slug) WHERE
  // slug IS NOT NULL enforces live-vs-live at write time too, but a pre-check
  // gives us a clean error code instead of a thrown constraint violation (D1
  // doesn't surface those structurally). Best-effort: a race can still slip a
  // second claim through between this SELECT and the write, in which case the
  // UPDATE/INSERT will throw and the top-level try/catch surfaces it as an
  // internal error. Acceptable for v1 (same posture 0005 already documented).
  const conflictQ = selfId
    ? env.META.prepare("select id from documents where slug = ? and id != ?").bind(slug, selfId)
    : env.META.prepare("select id from documents where slug = ?").bind(slug);
  const conflict = await conflictQ.first<{ id: string }>();
  if (conflict) return { ok: false, code: "slug_taken", slug };

  // Retired-slug check. A slug that any document ever shed is permanently
  // reserved — reclaiming it would resurrect the exact silent-repurposing bug
  // 0009 closes. Distinct `slug_retired` code so the caller can explain
  // "permanently spent" rather than "in use right now."
  const retired = await env.META
    .prepare("select slug from slug_tombstones where slug = ?")
    .bind(slug)
    .first<{ slug: string }>();
  if (retired) return { ok: false, code: "slug_retired", slug };

  return { ok: true, action: { kind: "set", slug, retire: priorSlug } };
}

/**
 * Build the statement that retires a slug into `slug_tombstones` (migration
 * 0009). Shared by every transition that strips a slug off a live document —
 * revoke, rename, and explicit release — so the reservation shape is identical
 * across all three call sites.
 *
 * `INSERT OR IGNORE`, NOT a plain INSERT, on purpose: the slug being retired
 * was live on `documents.slug` (covered by the partial unique index) and a live
 * slug is disjoint from the tombstone set, so a PK collision here is impossible
 * under the invariant. OR IGNORE makes that guarantee fail-safe instead of
 * fail-loud — most importantly it means the revoke batch (the operator kill
 * switch, which must ALWAYS win) can never roll back on a tombstone write even
 * if the invariant were somehow violated. The slug stays reserved either way.
 *
 * `redirectTo` (migration 0010) is set ONLY on a rename: the renamed-away slug
 * forwards to the document's own `public_id` (same-document, so it can't
 * surprise anyone — the auto-redirect case). Revoke and explicit release pass
 * null (a plain 410 tombstone); the operator sets a cross-document redirect
 * separately via setSlugRedirectCore.
 */
export function tombstoneSlug(
  env: Env,
  slug: string,
  documentId: string,
  reason: "revoked" | "renamed" | "released",
  redirectTo: string | null = null,
): D1PreparedStatement {
  return env.META
    .prepare(
      "insert or ignore into slug_tombstones (slug, document_id, reason, redirect_to) values (?, ?, ?, ?)",
    )
    .bind(slug, documentId, reason, redirectTo);
}

/**
 * Look up a retired slug in `slug_tombstones` (migration 0009). Returns the
 * tombstone row, or null if the slug was never claimed by any document.
 *
 * The serve / read surfaces call this ONLY after a live lookup
 * (findDocumentBySlugCore / resolvePublicIdBySlug) misses, to tell the two
 * miss-reasons apart: a retired slug → 410 Gone (it once existed and is
 * permanently spent), a never-claimed slug → opaque 404. The slug is validated
 * upstream; this is the bare DB hit.
 *
 * `redirect_to` (migration 0010) is the optional forwarding target — the target
 * document's `public_id`. NULL → a plain 410 tombstone; non-NULL → the caller
 * resolves it (resolveRedirectTarget) and forwards loudly (interstitial /
 * `409 slug_redirected` / `follow_redirects`).
 */
// SlugTombstone — a retired-slug tombstone row. Defined in src/contract.ts.
export async function findSlugTombstoneCore(
  env: Env,
  slug: string,
): Promise<SlugTombstone | null> {
  const row = await env.META.prepare(
    "select slug, document_id, retired_at, reason, redirect_to from slug_tombstones where slug = ? limit 1",
  )
    .bind(slug)
    .first<SlugTombstone>();
  return row ?? null;
}

/**
 * Display info for a redirect target — the LIVE document a retired slug's
 * `redirect_to` points at. `null` if the public_id is malformed, unknown, or
 * revoked (a dangling redirect, which the serve path falls back to 410 on).
 *
 * Returns the target's current `slug` (so the forward can land on the pretty
 * `/s/<slug>` URL, or `/d/<public_id>` when the target has no slug) and `title`
 * (for the browser interstitial's "this now points to <title>" copy).
 */
// RedirectTarget — a retired slug's live redirect target. Defined in src/contract.ts.
export async function resolveRedirectTarget(
  env: Env,
  publicId: string,
): Promise<RedirectTarget | null> {
  if (!PUBLIC_ID_RE.test(publicId)) return null;
  // `title` joins the SERVED version (issue #43), not `current_ver`. This is
  // the one non-byte query that reaches an ANONYMOUS reader: serveRetiredSlug
  // renders this title into the redirect interstitial. Left on `current_ver` it
  // would disclose the title of an unpublished version of a public document —
  // a small channel, but the same channel pinning the shell's <title> closed,
  // and one an agent controls on every write.
  const row = await env.META.prepare(
    `select d.public_id, d.slug, v.title
       from documents d
       left join versions v on v.document_id = d.id and v.version_no = ${SERVED_VER_SQL}
      where d.public_id = ? and d.revoked_at is null
      limit 1`,
  )
    .bind(publicId)
    .first<{ public_id: string; slug: string | null; title: string | null }>();
  return row ? { public_id: row.public_id, slug: row.slug, title: row.title } : null;
}

export type SlugRedirectErr =
  // The slug is not retired — there is no tombstone to attach a redirect to.
  // (A live slug serves its own document; to repoint it, revoke or rename
  // first. A never-claimed slug isn't a redirect target either.)
  | { ok: false; code: "tombstone_not_found" }
  // The target public_id is malformed, unknown, or revoked. A redirect may only
  // point at a LIVE document — a dangling target would just 410 anyway.
  | { ok: false; code: "bad_target"; target: string };

/**
 * Operator action: point a retired slug at a (live) target document by its
 * `public_id` (migration 0010). The cross-document redirect — the deliberate,
 * loud "this name moved" case (branding/consolidation). Validates the slug is
 * actually retired and the target is live before writing. Overwrites any prior
 * redirect (including a rename auto-redirect). The slug is validated upstream.
 */
export async function setSlugRedirectCore(
  env: Env,
  slug: string,
  targetPublicId: string,
  waitUntil?: WaitUntil,
): Promise<{ ok: true; target: RedirectTarget } | SlugRedirectErr> {
  const tomb = await findSlugTombstoneCore(env, slug);
  if (!tomb) return { ok: false, code: "tombstone_not_found" };
  const target = await resolveRedirectTarget(env, targetPublicId);
  if (!target) return { ok: false, code: "bad_target", target: targetPublicId };
  await env.META
    .prepare("update slug_tombstones set redirect_to = ? where slug = ?")
    .bind(target.public_id, slug)
    .run();
  // Ledger (0020): a retired public name now points somewhere new. Anyone
  // holding an old link lands on different content — an anonymous-surface
  // change with no version row, exactly like the two above.
  recordAudit(env, waitUntil, {
    kind: "slug_redirect_set",
    principal_kind: "operator",
    document_id: target.public_id,
    slug,
  });
  return { ok: true, target };
}

/**
 * Operator action: drop a retired slug's redirect, reverting it to a plain
 * 410-Gone tombstone. No-op-safe on an already-null redirect.
 */
export async function clearSlugRedirectCore(
  env: Env,
  slug: string,
  waitUntil?: WaitUntil,
): Promise<{ ok: true } | { ok: false; code: "tombstone_not_found" }> {
  const tomb = await findSlugTombstoneCore(env, slug);
  if (!tomb) return { ok: false, code: "tombstone_not_found" };
  await env.META
    .prepare("update slug_tombstones set redirect_to = null where slug = ?")
    .bind(slug)
    .run();
  recordAudit(env, waitUntil, {
    kind: "slug_redirect_cleared",
    principal_kind: "operator",
    slug,
  });
  return { ok: true };
}

/**
 * Operator escape hatch: force-release a retired slug by deleting its tombstone
 * row entirely, returning the name to the pool so a future publish can claim it.
 * For the genuine "I revoked by mistake" / "I really do want to repurpose this
 * name" case. The ONLY path that un-retires a slug — everything else treats
 * retirement as permanent.
 */
export async function releaseSlugTombstoneCore(
  env: Env,
  slug: string,
  waitUntil?: WaitUntil,
): Promise<{ ok: true } | { ok: false; code: "tombstone_not_found" }> {
  const tomb = await findSlugTombstoneCore(env, slug);
  if (!tomb) return { ok: false, code: "tombstone_not_found" };
  await env.META.prepare("delete from slug_tombstones where slug = ?").bind(slug).run();
  // The ONLY path that un-retires a slug — 0009 otherwise treats retirement as
  // permanent — so the ledger is where "who gave this name back, and when"
  // lives once the tombstone row is gone.
  recordAudit(env, waitUntil, {
    kind: "slug_released",
    principal_kind: "operator",
    slug,
  });
  return { ok: true };
}

export type SetSlugOk = {
  ok: true;
  public_id: string;
  /** The slug after the change — the new value, or null after a clear/no-op-on-empty. */
  slug: string | null;
  /** The prior slug that was retired into a tombstone, or null if there was none. */
  retired: string | null;
  /**
   * True when the retired prior slug now auto-forwards to THIS document (a
   * rename). False on a first-time claim (nothing retired), a clear/release
   * (retired but NOT forwarded — a plain 410 tombstone), or a no-op.
   */
  redirected: boolean;
};
export type SetSlugErr =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid_slug"; reason: SlugReject }
  | { ok: false; code: "slug_taken"; slug: string }
  | { ok: false; code: "slug_retired"; slug: string };

/**
 * Operator-only: change (add / rename / clear) a LIVE document's slug WITHOUT
 * bumping a version. Slug is identity-adjacent — a property of the document, not
 * of any version's bytes — so this mirrors setDocumentVisibilityCore's
 * no-version-bump shape rather than going through the publish/update version
 * path.
 *
 * It reuses the SAME `resolveSlug` decision and `tombstoneSlug` writes the
 * agentic update path uses, so the semantics are identical by construction:
 *   - **rename** (was slug A, now B) → claim B on `documents.slug` and RETIRE A
 *     into `slug_tombstones` with `redirect_to = this document's own public_id`
 *     (migration 0010). `/s/A` then auto-forwards LOUDLY to the doc at its new
 *     name — the exact behavior an agent's `update_document` slug change gives.
 *   - **first claim** (was no slug, now B) → claim B; nothing to retire.
 *   - **clear** (`slugInput === ""`, was slug A) → set slug NULL and retire A as
 *     a plain `released` tombstone (NO redirect — a cleared name 410s).
 *   - **no-op** (same slug, or empty on an already-slugless doc) → nothing.
 *
 * Uniqueness is enforced exactly as on the write path: a slug live on another
 * document → `slug_taken`; one ever claimed and retired → `slug_retired` (slugs
 * are not reusable; the operator's `DELETE /admin/slugs/:slug` escape hatch is
 * the only un-retire path). Invalid charset → `invalid_slug`.
 *
 * No FTS sync is needed — `documents_fts` does not index the slug; the
 * list/search/serve surfaces read `documents.slug` directly.
 *
 * Targets LIVE docs only (`revoked_at IS NULL`): a revoked doc's slug is already
 * retired, so there is nothing to change → `not_found`.
 */
export async function setDocumentSlugCore(
  env: Env,
  publicId: string,
  slugInput: string,
): Promise<SetSlugOk | SetSlugErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };

  const row = await env.META.prepare(
    "select id, slug, revoked_at from documents where public_id = ?",
  )
    .bind(publicId)
    .first<{ id: string; slug: string | null; revoked_at: string | null }>();
  if (!row || row.revoked_at) return { ok: false, code: "not_found" };

  // Same decision as the publish/update path. `selfId = row.id` so a same-slug
  // submit is a no-op and the uniqueness check ignores this document's own row.
  const slugResult = await resolveSlug(env, slugInput, row.slug, row.id);
  if (!slugResult.ok) return slugResult;
  const action = slugResult.action;

  const statements: D1PreparedStatement[] = [];
  let resolvedSlug: string | null;
  let retired: string | null = null;
  let redirected = false;

  if (action.kind === "set") {
    statements.push(
      env.META.prepare(
        `update documents set slug = ?, ${TOUCH_UPDATED_AT} where id = ?`,
      ).bind(action.slug, row.id),
    );
    // Rename: retire the old name AND auto-forward it to this doc's own
    // public_id (same-document redirect, migration 0010) — identical to the
    // agentic update path. A first-time claim has retire === null.
    if (action.retire !== null) {
      statements.push(tombstoneSlug(env, action.retire, row.id, "renamed", publicId));
      retired = action.retire;
      redirected = true;
    }
    resolvedSlug = action.slug;
  } else if (action.kind === "clear") {
    statements.push(
      env.META.prepare(
        `update documents set slug = null, ${TOUCH_UPDATED_AT} where id = ?`,
      ).bind(row.id),
    );
    // Release un-publishes the name but does NOT free it — tombstoned with no
    // redirect, so `/s/<old>` 410s.
    statements.push(tombstoneSlug(env, action.retire, row.id, "released"));
    retired = action.retire;
    resolvedSlug = null;
  } else {
    // No-op — leave documents.slug untouched, and DON'T touch `updated_at`
    // either (migration 0017). Re-submitting the same slug changed nothing, so
    // surfacing it in a change feed would be a lie the caller can't distinguish
    // from a real rename.
    resolvedSlug = action.slug;
  }

  if (statements.length > 0) await env.META.batch(statements);
  return { ok: true, public_id: publicId, slug: resolvedSlug, retired, redirected };
}
