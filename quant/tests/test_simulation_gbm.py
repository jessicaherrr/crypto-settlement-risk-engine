from __future__ import annotations

import numpy as np
import pytest

from askgene_quant.simulation.gbm import gbm_horizon_log_returns


def test_gbm_horizon_matches_analytic_moments():
    rng = np.random.default_rng(0)
    mu, sigma, horizon, ppy = 0.1, 0.6, 7, 365
    out = gbm_horizon_log_returns(
        mu_annual=mu, sigma_annual=sigma, horizon_days=horizon,
        n_scenarios=500_000, rng=rng, periods_per_year=ppy,
    )

    dt = horizon / ppy
    expected_mean = (mu - 0.5 * sigma**2) * dt
    expected_std = sigma * np.sqrt(dt)

    assert np.mean(out) == pytest.approx(expected_mean, abs=5e-4)
    assert np.std(out) == pytest.approx(expected_std, rel=0.02)


def test_gbm_variance_scales_linearly_with_horizon():
    rng = np.random.default_rng(1)
    var_1d = np.var(
        gbm_horizon_log_returns(mu_annual=0.0, sigma_annual=0.6, horizon_days=1, n_scenarios=500_000, rng=rng)
    )
    var_4d = np.var(
        gbm_horizon_log_returns(mu_annual=0.0, sigma_annual=0.6, horizon_days=4, n_scenarios=500_000, rng=rng)
    )
    assert var_4d == pytest.approx(var_1d * 4, rel=0.05)


def test_gbm_rejects_invalid_inputs():
    rng = np.random.default_rng(0)
    with pytest.raises(ValueError):
        gbm_horizon_log_returns(mu_annual=0.0, sigma_annual=0.5, horizon_days=0, n_scenarios=10, rng=rng)
    with pytest.raises(ValueError):
        gbm_horizon_log_returns(mu_annual=0.0, sigma_annual=-0.1, horizon_days=1, n_scenarios=10, rng=rng)
