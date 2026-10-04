import { ChartFrame } from '@/components/charts/ChartFrame';
import { TailComparisonChart, type TailComparisonPoint } from '@/components/charts/TailComparisonChart';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/Table';
import { formatFraction } from '@/lib/format/percent';
import { getTailComparison } from '@/lib/server/risk-service';

const METHOD_LABELS: Record<string, string> = {
  historical_simulation: 'Historical simulation',
  filtered_historical_simulation: 'Filtered historical (live quotes)',
  gbm_monte_carlo: 'GBM benchmark',
};

export async function TailComparisonSection() {
  const comparison = await getTailComparison();
  const horizons = Array.from(new Set(comparison.rows.map((r) => r.horizon_days))).sort((a, b) => a - b);

  const primaryConfidenceKey = Object.keys(comparison.rows[0]?.expected_shortfall ?? {}).sort().at(-1) ?? '0.9900';

  const chartData: TailComparisonPoint[] = horizons.map((horizonDays) => {
    const byMethod = (method: string) =>
      Number(comparison.rows.find((r) => r.horizon_days === horizonDays && r.method === method)?.expected_shortfall[primaryConfidenceKey] ?? '0');
    return {
      horizonLabel: `${horizonDays}d`,
      historical: byMethod('historical_simulation'),
      filteredHistorical: byMethod('filtered_historical_simulation'),
      gbm: byMethod('gbm_monte_carlo'),
    };
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tail risk by simulation method</CardTitle>
        <CardDescription>
          Expected Shortfall at {(Number(primaryConfidenceKey) * 100).toFixed(0)}% confidence, by horizon and
          method ({comparison.n_scenarios.toLocaleString()} scenarios each). Live quotes always use filtered
          historical simulation; historical and GBM are shown for comparison.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <THead>
            <TR>
              <TH>Horizon</TH>
              <TH>Method</TH>
              <TH numeric>Expected Shortfall</TH>
              <TH numeric>Volatility used</TH>
            </TR>
          </THead>
          <TBody>
            {comparison.rows.map((row) => (
              <TR key={`${row.horizon_days}-${row.method}`}>
                <TD className="text-slate-100">{row.horizon_days}d</TD>
                <TD>
                  {METHOD_LABELS[row.method] ?? row.method}
                  {row.method === 'filtered_historical_simulation' ? (
                    <Badge tone="info" className="ml-2">
                      live
                    </Badge>
                  ) : null}
                </TD>
                <TD numeric>{formatFraction(row.expected_shortfall[primaryConfidenceKey] ?? '0')}</TD>
                <TD numeric>{formatFraction(row.forecast_volatility_annualized)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>

        <ChartFrame
          title="Expected Shortfall by horizon and method"
          description="GBM's i.i.d.-normal assumption under-prices tail risk relative to the empirical methods at every horizon."
          source="Source: /v1/validation/tail-comparison"
        >
          <TailComparisonChart data={chartData} />
        </ChartFrame>
      </CardContent>
    </Card>
  );
}
