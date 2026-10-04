/**
 * Bigint-safe fixed-point arithmetic and formatting - the foundation
 * every other module in `lib/format/` builds on.
 *
 * The rule this whole directory exists to enforce: a financial or
 * on-chain amount is never converted through `Number()`. A `number` can't
 * exactly represent a uint256, and JS floats silently lose precision on
 * ordinary-looking decimal amounts well below that (`0.1 + 0.2 !== 0.3`).
 * Every amount is represented as a `Fixed` - a `bigint` plus the decimal
 * exponent it's scaled by - from the moment it enters this app
 * (`lib/format/sources.ts`) until it's rendered as a string.
 *
 * Scope: every function here assumes non-negative magnitudes. Every real
 * amount this app handles - uint256 token amounts, VaR/ES/stress loss
 * fractions, collateral ratios, spot prices - is non-negative; `floor`/
 * `ceil` are defined as "toward zero" / "away from zero if there's a
 * remainder" rather than the signed number-line versions, which would
 * otherwise flip at negative values and this module simply doesn't need
 * to support.
 */

export type RoundingMode = 'floor' | 'ceil' | 'halfUp';

export interface Fixed {
  readonly value: bigint;
  readonly decimals: number;
}

const DECIMAL_STRING_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Parses a plain decimal string (e.g. "10.5", never "1e5" or "NaN")
 * into a `Fixed` at `decimals` precision, rounding any excess fractional
 * digits with `rounding` (default: truncate). */
export function parseDecimalString(
  input: string,
  decimals: number,
  opts: { rounding?: RoundingMode } = {}
): Fixed {
  const trimmed = input.trim();
  const match = DECIMAL_STRING_RE.exec(trimmed);
  if (!match) {
    throw new Error(`not a valid decimal string: ${JSON.stringify(input)}`);
  }
  const [, sign, intPartRaw, fracPartRaw = ''] = match;
  const rounding = opts.rounding ?? 'floor';

  let fracPart: string;
  let carry: bigint;
  if (fracPartRaw.length > decimals) {
    fracPart = fracPartRaw.slice(0, decimals);
    carry = roundCarry(fracPartRaw.slice(decimals), rounding);
  } else {
    fracPart = fracPartRaw.padEnd(decimals, '0');
    carry = 0n;
  }

  let magnitude = BigInt(intPartRaw + fracPart) + carry;
  if (sign === '-') magnitude = -magnitude;
  return { value: magnitude, decimals };
}

const INTEGER_STRING_RE = /^-?\d+$/;

/** Wraps an already-scaled integer (uint256 base-units string or bigint,
 * e.g. wei) as a `Fixed` at `decimals` - no parsing of a decimal point,
 * since base-units values never have one. */
export function fromBaseUnits(raw: bigint | string, decimals: number): Fixed {
  if (typeof raw === 'bigint') return { value: raw, decimals };
  const trimmed = raw.trim();
  if (!INTEGER_STRING_RE.test(trimmed)) {
    throw new Error(`not a valid integer base-units string: ${JSON.stringify(raw)}`);
  }
  return { value: BigInt(trimmed), decimals };
}

export function toBaseUnits(fixed: Fixed): bigint {
  return fixed.value;
}

function roundCarry(droppedDigits: string, rounding: RoundingMode): bigint {
  if (droppedDigits.length === 0 || !/[1-9]/.test(droppedDigits)) return 0n; // exact - nothing dropped
  if (rounding === 'floor') return 0n;
  if (rounding === 'ceil') return 1n;
  const firstDropped = droppedDigits.charCodeAt(0) - 48;
  return firstDropped >= 5 ? 1n : 0n; // halfUp
}

function divRound(numerator: bigint, denominator: bigint, rounding: RoundingMode): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  if (rounding === 'floor') return quotient;
  if (rounding === 'ceil') return quotient + 1n;
  return remainder * 2n >= denominator ? quotient + 1n : quotient; // halfUp
}

function rescale(value: bigint, fromDecimals: number, toDecimals: number, rounding: RoundingMode): Fixed {
  if (toDecimals === fromDecimals) return { value, decimals: toDecimals };
  if (toDecimals > fromDecimals) {
    return { value: value * 10n ** BigInt(toDecimals - fromDecimals), decimals: toDecimals };
  }
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  return { value: divRound(value, divisor, rounding), decimals: toDecimals };
}

/** `a * b`, rescaled to `outDecimals`. The two operands may have
 * different `decimals` (e.g. an 18-decimal token amount times a
 * dimensionless 6-decimal ratio). */
export function mulFixed(a: Fixed, b: Fixed, outDecimals: number, rounding: RoundingMode = 'floor'): Fixed {
  const product = a.value * b.value;
  return rescale(product, a.decimals + b.decimals, outDecimals, rounding);
}

/** `a / b`, rescaled to `outDecimals`. */
export function divFixed(a: Fixed, b: Fixed, outDecimals: number, rounding: RoundingMode = 'floor'): Fixed {
  if (b.value === 0n) throw new Error('divFixed: division by zero');
  const shift = outDecimals + b.decimals - a.decimals;
  const numerator = shift >= 0 ? a.value * 10n ** BigInt(shift) : a.value;
  const denominator = shift >= 0 ? b.value : b.value * 10n ** BigInt(-shift);
  return { value: divRound(numerator, denominator, rounding), decimals: outDecimals };
}

/** Renders a `Fixed` as a plain decimal string: thousands separators by
 * default, at least `minFrac` and at most `maxFrac` fractional digits
 * (display-only rounding - never mutates the underlying value). */
export function formatFixed(
  fixed: Fixed,
  opts: { minFrac?: number; maxFrac?: number; grouping?: boolean } = {}
): string {
  const { minFrac = 0, maxFrac = fixed.decimals, grouping = true } = opts;
  if (maxFrac < minFrac) {
    throw new Error(`formatFixed: maxFrac (${maxFrac}) must be >= minFrac (${minFrac})`);
  }

  const negative = fixed.value < 0n;
  const absValue = negative ? -fixed.value : fixed.value;
  const digits = absValue.toString().padStart(fixed.decimals + 1, '0');
  let intPart = digits.slice(0, digits.length - fixed.decimals) || '0';
  let fracPart = fixed.decimals > 0 ? digits.slice(digits.length - fixed.decimals) : '';

  if (fracPart.length > maxFrac) {
    const kept = fracPart.slice(0, maxFrac);
    const nextDigit = fracPart.charCodeAt(maxFrac) - 48;
    let keptValue = maxFrac > 0 ? BigInt(kept) : 0n;
    if (nextDigit >= 5) {
      keptValue += 1n;
      const overflow = 10n ** BigInt(maxFrac);
      if (keptValue >= overflow) {
        keptValue -= overflow;
        intPart = (BigInt(intPart) + 1n).toString();
      }
    }
    fracPart = maxFrac > 0 ? keptValue.toString().padStart(maxFrac, '0') : '';
  }

  while (fracPart.length > minFrac && fracPart.endsWith('0')) {
    fracPart = fracPart.slice(0, -1);
  }
  if (fracPart.length < minFrac) {
    fracPart = fracPart.padEnd(minFrac, '0');
  }

  const groupedInt = grouping ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
  const sign = negative && (intPart !== '0' || /[1-9]/.test(fracPart)) ? '-' : '';
  return fracPart.length > 0 ? `${sign}${groupedInt}.${fracPart}` : `${sign}${groupedInt}`;
}
