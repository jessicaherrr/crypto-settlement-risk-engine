import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { formatUtc } from '@/lib/format/time';
import { getGarchView } from '@/lib/server/risk-service';

const STALE_AFTER_DAYS = 3;

export async function GarchDiagnosticsSection() {
  const garch = await getGarchView();
  const nearIntegrated = garch.persistence >= 0.98;
  const stale = garch.staleness_days > STALE_AFTER_DAYS;

  return (
    <Card>
      <CardHeader>
        <CardTitle>GARCH(1,1) model diagnostics</CardTitle>
        <CardDescription>The currently fitted model - what live quotes are priced from.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat label="Persistence (α+β)" value={garch.persistence.toFixed(4)} tone={nearIntegrated ? 'warning' : 'neutral'} />
          <Stat label="Shock half-life" value={garch.half_life_days !== null ? `${garch.half_life_days.toFixed(1)}d` : '—'} />
          <Stat label="Log-likelihood" value={garch.diagnostics.log_likelihood?.toFixed(1) ?? '—'} />
          <Stat label="AIC / BIC" value={`${garch.diagnostics.aic?.toFixed(1) ?? '—'} / ${garch.diagnostics.bic?.toFixed(1) ?? '—'}`} />
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <div className="text-xs text-slate-500">omega</div>
            <div className="font-mono text-slate-200">{garch.params.omega.toExponential(3)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">alpha</div>
            <div className="font-mono text-slate-200">{garch.params.alpha.toFixed(4)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">beta</div>
            <div className="font-mono text-slate-200">{garch.params.beta.toFixed(4)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">mu</div>
            <div className="font-mono text-slate-200">{garch.params.mu.toExponential(3)}</div>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-400">
          <span>
            Training window: {garch.training_window.start.slice(0, 10)} to {garch.training_window.end.slice(0, 10)} (
            {garch.training_window.n_obs} obs)
          </span>
          <span>Refits every {garch.refit_frequency} observations</span>
          <span>Last fit: {formatUtc(garch.fit_timestamp)}</span>
          <span>
            Converged:{' '}
            <Badge tone={garch.diagnostics.converged === 1 ? 'positive' : 'critical'}>
              {garch.diagnostics.converged === 1 ? 'yes' : 'no'}
            </Badge>
          </span>
        </div>

        {nearIntegrated ? (
          <Callout tone="warning" title="Near-integrated fit">
            Persistence (α+β = {garch.persistence.toFixed(4)}) is close to 1 - the unconditional
            variance is large or undefined, and volatility shocks decay slowly. This is a legitimate fit
            outcome for crypto, not an error, but it means long-run volatility estimates are less reliable
            than the current conditional estimate.
          </Callout>
        ) : null}

        {stale ? (
          <Callout tone="warning" title="Model may be stale">
            The fitted model&apos;s latest observation is {garch.staleness_days} day(s) behind the latest
            available market data (as of {garch.meta.data_as_of.slice(0, 10)}).
          </Callout>
        ) : null}
      </CardContent>
    </Card>
  );
}
