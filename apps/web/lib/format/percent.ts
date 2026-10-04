import { type Fixed, formatFixed, parseDecimalString } from './decimal';

/** Converts a fraction (e.g. 0.1834) to the same magnitude expressed as a
 * percent (18.34), via a pure decimal-exponent shift - no multiplication,
 * so it's exact regardless of how many decimals the input has. */
function toPercentFixed(fraction: Fixed): Fixed {
  if (fraction.decimals >= 2) {
    return { value: fraction.value, decimals: fraction.decimals - 2 };
  }
  return { value: fraction.value * 10n ** BigInt(2 - fraction.decimals), decimals: 0 };
}

/** Formats a loss/ratio *fraction* (not already a percent) as a percent
 * string, e.g. `formatFraction("0.1834")` -> `"18.34%"`. Accepts either a
 * raw decimal string (as the risk-oracle service returns VaR/ES/stress
 * fractions) or an already-parsed `Fixed`. Never goes through a JS
 * `number` - see `lib/format/decimal.ts`'s module docstring for why that
 * matters for a quantity this small and this consequential. */
export function formatFraction(input: string | Fixed, digits = 2): string {
  const fraction = typeof input === 'string' ? parseDecimalString(input, Math.max(digits + 6, 8)) : input;
  const percent = toPercentFixed(fraction);
  return `${formatFixed(percent, { minFrac: digits, maxFrac: digits })}%`;
}

/** Formats a plain JS `number` fraction as a percent - for statistical
 * floats (a Monte Carlo stress-scenario loss fraction, RMSE, a p-value)
 * that were never a Decimal/on-chain quantity to begin with, so going
 * through `Number` lost nothing `formatFraction`'s bigint path would
 * have preserved. Do not use this for VaR/ES/collateral figures - those
 * arrive as decimal strings specifically so they stay exact; use
 * `formatFraction` for those instead. */
export function formatPercentNumber(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}
