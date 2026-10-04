"""Return construction.

r_t = log(P_t / P_{t-1})

Log returns are used everywhere downstream (realized vol, EWMA, GARCH)
because they're additive across time and the standard input for
conditional-variance models.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def log_returns(prices: pd.Series) -> pd.Series:
    """Compute log returns r_t = log(P_t / P_{t-1}) from a price series.

    The first observation has no prior price and is dropped (not NaN'd),
    so the output is one observation shorter than the input.
    """
    if (prices <= 0).any():
        raise ValueError("log_returns requires strictly positive prices")
    r = np.log(prices).diff().dropna()
    r.name = "log_return"
    return r
