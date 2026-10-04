from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from askgene_quant.config import VolatilitySettings
from askgene_quant.validation.var_backtest import (
    kupiec_pof_test,
    walk_forward_var_backtest,
)


def test_kupiec_test_does_not_reject_when_rate_matches_expectation():
    # Exactly 10 exceedances in 1000 obs at 99% confidence (expected rate 0.01).
    result = kupiec_pof_test(n_obs=1000, n_exceedances=10, confidence=0.99)
    assert result.exceedance_rate == pytest.approx(0.01)
    assert result.lr_statistic == pytest.approx(0.0, abs=1e-9)
    assert result.p_value == pytest.approx(1.0, abs=1e-6)
    assert not result.reject_at_5pct


def test_kupiec_test_rejects_when_rate_is_far_off():
    # 100 exceedances in 1000 obs at 99% confidence (10x the expected rate).
    result = kupiec_pof_test(n_obs=1000, n_exceedances=100, confidence=0.99)
    assert result.reject_at_5pct
    assert result.p_value < 0.05


def test_kupiec_test_handles_zero_exceedances():
    result = kupiec_pof_test(n_obs=500, n_exceedances=0, confidence=0.99)
    assert result.exceedance_rate == 0.0
    assert np.isfinite(result.lr_statistic)
    assert 0.0 <= result.p_value <= 1.0


def test_kupiec_test_handles_all_exceedances():
    result = kupiec_pof_test(n_obs=10, n_exceedances=10, confidence=0.99)
    assert result.exceedance_rate == 1.0
    assert np.isfinite(result.lr_statistic)


def test_kupiec_test_rejects_invalid_inputs():
    with pytest.raises(ValueError):
        kupiec_pof_test(n_obs=0, n_exceedances=0, confidence=0.99)
    with pytest.raises(ValueError):
        kupiec_pof_test(n_obs=10, n_exceedances=11, confidence=0.99)


def test_walk_forward_var_backtest_runs_and_produces_reasonable_coverage(synthetic_garch_returns):
    settings = VolatilitySettings(garch_fitting_window=700, garch_refit_frequency=50)
    result = walk_forward_var_backtest(synthetic_garch_returns, confidence=0.99, settings=settings, oos_fraction=0.3)

    assert result.kupiec.n_obs > 100
    assert 0 <= result.kupiec.n_exceedances <= result.kupiec.n_obs
    # A well-specified model's exceedance rate should be in the right
    # ballpark of 1% - loose bound, this is a sanity check not a precise
    # calibration claim (the synthetic series is a single finite draw).
    assert result.kupiec.exceedance_rate < 0.05
    assert not result.forecasts.isna().any().any()
    assert (result.forecasts["sigma"] > 0).all()


def test_walk_forward_var_backtest_raises_when_not_enough_data():
    short_returns = pd.Series(np.random.default_rng(0).normal(0, 0.02, size=50))
    settings = VolatilitySettings(garch_fitting_window=30)
    with pytest.raises(ValueError):
        walk_forward_var_backtest(short_returns, settings=settings)
