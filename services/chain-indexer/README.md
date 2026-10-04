# chain-indexer

Go service that watches `RiskEscrow.sol` on an EVM chain (Polygon Amoy by
default, but works unmodified against local Hardhat or any other EVM
network), decodes its lifecycle events from the contract's real compiled
ABI, and keeps PostgreSQL in sync with confirmed on-chain state.

It answers one question: **what happened on-chain, is it sufficiently
confirmed, have we already processed it, and has the off-chain state been
updated correctly?** It never computes risk, never holds a wallet private
key, and never signs a transaction - it only observes and records.

```
Python decides risk  →  Solidity enforces the signed decision  →  Go observes and records what actually happened.
```

## Quick start

```bash
# 1. Postgres reachable and migrated (database/migrations/001-004).
docker compose up -d postgres   # or: brew services start postgresql@16

# 2. Point the indexer at a chain + the deployed RiskEscrow address.
export RPC_URL=https://rpc-amoy.polygon.technology
export CHAIN_ID=80002
export RISK_ESCROW_ADDRESS=0x...          # from apps/web/public/contracts.json
export DATABASE_URL=postgres://askgene:askgene@localhost:5432/askgene_quantfi

go run ./cmd/indexer
```

A JSON health snapshot is served at `http://localhost:8090` (configurable
via `HEALTH_ADDR`): chain head, last scanned/confirmed block, confirmed
lag, events processed, duplicates ignored, retries, reorgs.

## Configuration

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `RPC_URL` | yes | - | EVM JSON-RPC endpoint. No wallet key is ever read from this process - only reads. |
| `CHAIN_ID` | yes | - | Expected chain ID; checked against the RPC endpoint's actual chain ID at startup (fails fast on a mismatch). |
| `RISK_ESCROW_ADDRESS` | yes | - | Deployed `RiskEscrow` address; checked for contract code at startup. |
| `DATABASE_URL` | yes | - | PostgreSQL connection string. Never logged. |
| `START_BLOCK` | no | `0` | First block to scan from on a fresh (never-checkpointed) run. |
| `CONFIRMATION_DEPTH` | no | `5` | Blocks an event must sit under the head before it's treated as confirmed (see below). |
| `POLL_INTERVAL_SECONDS` | no | `5` | Delay between scan cycles. |
| `MAX_BLOCK_RANGE` | no | `2000` | Max blocks per `eth_getLogs` call (RPC providers cap this). |
| `MAX_CONCURRENT_SCANS` | no | `4` | Max concurrent `eth_getLogs` calls during a large backfill. |
| `HEALTH_ADDR` | no | `:8090` | Health JSON endpoint bind address. |

`CONFIRMATION_DEPTH` is a configurable *application-level* choice, not a
claim of universal finality - 5 is a reasonable default for a fast L2 like
Polygon; raise it if the deployment's risk tolerance for a deep reorg is
lower.

## Event coverage

Decoded from the real compiled ABI
(`internal/events/abi/risk_escrow.json`, extracted from
`artifacts/contracts/RiskEscrow.sol/RiskEscrow.json` after `npx hardhat
compile` - not hand-invented event names):

- `RiskEscrowCreated`, `RiskEscrowSettled`, `RiskEscrowRefunded` - deal
  lifecycle, each carrying `dealId`.
- `RiskOracleUpdated`, `PlatformFeeUpdated`, `PlatformWalletUpdated` -
  contract-level config, recorded into `chain_config_state` for
  operational visibility (not deal-scoped, not used for on-chain
  enforcement - the contract itself remains authoritative).

`OwnershipTransferred` and `EIP712DomainChanged` also exist on the
contract but carry no escrow-lifecycle or risk-collateral information and
are out of scope.

## Confirmation model

Three distinct states, and they are not the same thing:

1. **Transaction mined** - the chain has a receipt for it.
2. **Event observed** - this indexer has fetched the log and written it to
   `escrow_events` with `confirmation_state = 'observed'`. Not yet
   authoritative.
3. **Sufficiently confirmed for this application** - the event's block is
   at least `CONFIRMATION_DEPTH` blocks under the current head *and* its
   stored block hash has just been re-verified against the live chain.
   Only then is it promoted to `confirmation_state = 'confirmed'` and its
   effect applied to `escrows` (status transitions, settlement/refund tx
   hashes, block provenance).

This separation - raw observed events vs. derived confirmed state - is
what makes reorg handling tractable: a reorg can only ever discard
not-yet-confirmed `escrow_events` rows. It never has to undo an `escrows`
status transition, because nothing is written there until the event
survives the re-check in step 3.

## Reorg handling: design and limitations

At every scan cycle, before extending forward, the indexer re-fetches the
block hash at its own last-scanned frontier (`chain_checkpoints`) and
compares it to what was stored. If it no longer matches, a reorg reached
at least that deep: the indexer orphans every not-yet-confirmed event at
or above `lastScanned - CONFIRMATION_DEPTH` and rewinds its checkpoint to
that point, relying on idempotent re-scanning (below) to safely re-derive
everything from the now-canonical chain. The same re-check runs again,
per-block, immediately before a block's events are promoted to confirmed
(`confirmPending` in `internal/workers/indexer.go`) - so even a reorg that
lands exactly at the confirmation boundary is caught before anything
reaches derived state.

**What this deliberately does not do:** walk back an unbounded distance
to find a common ancestor, store a full historical hash chain, or run a
real consensus client. A reorg deeper than `CONFIRMATION_DEPTH` blocks
below what this indexer has *already confirmed* is outside its guarantees
- choose `CONFIRMATION_DEPTH` accordingly for the chain in question. This
is a proportionate amount of reorg protection for an application-level
indexer, not a blockchain node.

One more implementation note worth calling out because it caused a real
bug during integration testing: the re-check above compares the
block hash the RPC server *reports* for a given log (`types.Log.BlockHash`,
taken as-is) against the block hash the server reports for that block
number via a raw `eth_getBlockByNumber` call
(`internal/chain.Client.BlockHashByNumber`) - not against
`go-ethereum`'s own client-side recomputed `header.Hash()`. The two are
not interchangeable: recomputing a hash from a fetched header's RLP
encoding depends on every optional header field (base fee, withdrawals/
blob fields, etc.) round-tripping through JSON exactly as the chain's
consensus rules intend, and Hardhat's local dev chain does not always
reproduce its own reported hash that way. Comparing two server-reported
values instead of one server-reported and one locally recomputed is what
makes this check actually reliable against a real node, not just correct
against a reference implementation.

## Idempotency

The natural blockchain identity `(chain_id, tx_hash, log_index)` is the
conflict target for every write to `escrow_events`
(`internal/store.UpsertObservedEvent`): re-scanning the same block range
twice is always safe and produces identical database state (see
`TestIdempotent_RescanSameRange` in `internal/store/store_test.go`, and
the repeated-scan assertions in
`tests/integration/e2e_test.go`). The same identity reappearing with a
*different* block hash (a reorg re-included the transaction elsewhere) is
treated as an update-in-place, resetting that row's confirmation progress
rather than creating a duplicate.

## Database

See `database/migrations/004_chain_indexer.sql`:

- `escrow_events` - raw, append-only, auditable log of every observed
  event (full decoded fields, block/tx/log provenance, confirmation
  state). Never deleted; a reorg marks rows orphaned rather than removing
  them.
- `chain_checkpoints` - durable scan/confirmation progress per (chain,
  contract), loaded on every restart so the indexer never relies on
  in-memory state.
- `chain_config_state` - latest confirmed oracle/fee/wallet config, for
  operational visibility only.
- `escrows` gains on-chain provenance columns (`chain_id`,
  `on_chain_deal_id`, creation/settlement/refund tx hash + block
  number/hash) and a unique `(chain_id, contract_address,
  on_chain_deal_id)` identity, independent of whether a pending row
  already existed for the deal's `quote_id`.

That same migration also fixes a pre-existing schema bug caught by the
indexer's integration tests: `escrows.quote_id` was typed `UUID` in
migration 003, but `RiskQuote.quote_id`
(`quant/src/askgene_quant/quotes/risk_quote.py`) is `"0x" +
keccak256(...).hex()` - a 66-character hex string, matching
`RiskQuoteVerifier.sol`'s `bytes32 quoteId` - never a UUID. It is now
`VARCHAR(66)`.

## Risk metadata linkage

`RiskEscrowCreated` carries `quoteId`, `modelVersion` and
`riskSnapshotHash` straight from the signed `RiskQuote`; the indexer
persists them as-is onto the `escrows` row it activates (or creates, if no
pending row exists for that `quote_id` - e.g. a historical backfill). It
never recomputes or re-prices them. This is what lets later analysis
compare an ex-ante risk estimate (the signed quote) against the realized
settlement/refund outcome, by following `quote_id → escrow →
on-chain settlement/refund`.

## Testing

```bash
go test ./...                                   # unit tests, no external deps
TEST_DATABASE_URL=postgres://askgene:askgene@localhost:5432/askgene_quantfi_test \
  go test ./internal/store/...                  # + real Postgres integration tests
TEST_DATABASE_URL=... go test ./tests/integration/...  # + real local Hardhat node
```

Tests that need PostgreSQL or a local Hardhat node skip (not fail) when
those aren't reachable, matching the convention already established by
`contracts/test/pythonRiskQuoteIntegration.test.js` for the Python
signer. `tests/integration/e2e_test.go` manages its own `npx hardhat node`
process and runs `contracts/scripts/chain_indexer_e2e_fixture.js`, which
prices and signs two real `RiskQuote`s through the actual Python risk
engine, creates both escrows on-chain, settles one and refunds the other
- then asserts the indexer reproduces that exact state in Postgres,
including idempotency under repeated scanning and recovery from a
simulated process restart (a fresh `Indexer`/RPC client against the same
persisted checkpoint).

Unit test coverage includes: event decoding (against real ABI-encoded
logs), the `ToDecodedMap`/`FromMap` round trip, checkpoint persistence,
event identity/deduplication, confirmation-depth logic, idempotent event
processing, escrow state transitions, RPC retry/backoff (including
context-cancellation), reorg detection and rollback, and configuration
validation.

See `benchmarks/go_indexer/README.md` for what's actually been measured
(decode throughput, local-Postgres write throughput) and, importantly,
what hasn't (there is no real-network RPC throughput number, because this
environment has none to measure against).

## Package layout

- `internal/config` - env parsing/validation.
- `internal/chain` - retrying RPC client abstraction + startup validation
  (chain ID, contract code).
- `internal/events` - ABI-driven decoding of the six indexed events, and
  their `ToDecodedMap`/`FromMap` JSONB encoding.
- `internal/workers` - the scan → confirm pipeline: `ScanRange` (bounded
  concurrent log fetching across a block range) and `Indexer`
  (checkpointing, reorg reconciliation, confirmation promotion).
- `internal/store` - all PostgreSQL access: checkpoints, raw observed
  events, confirmation promotion + derived-state application.
- `internal/metrics` - the `Health` counters and JSON endpoint.
- `cmd/indexer` - process wiring, graceful shutdown on SIGINT/SIGTERM.
