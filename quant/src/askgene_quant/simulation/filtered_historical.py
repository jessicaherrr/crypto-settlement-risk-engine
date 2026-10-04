"""Filtered historical simulation (FHS).

Combines two things that neither GARCH-with-normal-innovations nor plain
historical simulation does on its own:

1. **Time-varying volatility** - the GARCH(1,1) conditional-variance
   recursion, seeded at the model's current filtered state, so the
   simulated path starts from "where volatility actually is right now"
   (post a quiet spell or a recent shock), not an unconditional average.
2. **The empirical shape of return shocks** - rather than drawing
   innovations from a Normal (or Student-t) distribution, each simulated
   day's shock is a bootstrap draw from the model's own historical
   standardized residuals. Crypto returns have heavy tails and skew that
   a parametric innovation distribution only approximates; resampling the
   realized residuals carries that empirical shape forward unchanged.

Multi-day horizons are built by actually simulating day-by-day paths - each
simulated day's variance depends on that *same path's* own simulated shock
history via the GARCH recursion - rather than by scaling a 1-day VaR/ES by
sqrt(horizon). That scaling is only exact for i.i.d., constant-volatility
processes, which is precisely what GARCH says returns are not.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from askgene_quant.volatility.garch import GARCHParams, conditional_variance_path


def standardized_residuals(
    returns: pd.Series, params: GARCHParams, *, sigma2_init: float | None = None
) -> np.ndarray:
    """Empirical standardized residuals ``z_t = (r_t - mu) / sigma_t``
    under the fitted conditional-variance path for ``params``.

    This is the empirical innovation distribution FHS resamples from. It
    is computed in-sample (over whatever ``returns`` is passed), so the
    caller controls look-ahead: pass only data available as of "now" when
    building a live risk quote, and only pre-out-of-sample data when
    backtesting.
    """
    sigma2 = conditional_variance_path(returns, params, sigma2_init=sigma2_init)
    eps = returns.to_numpy() - params.mu
    z = eps / np.sqrt(sigma2.to_numpy())
    return z


def simulate_fhs_horizon_log_returns(
    *,
    params: GARCHParams,
    last_sigma2: float,
    last_eps2: float,
    residual_pool: np.ndarray,
    horizon_days: int,
    n_scenarios: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """Simulate ``n_scenarios`` independent ``horizon_days``-ahead paths
    and return each path's cumulative log return.

    Each simulated day h for each scenario:

        sigma2_h = omega + alpha * eps2_{h-1} + beta * sigma2_{h-1}   (GARCH recursion)
        z_h      ~ bootstrap draw from residual_pool                  (empirical shock)
        eps_h    = z_h * sqrt(sigma2_h)
        r_h      = mu + eps_h

    ``last_sigma2`` / ``last_eps2`` seed the recursion at the model's
    current filtered state (as persisted in `models.state.ModelState`),
    so every path starts from the real, current volatility regime.
    """
    if horizon_days < 1:
        raise ValueError(f"horizon_days must be >= 1, got {horizon_days}")
    if n_scenarios < 1:
        raise ValueError(f"n_scenarios must be >= 1, got {n_scenarios}")
    if len(residual_pool) == 0:
        raise ValueError("residual_pool must not be empty")

    idx = rng.integers(0, len(residual_pool), size=(n_scenarios, horizon_days))
    z_paths = residual_pool[idx]  # (n_scenarios, horizon_days)

    sigma2 = np.full(n_scenarios, last_sigma2, dtype=float)
    eps2 = np.full(n_scenarios, last_eps2, dtype=float)
    cum_log_return = np.zeros(n_scenarios, dtype=float)

    for h in range(horizon_days):
        sigma2 = params.omega + params.alpha * eps2 + params.beta * sigma2
        eps = z_paths[:, h] * np.sqrt(sigma2)
        cum_log_return += params.mu + eps
        eps2 = eps**2

    return cum_log_return
