import 'server-only';

import { z } from 'zod';

// The Python risk-oracle service (quant/src/askgene_quant/service/app.py).
// Only ever called from server code (Server Components, API routes) -
// RISK_SERVICE_URL and everything it returns stays server-side until a
// page explicitly passes the data it needs down as props. See that
// service's `service/analytics.py` for what actually computes each of
// these; this file is just a typed, validated client for it.
const RISK_SERVICE_URL = process.env.RISK_SERVICE_URL || 'http://localhost:8001';

const MetaSchema = z.object({
  asset: z.string(),
  data_as_of: z.string(),
  n_returns: z.number(),
  model_version: z.string(),
  fingerprint: z.string(),
  computed_at: z.string(),
  cache: z.enum(['hit', 'miss']),
  compute_ms: z.number(),
});

export const OracleHealthSchema = z.object({
  status: z.string(),
  oracle_address: z.string(),
  data_as_of: z.string(),
  model_fit_timestamp: z.string(),
});
export type OracleHealth = z.infer<typeof OracleHealthSchema>;

export const GarchViewSchema = z.object({
  params: z.object({ omega: z.number(), alpha: z.number(), beta: z.number(), mu: z.number() }),
  persistence: z.number(),
  half_life_days: z.number().nullable(),
  current_vol_annualized: z.number(),
  long_run_vol_annualized: z.number().nullable(),
  diagnostics: z.record(z.string(), z.number()),
  training_window: z.object({ start: z.string(), end: z.string(), n_obs: z.number() }),
  refit_frequency: z.number(),
  fit_timestamp: z.string(),
  staleness_days: z.number(),
  vol_history: z.array(
    z.object({
      date: z.string(),
      conditional_vol: z.number(),
      realized_vol_30d: z.number().nullable(),
    })
  ),
  meta: MetaSchema,
});
export type GarchView = z.infer<typeof GarchViewSchema>;

const StressScenarioSchema = z.object({
  name: z.string(),
  description: z.string(),
  loss_fraction: z.number(),
});

export const RiskSnapshotSchema = z.object({
  spot_price_usd: z.string(),
  confidence_level: z.number(),
  model_version: z.string(),
  simulation_method: z.string(),
  policy: z.object({
    es_buffer_multiplier: z.string(),
    stress_buffer_multiplier: z.string(),
    min_collateral_ratio: z.string(),
    max_collateral_ratio: z.string(),
    rounding_decimals: z.number(),
  }),
  horizons: z.array(
    z.object({
      horizon_days: z.number(),
      forecast_volatility_annualized: z.string(),
      value_at_risk: z.string(),
      expected_shortfall: z.string(),
      stress_loss: z.string(),
      worst_stress_scenario: z.string(),
      loss_basis_source: z.enum(['expected_shortfall', 'stress']),
      collateral_ratio: z.string(),
      required_collateral_per_unit: z.string(),
      stress_scenarios: z.array(StressScenarioSchema),
    })
  ),
  meta: MetaSchema,
});
export type RiskSnapshot = z.infer<typeof RiskSnapshotSchema>;
export type RiskSnapshotHorizon = RiskSnapshot['horizons'][number];

export const VolatilityComparisonSchema = z.object({
  oos_start: z.string(),
  oos_end: z.string(),
  n_oos: z.number(),
  proxy: z.string(),
  metrics: z.record(z.string(), z.object({ rmse: z.number(), qlike: z.number() })),
  series: z.array(
    z.object({
      date: z.string(),
      proxy_vol: z.number(),
      rolling_hist_vol: z.number(),
      ewma: z.number(),
      garch: z.number(),
    })
  ),
  meta: MetaSchema,
});
export type VolatilityComparison = z.infer<typeof VolatilityComparisonSchema>;

const KupiecSchema = z.object({
  n_obs: z.number(),
  n_exceedances: z.number(),
  exceedance_rate: z.number(),
  expected_rate: z.number(),
  lr_statistic: z.number(),
  p_value: z.number(),
  reject_at_5pct: z.boolean(),
});

const EsBacktestSchema = z.object({
  n_exceedances: z.number(),
  predicted_es: z.number(),
  realized_es: z.number().nullable(),
  ratio: z.number().nullable(),
});

export const VarBacktestSchema = z.object({
  horizon_days: z.number(),
  results: z.array(
    z.object({
      confidence: z.number(),
      oos_start: z.string(),
      oos_end: z.string(),
      kupiec: KupiecSchema,
      expected_shortfall: EsBacktestSchema,
    })
  ),
  series: z.array(
    z.object({
      date: z.string(),
      return: z.number(),
      var_loss: z.number(),
      es_loss: z.number(),
      exceed: z.boolean(),
    })
  ),
  assumptions: z.array(z.string()),
  meta: MetaSchema,
});
export type VarBacktest = z.infer<typeof VarBacktestSchema>;

export const TailComparisonSchema = z.object({
  n_scenarios: z.number(),
  rows: z.array(
    z.object({
      horizon_days: z.number(),
      method: z.string(),
      var: z.record(z.string(), z.string()),
      expected_shortfall: z.record(z.string(), z.string()),
      forecast_volatility_annualized: z.string(),
    })
  ),
  meta: MetaSchema,
});
export type TailComparison = z.infer<typeof TailComparisonSchema>;

async function fetchJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${RISK_SERVICE_URL}${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new Error(
      `Could not reach the risk service at ${RISK_SERVICE_URL}${path}. Is it running? ` +
        '(cd quant && .venv/bin/uvicorn askgene_quant.service.app:app --port 8001)',
      { cause }
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Risk service ${path} returned ${response.status}: ${body}`);
  }
  const json = await response.json();
  return schema.parse(json);
}

export function getOracleHealth(): Promise<OracleHealth> {
  return fetchJson('/v1/health', OracleHealthSchema);
}

export function getGarchView(asset = 'ETH-USD'): Promise<GarchView> {
  return fetchJson(`/v1/models/garch?asset=${encodeURIComponent(asset)}`, GarchViewSchema);
}

export function getRiskSnapshot(confidence = 0.99, asset = 'ETH-USD'): Promise<RiskSnapshot> {
  return fetchJson(
    `/v1/risk/snapshot?asset=${encodeURIComponent(asset)}&confidence=${confidence}`,
    RiskSnapshotSchema
  );
}

export function getVolatilityComparison(asset = 'ETH-USD'): Promise<VolatilityComparison> {
  return fetchJson(`/v1/validation/volatility?asset=${encodeURIComponent(asset)}`, VolatilityComparisonSchema);
}

export function getVarBacktest(asset = 'ETH-USD'): Promise<VarBacktest> {
  return fetchJson(`/v1/validation/var-backtest?asset=${encodeURIComponent(asset)}`, VarBacktestSchema);
}

export function getTailComparison(asset = 'ETH-USD'): Promise<TailComparison> {
  return fetchJson(`/v1/validation/tail-comparison?asset=${encodeURIComponent(asset)}`, TailComparisonSchema);
}
