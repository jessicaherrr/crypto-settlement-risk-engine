'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ACTIVE_CHAIN, RISK_ESCROW_ADDRESS } from '@/lib/chain/config';
import { riskEscrowAbi } from '@/lib/contracts/riskEscrowAbi';
import { computeSettlePreview } from '@/lib/escrow/contractCall';
import { isSameAddress } from '@/lib/format/address';
import { formatTokenAmount } from '@/lib/format/money';
import { fromViem } from '@/lib/format/sources';
import { formatUtc } from '@/lib/format/time';

/**
 * Settle/refund, gated on the real, live contract state - not a
 * reimplementation of `RiskEscrow.sol`'s eligibility rules. `isSettleable`/
 * `isRefundable` are read straight off the deployed contract; a
 * disabled button always states why, rather than just doing nothing.
 */
export function EscrowActions({
  dealId,
  depositor,
  counterparty,
  notional,
  collateralLocked,
  settlementDeadline,
  confirmedStatus,
  assetSymbol = 'ETH',
}: {
  dealId: string;
  depositor: string;
  counterparty: string;
  notional: bigint;
  collateralLocked: bigint;
  settlementDeadline: string | null;
  confirmedStatus: 'pending' | 'active' | 'settled' | 'refunded' | 'cancelled';
  assetSymbol?: string;
}) {
  const router = useRouter();
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [pending, setPending] = useState<'settle' | 'refund' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dealIdBigInt = BigInt(dealId);
  const { data: isSettleable, refetch: refetchSettleable } = useReadContract({
    address: RISK_ESCROW_ADDRESS,
    abi: riskEscrowAbi,
    functionName: 'isSettleable',
    args: [dealIdBigInt],
  });
  const { data: isRefundable, refetch: refetchRefundable } = useReadContract({
    address: RISK_ESCROW_ADDRESS,
    abi: riskEscrowAbi,
    functionName: 'isRefundable',
    args: [dealIdBigInt],
  });
  const { data: platformFeeBps } = useReadContract({
    address: RISK_ESCROW_ADDRESS,
    abi: riskEscrowAbi,
    functionName: 'platformFeeBps',
  });

  if (confirmedStatus !== 'active') return null;

  const isParty = Boolean(address) && (isSameAddress(address!, depositor) || isSameAddress(address!, counterparty));
  const wrongNetwork = Boolean(chainId) && chainId !== ACTIVE_CHAIN.id;
  const deadlinePassed = settlementDeadline ? Date.now() >= new Date(settlementDeadline).getTime() : false;

  const preview = computeSettlePreview(notional, collateralLocked, (platformFeeBps as bigint) ?? 0n);

  async function handle(action: 'settle' | 'refund') {
    setPending(action);
    setError(null);
    try {
      const hash = await writeContractAsync({
        address: RISK_ESCROW_ADDRESS,
        abi: riskEscrowAbi,
        functionName: action,
        args: [dealIdBigInt],
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      await Promise.all([refetchSettleable(), refetchRefundable()]);
      router.refresh();
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : 'Transaction failed';
      setError(/user rejected|denied/i.test(message) ? 'Signature declined' : message);
    } finally {
      setPending(null);
    }
  }

  if (!isConnectedAtAll(address)) {
    return (
      <Callout tone="info">Connect the depositor or counterparty wallet to settle or refund this escrow.</Callout>
    );
  }
  if (!isParty) {
    return (
      <Callout tone="neutral">
        The connected wallet is not a party to this escrow - only the depositor or counterparty may settle or
        refund it.
      </Callout>
    );
  }
  if (wrongNetwork) {
    return <Callout tone="warning">Switch to {ACTIVE_CHAIN.name} to settle or refund this escrow.</Callout>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Button onClick={() => handle('settle')} disabled={!isSettleable || pending !== null}>
            {pending === 'settle' ? 'Settling…' : 'Settle'}
          </Button>
          {!isSettleable ? (
            <p className="mt-1 text-xs text-slate-500">Not currently settleable.</p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Pays {formatTokenAmount(fromViem(preview.payout, 18), { symbol: assetSymbol })} to the
              counterparty, returns {formatTokenAmount(fromViem(preview.refund, 18), { symbol: assetSymbol })}{' '}
              buffer to the depositor.
            </p>
          )}
        </div>
        <div>
          <Button variant="secondary" onClick={() => handle('refund')} disabled={!isRefundable || pending !== null}>
            {pending === 'refund' ? 'Refunding…' : 'Refund'}
          </Button>
          {!isRefundable ? (
            <p className="mt-1 text-xs text-slate-500">
              {deadlinePassed
                ? 'Should be refundable now — refresh the page.'
                : settlementDeadline
                  ? `Opens after ${formatUtc(settlementDeadline)}.`
                  : 'Opens after the settlement deadline.'}
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Returns the full {formatTokenAmount(fromViem(collateralLocked, 18), { symbol: assetSymbol })}{' '}
              collateral to the depositor.
            </p>
          )}
        </div>
      </div>
      {error ? <Callout tone="critical">{error}</Callout> : null}
    </div>
  );
}

function isConnectedAtAll(address: string | undefined): boolean {
  return Boolean(address);
}
