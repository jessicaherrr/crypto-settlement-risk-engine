from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from askgene_quant.validation.metrics import qlike, rmse


def test_rmse_zero_for_perfect_forecast():
    proxy = pd.Series([0.001, 0.002, 0.0015])
    assert rmse(proxy, proxy) == pytest.approx(0.0)


def test_rmse_matches_manual_calculation():
    proxy = pd.Series([1.0, 2.0, 3.0])
    forecast = pd.Series([1.5, 1.5, 3.5])
    expected = np.sqrt(np.mean([(1 - 1.5) ** 2, (2 - 1.5) ** 2, (3 - 3.5) ** 2]))
    assert rmse(proxy, forecast) == pytest.approx(expected)


def test_qlike_matches_manual_calculation():
    proxy = pd.Series([0.001, 0.002])
    forecast = pd.Series([0.0012, 0.0018])
    expected = np.mean(np.log(forecast.to_numpy()) + proxy.to_numpy() / forecast.to_numpy())
    assert qlike(proxy, forecast) == pytest.approx(expected)


def test_qlike_rejects_non_positive_forecast():
    proxy = pd.Series([0.001, 0.002])
    forecast = pd.Series([0.001, 0.0])
    with pytest.raises(ValueError):
        qlike(proxy, forecast)


def test_qlike_penalizes_underprediction_more_than_overprediction():
    # Same absolute forecast error in both directions; QLIKE should
    # penalize the under-prediction (forecast << proxy) more.
    proxy = pd.Series([0.01])
    under = qlike(proxy, pd.Series([0.005]))
    over = qlike(proxy, pd.Series([0.015]))
    assert under > over
