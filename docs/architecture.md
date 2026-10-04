# Architecture

The Crypto Settlement Risk Engine prices the settlement risk of a
crypto-denominated escrow, signs the resulting collateral requirement, enforces
it on-chain, and reconciles confirmed on-chain state back into a dashboard.

## Stack split

- **Python** (`quant/`): quantitative risk modeling (volatility, VaR,
  Expected Shortfall, stress testing, collateral pricing, risk quotes).
  Never executes on-chain.
- **Go** (`services/chain-indexer/`): concurrent blockchain event
  ingestion and persistence. Never implements quantitative models.
- **Solidity** (`contracts/`): on-chain escrow execution and risk quote
  verification. Never implements quantitative models.
- **Next.js** (`apps/web/`): risk monitoring console (escrow lifecycle,
  risk dashboard, model validation views).

## Components

### Risk engine (`quant/`)

- **Data and volatility.** Real ETH/USD daily data (Coinbase Exchange,
  locally cached), data-quality checks, log returns, and rolling, EWMA, and
  GARCH(1,1) volatility, with estimation and conditional-variance updating
  deliberately separated. `ModelState` persists fit parameters, training
  window, diagnostics, and the latest conditional variance. A
  look-ahead-free out-of-sample harness scores the estimators (RMSE/QLIKE).
- **Risk measures.** Historical, filtered-historical, and GBM-benchmark
  return-distribution methods (`simulation/`) across 1d/7d/14d/30d horizons
  without square-root-of-time scaling; VaR and Expected Shortfall
  (`risk/measures.py`, `risk/engine.py`); stress testing across
  historical-worst-case, volatility-shock, gap-down, and extended-horizon
  scenarios (`risk/stress.py`); and out-of-sample VaR validation
  (exceedance rate, Kupiec test) with an Expected Shortfall diagnostic.
- **Collateral policy.** A transparent, configurable policy kept separate
  from the risk models (`policy/collateral.py`). See
  [risk_policy.md](risk_policy.md).
- **Risk quotes and signing.** A canonical `RiskQuote` with deterministic
  Decimal-to-fixed-point serialization and a keccak256 risk-snapshot hash
  (`serialization.py`, `quotes/risk_quote.py`). The EIP-712 signing layer
  (`signing/eip712.py`, `signing/risk_oracle.py`) produces exactly the
  signature `RiskQuoteVerifier._verifyRiskQuote` accepts, with address
  checksumming and field-shape validation before anything is hashed.
- **Service.** A request-a-quote pipeline (`service/quoting.py`,
  `service/signing_service.py`) and a FastAPI app (`service/app.py`) exposing
  `POST /v1/quotes` plus read-only analytics endpoints
  (`/v1/models/garch`, `/v1/risk/snapshot`, `/v1/validation/*`).

See [methodology.md](methodology.md) and
[model_validation.md](model_validation.md) for the quantitative detail.

### Contracts (`contracts/`)

`RiskEscrow.sol` and `RiskQuoteVerifier.sol` implement a risk-aware escrow. A
deal activates only when the depositor presents a `RiskQuote` signed (EIP-712)
by the trusted risk-oracle key, binding notional, required collateral
(notional plus a risk buffer), settlement asset, settlement horizon, model
version, and a risk snapshot hash to a specific depositor/counterparty pair.
`quoteExpiration` (quote acceptance window) and `settlementHorizon` (the
escrow's own settlement window) are independent signed fields. On settlement
the counterparty receives notional minus the fee, the platform receives the
fee, and the buffer returns to the depositor. The contracts support native and
ERC-20 settlement, replay protection, horizon-based refunds, reentrancy
guards, and owner-gated admin functions whose `emergencyWithdraw` can reach
only surplus balance, never collateral backing an active deal.

### Chain indexer (`services/chain-indexer/`)

A Go service that watches `RiskEscrow`, decodes its six lifecycle and config
events from the compiled ABI, and keeps `escrows` in sync with *confirmed*
on-chain state. Raw observed events (`escrow_events`, append-only) are kept
separate from derived state (`escrows`): nothing is applied to the latter
until an event has sat `CONFIRMATION_DEPTH` blocks under the head and had its
block hash re-verified as canonical. This makes a shallow reorg safe to
handle (orphan unconfirmed rows and rescan; never undo a status transition).
Per-(chain, contract) checkpoints (`chain_checkpoints`) make restart recovery
rely on Postgres rather than memory, and processing is idempotent through the
`(chain_id, tx_hash, log_index)` identity. The indexer never reads a wallet
private key. See [services/chain-indexer/README.md](../services/chain-indexer/README.md).

### Web app (`apps/web/`)

Wallet connectivity, the dashboard (`/risk`, `/models`), and the escrow
lifecycle UI (`/escrow`, `/escrow/new`, `/escrow/[id]`). The app reads the same
Postgres the indexer writes (`lib/server/db.ts`), so the dashboard shows
confirmed state. `app/api/quote/request/route.ts` requests a signed quote from
the Python service server-side; `app/api/escrow/create/route.ts` validates it
field for field against the stored `risk_quotes` row and against the deployed
contract before returning call data to the wallet.

### Database (`database/migrations/`)

`escrows` (quote ID, settlement asset, notional, required collateral, model
version, risk snapshot hash, quote expiration, settlement horizon and
deadline), `escrow_events`, `chain_checkpoints`, `risk_quotes`, and supporting
tables. Migrations are applied in order by `scripts/db_migrate.sh`.

## Cross-language integration

The signing and verification chain is tested at three levels:

1. `quant/tests/test_eip712.py`: Python's EIP-712 digest against ethers.js
   `TypedDataEncoder.hash` (`scripts/cross_lang/eip712_digest.js`), across
   chain IDs, contract addresses, and edge-case field values.
2. `quant/tests/test_fixed_point_cross_lang.py`: Python's `to_fixed_point`
   against ethers.js `parseUnits` (`scripts/cross_lang/parse_units.js`).
3. `contracts/test/pythonRiskQuoteIntegration.test.js`: the real Python signer
   (via `quant/scripts/sign_quote_cli.py`) against the deployed
   `RiskEscrow`/`RiskQuoteVerifier` bytecode, covering digest and signer
   parity, rejection cases (tampering, forged signatures, expiry, replay,
   wrong depositor, insufficient collateral, horizon bounds), and full
   quote, `createEscrow`, `settle`/`refund` flows for native and ERC-20
   settlement.

## End-to-end tests

- `services/chain-indexer/tests/integration/e2e_test.go` starts a local
  Hardhat node, runs `contracts/scripts/chain_indexer_e2e_fixture.js` (which
  prices and signs two real `RiskQuote`s through the Python engine, creates
  both escrows, settles one and refunds the other), then runs the indexer
  against real Postgres and asserts it reproduces that state, including
  idempotency under repeated scanning and recovery from a simulated restart.
  It skips if `npx`/Hardhat or `TEST_DATABASE_URL` are unavailable.
- `apps/web/tests/integration/escrow-journey.test.ts` (`npm run test:e2e`)
  drives the full quote, create, confirm, settle/refund journey against a
  freshly started local stack.

## Public testnet

The flow has been validated on a local Hardhat chain only. Running it on
Polygon Amoy needs funded test accounts and configuration, not code changes;
see [amoy_demo.md](amoy_demo.md).

## Possible future directions

Settlement currently pays the fixed notional. A second signed quote attesting
a realized split at settlement time is a possible extension (see
[security.md](security.md), open item 4).
