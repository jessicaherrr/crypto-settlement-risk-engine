// Package store is the chain indexer's only access point to PostgreSQL.
// It separates two concerns on purpose (see database/migrations/004_chain_indexer.sql):
//
//   - escrow_events: the raw, append-only, auditable record of every log
//     the indexer has observed. UpsertObservedEvent is the only writer, and
//     it is written at "observed" time - before the configured confirmation
//     depth has elapsed, before the block is known to be canonical.
//   - escrows:       derived current state. Only ApplyAndConfirmBlock
//     mutates it, and only for events it has just itself promoted from
//     "observed" to "confirmed" in the same call - a merely-observed event
//     can never move a deal's status.
//
// This separation is what makes a shallow reorg safe to handle: a reorg
// can only ever discard not-yet-confirmed escrow_events rows (OrphanFromBlock),
// it never has to undo an escrows status transition.
package store

import (
	"context"
	"encoding/hex"
	"fmt"
	"math/big"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ethereum/go-ethereum/common"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/events"
)

var weiPerToken = new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))

// Store wraps a PostgreSQL connection pool. All methods are safe for
// concurrent use.
type Store struct {
	pool *pgxpool.Pool
}

// New connects to databaseURL and verifies connectivity.
func New(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("store: parse/create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: ping database: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases all pooled connections.
func (s *Store) Close() { s.pool.Close() }

// Pool exposes the underlying pool for tests that need to assert on raw
// table state the Store's own API doesn't expose.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// ============================================================
// Checkpoints
// ============================================================

// Checkpoint is the durable scan progress for one (chain, contract) pair.
type Checkpoint struct {
	ChainID              uint64
	ContractAddress      string
	LastScannedBlock     uint64
	LastScannedBlockHash string
	LastConfirmedBlock   uint64
}

// LoadCheckpoint returns the stored checkpoint, or found=false if the
// indexer has never scanned this (chain, contract) before (a fresh start).
func (s *Store) LoadCheckpoint(ctx context.Context, chainID uint64, contractAddress string) (Checkpoint, bool, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT chain_id, contract_address, last_scanned_block,
		       COALESCE(last_scanned_block_hash, ''), last_confirmed_block
		FROM chain_checkpoints
		WHERE chain_id = $1 AND contract_address = $2
	`, chainID, contractAddress)

	var cp Checkpoint
	if err := row.Scan(&cp.ChainID, &cp.ContractAddress, &cp.LastScannedBlock, &cp.LastScannedBlockHash, &cp.LastConfirmedBlock); err != nil {
		if err == pgx.ErrNoRows {
			return Checkpoint{}, false, nil
		}
		return Checkpoint{}, false, fmt.Errorf("store: load checkpoint: %w", err)
	}
	return cp, true, nil
}

// SaveCheckpoint durably upserts scan progress. Called after every
// successful scan/confirmation pass so a restart never has to rely on
// in-memory progress.
func (s *Store) SaveCheckpoint(ctx context.Context, cp Checkpoint) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO chain_checkpoints (chain_id, contract_address, last_scanned_block, last_scanned_block_hash, last_confirmed_block, updated_at)
		VALUES ($1, $2, $3, $4, $5, NOW())
		ON CONFLICT (chain_id, contract_address) DO UPDATE SET
			last_scanned_block = EXCLUDED.last_scanned_block,
			last_scanned_block_hash = EXCLUDED.last_scanned_block_hash,
			last_confirmed_block = EXCLUDED.last_confirmed_block,
			updated_at = NOW()
	`, cp.ChainID, cp.ContractAddress, cp.LastScannedBlock, cp.LastScannedBlockHash, cp.LastConfirmedBlock)
	if err != nil {
		return fmt.Errorf("store: save checkpoint: %w", err)
	}
	return nil
}

// ============================================================
// Raw observed events
// ============================================================

// RawEvent is one decoded log, exactly as it will be (or was) persisted to
// escrow_events. Decoded uses the events package's ToDecodedMap encoding
// (every field as a string) so it round-trips through JSONB without
// precision loss.
type RawEvent struct {
	ChainID         uint64
	ContractAddress string
	BlockNumber     uint64
	BlockHash       string
	TxHash          string
	TxIndex         uint
	LogIndex        uint
	EventName       string
	DealID          *uint64
	Decoded         map[string]string
}

// UpsertOutcome reports what UpsertObservedEvent actually did, so the
// caller can track operational metrics (events processed vs. duplicates
// ignored vs. reorg replacements).
type UpsertOutcome int

const (
	OutcomeInserted UpsertOutcome = iota
	OutcomeUpdatedReorg
	OutcomeDuplicateIgnored
)

func (o UpsertOutcome) String() string {
	switch o {
	case OutcomeInserted:
		return "inserted"
	case OutcomeUpdatedReorg:
		return "updated_reorg"
	case OutcomeDuplicateIgnored:
		return "duplicate_ignored"
	default:
		return "unknown"
	}
}

// UpsertObservedEvent idempotently records one observed log. The natural
// blockchain identity (chain_id, tx_hash, log_index) is the conflict
// target: re-scanning the same block range is always safe to call this
// again with the identical RawEvent and get OutcomeDuplicateIgnored back,
// unchanged DB state (see TestIdempotent_RescanSameRange in store_test.go).
//
// If the same (tx_hash, log_index) reappears with a *different*
// block_hash - the signed transaction was re-included after a reorg - the
// row is updated in place and its confirmation progress reset to
// "observed", since it must pass through confirmation again under its new
// block.
func (s *Store) UpsertObservedEvent(ctx context.Context, ev RawEvent) (UpsertOutcome, error) {
	var wasInsert bool
	var matched bool
	row := s.pool.QueryRow(ctx, `
		INSERT INTO escrow_events (
			chain_id, contract_address, block_number, block_hash, tx_hash, tx_index, log_index,
			event_name, deal_id, decoded, confirmation_state, is_orphaned, orphaned_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'observed', FALSE, NULL)
		ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE SET
			block_number = EXCLUDED.block_number,
			block_hash = EXCLUDED.block_hash,
			tx_index = EXCLUDED.tx_index,
			event_name = EXCLUDED.event_name,
			deal_id = EXCLUDED.deal_id,
			decoded = EXCLUDED.decoded,
			confirmation_state = 'observed',
			confirmed_at = NULL,
			is_orphaned = FALSE,
			orphaned_at = NULL
		WHERE escrow_events.block_hash IS DISTINCT FROM EXCLUDED.block_hash
		RETURNING (xmax = 0)
	`, ev.ChainID, ev.ContractAddress, ev.BlockNumber, ev.BlockHash, ev.TxHash, ev.TxIndex, ev.LogIndex,
		ev.EventName, ev.DealID, ev.Decoded)

	err := row.Scan(&wasInsert)
	if err == nil {
		matched = true
	} else if err == pgx.ErrNoRows {
		matched = false
	} else {
		return 0, fmt.Errorf("store: upsert observed event: %w", err)
	}

	if !matched {
		return OutcomeDuplicateIgnored, nil
	}
	if wasInsert {
		return OutcomeInserted, nil
	}
	return OutcomeUpdatedReorg, nil
}

// ============================================================
// Confirmation + reorg
// ============================================================

// BlockRef identifies a block by number and the hash this indexer last
// observed it under.
type BlockRef struct {
	BlockNumber uint64
	BlockHash   string
}

// PendingConfirmationBlocks returns the distinct blocks, in ascending
// order, that have observed-but-not-yet-confirmed, non-orphaned events at
// or below upToBlock (i.e. candidates for the caller to verify against the
// current canonical chain before confirming).
func (s *Store) PendingConfirmationBlocks(ctx context.Context, chainID uint64, contractAddress string, upToBlock uint64) ([]BlockRef, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT block_number, block_hash
		FROM escrow_events
		WHERE chain_id = $1 AND contract_address = $2
		  AND confirmation_state = 'observed' AND NOT is_orphaned
		  AND block_number <= $3
		ORDER BY block_number
	`, chainID, contractAddress, upToBlock)
	if err != nil {
		return nil, fmt.Errorf("store: pending confirmation blocks: %w", err)
	}
	defer rows.Close()

	var out []BlockRef
	for rows.Next() {
		var b BlockRef
		if err := rows.Scan(&b.BlockNumber, &b.BlockHash); err != nil {
			return nil, fmt.Errorf("store: scan pending confirmation block: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// OrphanFromBlock marks every non-orphaned escrow_events row at or above
// fromBlock as orphaned. Called when a reorg is detected: these rows were
// never applied to escrows (only confirmed events are), so there is no
// derived state to roll back - the next scan cycle will insert fresh rows
// for the new canonical chain and they will go through confirmation again.
func (s *Store) OrphanFromBlock(ctx context.Context, chainID uint64, contractAddress string, fromBlock uint64) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE escrow_events
		SET is_orphaned = TRUE, orphaned_at = NOW()
		WHERE chain_id = $1 AND contract_address = $2 AND block_number >= $3 AND NOT is_orphaned
	`, chainID, contractAddress, fromBlock)
	if err != nil {
		return 0, fmt.Errorf("store: orphan from block %d: %w", fromBlock, err)
	}
	return tag.RowsAffected(), nil
}

// ApplyAndConfirmBlock promotes every observed, non-orphaned event at
// exactly blockNumber to confirmed, applying each one's effect to escrows
// derived state in the same transaction, in (tx_index, log_index) order.
// The caller (internal/workers) must have already verified blockNumber's
// stored block hash still matches the current canonical chain before
// calling this - ApplyAndConfirmBlock itself only trusts what is already
// recorded in escrow_events.
//
// Derived state is reconstructed from each row's `decoded` JSONB, not from
// any in-memory copy of the original decode, so this is safe to call after
// a process restart.
func (s *Store) ApplyAndConfirmBlock(ctx context.Context, chainID uint64, contractAddress string, blockNumber uint64) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("store: begin confirm tx: %w", err)
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT id, event_name, decoded, tx_hash, block_hash
		FROM escrow_events
		WHERE chain_id = $1 AND contract_address = $2 AND block_number = $3
		  AND confirmation_state = 'observed' AND NOT is_orphaned
		ORDER BY tx_index, log_index
		FOR UPDATE
	`, chainID, contractAddress, blockNumber)
	if err != nil {
		return 0, fmt.Errorf("store: select events at block %d: %w", blockNumber, err)
	}

	type pendingEvent struct {
		id        int64
		eventName string
		decoded   map[string]string
		txHash    string
		blockHash string
	}
	var pending []pendingEvent
	for rows.Next() {
		var p pendingEvent
		if err := rows.Scan(&p.id, &p.eventName, &p.decoded, &p.txHash, &p.blockHash); err != nil {
			rows.Close()
			return 0, fmt.Errorf("store: scan event at block %d: %w", blockNumber, err)
		}
		pending = append(pending, p)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	rows.Close()

	for _, p := range pending {
		if err := applyDerivedState(ctx, tx, chainID, contractAddress, p.eventName, p.decoded, p.txHash, blockNumber, p.blockHash); err != nil {
			return 0, fmt.Errorf("store: apply derived state for event %d (%s): %w", p.id, p.eventName, err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE escrow_events SET confirmation_state = 'confirmed', confirmed_at = NOW() WHERE id = $1
		`, p.id); err != nil {
			return 0, fmt.Errorf("store: mark event %d confirmed: %w", p.id, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("store: commit confirm tx: %w", err)
	}
	return len(pending), nil
}

func applyDerivedState(ctx context.Context, tx pgx.Tx, chainID uint64, contractAddress, eventName string, decoded map[string]string, txHash string, blockNumber uint64, blockHash string) error {
	switch eventName {
	case events.EventRiskEscrowCreated:
		ev, err := events.RiskEscrowCreatedFromMap(decoded)
		if err != nil {
			return err
		}
		return applyCreated(ctx, tx, chainID, contractAddress, ev, txHash, blockNumber, blockHash)

	case events.EventRiskEscrowSettled:
		ev, err := events.RiskEscrowSettledFromMap(decoded)
		if err != nil {
			return err
		}
		return applySettled(ctx, tx, chainID, contractAddress, ev, txHash, blockNumber, blockHash)

	case events.EventRiskEscrowRefunded:
		ev, err := events.RiskEscrowRefundedFromMap(decoded)
		if err != nil {
			return err
		}
		return applyRefunded(ctx, tx, chainID, contractAddress, ev, txHash, blockNumber, blockHash)

	case events.EventRiskOracleUpdated:
		ev, err := events.RiskOracleUpdatedFromMap(decoded)
		if err != nil {
			return err
		}
		return applyConfigState(ctx, tx, chainID, contractAddress, blockNumber, func(set map[string]any) {
			set["risk_oracle"] = ev.NewOracle.Hex()
		})

	case events.EventPlatformFeeUpdated:
		ev, err := events.PlatformFeeUpdatedFromMap(decoded)
		if err != nil {
			return err
		}
		return applyConfigState(ctx, tx, chainID, contractAddress, blockNumber, func(set map[string]any) {
			set["platform_fee_bps"] = ev.NewFeeBps.Int64()
		})

	case events.EventPlatformWalletUpdated:
		ev, err := events.PlatformWalletUpdatedFromMap(decoded)
		if err != nil {
			return err
		}
		return applyConfigState(ctx, tx, chainID, contractAddress, blockNumber, func(set map[string]any) {
			set["platform_wallet"] = ev.NewWallet.Hex()
		})

	default:
		// Not a derived-state event (shouldn't happen - the decoder only
		// emits the six names above) - treat as a no-op rather than failing
		// the whole block.
		return nil
	}
}

func applyCreated(ctx context.Context, tx pgx.Tx, chainID uint64, contractAddress string, ev events.RiskEscrowCreated, txHash string, blockNumber uint64, blockHash string) error {
	quoteID := "0x" + hex.EncodeToString(ev.QuoteId[:])
	riskSnapshotHash := "0x" + hex.EncodeToString(ev.RiskSnapshotHash[:])
	var settlementAssetVal any
	if ev.SettlementAsset == (common.Address{}) {
		settlementAssetVal = nil
	} else {
		settlementAssetVal = ev.SettlementAsset.Hex()
	}

	settlementDeadline := time.Unix(ev.SettlementDeadline.Int64(), 0).UTC()
	displayAmount := weiToDecimalApprox(ev.Notional)

	_, err := tx.Exec(ctx, `
		INSERT INTO escrows (
			depositor_wallet_address, counterparty_wallet_address, amount, duration_minutes,
			settlement_time, status, payment_status,
			quote_id, settlement_asset, notional, required_collateral, model_version, risk_snapshot_hash,
			settlement_deadline,
			chain_id, on_chain_deal_id, contract_address, creation_tx_hash, creation_block_number, creation_block_hash
		) VALUES (
			$1, $2, $3, 0,
			$4, 'active', 'succeeded',
			$5, $6, $7, $8, $9, $10,
			$4,
			$11, $12, $13, $14, $15, $16
		)
		ON CONFLICT (quote_id) WHERE quote_id IS NOT NULL DO UPDATE SET
			depositor_wallet_address = EXCLUDED.depositor_wallet_address,
			counterparty_wallet_address = EXCLUDED.counterparty_wallet_address,
			amount = EXCLUDED.amount,
			settlement_time = EXCLUDED.settlement_time,
			status = 'active',
			payment_status = 'succeeded',
			settlement_asset = EXCLUDED.settlement_asset,
			notional = EXCLUDED.notional,
			required_collateral = EXCLUDED.required_collateral,
			model_version = EXCLUDED.model_version,
			risk_snapshot_hash = EXCLUDED.risk_snapshot_hash,
			settlement_deadline = EXCLUDED.settlement_deadline,
			chain_id = EXCLUDED.chain_id,
			on_chain_deal_id = EXCLUDED.on_chain_deal_id,
			contract_address = EXCLUDED.contract_address,
			creation_tx_hash = EXCLUDED.creation_tx_hash,
			creation_block_number = EXCLUDED.creation_block_number,
			creation_block_hash = EXCLUDED.creation_block_hash
	`,
		ev.Depositor.Hex(), ev.Counterparty.Hex(), displayAmount,
		settlementDeadline,
		quoteID, settlementAssetVal, ev.Notional.String(), ev.CollateralLocked.String(), ev.ModelVersion, riskSnapshotHash,
		chainID, ev.DealId.Int64(), contractAddress, txHash, blockNumber, blockHash,
	)
	if err != nil {
		return fmt.Errorf("upsert escrow (created, deal %s): %w", ev.DealId.String(), err)
	}
	return nil
}

func applySettled(ctx context.Context, tx pgx.Tx, chainID uint64, contractAddress string, ev events.RiskEscrowSettled, txHash string, blockNumber uint64, blockHash string) error {
	_, err := tx.Exec(ctx, `
		UPDATE escrows SET
			status = 'settled',
			settled_tx_hash = $4,
			settled_block_number = $5,
			settled_block_hash = $6
		WHERE chain_id = $1 AND contract_address = $2 AND on_chain_deal_id = $3 AND status = 'active'
	`, chainID, contractAddress, ev.DealId.Int64(), txHash, blockNumber, blockHash)
	if err != nil {
		return fmt.Errorf("update escrow (settled, deal %s): %w", ev.DealId.String(), err)
	}
	return nil
}

func applyRefunded(ctx context.Context, tx pgx.Tx, chainID uint64, contractAddress string, ev events.RiskEscrowRefunded, txHash string, blockNumber uint64, blockHash string) error {
	_, err := tx.Exec(ctx, `
		UPDATE escrows SET
			status = 'refunded',
			refunded_tx_hash = $4,
			refunded_block_number = $5,
			refunded_block_hash = $6
		WHERE chain_id = $1 AND contract_address = $2 AND on_chain_deal_id = $3 AND status = 'active'
	`, chainID, contractAddress, ev.DealId.Int64(), txHash, blockNumber, blockHash)
	if err != nil {
		return fmt.Errorf("update escrow (refunded, deal %s): %w", ev.DealId.String(), err)
	}
	return nil
}

func applyConfigState(ctx context.Context, tx pgx.Tx, chainID uint64, contractAddress string, blockNumber uint64, mutate func(set map[string]any)) error {
	set := map[string]any{}
	mutate(set)

	// Only three possible keys; written explicitly rather than building
	// dynamic SQL from the map, so this can never be an injection vector.
	riskOracle, _ := set["risk_oracle"].(string)
	feeBps, hasFee := set["platform_fee_bps"].(int64)
	wallet, _ := set["platform_wallet"].(string)

	_, err := tx.Exec(ctx, `
		INSERT INTO chain_config_state (chain_id, contract_address, risk_oracle, platform_fee_bps, platform_wallet, updated_at_block, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, NOW())
		ON CONFLICT (chain_id, contract_address) DO UPDATE SET
			risk_oracle = COALESCE($3, chain_config_state.risk_oracle),
			platform_fee_bps = CASE WHEN $7 THEN $4 ELSE chain_config_state.platform_fee_bps END,
			platform_wallet = COALESCE($5, chain_config_state.platform_wallet),
			updated_at_block = $6,
			updated_at = NOW()
	`, chainID, contractAddress, nullIfEmpty(riskOracle), feeBps, nullIfEmpty(wallet), blockNumber, hasFee)
	if err != nil {
		return fmt.Errorf("upsert chain_config_state: %w", err)
	}
	return nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// weiToDecimalApprox renders a wei-equivalent *big.Int as a human-readable
// decimal (18 decimals) for the legacy `escrows.amount` display column.
// Not used for any on-chain-accurate logic - notional/required_collateral
// (exact decimal strings) are authoritative, matching the convention set
// in apps/web/app/api/escrow/create/route.ts.
func weiToDecimalApprox(wei *big.Int) float64 {
	f := new(big.Float).SetInt(wei)
	f.Quo(f, weiPerToken)
	out, _ := f.Float64()
	return out
}
