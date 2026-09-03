#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
# SPDX-License-Identifier: Apache-2.0
#
# Orchestrates running the end-to-end test suite (test/e2e/*.sh) against a
# running local Worker dev server. Usable both locally and in CI.
#
# SAFETY: If .dev.vars or wrangler.toml already exist (as in local development),
# they are NEVER overwritten or modified. Temporary files are synthesized only
# when missing (such as on fresh checkouts or in CI runners) and are cleaned
# up automatically on exit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CLEANUP_DEV_VARS=0
CLEANUP_WRANGLER_TOML=0
WRANGLER_PID=""
WRANGLER_LOG="/tmp/slopcafe-e2e-wrangler-$$.log"

cleanup() {
  local exit_code=$?
  if [ -n "$WRANGLER_PID" ] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo "== stopping wrangler dev (pid $WRANGLER_PID) =="
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  if [ "$CLEANUP_DEV_VARS" = "1" ] && [ -f .dev.vars ]; then
    echo "== removing synthesized .dev.vars =="
    rm -f .dev.vars
  fi
  if [ "$CLEANUP_WRANGLER_TOML" = "1" ] && [ -f wrangler.toml ]; then
    echo "== removing synthesized wrangler.toml =="
    rm -f wrangler.toml
  fi
  if [ "$exit_code" -ne 0 ] && [ -f "$WRANGLER_LOG" ]; then
    echo "== wrangler dev log on failure ($WRANGLER_LOG) =="
    cat "$WRANGLER_LOG"
  fi
  rm -f "$WRANGLER_LOG"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# 1. Synthesize .dev.vars only if missing (e.g. CI or fresh checkout)
if [ ! -f .dev.vars ]; then
  echo "== synthesizing temporary .dev.vars for testing =="
  cat << 'EOF' > .dev.vars
HMAC_PEPPER="ci-test-pepper-0123456789abcdef0123456789abcdef"
OPERATOR_TOKEN="ci-test-operator-token-0123456789abcdef0123456789abcdef"
EOF
  CLEANUP_DEV_VARS=1
fi

# 2. Synthesize wrangler.toml only if missing (e.g. CI or fresh checkout)
if [ ! -f wrangler.toml ]; then
  echo "== synthesizing temporary wrangler.toml for testing =="
  # Substitute placeholders, and comment out [ai] so wrangler dev does not
  # attempt a remote Cloudflare connection in unauthenticated environments.
  sed -e 's/<YOUR_CLOUDFLARE_ACCOUNT_ID>/ci-account/' \
      -e 's/<YOUR_D1_DATABASE_ID>/ci-db/' \
      -e 's/<YOUR_OAUTH_KV_NAMESPACE_ID>/ci-kv/' \
      wrangler.toml.example > wrangler.toml
  sed -i.bak -e '/^\[ai\]/,/^binding = "AI"/ s/^/# /' wrangler.toml
  rm -f wrangler.toml.bak
  CLEANUP_WRANGLER_TOML=1
fi

# 3. Apply local D1 database migrations
echo "== applying local D1 migrations =="
npx wrangler d1 migrations apply META --local

# 4. Start wrangler dev in the background
PORT="${PORT:-8787}"
echo "== starting wrangler dev on port $PORT =="
npx wrangler dev --port "$PORT" --var CORS_ALLOWED_ORIGINS:https://app.example > "$WRANGLER_LOG" 2>&1 &
WRANGLER_PID=$!

# 5. Wait for the server to be ready
echo "== waiting for http://localhost:$PORT/healthz =="
READY=0
for i in $(seq 1 30); do
  if curl -s "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo "FATAL: wrangler dev process exited unexpectedly before becoming ready"
    exit 1
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "FATAL: timed out waiting for wrangler dev to become healthy"
  exit 1
fi
echo "== wrangler dev is ready =="

# 6. Execute all E2E test suites in order
SCRIPTS=(
  test/e2e/published-version.sh
  test/e2e/no-op-collapse.sh
  test/e2e/mcp-apps.sh
  test/e2e/cors.sh
  test/e2e/curation-and-detail.sh
  test/e2e/backup-restore.sh
)

for S in "${SCRIPTS[@]}"; do
  echo
  echo "================================================================================"
  echo "== RUNNING: $S =="
  echo "================================================================================"
  bash "$S"
done

echo
echo "================================================================================"
echo "== ALL E2E SUITES PASSED =="
echo "================================================================================"
