// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The served-version rule (migration 0018, GitHub issue #43) — the ONE
 * definition of "which version's bytes does a caller see".
 *
 *   For a PUBLIC document the HTML render path serves `published_ver` (the
 *   version an operator promoted) to EVERY caller. Everything else serves
 *   `current_ver`.
 *
 * This is the security boundary, not a display preference. Before 0018 the
 * render path served whatever was current, so any agent key — which may write
 * any document under the single-tenant trust model — could overwrite a public
 * document's body and publish private content to the anonymous internet without
 * ever touching the operator-only `visibility` flag. Pinning the render path to
 * an operator-promoted version is what makes "no agent action alone expands the
 * anonymous-visible byte set" true.
 *
 * It lives in its own leaf module (no runtime imports; the `Visibility` import
 * is `import type`, so it erases) because BOTH `serve.ts` and `core.ts` need it
 * and `serve.ts` already imports `core.ts` — the reverse edge would be a module
 * cycle. The alternative was a second copy in `core.ts`, and a drifted copy of
 * this particular rule is a silent anonymous-disclosure hole, which is exactly
 * the outcome that justifies a module of two exports. (`session.ts` keeps its
 * own copy of `SERVICE_DESC_LINK` for the same cycle reason; the standing
 * guidance there is "if a third copy appears, promote it to a leaf module" —
 * this is that promotion, made pre-emptively because the stakes are higher.)
 *
 * Adding a render site means routing it through one of these two exports. A
 * site left on `current_ver` is a hole, not a cosmetic inconsistency.
 */

import type { Visibility } from "./access.js";

/**
 * The rule as a SQL fragment, for callers issuing their own join.
 *
 * Interpolated into query text rather than bound, because it names columns, not
 * values: it contains no caller input at all (the string is a compile-time
 * constant), so there is nothing here to parameterize.
 *
 * Callers must alias the document table as `d`. The joins stay LEFT/INNER
 * exactly as they were: `published_ver` is only ever set to a version that
 * exists (`promoteVersionCore` verifies it, `setDocumentVisibilityCore`
 * coalesces to `current_ver`, `publishDocumentCore` binds it at birth) and
 * `versions` rows are append-only until revoke purges them, so the expression
 * cannot dangle on a live document.
 *
 * On a REVOKED document it can still resolve to a stale pointer — revoke nulls
 * `current_ver` and `published_ver` together, but a caller that queries without
 * a `revoked_at is null` guard would be joining against purged R2 keys. Every
 * caller gates on revoke first; keep it that way.
 */
export const SERVED_VER_SQL =
  "(case when d.visibility = 'public' and d.published_ver is not null then d.published_ver else d.current_ver end)";

/**
 * The same rule in TypeScript, for callers that already hold a document row
 * (`serveBySlug`'s listing row, the manage page) rather than issuing their own
 * join. Null only when `current_ver` is — i.e. a revoked document, which every
 * caller has already turned into a 404.
 */
export function servedVersion(doc: {
  visibility: Visibility;
  published_ver: number | null;
  current_ver: number | null;
}): number | null {
  return doc.visibility === "public" && doc.published_ver !== null
    ? doc.published_ver
    : doc.current_ver;
}
