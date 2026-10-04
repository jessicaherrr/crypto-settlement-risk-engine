from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from askgene_quant.config import VolatilitySettings
from askgene_quant.validation.backtest import (
    garch_walk_forward_forecast,
    rolling_variance_forecast,
    run_volatility_backtest,
)


def test_rolling_variance_forecast_has_no_lookahead():
    returns = pd.Series(np.random.default_rng(0).normal(0, 0.02, size=50))
    forecast = rolling_variance_forecast(returns, window=10)
    # forecast[t] must equal the sample variance of returns[t-10:t],
    # i.e. it excludes returns[t] itself.
    manual = returns.iloc[10:20].var(ddof=1)
    assert np.isclose(forecast.iloc[20], manual)


def test_rolling_variance_forecast_unaffected_by_future_values():
    returns = pd.Series(np.random.default_rng(1).normal(0, 0.02, size=50))
    forecast_full = rolling_variance_forecast(returns, window=10)

    mutated = returns.copy()
    mutated.iloc[25:] = mutated.iloc[25:] * 100  # blow up everything from t=25 onward
    forecast_mutated = rolling_variance_forecast(mutated, window=10)

    # forecast for t=20 only depends on returns[10:20], untouched by the
    # mutation starting at t=25.
    assert np.isclose(forecast_full.iloc[20], forecast_mutated.iloc[20])


def test_garch_walk_forward_forecast_runs_and_refits(synthetic_garch_returns):
    forecasts = garch_walk_forward_forecast(
        synthetic_garch_returns,
        fitting_window=800,
        refit_frequency=50,
        oos_start_idx=900,
    )
    oos = forecasts.iloc[900:]
    assert oos.notna().all()
    assert (oos > 0).all()


def test_run_volatility_backtest_produces_metrics_for_all_models(synthetic_garch_returns):
    settings = VolatilitySettings(
        realized_window=30, ewma_lambda=0.94, garch_fitting_window=700, garch_refit_frequency=50
    )
    result = run_volatility_backtest(synthetic_garch_returns, settings=settings, oos_fraction=0.3)

    assert set(result.metrics.keys()) == {"rolling_hist_vol", "ewma", "garch"}
    for model, m in result.metrics.items():
        assert m["rmse"] > 0
        assert np.isfinite(m["qlike"])

    assert result.n_oos == len(result.forecasts)
    assert result.n_oos > 100
    assert not result.forecasts.isna().any().any()


def test_run_volatility_backtest_raises_when_not_enough_data():
    short_returns = pd.Series(np.random.default_rng(0).normal(0, 0.02, size=50))
    settings = VolatilitySettings(garch_fitting_window=100)
    with pytest.raises(ValueError):
        run_volatility_backtest(short_returns, settings=settings)
