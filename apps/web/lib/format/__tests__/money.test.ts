import { describe, expect, it } from 'vitest';

import { parseDecimalString } from '../decimal';
import { formatTokenAmount, formatUsd, toUsd } from '../money';

describe('formatTokenAmount', () => {
  it('formats with a symbol', () => {
    expect(formatTokenAmount(parseDecimalString('15.183271456', 18), { symbol: 'ETH' })).toBe(
      '15.183271 ETH'
    );
  });

  it('formats without a symbol', () => {
    expect(formatTokenAmount(parseDecimalString('15', 18))).toBe('15');
  });
});

describe('toUsd / formatUsd', () => {
  it('converts an asset amount to USD at spot, rounded to the cent', () => {
    const amount = parseDecimalString('2.5', 18); // 2.5 ETH
    const spot = parseDecimalString('2669.42', 2); // $2,669.42
    const usd = toUsd(amount, spot);
    expect(formatUsd(usd)).toBe('$6,673.55');
  });

  it('always shows exactly 2 decimal places', () => {
    const amount = parseDecimalString('1', 18);
    const spot = parseDecimalString('100', 2);
    expect(formatUsd(toUsd(amount, spot))).toBe('$100.00');
  });
});
