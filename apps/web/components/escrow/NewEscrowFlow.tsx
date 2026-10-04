'use client';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { erc20Abi, parseEventLogs } from 'viem';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from 'wagmi';

import { QuoteSummary } from '@/components/escrow/QuoteSummary';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Field, Input, Select } from '@/components/ui/Field';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ACTIVE_CHAIN, CONTRACT_CONFIGURED, RISK_ESCROW_ADDRESS } from '@/lib/chain/config';
import { NATIVE_ASSET, SETTLEMENT_ASSETS, isNativeAsset } from '@/lib/chain/assets';
import { riskEscrowAbi } from '@/lib/contracts/riskEscrowAbi';
import { buildCreateEscrowArgs, createEscrowValue } from '@/lib/escrow/contractCall';
import {
  INITIAL_NEW_ESCROW_STATE,
  type IssuedQuote,
  isQuoteTooCloseToExpiry,
  needsApproval,
  newEscrowReducer,
} from '@/lib/escrow/newEscrowMachine';

const HORIZON_OPTIONS = [
  { label: '1 day', value: '1' },
  { label: '7 days', value: '7' },
  { label: '14 days', value: '14' },
  { label: '30 days', value: '30' },
];

const POLL_INTERVAL_MS = 2000;
const QUOTE_SAFETY_MARGIN_SECONDS = 30;

export function NewEscrowFlow() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const connectedChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [state, dispatch] = useReducer(newEscrowReducer, INITIAL_NEW_ESCROW_STATE);
  const [notional, setNotional] = useState('1.0');
  const [horizonDays, setHorizonDays] = useState('7');
  const [counterparty, setCounterparty] = useState('');
  const [assetAddress, setAssetAddress] = useState(NATIVE_ASSET.address);
  const [submitting, setSubmitting] = useState(false);

  const asset = SETTLEMENT_ASSETS.find((a) => a.address === assetAddress) ?? NATIVE_ASSET;
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const allowanceQuery = useReadContract({
    address: isNativeAsset(asset.address) ? undefined : asset.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && !isNativeAsset(asset.address) ? [address, RISK_ESCROW_ADDRESS] : undefined,
    query: { enabled: Boolean(address) && !isNativeAsset(asset.address) },
  });

  const wrongNetwork = isConnected && connectedChainId !== ACTIVE_CHAIN.id;

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  async function requestQuote() {
    if (!address || !counterparty) return;
    dispatch({ type: 'REQUEST_QUOTE' });
    try {
      const response = await fetch('/api/quote/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notional,
          horizonDays: Number(horizonDays),
          depositor: address,
          counterparty,
          settlementAsset: asset.address,
          settlementAssetDecimals: asset.decimals,
        }),
      });
      const json = await response.json();
      if (!json.success) {
        dispatch({ type: 'QUOTE_FAILED', message: json.error ?? 'The risk service rejected the request' });
        return;
      }
      const issued: IssuedQuote = {
        quote: json.quote,
        signature: json.signature,
        riskQuote: json.riskQuote,
        digest: json.digest,
        signer: json.signer,
      };
      dispatch({ type: 'QUOTE_RECEIVED', quote: issued });
    } catch (error) {
      dispatch({
        type: 'QUOTE_FAILED',
        message: error instanceof Error ? error.message : 'Could not reach the risk service',
      });
    }
  }

  async function proceed() {
    if (!state.quote || !address) return;
    if (isQuoteTooCloseToExpiry(state.quote, Date.now(), QUOTE_SAFETY_MARGIN_SECONDS)) {
      dispatch({ type: 'QUOTE_EXPIRED' });
      return;
    }
    if (wrongNetwork) {
      dispatch({ type: 'ERROR', kind: 'wrong_network', message: `Switch to ${ACTIVE_CHAIN.name} to continue` });
      return;
    }

    const args = buildCreateEscrowArgs(state.quote.quote);
    setSubmitting(true);
    try {
      if (!isNativeAsset(asset.address)) {
        const allowance = (allowanceQuery.data as bigint | undefined) ?? 0n;
        if (needsApproval(asset.address, allowance, args.requiredCollateral)) {
          dispatch({ type: 'NEEDS_APPROVAL' });
          const approveHash = await writeContractAsync({
            address: asset.address,
            abi: erc20Abi,
            functionName: 'approve',
            args: [RISK_ESCROW_ADDRESS, args.requiredCollateral],
          });
          dispatch({ type: 'APPROVAL_SUBMITTED', txHash: approveHash });
          await publicClient?.waitForTransactionReceipt({ hash: approveHash });
          await allowanceQuery.refetch();
          dispatch({ type: 'APPROVAL_CONFIRMED' });
        } else {
          dispatch({ type: 'ALLOWANCE_SUFFICIENT' });
        }
      } else {
        dispatch({ type: 'ALLOWANCE_SUFFICIENT' });
      }

      const createResp = await fetch('/api/escrow/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quote: state.quote.quote, signature: state.quote.signature }),
      });
      const createJson = await createResp.json();
      if (!createJson.success) {
        dispatch({ type: 'ESCROW_REJECTED', message: createJson.error ?? 'The server rejected this quote' });
        return;
      }
      dispatch({ type: 'ESCROW_PREPARED', escrowId: createJson.escrowId });

      const createHash = await writeContractAsync({
        address: RISK_ESCROW_ADDRESS,
        abi: riskEscrowAbi,
        functionName: 'createEscrow',
        args: [
          {
            quoteId: args.quoteId,
            depositor: args.depositor,
            counterparty: args.counterparty,
            settlementAsset: args.settlementAsset,
            notional: args.notional,
            requiredCollateral: args.requiredCollateral,
            quoteExpiration: args.quoteExpiration,
            settlementHorizon: args.settlementHorizon,
            modelVersion: args.modelVersion,
            riskSnapshotHash: args.riskSnapshotHash,
          },
          state.quote.signature as `0x${string}`,
        ],
        value: createEscrowValue(args),
      });
      dispatch({ type: 'CREATE_SUBMITTED', txHash: createHash });

      const receipt = await publicClient?.waitForTransactionReceipt({ hash: createHash });
      if (!receipt || receipt.status !== 'success') {
        dispatch({ type: 'ERROR', kind: 'reverted', message: 'The transaction reverted on-chain' });
        return;
      }

      await fetch('/api/escrow/update-transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escrowId: createJson.escrowId, transactionHash: createHash }),
      });

      const createdEvents = parseEventLogs({ abi: riskEscrowAbi, eventName: 'RiskEscrowCreated', logs: receipt.logs });
      const dealId = createdEvents[0]?.args.dealId?.toString();
      if (!dealId) {
        dispatch({ type: 'ERROR', kind: 'unknown', message: 'Could not read the deal ID from the transaction' });
        return;
      }
      dispatch({ type: 'CREATE_MINED', dealId });
      startPolling(dealId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong';
      const userRejected = /user rejected|denied/i.test(message);
      dispatch({ type: 'ERROR', kind: userRejected ? 'user_rejected' : 'unknown', message });
    } finally {
      setSubmitting(false);
    }
  }

  function startPolling(dealId: string) {
    pollTimer.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/escrow/${dealId}`);
        const json = await res.json();
        if (json.success && json.confirmed) {
          if (pollTimer.current) clearInterval(pollTimer.current);
          dispatch({ type: 'INDEXED' });
          router.push(`/escrow/${dealId}`);
        }
      } catch {
        // transient - keep polling
      }
    }, POLL_INTERVAL_MS);
  }

  const canRequestQuote = isConnected && Boolean(counterparty) && Number(notional) > 0 && !wrongNetwork;

  const phaseLabel = useMemo(() => phaseLabels[state.phase] ?? state.phase, [state.phase]);

  return (
    <div className="space-y-6">
      {!CONTRACT_CONFIGURED ? (
        <Callout tone="warning" title="Settlement contract not configured">
          NEXT_PUBLIC_RISK_ESCROW_ADDRESS is unset or zero - deploy RiskEscrow locally and restart the app
          before creating a real escrow.
        </Callout>
      ) : null}

      {state.phase === 'editing' || state.phase === 'requesting_quote' || state.phase === 'error' ? (
        <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
          <Field label="Counterparty address">
            <Input
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder="0x..."
              disabled={state.phase === 'requesting_quote'}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Notional">
              <Input
                value={notional}
                onChange={(e) => setNotional(e.target.value)}
                placeholder="1.0"
                disabled={state.phase === 'requesting_quote'}
              />
            </Field>
            <Field label="Settlement asset">
              <Select
                value={assetAddress}
                onChange={(e) => setAssetAddress(e.target.value as typeof assetAddress)}
                disabled={state.phase === 'requesting_quote'}
              >
                {SETTLEMENT_ASSETS.map((a) => (
                  <option key={a.address} value={a.address}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Settlement horizon">
            <SegmentedControl options={HORIZON_OPTIONS} value={horizonDays} onChange={setHorizonDays} />
          </Field>

          {!isConnected ? (
            <Callout tone="info">Connect a wallet to request a risk quote.</Callout>
          ) : null}
          {wrongNetwork ? (
            <Callout tone="warning" title="Wrong network">
              Connected to the wrong chain.
              <button
                type="button"
                onClick={() => switchChainAsync({ chainId: ACTIVE_CHAIN.id })}
                className="ml-2 underline"
              >
                Switch to {ACTIVE_CHAIN.name}
              </button>
            </Callout>
          ) : null}
          {state.phase === 'error' && state.error ? (
            <Callout tone="critical" title={errorTitles[state.error.kind]}>
              {state.error.message}
            </Callout>
          ) : null}

          <Button onClick={requestQuote} disabled={!canRequestQuote || state.phase === 'requesting_quote'}>
            {state.phase === 'requesting_quote' ? 'Requesting quote…' : 'Request risk quote'}
          </Button>
        </div>
      ) : null}

      {(state.phase === 'quote_ready' || state.phase === 'quote_expired') && state.quote ? (
        <div className="space-y-4">
          <QuoteSummary issued={state.quote} asset={asset} />
          {state.phase === 'quote_expired' ? (
            <Callout tone="warning">This quote expired before you signed. Request a new one to continue.</Callout>
          ) : null}
          <div className="flex gap-3">
            {state.phase === 'quote_ready' ? (
              <Button onClick={proceed} disabled={submitting}>
                Continue to wallet
              </Button>
            ) : null}
            <Button variant="secondary" onClick={requestQuote} disabled={submitting}>
              {state.phase === 'quote_expired' ? 'Request a new quote' : 'Request a fresh quote'}
            </Button>
          </div>
        </div>
      ) : null}

      {[
        'awaiting_approval_signature',
        'approval_pending',
        'preparing',
        'awaiting_create_signature',
        'create_pending',
        'create_mined',
        'awaiting_confirmations',
      ].includes(state.phase) ? (
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-series-1" />
            <span className="text-sm text-slate-200">{phaseLabel}</span>
          </div>
          {state.createTxHash ? (
            <p className="font-mono text-xs text-slate-500">tx: {state.createTxHash}</p>
          ) : null}
        </div>
      ) : null}

      {state.phase === 'error' && state.quote ? (
        <Callout tone="critical" title={errorTitles[state.error?.kind ?? 'unknown']}>
          {state.error?.message}
        </Callout>
      ) : null}
    </div>
  );
}

const phaseLabels: Record<string, string> = {
  awaiting_approval_signature: 'Waiting for your approval signature…',
  approval_pending: 'Approval submitted, waiting for it to be mined…',
  preparing: 'Preparing the escrow…',
  awaiting_create_signature: 'Waiting for your signature to create the escrow…',
  create_pending: 'Transaction submitted, waiting for it to be mined…',
  create_mined: 'Mined - waiting for the chain indexer to confirm…',
  awaiting_confirmations: 'Waiting for the chain indexer to confirm…',
};

const errorTitles: Record<string, string> = {
  wrong_network: 'Wrong network',
  insufficient_balance: 'Insufficient balance',
  quote_rejected: 'Quote rejected',
  user_rejected: 'Signature declined',
  reverted: 'Transaction reverted',
  chain_clock_skew: 'Chain clock is off',
  service_unavailable: 'Service unavailable',
  unknown: 'Something went wrong',
};
