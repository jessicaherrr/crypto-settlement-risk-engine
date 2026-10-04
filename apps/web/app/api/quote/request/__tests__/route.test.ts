import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/db', () => ({
  query: vi.fn().mockResolvedValue([]),
}));

const VALID_BODY = {
  notional: '1.5',
  horizonDays: 7,
  depositor: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  counterparty: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
};

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/quote/request', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockUpstream(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

const UPSTREAM_SUCCESS_BODY = {
  onchain: {
    quoteId: '0x' + 'ab'.repeat(32),
    depositor: VALID_BODY.depositor,
    counterparty: VALID_BODY.counterparty,
    settlementAsset: '0x0000000000000000000000000000000000000000',
    notional: '1500000000000000000',
    requiredCollateral: '2000000000000000000',
    quoteExpiration: '2000000000',
    settlementHorizon: '604800',
    modelVersion: 'garch_1_1-v1',
    riskSnapshotHash: '0x' + 'cd'.repeat(32),
  },
  quote: { notional: '1.5', model_version: 'garch_1_1-v1' },
  signature: '0x' + 'ef'.repeat(65),
  digest: '0x' + '12'.repeat(32),
  signer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
};

describe('POST /api/quote/request', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockUpstream(200, UPSTREAM_SUCCESS_BODY));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('rejects a request missing required fields', async () => {
    const { POST } = await import('../route');
    const response = await POST(postRequest({ notional: '1' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
  });

  it('rejects a numeric (non-string) notional - JSON numbers lose precision', async () => {
    const { POST } = await import('../route');
    const response = await POST(postRequest({ ...VALID_BODY, notional: 1.5 }));
    expect(response.status).toBe(400);
  });

  it('passes through the upstream risk service rejection (e.g. unsupported horizon)', async () => {
    vi.stubGlobal('fetch', mockUpstream(422, { detail: 'horizon_days=3 is not supported' }));
    const { POST } = await import('../route');
    const response = await POST(postRequest({ ...VALID_BODY, horizonDays: 3 }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toContain('not supported');
  });

  it('returns 502 when the risk service is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8001'))
    );
    const { POST } = await import('../route');
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(502);
  });

  it('on success, returns the onchain quote/signature in the shape /api/escrow/create expects', async () => {
    const { POST } = await import('../route');
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.quote).toEqual(UPSTREAM_SUCCESS_BODY.onchain);
    expect(body.signature).toBe(UPSTREAM_SUCCESS_BODY.signature);
    expect(body.riskQuote).toEqual(UPSTREAM_SUCCESS_BODY.quote);
  });

  it('still returns the quote successfully even if persisting it to risk_quotes fails', async () => {
    const dbModule = await import('@/lib/server/db');
    vi.mocked(dbModule.query).mockRejectedValueOnce(new Error('db unreachable'));
    const { POST } = await import('../route');
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });
});
