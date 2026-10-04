import { CollateralBasisChart, type CollateralBasisPoint } from '@/components/charts/CollateralBasisChart';
import { ChartFrame } from '@/components/charts/ChartFrame';
import { VolatilityHistoryChart } from '@/components/charts/VolatilityHistoryChart';
import { CollateralFormulaExplainer } from '@/components/risk/CollateralFormulaExplainer';
import { HorizonMetricsTable } from '@/components/risk/HorizonMetricsTable';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { parseDecimalString } from '@/lib/format/decimal';
import { formatUsd } from '@/lib/format/money';
import { formatPercentNumber } from '@/lib/format/percent';
import { formatUtc } from '@/lib/format/time';
import { getGarchView, getRiskSnapshot } from '@/lib/server/risk-service';

export const dynamic = 'force-dynamic';

const CONFIDENCE = 0.99;

export default async function RiskPage() {
  const [garch, snapshot] = await Promise.all([getGarchView(), getRiskSnapshot(CONFIDENCE)]);

  const spot = formatUsd(parseDecimalString(snapshot.spot_price_usd, 8));
  // Chart coordinates only (never the displayed/authoritative figures,
  // which go through HorizonMetricsTable's bigint-safe formatting) - a
  // plain Number() here only affects where a bar is drawn, not what's
  // reported as the risk figure.
  const collateralBasisData: CollateralBasisPoint[] = snapshot.horizons.map((h) => ({
    horizonLabel: `${h.horizon_days}d`,
    expectedShortfall: Number(h.expected_shortfall),
    stressLoss: Number(h.stress_loss),
  }));

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-10 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">Risk</h1>
        <p className="mt-1 text-sm text-slate-400">
          Current ETH/USD volatility and the collateral the risk engine would require for an escrow opened
          right now, at a {formatPercentNumber(CONFIDENCE, 0)} confidence level.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-6 rounded-lg border border-slate-800 bg-slate-900 p-6 sm:grid-cols-4">
        <Stat label="ETH spot" value={spot} />
        <Stat label="Current volatility" value={formatPercentNumber(garch.current_vol_annualized)} sublabel="annualized, GARCH(1,1)" />
        <Stat label="Long-run volatility" value={garch.long_run_vol_annualized !== null ? formatPercentNumber(garch.long_run_vol_annualized) : '—'} sublabel="unconditional" />
        <Stat
          label="Persistence"
          value={garch.persistence.toFixed(3)}
          sublabel={garch.half_life_days !== null ? `${garch.half_life_days.toFixed(0)}d shock half-life` : 'near-integrated'}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Risk and collateral by settlement horizon</CardTitle>
          <CardDescription>
            Per 1 unit of notional. A real escrow&apos;s collateral is priced for its actual notional when you
            request a quote.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HorizonMetricsTable horizons={snapshot.horizons} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How the collateral requirement is built</CardTitle>
          <CardDescription>required collateral = notional + buffer, where the buffer is sized off Expected Shortfall or the worst stress scenario, whichever is larger.</CardDescription>
        </CardHeader>
        <CardContent>
          <CollateralFormulaExplainer horizons={snapshot.horizons} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartFrame
          title="Volatility, last 12 months"
          description="GARCH-filtered conditional volatility vs. 30-day realized volatility, annualized."
          source={`Model: ${garch.params ? 'garch_1_1' : ''} · refit every ${garch.refit_frequency} observations · fit ${formatUtc(garch.fit_timestamp)}`}
        >
          <VolatilityHistoryChart data={garch.vol_history} />
        </ChartFrame>

        <ChartFrame
          title="Collateral basis by horizon"
          description="Expected Shortfall vs. the worst stress-test loss - the policy takes whichever is larger."
          source="Source: /v1/risk/snapshot"
        >
          <CollateralBasisChart data={collateralBasisData} />
        </ChartFrame>
      </div>

      <p className="text-xs text-slate-500">
        Figures above are indicative, computed for 1 unit of notional at the moment this page loaded. Starting
        an escrow requests a binding, signed quote priced for your actual notional and horizon - see{' '}
        <span className="text-slate-400">New escrow</span>.
      </p>
    </div>
  );
}
