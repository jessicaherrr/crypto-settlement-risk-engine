import { getAddress, isAddress } from 'viem';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export interface SettlementAsset {
  address: `0x${string}`; // zero address = native
  symbol: string;
  label: string;
  decimals: number;
}

export const NATIVE_ASSET: SettlementAsset = {
  address: ZERO_ADDRESS,
  symbol: 'ETH', // display label only - the quant risk engine always measures ETH/USD, independent of which chain's native asset backs collateral locally
  label: 'Native (ETH)',
  decimals: 18,
};

function parseConfiguredAssets(): SettlementAsset[] {
  const raw = process.env.NEXT_PUBLIC_SETTLEMENT_ASSETS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is SettlementAsset => isAddress(entry?.address) && typeof entry?.symbol === 'string')
      .map((entry) => ({
        address: getAddress(entry.address),
        symbol: entry.symbol,
        label: entry.label ?? entry.symbol,
        decimals: typeof entry.decimals === 'number' ? entry.decimals : 18,
      }));
  } catch {
    console.error('NEXT_PUBLIC_SETTLEMENT_ASSETS is not valid JSON; ignoring');
    return [];
  }
}

/** The settlement-asset allowlist this app offers in /escrow/new - native
 * plus whatever ERC-20s are configured via `NEXT_PUBLIC_SETTLEMENT_ASSETS`
 * (a JSON array of `{address, symbol, label?, decimals?}`). An escrow can
 * only ever be created against an asset on this list; the server
 * re-validates against the same list rather than trusting a client-
 * supplied address. */
export const SETTLEMENT_ASSETS: SettlementAsset[] = [NATIVE_ASSET, ...parseConfiguredAssets()];

export function findSettlementAsset(address: string): SettlementAsset | undefined {
  if (!isAddress(address)) return undefined;
  const checksummed = getAddress(address);
  return SETTLEMENT_ASSETS.find((asset) => asset.address === checksummed);
}

export function isNativeAsset(address: string): boolean {
  return address === ZERO_ADDRESS;
}
