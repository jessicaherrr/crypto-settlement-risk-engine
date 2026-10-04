'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { AXIS_COLOR, GRID_COLOR, SERIES, TEXT_SECONDARY } from '@/lib/ui/palette';

export interface TailComparisonPoint {
  horizonLabel: string;
  historical: number;
  filteredHistorical: number;
  gbm: number;
}

function formatPercentTick(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Expected Shortfall by horizon, grouped by simulation method - makes
 * the "GBM under-prices tail risk" finding visible directly, rather
 * than only stated in text. Live quotes use filtered historical
 * simulation only; the other two methods are shown for comparison. */
export function TailComparisonChart({ data }: { data: TailComparisonPoint[] }) {
  return (
    <div className="h-72 w-full">
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
          <Bar dataKey="historical" name="Historical simulation" fill={SERIES[2]} radius={[2, 2, 0, 0]} />
          <Bar dataKey="filteredHistorical" name="Filtered historical (live quotes)" fill={SERIES[0]} radius={[2, 2, 0, 0]} />
          <Bar dataKey="gbm" name="GBM benchmark" fill={SERIES[1]} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
