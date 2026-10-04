package workers

import (
	"context"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/config"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/metrics"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/store"
)

func TestReorgRewindTarget(t *testing.T) {
	cases := []struct {
		name                           string
		lastScanned, depth, startBlock uint64
		want                           uint64
	}{
		{"typical rewind", 100, 5, 0, 95},
		{"zero depth treated as 1", 100, 0, 0, 99},
		{"never rewinds below startBlock", 10, 5, 8, 8},
		{"lastScanned at or below window floors at startBlock", 3, 5, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := reorgRewindTarget(c.lastScanned, c.depth, c.startBlock)
			if got != c.want {
				t.Errorf("reorgRewindTarget(%d,%d,%d) = %d, want %d", c.lastScanned, c.depth, c.startBlock, got, c.want)
			}
		})
	}
}

// fakeDB is an in-memory DB test double, letting Indexer logic be tested
// without a live PostgreSQL instance.
type fakeDB struct {
	checkpoints map[string]store.Checkpoint
	events      map[string]store.RawEvent // key: chainID|txHash|logIndex
	escrowed    map[int64]string          // dealID -> status, set by ApplyAndConfirmBlock
	orphaned    map[uint64]bool           // blockNumber -> orphaned
	confirmErr  error
}

func newFakeDB() *fakeDB {
	return &fakeDB{
		checkpoints: map[string]store.Checkpoint{},
		events:      map[string]store.RawEvent{},
		escrowed:    map[int64]string{},
		orphaned:    map[uint64]bool{},
	}
}

func cpKey(chainID uint64, contract string) string { return contract }

func (f *fakeDB) LoadCheckpoint(ctx context.Context, chainID uint64, contractAddress string) (store.Checkpoint, bool, error) {
	cp, ok := f.checkpoints[cpKey(chainID, contractAddress)]
	return cp, ok, nil
}

func (f *fakeDB) SaveCheckpoint(ctx context.Context, cp store.Checkpoint) error {
	f.checkpoints[cpKey(cp.ChainID, cp.ContractAddress)] = cp
	return nil
}

func evKey(chainID uint64, txHash string, logIndex uint) string {
	return txHash + "|" + string(rune(logIndex))
}

func (f *fakeDB) UpsertObservedEvent(ctx context.Context, ev store.RawEvent) (store.UpsertOutcome, error) {
	k := evKey(ev.ChainID, ev.TxHash, ev.LogIndex)
	if existing, ok := f.events[k]; ok {
		if existing.BlockHash == ev.BlockHash {
			return store.OutcomeDuplicateIgnored, nil
		}
		f.events[k] = ev
		return store.OutcomeUpdatedReorg, nil
	}
	f.events[k] = ev
	return store.OutcomeInserted, nil
}

func (f *fakeDB) PendingConfirmationBlocks(ctx context.Context, chainID uint64, contractAddress string, upToBlock uint64) ([]store.BlockRef, error) {
	seen := map[uint64]string{}
	var blocks []uint64
	for _, ev := range f.events {
		if f.orphaned[ev.BlockNumber] || ev.BlockNumber > upToBlock {
			continue
		}
		if _, ok := seen[ev.BlockNumber]; !ok {
			seen[ev.BlockNumber] = ev.BlockHash
			blocks = append(blocks, ev.BlockNumber)
		}
	}
	// simple ascending sort (small N in tests)
	for i := 0; i < len(blocks); i++ {
		for j := i + 1; j < len(blocks); j++ {
			if blocks[j] < blocks[i] {
				blocks[i], blocks[j] = blocks[j], blocks[i]
			}
		}
	}
	out := make([]store.BlockRef, len(blocks))
	for i, b := range blocks {
		out[i] = store.BlockRef{BlockNumber: b, BlockHash: seen[b]}
	}
	return out, nil
}

func (f *fakeDB) OrphanFromBlock(ctx context.Context, chainID uint64, contractAddress string, fromBlock uint64) (int64, error) {
	var n int64
	for _, ev := range f.events {
		if ev.BlockNumber >= fromBlock && !f.orphaned[ev.BlockNumber] {
			f.orphaned[ev.BlockNumber] = true
			n++
		}
	}
	return n, nil
}

func (f *fakeDB) ApplyAndConfirmBlock(ctx context.Context, chainID uint64, contractAddress string, blockNumber uint64) (int, error) {
	if f.confirmErr != nil {
		return 0, f.confirmErr
	}
	n := 0
	for k, ev := range f.events {
		if ev.BlockNumber != blockNumber || f.orphaned[blockNumber] {
			continue
		}
		if ev.EventName == "RiskEscrowCreated" && ev.DealID != nil {
			f.escrowed[int64(*ev.DealID)] = "active"
		}
		n++
		delete(f.events, k) // simulate "confirmed, no longer pending" for PendingConfirmationBlocks
	}
	return n, nil
}

func testConfig(t *testing.T, confirmationDepth, maxBlockRange uint64, startBlock uint64) config.Config {
	t.Helper()
	return config.Config{
		RPCURL:             "http://fake",
		ChainID:            31337,
		RiskEscrowAddress:  common.HexToAddress("0x000000000000000000000000000000000000Ab"),
		StartBlock:         startBlock,
		ConfirmationDepth:  confirmationDepth,
		DatabaseURL:        "postgres://fake",
		PollInterval:       1,
		MaxBlockRange:      maxBlockRange,
		MaxConcurrentScans: 2,
		HealthAddr:         ":0",
	}
}

func TestRunOnce_ScansAndRespectsConfirmationDepth(t *testing.T) {
	log := makeOracleUpdatedLog(10, "0xtx1", 0)
	// Re-tag as a deal-scoped created-like log isn't needed; use real decode path instead.
	client := &fakeChainClient{allLogs: []types.Log{log}, headBlock: 12, headers: map[uint64]*types.Header{}}
	db := newFakeDB()
	cfg := testConfig(t, 5, 100, 0)
	ix := New(client, db, cfg, metrics.New(cfg.ChainID, cfg.RiskEscrowAddress.Hex(), cfg.ConfirmationDepth))

	if err := ix.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	// head=12, confirmationDepth=5 -> boundary=7; event at block 10 > 7, not confirmed yet.
	if len(db.events) != 1 {
		t.Fatalf("events pending = %d, want 1 (not yet past confirmation depth)", len(db.events))
	}

	cp, found, _ := db.LoadCheckpoint(context.Background(), cfg.ChainID, cfg.RiskEscrowAddress.Hex())
	if !found {
		t.Fatal("expected checkpoint to be saved")
	}
	if cp.LastScannedBlock != 12 {
		t.Errorf("LastScannedBlock = %d, want 12", cp.LastScannedBlock)
	}
	if cp.LastConfirmedBlock != 0 {
		t.Errorf("LastConfirmedBlock = %d, want 0 (nothing past confirmation depth)", cp.LastConfirmedBlock)
	}
}

func TestRunOnce_ConfirmsOnceDepthElapses(t *testing.T) {
	log := makeOracleUpdatedLog(10, "0xtx1", 0)
	client := &fakeChainClient{allLogs: []types.Log{log}, headBlock: 20}
	db := newFakeDB()
	cfg := testConfig(t, 5, 100, 0)
	ix := New(client, db, cfg, metrics.New(cfg.ChainID, cfg.RiskEscrowAddress.Hex(), cfg.ConfirmationDepth))

	if err := ix.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	// head=20, boundary=15, event at block 10 <= 15 -> should confirm.
	if len(db.events) != 0 {
		t.Fatalf("events pending = %d, want 0 (should have confirmed)", len(db.events))
	}
	cp, _, _ := db.LoadCheckpoint(context.Background(), cfg.ChainID, cfg.RiskEscrowAddress.Hex())
	if cp.LastConfirmedBlock != 10 {
		t.Errorf("LastConfirmedBlock = %d, want 10", cp.LastConfirmedBlock)
	}
}

func TestRunOnce_RescanIsIdempotent(t *testing.T) {
	log := makeOracleUpdatedLog(10, "0xtx1", 0)
	client := &fakeChainClient{allLogs: []types.Log{log}, headBlock: 12}
	db := newFakeDB()
	cfg := testConfig(t, 5, 100, 0)
	ix := New(client, db, cfg, metrics.New(cfg.ChainID, cfg.RiskEscrowAddress.Hex(), cfg.ConfirmationDepth))

	if err := ix.RunOnce(context.Background()); err != nil {
		t.Fatalf("first RunOnce: %v", err)
	}
	countAfterFirst := len(db.events)

	// Second cycle at the same head: from = LastScannedBlock+1 = 13, so
	// nothing new is scanned, and the already-observed event must still be
	// exactly one row (not re-inserted).
	if err := ix.RunOnce(context.Background()); err != nil {
		t.Fatalf("second RunOnce: %v", err)
	}
	if len(db.events) != countAfterFirst {
		t.Errorf("event count changed across idempotent re-run: %d -> %d", countAfterFirst, len(db.events))
	}
}

func TestRunOnce_DetectsReorgAtFrontierAndRewinds(t *testing.T) {
	log := makeOracleUpdatedLog(10, "0xtx1", 0)
	client := &fakeChainClient{
		allLogs:   []types.Log{log},
		headBlock: 12,
		headers:   map[uint64]*types.Header{},
	}
	db := newFakeDB()
	cfg := testConfig(t, 5, 100, 0)
	ix := New(client, db, cfg, metrics.New(cfg.ChainID, cfg.RiskEscrowAddress.Hex(), cfg.ConfirmationDepth))

	if err := ix.RunOnce(context.Background()); err != nil {
		t.Fatalf("first RunOnce: %v", err)
	}
	cp, _, _ := db.LoadCheckpoint(context.Background(), cfg.ChainID, cfg.RiskEscrowAddress.Hex())
	if cp.LastScannedBlock != 12 {
		t.Fatalf("setup: LastScannedBlock = %d, want 12", cp.LastScannedBlock)
	}

	// Simulate a reorg: block 12 now has a different canonical hash than
	// what was checkpointed (same height, different actual block).
	client.headers[12] = distinctHeader(12, "reorg-salt")

	if err := ix.RunOnce(context.Background()); err != nil {
		t.Fatalf("second RunOnce (reorg): %v", err)
	}

	if len(db.orphaned) == 0 {
		t.Error("expected reorg to orphan at least one block")
	}
	if got := ix.Health.Snapshot().ReorgCount; got < 1 {
		t.Errorf("Health.ReorgCount = %d, want >= 1", got)
	}
	// The same cycle rewinds past the reorg and then immediately rescans
	// forward to the (now-current) head, so the frontier ends back at 12 -
	// just under the new canonical block rather than the stale one.
	cp2, _, _ := db.LoadCheckpoint(context.Background(), cfg.ChainID, cfg.RiskEscrowAddress.Hex())
	if cp2.LastScannedBlock != 12 {
		t.Errorf("LastScannedBlock after reorg+rescan = %d, want 12", cp2.LastScannedBlock)
	}
}

// distinctHeader builds a header for blockNumber whose hash differs from
// the "default" header the fake client otherwise synthesizes for any
// block number it has no explicit entry for - simulating a reorg that
// replaces a block at the same height with different actual content.
func distinctHeader(blockNumber uint64, salt string) *types.Header {
	return &types.Header{Number: new(big.Int).SetUint64(blockNumber), Extra: []byte(salt)}
}
