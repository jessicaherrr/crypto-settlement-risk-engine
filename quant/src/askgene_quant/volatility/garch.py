"""GARCH(1,1) conditional volatility.

GARCH is treated as two deliberately separate operations:

1. **Parameter estimation** (`fit_garch`) - maximum-likelihood estimation
   of (omega, alpha, beta) from a fitting window of historical returns.
   This is the expensive, batch operation.
2. **Conditional-variance updating** (`GARCHModel.update`) - given fixed
   parameters, folding in one new observation via the closed-form
   recursion

       sigma2_t = omega + alpha * eps_{t-1}^2 + beta * sigma2_{t-1}

   This is O(1) per observation and is what runs on every new return.
   Parameters are only re-estimated when the caller explicitly calls
   `fit`/`refit` again (see `models.pipeline` for the scheduling policy).

The `arch` package is used purely as the MLE optimizer in step 1; step 2
is a plain recursion over the fitted (omega, alpha, beta) so that updating
never implies silently re-running an optimizer.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from arch import arch_model
from pydantic import BaseModel, field_validator

# `arch` recommends scaling returns into a ~O(1-10) range for numerical
# stability of the optimizer; we fit on returns * _SCALE and rescale the
# resulting parameters back to raw-return units immediately after.
_SCALE = 100.0


class GARCHParams(BaseModel):
    """Fitted GARCH(1,1) parameters, in raw (unscaled) return units."""

    omega: float
    alpha: float
    beta: float
    mu: float = 0.0

    @field_validator("omega")
    @classmethod
    def _omega_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError(f"omega must be positive, got {v}")
        return v

    @field_validator("alpha", "beta")
    @classmethod
    def _non_negative(cls, v: float) -> float:
        if v < 0:
            raise ValueError(f"GARCH coefficients must be non-negative, got {v}")
        return v

    @property
    def persistence(self) -> float:
        """alpha + beta; must be < 1 for a (covariance-)stationary process."""
        return self.alpha + self.beta

    @property
    def unconditional_variance(self) -> float:
        p = self.persistence
        if p >= 1:
            raise ValueError(
                f"process is non-stationary (alpha+beta={p:.4f} >= 1); "
                "unconditional variance is undefined"
            )
        return self.omega / (1 - p)


@dataclass
class GARCHFitDiagnostics:
    n_obs: int
    log_likelihood: float
    aic: float
    bic: float
    converged: bool
    param_std_errors: dict[str, float] = field(default_factory=dict)


def fit_garch(returns: pd.Series, *, dist: str = "normal") -> tuple[GARCHParams, GARCHFitDiagnostics]:
    """Estimate GARCH(1,1) parameters from a window of returns via MLE.

    Returns are demeaned by a constant mean (``mu``) inside the model,
    consistent with treating GARCH purely as a conditional-variance model
    on top of a trivial mean process.
    """
    if len(returns) < 30:
        raise ValueError(
            f"fit_garch needs at least 30 observations, got {len(returns)}"
        )

    scaled = returns.to_numpy() * _SCALE
    am = arch_model(scaled, mean="Constant", vol="Garch", p=1, q=1, dist=dist)
    res = am.fit(disp="off", show_warning=False)

    params = GARCHParams(
        omega=float(res.params["omega"]) / _SCALE**2,
        alpha=float(res.params["alpha[1]"]),
        beta=float(res.params["beta[1]"]),
        mu=float(res.params["mu"]) / _SCALE,
    )
    diagnostics = GARCHFitDiagnostics(
        n_obs=len(returns),
        log_likelihood=float(res.loglikelihood),
        aic=float(res.aic),
        bic=float(res.bic),
        converged=bool(res.convergence_flag == 0),
        param_std_errors={
            "omega": float(res.std_err["omega"]) / _SCALE**2,
            "alpha": float(res.std_err["alpha[1]"]),
            "beta": float(res.std_err["beta[1]"]),
            "mu": float(res.std_err["mu"]) / _SCALE,
        },
    )
    return params, diagnostics


def conditional_variance_path(
    returns: pd.Series, params: GARCHParams, *, sigma2_init: float | None = None
) -> pd.Series:
    """Recompute the full in-sample conditional-variance path for
    ``returns`` under fixed ``params`` (no re-estimation).

    Used for in-sample diagnostics (standardized residuals, etc.) and to
    recover the last filtered variance needed to seed online updates.
    """
    eps = returns.to_numpy() - params.mu
    n = len(eps)
    sigma2 = np.empty(n)
    # Seed from the window's empirical variance rather than the model's
    # theoretical unconditional variance (omega / (1 - alpha - beta)).
    # MLE on crypto data occasionally lands on a near-integrated boundary
    # solution (alpha+beta -> 1), where that denominator is near zero and
    # the theoretical seed explodes numerically even though the fit itself
    # is a legitimate (if extreme) high-persistence estimate.
    prev_sigma2 = sigma2_init if sigma2_init is not None else float(np.var(eps, ddof=1))
    prev_eps2 = prev_sigma2  # neutral seed for eps_0^2
    for t in range(n):
        sigma2[t] = params.omega + params.alpha * prev_eps2 + params.beta * prev_sigma2
        prev_eps2 = eps[t] ** 2
        prev_sigma2 = sigma2[t]
    return pd.Series(sigma2, index=returns.index, name="garch_conditional_variance")


class GARCHModel:
    """Stateful GARCH(1,1): fit once, update cheaply, refit on schedule."""

    def __init__(self, dist: str = "normal"):
        self.dist = dist
        self.params: GARCHParams | None = None
        self.diagnostics: GARCHFitDiagnostics | None = None
        self._last_sigma2: float | None = None
        self._last_eps2: float | None = None

    @property
    def last_variance(self) -> float:
        if self._last_sigma2 is None:
            raise RuntimeError("GARCHModel has not been fit yet")
        return self._last_sigma2

    @property
    def last_squared_residual(self) -> float:
        if self._last_eps2 is None:
            raise RuntimeError("GARCHModel has not been fit yet")
        return self._last_eps2

    def fit(self, returns: pd.Series) -> "GARCHModel":
        """Estimate parameters on ``returns`` (the fitting window) and
        seed the conditional-variance state at the end of that window."""
        self.params, self.diagnostics = fit_garch(returns, dist=self.dist)
        path = conditional_variance_path(returns, self.params)
        self._last_sigma2 = float(path.iloc[-1])
        self._last_eps2 = float((returns.iloc[-1] - self.params.mu) ** 2)
        return self

    def update(self, new_return: float) -> float:
        """Fold in one new observation using the closed-form recursion
        under the *current* fitted parameters - no re-estimation.

        Returns the updated conditional variance (i.e. the filtered
        variance as of the new observation).
        """
        if self.params is None or self._last_sigma2 is None or self._last_eps2 is None:
            raise RuntimeError("call fit(...) before update(...)")
        new_sigma2 = (
            self.params.omega
            + self.params.alpha * self._last_eps2
            + self.params.beta * self._last_sigma2
        )
        self._last_sigma2 = new_sigma2
        self._last_eps2 = (new_return - self.params.mu) ** 2
        return new_sigma2

    def forecast(self, horizon: int = 1) -> np.ndarray:
        """h-step-ahead conditional variance forecasts (h=1..horizon),
        given the current state. Does not mutate state."""
        if self.params is None or self._last_sigma2 is None or self._last_eps2 is None:
            raise RuntimeError("call fit(...) before forecast(...)")
        if horizon < 1:
            raise ValueError("horizon must be >= 1")

        out = np.empty(horizon)
        out[0] = (
            self.params.omega
            + self.params.alpha * self._last_eps2
            + self.params.beta * self._last_sigma2
        )
        # h-step recursion E[sigma2_{t+h}] = omega + (alpha+beta) * E[sigma2_{t+h-1}].
        # Valid whether or not the process is stationary; it just won't
        # converge to a finite unconditional variance when persistence >= 1.
        persistence = self.params.persistence
        for h in range(1, horizon):
            out[h] = self.params.omega + persistence * out[h - 1]
        return out

    def load_state(
        self, params: GARCHParams, *, last_variance: float, last_squared_residual: float
    ) -> "GARCHModel":
        """Restore state from persisted `models.state.ModelState` fields
        without re-fitting - used when resuming an online pipeline."""
        self.params = params
        self._last_sigma2 = last_variance
        self._last_eps2 = last_squared_residual
        return self
