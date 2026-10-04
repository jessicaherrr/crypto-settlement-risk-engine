import { Badge } from '@/components/ui/Badge';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/Table';
import { formatFixed, parseDecimalString } from '@/lib/format/decimal';
import { formatFraction } from '@/lib/format/percent';
import type { RiskSnapshotHorizon } from '@/lib/server/risk-service';

function formatRatio(ratio: string): string {
  return `${formatFixed(parseDecimalString(ratio, 6), { minFrac: 2, maxFrac: 2 })}×`;
}

function formatAssetAmount(amount: string): string {
  return formatFixed(parseDecimalString(amount, 18), { minFrac: 2, maxFrac: 4 });
}

/** The per-horizon VaR/ES/stress/collateral table - the same figures a
 * real quote at that horizon would show, computed for a notional of 1
 * unit (see `/v1/risk/snapshot`, `service/analytics.build_risk_snapshot`). */
export function HorizonMetricsTable({ horizons }: { horizons: RiskSnapshotHorizon[] }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Horizon</TH>
          <TH numeric>Volatility</TH>
          <TH numeric>VaR</TH>
          <TH numeric>Expected Shortfall</TH>
          <TH numeric>Worst stress</TH>
          <TH>Binding basis</TH>
          <TH numeric>Collateral ratio</TH>
          <TH numeric>Required (per unit)</TH>
        </TR>
      </THead>
      <TBody>
        {horizons.map((horizon) => (
          <TR key={horizon.horizon_days}>
            <TD className="font-medium text-slate-100">{horizon.horizon_days}d</TD>
            <TD numeric>{formatFraction(horizon.forecast_volatility_annualized)}</TD>
            <TD numeric>{formatFraction(horizon.value_at_risk)}</TD>
            <TD numeric>{formatFraction(horizon.expected_shortfall)}</TD>
            <TD numeric title={horizon.worst_stress_scenario}>
              {formatFraction(horizon.stress_loss)}
            </TD>
            <TD>
              <Badge tone={horizon.loss_basis_source === 'expected_shortfall' ? 'info' : 'warning'}>
                {horizon.loss_basis_source === 'expected_shortfall' ? 'Expected Shortfall' : 'Stress'}
              </Badge>
            </TD>
            <TD numeric>{formatRatio(horizon.collateral_ratio)}</TD>
            <TD numeric>{formatAssetAmount(horizon.required_collateral_per_unit)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
