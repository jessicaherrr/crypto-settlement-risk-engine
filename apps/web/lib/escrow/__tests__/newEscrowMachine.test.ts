import { describe, expect, it } from 'vitest';

import {
  INITIAL_NEW_ESCROW_STATE,
  type IssuedQuote,
  isQuoteTooCloseToExpiry,
  needsApproval,
  newEscrowReducer,
} from '../newEscrowMachine';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ERC20_ADDRESS = '0x1111111111111111111111111111111111111111';

function makeQuote(quoteExpirationUnixSeconds: number): IssuedQuote {
  return {
    quote: {
      quoteId: '0xabc',
      depositor: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      counterparty: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      settlementAsset: ZERO_ADDRESS,
      notional: '1000000000000000000',
      requiredCollateral: '1500000000000000000',
      quoteExpiration: String(quoteExpirationUnixSeconds),
      settlementHorizon: '604800',
      modelVersion: 'garch_1_1-v1',
      riskSnapshotHash: '0xdef',
    },
    signature: '0xsig',
    riskQuote: {},
    digest: '0xdigest',
    signer: '0xsigner',
  };
}

describe('newEscrowReducer', () => {
  it('starts in editing', () => {
    expect(INITIAL_NEW_ESCROW_STATE.phase).toBe('editing');
  });

  it('REQUEST_QUOTE resets to a clean requesting_quote state', () => {
    const dirty = { ...INITIAL_NEW_ESCROW_STATE, phase: 'error' as const, error: { kind: 'unknown' as const, message: 'x' } };
    const next = newEscrowReducer(dirty, { type: 'REQUEST_QUOTE' });
    expect(next.phase).toBe('requesting_quote');
    expect(next.error).toBeNull();
  });

  it('happy path: quote -> escrow prepared -> create submitted -> mined -> confirmations -> indexed', () => {
    const quote = makeQuote(2_000_000_000);
    let state = newEscrowReducer(INITIAL_NEW_ESCROW_STATE, { type: 'REQUEST_QUOTE' });
    state = newEscrowReducer(state, { type: 'QUOTE_RECEIVED', quote });
    expect(state.phase).toBe('quote_ready');
    expect(state.quote).toBe(quote);

    state = newEscrowReducer(state, { type: 'ESCROW_PREPARED', escrowId: 'esc-1' });
    expect(state.phase).toBe('awaiting_create_signature');
    expect(state.escrowId).toBe('esc-1');

    state = newEscrowReducer(state, { type: 'CREATE_SUBMITTED', txHash: '0xtx' });
    expect(state.phase).toBe('create_pending');
    expect(state.createTxHash).toBe('0xtx');

    state = newEscrowReducer(state, { type: 'CREATE_MINED', dealId: '7' });
    expect(state.phase).toBe('create_mined');
    expect(state.dealId).toBe('7');

    state = newEscrowReducer(state, { type: 'CONFIRMATION_PROGRESS', confirmations: 1, depth: 5 });
    expect(state.phase).toBe('awaiting_confirmations');
    expect(state.confirmations).toBe(1);
    expect(state.confirmationDepth).toBe(5);

    state = newEscrowReducer(state, { type: 'INDEXED' });
    expect(state.phase).toBe('indexed');
  });

  it('ERC-20 path: NEEDS_APPROVAL -> APPROVAL_SUBMITTED -> APPROVAL_CONFIRMED -> preparing', () => {
    let state = newEscrowReducer(INITIAL_NEW_ESCROW_STATE, { type: 'QUOTE_RECEIVED', quote: makeQuote(2_000_000_000) });
    state = newEscrowReducer(state, { type: 'NEEDS_APPROVAL' });
    expect(state.phase).toBe('awaiting_approval_signature');

    state = newEscrowReducer(state, { type: 'APPROVAL_SUBMITTED', txHash: '0xapprove' });
    expect(state.phase).toBe('approval_pending');
    expect(state.approvalTxHash).toBe('0xapprove');

    state = newEscrowReducer(state, { type: 'APPROVAL_CONFIRMED' });
    expect(state.phase).toBe('preparing');
  });

  it('ALLOWANCE_SUFFICIENT skips straight to preparing without an approval tx', () => {
    let state = newEscrowReducer(INITIAL_NEW_ESCROW_STATE, { type: 'QUOTE_RECEIVED', quote: makeQuote(2_000_000_000) });
    state = newEscrowReducer(state, { type: 'ALLOWANCE_SUFFICIENT' });
    expect(state.phase).toBe('preparing');
    expect(state.approvalTxHash).toBeNull();
  });

  it('QUOTE_EXPIRED and ESCROW_REJECTED land in their respective terminal phases', () => {
    const afterExpiry = newEscrowReducer(INITIAL_NEW_ESCROW_STATE, { type: 'QUOTE_EXPIRED' });
    expect(afterExpiry.phase).toBe('quote_expired');

    const afterRejection = newEscrowReducer(INITIAL_NEW_ESCROW_STATE, {
      type: 'ESCROW_REJECTED',
      message: 'tampered',
    });
    expect(afterRejection.phase).toBe('error');
    expect(afterRejection.error).toEqual({ kind: 'quote_rejected', message: 'tampered' });
  });

  it('ERROR carries the specific error kind through for UI branching', () => {
    const state = newEscrowReducer(INITIAL_NEW_ESCROW_STATE, {
      type: 'ERROR',
      kind: 'wrong_network',
      message: 'Switch to the configured chain',
    });
    expect(state.phase).toBe('error');
    expect(state.error?.kind).toBe('wrong_network');
  });

  it('EDIT resets fully back to the initial state', () => {
    const quote = makeQuote(2_000_000_000);
    const dirty = newEscrowReducer(INITIAL_NEW_ESCROW_STATE, { type: 'QUOTE_RECEIVED', quote });
    const reset = newEscrowReducer(dirty, { type: 'EDIT' });
    expect(reset).toEqual(INITIAL_NEW_ESCROW_STATE);
  });
});

describe('isQuoteTooCloseToExpiry', () => {
  it('is false well before expiry', () => {
    const quote = makeQuote(1000); // expires at t=1000s
    expect(isQuoteTooCloseToExpiry(quote, 500_000, 30)).toBe(false);
  });

  it('is true within the safety margin', () => {
    const quote = makeQuote(1000);
    expect(isQuoteTooCloseToExpiry(quote, 980_000, 30)).toBe(true); // 20s left, margin 30s
  });

  it('is true once already expired', () => {
    const quote = makeQuote(1000);
    expect(isQuoteTooCloseToExpiry(quote, 1_000_001_000, 30)).toBe(true);
  });
});

describe('needsApproval', () => {
  it('is always false for the native asset, regardless of allowance', () => {
    expect(needsApproval(ZERO_ADDRESS, 0n, 1000n)).toBe(false);
  });

  it('is true when allowance is below the required collateral', () => {
    expect(needsApproval(ERC20_ADDRESS, 500n, 1000n)).toBe(true);
  });

  it('is false when allowance already covers the required collateral', () => {
    expect(needsApproval(ERC20_ADDRESS, 1000n, 1000n)).toBe(false);
    expect(needsApproval(ERC20_ADDRESS, 1500n, 1000n)).toBe(false);
  });
});
