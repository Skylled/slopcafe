// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure OAuth 2.1 provider configuration constants (QL-808).
 *
 * Kept in a leaf module free of `@cloudflare/workers-oauth-provider`'s
 * `cloudflare:workers` runtime import so Node unit tests can import and assert
 * the exact TTL and PKCE options directly without a Workers runtime.
 * `src/oauth.ts` spreads {@link OAUTH_PROVIDER_STATIC_OPTIONS} verbatim into
 * `new OAuthProvider(...)`.
 */

/**
 * 24 hours — long enough to avoid frequent refresh-token rotation races across
 * concurrent connector sessions and cut `token_issued` audit-ledger noise by
 * ~96×, while still finite (as required by OAuth 2.1 and `workers-oauth-provider`
 * >= 60s) as defense in depth if `deleteClient` ever partial-fails.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 86_400;

/**
 * Refresh token TTL: explicitly `undefined` (non-expiring rotating refresh
 * tokens).
 *
 * WHY EXPLICIT `undefined` (NOT OMITTED): in `@cloudflare/workers-oauth-provider@0.8.2`,
 * omitting `refreshTokenTTL` inherits `DEFAULT_REFRESH_TOKEN_TTL = 2,592,000`
 * (30 days), which is STRICTLY ABSOLUTE — `handleRefreshTokenGrant` never
 * extends `grantData.expiresAt`, so active connectors hard-expire every 30 days
 * even when used daily. Because the library merges options via
 * `{ refreshTokenTTL: DEFAULT_REFRESH_TOKEN_TTL, ...options }`, passing
 * `refreshTokenTTL: undefined` explicitly overwrites the default and leaves
 * `grantData.expiresAt` undefined (no KV TTL). Refresh tokens still rotate on
 * every refresh and still cascade-revoke immediately on `deleteClient` or
 * `revokeAgent`.
 */
export const REFRESH_TOKEN_TTL_SECONDS: number | undefined = undefined;

/**
 * Dynamic Client Registration (DCR, RFC 7591) toggle. **Default: on.**
 *
 * When true, the provider exposes a public POST {@link DCR_REGISTRATION_ENDPOINT}
 * (advertised as `registration_endpoint` in the OAuth discovery metadata) so a
 * connector handed only the MCP URL — no client_id — can self-register.
 * To disable (revert to pre-registration-only): set to `false` and redeploy.
 */
export const ENABLE_DCR = true;

/** DCR endpoint path. Advertised as `registration_endpoint` in OAuth metadata. */
export const DCR_REGISTRATION_ENDPOINT = "/register";

/** Token endpoint path — served by the provider, observed by the audit layer. */
export const TOKEN_ENDPOINT = "/token";

/**
 * Lifetime of a registered OAuth client in `OAUTH_KV`: explicitly `undefined`
 * (never expires; emits RFC 7591 `client_secret_expires_at: 0`).
 *
 * WHY EXPLICIT `undefined` (NOT OMITTED, AND PASSED EVEN WHEN `ENABLE_DCR` IS
 * FALSE): in `@cloudflare/workers-oauth-provider@0.8.2`, omitting
 * `clientRegistrationTTL` inherits `DEFAULT_CLIENT_REGISTRATION_TTL = 90 days`
 * (STRICTLY ABSOLUTE from registration, never extended on token refresh). Worse,
 * `OAuthHelpers.updateClient()` (used by TOFU callback approval at `/authorize`)
 * unconditionally attaches `expirationTtl: this.provider.options.clientRegistrationTTL`,
 * silently turning even a pre-registered client into an expiring 90-day record.
 *
 * Setting `clientRegistrationTTL: undefined` fixes both: connected clients stay
 * alive until explicitly revoked (`DELETE /admin/oauth-clients/:client_id` or
 * `DELETE /admin/agents/:id`), while abandoned unbound DCR registrations are
 * swept on demand via `POST /admin/oauth-clients/prune` (mode `"unbound"`).
 * See docs/design/dcr-design.md.
 */
export const DCR_CLIENT_TTL_SECONDS: number | undefined = undefined;

/**
 * Whether to REJECT public (secretless, PKCE-only) DCR registrations. **Kept
 * `false` (public clients ALLOWED)** so native CLIs like Claude Code can
 * self-register under mandatory S256 PKCE (RFC 8252).
 */
export const DISALLOW_PUBLIC_CLIENT_REGISTRATION = false;

/**
 * Static options spread verbatim into `new OAuthProvider(...)` in `src/oauth.ts`.
 * Keeping `refreshTokenTTL` and `clientRegistrationTTL` as explicit own
 * properties with value `undefined` guarantees they overwrite the library's
 * 30-day and 90-day defaults during `{ ...defaults, ...options }`.
 */
export const OAUTH_PROVIDER_STATIC_OPTIONS = {
  authorizeEndpoint: "/authorize",
  tokenEndpoint: TOKEN_ENDPOINT,
  clientRegistrationTTL: DCR_CLIENT_TTL_SECONDS,
  ...(ENABLE_DCR
    ? {
        clientRegistrationEndpoint: DCR_REGISTRATION_ENDPOINT,
        disallowPublicClientRegistration: DISALLOW_PUBLIC_CLIENT_REGISTRATION,
      }
    : {}),
  accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
  allowPlainPKCE: false,
  scopesSupported: ["agent"],
};
