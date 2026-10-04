"""End-to-end Phase D risk-engine runner for ETH/USD.

GARCH volatility state (Phase C) -> settlement-value return distribution
(historical / filtered historical / GBM) -> VaR / Expected Shortfall ->
stress testing -> collateral policy -> RiskQuote, across the four
settlement horizons the product supports (1d/7d/14d/30d). Finishes with
the out-of-sample VaR validation (exceedance rate + Kupiec test).

Usage:
    python scripts/run_risk_pipeline.py
"""

from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import json

from askgene_quant.config import DEFAULT_VOLATILITY_SETTINGS
from askgene_quant.data.loader import load_market_data
from askgene_quant.data.quality import check_data_quality
from askgene_quant.data.returns import log_returns
from askgene_quant.models.pipeline import GarchVolatilityPipeline
from askgene_quant.models.store import ModelStateStore
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
from askgene_quant.validation.var_backtest import walk_forward_var_backtest

ASSET = "ETH-USD"
NOTIONAL = Decimal(10)  # ETH
HORIZONS = (1, 7, 14, 30)
CONFIDENCE_LEVELS = (0.95, 0.99)
PRIMARY_CONFIDENCE = 0.99
N_SCENARIOS = 50_000


def main() -> None:
    print(f"=== Phase D risk engine: {ASSET} ===\n")

    print("[1/5] Loading market data + GARCH state (Phase C)...")
    ohlcv = load_market_data(ASSET)
    check_data_quality(ohlcv).raise_if_invalid()
    returns = log_returns(ohlcv["close"])
    spot = Decimal(str(ohlcv["close"].iloc[-1]))
    print(f"  {len(returns)} returns, {returns.index.min().date()} -> {returns.index.max().date()}")
    print(f"  spot: ${spot:,.2f}")

    settings = DEFAULT_VOLATILITY_SETTINGS
    store = ModelStateStore()
    pipeline = GarchVolatilityPipeline(ASSET, settings=settings, store=store)
    state = pipeline.load()
    if state is None:
        print("  no persisted GARCH state found; fitting fresh...")
        state = pipeline.fit(returns.iloc[-settings.garch_fitting_window :])
    params = pipeline._model.params
    current_vol = (state.latest_conditional_variance * settings.periods_per_year) ** 0.5
    print(f"  GARCH(1,1): omega={params.omega:.3e} alpha={params.alpha:.4f} beta={params.beta:.4f}")
    print(f"  current annualized vol: {current_vol:.1%}\n")

    print("[2/5] Return-distribution methods, by horizon...")
    print(f"  {'horizon':>8}  {'method':<32}{'n':>8}{'VaR99':>9}{'ES99':>9}")
    risk_results = {}
    for horizon in HORIZONS:
        for method in SimulationMethod:
            config = RiskEngineConfig(simulation_method=method, n_scenarios=N_SCENARIOS, confidence_levels=CONFIDENCE_LEVELS)
            result = run_risk_engine(
                asset=ASSET, spot_price_usd=spot, horizon_days=horizon,
                returns=returns, garch_params=params, model_state=state, config=config,
            )
            if method == SimulationMethod.FILTERED_HISTORICAL:
                risk_results[horizon] = result
            print(
                f"  {horizon:>7}d  {method.value:<32}{result.n_scenarios:>8}"
                f"{float(result.var_at(0.99)):>9.1%}{float(result.es_at(0.99)):>9.1%}"
            )
    print()

    print("[3/5] Stress testing (filtered-historical-simulation horizons)...")
    stress_results = {}
    for horizon in HORIZONS:
        stress = run_stress_tests(
            returns=returns, garch_params=params, model_state=state,
            horizon_days=horizon, confidence=PRIMARY_CONFIDENCE, n_scenarios=N_SCENARIOS,
        )
        stress_results[horizon] = stress
        print(f"  horizon={horizon}d  worst={stress.worst_scenario_name} ({stress.worst_loss_fraction:.1%})")
        for s in stress.scenarios:
            print(f"    {s.name:28s} {s.loss_fraction:>7.1%}  {s.description}")
    print()

    print("[4/5] Collateral policy + RiskQuote, per horizon...")
    policy = CollateralPolicyConfig(confidence_level=PRIMARY_CONFIDENCE)
    quotes = {}
    for horizon in HORIZONS:
        risk_result = risk_results[horizon]
        stress = stress_results[horizon]
        decision = apply_collateral_policy(
            notional=NOTIONAL,
            es_loss_fraction=risk_result.es_at(PRIMARY_CONFIDENCE),
            stress_loss_fraction=Decimal(str(stress.worst_loss_fraction)),
            policy=policy,
        )
        quote = build_risk_quote(
            asset=ASSET, notional=NOTIONAL, spot_price_usd=spot, horizon_days=horizon,
            confidence_level=PRIMARY_CONFIDENCE, risk_result=risk_result,
            stress_summary=stress, collateral_decision=decision,
        )
        quotes[horizon] = quote
        print(
            f"  {horizon:>2}d  notional={NOTIONAL} ETH  ES99={float(risk_result.es_at(0.99)):.1%}  "
            f"stress={stress.worst_loss_fraction:.1%}  ratio={float(decision.collateral_ratio):.3f}  "
            f"required={float(decision.required_collateral):.4f} ETH"
        )

    sample_quote = quotes[7]
    print(f"\n  sample 7d RiskQuote:\n{sample_quote.model_dump_json(indent=2)}")
    onchain = sample_quote.to_onchain_fields(
        depositor="0x" + "11" * 20, counterparty="0x" + "22" * 20, settlement_asset_address="0x" + "00" * 20,
    )
    print(f"\n  on-chain RiskQuote fields (RiskQuoteVerifier.sol):\n{json.dumps(onchain, indent=2)}\n")

    print("[5/5] VaR / ES validation (1-day, out-of-sample, no look-ahead)...")
    for confidence in CONFIDENCE_LEVELS:
        bt = walk_forward_var_backtest(returns, confidence=confidence, settings=settings)
        print(
            f"  confidence={confidence:.0%}  n_obs={bt.kupiec.n_obs}  n_exceed={bt.kupiec.n_exceedances}  "
            f"rate={bt.kupiec.exceedance_rate:.2%}  expected={bt.kupiec.expected_rate:.2%}  "
            f"Kupiec LR={bt.kupiec.lr_statistic:.3f}  p={bt.kupiec.p_value:.3f}  "
            f"reject_at_5pct={bt.kupiec.reject_at_5pct}"
        )
        es = bt.expected_shortfall
        ratio_str = f"{es.ratio:.3f}" if es.ratio is not None else "n/a"
        print(
            f"    ES: predicted={es.predicted_es:.2%}  realized={es.realized_es if es.realized_es is None else f'{es.realized_es:.2%}'}  "
            f"ratio(realized/predicted)={ratio_str}"
        )

    print("\nDone.")


if __name__ == "__main__":
    main()
