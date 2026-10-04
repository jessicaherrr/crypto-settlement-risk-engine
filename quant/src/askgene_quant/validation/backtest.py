"""Out-of-sample, walk-forward comparison of rolling historical volatility,
EWMA, and GARCH(1,1).

Every forecast for day t is produced using only information available
through day t-1 - no model ever sees the return it is being scored
against. GARCH is refit periodically on trailing windows (mirroring
`models.pipeline.GarchVolatilityPipeline`); EWMA and rolling volatility
have no parameters to refit, only state/windows that roll forward.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from askgene_quant.config import DEFAULT_VOLATILITY_SETTINGS, VolatilitySettings
from askgene_quant.validation.metrics import qlike, rmse
from askgene_quant.volatility.ewma import ewma_variance
from askgene_quant.volatility.garch import GARCHModel

MODEL_COLUMNS = ("rolling_hist_vol", "ewma", "garch")


@dataclass
class ValidationResult:
    forecasts: pd.DataFrame  # columns: proxy, rolling_hist_vol, ewma, garch
    metrics: dict[str, dict[str, float]]  # {model: {"rmse": ..., "qlike": ...}}
    oos_start: pd.Timestamp
    oos_end: pd.Timestamp
    n_oos: int


def rolling_variance_forecast(returns: pd.Series, window: int) -> pd.Series:
    """One-step-ahead forecast for day t: sample variance of the trailing
    ``window`` returns ending at t-1."""
    return returns.rolling(window=window).var(ddof=1).shift(1)


def ewma_variance_forecast(
    returns: pd.Series, lam: float, *, train_end_idx: int
) -> pd.Series:
    """One-step-ahead EWMA forecast for every day, seeded only from
    ``returns`` up to (not including) ``train_end_idx`` so the recursion
    never uses information from the period it will later be scored on."""
    seed_variance = float(returns.iloc[:train_end_idx].var(ddof=1))
    filtered = ewma_variance(returns, lam, init_variance=seed_variance)
    return filtered.shift(1)


def garch_walk_forward_forecast(
    returns: pd.Series,
    *,
    fitting_window: int,
    refit_frequency: int,
    oos_start_idx: int,
    dist: str = "normal",
) -> pd.Series:
    """One-step-ahead GARCH(1,1) forecast for each day from
    ``oos_start_idx`` onward.

    Parameters are estimated once on the ``fitting_window`` observations
    immediately preceding ``oos_start_idx``, then only updated via the
    closed-form recursion as each day's return is revealed - refitting
    from scratch only every ``refit_frequency`` observations, exactly as
    `models.pipeline.GarchVolatilityPipeline` does online.
    """
    n = len(returns)
    forecasts = pd.Series(index=returns.index, dtype=float, name="garch")

    train = returns.iloc[max(0, oos_start_idx - fitting_window) : oos_start_idx]
    model = GARCHModel(dist=dist).fit(train)
    steps_since_fit = 0

    for t in range(oos_start_idx, n):
        forecasts.iloc[t] = model.forecast(1)[0]

        steps_since_fit += 1
        if steps_since_fit >= refit_frequency:
            window = returns.iloc[max(0, t + 1 - fitting_window) : t + 1]
            model = GARCHModel(dist=dist).fit(window)
            steps_since_fit = 0
        else:
            model.update(float(returns.iloc[t]))

    return forecasts


def run_volatility_backtest(
    returns: pd.Series,
    *,
    settings: VolatilitySettings = DEFAULT_VOLATILITY_SETTINGS,
    oos_fraction: float = 0.3,
    dist: str = "normal",
) -> ValidationResult:
    """Run the full walk-forward comparison and compute RMSE/QLIKE for
    each model against the squared-return realized-variance proxy."""
    n = len(returns)
    oos_start_idx = max(
        int(n * (1 - oos_fraction)),
        settings.garch_fitting_window,
        settings.realized_window,
    )
    if oos_start_idx >= n - 20:
        raise ValueError(
            f"not enough data for a meaningful out-of-sample period: "
            f"n={n}, oos_start_idx={oos_start_idx}"
        )

    proxy = returns**2
    rolling_forecast = rolling_variance_forecast(returns, settings.realized_window)
    ewma_forecast = ewma_variance_forecast(
        returns, settings.ewma_lambda, train_end_idx=oos_start_idx
    )
    garch_forecast = garch_walk_forward_forecast(
        returns,
        fitting_window=settings.garch_fitting_window,
        refit_frequency=settings.garch_refit_frequency,
        oos_start_idx=oos_start_idx,
        dist=dist,
    )

    df = pd.DataFrame(
        {
            "proxy": proxy,
            "rolling_hist_vol": rolling_forecast,
            "ewma": ewma_forecast,
            "garch": garch_forecast,
        }
    ).iloc[oos_start_idx:].dropna()

    metrics = {
        model: {"rmse": rmse(df["proxy"], df[model]), "qlike": qlike(df["proxy"], df[model])}
        for model in MODEL_COLUMNS
    }

    return ValidationResult(
        forecasts=df,
        metrics=metrics,
        oos_start=df.index.min(),
        oos_end=df.index.max(),
        n_oos=len(df),
    )
