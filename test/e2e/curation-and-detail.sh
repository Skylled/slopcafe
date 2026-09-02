#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end proof of the three 2.0 changes that have no unit coverage:
#   1. `version_not_found` as a first-class JSON error code (the break) —
#      POST /admin/documents/:id/{restore,promote}
#   2. GET /admin/documents/:public_id — the operator single-document read
#   3. the agent-door curation writes behind the new MCP tools
#      (`set_document_tags` / `set_document_status` call the same cores as
#       PUT /d/:id/{tags,status}, which is what this drives — /mcp itself needs
#       a JSON-RPC session, so the cores are exercised through their HTTP twins)
#
# WHY A SCRIPT. Same reason as published-version.sh: there is no D1 harness in
# `npm test`, so every one of these paths — the error discriminant, the route
# dispatch, the no-version-bump property — is otherwise proven only by reading
# the code. The dispatch case in particular has a failure mode no unit test can
# see: GET /admin/documents/search matches the new route's shape, so a guard
# regression turns operator search into a confident, wrong 404.
#
# USAGE (two terminals, local only — never point B at production):
#   npm run db:migrate:local && npm run dev
#   bash test/e2e/curation-and-detail.sh
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

col() { # col <public_id> <column> — D1 is the authority for stored-state claims
  npx wrangler d1 execute META --local --json \
    --command "select $2 as v from documents where public_id = '$1'" 2>/dev/null \
    | jq -r '.[0].results[0].v'
}

# --- credentials -------------------------------------------------------------
AG=$(curl -sS -X POST "$B/admin/agents" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{"name":"e2e-curation"}')
AGID=$(echo "$AG" | jq -r '.agent_id // .id')
KEY=$(curl -sS -X POST "$B/admin/agents/$AGID/keys" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{}' | jq -r '.key')
[ -n "$KEY" ] && [ "$KEY" != "null" ] || { echo "FATAL: key mint failed: $AG"; exit 1; }

PUB=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" \
       -H 'content-type: text/markdown' -H 'X-Doc-Title: E2E curation' \
       -H 'X-Doc-Tags: alpha,beta' \
       --data-binary $'# E2E curation\n\nbody one\n')
ID=$(echo "$PUB" | jq -r '.public_id')
[ "$ID" != "null" ] || { echo "FATAL: publish failed: $PUB"; exit 1; }

# A second live document, to be a valid `superseded_by` target.
OTHER=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" \
         -H 'content-type: text/markdown' -H 'X-Doc-Title: E2E successor' \
         --data-binary $'# E2E successor\n\nreplacement\n' | jq -r '.public_id')
echo "== doc $ID published (successor $OTHER) =="

# =============================================================================
# 1. version_not_found — the break
# =============================================================================
# The document is live and has exactly one version, so v99 is the "document
# exists, that version does not" case. Both routes must now name it distinctly.
PROMO=$(curl -sS -X POST "$B/admin/documents/$ID/promote" -H "authorization: Bearer $OP" \
         -H 'content-type: application/json' -d '{"version":99}')
ck "promote: unknown version -> version_not_found" "version_not_found" "$(echo "$PROMO" | jq -r '.error')"
ck "  ...and the body carries the version" "99" "$(echo "$PROMO" | jq -r '.version')"
PROMO_S=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/admin/documents/$ID/promote" \
           -H "authorization: Bearer $OP" -H 'content-type: application/json' -d '{"version":99}')
ck "  ...at status 404 (class unchanged by the split)" "404" "$PROMO_S"

REST=$(curl -sS -X POST "$B/admin/documents/$ID/restore" -H "authorization: Bearer $OP" \
        -H 'content-type: application/json' -d '{"version":99}')
ck "restore: unknown version -> version_not_found" "version_not_found" "$(echo "$REST" | jq -r '.error')"
ck "  ...and the body carries the version" "99" "$(echo "$REST" | jq -r '.version')"

# The OTHER miss must stay plain `not_found` with NO version field — that is the
# half of the break that makes the discriminant meaningful.
GONE=$(curl -sS -X POST "$B/admin/documents/AAAAAAAAAAAAAAAAAAAAAA/promote" \
        -H "authorization: Bearer $OP" -H 'content-type: application/json' -d '{"version":1}')
ck "promote: unknown DOCUMENT stays not_found" "not_found" "$(echo "$GONE" | jq -r '.error')"
ck "  ...and carries no version field" "null" "$(echo "$GONE" | jq -r '.version')"

# A non-integer version must still be rejected at the handler, BEFORE the core —
# the core returns version_not_found for a bad shape without a DB read, so a
# dropped guard would assert a nonexistent document exists.
BADV=$(curl -sS -X POST "$B/admin/documents/AAAAAAAAAAAAAAAAAAAAAA/promote" \
        -H "authorization: Bearer $OP" -H 'content-type: application/json' -d '{"version":0}')
ck "promote: version 0 is a bad_request, not version_not_found" "bad_request" "$(echo "$BADV" | jq -r '.error')"

# =============================================================================
# 2. GET /admin/documents/:public_id
# =============================================================================
DET=$(curl -sS "$B/admin/documents/$ID" -H "authorization: Bearer $OP")
ck "detail: returns the row BARE (public_id at top level)" "$ID" "$(echo "$DET" | jq -r '.public_id')"
ck "detail: carries the listing projection (current_ver)" "1" "$(echo "$DET" | jq -r '.current_ver')"
ck "detail: not wrapped in a 'document' key" "null" "$(echo "$DET" | jq -r '.document // "null"')"

DET_401=$(curl -sS -o /dev/null -w '%{http_code}' "$B/admin/documents/$ID")
ck "detail: unauthenticated -> 401" "401" "$DET_401"
DET_404=$(curl -sS "$B/admin/documents/AAAAAAAAAAAAAAAAAAAAAA" -H "authorization: Bearer $OP")
ck "detail: unknown id -> not_found" "not_found" "$(echo "$DET_404" | jq -r '.error')"

# THE DISPATCH REGRESSION GUARD. /admin/documents/search is a GET whose remainder
# contains no slash, so it matches the detail route's shape exactly. If the
# `!== "search"` term is ever dropped AND the block moves above the exact-match
# check, this returns a 404 that claims "search" is not a public_id.
SEARCH=$(curl -sS "$B/admin/documents/search?q=curation" -H "authorization: Bearer $OP")
ck "operator search is NOT swallowed by the detail route" "false" \
  "$(echo "$SEARCH" | jq -r 'has("error")')"

# =============================================================================
# 3. curation: the cores behind set_document_tags / set_document_status
# =============================================================================
# Full REPLACEMENT, and the response echoes the SANITIZED stored list. "b a d!"
# strips to "bad"; the 40-char tag truncates to 32.
LONG=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TAGS=$(curl -sS -X PUT "$B/d/$ID/tags" -H "authorization: Bearer $KEY" \
        -H 'content-type: application/json' -d "{\"tags\":[\"gamma\",\"b a d!\",\"$LONG\"]}")
ck "tags: agent door accepts the write" "gamma" "$(echo "$TAGS" | jq -r '.tags[0]')"
ck "tags: full replacement drops the old set" "false" \
  "$(echo "$TAGS" | jq -r '.tags | contains(["alpha"])')"
ck "tags: invalid chars stripped, not rejected" "bad" "$(echo "$TAGS" | jq -r '.tags[1]')"
ck "tags: over-long tag truncated to 32" "32" "$(echo "$TAGS" | jq -r '.tags[2] | length')"
ck "tags: NO version bump" "1" "$(col "$ID" current_ver)"

# status: valid successor, self-reference, and a slug (never accepted there).
ST=$(curl -sS -X PUT "$B/d/$ID/status" -H "authorization: Bearer $KEY" \
      -H 'content-type: application/json' \
      -d "{\"status\":\"deprecated\",\"superseded_by\":\"$OTHER\"}")
ck "status: deprecate with a live successor" "deprecated" "$(echo "$ST" | jq -r '.status')"
ck "  ...stores the pointer" "$OTHER" "$(echo "$ST" | jq -r '.superseded_by')"
ck "status: NO version bump" "1" "$(col "$ID" current_ver)"

SELF=$(curl -sS -X PUT "$B/d/$ID/status" -H "authorization: Bearer $KEY" \
        -H 'content-type: application/json' \
        -d "{\"status\":\"deprecated\",\"superseded_by\":\"$ID\"}")
ck "status: self-supersede -> bad_target" "bad_target" "$(echo "$SELF" | jq -r '.error')"

SLUGT=$(curl -sS -X PUT "$B/d/$ID/status" -H "authorization: Bearer $KEY" \
         -H 'content-type: application/json' \
         -d '{"status":"deprecated","superseded_by":"some-slug-not-an-id"}')
ck "status: a SLUG as superseded_by -> bad_target" "bad_target" "$(echo "$SLUGT" | jq -r '.error')"

BACK=$(curl -sS -X PUT "$B/d/$ID/status" -H "authorization: Bearer $KEY" \
        -H 'content-type: application/json' -d '{"status":"active"}')
ck "status: back to active clears the pointer" "null" "$(echo "$BACK" | jq -r '.superseded_by')"

# Both curation writes must have moved updated_at without touching versions —
# that is the whole reason updated_at lives on `documents`.
ck "curation stamped updated_at (not 1970)" "false" \
  "$(col "$ID" updated_at | grep -q '^1970' && echo true || echo false)"

# The line these tools must NOT cross: an agent still cannot flip visibility.
VIS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/admin/documents/$ID/visibility" \
       -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
       -d '{"visibility":"public"}')
ck "agent key still CANNOT change visibility" "401" "$VIS"

# --- detail view of a REVOKED doc (deliberately returned, not 404) ------------
curl -sS -X DELETE "$B/d/$OTHER" -H "authorization: Bearer $OP" >/dev/null
REV=$(curl -sS "$B/admin/documents/$OTHER" -H "authorization: Bearer $OP")
ck "detail: revoked doc is RETURNED, like the list" "$OTHER" "$(echo "$REV" | jq -r '.public_id')"
ck "  ...with revoked_at set" "false" "$(echo "$REV" | jq -r '.revoked_at == null')"
ck "  ...and null-degraded version fields" "null" "$(echo "$REV" | jq -r '.current_ver')"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ] || exit 1
