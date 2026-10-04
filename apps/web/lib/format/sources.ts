/**
 * The three shapes a financial/on-chain amount actually arrives in, each
 * funneled into the same `Fixed` representation (`lib/format/decimal.ts`)
 * so nothing downstream has to know which source it came from:
 *
 *   - the Python risk-oracle service's JSON (`quant/.../service/schemas.py`):
 *     plain decimal strings, e.g. `"0.1834"` for a loss fraction or
 *     `"2669.42"` for spot price - see `fromPythonDecimal`.
 *   - Postgres fixed-point columns (`escrows.notional`, `.required_collateral`,
 *     etc. - VARCHAR, storing the exact base-units integer as text): see
 *     `fromOnchainString`.
 *   - viem reads/writes (contract calls, event logs): already a `bigint`
 *     in base units - see `fromViem`.
 */

import { type Fixed, type RoundingMode, fromBaseUnits, parseDecimalString } from './decimal';

/** A human-readable decimal string from the risk-oracle service (a loss
 * fraction, spot price, collateral ratio, etc. - never base units). */
export function fromPythonDecimal(
  value: string,
  decimals: number,
  opts: { rounding?: RoundingMode } = {}
): Fixed {
  return parseDecimalString(value, decimals, opts);
}

/** A uint256 base-units decimal string - from the Python service's
 * `onchain` struct or a Postgres fixed-point VARCHAR column. Rejects
 * anything with a decimal point: base-units values never have one, and a
 * string that does almost certainly means a human-units value was passed
 * here by mistake. */
export function fromOnchainString(value: string, decimals: number): Fixed {
  return fromBaseUnits(value, decimals);
}

/** A bigint already in base units, as returned by a viem contract read
 * or decoded from an event log. */
export function fromViem(value: bigint, decimals: number): Fixed {
  return { value, decimals };
}

/** Converts to `bigint`, refusing a `number` input unless it's a safe
 * integer - the one place in this module that even looks at `number`,
 * and only to reject the unsafe case loudly instead of truncating
 * silently. Prefer `fromOnchainString`/`fromViem` over this for amounts;
 * this exists for plain integer identifiers (chain IDs, block numbers)
 * that happen to arrive as either a string or a number. */
export function coerceBigInt(value: bigint | string | number): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`coerceBigInt: not a valid integer string: ${JSON.stringify(value)}`);
    }
    return BigInt(trimmed);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `coerceBigInt: ${value} is not a safe integer - pass a string or bigint for amounts that may exceed 2^53`
      );
    }
    return BigInt(value);
  }
  throw new Error(`coerceBigInt: cannot coerce ${typeof value} to bigint`);
}
