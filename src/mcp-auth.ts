// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The shape of the agent identity surfaced to MCP tool handlers, in one
 * place so oauth.ts, authorize.ts, mcp.ts, and index.ts agree on it.
 *
 * Both auth doors converge on this shape:
 *
 *   Door A (OAuth)        — Set by src/authorize.ts at completeAuthorization
 *                            time; the OAuthProvider decrypts the grant's
 *                            encryptedProps on each request and injects
 *                            them as ctx.props before calling apiHandler.
 *
 *   Door B (static awh_)  — Set by src/oauth.ts's resolveExternalToken
 *                            callback after the existing authenticateAgent
 *                            check succeeds.
 *
 * The /mcp dispatch in src/index.ts trusts whatever shape the provider
 * hands it — ctx.props is always populated by the time apiHandler fires. It
 * gates on `agentId` alone; `clientId` is attribution that rides along and is
 * legitimately null on Door B (see the field comment).
 */
export type AwhProps = {
  agentId: string;
  /**
   * The OAuth `client_id` that minted this grant, or null when there isn't one
   * (migration 0019 / GitHub issue #63).
   *
   *   Door A (`via: "oauth"`)  — the client_id of the authorization request the
   *                              operator approved, read from the
   *                              PROVIDER-VALIDATED `authReq`, at the same point
   *                              `agentId` is re-derived from the oauth_clients
   *                              binding. NEVER from a form field: the consent
   *                              form is attacker-influenced, the parsed
   *                              authorization request is not.
   *   Door B (`via: "bearer"`) — always null. A static `awh_` key has no OAuth
   *                              client; there is nothing to attribute.
   *
   * Purely attributive — it is stamped onto `versions.author_client_id` so two
   * clients bound to one agent stop being indistinguishable in the audit trail.
   * It grants nothing and gates nothing: `agentId` remains the sole identity
   * every tool handler authorizes against.
   */
  clientId: string | null;
  via: "oauth" | "bearer";
};
