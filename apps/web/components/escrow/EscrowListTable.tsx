'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAccount } from 'wagmi';

import { Badge } from '@/components/ui/Badge';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/Table';
import { isSameAddress, shortAddress } from '@/lib/format/address';
import { fromOnchainString } from '@/lib/format/sources';
import { formatTokenAmount } from '@/lib/format/money';
import { deriveEscrowDisplayStatus } from '@/lib/escrow/status';

export interface EscrowListRow {
  id: string;
  onChainDealId: string | null;
  depositor: string;
  counterparty: string;
  notional: string | null;
  status: 'pending' | 'active' | 'settled' | 'refunded' | 'cancelled';
  hasSubmittedTx: boolean;
  createdAt: string;
}

export function EscrowListTable({ rows }: { rows: EscrowListRow[] }) {
  const { address } = useAccount();
  const [onlyMine, setOnlyMine] = useState(false);

  const visible = useMemo(() => {
    if (!onlyMine || !address) return rows;
    return rows.filter((row) => isSameAddress(address, row.depositor) || isSameAddress(address, row.counterparty));
  }, [rows, onlyMine, address]);

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-slate-400">
        <input
          type="checkbox"
          checked={onlyMine}
          onChange={(e) => setOnlyMine(e.target.checked)}
          disabled={!address}
          className="rounded border-slate-700 bg-slate-950"
        />
        Only mine
      </label>

      {visible.length === 0 ? (
        <p className="text-sm text-slate-500">No escrows to show.</p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Deal</TH>
              <TH>Parties</TH>
              <TH numeric>Notional</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {visible.map((row) => {
              const display = deriveEscrowDisplayStatus({
                dbStatus: row.status,
                hasSubmittedTx: row.hasSubmittedTx,
                events: [],
              });
              const notional = row.notional ? fromOnchainString(row.notional, 18) : null;
              return (
                <TR key={row.id}>
                  <TD>
                    {row.onChainDealId ? (
                      <Link href={`/escrow/${row.onChainDealId}`} className="text-series-1 hover:underline">
                        #{row.onChainDealId}
                      </Link>
                    ) : (
                      <span className="text-slate-500">not yet on-chain</span>
                    )}
                  </TD>
                  <TD className="font-mono text-xs">
                    {shortAddress(row.depositor)} → {shortAddress(row.counterparty)}
                  </TD>
                  <TD numeric>{notional ? formatTokenAmount(notional, { symbol: 'ETH' }) : '—'}</TD>
                  <TD>
                    <Badge tone={display.tone}>{display.label}</Badge>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
