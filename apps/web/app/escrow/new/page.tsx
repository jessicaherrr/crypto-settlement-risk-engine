import { NewEscrowFlow } from '@/components/escrow/NewEscrowFlow';
import { Callout } from '@/components/ui/Callout';
import { formatFixed, parseDecimalString } from '@/lib/format/decimal';
import { getRiskSnapshot } from '@/lib/server/risk-service';

function formatRatio(ratio: string): string {
  return `${formatFixed(parseDecimalString(ratio, 6), { minFrac: 2, maxFrac: 2 })}×`;
}

export const dynamic = 'force-dynamic';

export default async function NewEscrowPage() {
  let preview: Awaited<ReturnType<typeof getRiskSnapshot>> | null = null;
  try {
    preview = await getRiskSnapshot();
  } catch {
    preview = null;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-10 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">New escrow</h1>
        <p className="mt-1 text-sm text-slate-400">
          Request a real, signed risk quote, review the collateral it requires, then submit it on-chain.
        </p>
      </div>

      {preview ? (
        <Callout tone="neutral" title="Indicative collateral ratios right now">
          {preview.horizons.map((h) => `${h.horizon_days}d: ${formatRatio(h.collateral_ratio)}`).join('  ·  ')}
          {' '}- the real quote below will be priced for your exact notional and horizon.
        </Callout>
      ) : null}

      <NewEscrowFlow />
    </div>
  );
}
