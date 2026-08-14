#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end proof of the MCP Apps extension surface (SEP-1865, extension id
# io.modelcontextprotocol/ui): the view_document tool, its _meta link to the
# ui://slopcafe/document-view.html template, the template's resources/list +
# resources/read registration, and the capability advertisement.
#
# WHY THIS EXISTS AS A SCRIPT. Same reason as published-version.sh: the unit
# suite has no D1 harness and never speaks JSON-RPC to /mcp, so the pieces that
# make the extension real — the tools/list _meta bytes a host keys on, the
# resource read returning the actual template, the tool envelope an Apps host
# renders — are only exercised against a running Worker. mcp-errors.test.mjs
# pins the SOURCE of these strings; this proves they reach the wire.
#
# Speaks the 2026-07-28 (modern/stateless) protocol directly with plain curl
# JSON-RPC POSTs over Door B (a minted awh_ bearer): no session handshake, one
# _meta envelope per request (io.modelcontextprotocol/protocolVersion +
# clientCapabilities — required on every modern request).
#
# USAGE (two terminals, local only — never point B at production):
#   npm run db:migrate:local && npm run dev
#   bash test/e2e/mcp-apps.sh
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
      -H 'content-type: application/json' -d '{"name":"e2e-mcp-apps"}')
AGID=$(echo "$AG" | jq -r '.agent_id // .id')
KEY=$(curl -sS -X POST "$B/admin/agents/$AGID/keys" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{}' | jq -r '.key')
[ -n "$KEY" ] && [ "$KEY" != "null" ] || { echo "FATAL: key mint failed: $AG"; exit 1; }
echo "== credentials minted (agent $AGID) =="

# --- the JSON-RPC door -------------------------------------------------------
# One self-contained POST per call (2026-07-28 stateless): the modern era
# needs no session handshake, but each request must carry the `_meta` envelope
# (protocolVersion + clientCapabilities) in the params, the `Mcp-Method`
# header naming the body's method, AND — on name-addressed methods like
# tools/call and resources/read — an `Mcp-Name` header matching params.name /
# params.uri; the transport 400s a POST whose headers and body disagree. The
# response may be raw JSON or a single-event SSE stream; both normalize to
# the bare JSON-RPC object.
mcp() { # mcp <method> [<params-json>]
  local params="${2:-{\}}"
  local name
  name=$(jq -nr --argjson p "$params" '$p.name // $p.uri // empty')
  local body
  body=$(jq -nc --arg m "$1" --argjson p "$params" \
    '{jsonrpc:"2.0", id:1, method:$m,
      params:($p + {"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                             "io.modelcontextprotocol/clientCapabilities":{}}})}')
  local -a name_header=()
  [ -n "$name" ] && name_header=(-H "Mcp-Name: $name")
  local out
  out=$(curl -sS -X POST "$B/mcp" -H "authorization: Bearer $KEY" \
        -H 'content-type: application/json' \
        -H 'accept: application/json, text/event-stream' \
        -H "Mcp-Method: $1" "${name_header[@]}" \
        --data-binary "$body")
  case "$out" in
    "{"*) printf '%s\n' "$out" ;;
    *)    printf '%s\n' "$out" | sed -n 's/^data: //p' | tail -n1 ;;
  esac
}

# --- 1. tools/list advertises view_document with the template link -----------
TOOLS=$(mcp tools/list)
VIEW=$(echo "$TOOLS" | jq '.result.tools[] | select(.name == "view_document")')
ck "tools/list carries view_document" "view_document" "$(echo "$VIEW" | jq -r '.name')"
ck "  ..._meta.ui.resourceUri names the template" "ui://slopcafe/document-view.html" \
  "$(echo "$VIEW" | jq -r '._meta.ui.resourceUri')"
ck "  ...and the deprecated flat spelling too" "ui://slopcafe/document-view.html" \
  "$(echo "$VIEW" | jq -r '._meta["ui/resourceUri"]')"
# The three content writes carry the SAME link (the post-publish inline
# preview). Both spellings ride the one shared constant, so checking the
# nested spelling per tool is enough — the double-spelling pin above covers it.
for T in publish_document update_document edit_document; do
  ck "  ...$T carries the template link too" "ui://slopcafe/document-view.html" \
    "$(echo "$TOOLS" | jq -r --arg t "$T" '.result.tools[] | select(.name == $t) | ._meta.ui.resourceUri')"
done

# --- 2. resources/list shows the ui:// entry ---------------------------------
RES=$(mcp resources/list)
ENTRY=$(echo "$RES" | jq '.result.resources[] | select(.uri == "ui://slopcafe/document-view.html")')
ck "resources/list carries the ui:// template" "ui://slopcafe/document-view.html" \
  "$(echo "$ENTRY" | jq -r '.uri')"
ck "  ...with the SEP-1865 profile MIME" "text/html;profile=mcp-app" \
  "$(echo "$ENTRY" | jq -r '.mimeType')"

# --- 3. resources/read returns the template itself ---------------------------
READ=$(mcp resources/read '{"uri":"ui://slopcafe/document-view.html"}')
C0=$(echo "$READ" | jq '.result.contents[0]')
ck "resources/read echoes the uri" "ui://slopcafe/document-view.html" "$(echo "$C0" | jq -r '.uri')"
ck "  ...and the profile MIME" "text/html;profile=mcp-app" "$(echo "$C0" | jq -r '.mimeType')"
TPL=$(echo "$C0" | jq -r '.text')
echo "$TPL" | grep -q "slopcafe-document-view" && M1=present || M1=absent
ck "  ...template carries its marker (slopcafe-document-view)" "present" "$M1"
echo "$TPL" | grep -q '"ui/initialize"' && M2=present || M2=absent
ck "  ...and the ui/initialize handshake" "present" "$M2"

# --- 4. publish a doc, view it by public_id ----------------------------------
SLUG="e2e-apps-$(date +%s)"
PUB=$(curl -sS -X POST "$B/d" -H "authorization: Bearer $KEY" \
       -H 'content-type: text/markdown' -H 'X-Doc-Title: E2E MCP Apps' \
       -H "X-Doc-Slug: $SLUG" \
       --data-binary $'# E2E MCP Apps\n\nVIEWER BODY MARKER\n')
ID=$(echo "$PUB" | jq -r '.public_id')
[ "$ID" != "null" ] || { echo "FATAL: publish failed: $PUB"; exit 1; }
echo "== doc $ID published (slug $SLUG) =="

VD=$(mcp tools/call "{\"name\":\"view_document\",\"arguments\":{\"public_id\":\"$ID\"}}")
SC=$(echo "$VD" | jq '.result.structuredContent')
ck "view_document returns the envelope (public_id)" "$ID" "$(echo "$SC" | jq -r '.public_id')"
# Assert the PATH, not the origin: wrangler dev rewrites the request host to
# the configured route (slopcafe.com), so the origin half is environment noise
# while the /d/<public_id> path is the contract.
ck "  ...url is the canonical /d/ address" "/d/$ID" \
  "$(echo "$SC" | jq -r '.url' | sed 's|^https\{0,1\}://[^/]*||')"
ck "  ...version 1" "1" "$(echo "$SC" | jq -r '.version')"
ck "  ...visibility echoed (born private)" "private" "$(echo "$SC" | jq -r '.visibility')"
ck "  ...format html" "html" "$(echo "$SC" | jq -r '.format')"
echo "$SC" | jq -r '.content' | grep -q "VIEWER BODY MARKER" && BODY=present || BODY=absent
ck "  ...structuredContent carries the sanitized body" "present" "$BODY"
# Feature B: the model-facing TEXT block is the slim summary — metadata +
# note, NO body — while the full envelope (asserted above) rides
# structuredContent for the viewer.
TXT=$(echo "$VD" | jq -r '.result.content[0].text')
echo "$TXT" | grep -q "VIEWER BODY MARKER" && SLIM=leaks-body || SLIM=slim
ck "view's text block carries NO document body" "slim" "$SLIM"
ck "  ...but parses as metadata JSON with the public_id" "$ID" "$(echo "$TXT" | jq -r '.public_id')"
ck "  ...and carries the read_document pointer note" "true" \
  "$(echo "$TXT" | jq 'has("note") and (.content == null)')"

# --- 5. by-slug view resolves to the same doc --------------------------------
VS=$(mcp tools/call "{\"name\":\"view_document\",\"arguments\":{\"slug\":\"$SLUG\"}}")
ck "view_document by slug resolves the same doc" "$ID" \
  "$(echo "$VS" | jq -r '.result.structuredContent.public_id')"

# --- 5b. the write tools are NOT slimmed (the control) ------------------------
# view_document is the ONE tool whose text block diverges from
# structuredContent; a publish over MCP must still mirror its FULL envelope
# both ways (agents parse the write text block).
PUBM=$(mcp tools/call '{"name":"publish_document","arguments":{"content":"# MCP publish control\n\nCONTROL BODY","format":"markdown"}}')
ck "publish over MCP mirrors the FULL envelope in the text block" "true" \
  "$(echo "$PUBM" | jq '(.result.content[0].text | fromjson) == .result.structuredContent')"
ck "  ...and that envelope is a real write result" "1" \
  "$(echo "$PUBM" | jq -r '.result.structuredContent.version')"

# --- 6. failures are code-prefixed -------------------------------------------
BAD=$(mcp tools/call '{"name":"view_document","arguments":{"public_id":"AAAAAAAAAAAAAAAAAAAAAA"}}')
ck "unknown id is an isError result" "true" "$(echo "$BAD" | jq -r '.result.isError')"
echo "$BAD" | jq -r '.result.content[0].text' | grep -q '^not_found:' && PFX=yes || PFX=no
ck "  ...with the not_found: prefix" "yes" "$PFX"
NOV=$(mcp tools/call "{\"name\":\"view_document\",\"arguments\":{\"public_id\":\"$ID\",\"version\":99}}")
echo "$NOV" | jq -r '.result.content[0].text' | grep -q '^version_not_found:' && VPFX=yes || VPFX=no
ck "a missing version is version_not_found:-prefixed" "yes" "$VPFX"

# --- 7. server/discover advertises the extension -----------------------------
DISC=$(mcp server/discover)
ck "server/discover advertises io.modelcontextprotocol/ui" "true" \
  "$(echo "$DISC" | jq '.result.capabilities.extensions | has("io.modelcontextprotocol/ui")')"
ck "  ...and the resources capability" "true" \
  "$(echo "$DISC" | jq '.result.capabilities | has("resources")')"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ] || exit 1
