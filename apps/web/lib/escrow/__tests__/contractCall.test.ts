import { describe, expect, it } from 'vitest';

import type { OnchainQuote } from '../newEscrowMachine';
import { buildCreateEscrowArgs, computeSettlePreview, createEscrowValue, isNativeSettlement } from '../contractCall';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ERC20_ADDRESS = '0x1111111111111111111111111111111111111111';

function makeOnchain(overrides: Partial<OnchainQuote> = {}): OnchainQuote {
  return {
    quoteId: '0x' + 'ab'.repeat(32),
    depositor: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    counterparty: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    settlementAsset: ZERO_ADDRESS,
    notional: '1000000000000000000',
    requiredCollateral: '1500000000000000000',
    quoteExpiration: '2000000000',
    settlementHorizon: '604800',
    modelVersion: 'garch_1_1-v1',
    riskSnapshotHash: '0x' + 'cd'.repeat(32),
    ...overrides,
  };
}

describe('buildCreateEscrowArgs', () => {
  it('converts every numeric field to bigint without precision loss', () => {
    const args = buildCreateEscrowArgs(makeOnchain({ requiredCollateral: '123456789012345678901234567890' }));
    expect(args.requiredCollateral).toBe(123456789012345678901234567890n);
    expect(typeof args.notional).toBe('bigint');
    expect(typeof args.quoteExpiration).toBe('bigint');
    expect(typeof args.settlementHorizon).toBe('bigint');
  });

  it('checksums addresses', () => {
    const args = buildCreateEscrowArgs(makeOnchain({ depositor: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' }));
    expect(args.depositor).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });

  it('defaults an empty settlementAsset to the zero address', () => {
    const args = buildCreateEscrowArgs(makeOnchain({ settlementAsset: '' }));
    expect(args.settlementAsset).toBe(ZERO_ADDRESS);
  });
});

describe('createEscrowValue / isNativeSettlement', () => {
  it('uses the full required collateral as msg.value for native settlement', () => {
    const args = buildCreateEscrowArgs(makeOnchain({ settlementAsset: ZERO_ADDRESS, requiredCollateral: '42' }));
    expect(isNativeSettlement(args)).toBe(true);
    expect(createEscrowValue(args)).toBe(42n);
  });

  it('uses zero msg.value for an ERC-20 settlement', () => {
    const args = buildCreateEscrowArgs(makeOnchain({ settlementAsset: ERC20_ADDRESS, requiredCollateral: '42' }));
    expect(isNativeSettlement(args)).toBe(false);
    expect(createEscrowValue(args)).toBe(0n);
  });
});

describe('computeSettlePreview', () => {
  it('fee + payout + refund always equals the locked collateral', () => {
    const notional = 1_000_000_000_000_000_000n;
    const collateralLocked = 1_500_000_000_000_000_000n;
    const platformFeeBps = 500n; // 5%
    const { fee, payout, refund } = computeSettlePreview(notional, collateralLocked, platformFeeBps);
    expect(fee + payout + refund).toBe(collateralLocked);
  });

  it('computes the fee as exactly notional * bps / 10000', () => {
    const { fee, payout } = computeSettlePreview(1000n, 1500n, 500n);
    expect(fee).toBe(50n); // 5% of 1000
    expect(payout).toBe(950n);
  });

  it('refund is zero when requiredCollateral equals notional (no buffer)', () => {
    const { refund } = computeSettlePreview(1000n, 1000n, 500n);
    expect(refund).toBe(0n);
  });

  it('handles a zero platform fee', () => {
    const { fee, payout, refund } = computeSettlePreview(1000n, 1500n, 0n);
    expect(fee).toBe(0n);
    expect(payout).toBe(1000n);
    expect(refund).toBe(500n);
  });
});
