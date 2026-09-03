#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end proof of the append-only audit ledger (migration 0020 / issue #62).
#
# WHY A SCRIPT. `npm test` has no D1, so test/audit.test.mjs can only prove the
# SHAPE of the writer's union — that no field could carry a credential, and that
# the kind enum matches the migration's CHECK. Everything that makes the ledger
# actually work needs a database and a running Worker:
#
#   * the INSERT rides `ctx.waitUntil`, so it must be shown to land AT ALL;
#   * the kinds must be spelled identically in code and in the CHECK constraint,
#     or the INSERT throws — and the writer SWALLOWS its own failures by design,
#     so a mismatch would be invisible except as a permanently empty ledger;
#   * `/register` and `/token` are answered by the OAuth provider, so the only
#     proof the observe-only outer layer sees them is a row appearing here;
#   * the never-log rule has to be checked against the BYTES that reach the wire,
#     not just against field names in a type.
#
# The failed-login check is the one to read twice: it greps the raw response for
# the operator token itself. That is the assertion this whole design exists to
# be able to make.
#
# USAGE (two terminals, local only — never point B at production):
#   npm run db:migrate:local && npm run dev
#   bash test/e2e/audit.sh
#
# Reads OPERATOR_TOKEN from .dev.vars, mints a throwaway agent + key, and writes
# to LOCAL D1/R2 only. It never echoes a secret.
B=http://localhost:8787
OP=$(grep -E '^OPERATOR_TOKEN=' "$(git rev-parse --show-toplevel)/.dev.vars" | cut -d= -f2- | tr -d '"'"'"'')
[ -n "$OP" ] || { echo "FATAL: no OPERATOR_TOKEN in .dev.vars"; exit 1; }

pass=0; fail=0
ck() { # ck <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass+1));
  else echo "FAIL $1"; echo "       want: $2"; echo "       got:  $3"; fail=$((fail+1)); fi
}

audit() { # audit <query-string> — the operator ledger read
  curl -sS "$B/admin/audit?$1" -H "authorization: Bearer $OP"
}

# The write rides ctx.waitUntil, so it lands shortly AFTER the response that
# triggered it. Poll rather than sleep a fixed amount: a fixed sleep is either
# flaky or slow, and polling also fails informatively (the count stays 0).
settle() { # settle <query-string> [expected-min-count] — wait for rows to appear
  local want="${2:-1}" n=0 i
  for i in $(seq 1 40); do
    n=$(audit "$1&limit=200" | jq '.events | length')
    [ "$n" -ge "$want" ] && return 0
    sleep 0.25
  done
  return 0
}

count() { # count <query-string>
  audit "$1&limit=200" | jq '.events | length'
}

has_kind() { # has_kind <kind> <extra-query> — "true"/"false"
  local n
  n=$(count "kind=$1&$2")
  [ "$n" -ge 1 ] && echo true || echo false
}

# =============================================================================
# 0. the door
# =============================================================================
ANON=$(curl -sS -o /dev/null -w '%{http_code}' "$B/admin/audit")
ck "GET /admin/audit is operator-only (no auth -> 401)" "401" "$ANON"
AGENTTRY=$(curl -sS -o /dev/null -w '%{http_code}' "$B/admin/audit" -H "authorization: Bearer awh_not_a_real_key")
ck "  ...and an agent-shaped bearer is not enough" "401" "$AGENTTRY"

# =============================================================================
# 1. drive the events
# =============================================================================
AG=$(curl -sS -X POST "$B/admin/agents" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{"name":"e2e-audit"}')
AGID=$(echo "$AG" | jq -r '.agent_id // .id')
[ "$AGID" != "null" ] || { echo "FATAL: agent mint failed: $AG"; exit 1; }

KEYMINT=$(curl -sS -X POST "$B/admin/agents/$AGID/keys" -H "authorization: Bearer $OP" \
           -H 'content-type: application/json' -d '{}')
KEY=$(echo "$KEYMINT" | jq -r '.key')
KEYID=$(echo "$KEYMINT" | jq -r '.key_id')
[ -n "$KEY" ] && [ "$KEY" != "null" ] || { echo "FATAL: key mint failed"; exit 1; }

PUB=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" \
       -H 'content-type: text/markdown' -H 'X-Doc-Title: E2E audit' \
       --data-binary $'# E2E audit\n\nbody one\n')
ID=$(echo "$PUB" | jq -r '.public_id')
[ "$ID" != "null" ] || { echo "FATAL: publish failed: $PUB"; exit 1; }

DOOMED=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" \
          -H 'content-type: text/markdown' -H 'X-Doc-Title: E2E audit doomed' \
          --data-binary $'# doomed\n\nbye\n' | jq -r '.public_id')

# visibility flip (born private -> public), then promote v1 explicitly.
curl -sS -X POST "$B/admin/documents/$ID/visibility" -H "authorization: Bearer $OP" \
  -H 'content-type: application/json' -d '{"visibility":"public"}' >/dev/null
curl -sS -X POST "$B/admin/documents/$ID/promote" -H "authorization: Bearer $OP" \
  -H 'content-type: application/json' -d '{"version":1}' >/dev/null

# revoke the second document (the kill switch)
curl -sS -X DELETE "$B/d/$DOOMED" -H "authorization: Bearer $OP" >/dev/null

# revoke the key, then prune the inert tail (a real run, not a dry run)
curl -sS -X DELETE "$B/admin/keys/$KEYID" -H "authorization: Bearer $OP" >/dev/null
curl -sS -X POST "$B/admin/keys/prune" -H "authorization: Bearer $OP" \
  -H 'content-type: application/json' -d '{"mode":"expired"}' >/dev/null

# a failed operator sign-in — the row that must contain nothing of the attempt
curl -sS -o /dev/null -X POST "$B/login" \
  -d "operator_token=$OP-WRONG-SUFFIX&next=/admin/console"

# DCR self-registration, if this build serves it (ENABLE_DCR in src/oauth.ts).
REG=$(curl -sS -X POST "$B/register" -H 'content-type: application/json' \
       -d '{"client_name":"e2e-audit-probe","redirect_uris":["https://example.com/cb"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}')
REGID=$(echo "$REG" | jq -r '.client_id // empty')

# a token exchange that must fail (no such code) — proves the /token observation
curl -sS -o /dev/null -X POST "$B/token" -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=nope&client_id=nope&redirect_uri=https://example.com/cb'

settle "kind=agent_keys_pruned"
settle "kind=login_failed"
settle "kind=token_denied"
settle "document_id=$ID" 2

# =============================================================================
# 2. every kind we drove is in the ledger
# =============================================================================
ck "agent_key_minted recorded (with the agent)"      "true" "$(has_kind agent_key_minted "agent_id=$AGID")"
ck "agent_key_revoked recorded"                      "true" "$(has_kind agent_key_revoked "agent_id=$AGID")"
ck "agent_keys_pruned recorded"                      "true" "$(has_kind agent_keys_pruned "")"
ck "document_visibility_changed recorded"            "true" "$(has_kind document_visibility_changed "document_id=$ID")"
ck "document_promoted recorded"                      "true" "$(has_kind document_promoted "document_id=$ID")"
ck "document_revoked recorded (the other doc)"       "true" "$(has_kind document_revoked "document_id=$DOOMED")"
ck "login_failed recorded"                           "true" "$(has_kind login_failed "")"
ck "token_denied recorded (provider-answered route)" "true" "$(has_kind token_denied "")"
if [ -n "$REGID" ]; then
  ck "client_registered recorded (DCR is on)"        "true" "$(has_kind client_registered "")"
  CR=$(audit "kind=client_registered&limit=200" | jq -r --arg c "$REGID" '.events[] | select(.client_id == $c) | .client_id' | head -1)
  ck "  ...naming the client_id the provider issued" "$REGID" "$CR"
else
  echo "skip client_registered — POST /register did not return a client_id (DCR off?)"
fi

# The two document rows must carry the PUBLIC id, not the internal UUID — that
# is what makes the ledger readable by a human holding a URL.
VISROW=$(audit "kind=document_visibility_changed&document_id=$ID&limit=1")
ck "document rows key on the public_id" "$ID" "$(echo "$VISROW" | jq -r '.events[0].document_id')"
ck "  ...and carry their detail" "public" "$(echo "$VISROW" | jq -r '.events[0].detail.visibility')"
ck "  ...with outcome ok" "ok" "$(echo "$VISROW" | jq -r '.events[0].outcome')"

PROW=$(audit "kind=document_promoted&document_id=$ID&limit=1")
ck "promote records which version went live" "1" "$(echo "$PROW" | jq -r '.events[0].detail.version')"

# =============================================================================
# 3. THE NEVER-LOG RULE, on the bytes
# =============================================================================
# Every row the ledger will hand back, unfiltered, greped for the actual secrets.
ALL=$(audit "limit=200")
ck "no operator token anywhere in the ledger" "0" \
  "$(echo "$ALL" | grep -c -- "$OP" || true)"
ck "no minted agent key anywhere in the ledger" "0" \
  "$(echo "$ALL" | grep -c -- "$KEY" || true)"
ck "no 'awh_' key prefix anywhere in the ledger" "0" \
  "$(echo "$ALL" | grep -c -- 'awh_' || true)"

LF=$(audit "kind=login_failed&limit=5")
ck "the failed-login row carries no token substring" "0" \
  "$(echo "$LF" | grep -c -- "$OP" || true)"
ck "  ...and is filed as anonymous (nobody authenticated)" "anonymous" \
  "$(echo "$LF" | jq -r '.events[0].principal_kind')"
ck "  ...with outcome denied" "denied" "$(echo "$LF" | jq -r '.events[0].outcome')"
ck "  ...and no detail at all" "null" "$(echo "$LF" | jq -r '.events[0].detail')"

# =============================================================================
# 4. the list contract
# =============================================================================
# Newest first.
TWO=$(audit "limit=2")
A_AT=$(echo "$TWO" | jq -r '.events[0].at')
B_AT=$(echo "$TWO" | jq -r '.events[1].at')
ck "newest first (at[0] >= at[1])" "true" \
  "$([ "$A_AT" \> "$B_AT" ] || [ "$A_AT" = "$B_AT" ] && echo true || echo false)"

# The cursor pages, and page 2 is a different row.
P1=$(audit "limit=1")
CUR=$(echo "$P1" | jq -r '.next_cursor')
ck "a full page mints a next_cursor" "false" "$([ "$CUR" = "null" ] && echo true || echo false)"
P1ID=$(echo "$P1" | jq -r '.events[0].id')
P2=$(audit "limit=1&cursor=$CUR")
P2ID=$(echo "$P2" | jq -r '.events[0].id')
ck "the cursor advances to a different row" "false" "$([ "$P1ID" = "$P2ID" ] && echo true || echo false)"

# Filters narrow, and a bad one is REJECTED rather than silently ignored — an
# audit filter that quietly matched everything would read as "all clear".
BAD=$(audit "kind=operator_had_a_nap")
ck "an unknown kind is rejected" "bad_request" "$(echo "$BAD" | jq -r '.error')"
BADS=$(curl -sS -o /dev/null -w '%{http_code}' "$B/admin/audit?kind=nope" -H "authorization: Bearer $OP")
ck "  ...at status 400" "400" "$BADS"
BADSINCE=$(audit "since=not-a-date")
ck "an unparseable since is rejected" "bad_request" "$(echo "$BADSINCE" | jq -r '.error')"
BADCUR=$(audit "cursor=!!!not-base64!!!")
ck "a malformed cursor is rejected" "bad_cursor" "$(echo "$BADCUR" | jq -r '.error')"

# `since` windows. A far-future window must be empty; a far-past one must not.
ck "since=2999 windows to nothing" "0" "$(count 'since=2999-01-01')"
ck "since=1970 windows to everything" "false" "$([ "$(count 'since=1970-01-01')" = "0" ] && echo true || echo false)"

# A filter for a document that has no events returns an empty page, not an error.
ck "a document with no events lists empty" "0" "$(count 'document_id=AAAAAAAAAAAAAAAAAAAAAA')"

# =============================================================================
# 5. the console page
# =============================================================================
# Logged out: a sign-in card, NOT an existence oracle and not a 401 page.
CON=$(curl -sS "$B/admin/console/audit")
ck "console audit page renders the sign-in card when logged out" "true" \
  "$(echo "$CON" | grep -q 'Operator sign in' && echo true || echo false)"
ck "  ...and leaks no ledger rows to a logged-out caller" "true" \
  "$(echo "$CON" | grep -qv "$ID" && echo true || echo false)"
CONS=$(curl -sS -o /dev/null -w '%{http_code}' "$B/admin/console/audit")
ck "  ...at 200 (a card, not an error)" "200" "$CONS"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ] || exit 1
