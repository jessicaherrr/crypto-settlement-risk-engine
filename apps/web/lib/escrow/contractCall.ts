import { getAddress } from 'viem';

import type { OnchainQuote } from './newEscrowMachine';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export interface CreateEscrowArgs {
  quoteId: `0x${string}`;
  depositor: `0x${string}`;
  counterparty: `0x${string}`;
  settlementAsset: `0x${string}`;
  notional: bigint;
  requiredCollateral: bigint;
  quoteExpiration: bigint;
  settlementHorizon: bigint;
  modelVersion: string;
  riskSnapshotHash: `0x${string}`;
}

/** Converts the server's on-chain quote struct (uint256 fields as
 * decimal strings - see `service/schemas.py`'s docstring for why) into
 * the bigint-typed args `createEscrow` needs. Throws on a non-integer
 * numeric field rather than silently truncating. */
export function buildCreateEscrowArgs(onchain: OnchainQuote): CreateEscrowArgs {
  return {
    quoteId: onchain.quoteId as `0x${string}`,
    depositor: getAddress(onchain.depositor),
    counterparty: getAddress(onchain.counterparty),
    settlementAsset: getAddress(onchain.settlementAsset || ZERO_ADDRESS),
    notional: BigInt(onchain.notional),
    requiredCollateral: BigInt(onchain.requiredCollateral),
    quoteExpiration: BigInt(onchain.quoteExpiration),
    settlementHorizon: BigInt(onchain.settlementHorizon),
    modelVersion: onchain.modelVersion,
    riskSnapshotHash: onchain.riskSnapshotHash as `0x${string}`,
  };
}

/** `msg.value` for `createEscrow`: the full collateral for a native
 * settlement, exactly zero for an ERC-20 one (which instead relies on a
 * prior `approve` + the contract's `safeTransferFrom`). */
export function createEscrowValue(args: CreateEscrowArgs): bigint {
  return args.settlementAsset === ZERO_ADDRESS ? args.requiredCollateral : 0n;
}

export function isNativeSettlement(args: CreateEscrowArgs): boolean {
  return args.settlementAsset === ZERO_ADDRESS;
}

/** Previews `settle(dealId)`'s payout split - `fee + payout + refund`
 * always equals `collateralLocked` (enforced on-chain; see
 * `RiskEscrow.sol`'s fee-handling tests). Shown to the user before they
 * sign, so there are no surprises about where the buffer goes. */
export function computeSettlePreview(
  notional: bigint,
  collateralLocked: bigint,
  platformFeeBps: bigint
): { fee: bigint; payout: bigint; refund: bigint } {
  const fee = (notional * platformFeeBps) / 10_000n;
  const payout = notional - fee;
  const refund = collateralLocked - notional;
  return { fee, payout, refund };
}
