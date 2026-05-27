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
 * hands it — ctx.props is always populated by the time apiHandler fires.
 */
export type AwhProps = {
  agentId: string;
  via: "oauth" | "bearer";
};
