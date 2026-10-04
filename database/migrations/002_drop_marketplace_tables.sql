-- ============================================
-- PHASE A CLEANUP: drop consulting-marketplace tables
-- ============================================
--
-- Run this against an existing database that still has the old
-- consulting-marketplace schema applied. Fresh environments can skip
-- straight to 001_core_schema.sql.
--
-- If existing `consultations` data needs to be preserved, migrate it into
-- `escrows` BEFORE running this file, e.g.:
--
--   INSERT INTO escrows (
--     id, depositor_wallet_address, counterparty_wallet_address, amount,
--     currency, duration_minutes, settlement_time, status, payment_status,
--     notes, crypto_transaction_hash, crypto_currency, crypto_amount,
--     network, on_chain_escrow_id, contract_address, gas_used, block_number,
--     blockchain_explorer_url, payment_id, refund_id, cancellation_reason,
--     cancelled_by, created_at, updated_at
--   )
--   SELECT
--     c.id, c.client_wallet_address, co.wallet_address, c.total_amount,
--     c.currency, c.duration_hours * 60, c.scheduled_for, c.status,
--     c.payment_status, c.notes, c.crypto_transaction_hash, c.crypto_currency,
--     c.crypto_amount, c.network, c.contract_session_id, c.contract_address,
--     c.gas_used, c.block_number, c.blockchain_explorer_url, c.payment_id,
--     c.refund_id, c.cancellation_reason, c.cancelled_by, c.created_at,
--     c.updated_at
--   FROM consultations c
--   JOIN consultants co ON co.id = c.consultant_id;
--
-- Then update payment_records.consultation_id / crypto_transactions.consultation_id
-- references to the new escrows.id before dropping the old tables.

DROP TABLE IF EXISTS feedback CASCADE;
DROP TABLE IF EXISTS google_calendar_tokens CASCADE;
DROP TABLE IF EXISTS consultants CASCADE;
DROP TABLE IF EXISTS consultations CASCADE;
