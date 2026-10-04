"""EWMA (RiskMetrics-style) volatility.

Recursion:
    sigma2_t = lambda * sigma2_{t-1} + (1 - lambda) * r_t^2

``sigma2_t`` is the filtered variance estimate after observing return
``r_t``. Because EWMA has no mean reversion, the h-step-ahead forecast for
any h >= 1 is just the current level, ``sigma2_t``.

Unlike GARCH, EWMA has no free parameters to estimate by MLE here - decay
is a configuration choice (0.94 daily is the RiskMetrics default), so
"fitting" is just picking a seed variance and nothing more. The model is
naturally incremental: `EWMAVolatility.update` is the whole online story.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from askgene_quant.config import PERIODS_PER_YEAR


def ewma_variance(
    returns: pd.Series,
    lam: float = 0.94,
    *,
    init_variance: float | None = None,
) -> pd.Series:
    """Batch EWMA conditional variance for a full return series.

    ``init_variance`` seeds sigma2 before the first observation; it
    defaults to the sample variance of ``returns`` (a reasonable,
    mildly look-ahead seed appropriate for in-sample/research use - the
    online `EWMAVolatility` class below should be used instead when
    look-ahead must be strictly avoided, e.g. in validation).
    """
    if not 0 < lam < 1:
        raise ValueError(f"lam must be in (0, 1), got {lam}")
    if len(returns) == 0:
        return pd.Series(dtype=float, name="ewma_variance")

    if init_variance is None:
        init_variance = float(returns.var(ddof=1))

    out = np.empty(len(returns))
    prev = init_variance
    r2 = returns.to_numpy() ** 2
    for i in range(len(returns)):
        prev = lam * prev + (1 - lam) * r2[i]
        out[i] = prev

    series = pd.Series(out, index=returns.index, name="ewma_variance")
    return series


def ewma_volatility(
    returns: pd.Series,
    lam: float = 0.94,
    *,
    annualize: bool = True,
    periods_per_year: int = PERIODS_PER_YEAR,
    init_variance: float | None = None,
) -> pd.Series:
    var = ewma_variance(returns, lam, init_variance=init_variance)
    vol = np.sqrt(var)
    if annualize:
        vol = vol * np.sqrt(periods_per_year)
    vol.name = "ewma_vol"
    return vol


class EWMAVolatility:
    """Online EWMA variance tracker.

    Usage:
        model = EWMAVolatility(lam=0.94)
        model.seed(historical_returns)   # one-time initialization
        model.update(new_return)         # call per new observation
        model.variance                   # current conditional variance
    """

    def __init__(self, lam: float = 0.94):
        if not 0 < lam < 1:
            raise ValueError(f"lam must be in (0, 1), got {lam}")
        self.lam = lam
        self._variance: float | None = None

    @property
    def variance(self) -> float:
        if self._variance is None:
            raise RuntimeError("EWMAVolatility has not been seeded or updated yet")
        return self._variance

    def volatility(
        self, *, annualize: bool = True, periods_per_year: int = PERIODS_PER_YEAR
    ) -> float:
        vol = np.sqrt(self.variance)
        return vol * np.sqrt(periods_per_year) if annualize else vol

    def seed(self, returns: pd.Series, *, init_variance: float | None = None) -> "EWMAVolatility":
        """Initialize state from a historical return series (does not
        look ahead past the data it's given)."""
        variance = ewma_variance(returns, self.lam, init_variance=init_variance)
        self._variance = float(variance.iloc[-1])
        return self

    def update(self, new_return: float) -> float:
        """Fold in one new observation; returns the updated variance."""
        if self._variance is None:
            raise RuntimeError("call seed(...) before update(...)")
        self._variance = self.lam * self._variance + (1 - self.lam) * new_return**2
        return self._variance
