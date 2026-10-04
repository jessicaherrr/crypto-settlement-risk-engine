"""Geometric Brownian Motion Monte Carlo: the baseline stochastic-process
benchmark.

GBM assumes i.i.d. daily log-return increments with constant drift and
volatility - no volatility clustering, no fat tails, no mean reversion.
Under that assumption the horizon-``h`` cumulative log return really is
Normal with variance scaling linearly in ``h`` (i.e. volatility scaling in
``sqrt(h)``); that scaling is *intrinsic to GBM's own i.i.d. assumption*,
not something imposed on top of a model (like GARCH/FHS) that already
captures time-varying volatility. Sampling the horizon return directly
(rather than looping day-by-day) is exact for GBM and is used here purely
for efficiency.

GBM is intentionally treated as a benchmark the richer models (historical
simulation, FHS) are compared against, not as the preferred crypto risk
model - crypto returns visibly violate the i.i.d.-Normal assumption (fat
tails, volatility clustering; see `docs/methodology.md`).
"""

from __future__ import annotations

import numpy as np


def gbm_horizon_log_returns(
    *,
    mu_annual: float,
    sigma_annual: float,
    horizon_days: int,
    n_scenarios: int,
    rng: np.random.Generator,
    periods_per_year: int = 365,
) -> np.ndarray:
    """Sample ``n_scenarios`` horizon-``horizon_days`` cumulative log
    returns from GBM with constant annualized drift ``mu_annual`` and
    volatility ``sigma_annual``.

    ``log(P_{t+h} / P_t) ~ Normal((mu - sigma^2/2) * dt, sigma^2 * dt)``
    with ``dt = horizon_days / periods_per_year``.
    """
    if horizon_days < 1:
        raise ValueError(f"horizon_days must be >= 1, got {horizon_days}")
    if n_scenarios < 1:
        raise ValueError(f"n_scenarios must be >= 1, got {n_scenarios}")
    if sigma_annual < 0:
        raise ValueError(f"sigma_annual must be >= 0, got {sigma_annual}")

    dt = horizon_days / periods_per_year
    mean = (mu_annual - 0.5 * sigma_annual**2) * dt
    std = sigma_annual * np.sqrt(dt)
    return rng.normal(mean, std, size=n_scenarios)
