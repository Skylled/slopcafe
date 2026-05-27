/**
 * OAuth 2.1 wrapper around the worker. Hosts the Door A path for /mcp:
 * hosted Claude / Cowork uses authorization-code + PKCE through this
 * provider; we issue a short-lived access token whose `props.agentId`
 * lets MCP tool handlers stamp provenance identically to Door B.
 *
 *   GET  /.well-known/oauth-authorization-server   served by provider
 *   GET  /.well-known/oauth-protected-resource     served by provider
 *   POST /token                                    served by provider
 *   GET|POST /authorize                            served by defaultHandler (src/authorize.ts)
 *   *  /mcp with valid Door A token                routed to apiHandler with ctx.props
 *   *  everything else (incl. /mcp with awh_ bearer or no token) → defaultHandler
 *
 * Per the plan (Step 9 §Risks) we do NOT use `tokenExchangeCallback`:
 *   - It has no env access, so it can't query D1 for agent liveness.
 *   - `OAUTH_PROVIDER.deleteClient(client_id)` cascades and invalidates
 *     live tokens immediately via OAUTH_KV — that's the synchronous fail-
 *     closed path called from revokeAgent.
 *   - `accessTokenTTL: 900` (15 min) is defense in depth if a deleteClient
 *     call ever partial-fails.
 *
 * Audience binding is automatic per RFC 8707 — the AuthRequest carries a
 * `resource` parameter and the library enforces strict exact matching
 * (`resourceMatchOriginOnly` defaults to false).
 */

import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { authenticateAgent } from "./auth.js";
import type { Env } from "./env.js";
import type { AwhProps } from "./mcp-auth.js";

/** 15 minutes — short enough that any missed deleteClient still expires fast. */
const ACCESS_TOKEN_TTL_SECONDS = 900;

/**
 * Wrap an inner worker handler with the OAuthProvider so /mcp gains Door A
 * (and /token + discovery endpoints + /authorize routing). The inner
 * handler is registered for BOTH apiHandler and defaultHandler so a single
 * fetch implementation owns all routes; the only difference between the
 * two paths is whether `ctx.props.agentId` is populated.
 */
export function wrapWithOAuth(inner: ExportedHandler<Env>): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    // /mcp + valid OAuth token → apiHandler (ctx.props set).
    // /mcp without a valid OAuth token → defaultHandler (which tries Door B).
    apiRoute: "/mcp",
    apiHandler: inner as OAuthProviderOptions<Env>["apiHandler"],
    defaultHandler: inner,

    // /authorize is implemented by our defaultHandler (src/authorize.ts);
    // the URL here is only used in OAuth metadata.
    authorizeEndpoint: "/authorize",
    // /token is served by the provider itself.
    tokenEndpoint: "/token",

    // No DCR — pre-registration only via POST /admin/agents/:id/oauth-clients.
    // Setting clientRegistrationEndpoint to undefined disables the public endpoint.

    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,

    // OAuth 2.1 + PKCE: refuse the deprecated plain method.
    allowPlainPKCE: false,

    // Only one scope today: agent verbs (publish/update/read/list).
    scopesSupported: ["agent"],

    // Door B (static `awh_` bearer) lives here. The provider intercepts
    // EVERY /mcp request — apiRoute is total — so handing it Door B as an
    // `externalToken` callback is the only way to keep the static-bearer
    // path working. Returning props pins the agent identity for this
    // request; the provider then calls apiHandler with ctx.props set,
    // matching the OAuth path's shape.
    //
    // Audience: deliberately unset. The awh_ token is not per-resource;
    // any active key can hit /mcp under this operator.
    resolveExternalToken: async ({ token, request, env }) => {
      // Reconstruct a Request that just carries the Authorization so we
      // can reuse the existing authenticateAgent (HMAC-under-pepper +
      // revoked_at check) verbatim — the same path POST /d uses.
      const synth = new Request(request.url, {
        headers: { authorization: `Bearer ${token}` },
      });
      const auth = await authenticateAgent(synth, env as Env);
      if (!auth) return null;
      const props: AwhProps = { agentId: auth.agentId, via: "bearer" };
      return { props };
    },
  });
}
