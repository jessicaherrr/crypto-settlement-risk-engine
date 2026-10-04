// Row shapes for the tables `lib/server/*` queries directly, matching
// `database/migrations/001_core_schema.sql` through `005_risk_quotes.sql`.
// Hand-written (there is no Supabase-generated-types step anymore - see
// `lib/server/db.ts`'s docstring for why this reads the same Postgres the
// Go chain indexer writes to) and kept narrow: only the columns a route in
// this app actually reads or writes, not a mirror of every column that
// exists.
//
// Money/amount columns are typed `string` even where the DB stores a
// fixed-point decimal as text (notional, required_collateral, etc.) -
// never `number`. See `lib/format/` for how these get converted for
// display; nothing here does that conversion.

export interface EscrowRow {
  id: string;
  depositor_wallet_address: string;
  counterparty_wallet_address: string;
  amount: string;
  status: string;
  payment_status: string;
  crypto_transaction_hash: string | null;
  crypto_currency: string;
  crypto_amount: string | null;
  network: string;
  on_chain_escrow_id: string | null;
  contract_address: string | null;

  quote_id: string | null;
  settlement_asset: string | null;
  notional: string | null;
  required_collateral: string | null;
  model_version: string | null;
  risk_snapshot_hash: string | null;
  quote_expiration: string | null;
  settlement_horizon_seconds: number | null;
  settlement_deadline: string | null;

  chain_id: number | null;
  on_chain_deal_id: string | null;
  creation_tx_hash: string | null;
  creation_block_number: string | null;
  creation_block_hash: string | null;
  settled_tx_hash: string | null;
  settled_block_number: string | null;
  settled_block_hash: string | null;
  refunded_tx_hash: string | null;
  refunded_block_number: string | null;
  refunded_block_hash: string | null;

  created_at: string;
  updated_at: string;
}

export interface PaymentRecordRow {
  id: string;
  escrow_id: string | null;
  payment_method: string;
  payment_provider: string | null;
  provider_payment_id: string;
  amount: string;
  crypto_amount: string | null;
  currency: string;
  crypto_currency: string | null;
  transaction_hash: string | null;
  from_address: string | null;
  to_address: string | null;
  network: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface RiskQuoteRow {
  quote_id: string;
  chain_id: string;
  verifying_contract: string;
  depositor: string;
  counterparty: string;
  settlement_asset: string | null;
  settlement_asset_decimals: number;
  onchain: Record<string, unknown>;
  model_output: Record<string, unknown>;
  signature: string;
  digest: string;
  signer: string;
  issued_at: string;
  quote_expiration: string;
  created_at: string;
}

export interface EscrowEventRow {
  id: string;
  chain_id: number;
  contract_address: string;
  block_number: string;
  block_hash: string;
  tx_hash: string;
  tx_index: number;
  log_index: number;
  event_name: string;
  deal_id: string | null;
  decoded: Record<string, unknown>;
  observed_at: string;
  confirmation_state: 'observed' | 'confirmed';
  confirmed_at: string | null;
  is_orphaned: boolean;
  orphaned_at: string | null;
  created_at: string;
}
