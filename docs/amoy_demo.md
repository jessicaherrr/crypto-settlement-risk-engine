# Running this on Polygon Amoy

The local demo (`npm run stack`, or `scripts/dev_stack.sh`) has been
built and verified end-to-end against a real local Hardhat node: a real
Python-signed `RiskQuote`, a real `createEscrow` transaction, real Go
chain-indexer confirmation, and a real settle/refund path, all against
real deployed contracts.

**A live Polygon Amoy run has not been performed.** No funded Amoy
deployer key or oracle key was available while building this project. This
document states exactly what that would take, honestly, rather than
claiming a testnet run that didn't happen.

## What's missing

1. **A funded Amoy deployer key.** `PRIVATE_KEY` in `.env.local`, holding
   enough test POL to deploy `RiskEscrow` and (optionally) a test ERC-20.
   Get test POL from the [Polygon faucet](https://faucet.polygon.technology/)
   (select "Polygon Amoy").
2. **A distinct risk-oracle signing key.** The local demo uses the
   well-known Hardhat test key (`0xac09...`) for convenience - that key
   is public and must never sign a real quote on a real network. A real
   deployment needs its own `RISK_ORACLE_PRIVATE_KEY`, with
   `RISK_ORACLE_ADDRESS` (the matching public address) set *before*
   deployment so `RiskEscrow`'s constructor is given the right oracle
   from the start (or rotated in afterward via `setRiskOracle`, which
   requires the deployer/owner key).
3. **A WalletConnect project ID**
   (`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`) if you want to connect a
   real mobile/browser wallet rather than only a locally-imported test
   account.
4. **An Amoy RPC endpoint** with enough throughput for the chain
   indexer's polling - the public endpoint in `.env.example`
   (`https://rpc-amoy.polygon.technology`) is rate-limited; a dedicated
   RPC provider (Alchemy, Infura, etc.) is recommended for anything
   beyond a quick manual test.

## Steps, once the above exist

```bash
# 1. Deploy RiskEscrow to Amoy (uses PRIVATE_KEY, RISK_ORACLE_ADDRESS)
npm run deploy:amoy

# 2. Point the chain indexer and the web app at Amoy
#    (contracts/scripts/deploy.js already writes NEXT_PUBLIC_RISK_ESCROW_ADDRESS;
#    set these by hand in .env.local)
echo 'NEXT_PUBLIC_CHAIN_ID=80002' >> .env.local
echo 'CHAIN_ID=80002' >> .env.local
echo 'RPC_URL=<your Amoy RPC>' >> .env.local
echo 'NEXT_PUBLIC_RPC_URL=<your Amoy RPC>' >> .env.local

# 3. Apply migrations to whatever Postgres the indexer/app will share
DATABASE_URL=<your Postgres> npm run migrate

# 4. Start the risk-oracle service with the real oracle key
cd quant && RISK_ORACLE_PRIVATE_KEY=<real key> .venv/bin/uvicorn askgene_quant.service.app:app --port 8001

# 5. Start the chain indexer against Amoy
cd services/chain-indexer && \
  RPC_URL=<your Amoy RPC> CHAIN_ID=80002 RISK_ESCROW_ADDRESS=<deployed address> \
  DATABASE_URL=<your Postgres> go run ./cmd/indexer

# 6. Start the web app, connect a real wallet with Amoy test POL, and
#    run through /escrow/new for real.
npm run dev -w apps/web
```

## Why local Hardhat is sufficient for now

Everything the local demo needed to prove - the risk engine pricing a quote,
the EIP-712 signature verifying against the deployed contract, the
collateral lock/settle/refund mechanics, the chain indexer's
confirmation-depth and reorg handling, the dashboard reading confirmed
state - is chain-agnostic. None of it changes between a local Hardhat
chain and Polygon Amoy; only the RPC endpoint, the keys, and real block
times differ. A testnet run would validate real-world latency and RPC
reliability, not new logic.
