"""Core risk measures: exposure, Value at Risk, Expected Shortfall.

These functions operate on *simple* (not log) returns, because what
matters financially is the fraction of settlement value lost -
``V_T / V_0 - 1`` - not the log-price change. For small moves the two are
nearly identical, but settlement horizons here run up to 30 days and crypto
routinely moves 20-50%+ over that kind of window, where the gap between
log and simple returns is not negligible. Simulation modules
(`simulation/`) produce cumulative *log* returns (because log returns are
what's additive across days); callers convert with
``simple_returns = np.exp(log_returns) - 1`` before calling into this
module - see `risk/engine.py`.

VaR and ES are both expressed as *positive loss fractions* of notional:
a VaR of 0.12 at 99% confidence means "no more than a 12% loss, 99% of the
time"; it is not a signed return.
"""

from __future__ import annotations

from decimal import Decimal

import numpy as np


def value_at_risk(simple_returns: np.ndarray, confidence: float) -> float:
    """Historical/simulated VaR at ``confidence`` (e.g. 0.99), as a
    positive loss fraction.

    Defined as the loss at the ``1 - confidence`` quantile of the return
    distribution: ``VaR = -quantile(returns, 1 - confidence)``, floored at
    0 (a quantile that comes out positive, i.e. even the "bad" tail is a
    gain, implies no loss at that confidence level).
    """
    _validate_confidence(confidence)
    q = float(np.quantile(simple_returns, 1 - confidence))
    return max(-q, 0.0)


def expected_shortfall(simple_returns: np.ndarray, confidence: float) -> float:
    """Expected Shortfall (CVaR) at ``confidence``: the average loss in
    the tail beyond the VaR threshold, as a positive loss fraction.

    Strictly more conservative than VaR (it's the mean of the tail, not
    just its boundary) and, unlike VaR, is subadditive / a coherent risk
    measure.
    """
    _validate_confidence(confidence)
    threshold = np.quantile(simple_returns, 1 - confidence)
    tail = simple_returns[simple_returns <= threshold]
    if len(tail) == 0:
        tail = np.array([threshold])
    return max(-float(tail.mean()), 0.0)


def exposure_usd(notional: Decimal, spot_price_usd: Decimal) -> Decimal:
    """Mark-to-market USD exposure of a ``notional`` (in units of the
    settlement asset) at ``spot_price_usd``."""
    return notional * spot_price_usd


def _validate_confidence(confidence: float) -> None:
    if not 0.0 < confidence < 1.0:
        raise ValueError(f"confidence must be in (0, 1), got {confidence}")
