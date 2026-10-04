// Package integration exercises the full Phase F pipeline against real
// components rather than mocks wherever practical: a real local Hardhat
// node, the real deployed RiskEscrow contract, a real Python-priced and
// signed RiskQuote (quant/), and a real PostgreSQL instance.
//
// These tests are skipped (not failed) when their dependencies aren't
// available in the current environment - matching the convention already
// established by contracts/test/pythonRiskQuoteIntegration.test.js for the
// Python signer - so `go test ./...` stays green in a sandbox that has
// neither `npx`/Hardhat nor a reachable TEST_DATABASE_URL, while still
// running for real wherever both are present (see
// services/chain-indexer/README.md for how to set that up locally).
package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/chain"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/config"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/metrics"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/store"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/workers"
)

const hardhatRPC = "http://127.0.0.1:8545"

// repoRoot locates the monorepo root from this test file's own path, so
// the Hardhat commands below run with the right working directory
// regardless of where `go test` is invoked from.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not determine test file path")
	}
	// services/chain-indexer/tests/integration/e2e_test.go -> repo root
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..")
}

func requireNpx(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("npx"); err != nil {
		t.Skip("npx not found on PATH; skipping Hardhat-backed integration test")
	}
}

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test (see services/chain-indexer/README.md)")
	}
	return url
}

// startHardhatNode launches `npx hardhat node` in its own process group
// (so its child geth-like process can be killed together with it on
// cleanup) and waits for its JSON-RPC endpoint to respond.
func startHardhatNode(t *testing.T, root string) {
	t.Helper()

	cmd := exec.Command("npx", "hardhat", "node")
	cmd.Dir = root
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	logFile, err := os.CreateTemp("", "hardhat-node-*.log")
	if err != nil {
		t.Fatalf("create hardhat node log file: %v", err)
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile

	if err := cmd.Start(); err != nil {
		t.Fatalf("start hardhat node: %v", err)
	}

	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			_, _ = cmd.Process.Wait()
		}
		logFile.Close()
		os.Remove(logFile.Name())
	})

	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if rpcReachable(hardhatRPC) {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	logBytes, _ := os.ReadFile(logFile.Name())
	t.Fatalf("hardhat node did not become reachable at %s within 30s; log:\n%s", hardhatRPC, string(logBytes))
}

func rpcReachable(url string) bool {
	body := strings.NewReader(`{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}`)
	req, err := http.NewRequest(http.MethodPost, url, body)
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

type fixtureDeal struct {
	Kind               string `json:"kind"`
	DealID             string `json:"dealId"`
	QuoteID            string `json:"quoteId"`
	Notional           string `json:"notional"`
	RequiredCollateral string `json:"requiredCollateral"`
	CreateTxHash       string `json:"createTxHash"`
	CreateBlockNumber  int64  `json:"createBlockNumber"`
	CloseTxHash        string `json:"closeTxHash"`
	CloseBlockNumber   int64  `json:"closeBlockNumber"`
}

type fixtureResult struct {
	ChainID         int64         `json:"chainId"`
	ContractAddress string        `json:"contractAddress"`
	Deals           []fixtureDeal `json:"deals"`
}

// runFixture deploys RiskEscrow and drives it through a real
// Python-signed create -> settle and create -> refund lifecycle (see
// contracts/scripts/chain_indexer_e2e_fixture.js), against the Hardhat
// node already running at hardhatRPC.
func runFixture(t *testing.T, root string) fixtureResult {
	t.Helper()

	cmd := exec.Command("npx", "hardhat", "run", "--network", "localhost",
		"contracts/scripts/chain_indexer_e2e_fixture.js")
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("fixture script failed: %v\noutput:\n%s", err, string(out))
	}

	var jsonLine string
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "FIXTURE_JSON:") {
			jsonLine = strings.TrimPrefix(line, "FIXTURE_JSON:")
			break
		}
	}
	if jsonLine == "" {
		t.Fatalf("fixture script did not print FIXTURE_JSON line; output:\n%s", string(out))
	}

	var result fixtureResult
	if err := json.Unmarshal([]byte(jsonLine), &result); err != nil {
		t.Fatalf("parse fixture JSON: %v\nline: %s", err, jsonLine)
	}
	if !strings.HasPrefix(result.ContractAddress, "0x") {
		t.Fatalf("fixture output missing a valid ContractAddress: %q", result.ContractAddress)
	}
	return result
}

func truncateIndexerTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		TRUNCATE escrow_events, chain_checkpoints, chain_config_state RESTART IDENTITY;
		TRUNCATE escrows, payment_records CASCADE;
	`); err != nil {
		t.Fatalf("truncate tables: %v", err)
	}
}

func TestEndToEnd_PythonQuoteToSolidityToIndexerToPostgres(t *testing.T) {
	requireNpx(t)
	dbURL := testDatabaseURL(t)
	root := repoRoot(t)

	startHardhatNode(t, root)
	fixture := runFixture(t, root)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	db, err := store.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer db.Close()
	truncateIndexerTables(t, db.Pool())

	client, err := chain.Dial(ctx, hardhatRPC, chain.RetryConfig{MaxAttempts: 3, BaseDelay: 100 * time.Millisecond, MaxDelay: time.Second})
	if err != nil {
		t.Fatalf("chain.Dial: %v", err)
	}
	defer client.Close()

	cfg := config.Config{
		RPCURL:             hardhatRPC,
		ChainID:            uint64(fixture.ChainID),
		RiskEscrowAddress:  common.HexToAddress(fixture.ContractAddress),
		StartBlock:         0,
		ConfirmationDepth:  2,
		DatabaseURL:        dbURL,
		PollInterval:       time.Second,
		MaxBlockRange:      2000,
		MaxConcurrentScans: 2,
		HealthAddr:         ":0",
	}

	health := metrics.New(cfg.ChainID, cfg.RiskEscrowAddress.Hex(), cfg.ConfirmationDepth)
	ix := workers.New(client, db, cfg, health)

	if err := ix.Validate(ctx); err != nil {
		t.Fatalf("Validate: %v", err)
	}

	if err := ix.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	settled := fixture.Deals[0]
	refunded := fixture.Deals[1]
	if settled.Kind != "settled" || refunded.Kind != "refunded" {
		t.Fatalf("unexpected fixture deal order: %+v", fixture.Deals)
	}

	assertEscrowState(t, db.Pool(), uint64(cfg.ChainID), fixture.ContractAddress, settled.DealID, "settled", settled.CloseTxHash, settled.Notional, settled.RequiredCollateral)
	assertEscrowState(t, db.Pool(), uint64(cfg.ChainID), fixture.ContractAddress, refunded.DealID, "refunded", refunded.CloseTxHash, refunded.Notional, refunded.RequiredCollateral)

	var confirmedEventCount int
	err = db.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM escrow_events WHERE confirmation_state = 'confirmed'`).Scan(&confirmedEventCount)
	if err != nil {
		t.Fatalf("count confirmed events: %v", err)
	}
	if confirmedEventCount < 4 { // 2 creates + 1 settle + 1 refund, at minimum
		t.Errorf("confirmed event count = %d, want >= 4", confirmedEventCount)
	}

	// --- Idempotency: rescanning must not duplicate anything ---
	var eventCountBefore, escrowCountBefore int
	db.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM escrow_events`).Scan(&eventCountBefore)
	db.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM escrows`).Scan(&escrowCountBefore)

	for i := 0; i < 2; i++ {
		if err := ix.RunOnce(ctx); err != nil {
			t.Fatalf("repeated RunOnce[%d]: %v", i, err)
		}
	}

	var eventCountAfter, escrowCountAfter int
	db.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM escrow_events`).Scan(&eventCountAfter)
	db.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM escrows`).Scan(&escrowCountAfter)

	if eventCountBefore != eventCountAfter {
		t.Errorf("escrow_events count changed on repeated scan: %d -> %d", eventCountBefore, eventCountAfter)
	}
	if escrowCountBefore != escrowCountAfter {
		t.Errorf("escrows count changed on repeated scan: %d -> %d", escrowCountBefore, escrowCountAfter)
	}

	// --- Restart recovery: a brand-new Indexer/chain client against the
	// same persisted checkpoint must resume cleanly without re-deriving
	// anything from scratch or duplicating state. ---
	restartClient, err := chain.Dial(ctx, hardhatRPC, chain.DefaultRetryConfig())
	if err != nil {
		t.Fatalf("chain.Dial (restart): %v", err)
	}
	defer restartClient.Close()

	restarted := workers.New(restartClient, db, cfg, metrics.New(cfg.ChainID, cfg.RiskEscrowAddress.Hex(), cfg.ConfirmationDepth))
	if err := restarted.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce after simulated restart: %v", err)
	}

	var eventCountAfterRestart int
	db.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM escrow_events`).Scan(&eventCountAfterRestart)
	if eventCountAfterRestart != eventCountBefore {
		t.Errorf("escrow_events count changed after simulated restart: %d -> %d", eventCountBefore, eventCountAfterRestart)
	}
}

func assertEscrowState(t *testing.T, pool *pgxpool.Pool, chainID uint64, contractAddress, dealID, wantStatus, wantTxHash, wantNotional, wantCollateral string) {
	t.Helper()
	ctx := context.Background()

	dealIDInt, ok := new(big.Int).SetString(dealID, 10)
	if !ok {
		t.Fatalf("invalid dealID %q", dealID)
	}

	var status, notional, collateral string
	var txHash *string
	column := "settled_tx_hash"
	if wantStatus == "refunded" {
		column = "refunded_tx_hash"
	}

	query := fmt.Sprintf(`
		SELECT status, notional, required_collateral, %s
		FROM escrows
		WHERE chain_id = $1 AND contract_address = $2 AND on_chain_deal_id = $3
	`, column)
	err := pool.QueryRow(ctx, query, chainID, contractAddress, dealIDInt.Int64()).Scan(&status, &notional, &collateral, &txHash)
	if err != nil {
		t.Fatalf("query escrow (dealID=%s): %v", dealID, err)
	}

	if status != wantStatus {
		t.Errorf("deal %s: status = %q, want %q", dealID, status, wantStatus)
	}
	if notional != wantNotional {
		t.Errorf("deal %s: notional = %q, want %q", dealID, notional, wantNotional)
	}
	if collateral != wantCollateral {
		t.Errorf("deal %s: required_collateral = %q, want %q", dealID, collateral, wantCollateral)
	}
	if txHash == nil || !strings.EqualFold(*txHash, wantTxHash) {
		t.Errorf("deal %s: %s = %v, want %q", dealID, column, txHash, wantTxHash)
	}
}
