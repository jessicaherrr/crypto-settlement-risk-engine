import { describe, expect, it } from 'vitest';

import { formatDuration, formatUtc, remaining } from '../time';

describe('formatUtc', () => {
  it('formats an ISO string as a plain UTC timestamp', () => {
    expect(formatUtc('2026-10-03T14:05:32.123Z')).toBe('2026-10-03 14:05 UTC');
  });

  it('accepts a Date', () => {
    expect(formatUtc(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01 00:00 UTC');
  });
});

describe('formatDuration', () => {
  it('formats days/hours/minutes', () => {
    expect(formatDuration(90000n)).toBe('1d 1h 0m'); // 86400 + 3600
  });

  it('formats under a day', () => {
    expect(formatDuration(3660n)).toBe('1h 1m');
  });

  it('formats under an hour', () => {
    expect(formatDuration(125n)).toBe('2m');
  });

  it('formats under a minute as seconds', () => {
    expect(formatDuration(45n)).toBe('45s');
  });

  it('formats zero', () => {
    expect(formatDuration(0n)).toBe('0s');
  });

  it('accepts a plain number', () => {
    expect(formatDuration(3660)).toBe('1h 1m');
  });

  it('handles a negative duration (already expired)', () => {
    expect(formatDuration(-45n)).toBe('-45s');
  });
});

describe('remaining', () => {
  it('reports positive seconds and not expired when the expiry is in the future', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expiry = '2026-01-01T00:05:00.000Z';
    const result = remaining(expiry, now);
    expect(result.seconds).toBe(300);
    expect(result.expired).toBe(false);
  });

  it('reports expired once the expiry has passed', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const expiry = '2026-01-01T00:05:00.000Z';
    const result = remaining(expiry, now);
    expect(result.seconds).toBeLessThan(0);
    expect(result.expired).toBe(true);
  });

  it('treats the exact expiry instant as expired', () => {
    const now = new Date('2026-01-01T00:05:00.000Z');
    const result = remaining('2026-01-01T00:05:00.000Z', now);
    expect(result.seconds).toBe(0);
    expect(result.expired).toBe(true);
  });
});
