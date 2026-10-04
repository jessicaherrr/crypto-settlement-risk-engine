# Security

## Escrow contracts

- `RiskEscrow.sol` now verifies an EIP-712-signed `RiskQuote` (via
  `RiskQuoteVerifier.sol`) before any collateral is locked: signer must
  match the on-chain `riskOracle` address, the quote must be unexpired, and
  `quoteId` cannot be replayed. The quote is bound to a specific
  depositor/counterparty pair, so a valid quote cannot be redirected to an
  unintended pair of addresses.
- Collateral transfers use `SafeERC20` for the ERC-20 settlement path and
  checks-effects-interactions (status updated before any external call)
  for both native and ERC-20 transfers, under `ReentrancyGuard`.
- Admin-only state (risk oracle rotation, platform fee/wallet, settlement
  horizon bounds, emergency withdrawal) is gated by `Ownable`.
- `quoteExpiration` (how long a quote may be *accepted*) and
  `settlementHorizon` (how long the resulting escrow has to settle once
  accepted) are separate fields, both bound into the EIP-712 signature so
  neither can be tampered with independently of the other. `settlementHorizon`
  is bounded on-chain to `[MIN_SETTLEMENT_HORIZON, MAX_SETTLEMENT_HORIZON]`
  (1 hour - 90 days) to reject a degenerate (near-zero or unbounded) value.
- `requiredCollateral` must be `>= notional` at creation time. `settle()`
  charges the platform fee on `notional` only (never on the buffer above
  it), pays the counterparty `notional - fee`, and always returns
  `collateralLocked - notional` to the depositor - a compromised or
  mispriced quote with a large buffer cannot turn that buffer into
  unintended counterparty income.
- `emergencyWithdraw()` can only move the surplus balance above
  `totalLocked[asset]` (collateral backing ACTIVE escrows is tracked
  per-asset and incremented/decremented alongside each deal's lifecycle).
  The owner key can recover stray funds but cannot drain a live escrow,
  regardless of how much of an asset the contract happens to hold.

## Risk-oracle signing

- The risk oracle's signing key lives only in `RISK_ORACLE_PRIVATE_KEY`
  (an environment variable), loaded once by `RiskOracleSigner.from_env()`
  (`quant/src/askgene_quant/signing/risk_oracle.py`) and never logged,
  persisted, or passed through the HTTP service's request/response bodies.
  The service (`quant/src/askgene_quant/service/app.py`) fails fast at
  startup if the key is missing rather than serving unsigned quotes.
- Every field crossing the signing boundary is validated and normalized
  (`signing/eip712.py:normalize_onchain_fields`) before it is hashed or
  signed: addresses are checksummed, `bytes32` fields are shape-checked,
  and `uint256` fields must be non-negative Python `int` - a raw `float`
  or malformed value raises `InvalidRiskQuoteFields` instead of silently
  producing a signature over the wrong value.
- The EIP-712 domain/struct encoding (`typed_data_digest`) is
  cross-checked against `RiskQuoteVerifier.hashRiskQuote` (on the real
  deployed bytecode, `contracts/test/pythonRiskQuoteIntegration.test.js`)
  and against ethers.js `TypedDataEncoder.hash` directly
  (`quant/tests/test_eip712.py`), closing the "Python/Solidity precision
  mismatch" item below.
- `quant/scripts/sign_quote_cli.py` is a deliberately narrow CLI surface
  for signing: it takes an explicit private key as input (never reads
  `RISK_ORACLE_PRIVATE_KEY` itself) so test suites can sign with
  whichever key they configured as a given `RiskEscrow`'s oracle without
  mutating process environment - it is a test/integration tool, not
  something intended to run against a production key.

## Open items

These are not yet resolved and must be addressed before mainnet use:

1. **Production key custody.** The signing key now has a defined, narrow
   loading path (`RISK_ORACLE_PRIVATE_KEY` env var, read once at process
   start - see above), but an environment variable is not production-grade
   custody. An HSM/KMS-backed signer and a documented rotation procedure
   (`RiskEscrow.setRiskOracle`) are still required before any real
   collateral is at stake. Deploys without `RISK_ORACLE_ADDRESS` set still
   default the oracle to the deployer address (`contracts/scripts/deploy.js`)
   - that default must never be used once a real oracle key exists.
2. **No professional audit.** `RiskEscrow.sol` and
   `RiskQuoteVerifier.sol` have not been audited.
   Required before mainnet deployment or any non-trivial sum of real
   funds.
3. ~~**Python/Solidity precision mismatch.**~~ Resolved: the
   fixed-point conversion (`serialization.to_fixed_point`) is cross-checked
   against `ethers.parseUnits`, and the EIP-712 digest is cross-checked
   against both ethers.js and the deployed contract (see above).
4. **Settlement still pays the fixed notional, not a realized outcome.**
   `settle()` always pays the counterparty `notional - fee` and returns the
   buffer to the depositor; it does not consume a second signed quote
   attesting a realized (possibly partial, possibly loss-making for one
   side) profit/loss split. This is deliberate (quantitative collateral
   *pricing* is Python's job, and the contracts are kept small) and remains
   future work.
5. **Secrets.** Verify `.env.example` contains no real keys, and that
   `PRIVATE_KEY` / `RISK_ORACLE_ADDRESS` / `RISK_ORACLE_PRIVATE_KEY` /
   `DATABASE_URL` are never committed with real values.

## Chain indexer

- `services/chain-indexer` never reads or needs a wallet private key -
  `internal/config` has no such field, and `TestConfig_Validate_NeverRequiresPrivateKey`
  exists specifically to force a conscious decision if that ever changes.
  It only reads (`RPC_URL`, logs, chain state); it never signs or sends a
  transaction.
- Startup fails fast, visibly, rather than silently indexing the wrong
  thing: `chain.ValidateChainID` rejects an `RPC_URL`/`CHAIN_ID` mismatch,
  and `chain.ValidateContract` rejects a `RISK_ESCROW_ADDRESS` with no
  contract code deployed, both before the scan loop starts
  (`cmd/indexer/main.go`).
- `DATABASE_URL` is read from the environment and never logged (see the
  explicit comment in `cmd/indexer/main.go`); RPC retry/backoff
  (`internal/chain`) and DB writes (`internal/store`) surface errors up
  to the scan loop rather than swallowing them - a failed cycle is logged
  and retried next tick, never silently skipped.
- Derived financial state (`escrows.status` and its settlement/refund
  columns) is written only by `ApplyAndConfirmBlock`, and only for events
  that have already passed the confirmation-depth + block-hash re-check
  (`internal/workers.confirmPending`) - a reorg can discard unconfirmed
  `escrow_events` rows, but it can never cause a confirmed status
  transition to be applied incorrectly, because nothing is applied before
  that re-check passes. See `services/chain-indexer/README.md`'s
  "Reorg handling: design and limitations" for what this does and
  doesn't protect against (bounded by `CONFIRMATION_DEPTH`, not a
  from-genesis consensus check).
- Every DB write that establishes identity or applies derived state uses
  parameterized queries (`pgx`'s `$1, $2, ...` placeholders) - no SQL is
  ever built by string concatenation of chain data, including the
  risk-oracle/fee/wallet config values decoded from
  `RiskOracleUpdated`/`PlatformFeeUpdated`/`PlatformWalletUpdated` events.

## Web app and API routes

- **`RISK_ORACLE_PRIVATE_KEY` never reaches the client.** Confirmed by
  inspection (it is read once in `quant/`'s own process, never returned
  in an HTTP response) and by an automated test:
  `apps/web/lib/__tests__/no-public-secrets.test.ts` scans every source
  file for a secret-shaped `NEXT_PUBLIC_*` identifier and fails the
  build if one exists (`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is the one
  explicit, deliberate exception - a WalletConnect project ID is a
  public client identifier, not a secret).
- **No wallet private key is ever handled by the app.** Every
  transaction (`createEscrow`, `approve`, `settle`, `refund`) is signed
  client-side by the connected wallet via wagmi/viem; `apps/web`'s
  server code only ever holds a public `DATABASE_URL` and the public
  `RISK_SERVICE_URL` to reach the Python service.
- **Signed quotes are validated twice, independently, before
  `createEscrow`'s call data is handed back to the client**
  (`app/api/escrow/create/route.ts`): field-for-field against the
  `risk_quotes` row this server itself wrote when the quote was issued
  (a client cannot redefine a quote's terms after receiving it), and
  against the deployed contract's own `recoverRiskQuoteSigner`/
  `riskOracle`/`usedQuotes` views (so acceptance here means the
  on-chain call will actually succeed against the real oracle and
  hasn't already been consumed - not just that the server's own
  bookkeeping agrees with itself).
- **Arbitrary frontend requests cannot mark an escrow settled, refunded,
  or active in the database.** `app/api/escrow/update-transaction/route.ts`
  independently fetches the transaction receipt, verifies it targets
  this deployment's contract, and decodes a matching `RiskEscrowCreated`
  event before recording anything - and even then, never writes
  `status`. `status` (`pending`/`active`/`settled`/`refunded`) is written
  *only* by the Go chain indexer, only after its confirmation-depth
  check. This was a real gap in an earlier version of this route (it
  trusted a client-supplied `onChainEscrowId` and set `status='active'`
  directly), now closed with a regression test
  (`app/api/escrow/update-transaction/__tests__/route.test.ts`) pinned
  to both halves of the fix.
- **Confirmed chain state remains the source of truth for lifecycle
  display.** `apps/web/lib/escrow/status.ts` derives what to show from
  `escrows.status` (indexer-confirmed) plus the raw event history, never
  from a client-supplied or even a live-but-unconfirmed on-chain read
  alone; the escrow detail page shows a live read separately, labeled as
  such, alongside the confirmed state.
- **Contract addresses and chain IDs are validated at startup, not
  trusted blindly.** `apps/web/lib/chain/config.ts` rejects a malformed
  `NEXT_PUBLIC_RISK_ESCROW_ADDRESS` (checksum-validated via viem's
  `isAddress`/`getAddress`) and an unsupported `NEXT_PUBLIC_CHAIN_ID`
  immediately, rather than silently calling the zero address or the
  wrong chain.
- **User-provided addresses are validated.** Every route that accepts a
  depositor/counterparty/settlement-asset address checksums it via
  `getAddress` (which throws on a malformed address) before it's used in
  a query or a contract call.
- **No secrets are logged.** Checked by inspection across the Python
  service, the Go indexer (see above), and `apps/web`'s
  API routes - error logging only ever includes the error message and
  non-sensitive request context, never `RISK_ORACLE_PRIVATE_KEY` or
  `DATABASE_URL`.
- **On-chain/financial amounts never pass through an unsafe
  `Number()`.** `apps/web/lib/format/` is the only path amounts take
  from a Python decimal string, a Postgres fixed-point column, or a
  viem `bigint` to on-screen text - enforced by code review and 95 unit
  tests on that module, not by convention alone. The one deliberate
  exception is chart-coordinate values (pixel positions, not displayed
  figures), called out with a comment at each use.
