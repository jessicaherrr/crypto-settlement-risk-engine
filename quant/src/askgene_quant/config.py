"""Shared configuration for the askgene_quant package.

Central place for defaults used across the data, volatility, and
validation layers. Everything here can be overridden per call-site
(functions take explicit parameters) - this module only fixes what the
project uses when the caller doesn't care.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

# quant/ (the package root, one level above src/)
PACKAGE_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_DATA_CACHE_DIR = PACKAGE_ROOT / "data_cache"
DEFAULT_MODEL_STATE_DIR = PACKAGE_ROOT / "model_state"

# Trading-day convention for annualizing crypto volatility. Crypto trades
# every calendar day (no exchange holidays), so we annualize with 365
# rather than the equities convention of 252.
PERIODS_PER_YEAR = 365


class VolatilitySettings(BaseModel):
    """Defaults for the volatility estimation layer."""

    asset: str = "ETH-USD"

    # Realized / rolling volatility window, in observations (days).
    realized_window: int = 30

    # RiskMetrics-style EWMA decay factor.
    ewma_lambda: float = 0.94

    # GARCH(1,1) fitting-window length, in observations (days). ~3 trading
    # years of daily crypto data; long enough for stable MLE, short enough
    # that the volatility regime isn't too stale.
    garch_fitting_window: int = 750

    # How often (in observations/days) the GARCH model re-estimates its
    # parameters from scratch. Between refits, new observations only drive
    # the conditional-variance recursion (see volatility.garch).
    garch_refit_frequency: int = 21

    periods_per_year: int = PERIODS_PER_YEAR


DEFAULT_VOLATILITY_SETTINGS = VolatilitySettings()


class DataSettings(BaseModel):
    """Defaults for the market-data layer."""

    product_id: str = "ETH-USD"
    granularity_seconds: int = 86400  # daily candles
    cache_dir: Path = Field(default=DEFAULT_DATA_CACHE_DIR)


DEFAULT_DATA_SETTINGS = DataSettings()
