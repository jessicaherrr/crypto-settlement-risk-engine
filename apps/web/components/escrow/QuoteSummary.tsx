'use client';

import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import type { SettlementAsset } from '@/lib/chain/assets';
import { fromOnchainString, fromPythonDecimal } from '@/lib/format/sources';
import { formatFixed } from '@/lib/format/decimal';
import { formatTokenAmount } from '@/lib/format/money';
import { formatFraction } from '@/lib/format/percent';
import { formatDuration, remaining } from '@/lib/format/time';
import type { IssuedQuote } from '@/lib/escrow/newEscrowMachine';

/** The quote-review panel shown before the wallet is asked to sign
 * anything - makes `notional + buffer = required collateral` visually
 * explicit (required collateral can exceed notional, and this is
 * deliberately not hidden), plus the risk figures that justified it and
 * a live countdown to expiry. */
export function QuoteSummary({ issued, asset }: { issued: IssuedQuote; asset: SettlementAsset }) {
  const { quote, riskQuote } = issued;
  const [secondsLeft, setSecondsLeft] = useState(() => remaining(new Date(Number(quote.quoteExpiration) * 1000)).seconds);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft(remaining(new Date(Number(quote.quoteExpiration) * 1000)).seconds);
    }, 1000);
    return () => clearInterval(interval);
  }, [quote.quoteExpiration]);

  const notional = fromOnchainString(quote.notional, asset.decimals);
  const required = fromOnchainString(quote.requiredCollateral, asset.decimals);
  const buffer = { value: required.value - notional.value, decimals: asset.decimals };
  const expired = secondsLeft <= 0;

  const horizonDays = String(riskQuote.settlement_horizon_days ?? '');
  const modelVersion = String(riskQuote.model_version ?? '');
  const valueAtRisk = typeof riskQuote.value_at_risk === 'string' ? riskQuote.value_at_risk : null;
  const expectedShortfall = typeof riskQuote.expected_shortfall === 'string' ? riskQuote.expected_shortfall : null;
  const stressLoss = typeof riskQuote.stress_loss === 'string' ? riskQuote.stress_loss : null;
  const spotUsd = typeof riskQuote.spot_price_usd === 'string' ? riskQuote.spot_price_usd : null;

  return (
    <div className="space-y-5 rounded-lg border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Review before you sign</h3>
        <Badge tone={expired ? 'critical' : secondsLeft < 60 ? 'warning' : 'neutral'}>
          {expired ? 'Quote expired' : `Expires in ${formatDuration(secondsLeft)}`}
        </Badge>
      </div>

      <div className="flex flex-wrap items-baseline gap-2 font-mono text-lg">
        <span className="text-slate-200">{formatTokenAmount(notional, { symbol: asset.symbol })}</span>
        <span className="text-sm text-slate-500">notional</span>
        <span className="text-slate-500">+</span>
        <span className="text-status-warning">{formatTokenAmount(buffer, { symbol: asset.symbol })}</span>
        <span className="text-sm text-slate-500">buffer</span>
        <span className="text-slate-500">=</span>
        <span className="font-semibold text-slate-100">{formatTokenAmount(required, { symbol: asset.symbol })}</span>
        <span className="text-sm text-slate-500">required collateral</span>
      </div>

      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-slate-500">Value at Risk</dt>
          <dd className="font-mono text-slate-200">{valueAtRisk ? formatFraction(valueAtRisk) : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Expected Shortfall</dt>
          <dd className="font-mono text-slate-200">{expectedShortfall ? formatFraction(expectedShortfall) : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Worst stress loss</dt>
          <dd className="font-mono text-slate-200">{stressLoss ? formatFraction(stressLoss) : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Settlement horizon</dt>
          <dd className="font-mono text-slate-200">{horizonDays}d</dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
        <span>Model: {modelVersion}</span>
        {spotUsd ? (
          <span>Spot: {formatFixed(fromPythonDecimal(spotUsd, 2), { minFrac: 2, maxFrac: 2 })} USD</span>
        ) : null}
        <span>Quote ID: {quote.quoteId.slice(0, 10)}…{quote.quoteId.slice(-6)}</span>
      </div>
    </div>
  );
}
