#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end proof of the identical-write no-op collapse (contract 2.1.0).
#
# WHY THIS EXISTS AS A SCRIPT. The gate lives inside `updateDocumentCore`, which
# needs D1 + R2 + the WASM sanitizer; the unit suite has no D1 harness, so
# `npm test` cannot execute a single line of it. What the unit suite DOES cover
# is the shape (`test/contract.test.mjs` pins `unchanged` as required) — which
# would stay green if the gate never fired, or fired when it must not.
#
# The dangerous direction is a FALSE collapse: suppressing a write that carried
# a real change silently loses an agent's edit while reporting success. Most of
# the checks below are therefore "this must NOT collapse" — one per field that
# participates in the identity test.
#
# USAGE (two terminals, local only — never point B at production):
#   npm run db:migrate:local && npm run dev
#   bash test/e2e/no-op-collapse.sh
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

# Stored-state claims read D1 directly — same discipline as published-version.sh:
# a claim about what is stored should not be mediated by a route's projection.
col() { # col <public_id> <column>
  npx wrangler d1 execute agent-web-host-meta --local --json \
    --command "select $2 as v from documents where public_id = '$1'" 2>/dev/null \
    | jq -r '.[0].results[0].v'
}
vercount() { # vercount <public_id> — rows actually appended to `versions`
  npx wrangler d1 execute agent-web-host-meta --local --json \
    --command "select count(*) as v from versions v join documents d on d.id = v.document_id where d.public_id = '$1'" 2>/dev/null \
    | jq -r '.[0].results[0].v'
}

# --- credentials -------------------------------------------------------------
AG=$(curl -sS -X POST "$B/admin/agents" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{"name":"e2e-noop"}')
AGID=$(echo "$AG" | jq -r '.agent_id // .id')
KEY=$(curl -sS -X POST "$B/admin/agents/$AGID/keys" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{}' | jq -r '.key')
[ -n "$KEY" ] && [ "$KEY" != "null" ] || { echo "FATAL: key mint failed: $AG"; exit 1; }
echo "== credentials minted (agent $AGID) =="

BODY=$'# No-op E2E\n\nTHE ORIGINAL BODY\n'
put() { # put <body> [extra curl args…] — update as the agent, If-Match: *
  local body="$1"; shift
  curl -sS -X PUT "$B/d/$ID" -H "authorization: Bearer $KEY" -H 'If-Match: *' \
    -H 'content-type: text/markdown' "$@" --data-binary "$body"
}

# --- 1. publish is never collapsed -------------------------------------------
P1=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" \
      -H 'content-type: text/markdown' -H 'X-Doc-Title: No-op E2E' \
      --data-binary "$BODY")
ID=$(echo "$P1" | jq -r '.public_id')
[ "$ID" != "null" ] || { echo "FATAL: publish failed: $P1"; exit 1; }
ck "publish reports unchanged:false" "false" "$(echo "$P1" | jq -r '.unchanged')"

# A SECOND publish of byte-identical content must mint a SECOND document —
# publish has no prior version to be identical to, and two documents holding
# the same bytes are legitimate.
P2=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" \
      -H 'content-type: text/markdown' -H 'X-Doc-Title: No-op E2E' \
      --data-binary "$BODY")
ck "identical publish is a NEW document, not a collapse" "false" \
  "$(echo "$P2" | jq -r '.public_id == "'"$ID"'"')"
echo "== doc $ID published =="

# --- 2. the collapse itself ---------------------------------------------------
# Same bytes, same (inherited) metadata: nothing should be stored.
R=$(put "$BODY")
ck "identical re-write reports unchanged:true" "true" "$(echo "$R" | jq -r '.unchanged')"
ck "  ...and reports the version already there" "1" "$(echo "$R" | jq -r '.version')"
ck "  ...and appended NO version row" "1" "$(vercount "$ID")"
ck "  ...and left current_ver alone" "1" "$(col "$ID" current_ver)"

# The whole point of the exercise that prompted this: a write loop cannot
# inflate the history no matter how many times it fires.
for _ in 1 2 3 4 5; do put "$BODY" >/dev/null; done
ck "five more identical writes still leave one version" "1" "$(vercount "$ID")"

# `updated_at` must NOT move: it is the change feed, and a no-op is not a change.
U_BEFORE=$(col "$ID" updated_at)
put "$BODY" >/dev/null
ck "a collapsed write does not touch updated_at" "$U_BEFORE" "$(col "$ID" updated_at)"

# --- 3. a real content change must NOT collapse ------------------------------
R=$(put $'# No-op E2E\n\nA GENUINELY DIFFERENT BODY\n')
ck "changed body writes normally" "false" "$(echo "$R" | jq -r '.unchanged')"
ck "  ...and advances the version" "2" "$(echo "$R" | jq -r '.version')"
ck "  ...and appended a version row" "2" "$(vercount "$ID")"

# --- 4. metadata-only changes must NOT collapse ------------------------------
# The gate is all-or-nothing on purpose: title/description are per-version, so a
# metadata-only edit is a real change that must mint a version. Each of these
# re-sends the SAME body, so only the metadata field distinguishes them — if any
# collapses, `unchanged` is lying about what was stored.
BODY2=$'# No-op E2E\n\nA GENUINELY DIFFERENT BODY\n'
R=$(put "$BODY2" -H 'X-Doc-Title: A New Title')
ck "title-only change writes a version" "false" "$(echo "$R" | jq -r '.unchanged')"

R=$(put "$BODY2" -H 'X-Doc-Title: A New Title' -H 'X-Doc-Description: A new description')
ck "description-only change writes a version" "false" "$(echo "$R" | jq -r '.unchanged')"

R=$(put "$BODY2" -H 'X-Doc-Title: A New Title' -H 'X-Doc-Description: A new description' \
       -H 'X-Doc-Tags: alpha,beta')
ck "tags-only change writes a version" "false" "$(echo "$R" | jq -r '.unchanged')"

R=$(put "$BODY2" -H 'X-Doc-Title: A New Title' -H 'X-Doc-Description: A new description' \
       -H 'X-Doc-Tags: alpha,beta' -H 'X-Doc-Slug: noop-e2e-doc')
ck "slug-only change writes a version" "false" "$(echo "$R" | jq -r '.unchanged')"

# ...and now that all four match again, the very same request collapses.
R=$(put "$BODY2" -H 'X-Doc-Title: A New Title' -H 'X-Doc-Description: A new description' \
       -H 'X-Doc-Tags: alpha,beta' -H 'X-Doc-Slug: noop-e2e-doc')
ck "re-sending that exact state now collapses" "true" "$(echo "$R" | jq -r '.unchanged')"
ck "  ...and the echoed slug survived the no-op" "noop-e2e-doc" "$(echo "$R" | jq -r '.slug')"
ck "  ...and the echoed tags survived the no-op" "alpha" "$(echo "$R" | jq -r '.tags[0]')"

# Re-ordering tags is a real change (order is what gets stored).
R=$(put "$BODY2" -H 'X-Doc-Title: A New Title' -H 'X-Doc-Description: A new description' \
       -H 'X-Doc-Tags: beta,alpha' -H 'X-Doc-Slug: noop-e2e-doc')
ck "re-ordered tags write a version" "false" "$(echo "$R" | jq -r '.unchanged')"

# --- 5. a cross-format re-write must NOT collapse ----------------------------
# Same characters, different source_format: the stored source and the pipeline
# both differ, so this is a real write even though the text looks identical.
R=$(curl -sS -X PUT "$B/d/$ID" -H "authorization: Bearer $KEY" -H 'If-Match: *' \
     -H 'content-type: text/html' -H 'X-Doc-Title: A New Title' \
     -H 'X-Doc-Description: A new description' -H 'X-Doc-Tags: beta,alpha' \
     -H 'X-Doc-Slug: noop-e2e-doc' --data-binary "$BODY2")
ck "same bytes as HTML instead of Markdown writes a version" "false" \
  "$(echo "$R" | jq -r '.unchanged')"

# --- 6. the gate does not swallow a version conflict -------------------------
# A stale base must still conflict even though the resulting bytes would match:
# the conflict is about the base revision, not the outcome.
CUR=$(col "$ID" current_ver)
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$B/d/$ID" \
        -H "authorization: Bearer $KEY" -H 'If-Match: "v1"' \
        -H 'content-type: text/html' --data-binary "$BODY2")
ck "stale If-Match still 412s on an otherwise-identical write" "412" "$CODE"
ck "  ...and stored nothing" "$CUR" "$(col "$ID" current_ver)"

# --- 7. the gate does not bypass the public-slug lock ------------------------
# slug_locked must fire ahead of any collapse: a rename is refused, not
# silently absorbed. (Re-sending the SAME slug stays a clean no-op.)
curl -sS -X POST "$B/admin/documents/$ID/visibility" -H "authorization: Bearer $OP" \
  -H 'content-type: application/json' -d '{"visibility":"public"}' >/dev/null
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$B/d/$ID" \
        -H "authorization: Bearer $KEY" -H 'If-Match: *' -H 'content-type: text/html' \
        -H 'X-Doc-Slug: noop-e2e-renamed' --data-binary "$BODY2")
ck "agent rename of a public doc still 403s" "403" "$CODE"

# --- 8. the gate compares current_ver, NOT published_ver ---------------------
# The doc is public and pinned at some published version; write a NEW body so
# current_ver moves ahead of published_ver, then re-send the PUBLISHED version's
# bytes. That must NOT collapse — it differs from current, which is the working
# copy the gate is about.
curl -sS -X POST "$B/admin/documents/$ID/promote" -H "authorization: Bearer $OP" \
  -H 'content-type: application/json' -d '{"version":1}' >/dev/null
ck "published_ver parked at v1" "1" "$(col "$ID" published_ver)"
R=$(curl -sS -X PUT "$B/d/$ID" -H "authorization: Bearer $KEY" -H 'If-Match: *' \
     -H 'content-type: text/markdown' --data-binary "$BODY")
ck "re-writing the PUBLISHED body is a real write (gate reads current_ver)" "false" \
  "$(echo "$R" | jq -r '.unchanged')"
ck "  ...and did not move published_ver" "1" "$(col "$ID" published_ver)"

# --- 9. the operator write door collapses the same way -----------------------
OD=$(curl -sS -X POST "$B/admin/documents" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' \
      -d '{"content":"# operator doc\n\nbody","format":"markdown"}')
OID=$(echo "$OD" | jq -r '.public_id')
R=$(curl -sS -X PUT "$B/admin/documents/$OID" -H "authorization: Bearer $OP" \
     -H 'content-type: application/json' \
     -d '{"content":"# operator doc\n\nbody","format":"markdown"}')
ck "operator door collapses an identical re-write" "true" "$(echo "$R" | jq -r '.unchanged')"
ck "  ...and appended no version" "1" "$(vercount "$OID")"

# --- 10. restore of the current version collapses ----------------------------
# restoreVersionCore delegates to updateDocumentCore, so restoring a version
# whose source already matches current must not mint an identical copy.
R=$(curl -sS -X POST "$B/admin/documents/$OID/restore" -H "authorization: Bearer $OP" \
     -H 'content-type: application/json' -d '{"version":1}')
ck "restoring the current version collapses" "true" "$(echo "$R" | jq -r '.unchanged')"
ck "  ...and still reports restored_from" "1" "$(echo "$R" | jq -r '.restored_from')"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ] || exit 1
