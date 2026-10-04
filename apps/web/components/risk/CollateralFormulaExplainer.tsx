'use client';

import { useState } from 'react';

import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/Table';
import { formatFixed, parseDecimalString } from '@/lib/format/decimal';
import { formatFraction, formatPercentNumber } from '@/lib/format/percent';
import type { RiskSnapshotHorizon } from '@/lib/server/risk-service';

const UNIT_DECIMALS = 18;

/** Makes the collateral formula concrete with real numbers for a chosen
 * horizon: `notional + buffer = required collateral`, and which of
 * Expected Shortfall or the worst stress scenario set the buffer. This
 * is the task's "make it visually obvious required collateral can
 * exceed notional" requirement, for a notional of exactly 1 unit. */
export function CollateralFormulaExplainer({ horizons }: { horizons: RiskSnapshotHorizon[] }) {
  const [horizonDays, setHorizonDays] = useState<string>(String(horizons[0]?.horizon_days ?? 1));
  const horizon = horizons.find((h) => String(h.horizon_days) === horizonDays) ?? horizons[0];

  if (!horizon) return null;

  const notional = parseDecimalString('1', UNIT_DECIMALS);
  const required = parseDecimalString(horizon.required_collateral_per_unit, UNIT_DECIMALS);
  const buffer = { value: required.value - notional.value, decimals: UNIT_DECIMALS };

  const bindingLabel = horizon.loss_basis_source === 'expected_shortfall' ? 'Expected Shortfall' : 'the worst stress scenario';
  const bindingFraction =
    horizon.loss_basis_source === 'expected_shortfall' ? horizon.expected_shortfall : horizon.stress_loss;

  return (
    <div className="space-y-4">
      <SegmentedControl
        value={horizonDays}
        onChange={setHorizonDays}
        options={horizons.map((h) => ({ label: `${h.horizon_days}d`, value: String(h.horizon_days) }))}
      />

      <div className="flex flex-wrap items-baseline gap-2 font-mono text-lg">
        <span className="text-slate-200">{formatFixed(notional, { minFrac: 2, maxFrac: 6 })}</span>
        <span className="text-sm text-slate-500">notional</span>
        <span className="text-slate-500">+</span>
        <span className="text-status-warning">{formatFixed(buffer, { minFrac: 2, maxFrac: 6 })}</span>
        <span className="text-sm text-slate-500">buffer</span>
        <span className="text-slate-500">=</span>
        <span className="font-semibold text-slate-100">{formatFixed(required, { minFrac: 2, maxFrac: 6 })}</span>
        <span className="text-sm text-slate-500">required collateral</span>
      </div>

      <p className="text-sm text-slate-400">
        At the {horizon.horizon_days}-day horizon, the buffer is set by{' '}
        <span className="text-slate-200">{bindingLabel}</span> ({formatFraction(bindingFraction)} of notional),
        clamped to the policy&apos;s collateral-ratio range and rounded up so the escrow is never
        under-collateralized by a rounding error.
      </p>

      <Table>
        <THead>
          <TR>
            <TH>Stress scenario</TH>
            <TH numeric>Loss fraction</TH>
          </TR>
        </THead>
        <TBody>
          {horizon.stress_scenarios.map((scenario) => (
            <TR key={scenario.name} highlighted={scenario.name === horizon.worst_stress_scenario}>
              <TD>
                {scenario.description}
                {scenario.name === horizon.worst_stress_scenario ? (
                  <span className="ml-2 text-xs text-status-warning">(worst)</span>
                ) : null}
              </TD>
              <TD numeric>{formatPercentNumber(scenario.loss_fraction)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
