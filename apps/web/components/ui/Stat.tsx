import type { ReactNode } from 'react';

import { cn } from '@/lib/ui/cn';

type Tone = 'neutral' | 'positive' | 'warning' | 'critical';

const VALUE_TONE_CLASSES: Record<Tone, string> = {
  neutral: 'text-slate-100',
  positive: 'text-status-good',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
};

export function Stat({
  label,
  value,
  sublabel,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cn('font-mono text-2xl font-semibold tabular-nums', VALUE_TONE_CLASSES[tone])}>
        {value}
      </div>
      {sublabel ? <div className="text-xs text-slate-500">{sublabel}</div> : null}
    </div>
  );
}
