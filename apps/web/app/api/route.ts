import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    name: 'Crypto Settlement Risk Engine API',
    version: '0.1.0',
    description: 'API for the risk-aware crypto escrow and settlement engine',
    endpoints: [
      {
        path: '/api/quote/request',
        method: 'POST',
        description: 'Request a signed RiskQuote from the risk-oracle service for a notional/horizon/party binding'
      },
      {
        path: '/api/escrow/create',
        method: 'POST',
        description: 'Create a pending escrow and get the on-chain contract call config'
      },
      {
        path: '/api/escrow/update-transaction',
        method: 'POST',
        description: 'Attach a confirmed blockchain transaction hash to an escrow'
      }
    ],
    timestamp: new Date().toISOString()
  });
}
