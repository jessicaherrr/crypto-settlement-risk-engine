import { describe, expect, it } from 'vitest';

import { coerceBigInt, fromOnchainString, fromPythonDecimal, fromViem } from '../sources';

describe('fromPythonDecimal', () => {
  it('parses a decimal fraction string', () => {
    expect(fromPythonDecimal('0.1834', 6)).toEqual({ value: 183400n, decimals: 6 });
  });
});

describe('fromOnchainString', () => {
  it('parses a base-units integer string', () => {
    expect(fromOnchainString('15000000000000000000', 18)).toEqual({
      value: 15_000000000000000000n,
      decimals: 18,
    });
  });

  it('rejects a value with a decimal point - base units never have one', () => {
    expect(() => fromOnchainString('15.5', 18)).toThrow();
  });
});

describe('fromViem', () => {
  it('wraps a bigint as-is', () => {
    expect(fromViem(123n, 18)).toEqual({ value: 123n, decimals: 18 });
  });
});

describe('coerceBigInt', () => {
  it('passes a bigint through', () => {
    expect(coerceBigInt(5n)).toBe(5n);
  });

  it('parses an integer string', () => {
    expect(coerceBigInt('31337')).toBe(31337n);
  });

  it('accepts a safe-integer number', () => {
    expect(coerceBigInt(80002)).toBe(80002n);
  });

  it('rejects an unsafe number', () => {
    expect(() => coerceBigInt(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it('rejects a non-integer string', () => {
    expect(() => coerceBigInt('1.5')).toThrow();
  });
});
