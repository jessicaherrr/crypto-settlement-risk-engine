from __future__ import annotations

from decimal import Decimal

import numpy as np
import pytest

from askgene_quant.risk.measures import expected_shortfall, exposure_usd, value_at_risk


def test_value_at_risk_matches_quantile_definition():
    returns = np.linspace(-0.5, 0.5, 1001)  # uniform grid, easy quantiles
    var95 = value_at_risk(returns, 0.95)
    assert var95 == pytest.approx(-np.quantile(returns, 0.05))


def test_value_at_risk_floors_at_zero_when_tail_is_a_gain():
    returns = np.linspace(0.1, 0.5, 1000)  # all positive
    assert value_at_risk(returns, 0.99) == 0.0


def test_expected_shortfall_at_least_as_large_as_var():
    rng = np.random.default_rng(0)
    returns = rng.standard_t(df=4, size=100_000) * 0.05  # fat-tailed
    var99 = value_at_risk(returns, 0.99)
    es99 = expected_shortfall(returns, 0.99)
    assert es99 >= var99


def test_expected_shortfall_handles_degenerate_empty_tail():
    returns = np.array([0.5, 0.6, 0.7])  # confidence so high the tail could be empty
    es = expected_shortfall(returns, 0.999999)
    assert es >= 0.0


def test_measures_reject_invalid_confidence():
    returns = np.array([0.0, 0.1, -0.1])
    with pytest.raises(ValueError):
        value_at_risk(returns, 1.0)
    with pytest.raises(ValueError):
        expected_shortfall(returns, 0.0)


def test_exposure_usd_multiplies_notional_by_spot():
    assert exposure_usd(Decimal("2.5"), Decimal("2000.00")) == Decimal("5000.000")
