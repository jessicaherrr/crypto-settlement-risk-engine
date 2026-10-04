from __future__ import annotations

from datetime import UTC, datetime

import numpy as np
import pandas as pd
import pytest

from askgene_quant.models.state import ModelState
from askgene_quant.volatility.garch import GARCHModel, GARCHParams


@pytest.fixture
def synthetic_prices() -> pd.Series:
    """Deterministic ~500-day daily price series (GBM-like)."""
    rng = np.random.default_rng(42)
    n = 500
    idx = pd.date_range("2022-01-01", periods=n, freq="D", tz="UTC")
    daily_drift = 0.0002
    daily_vol = 0.03
    log_rets = rng.normal(daily_drift, daily_vol, size=n)
    log_price = np.log(2000.0) + np.cumsum(log_rets)
    prices = pd.Series(np.exp(log_price), index=idx, name="close")
    return prices


@pytest.fixture
def synthetic_garch_returns() -> pd.Series:
    """Deterministic return series simulated from a known GARCH(1,1)
    process, long enough for stable MLE recovery in tests."""
    return simulate_garch_returns(n=1500, omega=1.5e-5, alpha=0.08, beta=0.88, seed=7)


def simulate_garch_returns(
    n: int, omega: float, alpha: float, beta: float, seed: int = 0
) -> pd.Series:
    rng = np.random.default_rng(seed)
    sigma2 = np.empty(n)
    eps = np.empty(n)
    sigma2[0] = omega / (1 - alpha - beta)
    eps[0] = np.sqrt(sigma2[0]) * rng.standard_normal()
    for t in range(1, n):
        sigma2[t] = omega + alpha * eps[t - 1] ** 2 + beta * sigma2[t - 1]
        eps[t] = np.sqrt(sigma2[t]) * rng.standard_normal()
    idx = pd.date_range("2020-01-01", periods=n, freq="D", tz="UTC")
    return pd.Series(eps, index=idx, name="log_return")


@pytest.fixture
def fitted_garch(synthetic_garch_returns: pd.Series) -> tuple[GARCHParams, ModelState]:
    """A fitted GARCHModel's params plus the matching `ModelState`, as
    `risk/engine.py` and `risk/stress.py` expect - built directly rather
    than through `GarchVolatilityPipeline` so Phase D risk tests don't
    depend on model-state disk persistence."""
    model = GARCHModel().fit(synthetic_garch_returns)
    state = ModelState(
        asset="ETH-USD",
        model_name="garch_1_1",
        model_version="garch_1_1-v1",
        training_window_start=synthetic_garch_returns.index[0].to_pydatetime(),
        training_window_end=synthetic_garch_returns.index[-1].to_pydatetime(),
        n_obs_fit=len(synthetic_garch_returns),
        fitted_params=model.params.model_dump(),
        fit_timestamp=datetime.now(UTC),
        latest_conditional_variance=model.last_variance,
        latest_observation_timestamp=synthetic_garch_returns.index[-1].to_pydatetime(),
        latest_squared_residual=model.last_squared_residual,
    )
    return model.params, state


@pytest.fixture
def well_formed_ohlcv() -> pd.DataFrame:
    rng = np.random.default_rng(1)
    n = 60
    idx = pd.date_range("2023-01-01", periods=n, freq="D", tz="UTC")
    close = 1000 * np.exp(np.cumsum(rng.normal(0, 0.02, size=n)))
    open_ = close * (1 + rng.normal(0, 0.001, size=n))
    high = np.maximum(open_, close) * 1.01
    low = np.minimum(open_, close) * 0.99
    volume = rng.uniform(100, 1000, size=n)
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=idx,
    )
