"""Historical simulation: the empirical distribution of real multi-day
moves.

For a settlement horizon of ``h`` days, the relevant quantity is not "1-day
volatility scaled by sqrt(h)" but the actual distribution of h-day moves
that have occurred historically. Log returns are additive, so an h-day
cumulative log return is just the sum of h consecutive daily log returns -
equivalently ``log(P_t / P_{t-h})``.

Overlapping windows (every ``h``-day window, not just every ``h``-th one)
are used so the full history contributes scenarios; the cost is that
adjacent scenarios share up to ``h - 1`` days and are therefore not
independent draws. This is the standard trade-off for historical
simulation at horizons beyond 1 day and is why historical-simulation VaR/ES
here should be read as a description of realized multi-day moves, not as
i.i.d. samples from a fitted distribution.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def historical_horizon_log_returns(returns: pd.Series, horizon_days: int) -> np.ndarray:
    """All overlapping ``horizon_days``-day cumulative log returns in
    ``returns``, i.e. ``log(P_t / P_{t-horizon_days})`` for every valid t.

    Returns an array of length ``len(returns) - horizon_days + 1``.
    """
    if horizon_days < 1:
        raise ValueError(f"horizon_days must be >= 1, got {horizon_days}")
    if len(returns) < horizon_days:
        raise ValueError(
            f"need at least {horizon_days} observations, got {len(returns)}"
        )
    cum = returns.rolling(window=horizon_days).sum().dropna()
    return cum.to_numpy()
