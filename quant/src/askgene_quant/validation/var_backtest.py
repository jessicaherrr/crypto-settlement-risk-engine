"""VaR / Expected Shortfall validation: out-of-sample exceedance testing.

This is risk-*model* validation (does the predicted loss distribution
match what actually happened), not trading-strategy backtesting - no
positions are taken or evaluated for profitability.

Run at the 1-day horizon only. The Kupiec test's likelihood-ratio
statistic assumes exceedances are i.i.d. Bernoulli trials; the overlapping
multi-day windows a 7d/14d/30d VaR would use (see `simulation/historical.py`,
`risk/engine.py`) make adjacent exceedance indicators highly dependent, so
running Kupiec at those horizons would produce a numerically well-defined
but statistically meaningless p-value. Multi-day horizons are instead
sanity-checked qualitatively (simulated vs. realized percentiles) in
`scripts/run_risk_pipeline.py` and `docs/model_validation.md`, not claimed
to have a formal coverage test here.

Methodology mirrors `validation/backtest.py`: every day's VaR forecast
uses only information available through the prior day. The GARCH
conditional-variance path is the existing walk-forward, no-look-ahead
`garch_walk_forward_forecast`; the VaR multiplier (the standardized-
residual quantile) is estimated once, from the pre-out-of-sample training
window only, so it never sees an out-of-sample observation either.

Values here are computed directly on log returns rather than the
log-to-simple conversion `risk/engine.py` applies for horizon pricing - at
a 1-day horizon the two are close enough that this doesn't materially
affect exceedance counts, and keeping this module self-contained (no
dependency on the horizon risk engine) keeps the validation honest about
testing the *volatility model*, not the pricing layer built on top of it.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import chi2

from askgene_quant.config import DEFAULT_VOLATILITY_SETTINGS, VolatilitySettings
from askgene_quant.validation.backtest import garch_walk_forward_forecast
from askgene_quant.volatility.garch import conditional_variance_path, fit_garch


@dataclass
class KupiecTestResult:
    n_obs: int
    n_exceedances: int
    exceedance_rate: float
    expected_rate: float
    lr_statistic: float
    p_value: float
    reject_at_5pct: bool


@dataclass
class ExpectedShortfallBacktestResult:
    n_exceedances: int
    predicted_es: float
    realized_es: float | None
    ratio: float | None  # realized / predicted; None when there are no exceedances


@dataclass
class VarEsBacktestResult:
    confidence: float
    oos_start: pd.Timestamp
    oos_end: pd.Timestamp
    forecasts: pd.DataFrame  # columns: return, sigma2, sigma, var_loss, es_loss, exceed
    kupiec: KupiecTestResult
    expected_shortfall: ExpectedShortfallBacktestResult


def kupiec_pof_test(n_obs: int, n_exceedances: int, confidence: float) -> KupiecTestResult:
    """Kupiec (1995) unconditional-coverage (proportion-of-failures)
    likelihood-ratio test: does the observed exceedance rate match the
    rate implied by ``confidence``?

    ``LR = -2 * [ln L(p) - ln L(p_hat)]``, asymptotically chi-squared with
    1 degree of freedom under the null that the true exceedance
    probability is ``p = 1 - confidence``.
    """
    if n_obs <= 0:
        raise ValueError(f"n_obs must be positive, got {n_obs}")
    if not 0 <= n_exceedances <= n_obs:
        raise ValueError(f"n_exceedances must be in [0, n_obs], got {n_exceedances}")

    p = 1 - confidence
    p_hat = n_exceedances / n_obs

    def _log_likelihood(prob: float, n: int, x: int) -> float:
        if prob <= 0.0:
            return 0.0 if x == 0 else float("-inf")
        if prob >= 1.0:
            return 0.0 if x == n else float("-inf")
        return (n - x) * np.log(1 - prob) + x * np.log(prob)

    ll_null = _log_likelihood(p, n_obs, n_exceedances)
    ll_alt = _log_likelihood(p_hat, n_obs, n_exceedances)
    lr_statistic = max(-2.0 * (ll_null - ll_alt), 0.0)
    p_value = float(chi2.sf(lr_statistic, df=1))

    return KupiecTestResult(
        n_obs=n_obs,
        n_exceedances=n_exceedances,
        exceedance_rate=p_hat,
        expected_rate=p,
        lr_statistic=float(lr_statistic),
        p_value=p_value,
        reject_at_5pct=p_value < 0.05,
    )


def walk_forward_var_backtest(
    returns: pd.Series,
    *,
    confidence: float = 0.99,
    settings: VolatilitySettings = DEFAULT_VOLATILITY_SETTINGS,
    oos_fraction: float = 0.3,
    dist: str = "normal",
) -> VarEsBacktestResult:
    """Out-of-sample, walk-forward 1-day VaR/ES backtest.

    ``VaR_t = -(mu + z_q * sigma_t)``, where ``sigma_t`` is the walk-
    forward GARCH-filtered volatility (no look-ahead) and ``z_q`` is the
    ``1 - confidence`` quantile of standardized residuals estimated only
    from the training window *preceding* the out-of-sample period. An
    exceedance on day t is ``return_t < -VaR_t``.
    """
    n = len(returns)
    oos_start_idx = max(
        int(n * (1 - oos_fraction)),
        settings.garch_fitting_window,
        settings.realized_window,
    )
    if oos_start_idx >= n - 20:
        raise ValueError(
            f"not enough data for a meaningful out-of-sample VaR backtest: "
            f"n={n}, oos_start_idx={oos_start_idx}"
        )

    sigma2_forecast = garch_walk_forward_forecast(
        returns,
        fitting_window=settings.garch_fitting_window,
        refit_frequency=settings.garch_refit_frequency,
        oos_start_idx=oos_start_idx,
        dist=dist,
    )

    pre_oos = returns.iloc[:oos_start_idx]
    params, _ = fit_garch(pre_oos, dist=dist)
    pre_oos_sigma2 = conditional_variance_path(pre_oos, params)
    z_pre = (pre_oos.to_numpy() - params.mu) / np.sqrt(pre_oos_sigma2.to_numpy())

    z_q = float(np.quantile(z_pre, 1 - confidence))
    tail_z = z_pre[z_pre <= z_q]
    es_z = float(tail_z.mean()) if len(tail_z) > 0 else z_q

    df = pd.DataFrame({"return": returns, "sigma2": sigma2_forecast}).iloc[oos_start_idx:].dropna()
    df["sigma"] = np.sqrt(df["sigma2"])
    df["var_loss"] = -(params.mu + z_q * df["sigma"])
    df["es_loss"] = -(params.mu + es_z * df["sigma"])
    df["exceed"] = df["return"] < -df["var_loss"]

    n_obs = len(df)
    n_exceed = int(df["exceed"].sum())
    kupiec = kupiec_pof_test(n_obs, n_exceed, confidence)

    if n_exceed > 0:
        realized_es = float(-df.loc[df["exceed"], "return"].mean())
        predicted_es = float(df.loc[df["exceed"], "es_loss"].mean())
        ratio = realized_es / predicted_es if predicted_es != 0 else None
    else:
        realized_es = None
        predicted_es = float(df["es_loss"].mean())
        ratio = None

    es_result = ExpectedShortfallBacktestResult(
        n_exceedances=n_exceed,
        predicted_es=predicted_es,
        realized_es=realized_es,
        ratio=ratio,
    )

    return VarEsBacktestResult(
        confidence=confidence,
        oos_start=df.index.min(),
        oos_end=df.index.max(),
        forecasts=df,
        kupiec=kupiec,
        expected_shortfall=es_result,
    )
