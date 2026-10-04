"""Read-only analytics for the dashboard: everything `/v1/models/*` and
`/v1/risk/snapshot` expose. Pure orchestration - every number here comes
from an existing, independently-tested function (`validation/backtest.py`,
`validation/var_backtest.py`, `risk/engine.py`, `risk/stress.py`,
`policy/collateral.py`, `volatility/garch.py`); this module adds no new
quantitative logic, only HTTP-shaped reassembly plus caching (`cache.py`)
for the walk-forward backtests, which are real but non-trivial compute
(dozens of GARCH refits over the out-of-sample window) and shouldn't rerun
on every page load.

`AnalyticsInputs.fingerprint` is the cache key's third component: it
changes whenever the underlying data or the fitted model state changes, so
a cached result is never served past a refit or a new day's candle.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from decimal import Decimal
from time import perf_counter

import pandas as pd

from askgene_quant.config import (
    DEFAULT_VOLATILITY_SETTINGS,
    PERIODS_PER_YEAR,
    VolatilitySettings,
)
from askgene_quant.data.loader import load_market_data
from askgene_quant.data.quality import check_data_quality
from askgene_quant.data.returns import log_returns
from askgene_quant.models.pipeline import GarchVolatilityPipeline
from askgene_quant.models.state import ModelState
from askgene_quant.models.store import ModelStateStore
from askgene_quant.policy.collateral import (
    CollateralPolicyConfig,
    apply_collateral_policy,
)
from askgene_quant.risk.engine import (
    RiskEngineConfig,
    SimulationMethod,
    run_risk_engine,
)
from askgene_quant.risk.stress import run_stress_tests
from askgene_quant.service.cache import AnalyticsCache
from askgene_quant.service.quoting import DEFAULT_N_SCENARIOS, SUPPORTED_HORIZONS_DAYS
from askgene_quant.validation.backtest import run_volatility_backtest
from askgene_quant.validation.var_backtest import walk_forward_var_backtest
from askgene_quant.volatility.garch import GARCHParams, conditional_variance_path
from askgene_quant.volatility.realized import rolling_volatility

# How much of the conditional-volatility history to ship in
# /v1/models/garch - enough to draw a meaningful chart without sending the
# whole multi-year history on every request.
VOL_HISTORY_DAYS = 365

SUPPORTED_CONFIDENCES: tuple[float, ...] = (0.95, 0.99)
DEFAULT_CONFIDENCE = 0.99

_default_cache = AnalyticsCache()


@dataclass
class AnalyticsInputs:
    asset: str
    ohlcv: pd.DataFrame
    returns: pd.Series
    spot: Decimal
    state: ModelState
    params: GARCHParams
    settings: VolatilitySettings
    fingerprint: tuple


def load_analytics_inputs(
    asset: str = "ETH-USD",
    *,
    settings: VolatilitySettings = DEFAULT_VOLATILITY_SETTINGS,
    model_store: ModelStateStore | None = None,
) -> AnalyticsInputs:
    """Loads the same data/model state `service/quoting.generate_risk_quote`
    does, without signing anything - the shared starting point for every
    analytics endpoint below."""
    store = model_store or ModelStateStore()

    ohlcv = load_market_data(asset)
    check_data_quality(ohlcv).raise_if_invalid()
    returns = log_returns(ohlcv["close"])
    spot = Decimal(str(ohlcv["close"].iloc[-1]))

    pipeline = GarchVolatilityPipeline(asset, settings=settings, store=store)
    state = pipeline.load()
    if state is None:
        state = pipeline.fit(returns.iloc[-settings.garch_fitting_window :])
    params = GARCHParams(**state.fitted_params)

    fingerprint = (
        returns.index[-1].isoformat(),
        len(returns),
        state.fit_timestamp.isoformat(),
    )

    return AnalyticsInputs(
        asset=asset,
        ohlcv=ohlcv,
        returns=returns,
        spot=spot,
        state=state,
        params=params,
        settings=settings,
        fingerprint=fingerprint,
    )


def _var_to_vol(x: float) -> float:
    return math.sqrt(max(float(x), 0.0) * PERIODS_PER_YEAR)


def _meta(inputs: AnalyticsInputs, *, compute_ms: float, cache_hit: bool) -> dict:
    return {
        "asset": inputs.asset,
        "data_as_of": inputs.returns.index[-1].isoformat(),
        "n_returns": len(inputs.returns),
        "model_version": inputs.state.model_version,
        "fingerprint": "|".join(str(x) for x in inputs.fingerprint),
        "computed_at": datetime.now(UTC).isoformat(),
        "cache": "hit" if cache_hit else "miss",
        "compute_ms": round(compute_ms, 1),
    }


def _cached(
    cache: AnalyticsCache,
    name: str,
    inputs: AnalyticsInputs,
    params: tuple,
    compute: Callable[[], dict],
) -> dict:
    t0 = perf_counter()
    value, hit = cache.get_or_compute(
        name=name, params=params, fingerprint=inputs.fingerprint, compute=compute
    )
    compute_ms = (perf_counter() - t0) * 1000
    result = dict(value)
    result["meta"] = _meta(inputs, compute_ms=compute_ms, cache_hit=hit)
    return result


def build_garch_view(inputs: AnalyticsInputs, *, cache: AnalyticsCache | None = None) -> dict:
    """Current GARCH(1,1) fit: parameters, diagnostics, persistence/half-
    life, and a vol-history series (conditional vs. 30d realized)."""
    cache = cache or _default_cache

    def _compute() -> dict:
        state = inputs.state
        params = inputs.params
        persistence = params.persistence

        try:
            long_run_vol: float | None = math.sqrt(
                params.unconditional_variance * PERIODS_PER_YEAR
            )
        except ValueError:
            # Near-integrated or non-stationary fit (alpha+beta >= 1): the
            # unconditional variance is undefined, not an error condition
            # to hide - surfaced as a staleness/limitation signal instead.
            long_run_vol = None

        half_life_days = (
            math.log(0.5) / math.log(persistence) if 0 < persistence < 1 else None
        )
        current_vol = math.sqrt(state.latest_conditional_variance * PERIODS_PER_YEAR)

        data_as_of = inputs.returns.index[-1]
        model_as_of = pd.Timestamp(state.latest_observation_timestamp)
        if model_as_of.tzinfo is None:
            model_as_of = model_as_of.tz_localize("UTC")
        staleness_days = (data_as_of - model_as_of).days

        window = inputs.returns.iloc[-VOL_HISTORY_DAYS:]
        cond_var = conditional_variance_path(window, params)
        realized_vol_30d = rolling_volatility(inputs.returns, 30).reindex(window.index)

        vol_history = [
            {
                "date": ts.date().isoformat(),
                "conditional_vol": math.sqrt(max(float(v), 0.0) * PERIODS_PER_YEAR),
                "realized_vol_30d": float(r) if pd.notna(r) else None,
            }
            for ts, v, r in zip(window.index, cond_var, realized_vol_30d)
        ]

        return {
            "params": params.model_dump(),
            "persistence": persistence,
            "half_life_days": half_life_days,
            "current_vol_annualized": current_vol,
            "long_run_vol_annualized": long_run_vol,
            "diagnostics": dict(state.fit_diagnostics),
            "training_window": {
                "start": state.training_window_start.isoformat(),
                "end": state.training_window_end.isoformat(),
                "n_obs": state.n_obs_fit,
            },
            "refit_frequency": inputs.settings.garch_refit_frequency,
            "fit_timestamp": state.fit_timestamp.isoformat(),
            "staleness_days": staleness_days,
            "vol_history": vol_history,
        }

    return _cached(cache, "garch_view", inputs, (), _compute)


def build_risk_snapshot(
    inputs: AnalyticsInputs,
    confidence: float = DEFAULT_CONFIDENCE,
    *,
    cache: AnalyticsCache | None = None,
) -> dict:
    """Per-horizon VaR/ES/stress/collateral for a notional of 1 unit -
    exactly `service/quoting.generate_risk_quote`'s pipeline, run unsigned
    across every supported horizon for display rather than once for a
    binding quote."""
    cache = cache or _default_cache

    def _compute() -> dict:
        policy = CollateralPolicyConfig(confidence_level=confidence)
        horizons = []
        for h in SUPPORTED_HORIZONS_DAYS:
            engine_config = RiskEngineConfig(
                simulation_method=SimulationMethod.FILTERED_HISTORICAL,
                confidence_levels=(confidence,),
                primary_confidence=confidence,
                n_scenarios=DEFAULT_N_SCENARIOS,
                seed=42,
            )
            risk_result = run_risk_engine(
                asset=inputs.asset,
                spot_price_usd=inputs.spot,
                horizon_days=h,
                returns=inputs.returns,
                garch_params=inputs.params,
                model_state=inputs.state,
                config=engine_config,
            )
            stress_summary = run_stress_tests(
                returns=inputs.returns,
                garch_params=inputs.params,
                model_state=inputs.state,
                horizon_days=h,
                confidence=confidence,
                n_scenarios=DEFAULT_N_SCENARIOS,
                seed=42,
            )

            es = risk_result.es_at(confidence)
            stress_loss = Decimal(str(stress_summary.worst_loss_fraction))
            decision = apply_collateral_policy(
                notional=Decimal(1),
                es_loss_fraction=es,
                stress_loss_fraction=stress_loss,
                policy=policy,
            )
            weighted_es = es * policy.es_buffer_multiplier
            weighted_stress = stress_loss * policy.stress_buffer_multiplier
            loss_basis_source = (
                "expected_shortfall" if weighted_es >= weighted_stress else "stress"
            )

            horizons.append(
                {
                    "horizon_days": h,
                    "forecast_volatility_annualized": str(
                        risk_result.forecast_volatility_annualized
                    ),
                    "value_at_risk": str(risk_result.var_at(confidence)),
                    "expected_shortfall": str(es),
                    "stress_loss": str(stress_loss),
                    "worst_stress_scenario": stress_summary.worst_scenario_name,
                    "loss_basis_source": loss_basis_source,
                    "collateral_ratio": str(decision.collateral_ratio),
                    "required_collateral_per_unit": str(decision.required_collateral),
                    "stress_scenarios": [
                        {
                            "name": s.name,
                            "description": s.description,
                            "loss_fraction": s.loss_fraction,
                        }
                        for s in stress_summary.scenarios
                    ],
                }
            )

        return {
            "spot_price_usd": str(inputs.spot),
            "confidence_level": confidence,
            "model_version": inputs.state.model_version,
            "simulation_method": str(SimulationMethod.FILTERED_HISTORICAL.value),
            "policy": {
                "es_buffer_multiplier": str(policy.es_buffer_multiplier),
                "stress_buffer_multiplier": str(policy.stress_buffer_multiplier),
                "min_collateral_ratio": str(policy.min_collateral_ratio),
                "max_collateral_ratio": str(policy.max_collateral_ratio),
                "rounding_decimals": policy.rounding_decimals,
            },
            "horizons": horizons,
        }

    return _cached(cache, "risk_snapshot", inputs, (confidence,), _compute)


def build_volatility_comparison(
    inputs: AnalyticsInputs, *, cache: AnalyticsCache | None = None
) -> dict:
    """Out-of-sample RMSE/QLIKE comparison of rolling-historical, EWMA,
    and GARCH(1,1) volatility (`validation/backtest.run_volatility_backtest`)."""
    cache = cache or _default_cache

    def _compute() -> dict:
        result = run_volatility_backtest(inputs.returns, settings=inputs.settings)
        series = [
            {
                "date": ts.date().isoformat(),
                "proxy_vol": _var_to_vol(row["proxy"]),
                "rolling_hist_vol": _var_to_vol(row["rolling_hist_vol"]),
                "ewma": _var_to_vol(row["ewma"]),
                "garch": _var_to_vol(row["garch"]),
            }
            for ts, row in result.forecasts.iterrows()
        ]
        return {
            "oos_start": result.oos_start.isoformat(),
            "oos_end": result.oos_end.isoformat(),
            "n_oos": result.n_oos,
            "proxy": "squared_log_return",
            "metrics": result.metrics,
            "series": series,
        }

    return _cached(cache, "volatility_comparison", inputs, (), _compute)


def build_var_backtest(
    inputs: AnalyticsInputs,
    confidences: tuple[float, ...] = SUPPORTED_CONFIDENCES,
    *,
    cache: AnalyticsCache | None = None,
) -> dict:
    """Walk-forward 1-day VaR/ES backtest - Kupiec coverage test plus the
    ES predicted-vs-realized diagnostic - at each requested confidence
    (`validation/var_backtest.walk_forward_var_backtest`)."""
    cache = cache or _default_cache
    primary = max(confidences)

    def _compute() -> dict:
        results = []
        series: list[dict] = []
        for c in confidences:
            r = walk_forward_var_backtest(inputs.returns, confidence=c, settings=inputs.settings)
            results.append(
                {
                    "confidence": c,
                    "oos_start": r.oos_start.isoformat(),
                    "oos_end": r.oos_end.isoformat(),
                    "kupiec": asdict(r.kupiec),
                    "expected_shortfall": asdict(r.expected_shortfall),
                }
            )
            if c == primary:
                series = [
                    {
                        "date": ts.date().isoformat(),
                        "return": float(row["return"]),
                        "var_loss": float(row["var_loss"]),
                        "es_loss": float(row["es_loss"]),
                        "exceed": bool(row["exceed"]),
                    }
                    for ts, row in r.forecasts.iterrows()
                ]

        return {
            "horizon_days": 1,
            "results": results,
            "series": series,
            "assumptions": [
                (
                    "Computed at a 1-day horizon only. Multi-day VaR uses overlapping "
                    "windows whose exceedance indicators are not independent, which "
                    "would make the Kupiec test's p-value numerically well-defined "
                    "but not statistically meaningful."
                ),
                (
                    "The Kupiec test assumes exceedances are i.i.d. Bernoulli trials "
                    "at the stated confidence level."
                ),
            ],
        }

    return _cached(cache, "var_backtest", inputs, tuple(sorted(confidences)), _compute)


def build_tail_comparison(
    inputs: AnalyticsInputs,
    confidences: tuple[float, ...] = SUPPORTED_CONFIDENCES,
    *,
    cache: AnalyticsCache | None = None,
) -> dict:
    """Horizon x method VaR/ES comparison across historical simulation,
    filtered historical simulation (what live quotes use), and the GBM
    benchmark - i.e. the comparison `scripts/run_risk_pipeline.py` already
    prints, as structured data."""
    cache = cache or _default_cache
    primary = max(confidences)

    def _compute() -> dict:
        rows = []
        for h in SUPPORTED_HORIZONS_DAYS:
            for method in SimulationMethod:
                engine_config = RiskEngineConfig(
                    simulation_method=method,
                    confidence_levels=tuple(confidences),
                    primary_confidence=primary,
                    n_scenarios=DEFAULT_N_SCENARIOS,
                    seed=42,
                )
                result = run_risk_engine(
                    asset=inputs.asset,
                    spot_price_usd=inputs.spot,
                    horizon_days=h,
                    returns=inputs.returns,
                    garch_params=inputs.params,
                    model_state=inputs.state,
                    config=engine_config,
                )
                rows.append(
                    {
                        "horizon_days": h,
                        "method": str(method.value),
                        "var": {k: str(v) for k, v in result.var.items()},
                        "expected_shortfall": {
                            k: str(v) for k, v in result.expected_shortfall.items()
                        },
                        "forecast_volatility_annualized": str(
                            result.forecast_volatility_annualized
                        ),
                    }
                )
        return {"n_scenarios": DEFAULT_N_SCENARIOS, "rows": rows}

    return _cached(cache, "tail_comparison", inputs, tuple(sorted(confidences)), _compute)
