#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end proof of the publication gate (migration 0018 / GitHub issue #43).
#
# WHY THIS EXISTS AS A SCRIPT. The unit suite has no D1 harness, so the pieces
# that make the gate real — the render-path join, the write cores, revoke, the
# admin routes — are only exercised against a running Worker. This is the
# security boundary of the whole platform: if `servedVersion` ever resolves to
# `current_ver` on a public document, any agent key can publish private content
# to the anonymous internet with one ordinary authorized PUT. That deserves a
# re-runnable proof, not a procedure someone followed once.
#
# USAGE (two terminals, local only — never point B at production):
#   npm run db:migrate:local && npm run dev
#   bash test/e2e/published-version.sh
#
# Reads OPERATOR_TOKEN from .dev.vars and mints a throwaway agent + key. It
# writes to the LOCAL D1/R2 only, and never echoes a secret.
B=http://localhost:8787
OP=$(grep -E '^OPERATOR_TOKEN=' "$(git rev-parse --show-toplevel)/.dev.vars" | cut -d= -f2- | tr -d '"'"'"'')
[ -n "$OP" ] || { echo "FATAL: no OPERATOR_TOKEN in .dev.vars"; exit 1; }

pass=0; fail=0
ck() { # ck <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass+1));
  else echo "FAIL $1"; echo "       want: $2"; echo "       got:  $3"; fail=$((fail+1)); fi
}

# --- credentials -------------------------------------------------------------
AG=$(curl -sS -X POST "$B/admin/agents" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{"name":"e2e-43"}')
AGID=$(echo "$AG" | jq -r '.agent_id // .id')
KEY=$(curl -sS -X POST "$B/admin/agents/$AGID/keys" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{}' | jq -r '.key')
[ -n "$KEY" ] && [ "$KEY" != "null" ] || { echo "FATAL: key mint failed: $AG"; exit 1; }
echo "== credentials minted (agent $AGID) =="

# --- 1. publish (born private) ----------------------------------------------
PUB=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" \
       -H 'content-type: text/markdown' -H 'X-Doc-Title: E2E 43' \
       --data-binary $'# E2E 43\n\nVERSION ONE BODY\n')
ID=$(echo "$PUB" | jq -r '.public_id')
[ "$ID" != "null" ] || { echo "FATAL: publish failed: $PUB"; exit 1; }
echo "== doc $ID published =="

# Pointer assertions read D1 DIRECTLY rather than through an admin route: they
# are claims about stored state, and routing them through a JSON surface would
# make the test also depend on which route happens to expose which column (the
# first draft of this script asserted against `GET /admin/documents/:id`, which
# did not exist at the time — every pointer check "passed" as null while the
# feature was in fact working). That route EXISTS now, and this still does not
# use it: a stored-state claim should not be mediated by a projection that can
# change. D1 is the authority; HTTP is used only for behaviour.
col() { # col <public_id> <column>
  npx wrangler d1 execute agent-web-host-meta --local --json \
    --command "select $2 as v from documents where public_id = '$1'" 2>/dev/null \
    | jq -r '.[0].results[0].v'
}

ck "born private -> published_ver null" "null" "$(col "$ID" published_ver)"

# --- 2. flip public: coalesce publishes current ------------------------------
curl -sS -X POST "$B/admin/documents/$ID/visibility" -H "authorization: Bearer $OP" \
  -H 'content-type: application/json' -d '{"visibility":"public"}' >/dev/null
ck "flip to public publishes current (v1)" "1" "$(col "$ID" published_ver)"

# --- 3. agent writes v2 -------------------------------------------------------
curl -sS -X PUT "$B/d/$ID" -H "authorization: Bearer $KEY" -H 'If-Match: *' \
  -H 'content-type: text/markdown' \
  --data-binary $'# E2E 43\n\nVERSION TWO SECRET BODY\n' >/dev/null
ck "agent write bumped current_ver" "2" "$(col "$ID" current_ver)"
ck "agent write did NOT move published_ver" "1" "$(col "$ID" published_ver)"

# --- 4. THE SECURITY ASSERTION -----------------------------------------------
ANON=$(curl -sS "$B/d/$ID/raw")
echo "$ANON" | grep -q "VERSION TWO SECRET BODY" && LEAK=LEAKED || LEAK=contained
ck "anonymous /raw does NOT serve the agent's new bytes" "contained" "$LEAK"
echo "$ANON" | grep -q "VERSION ONE BODY" && SRV=v1 || SRV=other
ck "anonymous /raw serves the PUBLISHED bytes" "v1" "$SRV"

AH=$(curl -sS -D - -o /dev/null "$B/d/$ID/raw")
ck "anonymous ETag names the served version" '"v1"' "$(echo "$AH" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')"
ck "anonymous gets NO x-doc-current-version" "" "$(echo "$AH" | tr -d '\r' | awk 'tolower($1)=="x-doc-current-version:"{print $2}')"

# --- 5. the rule has no principal term ---------------------------------------
CH=$(curl -sS -D - -o /tmp/cred.html "$B/d/$ID/raw" -H "authorization: Bearer $KEY")
grep -q "VERSION ONE BODY" /tmp/cred.html && CSRV=v1 || CSRV=other
ck "credentialed /raw ALSO serves published (uniform rule)" "v1" "$CSRV"
ck "credentialed gets x-doc-current-version: 2" "2" "$(echo "$CH" | tr -d '\r' | awk 'tolower($1)=="x-doc-current-version:"{print $2}')"

# --- 6. machine surfaces stay on current -------------------------------------
curl -sS "$B/d/$ID/text" -H "authorization: Bearer $KEY" | grep -q "VERSION TWO SECRET BODY" \
  && TSRV=current || TSRV=other
ck "/text stays on current_ver (working copy)" "current" "$TSRV"

# --- 7. slug lock -------------------------------------------------------------
SL=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$B/d/$ID" -H "authorization: Bearer $KEY" \
      -H 'If-Match: *' -H 'content-type: text/markdown' -H 'X-Doc-Slug: e2e-43-rename' \
      --data-binary $'# E2E 43\n\nbody\n')
ck "agent slug change on a PUBLIC doc is refused" "403" "$SL"
SLB=$(curl -sS -X PUT "$B/d/$ID" -H "authorization: Bearer $KEY" -H 'If-Match: *' \
       -H 'content-type: text/markdown' -H 'X-Doc-Slug: e2e-43-rename2' \
       --data-binary $'# E2E 43\n\nbody\n' | jq -r '.error')
ck "  ...with code slug_locked" "slug_locked" "$SLB"

# --- 8. promote ---------------------------------------------------------------
PR=$(curl -sS -X POST "$B/admin/documents/$ID/promote" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{"version":2}')
ck "promote returns the new published_ver" "2" "$(echo "$PR" | jq -r '.published_ver')"
curl -sS "$B/d/$ID/raw" | grep -q "VERSION TWO SECRET BODY" && P2=v2 || P2=other
ck "anonymous /raw now serves v2" "v2" "$P2"
ck "promote 404 carries version context" "3" \
  "$(curl -sS -X POST "$B/admin/documents/$ID/promote" -H "authorization: Bearer $OP" \
     -H 'content-type: application/json' -d '{"version":3}' | jq -r '.version')"

# --- 9. manage-page Publish button is actually routed (finding F1) ------------
MP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/d/$ID/promote" \
      -F "operator_token=$OP" -F "version=1")
ck "POST /d/:id/promote is routed (not 404)" "200" "$MP"
ck "  ...and it moved published_ver back to 1" "1" "$(col "$ID" published_ver)"

# --- 10. born-public binds published_ver at birth (the audit's FAILURE 1) -----
BP=$(curl -sS -X POST "$B/admin/documents" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' \
      -d '{"content":"# born public\n\nbody","format":"markdown","visibility":"public"}')
BPID=$(echo "$BP" | jq -r '.public_id')
ck "doc BORN public is pinned at birth" "1" \
  "$(col "$BPID" published_ver)"

# --- 11. revoke nulls the pointer --------------------------------------------
curl -sS -X DELETE "$B/d/$ID" -H "authorization: Bearer $OP" >/dev/null
ck "revoke nulls published_ver" "null" "$(col "$ID" published_ver)"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ] || exit 1
