from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from askgene_quant.data.returns import log_returns


def test_log_returns_matches_manual_calculation():
    prices = pd.Series([100.0, 110.0, 99.0, 99.0])
    r = log_returns(prices)
    expected = np.log(np.array([110 / 100, 99 / 110, 99 / 99]))
    np.testing.assert_allclose(r.to_numpy(), expected)


def test_log_returns_is_one_shorter_than_input(synthetic_prices):
    r = log_returns(synthetic_prices)
    assert len(r) == len(synthetic_prices) - 1
    assert r.index[0] == synthetic_prices.index[1]


def test_log_returns_rejects_non_positive_prices():
    prices = pd.Series([100.0, 0.0, 50.0])
    with pytest.raises(ValueError):
        log_returns(prices)

    prices_negative = pd.Series([100.0, -5.0, 50.0])
    with pytest.raises(ValueError):
        log_returns(prices_negative)


def test_log_returns_flat_price_is_zero():
    prices = pd.Series([100.0, 100.0, 100.0])
    r = log_returns(prices)
    np.testing.assert_allclose(r.to_numpy(), [0.0, 0.0])
