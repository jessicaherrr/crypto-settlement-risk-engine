'use client';

import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { AXIS_COLOR, GRID_COLOR, SERIES, STATUS, TEXT_SECONDARY } from '@/lib/ui/palette';

export interface VarBacktestPoint {
  date: string;
  return: number;
  varLoss: number;
  exceed: boolean;
}

function formatDateTick(date: string): string {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function formatPercentTick(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Daily returns against the -VaR threshold at the stated confidence -
 * an exceedance (a return below the threshold) is a status, not a
 * series identity, so it's colored from the status palette rather than
 * a third categorical hue. */
export function VarBacktestChart({ data, confidenceLabel }: { data: VarBacktestPoint[]; confidenceLabel: string }) {
  const withThreshold = data.map((d) => ({ ...d, negVarLoss: -d.varLoss }));
  const normal = withThreshold.filter((d) => !d.exceed);
  const exceedances = withThreshold.filter((d) => d.exceed);

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={withThreshold} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
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
            formatter={(value, name) => [formatPercentTick(Number(value)), String(name)]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: TEXT_SECONDARY }} />
          <Line
            type="stepAfter"
            dataKey="negVarLoss"
            name={`-VaR (${confidenceLabel})`}
            stroke={SERIES[0]}
            strokeWidth={1.5}
            dot={false}
          />
          <Scatter data={normal} dataKey="return" name="Daily return" fill={TEXT_SECONDARY} />
          <Scatter data={exceedances} dataKey="return" name="Exceedance" fill={STATUS.critical} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
