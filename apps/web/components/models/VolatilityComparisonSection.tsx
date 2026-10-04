import { ChartFrame } from '@/components/charts/ChartFrame';
import { VolForecastComparisonChart } from '@/components/charts/VolForecastComparisonChart';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/Table';
import { formatUtc } from '@/lib/format/time';
import { getVolatilityComparison } from '@/lib/server/risk-service';

const MODEL_LABELS: Record<string, string> = {
  rolling_hist_vol: 'Rolling historical',
  ewma: 'EWMA',
  garch: 'GARCH(1,1)',
};

const MODEL_ORDER = ['rolling_hist_vol', 'ewma', 'garch'];

export async function VolatilityComparisonSection() {
  const comparison = await getVolatilityComparison();
  const entries = MODEL_ORDER.map((key) => ({ key, ...comparison.metrics[key] }));

  const bestRmse = entries.reduce((a, b) => (b.rmse < a.rmse ? b : a));
  const bestQlike = entries.reduce((a, b) => (b.qlike < a.qlike ? b : a));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Volatility model comparison</CardTitle>
        <CardDescription>
          Out-of-sample, walk-forward forecasts against the squared-return proxy, {comparison.oos_start} to{' '}
          {comparison.oos_end} ({comparison.n_oos} observations). Lower is better for both metrics.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-300">
          <span className="text-slate-100">{MODEL_LABELS[bestRmse.key]}</span> achieved the lowest RMSE and{' '}
          <span className="text-slate-100">{MODEL_LABELS[bestQlike.key]}</span> the lowest QLIKE on this
          evaluation sample. This is a historical comparison, not a guarantee either model dominates going
          forward.
        </p>
        <Table>
          <THead>
            <TR>
              <TH>Model</TH>
              <TH numeric>RMSE</TH>
              <TH numeric>QLIKE</TH>
            </TR>
          </THead>
          <TBody>
            {entries.map((entry) => (
              <TR key={entry.key}>
                <TD className="text-slate-100">
                  {MODEL_LABELS[entry.key]}
                  {entry.key === bestRmse.key && entry.key === bestQlike.key ? (
                    <Badge tone="positive" className="ml-2">
                      best on both
                    </Badge>
                  ) : null}
                </TD>
                <TD numeric>
                  {entry.rmse.toFixed(6)}
                  {entry.key === bestRmse.key && entry.key !== bestQlike.key ? (
                    <Badge tone="positive" className="ml-2">
                      lowest
                    </Badge>
                  ) : null}
                </TD>
                <TD numeric>
                  {entry.qlike.toFixed(4)}
                  {entry.key === bestQlike.key && entry.key !== bestRmse.key ? (
                    <Badge tone="positive" className="ml-2">
                      lowest
                    </Badge>
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
        <ChartFrame
          title="Forecast vs. realized volatility"
          source={`Proxy: squared log return · last computed ${formatUtc(comparison.meta.computed_at)}`}
        >
          <VolForecastComparisonChart data={comparison.series} />
        </ChartFrame>
      </CardContent>
    </Card>
  );
}
