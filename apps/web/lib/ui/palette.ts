/**
 * Plain hex values for chart marks (recharts' `stroke`/`fill` props take
 * literal colors, not Tailwind utility classes) - must stay in sync with
 * the `series`/`status` tokens in `tailwind.config.ts`, which is what UI
 * chrome (badges, callouts) uses for the same roles. Validated against
 * the dark slate-900 chart surface via the dataviz skill's palette
 * validator; see that config file's comment for the full rationale.
 *
 * `SERIES` is a fixed categorical order - assign chart series to these in
 * order (first series -> SERIES[0], etc.), never cycle or reassign based
 * on which series happens to be present.
 */
export const SERIES = ['#3987e5', '#199e70', '#d95926', '#e66767'] as const;

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export const CHART_SURFACE = '#0f172a'; // slate-900 - what charts render on
export const GRID_COLOR = '#1e293b'; // slate-800 - recessive gridlines
export const AXIS_COLOR = '#475569'; // slate-600 - muted axis ticks/labels
export const TEXT_SECONDARY = '#94a3b8'; // slate-400
