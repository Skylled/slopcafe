// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Document access control — the single-tenant `can_access` primitive.
 *
 * This is the named chokepoint for "may this principal READ this document on
 * the public surface," introduced with the visibility feature (GitHub issue #7)
 * so the decision lives in one pure function instead of scattered inline checks.
 * It is the deliberately-collapsed descendant of the multi-tenant
 * `can_access(principal, document, level)` in
 * docs/design/agent-knowledge-host-spec-PLATFORM-v2.md §4.1 — same shape (top-down,
 * first-match-wins), with everything single-tenant strips away removed:
 *
 *   - no shares table / `explicit` grants (one operator, no cross-operator reads)
 *   - no projects / project grants
 *   - no soft-delete `deleted_at` gate (revoke is a hard kill, handled by the
 *     row lookup returning nothing — we keep a `revoked` belt-and-suspenders arg)
 *   - no owner-suspension / pending-deletion darkening (there is one operator)
 *
 * What's left is a two-axis model: an authenticated principal (operator, any
 * active agent key, OR a human READER holding one of `READER_TOKENS` — the
 * whole "inner circle") reads everything; an anonymous caller reads a document
 * only if it is `public`. That is the entire policy.
 *
 * DELIBERATELY NOT FOLDED IN: write authority and visibility-CHANGE authority.
 * Those stay separate operator checks (requireOperator in src/session.ts),
 * mirroring how the platform keeps admin authz OUT of `can_access` (§13.4). This
 * function governs READ on the public surface and nothing else — keep it that
 * way; when sharing/ACLs eventually grow, they extend `canRead`'s branch list,
 * they don't migrate write/admin authority into it.
 */

import { authenticateAgent } from "./auth.js";
import type { Env } from "./env.js";
import { authenticateSessionRequest } from "./session.js";

/** The per-document public/private axis (migration 0011, documents.visibility). */
export type Visibility = "public" | "private";

/**
 * Who is asking. Resolved from the request by `resolvePrincipal`. The operator,
 * any active agent, and any READER are all "inner circle" and read everything;
 * `anonymous` is the open-web browser caller the visibility gate constrains.
 *
 * `reader` is the human read-only tier (`READER_TOKENS`): it reads exactly what
 * an agent reads and can write NOTHING. It carries no id here because the
 * per-person identity exists only to scope session revocation (see
 * `deriveReaderId` in src/session.ts) — no read decision, listing, or stored row
 * has ever depended on WHICH reader is asking, and none should start.
 */
export type Principal =
  | { kind: "operator" }
  | { kind: "reader" }
  | { kind: "agent"; agentId: string }
  | { kind: "anonymous" };

/**
 * Who AUTHORED a write — the same principal vocabulary as `Principal`, narrowed
 * to the kinds that can actually write. Anonymous cannot, and neither can a
 * `reader`: excluding it HERE is what makes "a reader session can never author a
 * version" a compile-time property rather than a per-route promise — there is no
 * value of this type a reader could be widened into, so a handler that tried to
 * forward one at a write core would not typecheck. The write path in
 * src/core.ts takes this instead of a bare `agentId: string`, so the operator is
 * recorded as the distinct, tableless principal it is rather than being smuggled
 * through as a fake agent id (which is exactly what `restoreVersionCore` used to
 * do with the literal string "operator"). Storage maps it: an `agent` author
 * sets documents.created_by / versions.author_agent_id and author_kind 'agent';
 * an `operator` author leaves those agent FKs NULL and sets the kind 'operator'
 * (migration 0013). Multi-operator is the deferred seam — when it arrives this
 * widens to `{ kind: "operator"; operatorId: string }`, nothing else here moves.
 */
export type Author = Exclude<Principal, { kind: "anonymous" } | { kind: "reader" }>;

/**
 * The access decision — pure, no env, no I/O, so it's unit-testable in
 * test/access.test.mjs. Top-down, first-match-wins (PLATFORM §4.1 order):
 *
 *   1. revoked      → false   (defense-in-depth; live lookups already exclude
 *                              revoked rows, so callers usually never reach here
 *                              with revoked=true)
 *   2. operator     → true    (the single-tenant analogue of the owner shortcut)
 *   3. reader       → true    (the human read-only tier; same read reach as an
 *                              agent, zero write reach — that asymmetry lives in
 *                              the write gates, deliberately not here)
 *   4. agent        → true    (whole-fleet trust model: any active key reads all)
 *   5. anonymous    → visibility === "public"
 *
 * The anonymous branch is the ONLY place visibility matters. Deny on the public
 * surface must be rendered as the same opaque 404 a missing/revoked document
 * gives (the caller's job — see src/serve.ts), never a 401, so a private
 * document is indistinguishable from a nonexistent one (no existence oracle).
 */
export function canRead(
  principal: Principal,
  doc: { visibility: Visibility; revoked: boolean },
): boolean {
  if (doc.revoked) return false;
  if (principal.kind === "operator") return true;
  if (principal.kind === "reader") return true;
  if (principal.kind === "agent") return true;
  return doc.visibility === "public";
}

/**
 * Resolve the requesting principal from a Request. Order is operator → reader →
 * agent → anonymous, and the order is load-bearing for both correctness and
 * intent:
 *
 *   - Operator first (cookie OR bearer, via authenticateSessionRequest): the
 *     operator's browser carries the `awh_session` cookie, which reaches the
 *     same-origin iframe subresource at `/d/:id/raw` (SameSite=Lax only strips
 *     CROSS-site requests; the iframe is same-origin), so the operator can view
 *     a private document in the browser. A pasted operator Bearer also resolves
 *     here.
 *   - Reader next, from the SAME resolver: a reader-tier `awh_session` cookie
 *     (minted at /login from one of `READER_TOKENS`) or a pasted reader Bearer.
 *     Ranked below the operator because the operator strictly dominates; ranked
 *     ABOVE the agent only because both answer `true` here and the human tier is
 *     the cheaper check (no D1 round trip).
 *   - Agent next (bearer, via authenticateAgent): a programmatic caller hitting
 *     `/d/:id/raw` (or the slug surface) with its `awh_` key.
 *   - Else anonymous.
 *
 * The credential spaces can't collide: `authenticateOperator` and the reader
 * compare are constant-time compares against operator-chosen secrets, while
 * `authenticateAgent` requires the `awh_` prefix + an HMAC-under-pepper match
 * against a stored key row — so trying the session tiers first never spuriously
 * matches an agent key (and vice versa) unless the operator deliberately sets
 * one of those secrets to a live agent key, a self-inflicted misconfig. For the
 * read decision the operator/reader/agent distinction doesn't even change the
 * answer (all three → true); the order is about who we ATTRIBUTE the request to,
 * and callers that DO care about the difference (the shell's operator-only
 * publish banner, `requireCurator`'s refusal of readers) read the kind.
 */
export async function resolvePrincipal(req: Request, env: Env): Promise<Principal> {
  const session = await authenticateSessionRequest(req, env);
  if (session.ok) return session.tier === "operator" ? { kind: "operator" } : { kind: "reader" };
  const agent = await authenticateAgent(req, env);
  if (agent) return { kind: "agent", agentId: agent.agentId };
  return { kind: "anonymous" };
}

/**
 * Normalize an arbitrary string to a `Visibility`, defaulting to `"private"` on
 * anything that isn't exactly `"public"`. Used for the free-form
 * `DEFAULT_DOCUMENT_VISIBILITY` [var] and for validating the operator endpoint's
 * input. Strict on the value, lenient on the failure direction: an unrecognized
 * config value falls back to the SAFER (private) posture rather than throwing.
 */
export function parseVisibility(s: string | null | undefined): Visibility {
  return s === "public" ? "public" : "private";
}

/**
 * Birth visibility for newly published documents, read from the
 * `DEFAULT_DOCUMENT_VISIBILITY` deploy-time toggle (default "private"). Clamped
 * via `parseVisibility` so a typo (`"publik"`) can never bind an out-of-set
 * value into the documents row and 500 every publish against the 0011 CHECK
 * constraint. The write path calls this once per publish and binds the result
 * EXPLICITLY, so the column's own DEFAULT 'public' only ever covers legacy rows.
 */
export function defaultDocumentVisibility(env: Env): Visibility {
  return parseVisibility(env.DEFAULT_DOCUMENT_VISIBILITY);
}
