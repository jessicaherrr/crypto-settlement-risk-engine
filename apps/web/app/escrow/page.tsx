import Link from 'next/link';

import { EscrowListTable, type EscrowListRow } from '@/components/escrow/EscrowListTable';
import { IndexerHealthPanel } from '@/components/system/IndexerHealthPanel';
import { Button } from '@/components/ui/Button';
import { listRecentEscrows } from '@/lib/server/escrows';

export const dynamic = 'force-dynamic';

export default async function EscrowListPage() {
  const escrows = await listRecentEscrows({ limit: 50 });
  const rows: EscrowListRow[] = escrows.map((e) => ({
    id: e.id,
    onChainDealId: e.on_chain_deal_id,
    depositor: e.depositor_wallet_address,
    counterparty: e.counterparty_wallet_address,
    notional: e.notional,
    status: e.status as EscrowListRow['status'],
    hasSubmittedTx: Boolean(e.crypto_transaction_hash),
    createdAt: e.created_at,
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Escrows</h1>
          <p className="mt-1 text-sm text-slate-400">Recent escrows, ordered by creation time.</p>
        </div>
        <Link href="/escrow/new">
          <Button>New escrow</Button>
        </Link>
      </div>

      <IndexerHealthPanel />
      <EscrowListTable rows={rows} />
    </div>
  );
}
