import type { ReactNode } from 'react';

import { cn } from '@/lib/ui/cn';

type Tone = 'neutral' | 'warning' | 'critical' | 'info';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-slate-800 bg-slate-900 text-slate-300',
  warning: 'border-status-warning/30 bg-status-warning/10 text-amber-200',
  critical: 'border-status-critical/30 bg-status-critical/10 text-rose-200',
  info: 'border-series-1/30 bg-series-1/10 text-sky-200',
};

export function Callout({
  tone = 'neutral',
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-lg border px-4 py-3', TONE_CLASSES[tone], className)}>
      {title ? <div className="mb-1 text-sm font-semibold">{title}</div> : null}
      <div className="text-[13px] leading-relaxed opacity-90">{children}</div>
    </div>
  );
}
