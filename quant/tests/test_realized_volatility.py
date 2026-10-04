from __future__ import annotations

import numpy as np
import pandas as pd

from askgene_quant.volatility.realized import realized_variance, rolling_volatility


def test_rolling_volatility_matches_manual_std():
    returns = pd.Series(np.arange(1, 11, dtype=float) / 100)
    vol = rolling_volatility(returns, window=5, annualize=False)
    manual = returns.rolling(5).std(ddof=1)
    pd.testing.assert_series_equal(vol, manual, check_names=False)


def test_rolling_volatility_annualization_factor():
    returns = pd.Series(np.full(20, 0.01))
    raw = rolling_volatility(returns, window=5, annualize=False)
    annualized = rolling_volatility(returns, window=5, annualize=True, periods_per_year=365)
    ratio = (annualized / raw).dropna()
    np.testing.assert_allclose(ratio.to_numpy(), np.sqrt(365))


def test_rolling_volatility_first_window_minus_one_is_nan():
    returns = pd.Series(np.random.default_rng(0).normal(size=30))
    vol = rolling_volatility(returns, window=10, annualize=False)
    assert vol.iloc[: 10 - 1].isna().all()
    assert vol.iloc[9:].notna().all()


def test_realized_variance_matches_sum_of_squares():
    returns = pd.Series([0.1, -0.1, 0.2, -0.2, 0.05])
    rv = realized_variance(returns, window=3)
    expected_last = 0.2**2 + (-0.2) ** 2 + 0.05**2
    assert np.isclose(rv.iloc[-1], expected_last)
