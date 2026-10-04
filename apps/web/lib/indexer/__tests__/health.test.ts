import { describe, expect, it } from 'vitest';

import { classifyIndexerHealth, type IndexerHealthSnapshot } from '../health';

function snapshot(overrides: Partial<IndexerHealthSnapshot> = {}): IndexerHealthSnapshot {
  return {
    started_at: '2026-01-01T00:00:00Z',
    chain_id: 31337,
    contract_address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    confirmation_depth: 5,
    chain_head: 100,
    last_scanned_block: 100,
    last_confirmed_block: 95,
    confirmed_lag_blocks: 5,
    last_successful_rpc_call: '2026-01-01T00:00:00Z',
    last_successful_db_write: '2026-01-01T00:00:00Z',
    total_events_processed: 10,
    duplicate_events_ignored: 0,
    retry_count: 0,
    reorg_count: 0,
    ...overrides,
  };
}

const NOW = new Date('2026-01-01T00:00:05Z');

describe('classifyIndexerHealth', () => {
  it('is unreachable when there is no snapshot at all', () => {
    const result = classifyIndexerHealth(null, NOW);
    expect(result.state).toBe('unreachable');
  });

  it('is healthy when lag is within confirmation_depth', () => {
    const result = classifyIndexerHealth(snapshot({ confirmed_lag_blocks: 5, confirmation_depth: 5 }), NOW);
    expect(result.state).toBe('healthy');
  });

  it('is healthy when lag is comfortably below confirmation_depth plus slack', () => {
    const result = classifyIndexerHealth(snapshot({ confirmed_lag_blocks: 8, confirmation_depth: 5 }), NOW);
    expect(result.state).toBe('healthy');
  });

  it('is lagging when confirmed_lag_blocks exceeds depth + slack', () => {
    const result = classifyIndexerHealth(snapshot({ confirmed_lag_blocks: 20, confirmation_depth: 5 }), NOW);
    expect(result.state).toBe('lagging');
  });

  it('is degraded when the last successful RPC call is stale', () => {
    const result = classifyIndexerHealth(
      snapshot({ last_successful_rpc_call: '2025-12-01T00:00:00Z' }),
      NOW
    );
    expect(result.state).toBe('degraded');
  });

  it('handles missing omitempty timestamp fields (never set yet) as stale, not a crash', () => {
    const result = classifyIndexerHealth(
      snapshot({ last_successful_rpc_call: undefined, last_successful_db_write: undefined }),
      NOW
    );
    expect(result.state).toBe('degraded');
  });

  it('is degraded with the last error message when an error is present and RPC is also stale', () => {
    const result = classifyIndexerHealth(
      snapshot({ last_error: 'rpc dial failed', last_successful_rpc_call: '2025-12-01T00:00:00Z' }),
      NOW
    );
    expect(result.state).toBe('degraded');
    expect(result.detail).toContain('rpc dial failed');
  });

  it('a malformed snapshot (missing fields entirely) is treated as unreachable upstream, not thrown', () => {
    // Simulates a non-JSON or empty response already having failed to
    // parse before this function is called.
    const result = classifyIndexerHealth(null);
    expect(result.state).toBe('unreachable');
    expect(result.snapshot).toBeNull();
  });
});
