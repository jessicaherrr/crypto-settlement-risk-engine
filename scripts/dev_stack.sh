#!/usr/bin/env bash
# One-command local demo stack: Postgres -> migrate -> local Hardhat node
# (with interval mining) -> compile/deploy RiskEscrow + a MockERC20 ->
# the Python risk-oracle service -> the Go chain indexer -> Next.js.
#
#   npm run stack        (or: make stack)
#
# Every piece here is a real Phase C-F component, run the same way the
# rest of this repo already documents running it individually - this
# script only sequences and waits for them. Logs land in .local/logs/;
# Ctrl+C stops everything.
#
# Requires: node, go, psql, a quant/.venv (see quant/README.md), and a
# reachable Postgres (brew/local install, or `docker compose up -d postgres`).
# Does not use docker-compose for the app services themselves - a Hardhat
# node running on the host is awkward for a container to reach, so the
# native path here is what Amoy would eventually replace, not something
# this script containerizes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_ROOT/.local/logs"
mkdir -p "$LOG_DIR"

PIDS=()
cleanup() {
  echo ""
  echo "Shutting down local stack..."
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait_for_http() {
  local url="$1" label="$2" attempts="${3:-30}"
  echo "    waiting for $label..."
  for _ in $(seq 1 "$attempts"); do
    if curl -s -o /dev/null "$url"; then
      return 0
    fi
    sleep 1
  done
  echo "    $label did not come up in time - check its log in $LOG_DIR" >&2
  return 1
}

echo "==> Checking prerequisites..."
for bin in node go psql curl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: $bin is required on PATH"; exit 1; }
done
if [ ! -d "$REPO_ROOT/quant/.venv" ]; then
  echo "error: quant/.venv not found - set up the Python venv first (see quant/README.md)"
  exit 1
fi

DATABASE_URL="${DATABASE_URL:-postgres://askgene:askgene@localhost:5432/askgene_quantfi}"
echo "==> Checking Postgres is reachable..."
if ! pg_isready -q >/dev/null 2>&1; then
  echo "error: Postgres doesn't appear to be running."
  echo "       Start it (brew services start postgresql@16, or 'docker compose up -d postgres') and re-run."
  exit 1
fi

echo "==> Running migrations..."
DATABASE_URL="$DATABASE_URL" bash "$REPO_ROOT/scripts/db_migrate.sh"

echo "==> Starting a local Hardhat node on :8545..."
(cd "$REPO_ROOT" && npx hardhat node) > "$LOG_DIR/hardhat.log" 2>&1 &
PIDS+=("$!")
wait_for_http "http://127.0.0.1:8545" "Hardhat node" 30

echo "==> Enabling interval mining (every 2s), so confirmations advance without manual transactions..."
curl -s -X POST http://127.0.0.1:8545 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"evm_setIntervalMining","params":[2000],"id":1}' >/dev/null

echo "==> Compiling contracts and exporting the frontend ABI..."
(cd "$REPO_ROOT" && npm run compile >> "$LOG_DIR/hardhat.log" 2>&1)
(cd "$REPO_ROOT" && npm run abi:export >> "$LOG_DIR/hardhat.log" 2>&1)

echo "==> Deploying RiskEscrow + a MockERC20 (tWETH) locally..."
(cd "$REPO_ROOT" && npx hardhat run contracts/scripts/deploy_local.js --network localhost | tee -a "$LOG_DIR/hardhat.log")

echo "==> Linking apps/web/.env.local to the root .env.local..."
node "$REPO_ROOT/scripts/ensure_env_symlink.js"

# shellcheck disable=SC1091
set -a; source "$REPO_ROOT/.env.local"; set +a

echo "==> Starting the Python risk-oracle service on :8001..."
(
  cd "$REPO_ROOT/quant"
  export RISK_ORACLE_PRIVATE_KEY="${RISK_ORACLE_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
  export ASKGENE_WARM_ANALYTICS=1
  # The editable install's .pth occasionally doesn't get picked up by a
  # plain `uvicorn` invocation on this kind of setup (pytest is
  # unaffected - it sets this itself via pyproject.toml's
  # [tool.pytest.ini_options] pythonpath). Setting it explicitly here
  # costs nothing when the editable install *is* working and fixes it
  # when it isn't.
  export PYTHONPATH="$REPO_ROOT/quant/src${PYTHONPATH:+:$PYTHONPATH}"
  exec .venv/bin/uvicorn askgene_quant.service.app:app --port 8001
) > "$LOG_DIR/quant.log" 2>&1 &
PIDS+=("$!")
wait_for_http "http://127.0.0.1:8001/v1/oracle" "risk-oracle service" 60

echo "==> Starting the Go chain indexer on :8090..."
(
  cd "$REPO_ROOT/services/chain-indexer"
  exec env \
    RPC_URL="http://127.0.0.1:8545" \
    CHAIN_ID="$CHAIN_ID" \
    RISK_ESCROW_ADDRESS="$RISK_ESCROW_ADDRESS" \
    START_BLOCK=0 \
    CONFIRMATION_DEPTH=2 \
    POLL_INTERVAL_SECONDS=1 \
    DATABASE_URL="$DATABASE_URL" \
    go run ./cmd/indexer
) > "$LOG_DIR/indexer.log" 2>&1 &
PIDS+=("$!")
wait_for_http "http://127.0.0.1:8090/" "chain indexer" 30

echo "==> Starting Next.js on :3000..."
(cd "$REPO_ROOT" && npm run dev:webpack -w apps/web) > "$LOG_DIR/web.log" 2>&1 &
PIDS+=("$!")
wait_for_http "http://127.0.0.1:3000" "Next.js" 60

cat <<EOF

============================================================
Local stack is up:
  Dashboard:       http://localhost:3000
  Risk service:    http://localhost:8001/v1/oracle
  Indexer health:  http://localhost:8090/
  Hardhat RPC:     http://127.0.0.1:8545 (chainId 31337)

MetaMask: add a network with RPC http://127.0.0.1:8545, chain ID 31337.
Import a test account's private key from this Hardhat node's own startup
log ($LOG_DIR/hardhat.log) - never use these on any real network.
If MetaMask shows a stale nonce after restarting this stack, reset the
account (Settings -> Advanced -> Clear activity tab data).

A quote's 5-minute validity window is wall-clock time; don't call
evm_increaseTime on this chain or later quotes will appear expired
immediately (see docs/architecture.md).

Logs: $LOG_DIR/*.log
Press Ctrl+C to stop everything.
============================================================
EOF

wait
