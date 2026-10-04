-- ============================================
-- ASK GENE QUANTFI - CORE SCHEMA v1.0 (Phase A)
-- Risk-aware crypto escrow & settlement engine
-- ============================================
--
-- This replaces the previous consulting-marketplace schema. It keeps only
-- the infrastructure that is reusable for escrow/settlement: profiles,
-- escrows, payment records and on-chain transaction records.
--
-- Marketplace-only tables from the old schema (consultants, feedback,
-- google_calendar_tokens) are intentionally dropped, not migrated - they
-- have no role in the risk escrow system. Full history remains in git.
--
-- Phase C/D/E will add: market_prices, model_states, risk_snapshots,
-- risk_quotes, escrow_events, settlements. Those are deliberately NOT
-- created here; this migration only cleans up and generalizes what
-- already existed.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. PROFILES (minimal user identity)
-- ============================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  wallet_address VARCHAR(42) UNIQUE NOT NULL,
  email VARCHAR(255),
  name VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE profiles IS 'Minimal user identity keyed by wallet address';
COMMENT ON COLUMN profiles.wallet_address IS 'User wallet address (unique)';

-- ============================================
-- 2. ESCROWS (generalized from consultations)
-- ============================================
CREATE TABLE IF NOT EXISTS escrows (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,

  -- Parties
  depositor_wallet_address VARCHAR(42) NOT NULL,
  counterparty_wallet_address VARCHAR(42) NOT NULL,

  -- Deal terms
  amount DECIMAL(20,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  duration_minutes INTEGER NOT NULL,
  settlement_time TIMESTAMP WITH TIME ZONE NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  payment_status VARCHAR(50) DEFAULT 'unpaid',
  notes TEXT,

  -- Crypto payment fields
  crypto_transaction_hash VARCHAR(100),
  crypto_currency VARCHAR(10) DEFAULT 'MATIC',
  crypto_amount VARCHAR(100),
  network VARCHAR(50) DEFAULT 'polygon-amoy',
  on_chain_escrow_id VARCHAR(100),
  contract_address VARCHAR(42),
  gas_used VARCHAR(50),
  block_number INTEGER,
  blockchain_explorer_url TEXT,

  -- Common payment fields
  payment_id VARCHAR(100),
  refund_id VARCHAR(100),
  cancellation_reason TEXT,
  cancelled_by VARCHAR(50),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE escrows
  ADD CONSTRAINT check_escrow_status
  CHECK (status IN ('pending', 'confirmed', 'active', 'completed', 'settled', 'cancelled'));

ALTER TABLE escrows
  ADD CONSTRAINT check_escrow_payment_status
  CHECK (payment_status IN (
    'unpaid',
    'pending',
    'processing',
    'confirming',
    'succeeded',
    'failed',
    'refunded',
    'cancelled'
  ));

COMMENT ON TABLE escrows IS 'Crypto escrow deal lifecycle (generalized from consultations)';
COMMENT ON COLUMN escrows.depositor_wallet_address IS 'Wallet that funded the escrow';
COMMENT ON COLUMN escrows.counterparty_wallet_address IS 'Wallet that receives funds on settlement';
COMMENT ON COLUMN escrows.on_chain_escrow_id IS 'Deal ID from the Escrow.sol contract';
COMMENT ON COLUMN escrows.contract_address IS 'Deployed escrow contract address';

-- ============================================
-- 3. PAYMENT_RECORDS (audit trail, kept as-is)
-- ============================================
CREATE TABLE IF NOT EXISTS payment_records (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  escrow_id UUID REFERENCES escrows(id) ON DELETE CASCADE,

  payment_method VARCHAR(20) NOT NULL DEFAULT 'crypto',
  payment_provider VARCHAR(20),
  provider_payment_id VARCHAR(100) NOT NULL,

  amount DECIMAL(10, 2) NOT NULL,
  crypto_amount VARCHAR(100),
  currency VARCHAR(10) DEFAULT 'USD',
  crypto_currency VARCHAR(10),

  transaction_hash VARCHAR(100),
  from_address VARCHAR(42),
  to_address VARCHAR(42),
  network VARCHAR(50),
  gas_used VARCHAR(50),
  block_number INTEGER,

  status VARCHAR(20) NOT NULL,
  metadata JSONB,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE payment_records IS 'Payment transaction records for audit trail';

-- ============================================
-- 4. CRYPTO_TRANSACTIONS (on-chain tx detail, kept as-is)
-- ============================================
CREATE TABLE IF NOT EXISTS crypto_transactions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  escrow_id UUID REFERENCES escrows(id) ON DELETE CASCADE,

  transaction_hash VARCHAR(100) UNIQUE NOT NULL,
  from_address VARCHAR(42) NOT NULL,
  to_address VARCHAR(42) NOT NULL,
  contract_address VARCHAR(42),

  value VARCHAR(100) NOT NULL,
  token_address VARCHAR(42),
  token_symbol VARCHAR(20),
  token_decimals INTEGER,

  network VARCHAR(50) NOT NULL,
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash VARCHAR(100),
  gas_used VARCHAR(50),
  gas_price VARCHAR(50),
  transaction_fee VARCHAR(100),

  status VARCHAR(20) NOT NULL,
  confirmation_count INTEGER DEFAULT 0,
  is_confirmed BOOLEAN DEFAULT FALSE,

  function_name VARCHAR(100),
  function_args JSONB,
  logs JSONB,

  explorer_url TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  confirmed_at TIMESTAMP WITH TIME ZONE
);

COMMENT ON TABLE crypto_transactions IS 'Detailed blockchain transaction records';

-- ============================================
-- 5. INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_profiles_wallet ON profiles(wallet_address);

CREATE INDEX IF NOT EXISTS idx_escrows_depositor ON escrows(depositor_wallet_address);
CREATE INDEX IF NOT EXISTS idx_escrows_counterparty ON escrows(counterparty_wallet_address);
CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrows(status);
CREATE INDEX IF NOT EXISTS idx_escrows_payment_status ON escrows(payment_status);
CREATE INDEX IF NOT EXISTS idx_escrows_settlement_time ON escrows(settlement_time DESC);
CREATE INDEX IF NOT EXISTS idx_escrows_updated_at ON escrows(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_escrows_crypto_tx_hash ON escrows(crypto_transaction_hash);
CREATE INDEX IF NOT EXISTS idx_escrows_on_chain_id ON escrows(on_chain_escrow_id);

CREATE INDEX IF NOT EXISTS idx_payment_records_escrow_id ON payment_records(escrow_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_provider_id ON payment_records(provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_status ON payment_records(status);

CREATE INDEX IF NOT EXISTS idx_crypto_tx_hash ON crypto_transactions(transaction_hash);
CREATE INDEX IF NOT EXISTS idx_crypto_tx_escrow ON crypto_transactions(escrow_id);
CREATE INDEX IF NOT EXISTS idx_crypto_tx_network ON crypto_transactions(network);
CREATE INDEX IF NOT EXISTS idx_crypto_tx_block ON crypto_transactions(block_number DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_tx_status ON crypto_transactions(status);

-- ============================================
-- 6. updated_at TRIGGERS
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_escrows_updated_at
    BEFORE UPDATE ON escrows
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payment_records_updated_at
    BEFORE UPDATE ON payment_records
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_crypto_transactions_updated_at
    BEFORE UPDATE ON crypto_transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
