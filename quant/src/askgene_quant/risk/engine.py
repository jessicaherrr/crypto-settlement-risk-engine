"""Risk engine: volatility state -> settlement-value return distribution
-> VaR / Expected Shortfall.

Three interchangeable return-distribution methods (`simulation/`):

- ``historical``: empirical overlapping horizon-day returns from real
  history. No distributional assumption, but limited by how much history
  exists and by overlap-induced dependence between scenarios.
- ``filtered_historical`` (default): GARCH-filtered conditional variance
  path driven by bootstrapped empirical standardized residuals. Combines
  time-varying volatility with the empirical (fat-tailed) shock
  distribution; the primary method this engine is built around.
- ``gbm``: i.i.d.-Normal Monte Carlo benchmark. Deliberately the *weakest*
  model here (no clustering, no fat tails) - it exists so the other two
  methods' results can be read relative to a naive baseline, not because
  it is the preferred crypto risk model.

This module only produces a `RiskResult`: a conditional loss distribution
and the VaR/ES figures read off it. It does not decide what collateral
that implies - see `policy/collateral.py` for the separate policy layer
that consumes a `RiskResult`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from enum import Enum

import numpy as np
import pandas as pd
from pydantic import BaseModel, ConfigDict, Field

from askgene_quant.config import PERIODS_PER_YEAR
from askgene_quant.models.state import ModelState
from askgene_quant.risk.measures import expected_shortfall, value_at_risk
from askgene_quant.simulation.filtered_historical import (
    simulate_fhs_horizon_log_returns,
    standardized_residuals,
)
from askgene_quant.simulation.gbm import gbm_horizon_log_returns
from askgene_quant.simulation.historical import historical_horizon_log_returns
from askgene_quant.volatility.garch import GARCHParams

DEFAULT_CONFIDENCE_LEVELS: tuple[float, ...] = (0.95, 0.99)
DEFAULT_PRIMARY_CONFIDENCE = 0.99


class SimulationMethod(str, Enum):
    HISTORICAL = "historical_simulation"
    FILTERED_HISTORICAL = "filtered_historical_simulation"
    GBM = "gbm_monte_carlo"


class RiskEngineConfig(BaseModel):
    simulation_method: SimulationMethod = SimulationMethod.FILTERED_HISTORICAL
    confidence_levels: tuple[float, ...] = DEFAULT_CONFIDENCE_LEVELS
    primary_confidence: float = DEFAULT_PRIMARY_CONFIDENCE
    n_scenarios: int = 50_000
    seed: int = 42
    # FHS only: how much history to draw the empirical-residual pool from.
    # None = use every return passed to run_risk_engine. A long pool
    # deliberately spans multiple crypto cycles (2018 drawdown, 2020 COVID
    # crash, 2022 Terra/FTX) so tail scenarios aren't limited to the
    # (shorter) GARCH parameter-fitting window.
    residual_pool_window: int | None = None


DEFAULT_RISK_ENGINE_CONFIG = RiskEngineConfig()


class RiskResult(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    asset: str
    spot_price_usd: Decimal
    horizon_days: int
    simulation_method: SimulationMethod
    n_scenarios: int
    model_name: str
    model_version: str
    forecast_volatility_annualized: Decimal
    confidence_levels: list[float]
    var: dict[str, Decimal] = Field(default_factory=dict)
    expected_shortfall: dict[str, Decimal] = Field(default_factory=dict)
    simple_return_percentiles: dict[str, Decimal] = Field(default_factory=dict)
    as_of: datetime
    seed: int

    def var_at(self, confidence: float) -> Decimal:
        return self.var[_conf_key(confidence)]

    def es_at(self, confidence: float) -> Decimal:
        return self.expected_shortfall[_conf_key(confidence)]


def _conf_key(confidence: float) -> str:
    return f"{confidence:.4f}"


@dataclass
class _ScenarioOutput:
    log_returns: np.ndarray
    n_scenarios: int


def _generate_scenarios(
    *,
    method: SimulationMethod,
    returns: pd.Series,
    horizon_days: int,
    garch_params: GARCHParams,
    model_state: ModelState,
    config: RiskEngineConfig,
    rng: np.random.Generator,
) -> _ScenarioOutput:
    if method == SimulationMethod.HISTORICAL:
        log_returns = historical_horizon_log_returns(returns, horizon_days)
        return _ScenarioOutput(log_returns, len(log_returns))

    if method == SimulationMethod.FILTERED_HISTORICAL:
        pool_returns = (
            returns
            if config.residual_pool_window is None
            else returns.iloc[-config.residual_pool_window :]
        )
        residual_pool = standardized_residuals(pool_returns, garch_params)
        log_returns = simulate_fhs_horizon_log_returns(
            params=garch_params,
            last_sigma2=model_state.latest_conditional_variance,
            last_eps2=model_state.latest_squared_residual or 0.0,
            residual_pool=residual_pool,
            horizon_days=horizon_days,
            n_scenarios=config.n_scenarios,
            rng=rng,
        )
        return _ScenarioOutput(log_returns, config.n_scenarios)

    if method == SimulationMethod.GBM:
        annual_vol = float(np.sqrt(model_state.latest_conditional_variance * PERIODS_PER_YEAR))
        mu_annual = float(returns.mean()) * PERIODS_PER_YEAR
        log_returns = gbm_horizon_log_returns(
            mu_annual=mu_annual,
            sigma_annual=annual_vol,
            horizon_days=horizon_days,
            n_scenarios=config.n_scenarios,
            rng=rng,
        )
        return _ScenarioOutput(log_returns, config.n_scenarios)

    raise ValueError(f"unknown simulation method: {method}")  # pragma: no cover


def run_risk_engine(
    *,
    asset: str,
    spot_price_usd: Decimal,
    horizon_days: int,
    returns: pd.Series,
    garch_params: GARCHParams,
    model_state: ModelState,
    config: RiskEngineConfig = DEFAULT_RISK_ENGINE_CONFIG,
) -> RiskResult:
    """Produce the conditional settlement-value loss distribution and
    read VaR/ES off it for one (asset, horizon) pair.

    ``returns`` is the full historical return series available as of
    "now"; ``garch_params`` / ``model_state`` are the currently fitted and
    filtered GARCH(1,1) state (`models.pipeline.GarchVolatilityPipeline`).
    """
    if horizon_days < 1:
        raise ValueError(f"horizon_days must be >= 1, got {horizon_days}")

    rng = np.random.default_rng(config.seed)
    scenarios = _generate_scenarios(
        method=config.simulation_method,
        returns=returns,
        horizon_days=horizon_days,
        garch_params=garch_params,
        model_state=model_state,
        config=config,
        rng=rng,
    )

    # Settlement value depends on the simple (percentage) return, not the
    # log return the simulators produce internally - see module docstring.
    simple_returns = np.exp(scenarios.log_returns) - 1.0

    forecast_vol = float(np.sqrt(model_state.latest_conditional_variance * PERIODS_PER_YEAR))

    var = {
        _conf_key(c): Decimal(str(value_at_risk(simple_returns, c))) for c in config.confidence_levels
    }
    es = {
        _conf_key(c): Decimal(str(expected_shortfall(simple_returns, c))) for c in config.confidence_levels
    }
    percentiles = {
        str(p): Decimal(str(float(np.percentile(simple_returns, p))))
        for p in (1, 5, 25, 50, 75, 95, 99)
    }

    return RiskResult(
        asset=asset,
        spot_price_usd=spot_price_usd,
        horizon_days=horizon_days,
        simulation_method=config.simulation_method,
        n_scenarios=scenarios.n_scenarios,
        model_name="garch_1_1",
        model_version=model_state.model_version,
        forecast_volatility_annualized=Decimal(str(forecast_vol)),
        confidence_levels=list(config.confidence_levels),
        var=var,
        expected_shortfall=es,
        simple_return_percentiles=percentiles,
        as_of=datetime.now(UTC),
        seed=config.seed,
    )
