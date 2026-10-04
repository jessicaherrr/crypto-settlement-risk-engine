"""Online GARCH(1,1) pipeline: ties together estimation, state
persistence, and the fit/update/refit lifecycle.

    historical data
      -> fit model parameters              (GarchVolatilityPipeline.fit)
      -> save model state                  (automatic, via ModelStateStore)
      -> receive new return
      -> update conditional variance        (GarchVolatilityPipeline.update)
      -> produce new volatility forecast    (GarchVolatilityPipeline.forecast)
      -> periodically refit parameters      (GarchVolatilityPipeline.should_refit / fit)

Fitting-window length and refit frequency are both configurable per
instance. A fit (or refit) is an explicit, infrequent call; `update` never
re-estimates parameters - it only advances the closed-form recursion.
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from askgene_quant.config import DEFAULT_VOLATILITY_SETTINGS, VolatilitySettings
from askgene_quant.models.state import ModelState
from askgene_quant.models.store import ModelStateStore
from askgene_quant.volatility.garch import GARCHModel, GARCHParams

MODEL_NAME = "garch_1_1"
MODEL_VERSION = "garch_1_1-v1"


class GarchVolatilityPipeline:
    def __init__(
        self,
        asset: str,
        *,
        settings: VolatilitySettings = DEFAULT_VOLATILITY_SETTINGS,
        store: ModelStateStore | None = None,
        model_version: str = MODEL_VERSION,
        dist: str = "normal",
    ):
        self.asset = asset
        self.settings = settings
        self.store = store or ModelStateStore()
        self.model_version = model_version
        self.dist = dist

        self._model = GARCHModel(dist=dist)
        self._state: ModelState | None = None
        self._n_updates_since_fit = 0

    @property
    def state(self) -> ModelState:
        if self._state is None:
            raise RuntimeError("pipeline has no state yet; call fit() or load()")
        return self._state

    def fit(self, returns: pd.Series) -> ModelState:
        """Estimate parameters on ``returns`` (the fitting window), seed
        the conditional-variance recursion, and persist the resulting
        state. ``returns`` should already be trimmed to the desired
        fitting-window length by the caller."""
        self._model = GARCHModel(dist=self.dist).fit(returns)
        params = self._model.params
        diag = self._model.diagnostics
        assert params is not None and diag is not None

        now = datetime.now(timezone.utc)
        self._state = ModelState(
            asset=self.asset,
            model_name=MODEL_NAME,
            model_version=self.model_version,
            training_window_start=returns.index[0].to_pydatetime(),
            training_window_end=returns.index[-1].to_pydatetime(),
            n_obs_fit=len(returns),
            fitted_params=params.model_dump(),
            fit_diagnostics={
                "log_likelihood": diag.log_likelihood,
                "aic": diag.aic,
                "bic": diag.bic,
                "converged": float(diag.converged),
            },
            fit_timestamp=now,
            latest_conditional_variance=self._model.last_variance,
            latest_observation_timestamp=returns.index[-1].to_pydatetime(),
            latest_squared_residual=self._model.last_squared_residual,
            config={
                "fitting_window": self.settings.garch_fitting_window,
                "refit_frequency": self.settings.garch_refit_frequency,
                "dist": self.dist,
            },
        )
        self.store.save(self._state, record_history=True)
        self._n_updates_since_fit = 0
        return self._state

    def load(self) -> ModelState | None:
        """Restore state (and the underlying GARCHModel) from disk."""
        state = self.store.load(self.asset, MODEL_NAME)
        if state is None:
            return None
        self._model = GARCHModel(dist=self.dist).load_state(
            GARCHParams(**state.fitted_params),
            last_variance=state.latest_conditional_variance,
            last_squared_residual=state.latest_squared_residual or 0.0,
        )
        self._state = state
        self._n_updates_since_fit = 0
        return state

    def update(self, new_return: float, observation_timestamp: datetime) -> float:
        """Fold in one new observation (no re-estimation) and persist the
        advanced state. Returns the updated conditional variance."""
        new_variance = self._model.update(new_return)
        self._n_updates_since_fit += 1

        prev = self.state
        self._state = prev.model_copy(
            update={
                "latest_conditional_variance": new_variance,
                "latest_observation_timestamp": observation_timestamp,
                "latest_squared_residual": self._model.last_squared_residual,
            }
        )
        self.store.save(self._state, record_history=False)
        return new_variance

    def forecast(self, horizon: int = 1) -> np.ndarray:
        return self._model.forecast(horizon)

    def should_refit(self) -> bool:
        return self._n_updates_since_fit >= self.settings.garch_refit_frequency
