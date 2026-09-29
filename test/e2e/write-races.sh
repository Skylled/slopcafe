#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end proof for issues #131 and #132.
#
#   #131 — `/s/:slug` with a present-but-invalid credential must answer the SAME
#          bytes whatever the slug is (private live, public live, never-claimed,
#          retired, redirecting). It used to be 401 / 404 / 410 depending on
#          what the slug was: an existence oracle for private slugs.
#   #132 — `updateDocumentCore`'s batch is guarded. Two same-`If-Match` PUTs
#          racing produce one success and one `412`, never a 500; clobber
#          (`If-Match: *`) writes racing all land, each on its own version; and
#          a PUT racing a revoke never leaves a version, FTS row, link row or R2
#          blob behind on the dead document.
#
# The races are fired concurrently and asserted as INVARIANTS, not as a scripted
# interleaving — they hold whichever order wrangler dev happens to run them in.
# (Race 2 of #132, the visibility flip under an agent rename, is not exercised
# here: no invariant observable afterwards distinguishes "rename landed before
# the flip" from "after". Its guard term is the same WHERE EXISTS as the others.)
#
# USAGE (two terminals, local only — never point B at production):
#   npm run db:migrate:local && npm run dev
#   bash test/e2e/write-races.sh
#
# Reads OPERATOR_TOKEN from .dev.vars and mints a throwaway agent + key. It
# writes to the LOCAL D1/R2 only, and never echoes a secret.
B=http://localhost:8787
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1   # wrangler d1/r2 resolve wrangler.toml from the cwd
OP=$(grep -E '^OPERATOR_TOKEN=' "$ROOT/.dev.vars" | cut -d= -f2- | tr -d '"'"'"'')
[ -n "$OP" ] || { echo "FATAL: no OPERATOR_TOKEN in .dev.vars"; exit 1; }
# The R2 bucket behind the DOCS binding — per-deployment, so read it rather than
# hardcode it (the D1 side is addressed by binding, which wrangler accepts).
BUCKET=$(awk '/binding *= *"DOCS"/{f=1} f&&/bucket_name/{gsub(/.*= *"|".*/,"");print;exit}' "$ROOT/wrangler.toml")
[ -n "$BUCKET" ] || { echo "FATAL: no DOCS bucket_name in wrangler.toml"; exit 1; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/write-races.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ck() { # ck <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass+1));
  else echo "FAIL $1"; echo "       want: $2"; echo "       got:  $3"; fail=$((fail+1)); fi
}
q() { # q <sql> — single scalar from LOCAL D1
  npx wrangler d1 execute META --local --json --command "$1" 2>/dev/null \
    | jq -r '.[0].results[0].v'
}

# --- credentials -------------------------------------------------------------
AG=$(curl -sS -X POST "$B/admin/agents" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{"name":"e2e-write-races"}')
AGID=$(echo "$AG" | jq -r '.agent_id // .id')
KEY=$(curl -sS -X POST "$B/admin/agents/$AGID/keys" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{}' | jq -r '.key')
[ -n "$KEY" ] && [ "$KEY" != "null" ] || { echo "FATAL: key mint failed: $AG"; exit 1; }
echo "== credentials minted (agent $AGID) =="

SFX=$(date +%s)$$
publish() { # publish <slug-or-empty> — agent publish (born private); prints public_id
  local hdr=()
  [ -n "$1" ] && hdr=(-H "X-Doc-Slug: $1")
  curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" -H 'content-type: text/markdown' \
    "${hdr[@]}" --data-binary $'# Race E2E\n\nbody\n' | jq -r '.public_id'
}
must_id() { # must_id <label> <value> — a failed publish must not make later checks vacuous
  [[ "$2" =~ ^[A-Za-z0-9_-]{22}$ ]] || { echo "FATAL: $1 publish failed (got: $2)"; exit 1; }
}

# =============================================================================
# #131 — junk-bearer responses on /s/:slug are slug-independent
# =============================================================================
S_PRIV="race-priv-$SFX"; S_PUB="race-pub-$SFX"; S_NEVER="race-never-$SFX"
S_REN="race-ren-$SFX"; S_REN2="race-ren2-$SFX"; S_CLR="race-clr-$SFX"

ID_PRIV=$(publish "$S_PRIV"); must_id private "$ID_PRIV"
ID_PUB=$(publish "$S_PUB"); must_id public "$ID_PUB"
curl -sS -o /dev/null -X POST "$B/admin/documents/$ID_PUB/visibility" -H "authorization: Bearer $OP" \
  -H 'content-type: application/json' -d '{"visibility":"public"}'
# A renamed slug → tombstone WITH a same-document redirect; a cleared one → plain.
ID_REN=$(publish "$S_REN"); must_id renamed "$ID_REN"
curl -sS -o /dev/null -X PUT "$B/d/$ID_REN" -H "authorization: Bearer $KEY" -H 'If-Match: *' \
  -H 'content-type: text/markdown' -H "X-Doc-Slug: $S_REN2" --data-binary $'# Race E2E\n\nrenamed\n'
ID_CLR=$(publish "$S_CLR"); must_id cleared "$ID_CLR"
curl -sS -o /dev/null -X PUT "$B/d/$ID_CLR" -H "authorization: Bearer $KEY" -H 'If-Match: *' \
  -H 'content-type: text/markdown' -H 'X-Doc-Slug;' --data-binary $'# Race E2E\n\ncleared\n'
ck "setup: private slug is live and private" "private" "$(q "select visibility as v from documents where slug='$S_PRIV'")"
ck "setup: renamed slug is tombstoned with a redirect" "$ID_REN" "$(q "select redirect_to as v from slug_tombstones where slug='$S_REN'")"
ck "setup: cleared slug is tombstoned, no redirect" "released" "$(q "select reason as v from slug_tombstones where slug='$S_CLR'")"

# Held in a variable so the literal `-H "authorization: Bearer <token>"` shape
# never appears in source: gitleaks' default curl-auth-header rule fires on it
# even for an obviously fake key (same convention as test/e2e/audit.sh).
JUNK_KEY="awh_not_a_real_key"
junk() { # junk <slug> <method> — status line + headers-that-matter + body, to a file
  local out="$TMP/junk-$1-$2"
  local m=(-X GET); [ "$2" = HEAD ] && m=(--head)   # -X HEAD would wait for a body
  curl -sS "${m[@]}" -D "$out.h" -o "$out.b" "$B/s/$1" -H "authorization: Bearer $JUNK_KEY"
  # Status line + content-type + body. For HEAD, curl writes the header block
  # into the body file too, so it's left out: per-request headers (date) differ.
  { head -1 "$out.h" | tr -d '\r'; grep -i '^content-type:' "$out.h" | tr -d '\r'
    [ "$2" = HEAD ] || cat "$out.b"; } > "$out"
  echo "$out"
}
for M in GET HEAD; do
  REF=$(junk "$S_NEVER" "$M")
  ck "[$M] junk bearer on a never-claimed slug is 401" "401" "$(head -1 "$REF" | awk '{print $2}')"
  for S in "$S_PRIV" "$S_PUB" "$S_REN" "$S_CLR"; do
    if cmp -s "$REF" "$(junk "$S" "$M")"; then ck "[$M] junk bearer: $S ≡ never-claimed (byte-identical)" same same
    else ck "[$M] junk bearer: $S ≡ never-claimed (byte-identical)" same "$(head -1 "$TMP/junk-$S-$M")"; fi
  done
done
# A valid key still reads the private doc by slug (the fix must not over-deny).
ck "valid key still reads a private doc by slug" "200" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$B/s/$S_PRIV" -H "authorization: Bearer $KEY")"
ck "valid key on a never-claimed slug is 404" "404" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$B/s/$S_NEVER" -H "authorization: Bearer $KEY")"
# /s/:slug/text runs requireReader before its lookup, so it never had the
# ordering bug; pin that its junk-bearer answer is slug-independent too.
junk_text() { # junk_text <slug> — status line + content-type + body, to a file
  local out="$TMP/junktext-$1"
  curl -sS -D "$out.h" -o "$out.b" "$B/s/$1/text" -H "authorization: Bearer $JUNK_KEY"
  { head -1 "$out.h" | tr -d '\r'; grep -i '^content-type:' "$out.h" | tr -d '\r'; cat "$out.b"; } > "$out"
  echo "$out"
}
REF=$(junk_text "$S_NEVER")
ck "[/text] junk bearer on a never-claimed slug is 401" "401" "$(head -1 "$REF" | awk '{print $2}')"
for S in "$S_PRIV" "$S_PUB" "$S_REN" "$S_CLR"; do
  if cmp -s "$REF" "$(junk_text "$S")"; then ck "[/text] junk bearer: $S ≡ never-claimed (byte-identical)" same same
  else ck "[/text] junk bearer: $S ≡ never-claimed (byte-identical)" same "$(head -1 "$TMP/junktext-$S")"; fi
done

# =============================================================================
# #132 race 3 — concurrent PUTs with the SAME If-Match
# =============================================================================
ID=$(publish ""); must_id pinned "$ID"
N=6
for i in $(seq 1 $N); do
  curl -sS -o "$TMP/pin-$i.b" -w '%{http_code}' -X PUT "$B/d/$ID" -H "authorization: Bearer $KEY" \
    -H 'If-Match: "v1"' -H 'content-type: text/markdown' \
    --data-binary "# Race E2E"$'\n\n'"pinned writer $i"$'\n' > "$TMP/pin-$i.s" &
done
wait
OK=0; PF=0; OTHER=""
for i in $(seq 1 $N); do
  s=$(cat "$TMP/pin-$i.s")
  case "$s" in
    200) OK=$((OK+1));;
    412) [ "$(jq -r '.error' "$TMP/pin-$i.b")" = "precondition_failed" ] && PF=$((PF+1)) || OTHER="$OTHER 412:$(jq -c . "$TMP/pin-$i.b")";;
    *) OTHER="$OTHER $s";;
  esac
done
ck "same-If-Match race: exactly one writer wins" "1" "$OK"
ck "  ...every loser gets 412 precondition_failed (never a 500)" "$((N-1))" "$PF"
ck "  ...no other statuses" "" "$OTHER"
ck "  ...exactly one version appended" "2" "$(q "select count(*) as v from versions v join documents d on d.id=v.document_id where d.public_id='$ID'")"
ck "  ...current_ver is 2" "2" "$(q "select current_ver as v from documents where public_id='$ID'")"

# =============================================================================
# #132 — concurrent CLOBBER writes (If-Match: *) all land, on distinct versions
# =============================================================================
N=5
for i in $(seq 1 $N); do
  curl -sS -o "$TMP/clob-$i.b" -w '%{http_code}' -X PUT "$B/d/$ID" -H "authorization: Bearer $KEY" \
    -H 'If-Match: *' -H 'content-type: text/markdown' \
    --data-binary "# Race E2E"$'\n\n'"clobber writer $i"$'\n' > "$TMP/clob-$i.s" &
done
wait
# Classify per file: `-w '%{http_code}'` writes no trailing newline, so
# `cat`-ing the status files together yields ONE line and a `grep -c` over it
# counts nothing (how this check first failed in CI, want 0 / got 4).
OKS=0; FIVEXX=0; OTHER=""
for i in $(seq 1 $N); do
  s=$(cat "$TMP/clob-$i.s")
  case "$s" in
    200) OKS=$((OKS+1));;
    5*) FIVEXX=$((FIVEXX+1));;
    412) [ "$(jq -r '.error' "$TMP/clob-$i.b")" = "precondition_failed" ] || OTHER="$OTHER 412:$(jq -c . "$TMP/clob-$i.b")";;
    *) OTHER="$OTHER $s";;
  esac
done
VERS=$(for i in $(seq 1 $N); do [ "$(cat "$TMP/clob-$i.s")" = 200 ] && jq -r '.version' "$TMP/clob-$i.b"; done | sort -n | uniq | wc -l | tr -d ' ')
# Bounded retry (3 attempts): under heavy contention a clobber may exhaust it and
# report 412. What must never happen is a 500 or two writers claiming one version.
[ "$OKS" -ge 1 ] || { echo "FATAL: no clobber write succeeded"; exit 1; }
ck "clobber race: only 200 or 412 precondition_failed" "" "$OTHER"
ck "clobber race: no 5xx" "0" "$FIVEXX"
ck "clobber race: every success reports a DISTINCT version" "$OKS" "$VERS"
ck "clobber race: version rows == 2 + successes" "$((2+OKS))" \
  "$(q "select count(*) as v from versions v join documents d on d.id=v.document_id where d.public_id='$ID'")"
ck "clobber race: FTS row count is exactly 1" "1" \
  "$(q "select count(*) as v from documents_fts f join documents d on d.id=f.document_id where d.public_id='$ID'")"

# =============================================================================
# #132 race 1 — PUTs racing a REVOKE leave nothing behind
# =============================================================================
ID=$(publish "race-rev-$SFX"); must_id revoke-race "$ID"
LINKBODY=$'# Race E2E\n\nsee [x](/s/some-target) and [y](/d/AAAAAAAAAAAAAAAAAAAAAA)\n'
for i in 1 2 3 4; do
  curl -sS -o /dev/null -X PUT "$B/d/$ID" -H "authorization: Bearer $KEY" -H 'If-Match: *' \
    -H 'content-type: text/markdown' --data-binary "$LINKBODY writer $i" &
done
curl -sS -o "$TMP/rev.b" -w '%{http_code}' -X DELETE "$B/d/$ID" -H "authorization: Bearer $OP" > "$TMP/rev.s" &
for i in 5 6 7 8; do
  curl -sS -o /dev/null -X PUT "$B/d/$ID" -H "authorization: Bearer $KEY" -H 'If-Match: *' \
    -H 'content-type: text/markdown' --data-binary "$LINKBODY writer $i" &
done
wait
ck "revoke race: revoke succeeded" "200" "$(cat "$TMP/rev.s")"
ck "revoke race: current_ver is NULL" "null" "$(q "select current_ver as v from documents where public_id='$ID'")"
ck "revoke race: live slug cleared" "null" "$(q "select slug as v from documents where public_id='$ID'")"
ck "revoke race: no FTS row resurrected" "0" \
  "$(q "select count(*) as v from documents_fts f join documents d on d.id=f.document_id where d.public_id='$ID'")"
ck "revoke race: no link rows resurrected" "0" \
  "$(q "select count(*) as v from document_links l join documents d on d.id=l.src_doc_id where d.public_id='$ID'")"
# Every version row that exists was purged from R2 (H and .src). A version that
# committed before the kill is in the (post-kill) purge list; one that lost the
# race never got a row and deleted its own blobs.
KEYS=$(npx wrangler d1 execute META --local --json --command \
  "select r2_key as k from versions v join documents d on d.id=v.document_id where d.public_id='$ID'
   union all select source_r2_key from versions v join documents d on d.id=v.document_id where d.public_id='$ID' and source_r2_key is not null" \
  2>/dev/null | jq -r '.[0].results[].k')
NKEYS=$(echo "$KEYS" | wc -w | tr -d ' ')
# At least v1's H + .src must be listed, or the key query failed and the purge
# check below would pass vacuously.
[ "$NKEYS" -ge 2 ] || { echo "FATAL: version-key query returned $NKEYS keys"; exit 1; }
LEFT=0
for k in $KEYS; do
  if npx wrangler r2 object get "$BUCKET/$k" --local --pipe >/dev/null 2>&1; then LEFT=$((LEFT+1)); fi
done
ck "revoke race: no R2 blob of any version survives (checked $NKEYS)" "0" "$LEFT"

echo
echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
