'use client';

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { AXIS_COLOR, GRID_COLOR, SERIES, TEXT_SECONDARY } from '@/lib/ui/palette';

export interface VolatilityHistoryPoint {
  date: string;
  conditional_vol: number;
  realized_vol_30d: number | null;
}

function formatDateTick(date: string): string {
  const d = new Date(date);
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function formatPercentTick(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function VolatilityHistoryChart({ data }: { data: VolatilityHistoryPoint[] }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID_COLOR} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateTick}
            stroke={AXIS_COLOR}
            tick={{ fill: AXIS_COLOR, fontSize: 12 }}
            minTickGap={40}
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
            labelFormatter={(date: string) => new Date(date).toLocaleDateString('en-US', { dateStyle: 'medium' })}
            formatter={(value, name) => [formatPercentTick(Number(value)), String(name)]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: TEXT_SECONDARY }} />
          <Line
            type="monotone"
            dataKey="conditional_vol"
            name="GARCH conditional vol"
            stroke={SERIES[0]}
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="realized_vol_30d"
            name="30-day realized vol"
            stroke={SERIES[1]}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
