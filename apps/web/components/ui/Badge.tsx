import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/ui/cn';

type Tone = 'neutral' | 'positive' | 'warning' | 'critical' | 'info';

// `status-*`/`series-1` Tailwind tokens (tailwind.config.ts) - validated
// dark-surface colors from the dataviz skill's palette, reused here as UI
// chrome. Never reused as a chart series color (see that config's
// comment) - a badge's meaning must never be confused with a line on a
// chart.
const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-slate-800 text-slate-300',
  positive: 'bg-status-good/10 text-status-good ring-1 ring-inset ring-status-good/30',
  warning: 'bg-status-warning/10 text-status-warning ring-1 ring-inset ring-status-warning/30',
  critical: 'bg-status-critical/10 text-status-critical ring-1 ring-inset ring-status-critical/30',
  info: 'bg-series-1/10 text-series-1 ring-1 ring-inset ring-series-1/30',
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium',
        TONE_CLASSES[tone],
        className
      )}
      {...props}
    />
  );
}
