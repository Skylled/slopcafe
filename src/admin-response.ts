// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON error envelope shared by every operator/reader JSON handler
 * (src/admin-agents.ts, src/admin-documents.ts, src/admin-slugs.ts,
 * src/admin-maintenance.ts). Split out of the former src/admin.ts as a pure
 * move (issue #72, phase 4) so the four resource modules share ONE copy of the
 * envelope and of the opaque document 404 instead of each re-hand-listing them.
 *
 * Invariants:
 *   - every JSON error carries the RFC 8631 `service-desc` Link header
 *     (`SERVICE_DESC_LINK`, src/serve-policy.ts) so a lost caller learns where
 *     `/openapi.json` is from any failure;
 *   - `documentNotFound`'s message is derived ONLY from the caller's own path
 *     segment (`idShapeHint`) — never from a lookup — so it is exactly as
 *     opaque as a bare "no such document".
 */

import { idShapeHint, SERVICE_DESC_LINK } from "./serve-policy.js";

/**
 * The admin/reader JSON error envelope. Carries the `service-desc` Link header
 * (SERVICE_DESC_LINK in serve-policy.ts) like every other JSON error surface, so a
 * caller that only ever sees a failure still learns where `/openapi.json` is.
 */
export function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: code, message, ...extra },
    { status, headers: { link: SERVICE_DESC_LINK } },
  );
}

/**
 * The `404 not_found` every document-addressed admin handler returns.
 *
 * The message carries the one hint a wrong-shaped id can safely give (see
 * `idShapeHint` in serve-policy.ts): a SLUG in the `:public_id` slot is by far the
 * commonest way to land here — every document in the corpus is named by its
 * slug in links and prose — and `GET /d?slug=…` is the conversion. Purely
 * syntactic, derived from the caller's own path segment and never from anything
 * we looked up, so it is exactly as opaque as the bare "no such document" it
 * replaced.
 */
export function documentNotFound(publicId: string): Response {
  // No slug-addressed twin exists for any /admin/documents/:id route, so the
  // resolver is the only alternative worth naming.
  return jsonError(404, "not_found", idShapeHint(publicId, () => null));
}

/**
 * The `403 read_only_agent` every agent-door write returns when
 * `WRITER_AGENT_IDS` is configured and this agent is not on it (insight fork).
 *
 * 403, not 401: the credential AUTHENTICATED fine — retrying with it, or minting
 * a fresh key for the same agent, changes nothing, and a 401 would send a client
 * into exactly that loop. The message names the id and the only real remedy
 * (an operator config change) so an agent stops rather than retrying, and echoes
 * `agent_id` as a context field for a machine client.
 *
 * Shared by `POST /d`, `PUT /d/:id` (src/index.ts), `PUT /d/:id/tags` and
 * `PUT /d/:id/status` (src/admin-documents.ts).
 */
export function readOnlyAgent(agentId: string): Response {
  return jsonError(
    403,
    "read_only_agent",
    `agent ${agentId} is not on this deployment's WRITER_AGENT_IDS allowlist, so it may ` +
      "READ the corpus but not write to it. This is deployment configuration, not a bad " +
      "credential — retrying, or minting a new key for the same agent, will not help. Ask " +
      "the operator to add this agent id if it is meant to publish here.",
    { agent_id: agentId },
  );
}
