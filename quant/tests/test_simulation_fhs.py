from __future__ import annotations

import numpy as np
import pytest

from askgene_quant.simulation.filtered_historical import (
    simulate_fhs_horizon_log_returns,
    standardized_residuals,
)
from askgene_quant.volatility.garch import GARCHModel, GARCHParams


def test_standardized_residuals_have_roughly_unit_variance(synthetic_garch_returns):
    model = GARCHModel().fit(synthetic_garch_returns)
    z = standardized_residuals(synthetic_garch_returns, model.params)

    assert len(z) == len(synthetic_garch_returns)
    # Standardizing by the model's own filtered sigma should remove most
    # of the volatility clustering, leaving an approximately unit-variance
    # series (loose tolerance: finite-sample MLE, not exact by construction).
    assert np.std(z) == pytest.approx(1.0, abs=0.15)


def test_fhs_one_day_matches_manual_single_step():
    params = GARCHParams(omega=1e-5, alpha=0.08, beta=0.88, mu=0.0)
    residual_pool = np.array([-1.0, 0.0, 1.0])
    rng = np.random.default_rng(0)

    out = simulate_fhs_horizon_log_returns(
        params=params,
        last_sigma2=0.001,
        last_eps2=0.0005,
        residual_pool=residual_pool,
        horizon_days=1,
        n_scenarios=10_000,
        rng=rng,
    )

    expected_sigma2 = params.omega + params.alpha * 0.0005 + params.beta * 0.001
    possible_returns = {params.mu + z * np.sqrt(expected_sigma2) for z in residual_pool}
    assert set(np.round(out, 10)) <= {round(v, 10) for v in possible_returns}


def test_fhs_horizon_variance_grows_with_horizon():
    """Multi-day FHS variance should grow roughly with the horizon (via
    the GARCH recursion feeding forward), not be flat like EWMA nor
    exactly linear like i.i.d. GBM - just monotonically increasing."""
    params = GARCHParams(omega=1e-5, alpha=0.08, beta=0.88, mu=0.0)
    rng = np.random.default_rng(1)
    residual_pool = np.random.default_rng(2).standard_normal(2000)

    var_1d = np.var(
        simulate_fhs_horizon_log_returns(
            params=params, last_sigma2=0.001, last_eps2=0.001,
            residual_pool=residual_pool, horizon_days=1, n_scenarios=50_000, rng=rng,
        )
    )
    var_7d = np.var(
        simulate_fhs_horizon_log_returns(
            params=params, last_sigma2=0.001, last_eps2=0.001,
            residual_pool=residual_pool, horizon_days=7, n_scenarios=50_000, rng=rng,
        )
    )
    assert var_7d > var_1d


def test_fhs_rejects_empty_residual_pool():
    params = GARCHParams(omega=1e-5, alpha=0.08, beta=0.88, mu=0.0)
    with pytest.raises(ValueError):
        simulate_fhs_horizon_log_returns(
            params=params, last_sigma2=0.001, last_eps2=0.001,
            residual_pool=np.array([]), horizon_days=1, n_scenarios=10,
            rng=np.random.default_rng(0),
        )
