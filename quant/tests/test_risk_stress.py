from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from askgene_quant.risk.stress import (
    gap_down_shock_scenario,
    historical_worst_case,
    run_stress_tests,
    volatility_shock_scenario,
)


def test_historical_worst_case_finds_the_actual_worst_window():
    # A sharp, deterministic crash embedded in otherwise-flat returns.
    n = 100
    idx = pd.date_range("2024-01-01", periods=n, freq="D", tz="UTC")
    returns = pd.Series(np.zeros(n), index=idx)
    returns.iloc[50:53] = -0.10  # a 3-day, ~27% crash

    result = historical_worst_case(returns, horizon_days=3)
    assert result.loss_fraction == pytest.approx(1 - np.exp(-0.30), abs=1e-9)
    assert result.detail["window_end"] == str(idx[52].date())


def test_gap_down_shock_loss_equals_shock_fraction():
    result = gap_down_shock_scenario(0.4)
    assert result.loss_fraction == 0.4


def test_gap_down_shock_rejects_out_of_range():
    with pytest.raises(ValueError):
        gap_down_shock_scenario(1.5)
    with pytest.raises(ValueError):
        gap_down_shock_scenario(0.0)


def test_volatility_shock_scales_with_multiplier():
    rng = np.random.default_rng(0)
    low = volatility_shock_scenario(
        current_annual_vol=0.5, shock_multiplier=1.0, horizon_days=7,
        confidence=0.99, n_scenarios=50_000, rng=rng,
    )
    high = volatility_shock_scenario(
        current_annual_vol=0.5, shock_multiplier=3.0, horizon_days=7,
        confidence=0.99, n_scenarios=50_000, rng=rng,
    )
    assert high.loss_fraction > low.loss_fraction


def test_run_stress_tests_covers_all_scenario_families(synthetic_garch_returns, fitted_garch):
    params, state = fitted_garch
    summary = run_stress_tests(
        returns=synthetic_garch_returns,
        garch_params=params,
        model_state=state,
        horizon_days=7,
        n_scenarios=10_000,
    )

    names = {s.name for s in summary.scenarios}
    assert any(n.startswith("historical_worst_case") for n in names)
    assert any(n.startswith("vol_shock") for n in names)
    assert any(n.startswith("gap_down_shock") for n in names)
    assert any(n.startswith("extended_horizon") for n in names)

    assert summary.worst_loss_fraction == max(s.loss_fraction for s in summary.scenarios)
    assert summary.worst_scenario_name in names
    assert all(s.loss_fraction >= 0 for s in summary.scenarios)
