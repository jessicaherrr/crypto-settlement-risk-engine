import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { classifyIndexerHealth } from '@/lib/indexer/health';
import { formatUtc } from '@/lib/format/time';
import { fetchIndexerHealth } from '@/lib/server/indexer';

const STATE_TONE = { healthy: 'positive', lagging: 'warning', degraded: 'critical', unreachable: 'neutral' } as const;

/** Server-rendered compact indexer status - chain head, confirmed lag,
 * events processed, reorgs - for the escrow pages, so it's clear the
 * settlement infrastructure behind what's shown is actually alive and
 * synchronized. Not a dashboard of its own. */
export async function IndexerHealthPanel() {
  const snapshot = await fetchIndexerHealth();
  const result = classifyIndexerHealth(snapshot);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Chain indexer</CardTitle>
        <Badge tone={STATE_TONE[result.state]}>{result.state}</Badge>
      </CardHeader>
      <CardContent>
        {snapshot ? (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Chain head" value={snapshot.chain_head} />
            <Stat label="Confirmed through" value={snapshot.last_confirmed_block} />
            <Stat label="Confirmed lag" value={`${snapshot.confirmed_lag_blocks} blocks`} />
            <Stat label="Confirmation depth" value={snapshot.confirmation_depth} />
            <Stat label="Events processed" value={snapshot.total_events_processed} />
            <Stat label="Duplicates ignored" value={snapshot.duplicate_events_ignored} />
            <Stat label="Reorgs" value={snapshot.reorg_count} />
            <Stat
              label="Last RPC success"
              value={snapshot.last_successful_rpc_call ? formatUtc(snapshot.last_successful_rpc_call) : '—'}
            />
          </dl>
        ) : (
          <p className="text-sm text-slate-500">{result.detail}</p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-mono text-sm text-slate-200">{value}</dd>
    </div>
  );
}
