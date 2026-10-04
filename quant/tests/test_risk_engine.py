from __future__ import annotations

from decimal import Decimal

import pytest

from askgene_quant.risk.engine import (
    RiskEngineConfig,
    SimulationMethod,
    run_risk_engine,
)


@pytest.mark.parametrize(
    "method",
    [SimulationMethod.HISTORICAL, SimulationMethod.FILTERED_HISTORICAL, SimulationMethod.GBM],
)
def test_run_risk_engine_produces_sane_var_es(synthetic_garch_returns, fitted_garch, method):
    params, state = fitted_garch
    config = RiskEngineConfig(simulation_method=method, n_scenarios=20_000, seed=1)

    result = run_risk_engine(
        asset="ETH-USD",
        spot_price_usd=Decimal("2000.00"),
        horizon_days=7,
        returns=synthetic_garch_returns,
        garch_params=params,
        model_state=state,
        config=config,
    )

    assert result.var_at(0.99) >= 0
    assert result.es_at(0.99) >= result.var_at(0.99)
    assert result.var_at(0.99) >= result.var_at(0.95)
    assert result.forecast_volatility_annualized > 0
    assert result.horizon_days == 7


def test_run_risk_engine_rejects_invalid_horizon(synthetic_garch_returns, fitted_garch):
    params, state = fitted_garch
    with pytest.raises(ValueError):
        run_risk_engine(
            asset="ETH-USD",
            spot_price_usd=Decimal("2000.00"),
            horizon_days=0,
            returns=synthetic_garch_returns,
            garch_params=params,
            model_state=state,
        )


def test_fhs_and_gbm_tail_loss_grows_with_horizon(synthetic_garch_returns, fitted_garch):
    params, state = fitted_garch
    for method in (SimulationMethod.FILTERED_HISTORICAL, SimulationMethod.GBM):
        config = RiskEngineConfig(simulation_method=method, n_scenarios=30_000, seed=7)
        short = run_risk_engine(
            asset="ETH-USD", spot_price_usd=Decimal(2000), horizon_days=1,
            returns=synthetic_garch_returns, garch_params=params, model_state=state, config=config,
        )
        long = run_risk_engine(
            asset="ETH-USD", spot_price_usd=Decimal(2000), horizon_days=30,
            returns=synthetic_garch_returns, garch_params=params, model_state=state, config=config,
        )
        assert long.es_at(0.99) > short.es_at(0.99)


def test_run_risk_engine_is_reproducible_given_same_seed(synthetic_garch_returns, fitted_garch):
    params, state = fitted_garch
    config = RiskEngineConfig(simulation_method=SimulationMethod.FILTERED_HISTORICAL, n_scenarios=5_000, seed=99)

    r1 = run_risk_engine(
        asset="ETH-USD", spot_price_usd=Decimal(2000), horizon_days=7,
        returns=synthetic_garch_returns, garch_params=params, model_state=state, config=config,
    )
    r2 = run_risk_engine(
        asset="ETH-USD", spot_price_usd=Decimal(2000), horizon_days=7,
        returns=synthetic_garch_returns, garch_params=params, model_state=state, config=config,
    )
    assert r1.var_at(0.99) == r2.var_at(0.99)
    assert r1.es_at(0.99) == r2.es_at(0.99)
