/** Classifies the Go chain indexer's health snapshot
 * (`services/chain-indexer/internal/metrics`) into one state a badge can
 * show - pure, so it's testable without a running indexer. */

export type IndexerHealthState = 'healthy' | 'lagging' | 'degraded' | 'unreachable';

export interface IndexerHealthSnapshot {
  started_at: string;
  chain_id: number;
  contract_address: string;
  confirmation_depth: number;
  chain_head: number;
  last_scanned_block: number;
  last_confirmed_block: number;
  confirmed_lag_blocks: number;
  last_successful_rpc_call?: string;
  last_successful_db_write?: string;
  total_events_processed: number;
  duplicate_events_ignored: number;
  retry_count: number;
  reorg_count: number;
  last_error?: string;
}

export interface IndexerHealthResult {
  state: IndexerHealthState;
  detail: string;
  snapshot: IndexerHealthSnapshot | null;
}

const STALE_RPC_SECONDS = 60;
const LAG_SLACK_BLOCKS = 10;

export function classifyIndexerHealth(
  snapshot: IndexerHealthSnapshot | null,
  now: Date = new Date()
): IndexerHealthResult {
  if (!snapshot) {
    return { state: 'unreachable', detail: 'Could not reach the chain indexer’s health endpoint.', snapshot: null };
  }

  const rpcAgeSeconds = snapshot.last_successful_rpc_call
    ? (now.getTime() - new Date(snapshot.last_successful_rpc_call).getTime()) / 1000
    : Number.POSITIVE_INFINITY;
  const dbWriteStale =
    Boolean(snapshot.last_error) && rpcAgeSeconds > STALE_RPC_SECONDS;

  if (dbWriteStale) {
    return {
      state: 'degraded',
      detail: `Last error: ${snapshot.last_error}`,
      snapshot,
    };
  }

  if (rpcAgeSeconds > STALE_RPC_SECONDS) {
    return {
      state: 'degraded',
      detail: `No successful RPC call in over ${STALE_RPC_SECONDS}s.`,
      snapshot,
    };
  }

  if (snapshot.confirmed_lag_blocks > snapshot.confirmation_depth + LAG_SLACK_BLOCKS) {
    return {
      state: 'lagging',
      detail: `${snapshot.confirmed_lag_blocks} blocks behind head (expected up to ~${snapshot.confirmation_depth}).`,
      snapshot,
    };
  }

  return { state: 'healthy', detail: 'Synced within the expected confirmation depth.', snapshot };
}
