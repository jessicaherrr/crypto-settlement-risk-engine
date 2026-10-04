/**
 * Derives what to actually show for an escrow's lifecycle state from
 * confirmed DB state plus the raw event history - pure and testable
 * without a database or a chain connection.
 *
 * `escrows.status` is only ever written by the Go chain indexer, after
 * its confirmation-depth check (see `services/chain-indexer`'s README
 * and `apps/web/app/api/escrow/update-transaction/route.ts`'s docstring)
 * - so `dbStatus` here is already "confirmed," never a guess. What this
 * function adds is noticing when a *newer* lifecycle event exists only
 * as `observed` (mined, seen by the indexer, not yet past its
 * confirmation depth) - e.g. a settlement transaction was just mined but
 * the escrow still reads `active` because the indexer hasn't promoted it
 * yet. That gap is real and expected, not an error, and the UI should
 * say so rather than either lying ("settled" before it's confirmed) or
 * looking stuck ("active" with no explanation).
 */

export type ConfirmedEscrowStatus = 'pending' | 'active' | 'settled' | 'refunded' | 'cancelled';

export type DisplayTone = 'neutral' | 'positive' | 'warning' | 'critical' | 'info';

export interface EscrowDisplayStatus {
  label: string;
  tone: DisplayTone;
  confirmed: boolean;
  detail: string;
}

export interface LifecycleEventSummary {
  eventName: 'RiskEscrowCreated' | 'RiskEscrowSettled' | 'RiskEscrowRefunded';
  confirmationState: 'observed' | 'confirmed';
  isOrphaned: boolean;
  blockNumber: string | number;
  logIndex: number;
}

export function deriveEscrowDisplayStatus(params: {
  dbStatus: ConfirmedEscrowStatus;
  hasSubmittedTx: boolean;
  events: LifecycleEventSummary[];
}): EscrowDisplayStatus {
  const { dbStatus, hasSubmittedTx, events } = params;

  const latestLifecycleEvent = events
    .filter((e) => !e.isOrphaned)
    .sort((a, b) => {
      const blockDiff = Number(a.blockNumber) - Number(b.blockNumber);
      return blockDiff !== 0 ? blockDiff : a.logIndex - b.logIndex;
    })
    .at(-1);
  const latestIsObserved = latestLifecycleEvent?.confirmationState === 'observed';

  if (dbStatus === 'settled') {
    return { label: 'Settled', tone: 'positive', confirmed: true, detail: 'Confirmed by the chain indexer.' };
  }
  if (dbStatus === 'refunded') {
    return { label: 'Refunded', tone: 'neutral', confirmed: true, detail: 'Confirmed by the chain indexer.' };
  }
  if (dbStatus === 'cancelled') {
    return { label: 'Cancelled', tone: 'neutral', confirmed: true, detail: 'Cancelled before activation.' };
  }

  if (dbStatus === 'active') {
    if (latestLifecycleEvent?.eventName === 'RiskEscrowSettled' && latestIsObserved) {
      return {
        label: 'Active — settlement observed',
        tone: 'info',
        confirmed: false,
        detail: 'A settlement transaction was observed on-chain but has not yet passed the indexer’s confirmation depth.',
      };
    }
    if (latestLifecycleEvent?.eventName === 'RiskEscrowRefunded' && latestIsObserved) {
      return {
        label: 'Active — refund observed',
        tone: 'info',
        confirmed: false,
        detail: 'A refund transaction was observed on-chain but has not yet passed the indexer’s confirmation depth.',
      };
    }
    return { label: 'Active', tone: 'positive', confirmed: true, detail: 'Confirmed by the chain indexer; collateral is locked.' };
  }

  // dbStatus === 'pending'
  if (latestLifecycleEvent?.eventName === 'RiskEscrowCreated' && latestIsObserved) {
    return {
      label: 'Observed — awaiting confirmation',
      tone: 'info',
      confirmed: false,
      detail: 'The creation transaction was observed on-chain but has not yet passed the indexer’s confirmation depth.',
    };
  }
  if (hasSubmittedTx) {
    return {
      label: 'Submitted — not yet observed',
      tone: 'warning',
      confirmed: false,
      detail: 'A transaction hash was recorded but the chain indexer has not observed a matching event yet.',
    };
  }
  return {
    label: 'Pending',
    tone: 'neutral',
    confirmed: false,
    detail: 'No on-chain transaction has been submitted yet.',
  };
}
