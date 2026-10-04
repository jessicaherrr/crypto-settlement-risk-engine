from __future__ import annotations

from decimal import Decimal

from askgene_quant.policy.collateral import (
    CollateralPolicyConfig,
    apply_collateral_policy,
)
from askgene_quant.quotes.risk_quote import build_risk_quote
from askgene_quant.risk.engine import (
    RiskEngineConfig,
    SimulationMethod,
    run_risk_engine,
)
from askgene_quant.risk.stress import run_stress_tests
from askgene_quant.serialization import from_fixed_point, to_fixed_point


def _build_quote(synthetic_garch_returns, fitted_garch, horizon_days=7, notional=Decimal(10)):
    params, state = fitted_garch
    config = RiskEngineConfig(simulation_method=SimulationMethod.FILTERED_HISTORICAL, n_scenarios=10_000, seed=3)

    risk_result = run_risk_engine(
        asset="ETH-USD", spot_price_usd=Decimal("2000.00"), horizon_days=horizon_days,
        returns=synthetic_garch_returns, garch_params=params, model_state=state, config=config,
    )
    stress_summary = run_stress_tests(
        returns=synthetic_garch_returns, garch_params=params, model_state=state,
        horizon_days=horizon_days, n_scenarios=10_000,
    )
    collateral_decision = apply_collateral_policy(
        notional=notional,
        es_loss_fraction=risk_result.es_at(0.99),
        stress_loss_fraction=Decimal(str(stress_summary.worst_loss_fraction)),
        policy=CollateralPolicyConfig(),
    )
    quote = build_risk_quote(
        asset="ETH-USD", notional=notional, spot_price_usd=Decimal("2000.00"),
        horizon_days=horizon_days, confidence_level=0.99,
        risk_result=risk_result, stress_summary=stress_summary, collateral_decision=collateral_decision,
    )
    return quote


def test_build_risk_quote_populates_all_required_fields(synthetic_garch_returns, fitted_garch):
    quote = _build_quote(synthetic_garch_returns, fitted_garch)

    assert quote.quote_id.startswith("0x") and len(quote.quote_id) == 66
    assert quote.risk_snapshot_hash.startswith("0x") and len(quote.risk_snapshot_hash) == 66
    assert quote.asset == "ETH-USD"
    assert quote.settlement_horizon_days == 7
    assert quote.settlement_horizon_seconds == 7 * 86_400
    assert quote.required_collateral >= quote.notional
    assert quote.quote_expiration > quote.quote_created_at
    assert quote.value_at_risk >= 0
    assert quote.expected_shortfall >= quote.value_at_risk


def test_risk_quote_ids_are_unique_across_builds(synthetic_garch_returns, fitted_garch):
    q1 = _build_quote(synthetic_garch_returns, fitted_garch)
    q2 = _build_quote(synthetic_garch_returns, fitted_garch)
    assert q1.quote_id != q2.quote_id
    assert q1.risk_snapshot_id != q2.risk_snapshot_id


def test_to_onchain_fields_matches_risk_quote_verifier_schema(synthetic_garch_returns, fitted_garch):
    quote = _build_quote(synthetic_garch_returns, fitted_garch, notional=Decimal(10))
    onchain = quote.to_onchain_fields(
        depositor="0x" + "11" * 20,
        counterparty="0x" + "22" * 20,
        settlement_asset_address="0x" + "00" * 20,
    )

    expected_keys = {
        "quoteId", "depositor", "counterparty", "settlementAsset", "notional",
        "requiredCollateral", "quoteExpiration", "settlementHorizon", "modelVersion",
        "riskSnapshotHash",
    }
    assert set(onchain.keys()) == expected_keys

    assert onchain["notional"] == to_fixed_point(quote.notional)
    assert isinstance(onchain["requiredCollateral"], int)
    assert from_fixed_point(onchain["requiredCollateral"]) >= quote.required_collateral
    assert onchain["settlementHorizon"] == quote.settlement_horizon_seconds
    assert onchain["quoteExpiration"] == int(quote.quote_expiration.timestamp())
    assert onchain["modelVersion"] == quote.model_version
    assert onchain["riskSnapshotHash"] == quote.risk_snapshot_hash
