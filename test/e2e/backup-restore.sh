#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end proof of the corpus backup + restore (issue #9):
#   GET  /admin/backup   — streamed NDJSON, cursor-paginated, blobs inline
#   POST /admin/restore  — verify/apply one page; identity re-asserted, H
#                          re-rendered from S, tombstones never released
#
# WHY A SCRIPT. The pure half (cursor, base64, the line validator) has a unit
# suite (test/backup-format.test.mjs), but the export walk and the raw-row
# restore need D1 + R2 + the WASM sanitizer, which `npm test` never has. Every
# claim below — "the same public_id is readable again", "a fresh R2 key", "the
# file's H never reaches the render", "a bad sha is corrupt" — is a claim about
# live storage, so it is proven here or nowhere.
#
# USAGE (two terminals, local only — never point B at production):
#   npm run db:migrate:local && npm run dev
#   bash test/e2e/backup-restore.sh
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

q() { # q <sql selecting one column aliased v> — D1 is the authority for stored-state claims
  npx wrangler d1 execute META --local --json --command "$1" 2>/dev/null | jq -r '.[0].results[0].v'
}
r2key() { # r2key <public_id> <version_no>
  q "select v.r2_key as v from versions v join documents d on d.id = v.document_id where d.public_id = '$1' and v.version_no = $2"
}

WORK=$(mktemp -d -t slopcafe-backup-e2e)
trap 'rm -rf "$WORK"' EXIT
RAND=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')

# --- credentials -------------------------------------------------------------
AG=$(curl -sS -X POST "$B/admin/agents" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{"name":"e2e-backup"}')
AGID=$(echo "$AG" | jq -r '.agent_id // .id')
KEY=$(curl -sS -X POST "$B/admin/agents/$AGID/keys" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{}' | jq -r '.key')
[ -n "$KEY" ] && [ "$KEY" != "null" ] || { echo "FATAL: key mint failed: $AG"; exit 1; }

# --- three documents ---------------------------------------------------------
# A: markdown with a slug. B: html with a slug, to be revoked. C: html, two versions.
SLUG_A="e2e-bk-a-$RAND"; SLUG_B="e2e-bk-b-$RAND"
A_PUB=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" -H 'content-type: text/markdown' \
     -H 'X-Doc-Title: E2E backup alpha' -H "X-Doc-Slug: $SLUG_A" -H 'X-Doc-Tags: backup,alpha' \
     --data-binary $'# E2E backup alpha\n\nA zebrafish swims in **markdown**.\n')
A=$(echo "$A_PUB" | jq -r '.public_id')
# The origin the Worker believes it serves (wrangler dev rewrites request.url to
# the configured route host, so it is NOT necessarily http://localhost:8787).
ORIGIN=$(echo "$A_PUB" | jq -r '.url' | sed -E 's#(/d/.*)$##')
BPUB=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" -H 'content-type: text/html' \
     -H 'X-Doc-Title: E2E backup bravo' -H "X-Doc-Slug: $SLUG_B" \
     --data-binary '<h1>E2E backup bravo</h1><p>A quokkaburger with <a href="/s/'"$SLUG_A"'">a link to alpha</a>.</p>' | jq -r '.public_id')
C=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" -H 'content-type: text/html' \
     -H 'X-Doc-Title: E2E backup charlie' --data-binary '<h1>E2E backup charlie</h1><p>version one</p>' | jq -r '.public_id')
[ "$A" != "null" ] && [ "$BPUB" != "null" ] && [ "$C" != "null" ] || { echo "FATAL: publish failed"; exit 1; }
curl -sS -X PUT "$B/d/$C" -H "authorization: Bearer $KEY" -H 'content-type: text/html' -H 'If-Match: "v1"' \
  --data-binary '<h1>E2E backup charlie</h1><p>version two</p>' >/dev/null
echo "== docs A=$A B=$BPUB C=$C published =="

B_TEXT_BEFORE=$(curl -sS "$B/d/$BPUB/text" -H "authorization: Bearer $KEY")
A_TEXT_BEFORE=$(curl -sS "$B/d/$A/text" -H "authorization: Bearer $KEY")
B_KEY_BEFORE=$(r2key "$BPUB" 1)
A_KEY_BEFORE=$(r2key "$A" 1)
SAN_V=$(curl -sS "$B/healthz" | jq -r '.sanitizer_version')

# =============================================================================
# 1. Export — every page, small pages so the walk crosses phase boundaries
# =============================================================================
ANON=$(curl -sS -o /dev/null -w '%{http_code}' "$B/admin/backup")
ck "export: anonymous -> 401" "401" "$ANON"
ck "export: a list cursor is not a backup cursor -> bad_cursor" "bad_cursor" \
  "$(curl -sS "$B/admin/backup?cursor=$(printf '{"ts":"x","id":"y"}' | base64 | tr -d '=\n')" -H "authorization: Bearer $OP" | jq -r '.error')"
ck "export: limit 0 -> bad_limit" "bad_limit" "$(curl -sS "$B/admin/backup?limit=0" -H "authorization: Bearer $OP" | jq -r '.error')"

: > "$WORK/all.ndjson"
CURSOR=""; PAGES=0
while :; do
  URL="$B/admin/backup?limit=2"; [ -n "$CURSOR" ] && URL="$URL&cursor=$CURSOR"
  curl -sS -D "$WORK/hdr" "$URL" -H "authorization: Bearer $OP" > "$WORK/page.ndjson"
  PAGES=$((PAGES+1))
  if [ "$PAGES" -eq 1 ]; then
    ck "export: content-type is application/x-ndjson" "true" "$(grep -qi '^content-type: application/x-ndjson' "$WORK/hdr" && echo true || echo false)"
    ck "export: served as an attachment" "true" "$(grep -qi '^content-disposition: attachment; filename="slopcafe-backup-' "$WORK/hdr" && echo true || echo false)"
    ck "export: page 1 opens with the header record" "header" "$(head -n1 "$WORK/page.ndjson" | jq -r '.kind')"
    ck "  ...format + version pinned" "slopcafe-backup/1" "$(head -n1 "$WORK/page.ndjson" | jq -r '"\(.format)/\(.version)"')"
    ck "  ...instance is this deployment's origin" "$ORIGIN" "$(head -n1 "$WORK/page.ndjson" | jq -r '.instance')"
    ck "  ...sanitizer_v is the live one" "$SAN_V" "$(head -n1 "$WORK/page.ndjson" | jq -r '.sanitizer_v')"
  fi
  LAST=$(tail -n1 "$WORK/page.ndjson")
  [ "$(echo "$LAST" | jq -r '.kind')" = "page" ] || { echo "FATAL: page $PAGES has no trailer: $LAST"; exit 1; }
  cat "$WORK/page.ndjson" >> "$WORK/all.ndjson"
  CURSOR=$(echo "$LAST" | jq -r '.next_cursor')
  [ "$CURSOR" != "null" ] || break
  [ "$PAGES" -lt 2000 ] || { echo "FATAL: export never terminated"; exit 1; }
done
ck "export: walked more than one page (limit=2)" "true" "$([ "$PAGES" -gt 1 ] && echo true || echo false)"
ck "export: exactly one header across all pages" "1" "$(jq -r 'select(.kind=="header") | .kind' "$WORK/all.ndjson" | wc -l | tr -d ' ')"
ck "export: exactly one footer, on the last page" "1/footer" \
  "$(jq -r 'select(.kind=="footer") | .kind' "$WORK/all.ndjson" | wc -l | tr -d ' ')/$(tail -n2 "$WORK/all.ndjson" | head -n1 | jq -r '.kind')"
DOC_LINES=$(jq -r 'select(.kind=="document") | .public_id' "$WORK/all.ndjson" | wc -l | tr -d ' ')
ck "export: footer.counts.documents equals the document records emitted" "$DOC_LINES" \
  "$(jq -r 'select(.kind=="footer") | .counts.documents' "$WORK/all.ndjson")"
ck "export: footer.counts.versions equals the version records emitted" \
  "$(jq -r 'select(.kind=="version") | .version_no' "$WORK/all.ndjson" | wc -l | tr -d ' ')" \
  "$(jq -r 'select(.kind=="footer") | .counts.versions' "$WORK/all.ndjson")"
ck "export: our agent is in the file" "$AGID" "$(jq -r --arg a "$AGID" 'select(.kind=="agent" and .id==$a) | .id' "$WORK/all.ndjson")"
ck "export: our key travels as a hash (prefix present, no plaintext)" "true" \
  "$(jq -r --arg a "$AGID" 'select(.kind=="agent_key" and .agent_id==$a) | (.key_hash | test("^[0-9a-f]{64}$"))' "$WORK/all.ndjson" | head -n1)"
ck "export: all three documents present" "3" "$(jq -r --arg a "$A" --arg b "$BPUB" --arg c "$C" 'select(.kind=="document" and (.public_id==$a or .public_id==$b or .public_id==$c)) | .public_id' "$WORK/all.ndjson" | wc -l | tr -d ' ')"
AID=$(jq -r --arg a "$A" 'select(.kind=="document" and .public_id==$a) | .id' "$WORK/all.ndjson")
BID=$(jq -r --arg b "$BPUB" 'select(.kind=="document" and .public_id==$b) | .id' "$WORK/all.ndjson")
CID=$(jq -r --arg c "$C" 'select(.kind=="document" and .public_id==$c) | .id' "$WORK/all.ndjson")
ck "export: A's version is markdown with BOTH blobs inline" "markdown/true/true" \
  "$(jq -r --arg id "$AID" 'select(.kind=="version" and .document_id==$id) | "\(.source_format)/\(.html_b64 != null)/\(.source_b64 != null)"' "$WORK/all.ndjson")"
ck "export: A's slug + tags ride the document record" "$SLUG_A/backup,alpha" \
  "$(jq -r --arg id "$AID" 'select(.kind=="document" and .id==$id) | "\(.slug)/\(.tags | join(","))"' "$WORK/all.ndjson")"
ck "export: C has two version records, on one page with its document" "1,2" \
  "$(jq -r --arg id "$CID" 'select(.kind=="version" and .document_id==$id) | .version_no' "$WORK/all.ndjson" | paste -sd, -)"
ck "export: B's outbound link row rides along" "slug/$SLUG_A" \
  "$(jq -r --arg id "$BID" 'select(.kind=="document_link" and .src_doc_id==$id) | "\(.target_kind)/\(.target_value)"' "$WORK/all.ndjson")"
ck "export: B's source bytes decode to what was published" "true" \
  "$(jq -r --arg id "$BID" 'select(.kind=="version" and .document_id==$id) | .source_b64' "$WORK/all.ndjson" | base64 -d | grep -q quokkaburger && echo true || echo false)"
ck "export: recorded source_sha256 matches the source bytes" "true" \
  "$(S=$(jq -r --arg id "$BID" 'select(.kind=="version" and .document_id==$id) | .source_sha256' "$WORK/all.ndjson"); H=$(jq -r --arg id "$BID" 'select(.kind=="version" and .document_id==$id) | .source_b64' "$WORK/all.ndjson" | base64 -d | shasum -a 256 | cut -d' ' -f1); [ "$S" = "$H" ] && echo true || echo false)"

# =============================================================================
# 2. Verify the whole file against the live corpus: everything already exists
# =============================================================================
ck "restore: anonymous -> 401" "401" "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/admin/restore" --data-binary @"$WORK/all.ndjson")"
ck "restore: bad mode -> bad_request" "bad_request" "$(curl -sS -X POST "$B/admin/restore?mode=yolo" -H "authorization: Bearer $OP" --data-binary @"$WORK/all.ndjson" | jq -r '.error')"
ck "restore: empty body -> bad_request" "bad_request" "$(curl -sS -X POST "$B/admin/restore" -H "authorization: Bearer $OP" --data-binary '' | jq -r '.error')"

V=$(curl -sS -X POST "$B/admin/restore" -H "authorization: Bearer $OP" --data-binary @"$WORK/all.ndjson")
ck "verify (whole file): mode defaults to verify, on_conflict to skip" "verify/skip" "$(echo "$V" | jq -r '"\(.mode)/\(.on_conflict)"')"
ck "verify (whole file): ok — nothing needs attention" "true" "$(echo "$V" | jq -r '.ok')"
ck "verify (whole file): every entity record is skip/exists" "0" "$(echo "$V" | jq -r '[.outcomes[] | select(.action != "skip")] | length')"
ck "verify (whole file): records counted, links counted separately" "true" "$(echo "$V" | jq -r '(.records > 0) and (.document_links >= 1)')"
ck "verify (whole file): C's two versions each report skip" "skip,skip" "$(echo "$V" | jq -r --arg c "$C" '[.outcomes[] | select(.kind=="version" and (.key | startswith($c + "#"))) | .action] | join(",")')"

# =============================================================================
# 3. Revoke B, then restore it from the file
# =============================================================================
jq -c --arg b "$BPUB" --arg id "$BID" \
  'select((.kind=="document" and .public_id==$b) or (.kind=="version" and .document_id==$id) or (.kind=="document_link" and .src_doc_id==$id))' \
  "$WORK/all.ndjson" > "$WORK/b.ndjson"
ck "B's unit extracted (doc + version + link)" "3" "$(wc -l < "$WORK/b.ndjson" | tr -d ' ')"

curl -sS -X DELETE "$B/d/$BPUB" -H "authorization: Bearer $OP" >/dev/null
ck "revoke: B is gone (/text -> 404)" "404" "$(curl -sS -o /dev/null -w '%{http_code}' "$B/d/$BPUB/text" -H "authorization: Bearer $KEY")"
ck "revoke: slug retired into a tombstone" "1" "$(q "select count(*) as v from slug_tombstones where slug = '$SLUG_B'")"

VS=$(curl -sS -X POST "$B/admin/restore?mode=verify" -H "authorization: Bearer $OP" --data-binary @"$WORK/b.ndjson")
ck "verify+skip on a revoked doc: the row exists -> skip" "skip/exists" "$(echo "$VS" | jq -r --arg b "$BPUB" '.outcomes[] | select(.kind=="document" and .key==$b) | "\(.action)/\(.reason)"')"

VR=$(curl -sS -X POST "$B/admin/restore?mode=verify&on_conflict=replace" -H "authorization: Bearer $OP" --data-binary @"$WORK/b.ndjson")
ck "verify+replace: plans a replace of the document" "replace" "$(echo "$VR" | jq -r --arg b "$BPUB" '.outcomes[] | select(.kind=="document" and .key==$b) | .action')"
ck "  ...notes the retired slug (never released by a restore)" "slug_retired:$SLUG_B" "$(echo "$VR" | jq -r --arg b "$BPUB" '.outcomes[] | select(.kind=="document" and .key==$b) | .notes[0]')"
ck "  ...and a replace of the version, with bytes" "replace" "$(echo "$VR" | jq -r --arg k "$BPUB#v1" '.outcomes[] | select(.key==$k) | .action')"
ck "  ...writes nothing (still revoked)" "revoked" "$(q "select case when revoked_at is null then 'live' else 'revoked' end as v from documents where public_id = '$BPUB'")"

AR=$(curl -sS -o "$WORK/apply.json" -w '%{http_code}' -X POST "$B/admin/restore?mode=apply&on_conflict=replace" -H "authorization: Bearer $OP" --data-binary @"$WORK/b.ndjson")
ck "apply+replace: 200" "200" "$AR"
ck "apply+replace: ok, document + version replaced" "true/replace/replace" \
  "$(jq -r --arg b "$BPUB" --arg k "$BPUB#v1" '"\(.ok)/\(.outcomes[] | select(.key==$b) | .action)/\(.outcomes[] | select(.key==$k) | .action)"' "$WORK/apply.json")"
ck "restored: same public_id is readable again" "200" "$(curl -sS -o /dev/null -w '%{http_code}' "$B/d/$BPUB/text" -H "authorization: Bearer $KEY")"
ck "restored: /text output is IDENTICAL to before the revoke" "true" "$([ "$(curl -sS "$B/d/$BPUB/text" -H "authorization: Bearer $KEY")" = "$B_TEXT_BEFORE" ] && echo true || echo false)"
ck "restored: revoked_at cleared, current_ver re-asserted" "1" "$(q "select current_ver as v from documents where public_id = '$BPUB' and revoked_at is null")"
ck "restored: internal id re-asserted (not re-minted)" "$BID" "$(q "select id as v from documents where public_id = '$BPUB'")"
ck "restored: visibility as recorded (private)" "private" "$(q "select visibility as v from documents where public_id = '$BPUB'")"
B_KEY_AFTER=$(r2key "$BPUB" 1)
ck "restored: a FRESH R2 key, never the recorded one" "true" "$([ -n "$B_KEY_AFTER" ] && [ "$B_KEY_AFTER" != "$B_KEY_BEFORE" ] && echo true || echo false)"
ck "restored: stamped with the CURRENT sanitizer_v" "$SAN_V" "$(q "select v.sanitizer_v as v from versions v join documents d on d.id=v.document_id where d.public_id='$BPUB' and v.version_no=1")"
ck "restored: slug NOT reclaimed (comes back slugless)" "null" "$(q "select coalesce(slug, 'null') as v from documents where public_id = '$BPUB'")"
ck "restored: tombstone intact" "1" "$(q "select count(*) as v from slug_tombstones where slug = '$SLUG_B'")"
ck "restored: /s/<old slug> stays 410" "410" "$(curl -sS -o /dev/null -w '%{http_code}' "$B/s/$SLUG_B" -H "authorization: Bearer $KEY")"
ck "restored: FTS finds it (keyword search)" "true" \
  "$(curl -sS "$B/d/search?q=quokkaburger&mode=keyword" -H "authorization: Bearer $KEY" | jq -r --arg b "$BPUB" '[.hits[]? // .documents[]? | select(.public_id==$b)] | length > 0')"
ck "restored: link graph re-extracted from the re-rendered H" "$SLUG_A" \
  "$(q "select target_value as v from document_links where src_doc_id = '$BID' and target_kind = 'slug'")"
ck "restored: source_sha256 recomputed equals the recorded one" \
  "$(jq -r 'select(.kind=="version") | .source_sha256' "$WORK/b.ndjson")" \
  "$(q "select v.source_sha256 as v from versions v join documents d on d.id=v.document_id where d.public_id='$BPUB' and v.version_no=1")"
ck "restored: updated_at stamped now (a restore is a change on this instance)" "fresh" \
  "$(q "select case when updated_at > created_at then 'fresh' else 'stale' end as v from documents where public_id = '$BPUB'")"

# =============================================================================
# 4. The render rule: a tampered H in the file never reaches the render
# =============================================================================
TAMP=$(printf '%s' '<script>alert(1)</script><p>TAMPERED</p>' | base64 | tr -d '\n')
jq -c --arg h "$TAMP" 'if .kind=="version" then .html_b64=$h else . end' "$WORK/b.ndjson" > "$WORK/b_tampered.ndjson"
AT=$(curl -sS -X POST "$B/admin/restore?mode=apply&on_conflict=replace" -H "authorization: Bearer $OP" --data-binary @"$WORK/b_tampered.ndjson")
ck "tampered H: the restore still succeeds (H is not consulted)" "true" "$(echo "$AT" | jq -r '.ok')"
RAW=$(curl -sS "$B/d/$BPUB/raw" -H "authorization: Bearer $KEY")
ck "tampered H: the render is the RE-DERIVED bytes, not the file's" "false" "$(echo "$RAW" | grep -q 'TAMPERED' && echo true || echo false)"
ck "tampered H: ...and still carries the original content" "true" "$(echo "$RAW" | grep -q 'quokkaburger' && echo true || echo false)"
ck "tampered H: no script reached storage" "false" "$(echo "$RAW" | grep -q '<script' && echo true || echo false)"
B_KEY_TAMPERED=$(r2key "$BPUB" 1)
ck "tampered H: replace minted another fresh key" "true" "$([ "$B_KEY_TAMPERED" != "$B_KEY_AFTER" ] && echo true || echo false)"

# =============================================================================
# 5. A bad source_sha256 is `corrupt` — and nothing changes
# =============================================================================
jq -c 'if .kind=="version" then .source_sha256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" else . end' "$WORK/b.ndjson" > "$WORK/b_corrupt.ndjson"
VC=$(curl -sS -X POST "$B/admin/restore?mode=verify&on_conflict=replace" -H "authorization: Bearer $OP" --data-binary @"$WORK/b_corrupt.ndjson")
ck "corrupt sha: verify reports the version corrupt" "corrupt" "$(echo "$VC" | jq -r --arg k "$BPUB#v1" '.outcomes[] | select(.key==$k) | .action')"
ck "corrupt sha: ...and the document rejected (its current version is unrestorable)" "rejected" "$(echo "$VC" | jq -r --arg b "$BPUB" '.outcomes[] | select(.key==$b) | .action')"
ck "corrupt sha: ok is false" "false" "$(echo "$VC" | jq -r '.ok')"
AC=$(curl -sS -o "$WORK/corrupt.json" -w '%{http_code}' -X POST "$B/admin/restore?mode=apply&on_conflict=replace" -H "authorization: Bearer $OP" --data-binary @"$WORK/b_corrupt.ndjson")
ck "corrupt sha: apply answers 207" "207" "$AC"
ck "corrupt sha: apply changed nothing (same R2 key)" "$B_KEY_TAMPERED" "$(r2key "$BPUB" 1)"

# =============================================================================
# 6. Fail closed: one invalid line rejects the page whole
# =============================================================================
{ cat "$WORK/b.ndjson"; echo '{"kind":"settings","evil":true}'; } > "$WORK/b_invalid.ndjson"
AI=$(curl -sS -o "$WORK/invalid.json" -w '%{http_code}' -X POST "$B/admin/restore?mode=apply&on_conflict=replace" -H "authorization: Bearer $OP" --data-binary @"$WORK/b_invalid.ndjson")
ck "invalid line: 207" "207" "$AI"
ck "invalid line: aborted=invalid_records" "invalid_records" "$(jq -r '.aborted' "$WORK/invalid.json")"
ck "invalid line: the bad line is reported by number" "4/invalid" "$(jq -r '.outcomes[] | select(.action=="invalid") | "\(.line)/\(.action)"' "$WORK/invalid.json")"
ck "invalid line: every other record is skip/page_rejected" "0" "$(jq -r '[.outcomes[] | select(.action != "invalid" and (.action != "skip" or .reason != "page_rejected"))] | length' "$WORK/invalid.json")"
ck "invalid line: NOTHING applied (same R2 key)" "$B_KEY_TAMPERED" "$(r2key "$BPUB" 1)"
VI=$(curl -sS -X POST "$B/admin/restore?mode=verify&on_conflict=replace" -H "authorization: Bearer $OP" --data-binary @"$WORK/b_invalid.ndjson")
ck "invalid line: verify still plans the valid records" "replace" "$(echo "$VI" | jq -r --arg b "$BPUB" '.outcomes[] | select(.key==$b) | .action')"

# =============================================================================
# 7. Dependencies + identity
# =============================================================================
GHOST="deadbeef-dead-4ead-8ead-deadbeefdead"
jq -c --arg g "$GHOST" 'select(.kind=="version") | .document_id=$g' "$WORK/b.ndjson" > "$WORK/orphan.ndjson"
ck "a version whose document is nowhere -> missing_dependency" "missing_dependency" \
  "$(curl -sS -X POST "$B/admin/restore" -H "authorization: Bearer $OP" --data-binary @"$WORK/orphan.ndjson" | jq -r '.outcomes[0].action')"
jq -c --arg g "$GHOST" 'if .kind=="document" then .id=$g else . end' "$WORK/b.ndjson" > "$WORK/ident.ndjson"
ck "a public_id bound to a different id -> rejected (identity_conflict)" "rejected" \
  "$(curl -sS -X POST "$B/admin/restore?on_conflict=replace" -H "authorization: Bearer $OP" --data-binary @"$WORK/ident.ndjson" | jq -r --arg b "$BPUB" '.outcomes[] | select(.key==$b) | .action')"

# A brand-new agent + key restored in FK order on one page (agent before key).
NEWAG=$(uuidgen | tr 'A-Z' 'a-z'); NEWKEY=$(uuidgen | tr 'A-Z' 'a-z')
{
  printf '{"kind":"agent","id":"%s","name":"e2e-restored-agent","created_at":"2026-01-01T00:00:00.000Z"}\n' "$NEWAG"
  printf '{"kind":"agent_key","id":"%s","agent_id":"%s","key_prefix":"e2eprefix","key_hash":"%s","revoked_at":null,"expires_at":null,"created_at":"2026-01-01T00:00:01.000Z"}\n' "$NEWKEY" "$NEWAG" "$(printf 'b%.0s' $(seq 1 64))"
} > "$WORK/agent.ndjson"
AA=$(curl -sS -X POST "$B/admin/restore?mode=apply" -H "authorization: Bearer $OP" --data-binary @"$WORK/agent.ndjson")
ck "agent + key page: both created" "create,create" "$(echo "$AA" | jq -r '[.outcomes[].action] | join(",")')"
ck "agent + key page: the agent row exists with its recorded created_at" "2026-01-01T00:00:00.000Z" "$(q "select created_at as v from agents where id = '$NEWAG'")"
ck "agent + key page: re-applying is skip/exists" "skip,skip" "$(curl -sS -X POST "$B/admin/restore?mode=apply" -H "authorization: Bearer $OP" --data-binary @"$WORK/agent.ndjson" | jq -r '[.outcomes[].action] | join(",")')"

# =============================================================================
# 8. A live markdown document, replaced from the file: same text, fresh key
# =============================================================================
jq -c --arg a "$A" --arg id "$AID" 'select((.kind=="document" and .public_id==$a) or (.kind=="version" and .document_id==$id))' "$WORK/all.ndjson" > "$WORK/a.ndjson"
AL=$(curl -sS -X POST "$B/admin/restore?mode=apply&on_conflict=replace" -H "authorization: Bearer $OP" --data-binary @"$WORK/a.ndjson")
ck "live markdown doc replace: ok" "true" "$(echo "$AL" | jq -r '.ok')"
ck "live markdown doc replace: /text identical" "true" "$([ "$(curl -sS "$B/d/$A/text" -H "authorization: Bearer $KEY")" = "$A_TEXT_BEFORE" ] && echo true || echo false)"
ck "live markdown doc replace: fresh R2 key" "true" "$([ "$(r2key "$A" 1)" != "$A_KEY_BEFORE" ] && echo true || echo false)"
ck "live markdown doc replace: slug kept (held by the same document)" "$SLUG_A" "$(q "select slug as v from documents where public_id = '$A'")"
ck "live markdown doc replace: source_format stays markdown" "markdown" "$(q "select v.source_format as v from versions v join documents d on d.id=v.document_id where d.public_id='$A' and v.version_no=1")"
ck "live markdown doc replace: reader theme survives (markdown render)" "true" "$(curl -sS "$B/d/$A/raw" -H "authorization: Bearer $KEY" | grep -q '<style' && echo true || echo false)"

# =============================================================================
# 9. The console twin: a multipart upload onto the same core, rendered as HTML
# =============================================================================
# The Bearer rung of authorizeOperatorForm (rung 2) authorizes without a cookie
# session, so the handler takes its terminal-card path: a full report table.
A_KEY_NOW=$(r2key "$A" 1)
CR=$(curl -sS -D "$WORK/console.hdr" -o "$WORK/console.html" -w '%{http_code}' -X POST "$B/admin/console/restore" \
      -H "authorization: Bearer $OP" -F "file=@$WORK/a.ndjson;type=application/x-ndjson" -F mode=verify -F on_conflict=replace)
ck "console restore (multipart, Bearer rung): 200" "200" "$CR"
ck "console restore: renders the report as a table with the planned action" "true" \
  "$(grep -q '<table>' "$WORK/console.html" && grep -q '>replace<' "$WORK/console.html" && echo true || echo false)"
ck "console restore: carries a CSP + no-store like every console page" "true" \
  "$(grep -qi '^content-security-policy:' "$WORK/console.hdr" && grep -qi '^cache-control: no-store' "$WORK/console.hdr" && echo true || echo false)"
ck "console restore: verify wrote nothing (same R2 key)" "$A_KEY_NOW" "$(r2key "$A" 1)"
ck "console restore: no file -> 400 error card" "400" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/admin/console/restore" -H "authorization: Bearer $OP" -F mode=verify)"
ck "console restore: anonymous -> 401" "401" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$B/admin/console/restore" -F "file=@$WORK/a.ndjson")"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ] || exit 1
