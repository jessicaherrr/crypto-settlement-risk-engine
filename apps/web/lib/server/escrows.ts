import 'server-only';

import { ACTIVE_CHAIN, RISK_ESCROW_ADDRESS } from '@/lib/chain/config';

import { query, queryOne } from './db';
import type { EscrowEventRow, EscrowRow, RiskQuoteRow } from './db-types';

export async function getEscrowByDealId(dealId: string): Promise<EscrowRow | null> {
  return queryOne<EscrowRow>(
    `SELECT * FROM escrows WHERE chain_id = $1 AND contract_address = $2 AND on_chain_deal_id = $3`,
    [ACTIVE_CHAIN.id, RISK_ESCROW_ADDRESS, dealId]
  );
}

/** Every decoded event for this deal, append-only and ordered the way
 * they actually happened on-chain - includes orphaned rows, so the
 * detail page can show a reorg honestly rather than silently hiding it. */
export async function getEscrowEvents(dealId: string): Promise<EscrowEventRow[]> {
  return query<EscrowEventRow>(
    `SELECT * FROM escrow_events
     WHERE chain_id = $1 AND contract_address = $2 AND deal_id = $3
     ORDER BY block_number ASC, log_index ASC`,
    [ACTIVE_CHAIN.id, RISK_ESCROW_ADDRESS, dealId]
  );
}

export async function getRiskQuoteById(quoteId: string): Promise<RiskQuoteRow | null> {
  return queryOne<RiskQuoteRow>('SELECT * FROM risk_quotes WHERE quote_id = $1', [quoteId]);
}

/** Scoped to the currently active (chain_id, contract_address) pair so that
 * stale rows from a previous local Hardhat deployment - or from another
 * chain entirely - never show up alongside the live contract's escrows.
 * Rows with no on-chain identity yet (chain_id/contract_address still null,
 * i.e. not yet submitted on-chain) are included since they belong to this
 * app regardless of deployment. */
export async function listRecentEscrows(opts: { limit?: number; party?: string } = {}): Promise<EscrowRow[]> {
  const limit = opts.limit ?? 25;
  const scopeClause = '(chain_id IS NULL OR (chain_id = $1 AND contract_address = $2))';
  if (opts.party) {
    return query<EscrowRow>(
      `SELECT * FROM escrows
       WHERE ${scopeClause} AND (depositor_wallet_address ILIKE $3 OR counterparty_wallet_address ILIKE $3)
       ORDER BY created_at DESC LIMIT $4`,
      [ACTIVE_CHAIN.id, RISK_ESCROW_ADDRESS, opts.party, limit]
    );
  }
  return query<EscrowRow>(
    `SELECT * FROM escrows WHERE ${scopeClause} ORDER BY created_at DESC LIMIT $3`,
    [ACTIVE_CHAIN.id, RISK_ESCROW_ADDRESS, limit]
  );
}
