/**
 * OAuth 2.1 wrapper around the worker. Hosts the Door A path for /mcp:
 * hosted Claude / Cowork uses authorization-code + PKCE through this
 * provider; we issue a short-lived access token whose `props.agentId`
 * lets MCP tool handlers stamp provenance identically to Door B.
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
 * Dynamic Client Registration (DCR, RFC 7591) toggle. **Default: on.**
 *
 * When true, the provider exposes a public POST {@link DCR_REGISTRATION_ENDPOINT}
 * (advertised as `registration_endpoint` in the OAuth discovery metadata) so a
 * connector handed only the MCP URL — no client_id — can self-register. That is
 * what makes the "just paste the URL" connect flow work for Claude / ChatGPT.
 * A self-registered client writes NO `oauth_clients` D1 row, so it lands in the
 * existing *unbound* → bind-or-mint-at-consent path (src/authorize.ts) unchanged:
 * the agent is still chosen at the operator-gated consent screen, so DCR confers
 * no authority — it only removes the manual client_id paste.
 *
 * To DISABLE (revert to pre-registration-only via POST /admin/oauth-clients or
 * POST /admin/agents/:id/oauth-clients): set this to `false` and redeploy — none
 * of the DCR options below are then passed, so `clientRegistrationEndpoint` stays
 * undefined and the public endpoint disappears.
 *
 * Why a build-time constant and not a [var]/secret: the provider is constructed at
 * module-init (`export default wrapWithOAuth(...)` in src/index.ts), before `env`
 * exists, so there is no runtime env to read here. Toggling a [var] also requires a
 * redeploy, so the constant costs nothing extra while keeping this security-relevant
 * switch right next to the config it gates.
 */
const ENABLE_DCR = true;

/** DCR endpoint path. Advertised as `registration_endpoint` in OAuth metadata. */
const DCR_REGISTRATION_ENDPOINT = "/register";

/**
 * Lifetime of a DYNAMICALLY-registered client, in seconds. **90 days.**
 *
 * Listed explicitly even though the library default is also 90 days, so the value
 * is discoverable and one-line-changeable here rather than buried in the dependency.
 *
 * IMPORTANT — this is an ABSOLUTE expiry measured from registration time, NOT a
 * sliding/last-used window. Normal token refresh reads the client record but never
 * re-writes its KV TTL (only an explicit `updateClient` does), so a connector used
 * every single day still hits this ceiling 90 days after first connect; the next
 * token refresh then 401s `invalid_client` ("Client not found") and the user must
 * re-authenticate. (Contrast `ACCESS_TOKEN_TTL_SECONDS` above and the provider's
 * refresh-token TTL, both of which DO slide on use.)
 *
 * Tuning: set to `undefined` for never-expire (DCR clients must then be GC'd by hand
 * via DELETE /admin/oauth-clients/:client_id); SHORTER values force more frequent
 * re-auth of even actively-used connectors and are usually not what you want. For a
 * PERMANENT connector that must never do the 90-day dance, don't use DCR at all —
 * mint a client via POST /admin/oauth-clients (createClient), which is immune to
 * this TTL — and paste its client_id. See dcr-design.md.
 */
const DCR_CLIENT_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

/**
 * Confidential-only DCR. When true, a registration requesting
 * `token_endpoint_auth_method: "none"` (a secretless *public* client) is rejected
 * with `invalid_client_metadata`. Claude's and ChatGPT's connectors register as
 * confidential anyway, so this costs them nothing and removes a weaker client
 * category we don't use. It does NOT gate WHO may register (DCR is open by design —
 * that's the consent gate's job); it only constrains what KIND of client results.
 */
const DISALLOW_PUBLIC_CLIENT_REGISTRATION = true;

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

    // Dynamic Client Registration (RFC 7591). Spread the DCR options in ONLY when
    // ENABLE_DCR is set — leaving `clientRegistrationEndpoint` undefined is what
    // disables the public endpoint (pre-registration-only). See the constant docs.
    ...(ENABLE_DCR
      ? {
          clientRegistrationEndpoint: DCR_REGISTRATION_ENDPOINT,
          clientRegistrationTTL: DCR_CLIENT_TTL_SECONDS,
          disallowPublicClientRegistration: DISALLOW_PUBLIC_CLIENT_REGISTRATION,
        }
      : {}),

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
