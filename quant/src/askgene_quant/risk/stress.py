"""Stress testing: deliberately adverse scenarios outside the "normal"
conditional loss distribution that `risk/engine.py` produces.

Four scenario families, each probing a different failure mode:

- **Historical worst case** - the worst realized multi-day ETH move that
  has actually happened, read directly off real data (no assumption at
  all, just "it happened before").
- **Volatility shock** - what if annualized volatility is instantaneously
  2x/3x its current GARCH-filtered level, independent of whether the
  current fitted dynamics would ever imply that. Modeled parametrically
  (GBM with the shocked vol) rather than through FHS, because FHS's whole
  point is pricing the *current* regime - a vol shock is explicitly a
  deviation from it, not a resample of recent history.
- **Gap-down shock** - an instantaneous, model-independent price drop
  (exchange insolvency, stablecoin depeg, a forced liquidation cascade)
  applied directly to spot. This exists because such events are not
  reliably present in the sampled return history and a continuous-path
  model (GBM or GARCH) cannot produce a true discontinuity.
- **Extended horizon** - the same FHS engine, run at a longer horizon than
  requested, to show how tail loss grows if settlement is delayed.

Every scenario reports a single loss fraction (of notional) plus
scenario-specific detail for transparency; `risk/stress.py` does not pick a
"the" stress number - `policy/collateral.py` decides how stress results
feed into required collateral.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from askgene_quant.config import PERIODS_PER_YEAR
from askgene_quant.models.state import ModelState
from askgene_quant.risk.measures import expected_shortfall
from askgene_quant.simulation.filtered_historical import (
    simulate_fhs_horizon_log_returns,
    standardized_residuals,
)
from askgene_quant.simulation.gbm import gbm_horizon_log_returns
from askgene_quant.volatility.garch import GARCHParams

DEFAULT_VOL_SHOCK_MULTIPLIERS: tuple[float, ...] = (2.0, 3.0)
DEFAULT_GAP_DOWN_SHOCKS: tuple[float, ...] = (0.30, 0.50)
DEFAULT_LONGER_HORIZON_MULTIPLIER = 2.0


@dataclass
class StressScenarioResult:
    name: str
    description: str
    loss_fraction: float  # positive loss fraction of notional
    detail: dict = field(default_factory=dict)


@dataclass
class StressTestSummary:
    horizon_days: int
    scenarios: list[StressScenarioResult]
    worst_loss_fraction: float
    worst_scenario_name: str


def historical_worst_case(returns: pd.Series, horizon_days: int) -> StressScenarioResult:
    """Worst realized overlapping ``horizon_days``-day move in ``returns``,
    reported with the actual calendar window it occurred in."""
    cum_log = returns.rolling(window=horizon_days).sum().dropna()
    worst_log_return = float(cum_log.min())
    worst_end = cum_log.idxmin()
    end_pos = returns.index.get_loc(worst_end)
    start_pos = end_pos - horizon_days + 1
    window_start = returns.index[start_pos]

    loss_fraction = max(-(np.exp(worst_log_return) - 1.0), 0.0)
    return StressScenarioResult(
        name=f"historical_worst_case_{horizon_days}d",
        description=(
            f"Worst realized {horizon_days}-day ETH move in the available history "
            f"({window_start.date()} to {worst_end.date()})"
        ),
        loss_fraction=loss_fraction,
        detail={
            "window_start": str(window_start.date()),
            "window_end": str(worst_end.date()),
            "cumulative_log_return": worst_log_return,
        },
    )


def volatility_shock_scenario(
    *,
    current_annual_vol: float,
    shock_multiplier: float,
    horizon_days: int,
    confidence: float,
    n_scenarios: int,
    rng: np.random.Generator,
) -> StressScenarioResult:
    """Expected Shortfall at ``confidence`` under annualized volatility
    shocked to ``shock_multiplier`` times its current GARCH-filtered
    level. Drift is set to zero (conservative: a stress scenario should
    not rely on an expected-positive-drift offset)."""
    shocked_vol = current_annual_vol * shock_multiplier
    log_returns = gbm_horizon_log_returns(
        mu_annual=0.0,
        sigma_annual=shocked_vol,
        horizon_days=horizon_days,
        n_scenarios=n_scenarios,
        rng=rng,
    )
    simple_returns = np.exp(log_returns) - 1.0
    loss = expected_shortfall(simple_returns, confidence)
    return StressScenarioResult(
        name=f"vol_shock_{shock_multiplier:g}x",
        description=(
            f"Expected Shortfall at {confidence:.0%} if annualized volatility "
            f"jumps to {shock_multiplier:g}x its current level ({shocked_vol:.1%})"
        ),
        loss_fraction=loss,
        detail={
            "current_annual_vol": current_annual_vol,
            "shocked_annual_vol": shocked_vol,
            "confidence": confidence,
        },
    )


def gap_down_shock_scenario(shock_fraction: float) -> StressScenarioResult:
    """Instantaneous, model-independent price gap (e.g. exchange
    insolvency, stablecoin depeg, forced liquidation cascade) applied
    directly to spot - not something a continuous-path model can produce."""
    if not 0.0 < shock_fraction < 1.0:
        raise ValueError(f"shock_fraction must be in (0, 1), got {shock_fraction}")
    return StressScenarioResult(
        name=f"gap_down_shock_{shock_fraction:.0%}",
        description=f"Instantaneous {shock_fraction:.0%} price gap before settlement",
        loss_fraction=shock_fraction,
        detail={"shock_fraction": shock_fraction},
    )


def extended_horizon_scenario(
    *,
    returns: pd.Series,
    garch_params: GARCHParams,
    model_state: ModelState,
    horizon_days: int,
    extended_horizon_days: int,
    confidence: float,
    n_scenarios: int,
    rng: np.random.Generator,
) -> StressScenarioResult:
    """FHS Expected Shortfall at ``extended_horizon_days`` instead of the
    requested ``horizon_days`` - how much worse tail risk gets if
    settlement is delayed."""
    residual_pool = standardized_residuals(returns, garch_params)
    log_returns = simulate_fhs_horizon_log_returns(
        params=garch_params,
        last_sigma2=model_state.latest_conditional_variance,
        last_eps2=model_state.latest_squared_residual or 0.0,
        residual_pool=residual_pool,
        horizon_days=extended_horizon_days,
        n_scenarios=n_scenarios,
        rng=rng,
    )
    simple_returns = np.exp(log_returns) - 1.0
    loss = expected_shortfall(simple_returns, confidence)
    return StressScenarioResult(
        name=f"extended_horizon_{extended_horizon_days}d",
        description=(
            f"FHS Expected Shortfall at {confidence:.0%} if settlement stretches to "
            f"{extended_horizon_days}d instead of the quoted {horizon_days}d"
        ),
        loss_fraction=loss,
        detail={
            "requested_horizon_days": horizon_days,
            "extended_horizon_days": extended_horizon_days,
            "confidence": confidence,
        },
    )


def run_stress_tests(
    *,
    returns: pd.Series,
    garch_params: GARCHParams,
    model_state: ModelState,
    horizon_days: int,
    confidence: float = 0.99,
    vol_shock_multipliers: tuple[float, ...] = DEFAULT_VOL_SHOCK_MULTIPLIERS,
    gap_down_shocks: tuple[float, ...] = DEFAULT_GAP_DOWN_SHOCKS,
    longer_horizon_multiplier: float = DEFAULT_LONGER_HORIZON_MULTIPLIER,
    n_scenarios: int = 50_000,
    seed: int = 42,
) -> StressTestSummary:
    rng = np.random.default_rng(seed)
    scenarios: list[StressScenarioResult] = [historical_worst_case(returns, horizon_days)]

    current_annual_vol = float(np.sqrt(model_state.latest_conditional_variance * PERIODS_PER_YEAR))
    for multiplier in vol_shock_multipliers:
        scenarios.append(
            volatility_shock_scenario(
                current_annual_vol=current_annual_vol,
                shock_multiplier=multiplier,
                horizon_days=horizon_days,
                confidence=confidence,
                n_scenarios=n_scenarios,
                rng=rng,
            )
        )

    for shock in gap_down_shocks:
        scenarios.append(gap_down_shock_scenario(shock))

    extended_horizon_days = max(horizon_days + 1, round(horizon_days * longer_horizon_multiplier))
    scenarios.append(
        extended_horizon_scenario(
            returns=returns,
            garch_params=garch_params,
            model_state=model_state,
            horizon_days=horizon_days,
            extended_horizon_days=extended_horizon_days,
            confidence=confidence,
            n_scenarios=n_scenarios,
            rng=rng,
        )
    )

    worst = max(scenarios, key=lambda s: s.loss_fraction)
    return StressTestSummary(
        horizon_days=horizon_days,
        scenarios=scenarios,
        worst_loss_fraction=worst.loss_fraction,
        worst_scenario_name=worst.name,
    )
