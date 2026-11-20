// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth 2.1 wrapper around the worker. Hosts the Door A path for /mcp:
 * hosted Claude / Cowork / ChatGPT use authorization-code + PKCE through this
 * provider; we issue an access token whose `props.agentId` + `props.clientId`
 * let MCP tool handlers stamp provenance identically to Door B (plus per-client
 * attribution on Door A).
 *
 *   GET  /.well-known/oauth-authorization-server   served by provider
 *   GET  /.well-known/oauth-protected-resource     served by provider
 *   POST /token                                    served by provider
 *   POST /register                                 served by provider (DCR; only when ENABLE_DCR)
 *   GET|POST /authorize                            served by defaultHandler (src/authorize.ts)
 *   *  /mcp with valid Door A token                routed to apiHandler with ctx.props
 *   *  everything else (incl. /mcp with awh_ bearer or no token) → defaultHandler
 *
 * Per the plan (Step 9 §Risks) we do NOT use `tokenExchangeCallback`:
 *   - It has no env access, so it can't query D1 for agent liveness.
 *   - `OAUTH_PROVIDER.deleteClient(client_id)` cascades and invalidates
 *     live tokens immediately via OAUTH_KV — that's the synchronous fail-
 *     closed path called from revokeAgent / deleteOAuthClient.
 *   - `accessTokenTTL: 86_400` (24h) bounds blast radius if a deleteClient
 *     call ever partial-fails while cutting refresh churn and `audit_events`
 *     `token_issued` volume by ~96× compared to 15 min.
 *   - `refreshTokenTTL: undefined` issues non-expiring rotating refresh
 *     tokens (bringing Door A to parity with static `awh_` keys while
 *     staying strictly safer: audience-bound per RFC 8707, rotated on
 *     refresh, and version-attributed via `versions.author_client_id`).
 *   - `clientRegistrationTTL: undefined` prevents the 90-day client ceiling
 *     and `updateClient()` TTL overwrite; abandoned unbound DCR registrations
 *     are swept via `POST /admin/oauth-clients/prune`.
 *
 * Audience binding is automatic per RFC 8707 — the AuthRequest carries a
 * `resource` parameter and the library enforces strict exact matching
 * (`resourceMatchOriginOnly` defaults to false).
 */

import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { authenticateAgent } from "./auth.js";
import type { Env } from "./env.js";
import type { AwhProps } from "./mcp-auth.js";
import {
  DCR_REGISTRATION_ENDPOINT,
  OAUTH_PROVIDER_STATIC_OPTIONS,
  TOKEN_ENDPOINT,
} from "./oauth-config.js";

export { DCR_REGISTRATION_ENDPOINT, TOKEN_ENDPOINT };

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

    ...OAUTH_PROVIDER_STATIC_OPTIONS,

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
      // clientId is null by construction (migration 0019 / issue #63): a static
      // `awh_` key is not an OAuth grant and has no client_id to attribute. The
      // versions row records the NULL honestly rather than inventing a
      // placeholder — `via` plus a non-null author_agent_id is what tells a
      // reader "this was Door B", not a sentinel client id.
      const props: AwhProps = { agentId: auth.agentId, clientId: null, via: "bearer" };
      return { props };
    },
  });
}
