/** Formats an ISO timestamp (or `Date`) as a plain UTC string, e.g.
 * "2026-10-03 14:05 UTC". Dates/times on this dashboard are always shown
 * in UTC - the chain, the risk-oracle service, and Postgres all operate
 * in UTC, and converting to the viewer's local time would make a shown
 * quote-expiration or settlement-deadline harder to cross-check against
 * those systems, not easier. */
export function formatUtc(input: string | Date): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  const iso = date.toISOString(); // "2026-10-03T14:05:32.123Z"
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Formats a non-negative duration in seconds as "1d 4h 32m" (smallest
 * unit "Xs" only if the whole duration is under a minute). */
export function formatDuration(totalSeconds: bigint | number): string {
  let seconds = typeof totalSeconds === 'bigint' ? totalSeconds : BigInt(Math.trunc(totalSeconds));
  const negative = seconds < 0n;
  if (negative) seconds = -seconds;

  const days = seconds / 86_400n;
  seconds %= 86_400n;
  const hours = seconds / 3_600n;
  seconds %= 3_600n;
  const minutes = seconds / 60n;
  seconds %= 60n;

  const parts: string[] = [];
  if (days > 0n) parts.push(`${days}d`);
  if (days > 0n || hours > 0n) parts.push(`${hours}h`);
  if (days > 0n || hours > 0n || minutes > 0n) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);

  return `${negative ? '-' : ''}${parts.join(' ')}`;
}

/** Seconds remaining until `expiry` (negative once past), and whether
 * it's already expired. */
export function remaining(expiry: string | Date, now: Date = new Date()): { seconds: number; expired: boolean } {
  const expiryDate = typeof expiry === 'string' ? new Date(expiry) : expiry;
  const seconds = Math.floor((expiryDate.getTime() - now.getTime()) / 1000);
  return { seconds, expired: seconds <= 0 };
}
