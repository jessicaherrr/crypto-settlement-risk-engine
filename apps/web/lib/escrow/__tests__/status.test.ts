import { describe, expect, it } from 'vitest';

import { deriveEscrowDisplayStatus, type LifecycleEventSummary } from '../status';

function event(overrides: Partial<LifecycleEventSummary> = {}): LifecycleEventSummary {
  return {
    eventName: 'RiskEscrowCreated',
    confirmationState: 'confirmed',
    isOrphaned: false,
    blockNumber: 10,
    logIndex: 0,
    ...overrides,
  };
}

describe('deriveEscrowDisplayStatus', () => {
  it('pending with no submitted tx and no events', () => {
    const result = deriveEscrowDisplayStatus({ dbStatus: 'pending', hasSubmittedTx: false, events: [] });
    expect(result.label).toBe('Pending');
    expect(result.confirmed).toBe(false);
  });

  it('pending with a submitted tx but no observed event yet', () => {
    const result = deriveEscrowDisplayStatus({ dbStatus: 'pending', hasSubmittedTx: true, events: [] });
    expect(result.label).toBe('Submitted — not yet observed');
    expect(result.confirmed).toBe(false);
    expect(result.tone).toBe('warning');
  });

  it('pending with an observed (unconfirmed) Created event', () => {
    const result = deriveEscrowDisplayStatus({
      dbStatus: 'pending',
      hasSubmittedTx: true,
      events: [event({ confirmationState: 'observed' })],
    });
    expect(result.label).toBe('Observed — awaiting confirmation');
    expect(result.confirmed).toBe(false);
  });

  it('active with only a confirmed Created event', () => {
    const result = deriveEscrowDisplayStatus({
      dbStatus: 'active',
      hasSubmittedTx: true,
      events: [event({ confirmationState: 'confirmed' })],
    });
    expect(result.label).toBe('Active');
    expect(result.confirmed).toBe(true);
    expect(result.tone).toBe('positive');
  });

  it('active but with a settlement observed, not yet confirmed', () => {
    const result = deriveEscrowDisplayStatus({
      dbStatus: 'active',
      hasSubmittedTx: true,
      events: [
        event({ eventName: 'RiskEscrowCreated', confirmationState: 'confirmed', blockNumber: 10 }),
        event({ eventName: 'RiskEscrowSettled', confirmationState: 'observed', blockNumber: 50 }),
      ],
    });
    expect(result.label).toBe('Active — settlement observed');
    expect(result.confirmed).toBe(false);
  });

  it('active with a refund observed, not yet confirmed', () => {
    const result = deriveEscrowDisplayStatus({
      dbStatus: 'active',
      hasSubmittedTx: true,
      events: [
        event({ eventName: 'RiskEscrowCreated', confirmationState: 'confirmed', blockNumber: 10 }),
        event({ eventName: 'RiskEscrowRefunded', confirmationState: 'observed', blockNumber: 99 }),
      ],
    });
    expect(result.label).toBe('Active — refund observed');
  });

  it('settled is always confirmed, regardless of event history passed in', () => {
    const result = deriveEscrowDisplayStatus({ dbStatus: 'settled', hasSubmittedTx: true, events: [] });
    expect(result.label).toBe('Settled');
    expect(result.confirmed).toBe(true);
  });

  it('refunded is always confirmed', () => {
    const result = deriveEscrowDisplayStatus({ dbStatus: 'refunded', hasSubmittedTx: true, events: [] });
    expect(result.label).toBe('Refunded');
    expect(result.confirmed).toBe(true);
  });

  it('cancelled is confirmed and terminal', () => {
    const result = deriveEscrowDisplayStatus({ dbStatus: 'cancelled', hasSubmittedTx: false, events: [] });
    expect(result.label).toBe('Cancelled');
    expect(result.confirmed).toBe(true);
  });

  it('ignores orphaned events when picking the latest lifecycle event', () => {
    const result = deriveEscrowDisplayStatus({
      dbStatus: 'active',
      hasSubmittedTx: true,
      events: [
        event({ eventName: 'RiskEscrowCreated', confirmationState: 'confirmed', blockNumber: 10 }),
        event({ eventName: 'RiskEscrowSettled', confirmationState: 'observed', blockNumber: 50, isOrphaned: true }),
      ],
    });
    // The orphaned Settled event is discarded by a reorg - must not be
    // treated as the latest real event.
    expect(result.label).toBe('Active');
    expect(result.confirmed).toBe(true);
  });

  it('orders events by block number and log index, not array order', () => {
    const result = deriveEscrowDisplayStatus({
      dbStatus: 'active',
      hasSubmittedTx: true,
      events: [
        event({ eventName: 'RiskEscrowSettled', confirmationState: 'observed', blockNumber: 50, logIndex: 1 }),
        event({ eventName: 'RiskEscrowCreated', confirmationState: 'confirmed', blockNumber: 10, logIndex: 0 }),
      ],
    });
    expect(result.label).toBe('Active — settlement observed');
  });
});
