import { notFound } from 'next/navigation';

import { EscrowActions } from '@/components/escrow/EscrowActions';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyableValue } from '@/components/ui/CopyableValue';
import { Timeline, type TimelineEntry } from '@/components/ui/Timeline';
import { shortAddress, shortHash } from '@/lib/format/address';
import { fromOnchainString, fromPythonDecimal } from '@/lib/format/sources';
import { formatFixed } from '@/lib/format/decimal';
import { formatTokenAmount } from '@/lib/format/money';
import { formatFraction } from '@/lib/format/percent';
import { formatUtc } from '@/lib/format/time';
import { ACTIVE_CHAIN, RISK_ESCROW_ADDRESS, explorerAddressUrl, explorerTxUrl } from '@/lib/chain/config';
import { riskEscrowAbi } from '@/lib/contracts/riskEscrowAbi';
import { deriveEscrowDisplayStatus, type LifecycleEventSummary } from '@/lib/escrow/status';
import { publicClient } from '@/lib/server/chain';
import { getEscrowByDealId, getEscrowEvents, getRiskQuoteById } from '@/lib/server/escrows';

export const dynamic = 'force-dynamic';

const EVENT_LABELS: Record<string, string> = {
  RiskEscrowCreated: 'Escrow created',
  RiskEscrowSettled: 'Escrow settled',
  RiskEscrowRefunded: 'Escrow refunded',
  RiskOracleUpdated: 'Risk oracle rotated',
  PlatformFeeUpdated: 'Platform fee updated',
  PlatformWalletUpdated: 'Platform wallet updated',
};

export default async function EscrowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();

  const escrow = await getEscrowByDealId(id);
  if (!escrow) notFound();

  const [events, riskQuote, liveDeal] = await Promise.all([
    getEscrowEvents(id),
    escrow.quote_id ? getRiskQuoteById(escrow.quote_id) : Promise.resolve(null),
    publicClient
      .readContract({ address: RISK_ESCROW_ADDRESS, abi: riskEscrowAbi, functionName: 'getDeal', args: [BigInt(id)] })
      .catch(() => null),
  ]);

  const lifecycleSummaries: LifecycleEventSummary[] = events
    .filter((e) => ['RiskEscrowCreated', 'RiskEscrowSettled', 'RiskEscrowRefunded'].includes(e.event_name))
    .map((e) => ({
      eventName: e.event_name as LifecycleEventSummary['eventName'],
      confirmationState: e.confirmation_state,
      isOrphaned: e.is_orphaned,
      blockNumber: e.block_number,
      logIndex: e.log_index,
    }));

  const displayStatus = deriveEscrowDisplayStatus({
    dbStatus: escrow.status as 'pending' | 'active' | 'settled' | 'refunded' | 'cancelled',
    hasSubmittedTx: Boolean(escrow.crypto_transaction_hash),
    events: lifecycleSummaries,
  });

  const notional = fromOnchainString(escrow.notional ?? '0', 18);
  const requiredCollateral = fromOnchainString(escrow.required_collateral ?? '0', 18);
  const buffer = { value: requiredCollateral.value - notional.value, decimals: 18 };

  const hashesMatch =
    liveDeal && escrow.risk_snapshot_hash
      ? (liveDeal as { riskSnapshotHash: string }).riskSnapshotHash.toLowerCase() === escrow.risk_snapshot_hash.toLowerCase()
      : null;

  const timelineEntries: TimelineEntry[] = events.map((e) => ({
    key: String(e.id),
    title: EVENT_LABELS[e.event_name] ?? e.event_name,
    timestamp: formatUtc(e.observed_at),
    tone: e.is_orphaned ? 'critical' : e.confirmation_state === 'confirmed' ? 'positive' : 'info',
    badge: e.is_orphaned ? 'orphaned (reorg)' : e.confirmation_state,
    detail: (
      <span>
        block {e.block_number} · <CopyableValue value={e.tx_hash} display={shortHash(e.tx_hash)} />
      </span>
    ),
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Escrow #{id}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {shortAddress(escrow.depositor_wallet_address)} → {shortAddress(escrow.counterparty_wallet_address)}
          </p>
        </div>
        <Badge tone={displayStatus.tone}>{displayStatus.label}</Badge>
      </div>
      <p className="text-sm text-slate-500">{displayStatus.detail}</p>

      <Card>
        <CardHeader>
          <CardTitle>Terms</CardTitle>
          <CardDescription>What this escrow actually locked up.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <Term label="Notional">{formatTokenAmount(notional, { symbol: 'ETH' })}</Term>
            <Term label="Collateral locked">{formatTokenAmount(requiredCollateral, { symbol: 'ETH' })}</Term>
            <Term label="Buffer">{formatTokenAmount(buffer, { symbol: 'ETH' })}</Term>
            <Term label="Depositor">
              <CopyableValue value={escrow.depositor_wallet_address} display={shortAddress(escrow.depositor_wallet_address)} />
            </Term>
            <Term label="Counterparty">
              <CopyableValue value={escrow.counterparty_wallet_address} display={shortAddress(escrow.counterparty_wallet_address)} />
            </Term>
            <Term label="Settlement deadline">
              {escrow.settlement_deadline ? formatUtc(escrow.settlement_deadline) : '—'}
            </Term>
          </dl>
        </CardContent>
      </Card>

      {riskQuote ? (
        <Card>
          <CardHeader>
            <CardTitle>Risk at issuance</CardTitle>
            <CardDescription>
              What the risk engine priced this escrow against, from the signed quote that created it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <Term label="Model version">{escrow.model_version ?? '—'}</Term>
              <Term label="Spot (USD)">
                {typeof riskQuote.model_output?.spot_price_usd === 'string'
                  ? formatFixed(fromPythonDecimal(riskQuote.model_output.spot_price_usd as string, 2), { minFrac: 2, maxFrac: 2 })
                  : '—'}
              </Term>
              <Term label="Value at Risk">
                {typeof riskQuote.model_output?.value_at_risk === 'string'
                  ? formatFraction(riskQuote.model_output.value_at_risk as string)
                  : '—'}
              </Term>
              <Term label="Expected Shortfall">
                {typeof riskQuote.model_output?.expected_shortfall === 'string'
                  ? formatFraction(riskQuote.model_output.expected_shortfall as string)
                  : '—'}
              </Term>
            </dl>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">On-chain risk snapshot hash matches issued quote:</span>
              {hashesMatch === null ? (
                <Badge tone="neutral">unknown (chain unreachable)</Badge>
              ) : hashesMatch ? (
                <Badge tone="positive">verified</Badge>
              ) : (
                <Badge tone="critical">mismatch</Badge>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Blockchain provenance</CardTitle>
          <CardDescription>Chain ID {escrow.chain_id ?? ACTIVE_CHAIN.id} · {ACTIVE_CHAIN.name}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <Term label="Contract">
              <ExplorerLink address value={escrow.contract_address ?? RISK_ESCROW_ADDRESS} />
            </Term>
            {escrow.creation_tx_hash ? (
              <Term label="Creation tx">
                <ExplorerLink value={escrow.creation_tx_hash} />
              </Term>
            ) : null}
            {escrow.settled_tx_hash ? (
              <Term label="Settlement tx">
                <ExplorerLink value={escrow.settled_tx_hash} />
              </Term>
            ) : null}
            {escrow.refunded_tx_hash ? (
              <Term label="Refund tx">
                <ExplorerLink value={escrow.refunded_tx_hash} />
              </Term>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lifecycle</CardTitle>
          <CardDescription>From the append-only chain-indexer event log.</CardDescription>
        </CardHeader>
        <CardContent>
          <Timeline entries={timelineEntries} />
        </CardContent>
      </Card>

      {displayStatus.confirmed && escrow.status === 'active' ? (
        <Card>
          <CardHeader>
            <CardTitle>Settle or refund</CardTitle>
          </CardHeader>
          <CardContent>
            <EscrowActions
              dealId={id}
              depositor={escrow.depositor_wallet_address}
              counterparty={escrow.counterparty_wallet_address}
              notional={notional.value}
              collateralLocked={requiredCollateral.value}
              settlementDeadline={escrow.settlement_deadline}
              confirmedStatus={escrow.status as 'active'}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-slate-200">{children}</dd>
    </div>
  );
}

function ExplorerLink({ value, address = false }: { value: string; address?: boolean }) {
  const url = address ? explorerAddressUrl(value) : explorerTxUrl(value);
  const display = address ? shortAddress(value) : shortHash(value);
  if (!url) return <CopyableValue value={value} display={display} />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-series-1 hover:underline">
      {display}
    </a>
  );
}
