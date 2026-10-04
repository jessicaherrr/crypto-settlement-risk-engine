import 'server-only';

import type { IndexerHealthSnapshot } from '@/lib/indexer/health';

const INDEXER_HEALTH_URL = process.env.INDEXER_HEALTH_URL || 'http://localhost:8090/';

export async function fetchIndexerHealth(): Promise<IndexerHealthSnapshot | null> {
  try {
    const response = await fetch(INDEXER_HEALTH_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    return (await response.json()) as IndexerHealthSnapshot;
  } catch {
    return null;
  }
}
