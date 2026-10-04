package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/events"

	"math/big"

	"github.com/ethereum/go-ethereum/common"
)

// testStore connects to TEST_DATABASE_URL and truncates the chain-indexer
// tables before each test, so tests are independent and repeatable. Skips
// (not fails) if TEST_DATABASE_URL is unset - these are integration tests
// against a real PostgreSQL instance, not unit tests; see
// services/chain-indexer/README.md for how to point it at a local
// Postgres (docker-compose, or `brew services start postgresql@16`).
func testStore(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping store integration test (see services/chain-indexer/README.md)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	s, err := New(ctx, url)
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(s.Close)

	if _, err := s.Pool().Exec(ctx, `
		TRUNCATE escrow_events, chain_checkpoints, chain_config_state RESTART IDENTITY;
		TRUNCATE escrows, payment_records CASCADE;
	`); err != nil {
		t.Fatalf("truncate tables: %v", err)
	}
	return s
}

const testChainID = uint64(31337)
const testContract = "0x000000000000000000000000000000000000ab"

func sampleCreated(dealID int64) events.RiskEscrowCreated {
	return events.RiskEscrowCreated{
		DealId:             big.NewInt(dealID),
		QuoteId:            [32]byte{byte(dealID), 0x01},
		Depositor:          common.HexToAddress("0x1111111111111111111111111111111111111111"),
		Counterparty:       common.HexToAddress("0x2222222222222222222222222222222222222222"),
		SettlementAsset:    common.Address{},
		Notional:           big.NewInt(10_000000000000000),
		CollateralLocked:   big.NewInt(12_000000000000000),
		SettlementDeadline: big.NewInt(time.Now().Add(7 * 24 * time.Hour).Unix()),
		ModelVersion:       "garch-1.1.0",
		RiskSnapshotHash:   [32]byte{0xbb},
	}
}

func rawCreatedEvent(dealID int64, blockNumber uint64, blockHash, txHash string) RawEvent {
	ev := sampleCreated(dealID)
	deal := uint64(dealID)
	return RawEvent{
		ChainID:         testChainID,
		ContractAddress: testContract,
		BlockNumber:     blockNumber,
		BlockHash:       blockHash,
		TxHash:          txHash,
		TxIndex:         0,
		LogIndex:        0,
		EventName:       events.EventRiskEscrowCreated,
		DealID:          &deal,
		Decoded:         ev.ToDecodedMap(),
	}
}

func TestCheckpoint_LoadMissing_ReturnsNotFound(t *testing.T) {
	s := testStore(t)
	_, found, err := s.LoadCheckpoint(context.Background(), testChainID, testContract)
	if err != nil {
		t.Fatalf("LoadCheckpoint: %v", err)
	}
	if found {
		t.Fatal("expected found=false for a never-saved checkpoint")
	}
}

func TestCheckpoint_SaveAndLoad_RoundTrips(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	want := Checkpoint{
		ChainID: testChainID, ContractAddress: testContract,
		LastScannedBlock: 100, LastScannedBlockHash: "0xaaa", LastConfirmedBlock: 95,
	}
	if err := s.SaveCheckpoint(ctx, want); err != nil {
		t.Fatalf("SaveCheckpoint: %v", err)
	}

	got, found, err := s.LoadCheckpoint(ctx, testChainID, testContract)
	if err != nil {
		t.Fatalf("LoadCheckpoint: %v", err)
	}
	if !found || got != want {
		t.Fatalf("LoadCheckpoint = (%+v, %v), want (%+v, true)", got, found, want)
	}

	// Overwrite - SaveCheckpoint must upsert, not fail on conflict.
	want.LastScannedBlock = 150
	if err := s.SaveCheckpoint(ctx, want); err != nil {
		t.Fatalf("SaveCheckpoint (update): %v", err)
	}
	got, _, _ = s.LoadCheckpoint(ctx, testChainID, testContract)
	if got.LastScannedBlock != 150 {
		t.Errorf("LastScannedBlock after update = %d, want 150", got.LastScannedBlock)
	}
}

func TestUpsertObservedEvent_FirstInsertReportsInserted(t *testing.T) {
	s := testStore(t)
	ev := rawCreatedEvent(1, 10, "0xblock10", "0xtx1")

	outcome, err := s.UpsertObservedEvent(context.Background(), ev)
	if err != nil {
		t.Fatalf("UpsertObservedEvent: %v", err)
	}
	if outcome != OutcomeInserted {
		t.Errorf("outcome = %v, want Inserted", outcome)
	}
}

func TestUpsertObservedEvent_IdenticalReplay_IsIdempotent(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	ev := rawCreatedEvent(1, 10, "0xblock10", "0xtx1")

	if _, err := s.UpsertObservedEvent(ctx, ev); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	outcome, err := s.UpsertObservedEvent(ctx, ev)
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if outcome != OutcomeDuplicateIgnored {
		t.Errorf("outcome = %v, want DuplicateIgnored", outcome)
	}

	var count int
	if err := s.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM escrow_events`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("escrow_events row count = %d, want 1 (replay must not duplicate)", count)
	}
}

// TestIdempotent_RescanSameRange is the regression test item 8 of the
// phase spec requires: scanning the same block range twice must yield
// identical database state.
func TestIdempotent_RescanSameRange(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	scanRange := func() {
		for dealID := int64(1); dealID <= 3; dealID++ {
			ev := rawCreatedEvent(dealID, uint64(10+dealID), "0xblockhash", "0xtx")
			ev.TxHash = ev.TxHash + big.NewInt(dealID).String()
			if _, err := s.UpsertObservedEvent(ctx, ev); err != nil {
				t.Fatalf("UpsertObservedEvent: %v", err)
			}
		}
	}

	scanRange()
	var firstCount int
	s.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM escrow_events`).Scan(&firstCount)

	scanRange() // rescan identical range
	var secondCount int
	s.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM escrow_events`).Scan(&secondCount)

	if firstCount != 3 || secondCount != 3 {
		t.Errorf("row counts = (%d, %d), want (3, 3)", firstCount, secondCount)
	}
}

func TestUpsertObservedEvent_ReorgReplacement_UpdatesInPlace(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	original := rawCreatedEvent(1, 10, "0xblockA", "0xtx1")
	if _, err := s.UpsertObservedEvent(ctx, original); err != nil {
		t.Fatalf("initial upsert: %v", err)
	}

	// Same (chain_id, tx_hash, log_index) identity, but the tx landed in a
	// different block after a reorg.
	replaced := original
	replaced.BlockNumber = 11
	replaced.BlockHash = "0xblockB"

	outcome, err := s.UpsertObservedEvent(ctx, replaced)
	if err != nil {
		t.Fatalf("replacement upsert: %v", err)
	}
	if outcome != OutcomeUpdatedReorg {
		t.Errorf("outcome = %v, want UpdatedReorg", outcome)
	}

	var count int
	s.Pool().QueryRow(ctx, `SELECT COUNT(*) FROM escrow_events`).Scan(&count)
	if count != 1 {
		t.Errorf("row count = %d, want 1 (update in place, not a duplicate row)", count)
	}

	var blockNumber uint64
	var confirmationState string
	s.Pool().QueryRow(ctx, `SELECT block_number, confirmation_state FROM escrow_events WHERE tx_hash = $1`, original.TxHash).
		Scan(&blockNumber, &confirmationState)
	if blockNumber != 11 {
		t.Errorf("block_number = %d, want 11", blockNumber)
	}
	if confirmationState != "observed" {
		t.Errorf("confirmation_state = %q, want %q (reorg must reset confirmation progress)", confirmationState, "observed")
	}
}

func TestPendingConfirmationBlocks_FiltersByDepthAndOrphan(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	ev1 := rawCreatedEvent(1, 10, "0xb10", "0xtxa")
	ev2 := rawCreatedEvent(2, 20, "0xb20", "0xtxb")
	s.UpsertObservedEvent(ctx, ev1)
	s.UpsertObservedEvent(ctx, ev2)

	blocks, err := s.PendingConfirmationBlocks(ctx, testChainID, testContract, 15)
	if err != nil {
		t.Fatalf("PendingConfirmationBlocks: %v", err)
	}
	if len(blocks) != 1 || blocks[0].BlockNumber != 10 {
		t.Fatalf("blocks = %+v, want exactly block 10", blocks)
	}

	blocksAll, err := s.PendingConfirmationBlocks(ctx, testChainID, testContract, 25)
	if err != nil {
		t.Fatalf("PendingConfirmationBlocks: %v", err)
	}
	if len(blocksAll) != 2 {
		t.Fatalf("blocksAll = %+v, want 2 blocks", blocksAll)
	}
}

func TestApplyAndConfirmBlock_Created_ActivatesEscrow(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	ev := rawCreatedEvent(1, 10, "0xb10", "0xtxa")
	if _, err := s.UpsertObservedEvent(ctx, ev); err != nil {
		t.Fatalf("UpsertObservedEvent: %v", err)
	}

	n, err := s.ApplyAndConfirmBlock(ctx, testChainID, testContract, 10)
	if err != nil {
		t.Fatalf("ApplyAndConfirmBlock: %v", err)
	}
	if n != 1 {
		t.Fatalf("confirmed count = %d, want 1", n)
	}

	var status, quoteID, riskSnapshotHash string
	var onChainDealID int64
	err = s.Pool().QueryRow(ctx, `
		SELECT status, on_chain_deal_id, quote_id, risk_snapshot_hash FROM escrows WHERE chain_id = $1 AND contract_address = $2 AND on_chain_deal_id = 1
	`, testChainID, testContract).Scan(&status, &onChainDealID, &quoteID, &riskSnapshotHash)
	if err != nil {
		t.Fatalf("query escrow: %v", err)
	}
	if status != "active" {
		t.Errorf("status = %q, want %q", status, "active")
	}
	// Regression guard: quote_id and risk_snapshot_hash come from distinct
	// event fields (QuoteId vs RiskSnapshotHash) and must never collapse to
	// the same value - applyCreated previously wrote quoteID into both
	// columns.
	wantRiskSnapshotHash := "0xbb00000000000000000000000000000000000000000000000000000000000000"
	if riskSnapshotHash != wantRiskSnapshotHash {
		t.Errorf("risk_snapshot_hash = %q, want %q", riskSnapshotHash, wantRiskSnapshotHash)
	}
	if riskSnapshotHash == quoteID {
		t.Errorf("risk_snapshot_hash (%q) must not equal quote_id (%q)", riskSnapshotHash, quoteID)
	}

	var confirmationState string
	s.Pool().QueryRow(ctx, `SELECT confirmation_state FROM escrow_events WHERE tx_hash = $1`, ev.TxHash).Scan(&confirmationState)
	if confirmationState != "confirmed" {
		t.Errorf("confirmation_state = %q, want confirmed", confirmationState)
	}
}

func TestApplyAndConfirmBlock_IsIdempotent_ReapplyIsNoOp(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	ev := rawCreatedEvent(1, 10, "0xb10", "0xtxa")
	s.UpsertObservedEvent(ctx, ev)

	first, err := s.ApplyAndConfirmBlock(ctx, testChainID, testContract, 10)
	if err != nil {
		t.Fatalf("first ApplyAndConfirmBlock: %v", err)
	}
	// Re-running against the same block must find nothing left to confirm,
	// since the event's confirmation_state is already 'confirmed' - this is
	// what makes a restart mid-confirmation safe.
	second, err := s.ApplyAndConfirmBlock(ctx, testChainID, testContract, 10)
	if err != nil {
		t.Fatalf("second ApplyAndConfirmBlock: %v", err)
	}
	if first != 1 || second != 0 {
		t.Errorf("confirmed counts = (%d, %d), want (1, 0)", first, second)
	}
}

func TestApplyAndConfirmBlock_FullLifecycle_CreatedSettled(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	created := rawCreatedEvent(1, 10, "0xb10", "0xtx-create")
	s.UpsertObservedEvent(ctx, created)
	if _, err := s.ApplyAndConfirmBlock(ctx, testChainID, testContract, 10); err != nil {
		t.Fatalf("confirm created: %v", err)
	}

	settled := events.RiskEscrowSettled{
		DealId: big.NewInt(1), Counterparty: common.HexToAddress("0x2222222222222222222222222222222222222222"),
		Payout: big.NewInt(9_500000000000000), PlatformFee: big.NewInt(500000000000000), DepositorRefund: big.NewInt(2_000000000000000),
	}
	dealID := uint64(1)
	settledEv := RawEvent{
		ChainID: testChainID, ContractAddress: testContract,
		BlockNumber: 20, BlockHash: "0xb20", TxHash: "0xtx-settle", TxIndex: 0, LogIndex: 0,
		EventName: events.EventRiskEscrowSettled, DealID: &dealID, Decoded: settled.ToDecodedMap(),
	}
	s.UpsertObservedEvent(ctx, settledEv)
	if _, err := s.ApplyAndConfirmBlock(ctx, testChainID, testContract, 20); err != nil {
		t.Fatalf("confirm settled: %v", err)
	}

	var status, settledTxHash string
	err := s.Pool().QueryRow(ctx, `
		SELECT status, settled_tx_hash FROM escrows WHERE chain_id = $1 AND contract_address = $2 AND on_chain_deal_id = 1
	`, testChainID, testContract).Scan(&status, &settledTxHash)
	if err != nil {
		t.Fatalf("query escrow: %v", err)
	}
	if status != "settled" {
		t.Errorf("status = %q, want settled", status)
	}
	if settledTxHash != "0xtx-settle" {
		t.Errorf("settled_tx_hash = %q, want 0xtx-settle", settledTxHash)
	}
}

func TestOrphanFromBlock_MarksEventsOrphanedAndExcludesFromConfirmation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	ev10 := rawCreatedEvent(1, 10, "0xb10-old", "0xtx10")
	ev11 := rawCreatedEvent(2, 11, "0xb11-old", "0xtx11")
	s.UpsertObservedEvent(ctx, ev10)
	s.UpsertObservedEvent(ctx, ev11)

	affected, err := s.OrphanFromBlock(ctx, testChainID, testContract, 10)
	if err != nil {
		t.Fatalf("OrphanFromBlock: %v", err)
	}
	if affected != 2 {
		t.Errorf("affected = %d, want 2", affected)
	}

	blocks, err := s.PendingConfirmationBlocks(ctx, testChainID, testContract, 100)
	if err != nil {
		t.Fatalf("PendingConfirmationBlocks: %v", err)
	}
	if len(blocks) != 0 {
		t.Errorf("blocks = %+v, want none (all orphaned)", blocks)
	}

	// A confirmed pass over an orphaned block must find nothing to confirm.
	n, err := s.ApplyAndConfirmBlock(ctx, testChainID, testContract, 10)
	if err != nil {
		t.Fatalf("ApplyAndConfirmBlock: %v", err)
	}
	if n != 0 {
		t.Errorf("confirmed count = %d, want 0 (orphaned events must never be confirmed)", n)
	}
}

func TestApplyAndConfirmBlock_ConfigEvents(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	feeEv := events.PlatformFeeUpdated{PreviousFeeBps: big.NewInt(500), NewFeeBps: big.NewInt(750)}
	raw := RawEvent{
		ChainID: testChainID, ContractAddress: testContract,
		BlockNumber: 5, BlockHash: "0xb5", TxHash: "0xtx-fee", TxIndex: 0, LogIndex: 0,
		EventName: events.EventPlatformFeeUpdated, DealID: nil, Decoded: feeEv.ToDecodedMap(),
	}
	s.UpsertObservedEvent(ctx, raw)
	if _, err := s.ApplyAndConfirmBlock(ctx, testChainID, testContract, 5); err != nil {
		t.Fatalf("ApplyAndConfirmBlock: %v", err)
	}

	var feeBps int
	err := s.Pool().QueryRow(ctx, `
		SELECT platform_fee_bps FROM chain_config_state WHERE chain_id = $1 AND contract_address = $2
	`, testChainID, testContract).Scan(&feeBps)
	if err != nil {
		t.Fatalf("query chain_config_state: %v", err)
	}
	if feeBps != 750 {
		t.Errorf("platform_fee_bps = %d, want 750", feeBps)
	}
}
