import { ChartFrame } from '@/components/charts/ChartFrame';
import { VarBacktestChart } from '@/components/charts/VarBacktestChart';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/Table';
import { formatPercentNumber } from '@/lib/format/percent';
import { getVarBacktest } from '@/lib/server/risk-service';

export async function VarBacktestSection() {
  const backtest = await getVarBacktest();
  const primary = backtest.results.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const confidenceLabel = formatPercentNumber(primary.confidence, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>VaR backtest (1-day horizon)</CardTitle>
        <CardDescription>
          Out-of-sample exceedance testing: does the realized exceedance rate match what each confidence
          level implies? Risk-model validation, not a trading-strategy backtest.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <THead>
            <TR>
              <TH>Confidence</TH>
              <TH numeric>Observations</TH>
              <TH numeric>Exceedances</TH>
              <TH numeric>Exceedance rate</TH>
              <TH numeric>Expected rate</TH>
              <TH numeric>Kupiec p-value</TH>
              <TH>Verdict</TH>
              <TH numeric>ES realized / predicted</TH>
            </TR>
          </THead>
          <TBody>
            {backtest.results.map((result) => (
              <TR key={result.confidence}>
                <TD className="text-slate-100">{formatPercentNumber(result.confidence, 0)}</TD>
                <TD numeric>{result.kupiec.n_obs}</TD>
                <TD numeric>{result.kupiec.n_exceedances}</TD>
                <TD numeric>{formatPercentNumber(result.kupiec.exceedance_rate)}</TD>
                <TD numeric>{formatPercentNumber(result.kupiec.expected_rate)}</TD>
                <TD numeric>{result.kupiec.p_value.toFixed(3)}</TD>
                <TD>
                  <Badge tone={result.kupiec.reject_at_5pct ? 'critical' : 'positive'}>
                    {result.kupiec.reject_at_5pct ? 'rejected at 5%' : 'not rejected'}
                  </Badge>
                </TD>
                <TD numeric>
                  {result.expected_shortfall.ratio !== null ? result.expected_shortfall.ratio.toFixed(2) : '—'}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>

        <Callout tone="neutral" title="Scope">
          {backtest.assumptions.join(' ')}
        </Callout>

        <ChartFrame
          title={`Daily returns vs. -VaR (${confidenceLabel})`}
          description="Points below the line are exceedances - days the realized loss exceeded the modeled VaR."
          source="Source: /v1/validation/var-backtest"
        >
          <VarBacktestChart
            data={backtest.series.map((point) => ({
              date: point.date,
              return: point.return,
              varLoss: point.var_loss,
              exceed: point.exceed,
            }))}
            confidenceLabel={confidenceLabel}
          />
        </ChartFrame>
      </CardContent>
    </Card>
  );
}
