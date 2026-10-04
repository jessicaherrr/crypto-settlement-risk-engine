import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const QUOTE_ID = '0x' + 'ab'.repeat(32);
const TX_HASH = '0x' + '11'.repeat(32);

const dbMocks = vi.hoisted(() => ({ queryOne: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/server/db', () => dbMocks);

const chainMocks = vi.hoisted(() => ({ getTransactionReceipt: vi.fn() }));
vi.mock('@/lib/server/chain', () => ({ publicClient: chainMocks }));

const parseEventLogsMock = vi.hoisted(() => vi.fn());
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return { ...actual, parseEventLogs: parseEventLogsMock };
});

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/escrow/update-transaction', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/escrow/update-transaction', () => {
  let riskEscrowAddress: string;

  beforeEach(async () => {
    const { RISK_ESCROW_ADDRESS } = await import('@/lib/chain/config');
    riskEscrowAddress = RISK_ESCROW_ADDRESS;

    dbMocks.queryOne.mockResolvedValue({ id: 'escrow-1', quote_id: QUOTE_ID });
    dbMocks.query.mockResolvedValue([]);
    chainMocks.getTransactionReceipt.mockResolvedValue({
      status: 'success',
      to: riskEscrowAddress,
      logs: [],
    });
    parseEventLogsMock.mockReturnValue([{ args: { quoteId: QUOTE_ID, dealId: 7n } }]);
  });
  afterEach(() => vi.clearAllMocks());

  it('rejects a request missing required fields', async () => {
    const { POST } = await import('../route');
    const response = await POST(postRequest({ escrowId: 'x' }));
    expect(response.status).toBe(400);
  });

  it('404s when the escrow does not exist', async () => {
    dbMocks.queryOne.mockResolvedValue(null);
    const { POST } = await import('../route');
    const response = await POST(postRequest({ escrowId: 'missing', transactionHash: TX_HASH }));
    expect(response.status).toBe(404);
  });

  it('409s when the transaction is not found / not yet mined', async () => {
    chainMocks.getTransactionReceipt.mockRejectedValue(new Error('not found'));
    const { POST } = await import('../route');
    const response = await POST(postRequest({ escrowId: 'escrow-1', transactionHash: TX_HASH }));
    expect(response.status).toBe(409);
  });

  it('rejects a reverted transaction', async () => {
    chainMocks.getTransactionReceipt.mockResolvedValue({ status: 'reverted', to: riskEscrowAddress, logs: [] });
    const { POST } = await import('../route');
    const response = await POST(postRequest({ escrowId: 'escrow-1', transactionHash: TX_HASH }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('reverted');
  });

  it('rejects a transaction that does not target this contract', async () => {
    chainMocks.getTransactionReceipt.mockResolvedValue({
      status: 'success',
      to: '0x1111111111111111111111111111111111111111',
      logs: [],
    });
    const { POST } = await import('../route');
    const response = await POST(postRequest({ escrowId: 'escrow-1', transactionHash: TX_HASH }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('settlement contract');
  });

  it('rejects when no RiskEscrowCreated event matches this escrow’s quote_id', async () => {
    parseEventLogsMock.mockReturnValue([{ args: { quoteId: '0x' + 'ff'.repeat(32), dealId: 9n } }]);
    const { POST } = await import('../route');
    const response = await POST(postRequest({ escrowId: 'escrow-1', transactionHash: TX_HASH }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('RiskEscrowCreated');
  });

  it('never sets status, even on success - only the chain indexer may', async () => {
    const { POST } = await import('../route');
    const response = await POST(postRequest({ escrowId: 'escrow-1', transactionHash: TX_HASH }));
    expect(response.status).toBe(200);
    const [sql] = dbMocks.queryOne.mock.calls[1]; // second call is the UPDATE (first was the SELECT)
    expect(sql).not.toMatch(/status\s*=\s*'active'/i);
    expect(sql).toContain("payment_status = 'confirming'");
  });

  it('on success, records the dealId read from the verified event, not from the request body', async () => {
    const { POST } = await import('../route');
    const response = await POST(
      postRequest({ escrowId: 'escrow-1', transactionHash: TX_HASH, onChainEscrowId: '999999' })
    );
    expect(response.status).toBe(200);
    const [, params] = dbMocks.queryOne.mock.calls[1];
    expect(params).toContain('7'); // from the mocked event's dealId, not the spoofed "999999"
    expect(params).not.toContain('999999');
  });
});
