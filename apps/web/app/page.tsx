// app/page.tsx
import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="max-w-3xl">
        <h1 className="text-3xl font-semibold text-slate-100 sm:text-4xl">Risk-aware crypto escrow</h1>
        <p className="mt-4 text-lg text-slate-400">
          Measuring and managing the market and settlement risk of crypto-denominated escrow under
          time-varying volatility and tail risk.
        </p>
        <div className="mt-6 flex gap-3">
          <Link
            href="/risk"
            className="rounded-md border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700"
          >
            View current risk
          </Link>
        </div>
      </div>

      <div className="mt-16 grid grid-cols-1 gap-6 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
          <h3 className="text-sm font-semibold text-slate-100">Quantitative risk</h3>
          <p className="mt-2 text-sm text-slate-400">
            Volatility modeling, Value at Risk, and Expected Shortfall drive the collateral required for
            every escrow.
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
          <h3 className="text-sm font-semibold text-slate-100">On-chain escrow</h3>
          <p className="mt-2 text-sm text-slate-400">
            Funds are locked in a settlement contract until settlement conditions are met, enforcing a
            signed, time-bound risk decision.
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
          <h3 className="text-sm font-semibold text-slate-100">Continuous monitoring</h3>
          <p className="mt-2 text-sm text-slate-400">
            A dedicated chain indexer reconciles confirmed on-chain state, so the dashboard reflects what
            actually settled, not just what was requested.
          </p>
        </div>
      </div>
    </div>
  );
}
