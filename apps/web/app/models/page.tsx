import { Suspense } from 'react';

import { GarchDiagnosticsSection } from '@/components/models/GarchDiagnosticsSection';
import { TailComparisonSection } from '@/components/models/TailComparisonSection';
import { VarBacktestSection } from '@/components/models/VarBacktestSection';
import { VolatilityComparisonSection } from '@/components/models/VolatilityComparisonSection';
import { Skeleton } from '@/components/ui/Skeleton';

export const dynamic = 'force-dynamic';

function SectionSkeleton({ note }: { note: string }) {
  return (
    <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-56 w-full" />
      <p className="text-xs text-slate-500">{note}</p>
    </div>
  );
}

export default function ModelsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-10 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">Model validation</h1>
        <p className="mt-1 text-sm text-slate-400">
          The quantitative evidence behind the risk engine - out-of-sample model comparisons, not a
          trading-strategy backtest. Each section below runs a real walk-forward evaluation; the first load
          after a restart can take longer than a cached one.
        </p>
      </div>

      <Suspense fallback={<SectionSkeleton note="Running the walk-forward volatility comparison..." />}>
        <VolatilityComparisonSection />
      </Suspense>

      <Suspense fallback={<SectionSkeleton note="Running the VaR backtest..." />}>
        <VarBacktestSection />
      </Suspense>

      <Suspense fallback={<SectionSkeleton note="Running the tail-risk comparison across methods..." />}>
        <TailComparisonSection />
      </Suspense>

      <Suspense fallback={<SectionSkeleton note="Loading the current model fit..." />}>
        <GarchDiagnosticsSection />
      </Suspense>
    </div>
  );
}
