import { describe, expect, it } from 'vitest';

import {
  divFixed,
  formatFixed,
  fromBaseUnits,
  mulFixed,
  parseDecimalString,
  toBaseUnits,
} from '../decimal';

describe('parseDecimalString', () => {
  it('parses a plain decimal string at the given precision', () => {
    expect(parseDecimalString('10.5', 18)).toEqual({ value: 10_500000000000000000n, decimals: 18 });
  });

  it('round-trips the maximum uint256 value as base units', () => {
    const max = (2n ** 256n - 1n).toString();
    const fixed = fromBaseUnits(max, 18);
    expect(toBaseUnits(fixed).toString()).toBe(max);
  });

  it('pads a short fractional part', () => {
    expect(parseDecimalString('1.5', 6)).toEqual({ value: 1_500000n, decimals: 6 });
  });

  it('handles an integer with no decimal point', () => {
    expect(parseDecimalString('42', 2)).toEqual({ value: 4200n, decimals: 2 });
  });

  it('handles a negative value', () => {
    expect(parseDecimalString('-1.5', 2)).toEqual({ value: -150n, decimals: 2 });
  });

  it.each([
    ['1e18'],
    ['NaN'],
    ['1 1'], // embedded whitespace is not trimmed (only leading/trailing is)
    ['1.'],
    ['.5'],
    [''],
    ['1,000'],
    ['Infinity'],
  ])('rejects %j', (input) => {
    expect(() => parseDecimalString(input, 18)).toThrow();
  });

  it('accepts a value with surrounding whitespace trimmed', () => {
    expect(parseDecimalString('  10.5  ', 2)).toEqual({ value: 1050n, decimals: 2 });
  });

  describe('rounding excess fractional digits', () => {
    it('floor truncates toward zero (default)', () => {
      expect(parseDecimalString('1.999', 2)).toEqual({ value: 199n, decimals: 2 });
    });

    it('ceil rounds away from zero on any nonzero remainder', () => {
      expect(parseDecimalString('1.991', 2, { rounding: 'ceil' })).toEqual({ value: 200n, decimals: 2 });
    });

    it('ceil does not round up an exact value', () => {
      expect(parseDecimalString('1.990', 2, { rounding: 'ceil' })).toEqual({ value: 199n, decimals: 2 });
    });

    it('halfUp rounds .5 up', () => {
      expect(parseDecimalString('1.995', 2, { rounding: 'halfUp' })).toEqual({ value: 200n, decimals: 2 });
    });

    it('halfUp rounds .4 down', () => {
      expect(parseDecimalString('1.994', 2, { rounding: 'halfUp' })).toEqual({ value: 199n, decimals: 2 });
    });

    it('ceil carries into the integer part', () => {
      expect(parseDecimalString('1.999', 2, { rounding: 'ceil' })).toEqual({ value: 200n, decimals: 2 });
    });
  });
});

describe('mulFixed / divFixed', () => {
  it('multiplies two Fixed amounts with different decimals', () => {
    // 10 (18-decimal token amount) * 0.1834 (6-decimal fraction) = 1.834, at 18 decimals
    const amount = fromBaseUnits('10000000000000000000', 18); // 10
    const fraction = parseDecimalString('0.1834', 6);
    const result = mulFixed(amount, fraction, 18);
    expect(formatFixed(result, { maxFrac: 4 })).toBe('1.834');
  });

  it('divides two Fixed amounts', () => {
    const a = parseDecimalString('10', 2);
    const b = parseDecimalString('4', 2);
    expect(formatFixed(divFixed(a, b, 2))).toBe('2.5');
  });

  it('divFixed throws on division by zero', () => {
    const a = parseDecimalString('10', 2);
    const zero = parseDecimalString('0', 2);
    expect(() => divFixed(a, zero, 2)).toThrow();
  });
});

describe('formatFixed', () => {
  it('formats with grouping by default', () => {
    expect(formatFixed(parseDecimalString('1234567.89', 2))).toBe('1,234,567.89');
  });

  it('can disable grouping', () => {
    expect(formatFixed(parseDecimalString('1234567.89', 2), { grouping: false })).toBe('1234567.89');
  });

  it('trims trailing zeros down to minFrac', () => {
    expect(formatFixed(parseDecimalString('1.500000', 6), { minFrac: 0 })).toBe('1.5');
  });

  it('never trims below minFrac', () => {
    expect(formatFixed(parseDecimalString('1', 6), { minFrac: 2 })).toBe('1.00');
  });

  it('rounds for display without mutating the value (half-up)', () => {
    const fixed = parseDecimalString('1.999', 6);
    expect(formatFixed(fixed, { minFrac: 2, maxFrac: 2 })).toBe('2.00');
    expect(fixed.value).toBe(1_999000n); // underlying value untouched
  });

  it('formats a negative value', () => {
    expect(formatFixed(parseDecimalString('-42.5', 2))).toBe('-42.5');
  });

  it('formats zero without a sign', () => {
    expect(formatFixed(parseDecimalString('0', 2))).toBe('0');
  });

  it('formats the full uint256 range without precision loss', () => {
    const rawMax = 2n ** 256n - 1n;
    const max = fromBaseUnits(rawMax.toString(), 18);
    // maxFrac === decimals means no rounding is triggered - round-tripping
    // the formatted string back to base units must reproduce rawMax exactly.
    const text = formatFixed(max, { maxFrac: 18, grouping: false });
    const [intPart, fracPart] = text.split('.');
    expect(BigInt(intPart) * 10n ** 18n + BigInt(fracPart)).toBe(rawMax);
  });
});
