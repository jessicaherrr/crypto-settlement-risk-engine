-- ============================================
-- PHASE B: RISK ESCROW SCHEMA UPDATE
-- ============================================
--
-- Escrow.sol (generic two-party escrow) is replaced by RiskEscrow.sol,
-- which only activates when a signed RiskQuote from the (future) Python
-- risk engine is presented and verified on-chain. This migration adds the
-- risk-quote metadata captured at escrow-creation time, and narrows the
-- lifecycle status values to match RiskEscrow.sol's ACTIVE/SETTLED/REFUNDED
-- states (the old CREATED/confirm/complete steps no longer exist on-chain).
--
-- risk_quotes / risk_snapshots / model_states tables are NOT created here;
-- those land in Phase D/E alongside the Python risk engine. This migration
-- only adds enough columns to `escrows` to record what a given on-chain
-- deal was created against.

ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS quote_id UUID,
  ADD COLUMN IF NOT EXISTS settlement_asset VARCHAR(42),
  ADD COLUMN IF NOT EXISTS notional VARCHAR(100),
  ADD COLUMN IF NOT EXISTS required_collateral VARCHAR(100),
  ADD COLUMN IF NOT EXISTS model_version VARCHAR(50),
  ADD COLUMN IF NOT EXISTS risk_snapshot_hash VARCHAR(66),
  ADD COLUMN IF NOT EXISTS quote_expiration TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS settlement_horizon_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS settlement_deadline TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN escrows.quote_id IS 'RiskQuote.quote_id bound into the signed EIP-712 quote consumed on-chain';
COMMENT ON COLUMN escrows.settlement_asset IS 'ERC-20 token address, or NULL for native POL settlement';
COMMENT ON COLUMN escrows.notional IS 'RiskQuote.notional, fixed-point decimal string (18 decimals, matches on-chain uint256)';
COMMENT ON COLUMN escrows.required_collateral IS 'RiskQuote.required_collateral, fixed-point decimal string (18 decimals, matches on-chain uint256). May exceed notional by a risk buffer; only the buffer is returned to the depositor on settlement.';
COMMENT ON COLUMN escrows.model_version IS 'Risk model version string bound into the signed RiskQuote, kept for audit';
COMMENT ON COLUMN escrows.risk_snapshot_hash IS 'keccak256 hash of the risk snapshot the quote was generated from';
COMMENT ON COLUMN escrows.quote_expiration IS 'RiskQuote.quote_expiration - deadline for using the quote to create this escrow. Distinct from settlement_deadline: this gates quote acceptance, not the resulting escrow''s settlement window.';
COMMENT ON COLUMN escrows.settlement_horizon_seconds IS 'RiskQuote.settlement_horizon - duration in seconds (bound into the signed quote) used on-chain to compute settlement_deadline = createdAt + horizon. Will support discrete horizons (1d/7d/14d/30d, etc) once the risk engine exists.';
COMMENT ON COLUMN escrows.settlement_deadline IS 'Absolute on-chain settlement deadline for this escrow (createdAt + settlement_horizon_seconds). Populated once the createEscrow transaction is confirmed; the escrow becomes refundable after this point if unsettled.';
COMMENT ON COLUMN escrows.amount IS 'Human-readable display amount, derived from notional. Not used for on-chain logic - required_collateral/notional are the precise fixed-point values.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_escrows_quote_id ON escrows(quote_id) WHERE quote_id IS NOT NULL;

-- RiskEscrow.sol has no "duration" concept in minutes: the settlement window
-- is settlement_horizon_seconds, bound into the signed quote itself.
-- duration_minutes is kept for backward compatibility with existing
-- rows/tooling but is no longer meaningful for new risk-escrow rows.
ALTER TABLE escrows ALTER COLUMN duration_minutes DROP NOT NULL;
COMMENT ON COLUMN escrows.duration_minutes IS 'Legacy field from the pre-risk-quote escrow model. RiskEscrow.sol uses settlement_horizon_seconds instead; left nullable for new rows.';

-- RiskEscrow.sol has no CREATED/confirm/complete steps: a deal is ACTIVE
-- the instant collateral is locked against a valid signed quote. Replace
-- the old status set accordingly. 'pending' remains for the DB row created
-- before the on-chain transaction is mined; 'cancelled' remains for rows
-- abandoned before any transaction was sent.
ALTER TABLE escrows DROP CONSTRAINT IF EXISTS check_escrow_status;
ALTER TABLE escrows
  ADD CONSTRAINT check_escrow_status
  CHECK (status IN ('pending', 'active', 'settled', 'refunded', 'cancelled'));
