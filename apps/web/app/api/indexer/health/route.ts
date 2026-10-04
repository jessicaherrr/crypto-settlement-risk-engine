import { NextResponse } from 'next/server';

import { classifyIndexerHealth } from '@/lib/indexer/health';
import { fetchIndexerHealth } from '@/lib/server/indexer';

export async function GET() {
  const snapshot = await fetchIndexerHealth();
  const result = classifyIndexerHealth(snapshot);
  return NextResponse.json(result);
}
