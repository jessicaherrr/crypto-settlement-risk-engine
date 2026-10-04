"""Forecast evaluation metrics for conditional-variance models.

Both metrics compare a variance *forecast* against a realized-variance
*proxy* (squared return) for the same day - never against the model's own
in-sample fit.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def rmse(proxy: pd.Series, forecast: pd.Series) -> float:
    """Root-mean-squared error between realized-variance proxy and
    forecast variance."""
    diff = proxy.to_numpy() - forecast.to_numpy()
    return float(np.sqrt(np.mean(diff**2)))


def qlike(proxy: pd.Series, forecast: pd.Series) -> float:
    """QLIKE loss: mean(log(forecast) + proxy / forecast).

    The standard loss function for variance-forecast evaluation (Patton,
    2011): it penalizes under-prediction of variance more heavily than
    RMSE and is robust to the choice of volatility proxy.
    """
    f = forecast.to_numpy()
    p = proxy.to_numpy()
    if np.any(f <= 0):
        raise ValueError("qlike requires strictly positive forecast variance")
    return float(np.mean(np.log(f) + p / f))
