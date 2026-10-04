import { describe, expect, it } from 'vitest';

import { isSameAddress, shortAddress, shortHash } from '../address';

const ADDR_LOWER = '0x1111111111111111111111111111111111111111';
const ADDR_2 = '0x2222222222222222222222222222222222222222';

describe('shortAddress', () => {
  it('checksums and truncates a valid address', () => {
    expect(shortAddress(ADDR_LOWER)).toBe('0x1111…1111');
  });

  it('returns the input unchanged if not a valid address', () => {
    expect(shortAddress('not-an-address')).toBe('not-an-address');
  });

  it('supports a custom character count', () => {
    expect(shortAddress(ADDR_LOWER, { chars: 6 })).toBe('0x111111…111111');
  });
});

describe('isSameAddress', () => {
  it('matches the same address regardless of case', () => {
    expect(isSameAddress(ADDR_LOWER, ADDR_LOWER.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('rejects different addresses', () => {
    expect(isSameAddress(ADDR_LOWER, ADDR_2)).toBe(false);
  });

  it('rejects an invalid address on either side', () => {
    expect(isSameAddress(ADDR_LOWER, 'not-an-address')).toBe(false);
  });
});

describe('shortHash', () => {
  it('matches the expected truncated shape', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const result = shortHash(hash);
    expect(result.startsWith('0xababab')).toBe(true);
    expect(result.endsWith('ababab')).toBe(true);
    expect(result).toContain('…');
  });

  it('returns a short, non-hash string unchanged', () => {
    expect(shortHash('short')).toBe('short');
  });
});
