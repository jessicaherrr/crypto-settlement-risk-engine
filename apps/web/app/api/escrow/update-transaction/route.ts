import { NextRequest, NextResponse } from 'next/server';
import { getAddress, parseEventLogs } from 'viem';

import { RISK_ESCROW_ADDRESS } from '@/lib/chain/config';
import { riskEscrowAbi } from '@/lib/contracts/riskEscrowAbi';
import { publicClient } from '@/lib/server/chain';
import { query, queryOne } from '@/lib/server/db';
import type { EscrowRow, PaymentRecordRow } from '@/lib/server/db-types';

/**
 * Records that a `createEscrow` transaction was submitted for a pending
 * escrow - but only after independently verifying it on-chain. Earlier
 * versions of this route trusted a client-supplied `onChainEscrowId` and
 * flipped `status` straight to `'active'`, which would let any
 * unauthenticated request mark an escrow active in the database. Now:
 * the transaction's receipt must exist, must have succeeded, must be a
 * call to this deployment's RiskEscrow, and must emit a
 * `RiskEscrowCreated` event for *this* escrow's `quote_id` - the on-chain
 * deal ID this route records is read out of that verified event, never
 * taken from the request body.
 *
 * `status` is deliberately never written here, in either direction - a
 * merely-submitted (or even just-mined) transaction is "observed," not
 * "confirmed." Only the Go chain indexer, after its confirmation-depth
 * check, promotes an escrow to `active`/`settled`/`refunded`; that stays
 * the single writer for lifecycle state, matching
 * `escrow_events.confirmation_state`'s observed/confirmed distinction.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { escrowId, transactionHash } = body;

    if (!escrowId || !transactionHash) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: escrowId, transactionHash' },
        { status: 400 }
      );
    }

    const escrow = await queryOne<EscrowRow>('SELECT * FROM escrows WHERE id = $1', [escrowId]);
    if (!escrow) {
      return NextResponse.json({ success: false, error: `No escrow found with id ${escrowId}` }, { status: 404 });
    }
    if (!escrow.quote_id) {
      return NextResponse.json(
        { success: false, error: 'Escrow has no associated quote_id to verify against' },
        { status: 400 }
      );
    }

    let receipt;
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: transactionHash });
    } catch (fetchError) {
      console.error('Could not fetch transaction receipt:', fetchError);
      return NextResponse.json(
        { success: false, error: 'Transaction not found or not yet mined - try again once it confirms' },
        { status: 409 }
      );
    }

    if (receipt.status !== 'success') {
      return NextResponse.json({ success: false, error: 'Transaction reverted on-chain' }, { status: 400 });
    }
    if (!receipt.to || getAddress(receipt.to) !== getAddress(RISK_ESCROW_ADDRESS)) {
      return NextResponse.json(
        { success: false, error: 'Transaction does not target this deployment’s settlement contract' },
        { status: 400 }
      );
    }

    const createdEvents = parseEventLogs({
      abi: riskEscrowAbi,
      eventName: 'RiskEscrowCreated',
      logs: receipt.logs,
    });
    const matchingEvent = createdEvents.find((event) => event.args.quoteId === escrow.quote_id);
    if (!matchingEvent) {
      return NextResponse.json(
        { success: false, error: 'Transaction did not emit a RiskEscrowCreated event for this escrow’s quote' },
        { status: 400 }
      );
    }

    const onChainDealId = matchingEvent.args.dealId.toString();

    let updatedEscrow: EscrowRow | null;
    try {
      updatedEscrow = await queryOne<EscrowRow>(
        `UPDATE escrows SET
          crypto_transaction_hash = $2,
          on_chain_escrow_id = $3,
          payment_status = 'confirming',
          updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
        [escrowId, transactionHash, onChainDealId]
      );
    } catch (updateError) {
      throw new Error(
        `Failed to update escrow: ${updateError instanceof Error ? updateError.message : 'unknown error'}`
      );
    }

    let paymentRecords: PaymentRecordRow[] = [];
    try {
      paymentRecords = await query<PaymentRecordRow>(
        `UPDATE payment_records SET
          transaction_hash = $2,
          provider_payment_id = $2,
          status = 'confirming',
          updated_at = NOW()
        WHERE escrow_id = $1
        RETURNING *`,
        [escrowId, transactionHash]
      );
    } catch (paymentError) {
      console.error('Payment record update error:', paymentError);
    }

    return NextResponse.json({
      success: true,
      data: { escrow: updatedEscrow, paymentRecords },
      message: 'Transaction verified on-chain and recorded; awaiting indexer confirmation.',
    });
  } catch (error) {
    console.error('Transaction update error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
