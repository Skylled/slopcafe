/**
 * Dual-door auth resolver for the /mcp surface.
 *
 *   Door A (OAuth)        — hosted Claude / Cowork. Wired in Step 9 via
 *                            workers-oauth-provider; reads ctx.props set
 *                            at completeAuthorization() time. For now this
 *                            branch is a stub and always falls through.
 *
 *   Door B (static bearer) — Gemini, curl, any script. Reuses the existing
 *                            authenticateAgent() so the HMAC+pepper+revoked_at
 *                            check is identical across surfaces.
 *
 * Either door yields an `agents.id`; the MCP tool handlers stamp it as
 * `documents.created_by` exactly as POST /d does today. No agent_id → 401
 * with an OAuth WWW-Authenticate challenge so a hosted client knows to
 * start the OAuth dance.
 */

import { authenticateAgent } from "./auth.js";
import type { Env } from "./env.js";

/**
 * The identity behind a /mcp request, regardless of which door it came in
 * through. Plumbed into the MCP layer via createMcpHandler's authContext
 * and read by tool handlers via getMcpAuthContext().
 *
 * The shape is mirrored as the OAuth `props` payload in Step 9's
 * completeAuthorization() call so both doors produce identical shapes.
 */
export type AwhProps = {
  agentId: string;
  via: "oauth" | "bearer";
};

/**
 * Resolve a /mcp request to an agent identity, or null. Door A first (when
 * wired), then Door B. Never throws — a thrown error here would surface as
 * an unhandled 500 instead of the intended 401.
 */
export async function resolveMcpAuth(req: Request, env: Env): Promise<AwhProps | null> {
  // Door A — wired in Step 9. When workers-oauth-provider wraps the
  // worker, it validates the incoming bearer and sets ctx.props before
  // calling the inner fetch. We'd read it here. Until then, fall through.
  // TODO(step-9): read agentId from ctx.props once the OAuth provider is mounted.

  // Door B — static `awh_` bearer. Existing HMAC-under-pepper path.
  const agentAuth = await authenticateAgent(req, env);
  if (agentAuth) return { agentId: agentAuth.agentId, via: "bearer" };

  return null;
}

/**
 * Build the WWW-Authenticate challenge for a 401 on /mcp. RFC 6750 Bearer
 * scheme with as_uri pointing at the discovery doc so a spec-compliant
 * client can start the OAuth flow. In Step 8 the discovery endpoint
 * doesn't exist yet; a hosted Claude client still sees a clean, parseable
 * challenge — just no provider to talk to, which is the right pre-Step-9
 * failure mode.
 */
export function buildWwwAuthenticate(req: Request): string {
  const origin = new URL(req.url).origin;
  return [
    `Bearer realm="agent-web-host"`,
    `as_uri="${origin}/.well-known/oauth-authorization-server"`,
    `resource="${origin}/mcp"`,
  ].join(", ");
}
