from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from askgene_quant.volatility.ewma import EWMAVolatility, ewma_variance


def test_ewma_variance_matches_manual_recursion():
    returns = pd.Series([0.01, -0.02, 0.015, 0.0, -0.005])
    lam = 0.9
    init = 0.0004
    out = ewma_variance(returns, lam, init_variance=init)

    manual = []
    prev = init
    for r in returns:
        prev = lam * prev + (1 - lam) * r**2
        manual.append(prev)

    np.testing.assert_allclose(out.to_numpy(), manual)


def test_ewma_variance_rejects_invalid_lambda():
    returns = pd.Series([0.01, 0.02])
    with pytest.raises(ValueError):
        ewma_variance(returns, lam=1.5)
    with pytest.raises(ValueError):
        ewma_variance(returns, lam=0.0)


def test_ewma_variance_defaults_seed_to_sample_variance():
    returns = pd.Series(np.random.default_rng(1).normal(0, 0.02, size=50))
    out = ewma_variance(returns, lam=0.94)
    manual_first = 0.94 * float(returns.var(ddof=1)) + 0.06 * returns.iloc[0] ** 2
    assert np.isclose(out.iloc[0], manual_first)


def test_online_ewma_matches_batch_after_seed_and_updates():
    returns = pd.Series(np.random.default_rng(2).normal(0, 0.02, size=40))
    seed_window = returns.iloc[:20]
    rest = returns.iloc[20:]

    online = EWMAVolatility(lam=0.9).seed(seed_window)
    for r in rest:
        online.update(float(r))

    batch = ewma_variance(returns, lam=0.9, init_variance=float(seed_window.var(ddof=1)))
    assert np.isclose(online.variance, batch.iloc[-1])


def test_ewma_volatility_requires_seed_before_update():
    model = EWMAVolatility(lam=0.9)
    with pytest.raises(RuntimeError):
        model.update(0.01)
    with pytest.raises(RuntimeError):
        _ = model.variance


def test_ewma_volatility_annualizes_correctly():
    model = EWMAVolatility(lam=0.9)
    model.seed(pd.Series([0.01, 0.02, -0.01]))
    raw = model.volatility(annualize=False)
    ann = model.volatility(annualize=True, periods_per_year=365)
    assert np.isclose(ann, raw * np.sqrt(365))
