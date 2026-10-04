package workers

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/chain"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/config"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/metrics"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/store"
)

// DB is the subset of *store.Store's methods Indexer depends on, so tests
// can substitute an in-memory fake instead of a real PostgreSQL instance.
type DB interface {
	LoadCheckpoint(ctx context.Context, chainID uint64, contractAddress string) (store.Checkpoint, bool, error)
	SaveCheckpoint(ctx context.Context, cp store.Checkpoint) error
	UpsertObservedEvent(ctx context.Context, ev store.RawEvent) (store.UpsertOutcome, error)
	PendingConfirmationBlocks(ctx context.Context, chainID uint64, contractAddress string, upToBlock uint64) ([]store.BlockRef, error)
	OrphanFromBlock(ctx context.Context, chainID uint64, contractAddress string, fromBlock uint64) (int64, error)
	ApplyAndConfirmBlock(ctx context.Context, chainID uint64, contractAddress string, blockNumber uint64) (int, error)
}

// Indexer orchestrates one chain/contract's scan -> confirm pipeline:
// resuming from a durable checkpoint, detecting reorgs at its own
// frontier, fetching and persisting new logs as "observed", and promoting
// sufficiently-old observed events to "confirmed" (applying their effect
// to escrows derived state) only after re-verifying their block is still
// canonical.
type Indexer struct {
	Client chain.Client
	DB     DB
	Cfg    config.Config
	Health *metrics.Health

	contractHex string
}

// New builds an Indexer. Health may be nil (metrics become no-ops) for
// tests that don't care about operational counters.
func New(client chain.Client, db DB, cfg config.Config, health *metrics.Health) *Indexer {
	if health == nil {
		health = metrics.New(cfg.ChainID, cfg.RiskEscrowAddress.Hex(), cfg.ConfirmationDepth)
	}
	return &Indexer{Client: client, DB: db, Cfg: cfg, Health: health, contractHex: cfg.RiskEscrowAddress.Hex()}
}

// Validate performs the startup checks the phase's security review calls
// for: that RPC_URL actually serves the configured CHAIN_ID, and that
// RISK_ESCROW_ADDRESS actually has contract code - failing fast on a
// misconfigured network or address rather than silently indexing nothing
// or the wrong thing.
func (ix *Indexer) Validate(ctx context.Context) error {
	if err := chain.ValidateChainID(ctx, ix.Client, ix.Cfg.ChainID); err != nil {
		return err
	}
	if err := chain.ValidateContract(ctx, ix.Client, ix.Cfg.RiskEscrowAddress); err != nil {
		return err
	}
	return nil
}

// Run calls RunOnce every Cfg.PollInterval until ctx is canceled, which is
// this service's graceful-shutdown signal (see cmd/indexer/main.go). A
// RunOnce error is recorded on Health and logged by the caller, but does
// not stop the loop - the next tick simply tries again, so a transient RPC
// or DB blip never requires a restart.
func (ix *Indexer) Run(ctx context.Context, onCycle func(error)) error {
	ticker := time.NewTicker(ix.Cfg.PollInterval)
	defer ticker.Stop()

	for {
		err := ix.RunOnce(ctx)
		if err != nil {
			ix.Health.SetLastError(err.Error())
		} else {
			ix.Health.SetLastError("")
		}
		if onCycle != nil {
			onCycle(err)
		}

		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil
			}
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// RunOnce executes exactly one scan-and-confirm cycle: reorg check, scan
// forward to the current head, then promote eligible observed events to
// confirmed.
func (ix *Indexer) RunOnce(ctx context.Context) error {
	head, err := ix.Client.BlockNumber(ctx)
	if err != nil {
		return fmt.Errorf("fetch chain head: %w", err)
	}
	ix.Health.MarkSuccessfulRPCCall()
	ix.Health.SetChainHead(head)

	cp, found, err := ix.DB.LoadCheckpoint(ctx, ix.Cfg.ChainID, ix.contractHex)
	if err != nil {
		return fmt.Errorf("load checkpoint: %w", err)
	}
	if !found {
		cp = store.Checkpoint{ChainID: ix.Cfg.ChainID, ContractAddress: ix.contractHex}
	}

	from := ix.Cfg.StartBlock
	if found {
		if cp, err = ix.reconcileReorg(ctx, cp); err != nil {
			return fmt.Errorf("reorg check: %w", err)
		}
		from = cp.LastScannedBlock + 1
	}

	if from <= head {
		cp, err = ix.scanForward(ctx, cp, from, head)
		if err != nil {
			return fmt.Errorf("scan forward: %w", err)
		}
		if err := ix.DB.SaveCheckpoint(ctx, cp); err != nil {
			return fmt.Errorf("save checkpoint after scan: %w", err)
		}
		ix.Health.MarkSuccessfulDBWrite()
	}

	cp, err = ix.confirmPending(ctx, cp, head)
	if err != nil {
		return fmt.Errorf("confirm pending: %w", err)
	}
	if err := ix.DB.SaveCheckpoint(ctx, cp); err != nil {
		return fmt.Errorf("save checkpoint after confirmation: %w", err)
	}

	ix.Health.SetLastScannedBlock(cp.LastScannedBlock)
	ix.Health.SetLastConfirmedBlock(cp.LastConfirmedBlock)
	return nil
}

// reconcileReorg re-verifies the checkpoint's own frontier (the hash of
// the last block it scanned) against the current canonical chain. If it
// no longer matches, a reorg reached at least that deep: rewind both the
// scan and confirmation frontiers by reorgRewindTarget, and orphan every
// not-yet-confirmed event at or above the rewind point so the next scan
// re-derives them from the now-canonical chain. Confirmed events are never
// touched here - by construction they can only exist below what was, at
// the time they were confirmed, a verified-canonical block (see
// confirmPending) - a reorg deeper than that is outside this indexer's
// documented guarantees (see services/chain-indexer/README.md).
func (ix *Indexer) reconcileReorg(ctx context.Context, cp store.Checkpoint) (store.Checkpoint, error) {
	if cp.LastScannedBlock == 0 || cp.LastScannedBlockHash == "" {
		return cp, nil
	}

	currentHash, err := ix.Client.BlockHashByNumber(ctx, new(big.Int).SetUint64(cp.LastScannedBlock))
	if err != nil {
		return cp, fmt.Errorf("fetch block hash at checkpoint frontier %d: %w", cp.LastScannedBlock, err)
	}
	ix.Health.MarkSuccessfulRPCCall()

	if currentHash.Hex() == cp.LastScannedBlockHash {
		return cp, nil // no reorg at the frontier
	}

	ix.Health.AddReorg(1)
	rewindTo := reorgRewindTarget(cp.LastScannedBlock, ix.Cfg.ConfirmationDepth, ix.Cfg.StartBlock)

	if _, err := ix.DB.OrphanFromBlock(ctx, ix.Cfg.ChainID, ix.contractHex, rewindTo+1); err != nil {
		return cp, fmt.Errorf("orphan events from block %d after reorg: %w", rewindTo+1, err)
	}

	cp.LastScannedBlock = rewindTo
	if rewindTo == 0 {
		cp.LastScannedBlockHash = ""
	} else {
		rewindHash, err := ix.Client.BlockHashByNumber(ctx, new(big.Int).SetUint64(rewindTo))
		if err != nil {
			return cp, fmt.Errorf("fetch block hash at rewind target %d: %w", rewindTo, err)
		}
		cp.LastScannedBlockHash = rewindHash.Hex()
	}
	if cp.LastConfirmedBlock > rewindTo {
		cp.LastConfirmedBlock = rewindTo
	}
	return cp, nil
}

// reorgRewindTarget is the pure decision at the heart of reconcileReorg:
// how far back to rewind once a mismatch is found at lastScanned. Kept
// separate from any I/O so it has a direct unit test.
func reorgRewindTarget(lastScanned, confirmationDepth, startBlock uint64) uint64 {
	window := confirmationDepth
	if window == 0 {
		window = 1
	}
	if lastScanned <= window {
		return startBlock
	}
	target := lastScanned - window
	if target < startBlock {
		return startBlock
	}
	return target
}

// scanForward fetches, decodes and persists every indexed log in
// [from, to], then returns cp updated to that new frontier (block number
// + hash). Each decoded event is written via DB.UpsertObservedEvent,
// individually idempotent (see store.UpsertObservedEvent) - ScanRange's
// concurrency is only in the RPC fetch; persistence happens sequentially,
// in block/tx/log order, which is what keeps ordering-sensitive state
// (e.g. a create-then-settle pair landing in the same cycle) correct.
func (ix *Indexer) scanForward(ctx context.Context, cp store.Checkpoint, from, to uint64) (store.Checkpoint, error) {
	batchEnd := to
	if max := from + ix.Cfg.MaxBlockRange*uint64(ix.Cfg.MaxConcurrentScans) - 1; max < batchEnd {
		batchEnd = max
	}

	rawEvents, err := ScanRange(ctx, ix.Client, ix.Cfg.RiskEscrowAddress, ix.Cfg.ChainID, from, batchEnd, ix.Cfg.MaxBlockRange, ix.Cfg.MaxConcurrentScans)
	if err != nil {
		return cp, fmt.Errorf("scan range [%d,%d]: %w", from, batchEnd, err)
	}
	ix.Health.MarkSuccessfulRPCCall()

	for _, ev := range rawEvents {
		outcome, err := ix.DB.UpsertObservedEvent(ctx, ev)
		if err != nil {
			return cp, fmt.Errorf("persist event tx=%s logIndex=%d: %w", ev.TxHash, ev.LogIndex, err)
		}
		switch outcome {
		case store.OutcomeInserted, store.OutcomeUpdatedReorg:
			ix.Health.AddEventsProcessed(1)
		case store.OutcomeDuplicateIgnored:
			ix.Health.AddDuplicatesIgnored(1)
		}
	}

	newFrontierHash, err := ix.Client.BlockHashByNumber(ctx, new(big.Int).SetUint64(batchEnd))
	if err != nil {
		return cp, fmt.Errorf("fetch block hash at new frontier %d: %w", batchEnd, err)
	}
	ix.Health.MarkSuccessfulRPCCall()

	cp.LastScannedBlock = batchEnd
	cp.LastScannedBlockHash = newFrontierHash.Hex()
	return cp, nil
}

// confirmPending promotes every observed, non-orphaned event at or below
// (head - ConfirmationDepth) to confirmed, applying its effect to escrows
// derived state - but only after re-verifying each candidate block's
// stored hash still matches the current canonical chain. A mismatch means
// a reorg reached into what this cycle was about to treat as confirmed:
// everything at or above that block is orphaned instead, and confirmation
// stops for this cycle (the next cycle's reconcileReorg will pick up the
// rewind). This is what makes the derived escrows table reorg-safe without
// ever needing to undo a status transition: nothing is applied to it until
// its block has survived long enough, under this same re-check, to be
// trusted.
func (ix *Indexer) confirmPending(ctx context.Context, cp store.Checkpoint, head uint64) (store.Checkpoint, error) {
	if head < ix.Cfg.ConfirmationDepth {
		return cp, nil
	}
	boundary := head - ix.Cfg.ConfirmationDepth

	blocks, err := ix.DB.PendingConfirmationBlocks(ctx, ix.Cfg.ChainID, ix.contractHex, boundary)
	if err != nil {
		return cp, fmt.Errorf("list pending confirmation blocks: %w", err)
	}

	for _, b := range blocks {
		currentHash, err := ix.Client.BlockHashByNumber(ctx, new(big.Int).SetUint64(b.BlockNumber))
		if err != nil {
			return cp, fmt.Errorf("fetch block hash for confirmation at block %d: %w", b.BlockNumber, err)
		}
		ix.Health.MarkSuccessfulRPCCall()

		if currentHash.Hex() != b.BlockHash {
			// Reorg found exactly where we were about to confirm. Orphan
			// this block onward and stop; never confirm past a mismatch.
			ix.Health.AddReorg(1)
			if _, err := ix.DB.OrphanFromBlock(ctx, ix.Cfg.ChainID, ix.contractHex, b.BlockNumber); err != nil {
				return cp, fmt.Errorf("orphan events from block %d during confirmation: %w", b.BlockNumber, err)
			}
			if cp.LastScannedBlock >= b.BlockNumber {
				cp.LastScannedBlock = b.BlockNumber - 1
			}
			break
		}

		if _, err := ix.DB.ApplyAndConfirmBlock(ctx, ix.Cfg.ChainID, ix.contractHex, b.BlockNumber); err != nil {
			return cp, fmt.Errorf("apply and confirm block %d: %w", b.BlockNumber, err)
		}
		ix.Health.MarkSuccessfulDBWrite()
		cp.LastConfirmedBlock = b.BlockNumber
	}

	return cp, nil
}
