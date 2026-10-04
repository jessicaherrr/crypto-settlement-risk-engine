import 'server-only';

import { createPublicClient, http } from 'viem';

import { ACTIVE_CHAIN, RPC_URL } from '@/lib/chain/config';

// Server-side read-only RPC client (API routes, Server Components) -
// never imported by a client component.
export const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(RPC_URL),
});
