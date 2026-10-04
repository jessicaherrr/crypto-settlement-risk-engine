"""Model state: the serializable record of a fitted volatility model.

This is what gets persisted between runs so that an online pipeline can
restart, fold in new observations, and periodically refit without ever
needing to reload the raw history. It also records enough metadata
(training window, fit timestamp, fitted params, model version) to
reproduce the model from scratch.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ModelState(BaseModel):
    """Persisted state for one fitted volatility model instance.

    ``model_version`` is a free-form string the caller controls (e.g. a
    semver-like "garch-1.1" or a config hash) - it exists so that a saved
    state can be checked for compatibility before being loaded back into
    a model object, and so validation/reporting can tell which model
    generation produced a given forecast.
    """

    asset: str
    model_name: str  # e.g. "garch_1_1", "ewma"
    model_version: str

    training_window_start: datetime
    training_window_end: datetime
    n_obs_fit: int

    fitted_params: dict[str, float]
    fit_diagnostics: dict[str, float] = Field(default_factory=dict)
    fit_timestamp: datetime

    # Online recursion state as of the most recent observation folded in
    # (which may be later than training_window_end if updates have been
    # applied since the last fit).
    latest_conditional_variance: float
    latest_observation_timestamp: datetime
    latest_squared_residual: float | None = None

    config: dict[str, float | int | str] = Field(default_factory=dict)

    def state_key(self) -> str:
        return f"{self.asset}__{self.model_name}".replace("/", "_")
