import { getAddress, isAddress } from 'viem';

/** Checksums and truncates an address for display, e.g.
 * "0x1234…abcd". Returns the input unchanged if it isn't a valid
 * address, rather than throwing - this is a display helper, not a
 * validator (routes validate addresses themselves before acting on
 * them). */
export function shortAddress(address: string, opts: { chars?: number } = {}): string {
  const { chars = 4 } = opts;
  if (!isAddress(address)) return address;
  const checksummed = getAddress(address);
  return `${checksummed.slice(0, 2 + chars)}…${checksummed.slice(-chars)}`;
}

/** Case-insensitive, checksum-normalized address comparison - plain `===`
 * on two address strings is a real bug source since EIP-55 checksums mean
 * the same address can be spelled multiple ways. */
export function isSameAddress(a: string, b: string): boolean {
  if (!isAddress(a) || !isAddress(b)) return false;
  return getAddress(a) === getAddress(b);
}

/** Truncates a 0x-prefixed hash (tx hash, block hash, quoteId) for
 * display, e.g. "0x1a2b3c…f00dba". */
export function shortHash(hash: string, opts: { chars?: number } = {}): string {
  const { chars = 6 } = opts;
  if (!hash.startsWith('0x') || hash.length <= 2 + chars * 2) return hash;
  return `${hash.slice(0, 2 + chars)}…${hash.slice(-chars)}`;
}
