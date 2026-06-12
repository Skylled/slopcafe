// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// Conditional-request helpers for the render-bytes path: `GET /d/:id/raw` and
// the operator version-history `GET /d/:id/v/:n/raw`.
//
// Both endpoints already stamp a strong `ETag: "v<n>"` keyed on the document's
// version_no — the only thing that changes the rendered bytes. A content write
// bumps the version; slug/visibility/tag edits touch neither the bytes nor the
// version. That makes version_no a sound validator, so a client (the mobile
// operator app caching bytes for offline render) can send `If-None-Match` and
// get a bodyless 304 when its cache is current — skipping the R2 GET and the
// body transfer on the common "nothing changed" case.
//
// CAVEAT the caller MUST respect: the 304 short-circuit has to run AFTER the
// revoke + visibility/auth gate, never before. A 304 confirms "this id exists
// at version N"; emitting one ahead of the gate would turn a private/revoked
// doc's opaque 404 into an existence-and-version oracle. See serveRaw /
// serveVersionRaw for the placement.
//
// Validator blind spot, documented on purpose: the ETag keys on version_no
// ONLY. The Markdown reader-theme prefix and the HTML→Markdown converter are
// deploy-time, not version-tracked, so changing either does NOT bump the ETag —
// a cached client won't pick the change up for an unchanged version. Acceptable
// in v1 (nothing else revalidates; everything is `no-store`). If it ever
// matters, fold a theme/converter rev into etagForVersion (e.g. `"v7-s3"`).

/** The strong entity-tag for a document version: the quoted `"v<n>"` form. */
export function etagForVersion(versionNo: number): string {
  return `"v${versionNo}"`;
}

/**
 * Whether an `If-None-Match` request-header value means "I already hold the
 * current version" for `versionNo` — i.e. the server may answer 304.
 *
 * HTTP-correct cases: the exact strong tag `"v<n>"` (what a conformant client
 * echoes back), the wildcard `*` (matches any current representation), comma-
 * separated lists of candidates, and the weak `W/"v<n>"` form (`If-None-Match`
 * uses the weak comparison function, so a `W/` prefix is ignored). Plus two
 * harmless first-party tolerances — a bare `v<n>` or `<n>` — in case a client
 * sends the version unquoted. A null/empty/absent header never matches.
 */
export function ifNoneMatchSatisfied(headerValue: string | null, versionNo: number): boolean {
  if (!headerValue) return false;
  const strong = `"v${versionNo}"`;
  for (const candidate of headerValue.split(",")) {
    let tag = candidate.trim();
    if (tag === "*") return true; // wildcard matches any existing representation
    if (tag.startsWith("W/")) tag = tag.slice(2).trim(); // weak comparison: drop W/
    if (tag === strong || tag === `v${versionNo}` || tag === String(versionNo)) return true;
  }
  return false;
}

/**
 * Parse an `If-Match` REQUEST-header value for the write path (`PUT /d/:id` and
 * the operator `PUT /admin/documents/:id`) into one of:
 *   { kind: "any" }        - the `*` wildcard (skip the precondition)
 *   { kind: "version", v } - a specific version the caller expects to replace
 *   { kind: "invalid" }    - anything else (multi-tag list, weak tag, garbage)
 *
 * We only ever ISSUE the strong tag `"v<n>"`, so that's the canonical form. But
 * we ACCEPT four equivalent spellings of "version n", because a hand-built
 * header (the byte-exact `curl PUT` path) commonly carries one of the looser
 * forms: the quoted strong tag `"v<n>"`, the unquoted `v<n>`, the bare integer
 * `<n>` (what an agent primed by the integer `version`/`current_version` field
 * of a read response naturally sends — GitHub issue #32), and the quoted bare
 * integer `"<n>"`. This mirrors the read-side `ifNoneMatchSatisfied` tolerances
 * so both conditional surfaces accept the same shapes. A balanced pair of outer
 * double-quotes is stripped first; multi-tag lists and weak (`W/`) tags stay
 * unsupported (→ `invalid`).
 */
export function parseIfMatch(
  headerValue: string,
): { kind: "any" } | { kind: "version"; v: number } | { kind: "invalid" } {
  let tag = headerValue.trim();
  if (tag === "*") return { kind: "any" };
  // Strip one balanced pair of surrounding double-quotes ("v5" / "5"), then
  // accept an optional `v` prefix on the bare digits (v5 / 5).
  if (tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"')) {
    tag = tag.slice(1, -1).trim();
  }
  const m = /^v?(\d+)$/.exec(tag);
  if (!m) return { kind: "invalid" };
  return { kind: "version", v: parseInt(m[1]!, 10) };
}
