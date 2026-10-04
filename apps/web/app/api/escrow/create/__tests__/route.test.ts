import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORACLE_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const DEPOSITOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const COUNTERPARTY = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const VALID_ONCHAIN = {
  quoteId: '0x' + 'ab'.repeat(32),
  depositor: DEPOSITOR,
  counterparty: COUNTERPARTY,
  settlementAsset: ZERO_ADDRESS,
  notional: '1500000000000000000',
  requiredCollateral: '2000000000000000000',
  quoteExpiration: '99999999999',
  settlementHorizon: '604800',
  modelVersion: 'garch_1_1-v1',
  riskSnapshotHash: '0x' + 'cd'.repeat(32),
};
const VALID_SIGNATURE = '0x' + 'ef'.repeat(65);

function issuedRow(overrides: Record<string, unknown> = {}) {
  return {
    quote_id: VALID_ONCHAIN.quoteId,
    chain_id: '80002',
    verifying_contract: ZERO_ADDRESS, // overwritten per-test to match ACTIVE_CHAIN/RISK_ESCROW_ADDRESS as needed
    onchain: { ...VALID_ONCHAIN },
    signature: VALID_SIGNATURE,
    quote_expiration: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const dbMocks = vi.hoisted(() => ({ queryOne: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/server/db', () => dbMocks);

const chainMocks = vi.hoisted(() => ({ readContract: vi.fn() }));
vi.mock('@/lib/server/chain', () => ({ publicClient: chainMocks }));

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/escrow/create', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/escrow/create', () => {
  let activeChainId: number;
  let riskEscrowAddress: string;

  beforeEach(async () => {
    const { ACTIVE_CHAIN, RISK_ESCROW_ADDRESS } = await import('@/lib/chain/config');
    activeChainId = ACTIVE_CHAIN.id;
    riskEscrowAddress = RISK_ESCROW_ADDRESS;

    chainMocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'recoverRiskQuoteSigner') return ORACLE_ADDRESS;
      if (functionName === 'riskOracle') return ORACLE_ADDRESS;
      if (functionName === 'usedQuotes') return false;
      throw new Error(`unexpected functionName ${functionName}`);
    });
    dbMocks.queryOne.mockResolvedValue(
      issuedRow({ chain_id: String(activeChainId), verifying_contract: riskEscrowAddress })
    );
    dbMocks.query.mockResolvedValue([{ id: 'payment-1' }]);
  });
  afterEach(() => vi.clearAllMocks());

  it('rejects a request missing quote/signature', async () => {
    const { POST } = await import('../route');
    const response = await POST(postRequest({}));
    expect(response.status).toBe(400);
  });

  it('rejects an incomplete quote (missing a required field)', async () => {
    const { POST } = await import('../route');
    const incomplete = { ...VALID_ONCHAIN } as Record<string, unknown>;
    delete incomplete.riskSnapshotHash;
    const response = await POST(postRequest({ quote: incomplete, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('riskSnapshotHash');
  });

  it('rejects a quote with no matching risk_quotes row (unknown quote)', async () => {
    dbMocks.queryOne.mockResolvedValue(null);
    const { POST } = await import('../route');
    const response = await POST(postRequest({ quote: VALID_ONCHAIN, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Unknown quote');
  });

  it('rejects a quote tampered with after issuance (field mismatch against the issued row)', async () => {
    const { POST } = await import('../route');
    const tampered = { ...VALID_ONCHAIN, notional: '999999999999999999999' };
    const response = await POST(postRequest({ quote: tampered, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('notional');
  });

  it('rejects a signature that does not match the issued signature', async () => {
    const { POST } = await import('../route');
    const response = await POST(postRequest({ quote: VALID_ONCHAIN, signature: '0x' + '00'.repeat(65) }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Signature');
  });

  it('rejects a quote issued for a different chain/contract', async () => {
    dbMocks.queryOne.mockResolvedValue(issuedRow({ chain_id: '1', verifying_contract: riskEscrowAddress }));
    const { POST } = await import('../route');
    const response = await POST(postRequest({ quote: VALID_ONCHAIN, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('different chain');
  });

  it('rejects an expired quote', async () => {
    dbMocks.queryOne.mockResolvedValue(
      issuedRow({
        chain_id: String(activeChainId),
        verifying_contract: riskEscrowAddress,
        quote_expiration: '2000-01-01T00:00:00.000Z',
      })
    );
    const { POST } = await import('../route');
    const response = await POST(postRequest({ quote: VALID_ONCHAIN, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('expired');
  });

  it('rejects when the recovered signer does not match the on-chain risk oracle', async () => {
    chainMocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'recoverRiskQuoteSigner') return '0x000000000000000000000000000000000000dEaD';
      if (functionName === 'riskOracle') return ORACLE_ADDRESS;
      if (functionName === 'usedQuotes') return false;
      throw new Error('unexpected');
    });
    const { POST } = await import('../route');
    const response = await POST(postRequest({ quote: VALID_ONCHAIN, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('risk oracle');
  });

  it('rejects a quote that has already been used on-chain (usedQuotes true)', async () => {
    chainMocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'recoverRiskQuoteSigner') return ORACLE_ADDRESS;
      if (functionName === 'riskOracle') return ORACLE_ADDRESS;
      if (functionName === 'usedQuotes') return true;
      throw new Error('unexpected');
    });
    const { POST } = await import('../route');
    const response = await POST(postRequest({ quote: VALID_ONCHAIN, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('already been used');
  });

  it('returns 503 (not 500) when the chain is unreachable during verification', async () => {
    chainMocks.readContract.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { POST } = await import('../route');
    const response = await POST(postRequest({ quote: VALID_ONCHAIN, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(503);
  });

  it('returns a clean 409 (not a raw DB error) on a duplicate escrow for the same quote', async () => {
    dbMocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM risk_quotes')) {
        return issuedRow({ chain_id: String(activeChainId), verifying_contract: riskEscrowAddress });
      }
      const error = new Error('duplicate key value violates unique constraint') as Error & { code: string };
      error.code = '23505';
      throw error;
    });
    const { POST } = await import('../route');
    const response = await POST(postRequest({ quote: VALID_ONCHAIN, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('already exists');
  });

  it('on success, returns a contractConfig with createEscrow args and the correct native value', async () => {
    dbMocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM risk_quotes')) {
        return issuedRow({ chain_id: String(activeChainId), verifying_contract: riskEscrowAddress });
      }
      return { id: 'escrow-1' };
    });
    const { POST } = await import('../route');
    const response = await POST(postRequest({ quote: VALID_ONCHAIN, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.contractConfig.functionName).toBe('createEscrow');
    expect(body.contractConfig.value).toBe(VALID_ONCHAIN.requiredCollateral); // native settlement
    expect(body.contractConfig.args[0].quoteId).toBe(VALID_ONCHAIN.quoteId);
  });

  it('uses msg.value = 0 for an ERC-20 settlement asset', async () => {
    const erc20Address = '0x1111111111111111111111111111111111111111';
    const erc20Onchain = { ...VALID_ONCHAIN, settlementAsset: erc20Address };
    dbMocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM risk_quotes')) {
        return issuedRow({
          chain_id: String(activeChainId),
          verifying_contract: riskEscrowAddress,
          onchain: erc20Onchain,
        });
      }
      return { id: 'escrow-2' };
    });
    const { POST } = await import('../route');
    const response = await POST(postRequest({ quote: erc20Onchain, signature: VALID_SIGNATURE }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.contractConfig.value).toBe('0');
  });
});
