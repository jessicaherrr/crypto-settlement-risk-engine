// lib/blockchain/client-config.ts
import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { http } from 'wagmi';

import { ACTIVE_CHAIN } from '@/lib/chain/config';

/**
 * Client-side only configuration for Wagmi and RainbowKit
 * This should ONLY be imported in client components
 */
export const clientConfig = getDefaultConfig({
  appName: 'Crypto Settlement Risk Engine',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'demo-project-id',
  chains: [ACTIVE_CHAIN],
  transports: {
    [ACTIVE_CHAIN.id]: http(),
  },
  ssr: true, // Required for Next.js server-side rendering
});
