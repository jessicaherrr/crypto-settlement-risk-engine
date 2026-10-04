import { describe, expect, it } from 'vitest';

import { formatFraction, formatPercentNumber } from '../percent';

describe('formatFraction', () => {
  it('converts a loss fraction string to a percent', () => {
    expect(formatFraction('0.1834')).toBe('18.34%');
  });

  it('defaults to 2 digits', () => {
    expect(formatFraction('0.99')).toBe('99.00%');
  });

  it('supports a custom digit count', () => {
    expect(formatFraction('0.1834', 4)).toBe('18.3400%');
  });

  it('handles a fraction greater than 1 (e.g. a collateral buffer)', () => {
    expect(formatFraction('1.5')).toBe('150.00%');
  });

  it('handles zero', () => {
    expect(formatFraction('0')).toBe('0.00%');
  });

  it('never uses a JS float conversion for a small fraction', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; this must still be exact.
    expect(formatFraction('0.0001', 4)).toBe('0.0100%');
  });
});

describe('formatPercentNumber', () => {
  it('formats a plain-number statistical fraction', () => {
    expect(formatPercentNumber(0.1834)).toBe('18.34%');
  });

  it('supports a custom digit count', () => {
    expect(formatPercentNumber(0.1834, 1)).toBe('18.3%');
  });
});
