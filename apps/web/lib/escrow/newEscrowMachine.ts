/**
 * Pure state machine for the /escrow/new flow:
 *
 *   editing -> requesting_quote -> quote_ready (countdown)
 *     -> [quote_expired -> re-request]
 *     -> [ERC-20 only] awaiting_approval_signature -> approval_pending -> preparing
 *     -> preparing -> awaiting_create_signature -> create_pending
 *     -> create_mined -> awaiting_confirmations -> indexed
 *
 * `NewEscrowFlow.tsx` only dispatches actions (wagmi hook results, API
 * responses, timer ticks) - every phase transition and every error
 * classification lives here, where it's testable without a browser or a
 * wallet.
 */

export type ErrorKind =
  | 'wrong_network'
  | 'insufficient_balance'
  | 'quote_rejected'
  | 'user_rejected'
  | 'reverted'
  | 'chain_clock_skew'
  | 'service_unavailable'
  | 'unknown';

export interface OnchainQuote {
  quoteId: string;
  depositor: string;
  counterparty: string;
  settlementAsset: string;
  notional: string;
  requiredCollateral: string;
  quoteExpiration: string; // unix seconds, as a string
  settlementHorizon: string; // seconds, as a string
  modelVersion: string;
  riskSnapshotHash: string;
}

export interface IssuedQuote {
  quote: OnchainQuote;
  signature: string;
  riskQuote: Record<string, unknown>;
  digest: string;
  signer: string;
}

export type NewEscrowPhase =
  | 'editing'
  | 'requesting_quote'
  | 'quote_ready'
  | 'quote_expired'
  | 'awaiting_approval_signature'
  | 'approval_pending'
  | 'preparing'
  | 'awaiting_create_signature'
  | 'create_pending'
  | 'create_mined'
  | 'awaiting_confirmations'
  | 'indexed'
  | 'error';

export interface NewEscrowState {
  phase: NewEscrowPhase;
  quote: IssuedQuote | null;
  escrowId: string | null;
  approvalTxHash: string | null;
  createTxHash: string | null;
  dealId: string | null;
  confirmations: number;
  confirmationDepth: number;
  error: { kind: ErrorKind; message: string } | null;
}

export const INITIAL_NEW_ESCROW_STATE: NewEscrowState = {
  phase: 'editing',
  quote: null,
  escrowId: null,
  approvalTxHash: null,
  createTxHash: null,
  dealId: null,
  confirmations: 0,
  confirmationDepth: 0,
  error: null,
};

export type NewEscrowAction =
  | { type: 'EDIT' }
  | { type: 'REQUEST_QUOTE' }
  | { type: 'QUOTE_RECEIVED'; quote: IssuedQuote }
  | { type: 'QUOTE_FAILED'; message: string }
  | { type: 'QUOTE_EXPIRED' }
  | { type: 'NEEDS_APPROVAL' }
  | { type: 'APPROVAL_SUBMITTED'; txHash: string }
  | { type: 'APPROVAL_CONFIRMED' }
  | { type: 'ALLOWANCE_SUFFICIENT' }
  | { type: 'ESCROW_PREPARED'; escrowId: string }
  | { type: 'ESCROW_REJECTED'; message: string }
  | { type: 'CREATE_SUBMITTED'; txHash: string }
  | { type: 'CREATE_MINED'; dealId: string }
  | { type: 'CONFIRMATION_PROGRESS'; confirmations: number; depth: number }
  | { type: 'INDEXED' }
  | { type: 'ERROR'; kind: ErrorKind; message: string };

export function newEscrowReducer(state: NewEscrowState, action: NewEscrowAction): NewEscrowState {
  switch (action.type) {
    case 'EDIT':
      return { ...INITIAL_NEW_ESCROW_STATE };
    case 'REQUEST_QUOTE':
      return { ...INITIAL_NEW_ESCROW_STATE, phase: 'requesting_quote' };
    case 'QUOTE_RECEIVED':
      return { ...state, phase: 'quote_ready', quote: action.quote, error: null };
    case 'QUOTE_FAILED':
      return { ...state, phase: 'error', error: { kind: 'service_unavailable', message: action.message } };
    case 'QUOTE_EXPIRED':
      return { ...state, phase: 'quote_expired' };
    case 'NEEDS_APPROVAL':
      return { ...state, phase: 'awaiting_approval_signature', error: null };
    case 'APPROVAL_SUBMITTED':
      return { ...state, phase: 'approval_pending', approvalTxHash: action.txHash };
    case 'APPROVAL_CONFIRMED':
    case 'ALLOWANCE_SUFFICIENT':
      return { ...state, phase: 'preparing', error: null };
    case 'ESCROW_PREPARED':
      return { ...state, phase: 'awaiting_create_signature', escrowId: action.escrowId, error: null };
    case 'ESCROW_REJECTED':
      return { ...state, phase: 'error', error: { kind: 'quote_rejected', message: action.message } };
    case 'CREATE_SUBMITTED':
      return { ...state, phase: 'create_pending', createTxHash: action.txHash };
    case 'CREATE_MINED':
      return { ...state, phase: 'create_mined', dealId: action.dealId };
    case 'CONFIRMATION_PROGRESS':
      return {
        ...state,
        phase: 'awaiting_confirmations',
        confirmations: action.confirmations,
        confirmationDepth: action.depth,
      };
    case 'INDEXED':
      return { ...state, phase: 'indexed' };
    case 'ERROR':
      return { ...state, phase: 'error', error: { kind: action.kind, message: action.message } };
    default:
      return state;
  }
}

/** Whether `quote` is too close to (or past) its expiration to safely
 * start a new signature request - checked immediately before every
 * wallet prompt, not just once when the quote first arrived, so an
 * approval that takes a while to sign can't carry an expired quote into
 * `createEscrow`. */
export function isQuoteTooCloseToExpiry(
  quote: IssuedQuote,
  nowMs: number,
  safetyMarginSeconds = 30
): boolean {
  const expiryMs = Number(quote.quote.quoteExpiration) * 1000;
  return nowMs >= expiryMs - safetyMarginSeconds * 1000;
}

/** Whether an ERC-20 approval step is needed before `createEscrow` can
 * be called - false for the native asset (no ERC-20 call involved at
 * all) and false once the existing allowance already covers the
 * required collateral (never submit a redundant approval). */
export function needsApproval(settlementAsset: string, allowance: bigint, requiredCollateral: bigint): boolean {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  if (settlementAsset.toLowerCase() === ZERO_ADDRESS) return false;
  return allowance < requiredCollateral;
}
