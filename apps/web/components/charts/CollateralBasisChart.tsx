'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { AXIS_COLOR, GRID_COLOR, SERIES, TEXT_SECONDARY } from '@/lib/ui/palette';

export interface CollateralBasisPoint {
  horizonLabel: string;
  expectedShortfall: number;
  stressLoss: number;
}

function formatPercentTick(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Expected Shortfall vs. worst stress loss, per horizon - the two
 * candidate bases the collateral policy takes the larger of (see
 * `policy/collateral.py`). Which one actually binds for a given horizon
 * is stated in the metrics table alongside this chart, not re-encoded
 * here as a third visual channel. */
export function CollateralBasisChart({ data }: { data: CollateralBasisPoint[] }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }} barGap={4}>
          <CartesianGrid stroke={GRID_COLOR} vertical={false} />
          <XAxis
            dataKey="horizonLabel"
            stroke={AXIS_COLOR}
            tick={{ fill: AXIS_COLOR, fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={formatPercentTick}
            stroke={AXIS_COLOR}
            tick={{ fill: AXIS_COLOR, fontSize: 12 }}
            width={48}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', fontSize: 12 }}
            formatter={(value, name) => [formatPercentTick(Number(value)), String(name)]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: TEXT_SECONDARY }} />
          <Bar dataKey="expectedShortfall" name="Expected Shortfall" fill={SERIES[0]} radius={[2, 2, 0, 0]} />
          <Bar dataKey="stressLoss" name="Worst stress loss" fill={SERIES[1]} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
