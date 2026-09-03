#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end proof of `?tools=` toolset gating on /mcp (GitHub issue #59).
#
# WHY THIS EXISTS AS A SCRIPT. test/mcp-toolset.test.mjs covers the pure parse
# and scans the two wiring sites as source text, but it never speaks JSON-RPC:
# it cannot show that the OAuth wrap actually forwards a query-carrying /mcp
# request to us, that an excluded tool is really absent from tools/list, that
# calling one really errors, or that a typo really 400s at the transport edge
# instead of silently narrowing. Those are the properties a host depends on.
#
# Speaks the 2026-07-28 (modern/stateless) protocol with plain curl JSON-RPC
# POSTs over Door B (a minted awh_ bearer): no session handshake, one _meta
# envelope per request.
#
# USAGE (two terminals, local only — never point B at production):
#   npm run db:migrate:local && npm run dev
#   bash test/e2e/mcp-toolset.sh
#
# Reads OPERATOR_TOKEN from .dev.vars and mints a throwaway agent + key. It
# touches no documents at all, and never echoes a secret.
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
      -H 'content-type: application/json' -d '{"name":"e2e-mcp-toolset"}')
AGID=$(echo "$AG" | jq -r '.agent_id // .id')
KEY=$(curl -sS -X POST "$B/admin/agents/$AGID/keys" -H "authorization: Bearer $OP" \
      -H 'content-type: application/json' -d '{}' | jq -r '.key')
[ -n "$KEY" ] && [ "$KEY" != "null" ] || { echo "FATAL: key mint failed: $AG"; exit 1; }
echo "== credentials minted (agent $AGID) =="

# --- the JSON-RPC door, with an addressable URL ------------------------------
# Same envelope discipline as mcp-apps.sh (per-request `_meta` with
# protocolVersion + clientCapabilities, `Mcp-Method`, and `Mcp-Name` on
# name-addressed methods), but the URL is a parameter so each check can carry
# its own `?tools=`.
mcp_at() { # mcp_at <url> <method> [<params-json>]
  local url="$1" method="$2" params="${3:-{\}}"
  local name
  name=$(jq -nr --argjson p "$params" '$p.name // $p.uri // empty')
  local body
  body=$(jq -nc --arg m "$method" --argjson p "$params" \
    '{jsonrpc:"2.0", id:1, method:$m,
      params:($p + {"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                             "io.modelcontextprotocol/clientCapabilities":{}}})}')
  local -a name_header=()
  [ -n "$name" ] && name_header=(-H "Mcp-Name: $name")
  local out
  out=$(curl -sS -X POST "$url" -H "authorization: Bearer $KEY" \
        -H 'content-type: application/json' \
        -H 'accept: application/json, text/event-stream' \
        -H "Mcp-Method: $method" "${name_header[@]}" \
        --data-binary "$body")
  case "$out" in
    "{"*) printf '%s\n' "$out" ;;
    *)    printf '%s\n' "$out" | sed -n 's/^data: //p' | tail -n1 ;;
  esac
}

status_at() { # status_at <url> <method> — HTTP status only
  local url="$1" method="$2"
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$url" \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H "Mcp-Method: $method" \
    --data-binary '{"jsonrpc":"2.0","id":1,"method":"'"$method"'","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
}

body_at() { # body_at <url> <method> — raw response body
  local url="$1" method="$2"
  curl -sS -X POST "$url" \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H "Mcp-Method: $method" \
    --data-binary '{"jsonrpc":"2.0","id":1,"method":"'"$method"'","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
}

# --- 1. no parameter = zero regression ---------------------------------------
# The default path must be indistinguishable from a build without the feature.
ALL=$(mcp_at "$B/mcp" tools/list)
ck "no ?tools= → all eleven tools" "11" "$(echo "$ALL" | jq -r '.result.tools | length')"

# --- 2. narrowing -------------------------------------------------------------
TWO=$(mcp_at "$B/mcp?tools=read_document,list_documents" tools/list)
ck "?tools=read_document,list_documents → exactly 2" "2" \
  "$(echo "$TWO" | jq -r '.result.tools | length')"
ck "  ...and they are the two named (sorted)" "list_documents read_document" \
  "$(echo "$TWO" | jq -r '[.result.tools[].name] | sort | join(" ")')"

ONE=$(mcp_at "$B/mcp?tools=publish_document" tools/list)
ck "a single-tool set narrows to one" "publish_document" \
  "$(echo "$ONE" | jq -r '.result.tools[0].name')"
ck "  ...and it keeps its full registration (outputSchema survives gating)" "object" \
  "$(echo "$ONE" | jq -r '.result.tools[0].outputSchema.type')"
ck "  ...and its MCP Apps _meta link survives too" "ui://slopcafe/document-view.html" \
  "$(echo "$ONE" | jq -r '.result.tools[0]._meta.ui.resourceUri')"

# Cosmetics a hand-edited URL will contain.
SPACED=$(mcp_at "$B/mcp?tools=%20read_document%20,%20list_documents%20" tools/list)
ck "whitespace around names is tolerated" "2" "$(echo "$SPACED" | jq -r '.result.tools | length')"
TRAIL=$(mcp_at "$B/mcp?tools=read_document," tools/list)
ck "a trailing comma is tolerated" "1" "$(echo "$TRAIL" | jq -r '.result.tools | length')"

# --- 3. an excluded tool is genuinely gone -----------------------------------
# Not merely hidden from tools/list: calling it must error, or the narrowing
# would be cosmetic.
EXC=$(mcp_at "$B/mcp?tools=read_document" tools/call '{"name":"list_documents","arguments":{}}')
ck "calling an excluded tool is a JSON-RPC error" "true" \
  "$(echo "$EXC" | jq -r 'has("error")')"
ck "  ...and the error names the tool" "true" \
  "$(echo "$EXC" | jq -r '.error.message | contains("list_documents")')"
# The same call on an unnarrowed connection must succeed — otherwise the check
# above proves nothing about gating.
INC=$(mcp_at "$B/mcp" tools/call '{"name":"list_documents","arguments":{}}')
ck "  ...while the same call succeeds without ?tools=" "false" \
  "$(echo "$INC" | jq -r 'has("error")')"

# --- 4. an unknown name FAILS LOUD -------------------------------------------
# The point of the feature's error handling: a host configures the URL once, so
# a typo must not silently drop a tool.
ck "unknown tool name → HTTP 400" "400" "$(status_at "$B/mcp?tools=read_document,frobnicate" tools/list)"
BAD=$(body_at "$B/mcp?tools=read_document,frobnicate" tools/list)
ck "  ...with error=bad_request" "bad_request" "$(echo "$BAD" | jq -r '.error')"
ck "  ...and the message names the bad value" "true" \
  "$(echo "$BAD" | jq -r '.message | contains("frobnicate")')"
ck "  ...and lists what IS valid" "true" \
  "$(echo "$BAD" | jq -r '.message | contains("read_document")')"
ck "a near-miss (plural) is rejected, not silently dropped" "400" \
  "$(status_at "$B/mcp?tools=read_documents" tools/list)"
ck "wrong case is rejected" "400" "$(status_at "$B/mcp?tools=Read_Document" tools/list)"
ck "an empty ?tools= is rejected, NOT read as \"all\"" "400" "$(status_at "$B/mcp?tools=" tools/list)"
MULTI=$(body_at "$B/mcp?tools=frobnicate,widget" tools/list)
ck "several unknown names are reported together" "true" \
  "$(echo "$MULTI" | jq -r '(.message | contains("frobnicate")) and (.message | contains("widget"))')"

# --- 5. the rejection happens at CONNECT time --------------------------------
# It is a transport-level 400, so it fires on the handshake methods too — a
# misconfigured host fails immediately rather than on some later tools/call.
ck "a bad ?tools= 400s server/discover too (fails at connect)" "400" \
  "$(status_at "$B/mcp?tools=frobnicate" server/discover)"

# --- 6. Door A carries the query -------------------------------------------
# The OAuth provider matches its apiRoute on pathname ONLY, and derives the RFC
# 9728 protected-resource metadata URL from pathname only as well — so a token
# minted at /mcp is valid at /mcp?tools=… and there is no per-query metadata
# document to publish. Proven without an OAuth dance: an invalid Door A-shaped
# bearer gets a 401 whose WWW-Authenticate must be byte-identical on both URLs.
WWW_PLAIN=$(curl -sS -D- -o /dev/null -X POST "$B/mcp" \
  -H 'authorization: Bearer not:a:token' -H 'content-type: application/json' \
  -H 'Mcp-Method: tools/list' --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: //p')
WWW_TOOLS=$(curl -sS -D- -o /dev/null -X POST "$B/mcp?tools=read_document" \
  -H 'authorization: Bearer not:a:token' -H 'content-type: application/json' \
  -H 'Mcp-Method: tools/list' --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: //p')
ck "Door A: ?tools= does not change the RFC 9728 resource metadata URL" "$WWW_PLAIN" "$WWW_TOOLS"
ck "  ...and that URL is the bare /mcp path" "true" \
  "$(case "$WWW_TOOLS" in *'/.well-known/oauth-protected-resource/mcp"'*) echo true;; *) echo false;; esac)"

# --- 7. resources are unaffected ---------------------------------------------
# The gate wraps registerTool only; the MCP Apps template is a resource and must
# still be served on a narrowed connection (a host may prefetch it).
RES=$(mcp_at "$B/mcp?tools=read_document" resources/list)
ck "the ui:// template still lists on a narrowed connection" "ui://slopcafe/document-view.html" \
  "$(echo "$RES" | jq -r '.result.resources[] | select(.uri == "ui://slopcafe/document-view.html") | .uri')"

echo
echo "== mcp-toolset: $pass passed, $fail failed =="
[ "$fail" -eq 0 ] || exit 1
