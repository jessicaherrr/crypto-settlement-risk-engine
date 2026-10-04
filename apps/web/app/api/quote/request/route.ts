// app/api/quote/request/route.ts
import { NextRequest, NextResponse } from 'next/server';

import { ACTIVE_CHAIN, RISK_ESCROW_ADDRESS } from '@/lib/chain/config';
import { query } from '@/lib/server/db';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// The Python risk-oracle service (quant/src/askgene_quant/service/app.py).
// Not reachable from the browser directly - only this route (server-side)
// talks to it, so the signing key and the quantitative pipeline never run
// client-side. Start it with:
//   cd quant && .venv/bin/uvicorn askgene_quant.service.app:app --port 8001
const RISK_SERVICE_URL = process.env.RISK_SERVICE_URL || 'http://localhost:8001';

/**
 * Requests a real, EIP-712-signed `RiskQuote` from the Python risk engine
 * for a given notional/horizon/party binding, and hands it back in
 * exactly the shape `POST /api/escrow/create` expects (`{ quote,
 * signature }`, camelCase on-chain field names) - this route is the
 * "real quote request" step that precedes it, not a replacement for it.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      asset = 'ETH-USD',
      notional,
      horizonDays,
      depositor,
      counterparty,
      settlementAsset = ZERO_ADDRESS,
      settlementAssetDecimals = 18,
      confidenceLevel,
    } = body;

    if (!notional || !horizonDays || !depositor || !counterparty) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing required fields: notional, horizonDays, depositor, counterparty',
        },
        { status: 400 }
      );
    }

    if (typeof notional !== 'string') {
      return NextResponse.json(
        {
          success: false,
          error: 'notional must be a decimal string (e.g. "10.5"), not a number - ' +
            'JSON numbers lose precision for financial amounts',
        },
        { status: 400 }
      );
    }

    const upstreamResponse = await fetch(`${RISK_SERVICE_URL}/v1/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset,
        notional,
        horizon_days: horizonDays,
        depositor,
        counterparty,
        settlement_asset: settlementAsset,
        settlement_asset_decimals: settlementAssetDecimals,
        chain_id: ACTIVE_CHAIN.id,
        verifying_contract: RISK_ESCROW_ADDRESS,
        ...(confidenceLevel !== undefined ? { confidence_level: confidenceLevel } : {}),
      }),
    });

    const upstreamBody = await upstreamResponse.json();

    if (!upstreamResponse.ok) {
      return NextResponse.json(
        {
          success: false,
          error: upstreamBody.detail || 'Risk oracle service rejected the quote request',
        },
        { status: upstreamResponse.status }
      );
    }

    // Persist the full issued quote server-to-server, before it ever
    // reaches the browser - this is what /api/escrow/create reads back to
    // validate a submitted quote against exactly what was issued (not
    // client-supplied fields), and what an escrow's detail page later
    // reads for its "risk at issuance" section (VaR/ES/stress/spot, none
    // of which escrows itself stores). Best-effort: a write failure here
    // shouldn't block handing back a quote the risk engine already signed.
    try {
      await query(
        `INSERT INTO risk_quotes (
          quote_id, chain_id, verifying_contract, depositor, counterparty,
          settlement_asset, settlement_asset_decimals, onchain, model_output,
          signature, digest, signer, quote_expiration
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (quote_id) DO NOTHING`,
        [
          upstreamBody.onchain.quoteId,
          ACTIVE_CHAIN.id,
          RISK_ESCROW_ADDRESS,
          upstreamBody.onchain.depositor,
          upstreamBody.onchain.counterparty,
          upstreamBody.onchain.settlementAsset === ZERO_ADDRESS ? null : upstreamBody.onchain.settlementAsset,
          settlementAssetDecimals,
          JSON.stringify(upstreamBody.onchain),
          JSON.stringify(upstreamBody.quote),
          upstreamBody.signature,
          upstreamBody.digest,
          upstreamBody.signer,
          new Date(Number(upstreamBody.onchain.quoteExpiration) * 1000).toISOString(),
        ]
      );
    } catch (persistError) {
      console.error('risk_quotes insert failed (non-fatal):', persistError);
    }

    return NextResponse.json({
      success: true,
      // Exactly what /api/escrow/create expects as its request body.
      quote: upstreamBody.onchain,
      signature: upstreamBody.signature,
      // Full model output + audit fields, for display/logging - not
      // needed to submit the transaction.
      riskQuote: upstreamBody.quote,
      digest: upstreamBody.digest,
      signer: upstreamBody.signer,
    });
  } catch (error) {
    console.error('Quote request error:', error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? `Failed to reach the risk oracle service: ${error.message}`
            : 'Unknown error requesting a risk quote',
      },
      { status: 502 }
    );
  }
}
