// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Classification mutators — the no-version-bump writes that change what a
 * document IS without changing a byte: visibility (0011), promotion (0018),
 * status (0014) and tags (0012).
 *
 * Key invariants:
 *   - None of these bumps a version or touches R2/FTS; every one stamps
 *     `updated_at` (`TOUCH_UPDATED_AT`) so change feeds see it.
 *   - Visibility and promotion are OPERATOR-ONLY at the call sites (the
 *     boundary between fleet-private and anonymous-readable); tags and status
 *     are agent-reachable too. That line is enforced by the doors, not here.
 *   - `setDocumentVisibilityCore` runs `published_ver = coalesce(published_ver,
 *     current_ver)` in the SAME statement as the flip — the 0018 invariant
 *     `public ⇒ published_ver IS NOT NULL`.
 *   - `promoteVersionCore` moves `published_ver` and NOTHING else; allowed on a
 *     private doc (staging before the door opens).
 */

import type { Visibility } from "./access.js";
import { recordAudit } from "./audit.js";
import { serializeTags, TOUCH_UPDATED_AT } from "./document-listing.js";
import { resolveRedirectTarget } from "./document-slug.js";
import type { Env } from "./env.js";
import { PUBLIC_ID_RE } from "./ids.js";
import { sanitizeTagsInput } from "./metadata.js";
import type { WaitUntil } from "./vector-io.js";
import type { DocumentStatus } from "./contract.js";

export type SetVisibilityOk = { ok: true; public_id: string; visibility: Visibility };
export type SetVisibilityErr =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid_visibility" };

/**
 * Operator-only: set a live document's visibility (migration 0011). Reversible,
 * no version bump, no tombstone — visibility is identity-adjacent (a property of
 * the document, like slug), not of any version's bytes. Validates the value
 * against the legal set before writing (the DB CHECK is the backstop; this
 * gives a clean `invalid_visibility` rather than a thrown constraint error).
 *
 * Targets LIVE docs only (`revoked_at IS NULL`): a revoked doc serves no bytes,
 * so flipping its visibility is meaningless → `not_found`. A no-op set
 * (public→public) still matches the row and returns ok (SQLite counts a matched
 * UPDATE row as a change), so the operator endpoint is idempotent.
 *
 * Going PUBLIC also settles what the open door leads to (migration 0018, issue
 * #43): `published_ver` is filled in the SAME statement, so a document can never
 * sit public with nothing published. See the coalesce below for which version
 * wins.
 *
 * Authority lives at the caller (requireOperator in admin.ts), NOT in
 * `can_access` — visibility-change is operator-only and deliberately kept out
 * of the read decision (see src/access.ts).
 */
export async function setDocumentVisibilityCore(
  env: Env,
  publicId: string,
  visibility: string,
  waitUntil?: WaitUntil,
): Promise<SetVisibilityOk | SetVisibilityErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  if (visibility !== "public" && visibility !== "private") {
    return { ok: false, code: "invalid_visibility" };
  }
  // `coalesce(published_ver, current_ver)` on the way public, in this one
  // statement so the two columns can't disagree even for an instant:
  //   - already promoted → the operator's staged choice SURVIVES (staging a
  //     version while the doc is still private is the whole point of being able
  //     to promote a private doc at all — see promoteVersionCore).
  //   - never promoted → publish what is CURRENT, which is exactly the pre-0018
  //     behavior (going public showed the latest bytes) and keeps the flip a
  //     one-step action rather than a two-step trap.
  // Going PRIVATE deliberately leaves `published_ver` ALONE: a private doc
  // renders current_ver regardless, so clearing it would only lose the choice on
  // a private↔public round trip.
  const result = await env.META.prepare(
    visibility === "public"
      ? `update documents set visibility = ?, published_ver = coalesce(published_ver, current_ver), ${TOUCH_UPDATED_AT} where public_id = ? and revoked_at is null`
      : `update documents set visibility = ?, ${TOUCH_UPDATED_AT} where public_id = ? and revoked_at is null`,
  )
    .bind(visibility, publicId)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return { ok: false, code: "not_found" };
  // Ledger (0020): the flip between fleet-private and anonymously readable is
  // the largest read-boundary change a document can undergo short of revoke,
  // and it leaves no version row behind to record it.
  recordAudit(env, waitUntil, {
    kind: "document_visibility_changed",
    principal_kind: "operator",
    document_id: publicId,
    visibility,
  });
  return { ok: true, public_id: publicId, visibility };
}

export type PromoteOk = { ok: true; public_id: string; published_ver: number };
export type PromoteErr =
  | { ok: false; code: "not_found" }
  // The document is live but carries no such version. Distinct from `not_found`
  // so the caller can say "that document exists, that version doesn't" — the
  // same split restoreVersionCore and the version-pinned reads already use.
  | { ok: false; code: "version_not_found" };

/**
 * Operator-only: choose WHICH version a public document renders (migration
 * 0018, GitHub issue #43) — the promote half of the published/current split.
 *
 * The problem it closes: any active agent key can overwrite any live document
 * (the single-tenant trust model), and some documents are `public`. With one
 * version pointer, "the bytes an agent just wrote" and "the bytes the anonymous
 * internet reads" are the same thing — so an agent can move private content onto
 * a public address in a single write. Splitting the pointers means an agent's
 * write always lands as a new CURRENT version (visible to every credentialed
 * surface, editable, searchable, indexed) while a public document's HTML byte
 * path keeps serving the version an OPERATOR promoted. Staged is not published.
 *
 * `published_ver` is nullable and means exactly "nothing is published" — the
 * same presence-flag posture as the 0008/0015 source columns, not a default to
 * be papered over. The serving rule itself lives at the render path: a public
 * doc with a non-NULL `published_ver` serves THAT version to every caller —
 * anonymous, agent and operator alike, so the operator sees what the world sees
 * — and a private doc always renders `current_ver`. Every credentialed/machine
 * surface (/text, /source, /links, the MCP reads, search, packs, FTS, vectors,
 * the link graph) stays on `current_ver`, unchanged: the split governs the
 * public BYTE path and nothing else.
 *
 * Classification, not content: no version bump, no FTS write, no vector sync, no
 * tombstone — promoting moves a pointer, exactly like the visibility/tags/status
 * mutators, and stamps `updated_at` for the same reason they do (a change feed
 * must see it; nothing else records that it happened).
 *
 * Deliberately allowed on PRIVATE documents: staging the choice before the door
 * opens is a feature, not a loophole — it takes effect the moment visibility
 * flips, because setDocumentVisibilityCore preserves an already-staged pointer
 * rather than overwriting it with current.
 *
 * Targets LIVE docs only (`revoked_at IS NULL`): a revoked doc renders nothing,
 * so promoting into it is meaningless → `not_found`. Authority lives at the
 * caller (requireOperator in admin.ts / the manage-page form ladder): deciding
 * what the anonymous internet reads is the same KIND of authority as
 * `visibility` itself, so it never reaches the agent door.
 */
export async function promoteVersionCore(
  env: Env,
  publicId: string,
  versionNo: number,
  waitUntil?: WaitUntil,
): Promise<PromoteOk | PromoteErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  // A non-integer / non-positive version can never name a row, so reject it as
  // the miss it is rather than binding a NaN into the lookup below.
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    return { ok: false, code: "version_not_found" };
  }

  // One query answers both questions: the LEFT JOIN means a LIVE document with
  // no such version still comes back (with a NULL version_no), which is what
  // separates "no such document" from "no such version" without a second trip.
  const row = await env.META.prepare(
    `select d.id, v.version_no
     from documents d
     left join versions v on v.document_id = d.id and v.version_no = ?
     where d.public_id = ? and d.revoked_at is null`,
  )
    .bind(versionNo, publicId)
    .first<{ id: string; version_no: number | null }>();
  if (!row) return { ok: false, code: "not_found" };
  if (row.version_no === null) return { ok: false, code: "version_not_found" };

  // Re-assert `revoked_at is null` on the write: a revoke committing between the
  // lookup and here must win (it is the kill switch), and a zero-change UPDATE
  // is how we notice. Idempotent otherwise — re-promoting the version that is
  // already published matches the row and returns ok, like every other mutator
  // in this section.
  const result = await env.META.prepare(
    `update documents set published_ver = ?, ${TOUCH_UPDATED_AT} where id = ? and revoked_at is null`,
  )
    .bind(versionNo, row.id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return { ok: false, code: "not_found" };
  // Ledger (0020): which bytes the anonymous internet is served. Like the
  // visibility flip, it bumps no version, so the ledger is the only place a
  // promotion is durably recorded as an ACT rather than as a column value.
  recordAudit(env, waitUntil, {
    kind: "document_promoted",
    principal_kind: "operator",
    document_id: publicId,
    version: versionNo,
  });
  return { ok: true, public_id: publicId, published_ver: versionNo };
}

export type SetStatusOk = {
  ok: true;
  public_id: string;
  status: DocumentStatus;
  /** The stored replacement pointer after the change (null unless deprecated with a successor). */
  superseded_by: string | null;
};
export type SetStatusErr =
  | { ok: false; code: "not_found" }
  // The status value isn't settable: not in the enum, or the reserved
  // "archived" (pinned in the CHECK for a future migration-free wiring, but
  // no surface honors it in v1 — letting it be SET with undefined behavior
  // would be a silent trap).
  | { ok: false; code: "invalid_status" }
  // superseded_by is malformed, names no live document, or points at the
  // document itself. Mirrors the slug-redirect target validation (same loud
  // single-hop contract).
  | { ok: false; code: "bad_target"; target: string };

/**
 * Set a LIVE document's lifecycle status (migration 0014) WITHOUT bumping a
 * version. Reachable from THREE doors — operator
 * `POST /admin/documents/:id/status`, agent `PUT /d/:id/status`, and the MCP
 * `set_document_status` tool — so this is an "operator mutator" by history, not
 * by gate. Status is classification — like tags (0012) and
 * slug (0005), a property of the document's place in the collection, not of
 * any version's bytes — so this mirrors setDocumentVisibilityCore /
 * setDocumentTagsCore's no-version-bump shape.
 *
 * v1 wires `active` and `deprecated`; `archived` is reserved in the DB CHECK
 * and REJECTED here (`invalid_status`) until its hide-from-default-search
 * behavior is actually built — a settable state with no wired semantics would
 * be a silent trap.
 *
 * `supersededBy` is the optional replacement pointer for a deprecated doc (a
 * target `public_id` — the document-level analogue of
 * slug_tombstones.redirect_to). FULL-REPLACE semantics per call, like tags:
 * the supplied value (or its absence) becomes the stored value outright.
 * Validated when present: must name a LIVE document (`resolveRedirectTarget`)
 * and must not be the document itself (`bad_target` either way) — single-hop
 * by construction, since the stored value is a public_id, never a chain.
 * Setting status back to `active` forces the pointer NULL regardless of input
 * (an active doc has no replacement).
 *
 * Targets LIVE docs only (`revoked_at IS NULL`): a revoked doc is already
 * terminally gone — deprecating it is meaningless → `not_found`. Idempotent on
 * a no-op set. Authority lives at the caller, deliberately NOT in `canRead` —
 * status never gates read access anywhere; it only marks hits and filters packs.
 * Callers now span both doors: the operator's POST /admin/documents/:id/status
 * and manage-page form, plus the agent-reachable `PUT /d/:id/status`
 * (requireReader) and the MCP `set_document_status` tool — same reasoning as
 * tags, since status marks currency without reaching an anonymous surface.
 */
export async function setDocumentStatusCore(
  env: Env,
  publicId: string,
  statusInput: string,
  supersededByInput?: string | null,
): Promise<SetStatusOk | SetStatusErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  if (statusInput !== "active" && statusInput !== "deprecated") {
    return { ok: false, code: "invalid_status" };
  }
  const status: DocumentStatus = statusInput;

  // Resolve the pointer BEFORE the write. Active forces null; an absent/empty
  // input on deprecate is an explicit "no successor" (full-replace, like tags).
  let supersededBy: string | null = null;
  if (status === "deprecated" && supersededByInput) {
    if (supersededByInput === publicId) {
      return { ok: false, code: "bad_target", target: supersededByInput };
    }
    const target = await resolveRedirectTarget(env, supersededByInput);
    if (!target) return { ok: false, code: "bad_target", target: supersededByInput };
    supersededBy = target.public_id;
  }

  const result = await env.META.prepare(
    `update documents set status = ?, superseded_by = ?, ${TOUCH_UPDATED_AT} where public_id = ? and revoked_at is null`,
  )
    .bind(status, supersededBy, publicId)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return { ok: false, code: "not_found" };
  return { ok: true, public_id: publicId, status, superseded_by: supersededBy };
}

export type SetTagsOk = { ok: true; public_id: string; tags: string[] };
export type SetTagsErr = { ok: false; code: "not_found" };

/**
 * Replace a LIVE document's tags WITHOUT bumping a version (migration 0012).
 * Reachable from THREE doors — operator `POST /admin/documents/:id/tags`, agent
 * `PUT /d/:id/tags`, and the MCP `set_document_tags` tool — so this is an
 * "operator mutator" by history, not by gate. Tags are document-level
 * classification — a property of the
 * document's place in the collection, not of any version's bytes — so this
 * mirrors setDocumentVisibilityCore / setDocumentSlugCore's no-version-bump
 * shape rather than the publish/update version path. This is the librarian's
 * primary write verb (the curation pass retags without churning content).
 *
 * FULL replacement, not a merge: the supplied list becomes the document's tags
 * outright; `[]` clears them (stored NULL via serializeTags). Input runs through
 * the same `sanitizeTagsInput` (charset strip, dedupe, count cap) and
 * `serializeTags` shape as the write path, so the stored bytes are identical to
 * what publish/update would store and `parseStoredTags` / the `?tags=` filter
 * read them back unchanged.
 *
 * No FTS sync is needed — since 0012 `documents_fts` does not index tags; the
 * list/search surfaces read `documents.tags` directly and the `?tags=` filter
 * is a LIKE on that column, never FTS.
 *
 * Targets LIVE docs only (`revoked_at IS NULL`): a revoked doc serves nothing,
 * so retagging it is meaningless → `not_found`. A no-op set still matches the
 * row and returns ok (SQLite counts a matched UPDATE as a change), so the
 * endpoint is idempotent.
 *
 * Authority lives at the caller, NOT in `canRead` — deliberately kept out of the
 * read decision (mirrors visibility/slug; see src/access.ts). That caller is no
 * longer only the operator: `PUT /d/:id/tags` (requireReader) and the MCP
 * `set_document_tags` tool put this on the agent door too, because tags are a
 * fleet-internal filter that reaches no anonymous surface — an agent key that
 * can replace a document's whole CONTENT grants strictly more. `visibility` and
 * publication stayed operator-only for exactly the inverse reason.
 */
export async function setDocumentTagsCore(
  env: Env,
  publicId: string,
  tagsInput: unknown,
): Promise<SetTagsOk | SetTagsErr> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "not_found" };
  const tags = sanitizeTagsInput(tagsInput);
  const result = await env.META.prepare(
    `update documents set tags = ?, ${TOUCH_UPDATED_AT} where public_id = ? and revoked_at is null`,
  )
    .bind(serializeTags(tags), publicId)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return { ok: false, code: "not_found" };
  return { ok: true, public_id: publicId, tags };
}
