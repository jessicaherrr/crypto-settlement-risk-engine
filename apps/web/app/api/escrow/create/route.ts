// app/api/escrow/create/route.ts
// Renamed from create-session (a marketplace-era "booking session" name
// repurposed for "create an escrow session" - no longer meaningful once
// nothing else in this codebase uses "session" that way). See README.md
// and docs/architecture.md, both updated to match.
import { NextRequest, NextResponse } from 'next/server';
import { getAddress } from 'viem';

import { ACTIVE_CHAIN, RISK_ESCROW_ADDRESS } from '@/lib/chain/config';
import { riskEscrowAbi } from '@/lib/contracts/riskEscrowAbi';
import { fromOnchainString, formatFixed } from '@/lib/format';
import { publicClient } from '@/lib/server/chain';
import { query, queryOne } from '@/lib/server/db';
import type { EscrowRow, PaymentRecordRow, RiskQuoteRow } from '@/lib/server/db-types';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

// Exactly `RiskQuoteVerifier.RiskQuote`'s fields, in its EIP-712 field
// order - both the completeness check and the issued-quote comparison
// below iterate this list rather than hand-checking each field.
const ONCHAIN_FIELDS = [
  'quoteId',
  'depositor',
  'counterparty',
  'settlementAsset',
  'notional',
  'requiredCollateral',
  'quoteExpiration',
  'settlementHorizon',
  'modelVersion',
  'riskSnapshotHash',
] as const;

/**
 * Persists a pending escrow record and prepares the on-chain `createEscrow`
 * call config for a RiskQuote the caller already has. Before doing either,
 * the submitted quote is checked two ways: field-for-field against the
 * `risk_quotes` row this server itself wrote when the quote was issued
 * (`/api/quote/request`) - so a client can't redefine a quote's terms
 * after receiving it - and against the deployed contract's own
 * `recoverRiskQuoteSigner`/`riskOracle`/`usedQuotes` views, so acceptance
 * here means the on-chain `createEscrow` call this response prepares will
 * actually succeed, not just that our own bookkeeping matches.
 *
 * This endpoint does not compute risk or sign anything; the risk engine
 * (quant/) already did both. The deposit transaction is signed client-side.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { quote, signature } = body;

    if (!quote || typeof quote !== 'object' || !signature) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: quote, signature' },
        { status: 400 }
      );
    }
    for (const field of ONCHAIN_FIELDS) {
      if (quote[field] === undefined || quote[field] === null || quote[field] === '') {
        return NextResponse.json(
          { success: false, error: `Incomplete RiskQuote: missing ${field}` },
          { status: 400 }
        );
      }
    }

    const issued = await queryOne<RiskQuoteRow>('SELECT * FROM risk_quotes WHERE quote_id = $1', [
      quote.quoteId,
    ]);
    if (!issued) {
      return NextResponse.json(
        { success: false, error: 'Unknown quote: no matching quote was issued by this server' },
        { status: 400 }
      );
    }

    const issuedOnchain = issued.onchain as Record<string, unknown>;
    for (const field of ONCHAIN_FIELDS) {
      if (String(issuedOnchain[field] ?? '') !== String(quote[field] ?? '')) {
        return NextResponse.json(
          { success: false, error: `Quote field "${field}" does not match the quote this server issued` },
          { status: 400 }
        );
      }
    }
    if (signature !== issued.signature) {
      return NextResponse.json(
        { success: false, error: 'Signature does not match the issued quote' },
        { status: 400 }
      );
    }
    if (Number(issued.chain_id) !== ACTIVE_CHAIN.id || getAddress(issued.verifying_contract) !== getAddress(RISK_ESCROW_ADDRESS)) {
      return NextResponse.json(
        { success: false, error: 'This quote was issued for a different chain or contract' },
        { status: 400 }
      );
    }
    if (Date.now() >= new Date(issued.quote_expiration).getTime()) {
      return NextResponse.json(
        { success: false, error: 'Quote has expired; request a new one' },
        { status: 400 }
      );
    }

    const resolvedSettlementAsset = quote.settlementAsset === ZERO_ADDRESS ? ZERO_ADDRESS : getAddress(quote.settlementAsset);
    const onchainTuple = {
      quoteId: quote.quoteId as `0x${string}`,
      depositor: getAddress(quote.depositor),
      counterparty: getAddress(quote.counterparty),
      settlementAsset: resolvedSettlementAsset,
      notional: BigInt(quote.notional),
      requiredCollateral: BigInt(quote.requiredCollateral),
      quoteExpiration: BigInt(quote.quoteExpiration),
      settlementHorizon: BigInt(quote.settlementHorizon),
      modelVersion: quote.modelVersion as string,
      riskSnapshotHash: quote.riskSnapshotHash as `0x${string}`,
    };

    let recoveredSigner: string;
    let oracleAddress: string;
    let alreadyUsed: boolean;
    try {
      [recoveredSigner, oracleAddress, alreadyUsed] = await Promise.all([
        publicClient.readContract({
          address: RISK_ESCROW_ADDRESS,
          abi: riskEscrowAbi,
          functionName: 'recoverRiskQuoteSigner',
          args: [onchainTuple, signature as `0x${string}`],
        }) as Promise<string>,
        publicClient.readContract({
          address: RISK_ESCROW_ADDRESS,
          abi: riskEscrowAbi,
          functionName: 'riskOracle',
        }) as Promise<string>,
        publicClient.readContract({
          address: RISK_ESCROW_ADDRESS,
          abi: riskEscrowAbi,
          functionName: 'usedQuotes',
          args: [quote.quoteId as `0x${string}`],
        }) as Promise<boolean>,
      ]);
    } catch (chainError) {
      console.error('on-chain quote verification failed:', chainError);
      return NextResponse.json(
        { success: false, error: 'Could not verify the quote against the settlement contract. Is the chain reachable?' },
        { status: 503 }
      );
    }

    if (getAddress(recoveredSigner) !== getAddress(oracleAddress)) {
      return NextResponse.json(
        { success: false, error: 'Quote signature does not match the configured risk oracle' },
        { status: 400 }
      );
    }
    if (alreadyUsed) {
      return NextResponse.json(
        { success: false, error: 'This quote has already been used to create an escrow' },
        { status: 400 }
      );
    }

    // Legacy human-readable display column (DECIMAL(20,2)); notional/
    // required_collateral below are stored as exact base-units strings
    // for on-chain-accurate logic. Formatted through the bigint-safe
    // path (never `Number(BigInt(...))`, which silently loses precision)
    // and passed as a plain decimal-string SQL parameter.
    const displayAmount = formatFixed(fromOnchainString(String(quote.notional), 18), {
      minFrac: 2,
      maxFrac: 2,
      grouping: false,
    });

    let escrow: EscrowRow | null;
    try {
      escrow = await queryOne<EscrowRow>(
        `INSERT INTO escrows (
          depositor_wallet_address, counterparty_wallet_address, amount,
          settlement_time, status, payment_status,
          crypto_currency, crypto_amount, network, contract_address,
          quote_id, settlement_asset, notional, required_collateral,
          model_version, risk_snapshot_hash, quote_expiration, settlement_horizon_seconds
        ) VALUES (
          $1, $2, $3,
          $4, 'pending', 'pending',
          $5, $6, 'polygon-amoy', $7,
          $8, $9, $10, $11,
          $12, $13, $14, $15
        )
        RETURNING *`,
        [
          quote.depositor,
          quote.counterparty,
          displayAmount,
          new Date(Number(quote.quoteExpiration) * 1000).toISOString(),
          resolvedSettlementAsset === ZERO_ADDRESS ? 'POL' : 'ERC20',
          String(quote.requiredCollateral),
          RISK_ESCROW_ADDRESS,
          quote.quoteId,
          resolvedSettlementAsset === ZERO_ADDRESS ? null : resolvedSettlementAsset,
          String(quote.notional),
          String(quote.requiredCollateral),
          quote.modelVersion,
          quote.riskSnapshotHash,
          new Date(Number(quote.quoteExpiration) * 1000).toISOString(),
          Number(quote.settlementHorizon),
        ]
      );
    } catch (escrowError) {
      // Postgres unique_violation on idx_escrows_quote_id - a pending
      // escrow for this exact quote already exists. This is the common,
      // expected case of a client retrying/double-submitting, not a
      // server error, so it gets a clean 409 rather than a raw DB
      // message leaking out as a 500.
      if (isUniqueViolation(escrowError)) {
        return NextResponse.json(
          { success: false, error: 'An escrow for this quote already exists' },
          { status: 409 }
        );
      }
      console.error('Escrow creation error:', escrowError);
      return NextResponse.json(
        { success: false, error: 'Failed to create escrow record' },
        { status: 500 }
      );
    }

    if (!escrow) {
      return NextResponse.json({ success: false, error: 'Failed to create escrow record' }, { status: 500 });
    }

    let paymentRecord: PaymentRecordRow | undefined;
    try {
      const paymentRecords = await query<PaymentRecordRow>(
        `INSERT INTO payment_records (
          escrow_id, payment_method, payment_provider, provider_payment_id,
          amount, crypto_amount, currency, crypto_currency,
          from_address, to_address, network, status, metadata
        ) VALUES (
          $1, 'crypto', 'polygon', $2,
          $3, $4, 'USD', $5,
          $6, $7, 'polygon-amoy', 'pending', $8
        )
        RETURNING *`,
        [
          escrow.id,
          escrow.id,
          displayAmount,
          String(quote.requiredCollateral),
          resolvedSettlementAsset === ZERO_ADDRESS ? 'POL' : 'ERC20',
          quote.depositor,
          quote.counterparty,
          JSON.stringify({
            escrow_id: escrow.id,
            contract_address: RISK_ESCROW_ADDRESS,
            quote_id: quote.quoteId,
            model_version: quote.modelVersion,
            risk_snapshot_hash: quote.riskSnapshotHash,
          }),
        ]
      );
      paymentRecord = paymentRecords[0];
    } catch (paymentRecordError) {
      console.error('Payment record creation error:', paymentRecordError);
      // Non-fatal: escrow record exists, continue
    }

    return NextResponse.json({
      success: true,
      escrowId: escrow.id,
      contractAddress: RISK_ESCROW_ADDRESS,
      notional: quote.notional,
      requiredCollateral: String(quote.requiredCollateral),
      settlementAsset: resolvedSettlementAsset,
      network: 'polygon-amoy',
      paymentRecordId: paymentRecord?.id,
      nextSteps: 'Sign the createEscrow transaction in your wallet',
      // Numeric fields are returned as decimal strings (JSON has no bigint
      // type) - the caller must convert them to BigInt before passing this
      // quote struct to wagmi/viem's writeContract.
      contractConfig: {
        address: RISK_ESCROW_ADDRESS,
        functionName: 'createEscrow' as const,
        args: [
          {
            quoteId: quote.quoteId,
            depositor: quote.depositor,
            counterparty: quote.counterparty,
            settlementAsset: resolvedSettlementAsset,
            notional: String(quote.notional),
            requiredCollateral: String(quote.requiredCollateral),
            quoteExpiration: String(quote.quoteExpiration),
            settlementHorizon: String(quote.settlementHorizon),
            modelVersion: quote.modelVersion,
            riskSnapshotHash: quote.riskSnapshotHash,
          },
          signature,
        ],
        value: resolvedSettlementAsset === ZERO_ADDRESS ? String(quote.requiredCollateral) : '0',
      },
    });
  } catch (error) {
    console.error('Escrow creation error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
