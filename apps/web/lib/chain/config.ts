// Chain/contract identity shared by both server and client code - no
// secrets, no wagmi/RainbowKit imports (those live in
// `lib/blockchain/client-config.ts`, which only a client component may
// import). Replaces the old single-chain-hardcoded `lib/blockchain/config.ts`:
// this app now runs against either a local Hardhat node (for the local
// demo stack) or Polygon Amoy, selected by `NEXT_PUBLIC_CHAIN_ID`.
import { getAddress, isAddress } from 'viem';
import type { Chain } from 'viem';
import { hardhat, polygonAmoy } from 'viem/chains';

export const SUPPORTED_CHAINS = [polygonAmoy, hardhat] as const;

function resolveActiveChain(): Chain {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID;
  const chainId = raw ? Number(raw) : polygonAmoy.id;
  const match = SUPPORTED_CHAINS.find((chain) => chain.id === chainId);
  if (!match) {
    const supported = SUPPORTED_CHAINS.map((chain) => chain.id).join(', ');
    throw new Error(
      `Unsupported NEXT_PUBLIC_CHAIN_ID=${JSON.stringify(raw)}; supported chain ids are [${supported}]`
    );
  }
  return match;
}

export const ACTIVE_CHAIN: Chain = resolveActiveChain();

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || ACTIVE_CHAIN.rpcUrls.default.http[0];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

function resolveRiskEscrowAddress(): { address: `0x${string}`; configured: boolean } {
  const raw = process.env.NEXT_PUBLIC_RISK_ESCROW_ADDRESS;
  if (!raw) {
    return { address: ZERO_ADDRESS, configured: false };
  }
  if (!isAddress(raw)) {
    // Catches exactly the kind of malformed-address mistake that's easy to
    // make hand-editing .env.local (e.g. one extra hex character) - fail
    // loudly at startup rather than silently calling the wrong contract.
    throw new Error(
      `NEXT_PUBLIC_RISK_ESCROW_ADDRESS is not a valid address: ${JSON.stringify(raw)} ` +
        '(expected "0x" followed by exactly 40 hex characters)'
    );
  }
  const address = getAddress(raw);
  return { address, configured: address !== ZERO_ADDRESS };
}

const resolvedRiskEscrow = resolveRiskEscrowAddress();

/** The deployed RiskEscrow address, checksummed. Falls back to the zero
 * address (see `CONTRACT_CONFIGURED`) rather than throwing when unset, so
 * pages that don't need the contract (e.g. /models) still render during
 * local setup before a contract is deployed. */
export const RISK_ESCROW_ADDRESS = resolvedRiskEscrow.address;

/** False until a real (non-zero) contract address is configured - pages
 * that need the contract should show a clear "not configured" state
 * instead of silently calling the zero address. */
export const CONTRACT_CONFIGURED = resolvedRiskEscrow.configured;

export function explorerTxUrl(txHash: string): string | null {
  const base = ACTIVE_CHAIN.blockExplorers?.default.url;
  return base ? `${base}/tx/${txHash}` : null;
}

export function explorerAddressUrl(address: string): string | null {
  const base = ACTIVE_CHAIN.blockExplorers?.default.url;
  return base ? `${base}/address/${address}` : null;
}
