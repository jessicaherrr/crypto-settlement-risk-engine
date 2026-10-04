import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/Badge';

export interface TimelineEntry {
  key: string;
  title: string;
  timestamp?: string;
  tone?: 'neutral' | 'positive' | 'warning' | 'critical' | 'info';
  badge?: string;
  detail?: ReactNode;
}

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-slate-500">No events recorded yet.</p>;
  }
  return (
    <ol className="space-y-4">
      {entries.map((entry) => (
        <li key={entry.key} className="flex gap-3">
          <div className="mt-1.5 h-2 w-2 flex-none rounded-full bg-slate-600" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-200">{entry.title}</span>
              {entry.badge ? <Badge tone={entry.tone ?? 'neutral'}>{entry.badge}</Badge> : null}
            </div>
            {entry.timestamp ? <div className="text-xs text-slate-500">{entry.timestamp}</div> : null}
            {entry.detail ? <div className="text-xs text-slate-500">{entry.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
