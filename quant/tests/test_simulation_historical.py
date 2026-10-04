from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from askgene_quant.simulation.historical import historical_horizon_log_returns


def test_historical_horizon_matches_manual_cumulative_sum():
    returns = pd.Series(np.random.default_rng(0).normal(0, 0.02, size=50))
    out = historical_horizon_log_returns(returns, horizon_days=5)

    manual_first = returns.iloc[0:5].sum()
    assert out[0] == pytest.approx(manual_first)
    assert len(out) == len(returns) - 5 + 1


def test_historical_horizon_one_day_equals_raw_returns():
    returns = pd.Series(np.random.default_rng(1).normal(0, 0.02, size=20))
    out = historical_horizon_log_returns(returns, horizon_days=1)
    np.testing.assert_allclose(out, returns.to_numpy())


def test_historical_horizon_rejects_invalid_horizon():
    returns = pd.Series(np.random.default_rng(0).normal(0, 0.02, size=20))
    with pytest.raises(ValueError):
        historical_horizon_log_returns(returns, horizon_days=0)


def test_historical_horizon_rejects_insufficient_data():
    returns = pd.Series(np.random.default_rng(0).normal(0, 0.02, size=5))
    with pytest.raises(ValueError):
        historical_horizon_log_returns(returns, horizon_days=10)
