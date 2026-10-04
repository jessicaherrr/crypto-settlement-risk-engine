import { NextRequest, NextResponse } from 'next/server';

import { ACTIVE_CHAIN, RISK_ESCROW_ADDRESS } from '@/lib/chain/config';
import { queryOne } from '@/lib/server/db';
import type { EscrowRow } from '@/lib/server/db-types';

/**
 * Reads an escrow by its on-chain deal ID (not the internal UUID) - the
 * identifier this app's URLs and the `/escrow/new` polling loop use,
 * since it's what's actually meaningful on-chain. `confirmed` reflects
 * the Go chain indexer's own confirmation-depth-gated promotion
 * (`status`), never a live, unconfirmed read - a client polling this
 * route during escrow creation is waiting for exactly that promotion,
 * not for the transaction to merely be mined (which it already knows
 * happened, from its own `waitForTransactionReceipt`).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await params;
  if (!/^\d+$/.test(dealId)) {
    return NextResponse.json({ success: false, error: 'dealId must be a non-negative integer' }, { status: 400 });
  }

  const escrow = await queryOne<EscrowRow>(
    `SELECT * FROM escrows WHERE chain_id = $1 AND contract_address = $2 AND on_chain_deal_id = $3`,
    [ACTIVE_CHAIN.id, RISK_ESCROW_ADDRESS, dealId]
  );

  if (!escrow) {
    return NextResponse.json(
      { success: false, error: 'Not indexed yet - the chain indexer may not have confirmed it', confirmed: false },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    escrow,
    confirmed: ['active', 'settled', 'refunded'].includes(escrow.status),
  });
}
