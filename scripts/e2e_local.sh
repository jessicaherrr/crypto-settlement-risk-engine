#!/usr/bin/env bash
# Boots the full local demo stack, runs the real quote -> create ->
# on-chain tx -> indexer-confirmed -> settle/refund journey against it
# (apps/web/tests/integration/escrow-journey.test.ts), then tears the
# stack down. This is the "did the whole system actually work, for
# real, just now" check - no mocks anywhere in the path it drives.
#
#   bash scripts/e2e_local.sh
#
# The journey test's refund case advances the local chain's clock
# (evm_increaseTime), which is why this script always starts a fresh
# stack rather than reusing one that might already have issued quotes.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$REPO_ROOT/scripts/dev_stack.sh" &
STACK_PID=$!

cleanup() {
  kill "$STACK_PID" >/dev/null 2>&1 || true
  wait "$STACK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Waiting for the stack to come up..."
for _ in $(seq 1 90); do
  if curl -s -o /dev/null http://127.0.0.1:3000 \
    && curl -s -o /dev/null http://127.0.0.1:8001/v1/oracle \
    && curl -s -o /dev/null http://127.0.0.1:8090/; then
    break
  fi
  sleep 1
done

echo "==> Running the escrow journey test..."
cd "$REPO_ROOT/apps/web"
E2E_STACK=1 npx vitest run tests/integration/escrow-journey.test.ts

echo "==> Journey test passed."
