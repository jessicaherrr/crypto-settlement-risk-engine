import type { ReactNode } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';

/** Shared chrome around every chart on the dashboard: title, what it
 * shows, and where the data comes from - every chart here is drawn from
 * a real endpoint, so this is also where that's made legible rather than
 * left implicit. */
export function ChartFrame({
  title,
  description,
  source,
  children,
}: {
  title: string;
  description?: string;
  source?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <p className="text-sm text-slate-400">{description}</p> : null}
      </CardHeader>
      <CardContent>
        {children}
        {source ? <p className="mt-3 text-xs text-slate-500">{source}</p> : null}
      </CardContent>
    </Card>
  );
}
