"""Realized / rolling historical volatility.

Simple trailing-window standard deviation of log returns. This is the
baseline volatility estimator everything else (EWMA, GARCH) is compared
against in validation.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from askgene_quant.config import PERIODS_PER_YEAR


def rolling_volatility(
    returns: pd.Series,
    window: int,
    *,
    annualize: bool = True,
    periods_per_year: int = PERIODS_PER_YEAR,
    min_periods: int | None = None,
) -> pd.Series:
    """Trailing ``window``-observation standard deviation of ``returns``.

    ``rolling_volatility(...).iloc[t]`` only uses returns up to and
    including ``t`` - it's safe to use as a same-day volatility estimate,
    but using it as a *forecast* for day t+1 (as validation does) means
    shifting it forward by one first.
    """
    vol = returns.rolling(window=window, min_periods=min_periods or window).std(ddof=1)
    if annualize:
        vol = vol * np.sqrt(periods_per_year)
    vol.name = f"realized_vol_{window}d"
    return vol


def realized_variance(returns: pd.Series, window: int) -> pd.Series:
    """Trailing ``window``-observation realized variance (sum of squared
    returns), the GARCH-literature definition used as a volatility proxy
    and as an alternative to the sample-variance ``rolling_volatility``.
    """
    rv = (returns**2).rolling(window=window).sum()
    rv.name = f"realized_variance_{window}d"
    return rv
