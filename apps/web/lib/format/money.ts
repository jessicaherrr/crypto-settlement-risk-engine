import { type Fixed, formatFixed, mulFixed } from './decimal';

/** Renders a token/asset amount, e.g. "15.183271 ETH". `maxFrac` defaults
 * to 6 - enough to distinguish real amounts without printing all 18
 * decimals of wei precision on screen. */
export function formatTokenAmount(amount: Fixed, opts: { symbol?: string; maxFrac?: number } = {}): string {
  const { symbol, maxFrac = 6 } = opts;
  const text = formatFixed(amount, { maxFrac });
  return symbol ? `${text} ${symbol}` : text;
}

/** `amount * spotUsd`, as a 2-decimal USD `Fixed` - e.g. an asset amount
 * times its spot price. Rounds half-up at the cent, matching how the
 * risk-oracle service itself rounds display amounts. */
export function toUsd(amount: Fixed, spotUsd: Fixed): Fixed {
  return mulFixed(amount, spotUsd, 2, 'halfUp');
}

export function formatUsd(amount: Fixed): string {
  return `$${formatFixed(amount, { minFrac: 2, maxFrac: 2 })}`;
}
