#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end proof of Door A OAuth 2.1 lifetimes, multi-client binding,
# inventory/pruning, inline replacement, and cascading revocation (QL-808).
#
# USAGE (local only — never point B at production):
#   npm run db:migrate:local && npm run dev
#   bash test/e2e/oauth.sh

set -euo pipefail

B="${BASE_URL:-http://localhost:8787}"
OP=$(grep -E '^OPERATOR_TOKEN=' "$(git rev-parse --show-toplevel)/.dev.vars" | cut -d= -f2- | tr -d '"'"'"'')
[ -n "$OP" ] || { echo "FATAL: no OPERATOR_TOKEN in .dev.vars"; exit 1; }

pass=0; fail=0
ck() { # ck <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass+1));
  else echo "FAIL $1"; echo "       want: $2"; echo "       got:  $3"; fail=$((fail+1)); fi
}

# PKCE S256 challenge via node (present everywhere tests run).
pkce_challenge() {
  node -e 'const c=require("node:crypto"); console.log(c.createHash("sha256").update(process.argv[1]).digest("base64url"));' "$1"
}

url_param() { # url_param <url> <param>
  node -e 'const u=new URL(process.argv[1]); console.log(u.searchParams.get(process.argv[2]) ?? "");' "$1" "$2"
}

# =============================================================================
# 1. Agent + multi-client manual mint with custom redirect_uris
# =============================================================================
AG=$(curl -sS -X POST "$B/admin/agents" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{"name":"e2e-oauth-agent"}')
AGID=$(echo "$AG" | jq -r '.agent_id // .id')
[ -n "$AGID" ] && [ "$AGID" != "null" ] || { echo "FATAL: agent mint failed: $AG"; exit 1; }

MINT1=$(curl -sS -X POST "$B/admin/agents/$AGID/oauth-clients" -H "authorization: Bearer $OP" \
        -H 'content-type: application/json' \
        -d '{"redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"client_name":"ChatGPT Connector"}')
MINT1_ID=$(echo "$MINT1" | jq -r '.client_id')
MINT1_SECRET=$(echo "$MINT1" | jq -r '.client_secret')
ck "bound mint 1 accepts custom ChatGPT redirect_uri" "https://chatgpt.com/connector_platform_oauth_redirect" \
  "$(echo "$MINT1" | jq -r '.redirect_uris[0]')"

# Second bound mint on the SAME agent — proves migration 0021 dropped UNIQUE(agent_id).
MINT2_STATUS=$(curl -sS -o /tmp/e2e-mint2-$$.json -w '%{http_code}' \
  -X POST "$B/admin/agents/$AGID/oauth-clients" -H "authorization: Bearer $OP" \
  -H 'content-type: application/json' -d '{}')
MINT2_ID=$(jq -r '.client_id' /tmp/e2e-mint2-$$.json)
rm -f /tmp/e2e-mint2-$$.json
ck "second bound mint on same agent returns 201 (no 409 UNIQUE collision)" "201" "$MINT2_STATUS"

# Unbound mint with custom redirect_uri.
UNBOUND=$(curl -sS -X POST "$B/admin/oauth-clients" -H "authorization: Bearer $OP" \
          -H 'content-type: application/json' \
          -d '{"redirect_uris":["https://claude.com/api/mcp/auth_callback"],"client_name":"Unbound Test"}')
UNBOUND_ID=$(echo "$UNBOUND" | jq -r '.client_id')
ck "unbound mint accepts custom redirect_uri" "https://claude.com/api/mcp/auth_callback" \
  "$(echo "$UNBOUND" | jq -r '.redirect_uris[0]')"

# =============================================================================
# 2. DCR registration + full Authorization Code + S256 PKCE + refresh rotation
# =============================================================================
CB1="http://127.0.0.1:54321/cb"
REG1=$(curl -sS -X POST "$B/register" -H 'content-type: application/json' \
       -d "{\"client_name\":\"E2E Public CLI 1\",\"redirect_uris\":[\"$CB1\"],\"token_endpoint_auth_method\":\"none\",\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"]}")
DCR1_ID=$(echo "$REG1" | jq -r '.client_id')
[ -n "$DCR1_ID" ] && [ "$DCR1_ID" != "null" ] || { echo "FATAL: DCR 1 failed: $REG1"; exit 1; }

# Confidential DCR client checks RFC 7591 client_secret_expires_at === 0 (non-expiring).
REG_CONF=$(curl -sS -X POST "$B/register" -H 'content-type: application/json' \
           -d '{"client_name":"E2E Conf Unbound","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"token_endpoint_auth_method":"client_secret_basic","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}')
REG_CONF_ID=$(echo "$REG_CONF" | jq -r '.client_id')
ck "DCR client_secret_expires_at is 0 (non-expiring)" "0" "$(echo "$REG_CONF" | jq -r '.client_secret_expires_at')"

VERIFIER1="e2e-pkce-verifier-0123456789abcdefghijklmnopqrstuvwxyz"
CHALLENGE1=$(pkce_challenge "$VERIFIER1")
AUTH1_QS="client_id=$DCR1_ID&redirect_uri=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$CB1")&response_type=code&scope=agent&state=st1&code_challenge=$CHALLENGE1&code_challenge_method=S256"

# Anonymous GET /authorize on unbound DCR client must not disclose existence.
ANON_AUTH=$(curl -sS -o /dev/null -w '%{http_code}' "$B/authorize?$AUTH1_QS")
ck "anonymous GET /authorize on unbound client returns 400" "400" "$ANON_AUTH"

# Operator GET /authorize shows bind-or-mint card with replace_existing checkbox.
OP_AUTH_HTML=$(curl -sS "$B/authorize?$AUTH1_QS" -H "authorization: Bearer $OP")
ck "operator GET /authorize shows replace_existing checkbox" "true" \
  "$(echo "$OP_AUTH_HTML" | grep -q 'name="replace_existing"' && echo true || echo false)"
ck "operator GET /authorize labels agent active clients" "true" \
  "$(echo "$OP_AUTH_HTML" | grep -q 'e2e-oauth-agent (2 active clients)' && echo true || echo false)"

# Operator POST /authorize binds DCR1 to AGID (3rd client on AGID, no replace).
AUTH1_HDR="/tmp/e2e-auth1-hdr-$$.txt"
AUTH1_STATUS=$(curl -sS -D "$AUTH1_HDR" -o /dev/null -w '%{http_code}' -X POST "$B/authorize?$AUTH1_QS" \
  -F "action=allow" -F "agent_mode=existing" -F "agent_id=$AGID" -F "operator_token=$OP")
AUTH1_LOC=$(grep -i '^location:' "$AUTH1_HDR" | tail -1 | sed -E 's/^location:[[:space:]]*//I' | tr -d '\r')
rm -f "$AUTH1_HDR"
ck "POST /authorize binds DCR1 alongside existing clients (302)" "302" "$AUTH1_STATUS"
ck "redirect carries RFC 9207 iss" "$B" "$(url_param "$AUTH1_LOC" iss)"
CODE1=$(url_param "$AUTH1_LOC" code)
[ -n "$CODE1" ] || { echo "FATAL: missing auth code in $AUTH1_LOC"; exit 1; }

# Exchange authorization code for access + refresh tokens.
TOK1=$(curl -sS -X POST "$B/token" -H 'content-type: application/x-www-form-urlencoded' \
       --data-urlencode "grant_type=authorization_code" \
       --data-urlencode "code=$CODE1" \
       --data-urlencode "client_id=$DCR1_ID" \
       --data-urlencode "redirect_uri=$CB1" \
       --data-urlencode "code_verifier=$VERIFIER1")
AT1=$(echo "$TOK1" | jq -r '.access_token')
RT1=$(echo "$TOK1" | jq -r '.refresh_token')
ck "access_token expires_in is 86400 (24h)" "86400" "$(echo "$TOK1" | jq -r '.expires_in')"
ck "refresh_token issued" "true" "$([ -n "$RT1" ] && [ "$RT1" != "null" ] && echo true || echo false)"

# Verify Door A access token works on /mcp.
MCP_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/mcp" \
  -H "authorization: Bearer $AT1" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
ck "Door A OAuth access token authenticates /mcp (200)" "200" "$MCP_STATUS"

# Verify refresh token rotation produces a fresh 86400s access token.
TOK1_REF=$(curl -sS -X POST "$B/token" -H 'content-type: application/x-www-form-urlencoded' \
           --data-urlencode "grant_type=refresh_token" \
           --data-urlencode "refresh_token=$RT1" \
           --data-urlencode "client_id=$DCR1_ID")
AT1_NEW=$(echo "$TOK1_REF" | jq -r '.access_token')
ck "refreshed access_token expires_in is 86400" "86400" "$(echo "$TOK1_REF" | jq -r '.expires_in')"
ck "refresh rotation issued a new access token" "false" "$([ "$AT1_NEW" = "$AT1" ] && echo true || echo false)"

# =============================================================================
# 3. GET /admin/oauth-clients inventory + KV/grant liveness + console view
# =============================================================================
INV=$(curl -sS "$B/admin/oauth-clients?agent_id=$AGID" -H "authorization: Bearer $OP")
ck "GET /admin/oauth-clients returns 3 bound clients for agent" "3" "$(echo "$INV" | jq '.clients | length')"
DCR1_INV=$(echo "$INV" | jq --arg id "$DCR1_ID" '.clients[] | select(.client_id == $id)')
ck "DCR1 reports kv_status=alive" "alive" "$(echo "$DCR1_INV" | jq -r '.kv_status')"
ck "DCR1 reports active_grants=1" "1" "$(echo "$DCR1_INV" | jq -r '.active_grants')"
ck "DCR1 reports has_non_expiring_grant=true" "true" "$(echo "$DCR1_INV" | jq -r '.has_non_expiring_grant')"
ck "DCR1 reports earliest_grant_expires_at=null" "null" "$(echo "$DCR1_INV" | jq -r '.earliest_grant_expires_at')"
ck "GET /admin/oauth-clients has no client_secret field" "false" \
  "$(echo "$INV" | jq '[.clients[] | has("client_secret") or has("clientSecret")] | any')"
ck "GET /admin/oauth-clients never leaks minted plaintext secret" "0" \
  "$(echo "$INV" | grep -cF -- "$MINT1_SECRET" || true)"

# Operator console /admin/console/agents/:id shows KV liveness & grant status.
COOKIE_JAR="/tmp/e2e-oauth-cookies-$$.txt"
curl -sS -c "$COOKIE_JAR" -o /dev/null -X POST "$B/login" \
  -d "operator_token=$OP&next=/admin/console"
AGENT_HTML=$(curl -sS -b "$COOKIE_JAR" "$B/admin/console/agents/$AGID")
rm -f "$COOKIE_JAR"
ck "console agent detail shows alive KV badge" "true" \
  "$(echo "$AGENT_HTML" | grep -q '>alive<' && echo true || echo false)"
ck "console agent detail shows non-expiring grant" "true" \
  "$(echo "$AGENT_HTML" | grep -q '1 active (no expiry)' && echo true || echo false)"

# =============================================================================
# 4. Inline replace_existing=1 revokes prior active clients & invalidates tokens
# =============================================================================
CB2="http://127.0.0.1:54322/cb"
REG2=$(curl -sS -X POST "$B/register" -H 'content-type: application/json' \
       -d "{\"client_name\":\"E2E Replacer CLI\",\"redirect_uris\":[\"$CB2\"],\"token_endpoint_auth_method\":\"none\",\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"]}")
DCR2_ID=$(echo "$REG2" | jq -r '.client_id')
VERIFIER2="e2e-pkce-verifier-second-0123456789abcdefghijklmnopqrstuvwxyz"
CHALLENGE2=$(pkce_challenge "$VERIFIER2")
AUTH2_QS="client_id=$DCR2_ID&redirect_uri=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$CB2")&response_type=code&scope=agent&state=st2&code_challenge=$CHALLENGE2&code_challenge_method=S256"

AUTH2_HDR="/tmp/e2e-auth2-hdr-$$.txt"
AUTH2_STATUS=$(curl -sS -D "$AUTH2_HDR" -o /dev/null -w '%{http_code}' -X POST "$B/authorize?$AUTH2_QS" \
  -F "action=allow" -F "agent_mode=existing" -F "agent_id=$AGID" -F "replace_existing=1" -F "operator_token=$OP")
AUTH2_LOC=$(grep -i '^location:' "$AUTH2_HDR" | tail -1 | sed -E 's/^location:[[:space:]]*//I' | tr -d '\r')
rm -f "$AUTH2_HDR"
ck "POST /authorize with replace_existing=1 returns 302" "302" "$AUTH2_STATUS"

# Old DCR1 access token must immediately 401 on /mcp.
OLD_MCP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/mcp" \
  -H "authorization: Bearer $AT1_NEW" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
ck "replaced client's live access token immediately 401s on /mcp" "401" "$OLD_MCP"

INV_AFTER=$(curl -sS "$B/admin/oauth-clients?agent_id=$AGID" -H "authorization: Bearer $OP")
ck "only replacer DCR2 remains bound to agent" "1" "$(echo "$INV_AFTER" | jq '.clients | length')"
ck "...matching DCR2_ID" "$DCR2_ID" "$(echo "$INV_AFTER" | jq -r '.clients[0].client_id')"

# Exchange DCR2 code, verify live /mcp, then revoke via DELETE /admin/oauth-clients/:id.
CODE2=$(url_param "$AUTH2_LOC" code)
TOK2=$(curl -sS -X POST "$B/token" -H 'content-type: application/x-www-form-urlencoded' \
       --data-urlencode "grant_type=authorization_code" \
       --data-urlencode "code=$CODE2" \
       --data-urlencode "client_id=$DCR2_ID" \
       --data-urlencode "redirect_uri=$CB2" \
       --data-urlencode "code_verifier=$VERIFIER2")
AT2=$(echo "$TOK2" | jq -r '.access_token')
MCP2_OK=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/mcp" \
  -H "authorization: Bearer $AT2" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
ck "replacer client's access token works on /mcp (200)" "200" "$MCP2_OK"

# =============================================================================
# 5. POST /admin/oauth-clients/prune + cascading DELETE revocation
# =============================================================================
PRUNE_DRY=$(curl -sS -X POST "$B/admin/oauth-clients/prune" -H "authorization: Bearer $OP" \
            -H 'content-type: application/json' -d '{"mode":"unbound","dry_run":true,"older_than_days":0}')
ck "prune unbound dry_run matches >= 2 unbound clients" "true" \
  "$([ "$(echo "$PRUNE_DRY" | jq '.matched')" -ge 2 ] && echo true || echo false)"
ck "prune unbound dry_run deletes 0" "0" "$(echo "$PRUNE_DRY" | jq -r '.deleted')"

PRUNE_REAL=$(curl -sS -X POST "$B/admin/oauth-clients/prune" -H "authorization: Bearer $OP" \
             -H 'content-type: application/json' -d '{"mode":"unbound","dry_run":false,"older_than_days":0}')
ck "prune unbound real deletes >= 2 unbound clients" "true" \
  "$([ "$(echo "$PRUNE_REAL" | jq '.deleted')" -ge 2 ] && echo true || echo false)"

# Bound DCR2 must survive unbound prune!
MCP2_STILL_OK=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/mcp" \
  -H "authorization: Bearer $AT2" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
ck "bound client survives unbound prune (200)" "200" "$MCP2_STILL_OK"

# Cascading DELETE revokes DCR2 immediately.
DEL_RES=$(curl -sS -X DELETE "$B/admin/oauth-clients/$DCR2_ID" -H "authorization: Bearer $OP")
ck "DELETE /admin/oauth-clients/:id returns revoked=true" "true" "$(echo "$DEL_RES" | jq -r '.revoked')"
MCP2_REVOKED=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/mcp" \
  -H "authorization: Bearer $AT2" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
ck "revoked client's live token immediately 401s on /mcp" "401" "$MCP2_REVOKED"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ] || exit 1
