-- ============================================
-- PHASE F: CHAIN INDEXER SCHEMA
-- ============================================
--
-- Adds the tables/columns the Go chain indexer (services/chain-indexer)
-- needs to observe RiskEscrow on-chain activity and keep `escrows` in sync
-- with confirmed blockchain state.
--
-- Design principle (kept distinct on purpose):
--   1. escrow_events  - raw, append-only, auditable record of every decoded
--      RiskEscrow log the indexer has observed, keyed by its natural
--      blockchain identity (chain_id, tx_hash, log_index). Rows here are
--      never financially authoritative by themselves - they are evidence.
--   2. escrows        - derived current state. The indexer only mutates a
--      deal's status/provenance columns here once the corresponding event
--      has been CONFIRMED (see chain_checkpoints / confirmation_state
--      below), never from a merely-observed, unconfirmed log. This is what
--      makes the derived table safe across shallow reorgs: a reorg can only
--      ever discard unconfirmed `escrow_events` rows, it never has to undo
--      an `escrows` status transition.
--   3. chain_checkpoints - durable scan progress per (chain_id,
--      contract_address), so the indexer can resume after a restart without
--      relying on in-memory state, and can detect a reorg at its own
--      frontier by comparing the stored block hash against the chain.

-- ============================================
-- 1. ESCROW_EVENTS (raw, append-only, auditable)
-- ============================================
CREATE TABLE IF NOT EXISTS escrow_events (
  id BIGSERIAL PRIMARY KEY,

  chain_id INTEGER NOT NULL,
  contract_address VARCHAR(42) NOT NULL,

  block_number BIGINT NOT NULL,
  block_hash VARCHAR(66) NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  tx_index INTEGER NOT NULL,
  log_index INTEGER NOT NULL,

  event_name VARCHAR(50) NOT NULL,
  deal_id BIGINT, -- NULL for contract-level config events (not deal-scoped)

  -- Full decoded event fields (addresses/bytes32 as 0x-hex strings, uint256
  -- as decimal strings - JSON has no bigint type).
  decoded JSONB NOT NULL,

  observed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  confirmation_state VARCHAR(20) NOT NULL DEFAULT 'observed',
  confirmed_at TIMESTAMP WITH TIME ZONE,

  -- Set when a later reorg scan finds this row's block is no longer
  -- canonical. Orphaned rows are kept (never deleted) for audit; a fresh
  -- row for the same (or a different) canonical block is inserted
  -- separately once the chain re-settles.
  is_orphaned BOOLEAN NOT NULL DEFAULT FALSE,
  orphaned_at TIMESTAMP WITH TIME ZONE,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE escrow_events
  ADD CONSTRAINT check_escrow_event_confirmation_state
  CHECK (confirmation_state IN ('observed', 'confirmed'));

-- Natural blockchain event identity: processing the same log twice must
-- never create duplicate financial state. A reorg that replaces the tx
-- entirely gets a new tx_hash and so a new row; this index is what makes
-- re-scanning the same block range idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_events_identity
  ON escrow_events(chain_id, tx_hash, log_index);

CREATE INDEX IF NOT EXISTS idx_escrow_events_deal ON escrow_events(deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_escrow_events_block ON escrow_events(chain_id, contract_address, block_number);
CREATE INDEX IF NOT EXISTS idx_escrow_events_pending_confirmation
  ON escrow_events(chain_id, contract_address, block_number)
  WHERE confirmation_state = 'observed' AND NOT is_orphaned;

COMMENT ON TABLE escrow_events IS 'Raw, append-only, auditable record of every decoded RiskEscrow log observed by the chain indexer. Never updated except to move confirmation_state forward or mark a row orphaned by a reorg; never deleted.';
COMMENT ON COLUMN escrow_events.event_name IS 'RiskEscrowCreated | RiskEscrowSettled | RiskEscrowRefunded | RiskOracleUpdated | PlatformFeeUpdated | PlatformWalletUpdated';
COMMENT ON COLUMN escrow_events.confirmation_state IS 'observed: log fetched and decoded, not yet past CONFIRMATION_DEPTH blocks. confirmed: past the confirmation depth with its block hash re-verified canonical - only confirmed events are applied to escrows derived state.';
COMMENT ON COLUMN escrow_events.is_orphaned IS 'Set true if a later scan finds this event''s block is no longer part of the canonical chain (reorg). Orphaned rows are never treated as confirmed truth and are excluded from derived-state application.';

-- ============================================
-- 2. CHAIN_CHECKPOINTS (durable scan progress / restart recovery)
-- ============================================
CREATE TABLE IF NOT EXISTS chain_checkpoints (
  chain_id INTEGER NOT NULL,
  contract_address VARCHAR(42) NOT NULL,

  -- Highest block number whose logs have been fetched and inserted into
  -- escrow_events (as 'observed'; not necessarily confirmed yet).
  last_scanned_block BIGINT NOT NULL DEFAULT 0,
  last_scanned_block_hash VARCHAR(66),

  -- Highest block number for which every event has been promoted to
  -- 'confirmed' and applied to escrows derived state.
  last_confirmed_block BIGINT NOT NULL DEFAULT 0,

  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  PRIMARY KEY (chain_id, contract_address)
);

COMMENT ON TABLE chain_checkpoints IS 'Durable chain-indexer scan progress per (chain_id, contract_address). Loaded on restart so the indexer never relies only on in-memory progress; last_scanned_block_hash lets it detect a reorg at its own frontier on resume.';

-- ============================================
-- 3. CHAIN_CONFIG_STATE (current platform/oracle config, for ops visibility)
-- ============================================
CREATE TABLE IF NOT EXISTS chain_config_state (
  chain_id INTEGER NOT NULL,
  contract_address VARCHAR(42) NOT NULL,

  risk_oracle VARCHAR(42),
  platform_fee_bps INTEGER,
  platform_wallet VARCHAR(42),

  updated_at_block BIGINT,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  PRIMARY KEY (chain_id, contract_address)
);

COMMENT ON TABLE chain_config_state IS 'Latest confirmed RiskOracleUpdated / PlatformFeeUpdated / PlatformWalletUpdated values per contract, for operational visibility. Not consulted for on-chain enforcement - the contract itself is authoritative.';

-- ============================================
-- 4. ESCROWS: on-chain provenance + identity columns
-- ============================================

-- Fix a pre-existing schema/reality mismatch surfaced by this phase's
-- integration tests: migration 003 typed escrows.quote_id as UUID, but
-- RiskQuote.quote_id (quant/src/askgene_quant/quotes/risk_quote.py) is
-- "0x" + keccak256(...).hex() - a 66-character 0x-prefixed bytes32 hex
-- string, matching RiskQuoteVerifier.sol's `bytes32 quoteId` - never a
-- UUID. Every real quote_id value would have failed this column's type
-- check; nothing on the UUID assumption has shipped real data against it.
ALTER TABLE escrows ALTER COLUMN quote_id TYPE VARCHAR(66) USING quote_id::text;

ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS chain_id INTEGER,
  ADD COLUMN IF NOT EXISTS on_chain_deal_id BIGINT,
  ADD COLUMN IF NOT EXISTS creation_tx_hash VARCHAR(66),
  ADD COLUMN IF NOT EXISTS creation_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS creation_block_hash VARCHAR(66),
  ADD COLUMN IF NOT EXISTS settled_tx_hash VARCHAR(66),
  ADD COLUMN IF NOT EXISTS settled_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS settled_block_hash VARCHAR(66),
  ADD COLUMN IF NOT EXISTS refunded_tx_hash VARCHAR(66),
  ADD COLUMN IF NOT EXISTS refunded_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS refunded_block_hash VARCHAR(66);

COMMENT ON COLUMN escrows.chain_id IS 'EVM chain ID this deal was created on. Populated by the chain indexer from the confirmed RiskEscrowCreated event.';
COMMENT ON COLUMN escrows.on_chain_deal_id IS 'RiskEscrow.sol dealId (the contract''s own 1-indexed deal counter). The chain is the source of truth for settlement state; off-chain rows may only reach status=settled/refunded once the corresponding confirmed event exists.';
COMMENT ON COLUMN escrows.creation_tx_hash IS 'Transaction hash of the confirmed RiskEscrowCreated event that activated this deal.';
COMMENT ON COLUMN escrows.settled_tx_hash IS 'Transaction hash of the confirmed RiskEscrowSettled event, if any.';
COMMENT ON COLUMN escrows.refunded_tx_hash IS 'Transaction hash of the confirmed RiskEscrowRefunded event, if any.';

-- Natural identity for a deal once it exists on-chain: a given contract on
-- a given chain never reuses a dealId. This is the idempotent upsert key
-- the indexer uses when applying a confirmed RiskEscrowCreated/Settled/
-- Refunded event, independent of whether a pending DB row already existed
-- for that quote_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_escrows_chain_deal_id
  ON escrows(chain_id, contract_address, on_chain_deal_id)
  WHERE on_chain_deal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_escrows_creation_tx ON escrows(creation_tx_hash) WHERE creation_tx_hash IS NOT NULL;
