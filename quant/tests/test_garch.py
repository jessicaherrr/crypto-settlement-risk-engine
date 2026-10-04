from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from askgene_quant.volatility.garch import (
    GARCHModel,
    GARCHParams,
    conditional_variance_path,
    fit_garch,
)


def test_fit_garch_recovers_known_parameters(synthetic_garch_returns):
    true_omega, true_alpha, true_beta = 1.5e-5, 0.08, 0.88
    params, diag = fit_garch(synthetic_garch_returns)

    assert diag.converged
    assert diag.n_obs == len(synthetic_garch_returns)
    # MLE on a finite sample won't recover the exact generating params;
    # loose tolerances just confirm the optimizer is in the right regime.
    assert params.alpha == pytest.approx(true_alpha, abs=0.06)
    assert params.beta == pytest.approx(true_beta, abs=0.1)
    assert params.persistence < 1


def test_fit_garch_requires_minimum_observations():
    returns = pd.Series(np.random.default_rng(0).normal(0, 0.01, size=10))
    with pytest.raises(ValueError):
        fit_garch(returns)


def test_garch_params_reject_invalid_values():
    with pytest.raises(ValueError):
        GARCHParams(omega=-1.0, alpha=0.1, beta=0.8)
    with pytest.raises(ValueError):
        GARCHParams(omega=1e-5, alpha=-0.1, beta=0.8)


def test_garch_params_unconditional_variance():
    params = GARCHParams(omega=1e-5, alpha=0.1, beta=0.8)
    assert np.isclose(params.unconditional_variance, 1e-5 / (1 - 0.9))

    non_stationary = GARCHParams(omega=1e-5, alpha=0.5, beta=0.6)
    with pytest.raises(ValueError):
        _ = non_stationary.unconditional_variance


def test_conditional_variance_path_matches_manual_recursion():
    params = GARCHParams(omega=1e-5, alpha=0.08, beta=0.9, mu=0.0)
    returns = pd.Series(np.random.default_rng(3).normal(0, 0.02, size=30))
    path = conditional_variance_path(returns, params)

    prev_sigma2 = float(returns.var(ddof=1))
    prev_eps2 = prev_sigma2
    manual = []
    for r in returns:
        s2 = params.omega + params.alpha * prev_eps2 + params.beta * prev_sigma2
        manual.append(s2)
        prev_eps2 = r**2
        prev_sigma2 = s2
    np.testing.assert_allclose(path.to_numpy(), manual)


def test_garch_model_update_matches_recursion_without_refitting(synthetic_garch_returns):
    train = synthetic_garch_returns.iloc[:1000]
    held_out = synthetic_garch_returns.iloc[1000:1010]

    model = GARCHModel().fit(train)
    params_before = model.params

    manual_sigma2 = model.last_variance
    manual_eps2 = model._last_eps2
    for r in held_out:
        manual_sigma2 = (
            params_before.omega + params_before.alpha * manual_eps2 + params_before.beta * manual_sigma2
        )
        manual_eps2 = (r - params_before.mu) ** 2

        updated = model.update(float(r))
        assert np.isclose(updated, manual_sigma2)

    # update() must never re-estimate parameters.
    assert model.params is params_before


def test_garch_model_forecast_first_step_matches_update(synthetic_garch_returns):
    model = GARCHModel().fit(synthetic_garch_returns.iloc[:800])
    forecast_1 = model.forecast(1)[0]

    sigma2_before = model.last_variance
    eps2_before = model._last_eps2
    updated = model.update(0.0)  # doesn't matter, just checking forecast matched pre-update

    manual_forecast = (
        model.params.omega + model.params.alpha * eps2_before + model.params.beta * sigma2_before
    )
    assert np.isclose(forecast_1, manual_forecast)


def test_garch_model_long_horizon_forecast_converges_to_unconditional_variance():
    model = GARCHModel()
    model.params = GARCHParams(omega=1e-5, alpha=0.05, beta=0.9)
    model._last_sigma2 = 0.01
    model._last_eps2 = 0.01

    forecast = model.forecast(500)
    assert np.isclose(forecast[-1], model.params.unconditional_variance, rtol=1e-3)


def test_conditional_variance_path_stable_at_near_integrated_boundary():
    """Regression test: a near-unit-root fit (alpha+beta ~ 1, a boundary
    solution MLE occasionally lands on for volatile crypto windows) must
    not blow up the seed variance via omega / (1 - persistence)."""
    params = GARCHParams(omega=1.719e-6, alpha=0.0, beta=0.9999999999852732, mu=0.0)
    returns = pd.Series(np.random.default_rng(5).normal(0, 0.045, size=750))

    path = conditional_variance_path(returns, params)

    sample_var = float(returns.var(ddof=1))
    # the whole path should stay within a sane multiple of the window's
    # empirical variance, not jump to the theoretical (and here enormous)
    # unconditional variance of ~1.17e5.
    assert path.max() < sample_var * 10
    assert params.unconditional_variance > 1e4  # confirms this really is the pathological case


def test_garch_model_requires_fit_before_update_or_forecast():
    model = GARCHModel()
    with pytest.raises(RuntimeError):
        model.update(0.01)
    with pytest.raises(RuntimeError):
        model.forecast(1)
    with pytest.raises(RuntimeError):
        _ = model.last_variance
