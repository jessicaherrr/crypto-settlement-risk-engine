-- ============================================
-- PHASE G: RISK_QUOTES (server-issued quote audit trail)
-- ============================================
--
-- Problem this fixes: `POST /v1/quotes` (the Python risk-oracle service)
-- returns a full RiskQuote - VaR, Expected Shortfall, stress loss, spot
-- price, model version, the EIP-712 signature/digest/signer - but until
-- now nothing persisted it. Once the HTTP response left the server, every
-- one of those numbers was gone; an escrow's "risk at issuance" could
-- never be shown later, only its notional and collateral (escrows.notional
-- / required_collateral, from migration 003).
--
-- risk_quotes is written server-to-server by the Next.js quote route,
-- immediately after the Python service responds and before the quote is
-- ever handed to the browser. It is the full-fidelity record an escrow's
-- detail page reads back for its "risk at issuance" section; the escrow
-- itself only needs to reference it by quote_id (escrows.quote_id already
-- exists, from migration 003).
--
-- Not written or read by the Go chain indexer - this is off-chain quote
-- issuance provenance, not confirmed on-chain state.

CREATE TABLE IF NOT EXISTS risk_quotes (
  quote_id VARCHAR(66) PRIMARY KEY, -- "0x" + keccak256(...) - matches escrows.quote_id and RiskQuoteVerifier.RiskQuote.quoteId

  chain_id BIGINT NOT NULL,
  verifying_contract VARCHAR(42) NOT NULL,

  depositor VARCHAR(42) NOT NULL,
  counterparty VARCHAR(42) NOT NULL,
  settlement_asset VARCHAR(42), -- NULL/zero address = native asset
  settlement_asset_decimals INTEGER NOT NULL DEFAULT 18,

  -- Exactly the two JSON objects `POST /v1/quotes` returned: the on-chain
  -- RiskQuoteVerifier.RiskQuote struct fields (uint256s as decimal
  -- strings) and the full model output (VaR/ES/stress/spot/model version/
  -- etc., Decimal-typed fields as strings) - stored verbatim, not
  -- re-derived, so this is always exactly what was quoted and signed.
  onchain JSONB NOT NULL,
  model_output JSONB NOT NULL,

  signature VARCHAR(132) NOT NULL, -- "0x" + 65-byte ECDSA signature
  digest VARCHAR(66) NOT NULL, -- the EIP-712 digest that was signed
  signer VARCHAR(42) NOT NULL, -- checksummed risk-oracle address that signed it

  issued_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  quote_expiration TIMESTAMP WITH TIME ZONE NOT NULL,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_quotes_depositor ON risk_quotes(depositor);
CREATE INDEX IF NOT EXISTS idx_risk_quotes_expiration ON risk_quotes(quote_expiration);

COMMENT ON TABLE risk_quotes IS 'Server-issued record of every signed RiskQuote the risk-oracle service produced, written before the quote reaches the browser. Lets an escrow''s detail page show the full risk picture (VaR/ES/stress/spot/model version) at issuance, and lets the escrow-create route validate a submitted quote against exactly what was actually issued rather than trusting client-supplied fields.';
COMMENT ON COLUMN risk_quotes.onchain IS 'Verbatim RiskQuoteVerifier.RiskQuote struct fields as returned by POST /v1/quotes (uint256s as decimal strings).';
COMMENT ON COLUMN risk_quotes.model_output IS 'Verbatim full RiskQuote model output as returned by POST /v1/quotes (VaR, Expected Shortfall, stress_loss, spot_price_usd, model_version, etc.).';
