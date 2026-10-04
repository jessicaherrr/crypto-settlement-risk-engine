'use client';

import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import type { IndexerHealthResult, IndexerHealthState } from '@/lib/indexer/health';

const POLL_INTERVAL_MS = 15_000;

const STATE_TONE: Record<IndexerHealthState, 'positive' | 'warning' | 'critical' | 'neutral'> = {
  healthy: 'positive',
  lagging: 'warning',
  degraded: 'critical',
  unreachable: 'neutral',
};

const STATE_LABEL: Record<IndexerHealthState, string> = {
  healthy: 'Indexer synced',
  lagging: 'Indexer lagging',
  degraded: 'Indexer degraded',
  unreachable: 'Indexer unreachable',
};

/** A compact "is the settlement infrastructure alive" signal, polling
 * the chain indexer's own health endpoint through a thin server proxy
 * (`/api/indexer/health`) - not an observability product, just evidence
 * the Go indexer is actually running and roughly caught up. */
export function IndexerHealthBadge() {
  const [result, setResult] = useState<IndexerHealthResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/indexer/health');
        const json = await res.json();
        if (!cancelled) setResult(json);
      } catch {
        if (!cancelled) setResult({ state: 'unreachable', detail: 'Request failed', snapshot: null });
      }
    }
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!result) return null;

  return (
    <div title={result.detail}>
      <Badge tone={STATE_TONE[result.state]}>{STATE_LABEL[result.state]}</Badge>
    </div>
  );
}
