// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for QL-808 OAuth token lifetimes & renewal UX:
 *   1. OAuthProvider options: accessTokenTTL = 86_400, explicit own-property
 *      refreshTokenTTL = undefined and clientRegistrationTTL = undefined
 *      (overwriting workers-oauth-provider@0.8.2's 30d/90d absolute defaults),
 *      allowPlainPKCE = false.
 *   2. Migration 0021 SQL structure (drops UNIQUE(agent_id), preserves PK,
 *      ON DELETE CASCADE FK, and agent_id index).
 *   3. Manual mint redirect_uri validation (https, loopback http, IDE schemes;
 *      rejects remote http, *.localhost, userinfo, fragments, control chars).
 *   4. Multi-client bound mint, custom redirect_uris/client_name, GET inventory
 *      with KV/grant liveness, pruning (unbound + expired_ghosts + dry_run),
 *      and selective revocation.
 *   5. /authorize renewal UX: picker labels, non-operator anti-oracle on
 *      expired ghosts, operator recovery hint, automatic ghost eviction on
 *      bind, multi-client bind without 409, and inline replace_existing=1.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  DCR_CLIENT_TTL_SECONDS,
  OAUTH_PROVIDER_STATIC_OPTIONS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../src/oauth-config.ts";
import {
  createOAuthClientCore,
  createUnboundOAuthClientCore,
  deleteOAuthClientCore,
  listBoundClientsWithLivenessCore,
  listOAuthClientsCore,
  pruneOAuthClientsCore,
  validateMintRedirectUri,
} from "../src/admin-oauth.ts";
import { formatPickerAgentLabel, handleAuthorize } from "../src/authorize.ts";

let fails = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
function checkThat(label, cond, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : `\n       ${detail}`}`);
}

// ============================================================================
// 1. OAuthProvider TTL & PKCE configuration
// ============================================================================

check("ACCESS_TOKEN_TTL_SECONDS is 86_400 (24 hours)", ACCESS_TOKEN_TTL_SECONDS, 86_400);
check("REFRESH_TOKEN_TTL_SECONDS is undefined (non-expiring)", REFRESH_TOKEN_TTL_SECONDS, undefined);
check("DCR_CLIENT_TTL_SECONDS is undefined (non-expiring)", DCR_CLIENT_TTL_SECONDS, undefined);

const opts = OAUTH_PROVIDER_STATIC_OPTIONS;
const oauthSrc = readFileSync(
  fileURLToPath(new URL("../src/oauth.ts", import.meta.url)),
  "utf8",
);
checkThat(
  "src/oauth.ts spreads OAUTH_PROVIDER_STATIC_OPTIONS into new OAuthProvider",
  oauthSrc.includes("...OAUTH_PROVIDER_STATIC_OPTIONS"),
);

check("options.accessTokenTTL is 86_400", opts.accessTokenTTL, 86_400);
checkThat(
  "options has own property refreshTokenTTL set to undefined (overwrites 0.8.2 30d default)",
  Object.prototype.hasOwnProperty.call(opts, "refreshTokenTTL") && opts.refreshTokenTTL === undefined,
  JSON.stringify(Object.keys(opts)),
);
checkThat(
  "options has own property clientRegistrationTTL set to undefined (overwrites 0.8.2 90d default)",
  Object.prototype.hasOwnProperty.call(opts, "clientRegistrationTTL") &&
    opts.clientRegistrationTTL === undefined,
  JSON.stringify(Object.keys(opts)),
);
// Simulate workers-oauth-provider@0.8.2 constructor merge directly.
const merged = {
  accessTokenTTL: 3600,
  refreshTokenTTL: 2_592_000,
  clientRegistrationTTL: 7_776_000,
  ...opts,
};
check("spread merge over 0.8.2 defaults yields refreshTokenTTL === undefined", merged.refreshTokenTTL, undefined);
check(
  "spread merge over 0.8.2 defaults yields clientRegistrationTTL === undefined",
  merged.clientRegistrationTTL,
  undefined,
);
check("allowPlainPKCE remains false", opts.allowPlainPKCE, false);

// ============================================================================
// 2. Migration 0021 structure
// ============================================================================

const m21 = readFileSync(
  fileURLToPath(new URL("../migrations/0021_oauth_clients_multi.sql", import.meta.url)),
  "utf8",
);
checkThat(
  "migration 0021 preserves client_id PRIMARY KEY",
  /client_id\s+TEXT PRIMARY KEY/.test(m21),
);
checkThat(
  "migration 0021 drops UNIQUE on agent_id while preserving NOT NULL + ON DELETE CASCADE",
  /agent_id\s+TEXT NOT NULL REFERENCES agents\(id\) ON DELETE CASCADE/.test(m21) &&
    !/agent_id\s+TEXT NOT NULL UNIQUE/.test(m21),
);
checkThat(
  "migration 0021 recreates oauth_clients_agent_id index",
  /CREATE INDEX oauth_clients_agent_id ON oauth_clients \(agent_id\)/.test(m21),
);

// ============================================================================
// 3. Manual mint redirect_uri validation
// ============================================================================

check(
  "accepts https ChatGPT callback",
  validateMintRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect"),
  "https://chatgpt.com/connector_platform_oauth_redirect",
);
check(
  "accepts https claude.com callback",
  validateMintRedirectUri("https://claude.com/api/mcp/auth_callback"),
  "https://claude.com/api/mcp/auth_callback",
);
check(
  "accepts IPv4 loopback callback",
  validateMintRedirectUri("http://127.0.0.1:54321/callback"),
  "http://127.0.0.1:54321/callback",
);
check(
  "accepts exact localhost callback",
  validateMintRedirectUri("http://localhost:8080/cb"),
  "http://localhost:8080/cb",
);
check(
  "accepts IPv6 loopback callback",
  validateMintRedirectUri("http://[::1]:9000/cb"),
  "http://[::1]:9000/cb",
);
check(
  "accepts recognized IDE custom scheme",
  validateMintRedirectUri("vscode://anthropic.claude/auth"),
  "vscode://anthropic.claude/auth",
);
check("rejects remote plain http", validateMintRedirectUri("http://evil.example/cb"), null);
check(
  "rejects *.localhost subdomain spoofing",
  validateMintRedirectUri("http://claude.ai.localhost:9999/cb"),
  null,
);
check(
  "rejects embedded userinfo spoofing",
  validateMintRedirectUri("https://claude.ai@evil.example/cb"),
  null,
);
check("rejects fragment", validateMintRedirectUri("https://claude.ai/cb#frag"), null);
check("rejects javascript: scheme", validateMintRedirectUri("javascript:alert(1)"), null);
check("rejects unrecognized custom scheme", validateMintRedirectUri("evilapp://claude.ai/cb"), null);
check("rejects control characters", validateMintRedirectUri("https://claude.ai/cb\r\nX: 1"), null);

// ============================================================================
// In-memory D1 + OAuthProvider harness for core + /authorize behavioral tests
// ============================================================================

function makeTestEnv(opts = {}) {
  const agents = new Map(); // id -> { id, name, created_at }
  const bindings = new Map(); // client_id -> { client_id, agent_id, created_at }
  const kvClients = new Map(); // client_id -> ClientInfo
  const kvGrants = new Map(); // userId -> GrantSummary[]
  const auditEvents = [];
  let seq = 0;

  const failDeleteFor = new Set(opts.failDeleteFor ?? []);
  let purgeCalls = 0;

  const META = {
    prepare(sql) {
      const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
      return {
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          if (norm === "select id, name from agents where id = ?") {
            return agents.get(this.args[0]) ?? null;
          }
          if (norm === "select id from agents where id = ?") {
            const a = agents.get(this.args[0]);
            return a ? { id: a.id } : null;
          }
          if (norm === "select client_id, agent_id from oauth_clients where client_id = ?") {
            const b = bindings.get(this.args[0]);
            return b ? { client_id: b.client_id, agent_id: b.agent_id } : null;
          }
          if (
            norm ===
            "select a.id, a.name from oauth_clients oc join agents a on a.id = oc.agent_id where oc.client_id = ?"
          ) {
            const b = bindings.get(this.args[0]);
            if (!b) return null;
            const a = agents.get(b.agent_id);
            return a ? { id: a.id, name: a.name } : null;
          }
          throw new Error(`Unhandled first() SQL: ${norm}`);
        },
        async all() {
          if (norm === "select client_id, created_at from oauth_clients where agent_id = ? order by created_at desc") {
            const rows = [...bindings.values()]
              .filter((b) => b.agent_id === this.args[0])
              .sort((a, b) => b.created_at.localeCompare(a.created_at))
              .map((b) => ({ client_id: b.client_id, created_at: b.created_at }));
            return { results: rows };
          }
          if (norm === "select client_id from oauth_clients where agent_id = ?") {
            const rows = [...bindings.values()]
              .filter((b) => b.agent_id === this.args[0])
              .map((b) => ({ client_id: b.client_id }));
            return { results: rows };
          }
          if (norm === "select client_id from oauth_clients") {
            return { results: [...bindings.values()].map((b) => ({ client_id: b.client_id })) };
          }
          if (norm === "select client_id, agent_id from oauth_clients") {
            return {
              results: [...bindings.values()].map((b) => ({
                client_id: b.client_id,
                agent_id: b.agent_id,
              })),
            };
          }
          if (norm === "select agent_id, client_id from oauth_clients") {
            return {
              results: [...bindings.values()].map((b) => ({
                agent_id: b.agent_id,
                client_id: b.client_id,
              })),
            };
          }
          if (
            norm ===
            "select oc.client_id, oc.agent_id, a.name as agent_name, oc.created_at from oauth_clients oc join agents a on a.id = oc.agent_id order by oc.created_at desc, oc.client_id desc"
          ) {
            const rows = [...bindings.values()]
              .map((b) => {
                const a = agents.get(b.agent_id);
                return a
                  ? {
                      client_id: b.client_id,
                      agent_id: b.agent_id,
                      agent_name: a.name,
                      created_at: b.created_at,
                    }
                  : null;
              })
              .filter(Boolean)
              .sort(
                (a, b) =>
                  b.created_at.localeCompare(a.created_at) ||
                  b.client_id.localeCompare(a.client_id),
              );
            return { results: rows };
          }
          if (norm === "select id, name from agents order by created_at desc, id desc limit 100") {
            const rows = [...agents.values()]
              .sort(
                (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
              )
              .map((a) => ({ id: a.id, name: a.name }));
            return { results: rows };
          }
          throw new Error(`Unhandled all() SQL: ${norm}`);
        },
        async run() {
          if (norm === "insert into oauth_clients (client_id, agent_id) values (?, ?)") {
            const [client_id, agent_id] = this.args;
            if (bindings.has(client_id)) throw new Error("UNIQUE constraint failed: oauth_clients.client_id");
            bindings.set(client_id, {
              client_id,
              agent_id,
              created_at: new Date(Date.now() + ++seq * 1000).toISOString(),
            });
            return { meta: { changes: 1 } };
          }
          if (norm === "delete from oauth_clients where client_id = ?") {
            const existed = bindings.delete(this.args[0]);
            return { meta: { changes: existed ? 1 : 0 } };
          }
          if (norm.startsWith("insert into audit_events")) {
            auditEvents.push(this.args);
            return { meta: { changes: 1 } };
          }
          throw new Error(`Unhandled run() SQL: ${norm}`);
        },
      };
    },
    async batch(stmts) {
      for (const s of stmts) await s.run();
      return [];
    },
  };

  let lastCompletedAuth = null;

  const OAUTH_PROVIDER = {
    async createClient(partial) {
      const id = `cid_${++seq}`;
      const info = {
        clientId: id,
        clientSecret: `sec_${seq}`,
        clientName: partial.clientName,
        redirectUris: partial.redirectUris ?? [],
        tokenEndpointAuthMethod: partial.tokenEndpointAuthMethod ?? "client_secret_basic",
        grantTypes: partial.grantTypes ?? ["authorization_code", "refresh_token"],
        responseTypes: partial.responseTypes ?? ["code"],
        registrationDate: Math.floor(Date.now() / 1000),
      };
      kvClients.set(id, info);
      return info;
    },
    async lookupClient(id) {
      return kvClients.get(id) ?? null;
    },
    async listClients() {
      return { items: [...kvClients.values()] };
    },
    async deleteClient(id) {
      if (failDeleteFor.has(id)) throw new Error("simulated KV failure");
      kvClients.delete(id);
      for (const [uid, list] of kvGrants.entries()) {
        kvGrants.set(
          uid,
          list.filter((g) => g.clientId !== id),
        );
      }
    },
    async listUserGrants(userId) {
      return { items: kvGrants.get(userId) ?? [] };
    },
    async purgeExpiredData() {
      purgeCalls++;
      return {
        grantsChecked: 2,
        grantsPurged: 1,
        tokensChecked: 3,
        tokensPurged: 2,
        done: true,
      };
    },
    async parseAuthRequest(req) {
      const u = new URL(req.url);
      const clientId = u.searchParams.get("client_id") ?? "";
      const redirectUri = u.searchParams.get("redirect_uri") ?? "";
      const state = u.searchParams.get("state") ?? "";
      const client = kvClients.get(clientId);
      if (!client || !client.redirectUris.includes(redirectUri)) {
        throw new Error("Invalid client or redirect_uri");
      }
      return {
        responseType: "code",
        clientId,
        redirectUri,
        scope: ["agent"],
        state,
      };
    },
    async completeAuthorization(completeOpts) {
      lastCompletedAuth = completeOpts;
      const u = new URL(completeOpts.request.redirectUri);
      u.searchParams.set("code", "authcode_123");
      if (completeOpts.request.state) u.searchParams.set("state", completeOpts.request.state);
      return { redirectTo: u.toString() };
    },
  };

  return {
    env: {
      META,
      OAUTH_PROVIDER,
      OPERATOR_TOKEN: "test-operator-token-secret",
    },
    agents,
    bindings,
    kvClients,
    kvGrants,
    auditEvents,
    getPurgeCalls: () => purgeCalls,
    getLastCompletedAuth: () => lastCompletedAuth,
  };
}

// ============================================================================
// 4. Multi-client mint, optional redirect_uris, inventory, pruning, revocation
// ============================================================================

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";

{
  const h = makeTestEnv();
  h.agents.set(A1, { id: A1, name: "Claude", created_at: "2026-11-01T00:00:00.000Z" });
  h.agents.set(A2, { id: A2, name: "ChatGPT", created_at: "2026-11-02T00:00:00.000Z" });

  // Multi-client binding on one agent (no 409!).
  const m1 = await createOAuthClientCore(h.env, A1, "https://slopcafe.com");
  const m2 = await createOAuthClientCore(h.env, A1, "https://slopcafe.com", undefined, {
    redirectUris: ["https://claude.com/api/mcp/auth_callback"],
    clientName: "Claude Desktop",
  });
  check("first bound mint succeeds", m1.ok, true);
  check("second bound mint on SAME agent succeeds (multi-client)", m2.ok, true);
  check(
    "default redirect_uris is claude.ai callback",
    m1.ok ? m1.redirect_uris[0] : null,
    "https://claude.ai/api/mcp/auth_callback",
  );
  check(
    "custom redirect_uris is preserved on bound mint",
    m2.ok ? m2.redirect_uris[0] : null,
    "https://claude.com/api/mcp/auth_callback",
  );

  // Unbound mint with custom ChatGPT redirect_uri.
  const u1 = await createUnboundOAuthClientCore(h.env, "https://slopcafe.com", undefined, {
    redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    clientName: "ChatGPT Custom",
  });
  check(
    "custom redirect_uris is preserved on unbound mint",
    u1.redirect_uris[0],
    "https://chatgpt.com/connector_platform_oauth_redirect",
  );

  // Add an old unbound DCR client (10 days old) + an expired KV ghost row on A2.
  const nowMs = Date.UTC(2026, 10, 19, 12, 0, 0);
  const nowSec = Math.floor(nowMs / 1000);
  h.kvClients.get(u1.client_id).registrationDate = nowSec - 2 * 86_400; // 2 days old (fresh)
  h.kvClients.set("cid_old_dcr", {
    clientId: "cid_old_dcr",
    clientName: "Abandoned DCR",
    redirectUris: ["https://example.com/cb"],
    tokenEndpointAuthMethod: "none",
    registrationDate: nowSec - 10 * 86_400, // 10 days old (stale)
  });
  h.bindings.set("cid_ghost", {
    client_id: "cid_ghost",
    agent_id: A2,
    created_at: "2026-08-01T00:00:00.000Z",
  });

  // Add grants: non-expiring grant on m1, finite-expiry grant on m2.
  h.kvGrants.set(A1, [
    {
      id: "g1",
      clientId: m1.client_id,
      userId: A1,
      scope: ["agent"],
      metadata: {},
      createdAt: nowSec - 100,
      expiresAt: undefined,
    },
    {
      id: "g2",
      clientId: m2.client_id,
      userId: A1,
      scope: ["agent"],
      metadata: {},
      createdAt: nowSec - 50,
      expiresAt: nowSec + 86_400,
    },
  ]);

  // GET /admin/oauth-clients inventory.
  const inv = await listOAuthClientsCore(h.env);
  check("inventory counts.total is 5 (3 bound + 2 unbound)", inv.counts.total, 5);
  check("inventory counts.bound is 3", inv.counts.bound, 3);
  check("inventory counts.unbound is 2", inv.counts.unbound, 2);
  check("inventory counts.expired_in_kv is 1", inv.counts.expired_in_kv, 1);

  const m1Row = inv.clients.find((c) => c.client_id === m1.client_id);
  check("m1 reports kv_status=alive", m1Row?.kv_status, "alive");
  check("m1 reports active_grants=1", m1Row?.active_grants, 1);
  check("m1 reports has_non_expiring_grant=true", m1Row?.has_non_expiring_grant, true);
  check("m1 reports earliest_grant_expires_at=null", m1Row?.earliest_grant_expires_at, null);
  checkThat("inventory never includes clientSecret", !("clientSecret" in m1Row) && !("client_secret" in m1Row));

  const m2Row = inv.clients.find((c) => c.client_id === m2.client_id);
  check("m2 reports has_non_expiring_grant=false", m2Row?.has_non_expiring_grant, false);
  checkThat("m2 reports ISO earliest_grant_expires_at", typeof m2Row?.earliest_grant_expires_at === "string");

  const ghostOnly = await listOAuthClientsCore(h.env, { status: "expired_in_kv" });
  check("status=expired_in_kv returns only the ghost row", ghostOnly.clients.length, 1);
  check("...matching cid_ghost", ghostOnly.clients[0]?.client_id, "cid_ghost");

  const a1Liveness = await listBoundClientsWithLivenessCore(h.env, A1);
  check("listBoundClientsWithLivenessCore returns both clients for A1", a1Liveness.length, 2);

  // Prune unbound: dry-run with default 7 days matches only cid_old_dcr.
  const dryUnbound = await pruneOAuthClientsCore(h.env, "unbound", { dryRun: true }, nowMs);
  check("unbound dry_run matched=1", dryUnbound.ok ? dryUnbound.matched : -1, 1);
  check("unbound dry_run deleted=0", dryUnbound.ok ? dryUnbound.deleted : -1, 0);
  check("unbound dry_run does not call purgeExpiredData", h.getPurgeCalls(), 0);

  // Real unbound prune with default 7 days deletes cid_old_dcr, keeps u1 and bound clients.
  const realUnbound = await pruneOAuthClientsCore(h.env, "unbound", { dryRun: false }, nowMs);
  check("unbound real prune deleted=1", realUnbound.ok ? realUnbound.deleted : -1, 1);
  check("unbound real prune ran purgeExpiredData (grantsPurged=1)", realUnbound.ok ? realUnbound.grantsPurged : -1, 1);
  check("unbound real prune ran purgeExpiredData (tokensPurged=2)", realUnbound.ok ? realUnbound.tokensPurged : -1, 2);
  check("cid_old_dcr removed from KV", h.kvClients.has("cid_old_dcr"), false);
  check("fresh unbound u1 survived 7-day gate", h.kvClients.has(u1.client_id), true);
  check("bound m1 survived unbound prune", h.kvClients.has(m1.client_id), true);

  // Unbound prune with olderThanDays=0 sweeps remaining fresh unbound client u1.
  const zeroUnbound = await pruneOAuthClientsCore(h.env, "unbound", { olderThanDays: 0 }, nowMs);
  check("unbound older_than_days=0 deletes fresh unbound client", zeroUnbound.ok ? zeroUnbound.deleted : -1, 1);
  check("u1 removed from KV", h.kvClients.has(u1.client_id), false);

  // Prune expired_ghosts rejects older_than_days.
  const badGhostArg = await pruneOAuthClientsCore(h.env, "expired_ghosts", { olderThanDays: 7 }, nowMs);
  check("expired_ghosts rejects older_than_days", badGhostArg.ok, false);

  // Prune expired_ghosts deletes cid_ghost without touching alive bound clients.
  const ghostPrune = await pruneOAuthClientsCore(h.env, "expired_ghosts", {}, nowMs);
  check("expired_ghosts deletes 1 dead D1 row", ghostPrune.ok ? ghostPrune.deleted : -1, 1);
  check("cid_ghost removed from D1", h.bindings.has("cid_ghost"), false);
  check("alive bound m1 still in D1", h.bindings.has(m1.client_id), true);

  // Selective revocation: deleting m1 leaves m2 intact on A1.
  const del1 = await deleteOAuthClientCore(h.env, m1.client_id);
  check("deleteOAuthClientCore succeeds on m1", del1.ok, true);
  check("m1 removed from D1 and KV", !h.bindings.has(m1.client_id) && !h.kvClients.has(m1.client_id), true);
  check("sibling m2 remains bound and alive", h.bindings.has(m2.client_id) && h.kvClients.has(m2.client_id), true);
}

// ============================================================================
// 5. /authorize renewal UX: picker labels, ghost handling, multi-client & replace
// ============================================================================

check(
  "picker label: 0 clients",
  formatPickerAgentLabel({ id: A1, name: "Claude", aliveClients: 0, expiredClients: 0 }),
  "Claude",
);
check(
  "picker label: 1 active client",
  formatPickerAgentLabel({ id: A1, name: "Claude", aliveClients: 1, expiredClients: 0 }),
  "Claude (1 active client)",
);
check(
  "picker label: 2 active clients",
  formatPickerAgentLabel({ id: A1, name: "Claude", aliveClients: 2, expiredClients: 0 }),
  "Claude (2 active clients)",
);
check(
  "picker label: 1 expired ghost",
  formatPickerAgentLabel({ id: A1, name: "Claude", aliveClients: 0, expiredClients: 1 }),
  "Claude (1 expired client — auto-cleaned)",
);
check(
  "picker label: mixed active + expired",
  formatPickerAgentLabel({ id: A1, name: "Claude", aliveClients: 1, expiredClients: 2 }),
  "Claude (1 active, 2 expired)",
);

{
  const h = makeTestEnv();
  h.agents.set(A1, { id: A1, name: "Claude", created_at: "2026-11-01T00:00:00.000Z" });
  // Seed one alive client + one dead KV ghost on A1.
  h.kvClients.set("cid_alive_1", {
    clientId: "cid_alive_1",
    clientName: "Claude Web",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    tokenEndpointAuthMethod: "client_secret_basic",
    registrationDate: Math.floor(Date.now() / 1000) - 3600,
  });
  h.bindings.set("cid_alive_1", {
    client_id: "cid_alive_1",
    agent_id: A1,
    created_at: "2026-11-10T00:00:00.000Z",
  });
  h.bindings.set("cid_dead_ghost", {
    client_id: "cid_dead_ghost",
    agent_id: A1,
    created_at: "2026-08-01T00:00:00.000Z",
  });

  // Expired ghost GET /authorize: non-operator gets generic error (no oracle); operator gets hint.
  const ghostUrl =
    "https://slopcafe.com/authorize?client_id=cid_dead_ghost&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&response_type=code";
  const anonGhostRes = await handleAuthorize(new Request(ghostUrl), h.env);
  const anonGhostHtml = await anonGhostRes.text();
  check("non-operator expired ghost returns 400", anonGhostRes.status, 400);
  checkThat(
    "non-operator expired ghost leaks neither agent name nor KV expiry",
    anonGhostHtml.includes("invalid authorization request") && !anonGhostHtml.includes("Claude"),
    anonGhostHtml,
  );

  const opGhostRes = await handleAuthorize(
    new Request(ghostUrl, { headers: { authorization: "Bearer test-operator-token-secret" } }),
    h.env,
  );
  const opGhostHtml = await opGhostRes.text();
  check("operator expired ghost returns 400 with recovery hint", opGhostRes.status, 400);
  checkThat(
    "operator expired ghost links to agent console",
    opGhostHtml.includes(`/admin/console/agents/${A1}`) && opGhostHtml.includes("KV registration has expired"),
    opGhostHtml,
  );

  // New DCR client arrives unbound.
  h.kvClients.set("cid_new_dcr", {
    clientId: "cid_new_dcr",
    clientName: "Claude Code CLI",
    redirectUris: ["http://127.0.0.1:51234/cb"],
    tokenEndpointAuthMethod: "none",
    registrationDate: Math.floor(Date.now() / 1000) - 30,
  });
  const dcrUrl =
    "https://slopcafe.com/authorize?client_id=cid_new_dcr&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fcb&response_type=code&state=st1";

  // GET /authorize as operator shows picker with liveness + replace_existing checkbox + Deny first.
  const getRes = await handleAuthorize(
    new Request(dcrUrl, { headers: { authorization: "Bearer test-operator-token-secret" } }),
    h.env,
  );
  const getHtml = await getRes.text();
  check("operator GET /authorize on unbound client returns 200", getRes.status, 200);
  checkThat("picker labels mixed active+expired counts", getHtml.includes("Claude (1 active, 1 expired)"));
  checkThat("bind-or-mint card offers replace_existing checkbox", getHtml.includes('name="replace_existing"'));
  checkThat(
    "Deny button stays before Allow button in DOM order",
    getHtml.indexOf('value="deny"') < getHtml.indexOf('value="allow"'),
  );

  // POST /authorize WITHOUT replace_existing: auto-evicts dead ghost, keeps alive client, binds new client!
  const fd1 = new FormData();
  fd1.set("action", "allow");
  fd1.set("agent_mode", "existing");
  fd1.set("agent_id", A1);
  fd1.set("operator_token", "test-operator-token-secret");
  const postRes1 = await handleAuthorize(new Request(dcrUrl, { method: "POST", body: fd1 }), h.env);
  check("POST /authorize binds second client to existing agent without 409 (302)", postRes1.status, 302);
  const loc1 = postRes1.headers.get("location") ?? "";
  checkThat("redirect carries RFC 9207 iss", loc1.includes("iss=https%3A%2F%2Fslopcafe.com"), loc1);
  check("dead ghost row was auto-evicted from D1", h.bindings.has("cid_dead_ghost"), false);
  check("existing alive client remained bound", h.bindings.has("cid_alive_1"), true);
  check("new DCR client is now bound to A1", h.bindings.get("cid_new_dcr")?.agent_id, A1);
  check("completeAuthorization stamped props.clientId from authReq", h.getLastCompletedAuth()?.props?.clientId, "cid_new_dcr");

  // Third DCR client binds WITH replace_existing=1 → revokes both prior active clients!
  h.kvClients.set("cid_replacer", {
    clientId: "cid_replacer",
    clientName: "Fresh Connector",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    tokenEndpointAuthMethod: "client_secret_basic",
    registrationDate: Math.floor(Date.now() / 1000) - 10,
  });
  const repUrl =
    "https://slopcafe.com/authorize?client_id=cid_replacer&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&response_type=code&state=st2";
  const fd2 = new FormData();
  fd2.set("action", "allow");
  fd2.set("agent_mode", "existing");
  fd2.set("agent_id", A1);
  fd2.set("replace_existing", "1");
  fd2.set("operator_token", "test-operator-token-secret");
  const postRes2 = await handleAuthorize(new Request(repUrl, { method: "POST", body: fd2 }), h.env);
  check("POST /authorize with replace_existing=1 succeeds (302)", postRes2.status, 302);
  check("prior cid_alive_1 revoked from KV + D1", !h.kvClients.has("cid_alive_1") && !h.bindings.has("cid_alive_1"), true);
  check("prior cid_new_dcr revoked from KV + D1", !h.kvClients.has("cid_new_dcr") && !h.bindings.has("cid_new_dcr"), true);
  check("replacer client is bound to A1", h.bindings.get("cid_replacer")?.agent_id, A1);
}

// Fail-closed replace_existing when KV deleteClient throws.
{
  const h = makeTestEnv({ failDeleteFor: ["cid_stubborn"] });
  h.agents.set(A1, { id: A1, name: "Claude", created_at: "2026-11-01T00:00:00.000Z" });
  h.kvClients.set("cid_stubborn", {
    clientId: "cid_stubborn",
    clientName: "Stubborn",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    tokenEndpointAuthMethod: "client_secret_basic",
  });
  h.bindings.set("cid_stubborn", {
    client_id: "cid_stubborn",
    agent_id: A1,
    created_at: "2026-11-10T00:00:00.000Z",
  });
  h.kvClients.set("cid_incoming", {
    clientId: "cid_incoming",
    clientName: "Incoming",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    tokenEndpointAuthMethod: "client_secret_basic",
  });
  const url =
    "https://slopcafe.com/authorize?client_id=cid_incoming&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&response_type=code";
  const fd = new FormData();
  fd.set("action", "allow");
  fd.set("agent_mode", "existing");
  fd.set("agent_id", A1);
  fd.set("replace_existing", "1");
  fd.set("operator_token", "test-operator-token-secret");
  const res = await handleAuthorize(new Request(url, { method: "POST", body: fd }), h.env);
  check("replace_existing fails closed (500) when KV deleteClient throws", res.status, 500);
  check("old D1 binding remains intact for retry", h.bindings.has("cid_stubborn"), true);
  check("incoming client is not bound on aborted replace", h.bindings.has("cid_incoming"), false);
}

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} oauth-renewal test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall oauth-renewal tests passed");
}
