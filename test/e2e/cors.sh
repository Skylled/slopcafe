#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end proof of the cross-origin (CORS) surface: the preflight, the
# response-header stamping, the exclusions, and — above all — the absence of
# Access-Control-Allow-Credentials.
#
# WHY THIS EXISTS AS A SCRIPT. test/cors.test.mjs drives `withCors` directly
# against a stub inner handler, which pins the logic but proves nothing about
# the WRAPPER STACK. The order in src/index.ts is
# `wrapWithOAuth(withCors(withHeadSupport(innerHandler)))`, and only a running
# Worker can show that (a) the OAuth provider really does delegate the
# defaultHandler surface down to us rather than swallowing it, (b) our headers
# survive to the wire alongside the real route's own headers, and (c) the
# provider's separate CORS pass on /mcp doesn't collide with ours. Same reason
# published-version.sh and mcp-apps.sh exist: no D1/R2 harness in the unit suite.
#
# USAGE (two terminals, local only — never point this at production):
#   1. Add the test origin to wrangler.toml's [vars] and restart `npm run dev`:
#
#        CORS_ALLOWED_ORIGINS = "https://app.example"
#
#      (The wrapper is OFF when that var is unset, so without this step every
#      assertion below correctly reports "no CORS" and the script fails loudly
#      at check 0 rather than silently passing.)
#   2. npm run db:migrate:local && npm run dev
#   3. bash test/e2e/cors.sh
#
# Reads OPERATOR_TOKEN from .dev.vars and mints a throwaway agent + key. It
# writes to the LOCAL D1/R2 only, and never echoes a secret.
B=http://localhost:8787
ALLOWED=https://app.example
# The prefix-match attack: admitted by startsWith/includes, rejected by the
# exact match src/cors.ts implements.
EVIL=https://app.example.evil.test
OP=$(grep -E '^OPERATOR_TOKEN=' "$(git rev-parse --show-toplevel)/.dev.vars" | cut -d= -f2- | tr -d '"'"'"'')
[ -n "$OP" ] || { echo "FATAL: no OPERATOR_TOKEN in .dev.vars"; exit 1; }

pass=0; fail=0
ck() { # ck <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass+1));
  else echo "FAIL $1"; echo "       want: $2"; echo "       got:  $3"; fail=$((fail+1)); fi
}

# Response headers, lower-cased and stripped of CR, so a grep is stable across
# curl/HTTP versions.
heads() { curl -sS -D - -o /dev/null "$@" | tr -d '\r' | tr 'A-Z' 'a-z'; }
# The value of a single response header ("" when absent).
hval() { # hval <header-name> <curl args...>
  local name="$1"; shift
  heads "$@" | sed -n "s/^${name}: //p" | tail -n1
}

# --- 0. the wrapper is actually enabled --------------------------------------
# /healthz reports the CORS state, keyed on the caller's own Origin. If this
# check fails, CORS_ALLOWED_ORIGINS is unset or didn't parse — fix step 1 above
# before reading anything below, because a disabled wrapper makes every
# "no header" assertion pass for the wrong reason.
HZ=$(curl -sS -H "origin: $ALLOWED" "$B/healthz")
ck "healthz reports CORS enabled" "true" "$(echo "$HZ" | jq -r '.cors.enabled')"
ck "  ...and recognizes this origin" "true" "$(echo "$HZ" | jq -r '.cors.request_origin_allowed')"
ck "  ...echoing it canonicalized" "$ALLOWED" "$(echo "$HZ" | jq -r '.cors.request_origin')"
if [ "$(echo "$HZ" | jq -r '.cors.enabled')" != "true" ]; then
  echo "FATAL: CORS is off in this dev server — set CORS_ALLOWED_ORIGINS and restart"; exit 1
fi
# The same probe from the attacker origin: enabled, but not for you.
ck "healthz denies the prefix-match origin" "false" \
  "$(curl -sS -H "origin: $EVIL" "$B/healthz" | jq -r '.cors.request_origin_allowed')"

# --- credentials -------------------------------------------------------------
AG=$(curl -sS -X POST "$B/admin/agents" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{"name":"e2e-cors"}')
AGID=$(echo "$AG" | jq -r '.agent_id // .id')
KEY=$(curl -sS -X POST "$B/admin/agents/$AGID/keys" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{}' | jq -r '.key')
[ -n "$KEY" ] && [ "$KEY" != "null" ] || { echo "FATAL: key mint failed: $AG"; exit 1; }

PUB=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" \
       -H 'content-type: text/markdown' -H 'X-Doc-Title: E2E CORS' \
       --data-binary $'# E2E CORS\n\nbody\n')
ID=$(echo "$PUB" | jq -r '.public_id')
[ "$ID" != "null" ] || { echo "FATAL: publish failed: $PUB"; exit 1; }
echo "== credentials minted (agent $AGID), doc $ID published =="

# --- 1. THE RULE: no credentials header, anywhere ----------------------------
# Checked on every shape of response the wrapper can produce — preflight,
# allowed 200, denied 200, ineligible route, and a plain public read — because
# the rule is absolute and a single leaking path is the whole vulnerability.
# Written out rather than looped over a string, so no argument is at the mercy
# of word splitting (the Bearer value contains no space today, but a probe that
# silently degraded to a different request would pass for the wrong reason).
nocreds() { # nocreds <label> <curl args...>
  local label="$1"; shift
  ck "no allow-credentials: $label" "0" \
    "$(heads "$@" | grep -c '^access-control-allow-credentials:')"
}
nocreds "preflight (allowed origin)" -X OPTIONS -H "origin: $ALLOWED" \
  -H 'access-control-request-method: PUT' "$B/d/$ID"
nocreds "credentialed read (allowed origin)" -H "origin: $ALLOWED" \
  -H "authorization: Bearer $KEY" "$B/d/$ID/raw"
nocreds "read from a denied origin" -H "origin: $EVIL" \
  -H "authorization: Bearer $KEY" "$B/d/$ID/raw"
nocreds "an excluded console page" -H "origin: $ALLOWED" "$B/admin/console"
nocreds "the discovery endpoint" -H "origin: $ALLOWED" "$B/healthz"

# --- 2. the preflight --------------------------------------------------------
PF=$(heads -X OPTIONS -H "origin: $ALLOWED" \
      -H 'access-control-request-method: PUT' \
      -H 'access-control-request-headers: authorization, if-match, content-type' \
      "$B/d/$ID")
ck "preflight is 204" "1" "$(echo "$PF" | grep -c '^http/.* 204')"
ck "  ...allow-origin echoes the allowed origin" "1" \
  "$(echo "$PF" | grep -c "^access-control-allow-origin: $ALLOWED\$")"
ck "  ...advertises PUT" "1" "$(echo "$PF" | grep '^access-control-allow-methods:' | grep -c 'put')"
ck "  ...allows authorization" "1" "$(echo "$PF" | grep '^access-control-allow-headers:' | grep -c 'authorization')"
ck "  ...allows if-match" "1" "$(echo "$PF" | grep '^access-control-allow-headers:' | grep -c 'if-match')"
ck "  ...does NOT allow x-csrf-token" "0" \
  "$(echo "$PF" | grep '^access-control-allow-headers:' | grep -c 'x-csrf-token')"
ck "  ...sets a max-age" "1" "$(echo "$PF" | grep -c '^access-control-max-age:')"
ck "  ...varies on origin" "1" "$(echo "$PF" | grep '^vary:' | grep -c 'origin')"

# The attacker origin gets NO grant. It falls through to the ordinary 404 for
# an unrouted OPTIONS rather than a distinctive status — a distinct code here
# would be a free signal about which routes exist.
ck "preflight from the prefix-match origin gets no allow-origin" "0" \
  "$(heads -X OPTIONS -H "origin: $EVIL" -H 'access-control-request-method: PUT' "$B/d/$ID" \
     | grep -c '^access-control-allow-origin:')"

# --- 3. NOT an existence oracle ----------------------------------------------
# Same preflight against the live doc, a revoked one, and a nonexistent id. The
# wrapper answers before dispatch, so all three must be byte-identical.
DEAD=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" \
        -H 'content-type: text/markdown' --data-binary $'# gone\n' | jq -r '.public_id')
curl -sS -X DELETE "$B/d/$DEAD" -H "authorization: Bearer $OP" >/dev/null
GHOST=AAAAAAAAAAAAAAAAAAAAAA
sig() { heads -X OPTIONS -H "origin: $ALLOWED" -H 'access-control-request-method: GET' \
          "$B/d/$1/raw" | grep -v '^date:' | sort; }
A=$(sig "$ID"); D=$(sig "$DEAD"); G=$(sig "$GHOST")
ck "preflight for a live vs revoked doc is identical" "same" \
  "$([ "$A" = "$D" ] && echo same || echo DIFFERENT)"
ck "preflight for a live vs nonexistent doc is identical" "same" \
  "$([ "$A" = "$G" ] && echo same || echo DIFFERENT)"

# --- 4. the actual request: headers a browser can read -----------------------
RAW=$(heads -H "origin: $ALLOWED" -H "authorization: Bearer $KEY" "$B/d/$ID/raw")
ck "GET /raw carries allow-origin" "1" \
  "$(echo "$RAW" | grep -c "^access-control-allow-origin: $ALLOWED\$")"
ck "  ...exposes etag" "1" "$(echo "$RAW" | grep '^access-control-expose-headers:' | grep -c 'etag')"
ck "  ...exposes x-doc-current-version" "1" \
  "$(echo "$RAW" | grep '^access-control-expose-headers:' | grep -c 'x-doc-current-version')"
ck "  ...and that header is actually present (credentialed caller)" "1" \
  "$(echo "$RAW" | grep -c '^x-doc-current-version:')"
ck "  ...varies on origin" "1" "$(echo "$RAW" | grep '^vary:' | grep -c 'origin')"

# /text emits `Vary: Accept` of its own; the wrapper must APPEND, not clobber —
# a lost `Accept` would let a cache serve the JSON envelope for a markdown
# request (or vice versa).
TXT=$(heads -H "origin: $ALLOWED" -H "authorization: Bearer $KEY" \
       -H 'accept: application/json' "$B/d/$ID/text")
ck "/text still varies on accept" "1" "$(echo "$TXT" | grep '^vary:' | grep -c 'accept')"
ck "  ...and now also on origin" "1" "$(echo "$TXT" | grep '^vary:' | grep -c 'origin')"
ck "  ...exposing the converter/sanitizer stamps" "1" \
  "$(echo "$TXT" | grep '^access-control-expose-headers:' | grep -c 'x-converter-version')"

# A denied origin gets the response (CORS is enforced in the browser, not by
# us withholding bytes) but NO allow-origin, so the browser blocks it.
ck "denied origin gets no allow-origin on a real request" "0" \
  "$(heads -H "origin: $EVIL" -H "authorization: Bearer $KEY" "$B/d/$ID/raw" \
     | grep -c '^access-control-allow-origin:')"

# --- 5. the exclusions -------------------------------------------------------
# Cookie/HTML/operator-form surfaces get nothing, even from the allowed origin.
for P in /admin/console /admin/console/agents /login /logout /authorize "/d/$ID/manage" "/d/$ID/revoke" /; do
  ck "excluded: $P" "0" \
    "$(heads -H "origin: $ALLOWED" "$B$P" | grep -c '^access-control-allow-origin:')"
done
# The manage page's HTML form POST is excluded while its JSON twin is not —
# the method split is the whole reason isCorsEligible takes a method.
ck "excluded: POST /d/:id/tags (manage form)" "0" \
  "$(heads -X OPTIONS -H "origin: $ALLOWED" -H 'access-control-request-method: POST' \
     "$B/d/$ID/tags" | grep -c '^access-control-allow-origin:')"
ck "included: PUT /d/:id/tags (JSON twin)" "1" \
  "$(heads -X OPTIONS -H "origin: $ALLOWED" -H 'access-control-request-method: PUT' \
     "$B/d/$ID/tags" | grep -c '^access-control-allow-origin:')"

# --- 6. the operator JSON API is reachable, the console is not ---------------
ck "included: GET /admin/documents" "1" \
  "$(heads -H "origin: $ALLOWED" -H "authorization: Bearer $OP" "$B/admin/documents" \
     | grep -c "^access-control-allow-origin: $ALLOWED\$")"
ck "included: GET /openapi.json" "1" \
  "$(heads -H "origin: $ALLOWED" "$B/openapi.json" | grep -c '^access-control-allow-origin:')"

# --- 7. /mcp belongs to the OAuth provider, not to us ------------------------
# The provider answers /mcp upstream of our wrapper and applies its OWN CORS
# (origin-reflecting, and — importantly — credential-free). What must NOT
# happen is two layers both writing allow-origin: a duplicated header is a hard
# browser failure. Exactly one, and still no credentials.
MCP=$(heads -X OPTIONS -H "origin: $ALLOWED" -H 'access-control-request-method: POST' "$B/mcp")
ck "/mcp emits exactly one allow-origin (no double-stamp)" "1" \
  "$(echo "$MCP" | grep -c '^access-control-allow-origin:')"
ck "/mcp emits no allow-credentials either" "0" \
  "$(echo "$MCP" | grep -c '^access-control-allow-credentials:')"

# --- 8. a request with no Origin is untouched --------------------------------
# The overwhelming majority of traffic (agents, curl, the CLI). The wrapper must
# add nothing at all to it.
ck "no Origin header: no CORS headers added" "0" \
  "$(heads -H "authorization: Bearer $KEY" "$B/d/$ID/raw" | grep -c '^access-control-')"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ] || exit 1
