'use client';

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { AXIS_COLOR, GRID_COLOR, SERIES, TEXT_SECONDARY } from '@/lib/ui/palette';

export interface VolForecastPoint {
  date: string;
  proxy_vol: number;
  rolling_hist_vol: number;
  ewma: number;
  garch: number;
}

function formatDateTick(date: string): string {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function formatPercentTick(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Out-of-sample volatility forecasts (rolling/EWMA/GARCH) against the
 * squared-return proxy - a visual reference for the RMSE/QLIKE table
 * next to it, which is what actually ranks the models. The proxy is
 * itself noisy day to day (it's a single squared return, not a smoothed
 * estimate), so read this for the forecasts tracking its general level,
 * not for a tight point-by-point match. */
export function VolForecastComparisonChart({ data }: { data: VolForecastPoint[] }) {
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
          <Line type="monotone" dataKey="proxy_vol" name="Realized (proxy)" stroke={TEXT_SECONDARY} strokeWidth={1} dot={false} strokeDasharray="2 2" />
          <Line type="monotone" dataKey="rolling_hist_vol" name="Rolling historical" stroke={SERIES[2]} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="ewma" name="EWMA" stroke={SERIES[1]} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="garch" name="GARCH(1,1)" stroke={SERIES[0]} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
