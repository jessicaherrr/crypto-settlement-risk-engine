// Drives the full quote -> create -> on-chain tx -> indexer-confirmed ->
// settle/refund journey against a real running local stack (Postgres,
// Hardhat node, the Python risk-oracle service, the Go chain indexer,
// Next.js) - the same thing `scripts/e2e_local.sh` boots before running
// this file. Skipped by default (reports as skipped, not failed) unless
// `E2E_STACK=1`, mirroring the Go chain-indexer's own e2e test's
// convention of gating a real-infra test behind an explicit opt-in
// rather than mocking any of it.
//
//   E2E_STACK=1 npx vitest run tests/integration/escrow-journey.test.ts
//   (or: bash scripts/e2e_local.sh)
//
// Assumes `npm run stack` is already running, with interval mining
// enabled (so confirmations advance without a manual mine) and the
// contract addresses in apps/web/public/contracts.json matching the
// live deployment.

import { readFileSync } from 'fs';
import { join } from 'path';

import { erc20Abi, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http } from 'viem';
import { hardhat } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import { riskEscrowAbi } from '@/lib/contracts/riskEscrowAbi';

const E2E_ENABLED = process.env.E2E_STACK === '1';
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const RPC_URL = process.env.E2E_RPC_URL || 'http://127.0.0.1:8545';

// Well-known local Hardhat test keys (publicly known, never used on a
// real network) - #1 as depositor, #2 as counterparty.
const DEPOSITOR_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const COUNTERPARTY_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

interface ContractsJson {
  riskEscrow: `0x${string}`;
  mockERC20?: `0x${string}`;
}

function loadContracts(): ContractsJson {
  const path = join(__dirname, '../../public/contracts.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs = 30_000, intervalMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function requestQuote(body: Record<string, unknown>) {
  const response = await fetch(`${BASE_URL}/api/quote/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!json.success) throw new Error(`quote request failed: ${JSON.stringify(json)}`);
  return json as { quote: Record<string, string>; signature: `0x${string}` };
}

async function createEscrow(quote: Record<string, string>, signature: string) {
  const response = await fetch(`${BASE_URL}/api/escrow/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quote, signature }),
  });
  const json = await response.json();
  if (!json.success) throw new Error(`escrow create failed: ${JSON.stringify(json)}`);
  return json as { escrowId: string; contractConfig: { address: `0x${string}`; args: unknown[]; value: string } };
}

async function getEscrowByDealId(dealId: string) {
  const response = await fetch(`${BASE_URL}/api/escrow/${dealId}`);
  return response.json() as Promise<{ success: boolean; confirmed: boolean; escrow?: { status: string } }>;
}

describe.skipIf(!E2E_ENABLED)('escrow journey (real local stack, E2E_STACK=1)', () => {
  const contracts = E2E_ENABLED ? loadContracts() : ({} as ContractsJson);
  const account = privateKeyToAccount(DEPOSITOR_KEY);
  const walletClient = createWalletClient({ account, chain: hardhat, transport: http(RPC_URL) });
  const publicClient = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });

  async function driveToConfirmedDeal(settlementAsset?: `0x${string}`): Promise<string> {
    const { quote, signature } = await requestQuote({
      notional: '1',
      horizonDays: 1,
      depositor: account.address,
      counterparty: COUNTERPARTY_ADDRESS,
      ...(settlementAsset ? { settlementAsset, settlementAssetDecimals: 18 } : {}),
    });
    const created = await createEscrow(quote, signature);

    if (settlementAsset) {
      const approveHash = await walletClient.writeContract({
        address: settlementAsset,
        abi: erc20Abi,
        functionName: 'approve',
        args: [created.contractConfig.address, BigInt(quote.requiredCollateral)],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    const [quoteArg, sigArg] = created.contractConfig.args as [Record<string, string>, `0x${string}`];
    const txHash = await walletClient.writeContract({
      address: created.contractConfig.address,
      abi: riskEscrowAbi,
      functionName: 'createEscrow',
      args: [
        {
          ...quoteArg,
          notional: BigInt(quoteArg.notional),
          requiredCollateral: BigInt(quoteArg.requiredCollateral),
          quoteExpiration: BigInt(quoteArg.quoteExpiration),
          settlementHorizon: BigInt(quoteArg.settlementHorizon),
        } as never,
        sigArg,
      ],
      value: BigInt(created.contractConfig.value),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    expect(receipt.status).toBe('success');

    await fetch(`${BASE_URL}/api/escrow/update-transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ escrowId: created.escrowId, transactionHash: txHash }),
    });

    const events = parseEventLogs({ abi: riskEscrowAbi, eventName: 'RiskEscrowCreated', logs: receipt.logs });
    const dealId = (events[0]?.args as { dealId?: bigint })?.dealId?.toString();
    if (!dealId) throw new Error('could not read dealId from receipt logs');

    await pollUntil(async () => {
      const result = await getEscrowByDealId(dealId);
      return result.confirmed === true && result.escrow?.status === 'active';
    });

    return dealId;
  }

  it(
    'native asset: quote -> create -> on-chain tx -> indexer confirms -> settle -> confirmed settled',
    async () => {
      const dealId = await driveToConfirmedDeal();

      const settleHash = await walletClient.writeContract({
        address: contracts.riskEscrow,
        abi: riskEscrowAbi,
        functionName: 'settle',
        args: [BigInt(dealId)],
      });
      const settleReceipt = await publicClient.waitForTransactionReceipt({ hash: settleHash });
      expect(settleReceipt.status).toBe('success');

      await pollUntil(async () => {
        const result = await getEscrowByDealId(dealId);
        return result.escrow?.status === 'settled';
      });
    },
    60_000
  );

  it.skipIf(!contracts.mockERC20)(
    'ERC-20 asset: approve -> create -> on-chain tx -> indexer confirms as active',
    async () => {
      const dealId = await driveToConfirmedDeal(contracts.mockERC20);
      const result = await getEscrowByDealId(dealId);
      expect(result.escrow?.status).toBe('active');
    },
    60_000
  );

  it(
    'refund path: past the settlement horizon, refund succeeds and the indexer confirms it - runs last (advances the chain clock)',
    async () => {
      const dealId = await driveToConfirmedDeal();

      // Past the 1-day settlement horizon. Deliberately the only time-
      // travel in this suite, and deliberately last: see
      // docs/architecture.md on quotes being wall-clock-expiring - any
      // later quote request in this process would otherwise appear
      // expired immediately.
      await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'evm_increaseTime', params: [2 * 86_400], id: 1 }),
      });
      await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'evm_mine', params: [], id: 1 }),
      });

      const refundHash = await walletClient.writeContract({
        address: contracts.riskEscrow,
        abi: riskEscrowAbi,
        functionName: 'refund',
        args: [BigInt(dealId)],
      });
      const refundReceipt = await publicClient.waitForTransactionReceipt({ hash: refundHash });
      expect(refundReceipt.status).toBe('success');

      await pollUntil(async () => {
        const result = await getEscrowByDealId(dealId);
        return result.escrow?.status === 'refunded';
      });
    },
    60_000
  );
});
