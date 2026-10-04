"""Tests for the dashboard analytics layer: `service/analytics.py` (pure
orchestration over already-tested functions, plus caching) and the new
read-only endpoints in `service/app.py`.

Shape/consistency tests use a locally-built `AnalyticsInputs` from the
existing `synthetic_garch_returns`/`fitted_garch` fixtures (fast, no
network, no disk model-state dependency). The HTTP-level tests exercise
the real ETH-USD data/model path, following the same
`_market_data_available()` skip convention as `test_service_app.py`, and
deliberately each hit a given endpoint only once - they share
`analytics._default_cache`, a process-lifetime singleton, so repeat calls
across tests in this module would otherwise just be re-testing the cache
rather than the endpoint.
"""

from __future__ import annotations

import threading
import time as time_module
from dataclasses import replace
from decimal import Decimal

import pandas as pd
import pytest

from askgene_quant.config import DEFAULT_VOLATILITY_SETTINGS
from askgene_quant.models.state import ModelState
from askgene_quant.policy.collateral import (
    CollateralPolicyConfig,
    apply_collateral_policy,
)
from askgene_quant.risk.engine import (
    RiskEngineConfig,
    SimulationMethod,
    run_risk_engine,
)
from askgene_quant.risk.stress import run_stress_tests
from askgene_quant.service.analytics import (
    VOL_HISTORY_DAYS,
    AnalyticsInputs,
    build_garch_view,
    build_risk_snapshot,
    build_tail_comparison,
    build_var_backtest,
    build_volatility_comparison,
)
from askgene_quant.service.cache import AnalyticsCache
from askgene_quant.service.quoting import DEFAULT_N_SCENARIOS, SUPPORTED_HORIZONS_DAYS
from askgene_quant.volatility.garch import GARCHParams

TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"


@pytest.fixture
def analytics_inputs(
    synthetic_garch_returns: pd.Series, fitted_garch: tuple[GARCHParams, ModelState]
) -> AnalyticsInputs:
    params, state = fitted_garch
    returns = synthetic_garch_returns
    fingerprint = (
        returns.index[-1].isoformat(),
        len(returns),
        state.fit_timestamp.isoformat(),
    )
    return AnalyticsInputs(
        asset="ETH-USD",
        ohlcv=pd.DataFrame(),  # unused by build_* - they only read returns/spot/state/params/settings
        returns=returns,
        spot=Decimal(2000),
        state=state,
        params=params,
        settings=DEFAULT_VOLATILITY_SETTINGS,
        fingerprint=fingerprint,
    )


# --- build_garch_view ---------------------------------------------------


def test_garch_view_shape(analytics_inputs: AnalyticsInputs):
    result = build_garch_view(analytics_inputs, cache=AnalyticsCache())

    assert result["meta"]["cache"] == "miss"
    assert 0 < result["persistence"] < 1
    assert result["half_life_days"] == pytest.approx(
        __import__("math").log(0.5) / __import__("math").log(result["persistence"])
    )
    assert result["current_vol_annualized"] > 0
    assert result["long_run_vol_annualized"] is not None
    # `fitted_garch` (conftest.py) builds its ModelState without
    # fit_diagnostics - this just checks the shape passes through
    # unmodified, not any particular diagnostic value.
    assert isinstance(result["diagnostics"], dict)
    assert result["training_window"]["n_obs"] == len(analytics_inputs.returns)

    expected_len = min(VOL_HISTORY_DAYS, len(analytics_inputs.returns))
    assert len(result["vol_history"]) == expected_len
    for row in result["vol_history"][-5:]:
        assert isinstance(row["conditional_vol"], float)
        assert row["conditional_vol"] > 0


def test_garch_view_near_integrated_has_no_long_run_vol(analytics_inputs: AnalyticsInputs):
    near_integrated = analytics_inputs.params.model_copy(update={"alpha": 0.5, "beta": 0.5})
    inputs = replace(analytics_inputs, params=near_integrated)
    result = build_garch_view(inputs, cache=AnalyticsCache())
    assert result["long_run_vol_annualized"] is None
    assert result["persistence"] == pytest.approx(1.0)


# --- build_risk_snapshot -------------------------------------------------


def test_risk_snapshot_has_all_horizons(analytics_inputs: AnalyticsInputs):
    result = build_risk_snapshot(analytics_inputs, confidence=0.99, cache=AnalyticsCache())
    assert {h["horizon_days"] for h in result["horizons"]} == set(SUPPORTED_HORIZONS_DAYS)
    assert result["simulation_method"] == "filtered_historical_simulation"
    for h in result["horizons"]:
        assert Decimal(h["required_collateral_per_unit"]) >= Decimal(1)
        assert h["loss_basis_source"] in ("expected_shortfall", "stress")


def test_risk_snapshot_matches_independently_computed_policy(analytics_inputs: AnalyticsInputs):
    """build_risk_snapshot must be pure reassembly of the existing risk
    engine + stress + collateral policy functions - this reruns horizon=1
    through them directly (same seed=42) and checks the numbers agree
    exactly, not just approximately."""
    result = build_risk_snapshot(analytics_inputs, confidence=0.99, cache=AnalyticsCache())
    h1 = next(h for h in result["horizons"] if h["horizon_days"] == 1)

    engine_config = RiskEngineConfig(
        simulation_method=SimulationMethod.FILTERED_HISTORICAL,
        confidence_levels=(0.99,),
        primary_confidence=0.99,
        n_scenarios=DEFAULT_N_SCENARIOS,
        seed=42,
    )
    risk_result = run_risk_engine(
        asset=analytics_inputs.asset,
        spot_price_usd=analytics_inputs.spot,
        horizon_days=1,
        returns=analytics_inputs.returns,
        garch_params=analytics_inputs.params,
        model_state=analytics_inputs.state,
        config=engine_config,
    )
    stress_summary = run_stress_tests(
        returns=analytics_inputs.returns,
        garch_params=analytics_inputs.params,
        model_state=analytics_inputs.state,
        horizon_days=1,
        confidence=0.99,
        n_scenarios=DEFAULT_N_SCENARIOS,
        seed=42,
    )
    decision = apply_collateral_policy(
        notional=Decimal(1),
        es_loss_fraction=risk_result.es_at(0.99),
        stress_loss_fraction=Decimal(str(stress_summary.worst_loss_fraction)),
        policy=CollateralPolicyConfig(confidence_level=0.99),
    )

    assert Decimal(h1["collateral_ratio"]) == decision.collateral_ratio
    assert Decimal(h1["required_collateral_per_unit"]) == decision.required_collateral
    assert Decimal(h1["expected_shortfall"]) == risk_result.es_at(0.99)
    assert h1["worst_stress_scenario"] == stress_summary.worst_scenario_name


# --- build_volatility_comparison -----------------------------------------


def test_volatility_comparison_shape(analytics_inputs: AnalyticsInputs):
    result = build_volatility_comparison(analytics_inputs, cache=AnalyticsCache())
    assert set(result["metrics"]) == {"rolling_hist_vol", "ewma", "garch"}
    for metrics in result["metrics"].values():
        assert set(metrics) == {"rmse", "qlike"}
        assert isinstance(metrics["rmse"], float)
    assert result["n_oos"] == len(result["series"])
    assert result["proxy"] == "squared_log_return"
    for row in result["series"][:5]:
        for key in ("proxy_vol", "rolling_hist_vol", "ewma", "garch"):
            assert isinstance(row[key], float)
            assert row[key] >= 0


# --- build_var_backtest ---------------------------------------------------


def test_var_backtest_shape(analytics_inputs: AnalyticsInputs):
    result = build_var_backtest(analytics_inputs, confidences=(0.95, 0.99), cache=AnalyticsCache())
    assert result["horizon_days"] == 1
    assert {r["confidence"] for r in result["results"]} == {0.95, 0.99}
    for r in result["results"]:
        assert set(r["kupiec"]) == {
            "n_obs",
            "n_exceedances",
            "exceedance_rate",
            "expected_rate",
            "lr_statistic",
            "p_value",
            "reject_at_5pct",
        }
        assert set(r["expected_shortfall"]) == {
            "n_exceedances",
            "predicted_es",
            "realized_es",
            "ratio",
        }
    assert len(result["series"]) > 0
    assert len(result["assumptions"]) >= 1


# --- build_tail_comparison -------------------------------------------------


def test_tail_comparison_shape(analytics_inputs: AnalyticsInputs):
    result = build_tail_comparison(analytics_inputs, cache=AnalyticsCache())
    assert result["n_scenarios"] == DEFAULT_N_SCENARIOS
    assert len(result["rows"]) == len(SUPPORTED_HORIZONS_DAYS) * len(list(SimulationMethod))
    assert {row["method"] for row in result["rows"]} == {m.value for m in SimulationMethod}
    sample = result["rows"][0]
    assert set(sample["var"]) == {"0.9500", "0.9900"}
    assert set(sample["expected_shortfall"]) == {"0.9500", "0.9900"}
    # uint256-adjacent money/loss fractions must be strings, never bare floats.
    assert isinstance(sample["var"]["0.9900"], str)


# --- AnalyticsCache --------------------------------------------------------


def test_cache_hit_on_repeat_call():
    calls = []
    cache = AnalyticsCache(ttl_seconds=100)

    def compute():
        calls.append(1)
        return {"x": 1}

    v1, hit1 = cache.get_or_compute(name="n", params=(), fingerprint="f", compute=compute)
    v2, hit2 = cache.get_or_compute(name="n", params=(), fingerprint="f", compute=compute)

    assert hit1 is False
    assert hit2 is True
    assert len(calls) == 1
    assert v1 == v2 == {"x": 1}


def test_cache_ttl_expiry():
    now = [0.0]
    cache = AnalyticsCache(ttl_seconds=10, clock=lambda: now[0])

    cache.get_or_compute(name="n", params=(), fingerprint="f", compute=lambda: "a")
    now[0] = 5.0
    _, hit = cache.get_or_compute(name="n", params=(), fingerprint="f", compute=lambda: "b")
    assert hit is True  # still fresh

    now[0] = 11.0
    value, hit = cache.get_or_compute(name="n", params=(), fingerprint="f", compute=lambda: "b")
    assert hit is False  # TTL elapsed
    assert value == "b"


def test_cache_fingerprint_change_invalidates():
    cache = AnalyticsCache(ttl_seconds=1000)
    cache.get_or_compute(name="n", params=(), fingerprint="f1", compute=lambda: "a")
    value, hit = cache.get_or_compute(name="n", params=(), fingerprint="f2", compute=lambda: "b")
    assert hit is False
    assert value == "b"


def test_cache_distinct_params_do_not_collide():
    cache = AnalyticsCache(ttl_seconds=1000)
    v95, _ = cache.get_or_compute(name="n", params=(0.95,), fingerprint="f", compute=lambda: "a")
    v99, hit99 = cache.get_or_compute(name="n", params=(0.99,), fingerprint="f", compute=lambda: "b")
    assert hit99 is False
    assert v95 == "a"
    assert v99 == "b"


def test_cache_concurrent_cold_requests_compute_once():
    calls = []
    start_barrier = threading.Barrier(5)

    def compute():
        time_module.sleep(0.05)
        calls.append(1)
        return "computed"

    cache = AnalyticsCache(ttl_seconds=1000)
    results: list[tuple[str, bool]] = []

    def worker():
        start_barrier.wait()
        results.append(cache.get_or_compute(name="n", params=(), fingerprint="f", compute=compute))

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(calls) == 1
    assert all(v == "computed" for v, _ in results)
    assert sum(1 for _, hit in results if hit) == 4


# --- HTTP layer (real ETH-USD data) ---------------------------------------


def _market_data_available() -> bool:
    try:
        from askgene_quant.data.loader import load_market_data

        load_market_data("ETH-USD")
        return True
    except Exception:  # noqa: BLE001 - any failure means "skip", not "fail"
        return False


pytestmark = pytest.mark.skipif(
    not _market_data_available(),
    reason="ETH-USD market data not cached locally and not fetchable (no network)",
)


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    from askgene_quant.service import app as app_module

    monkeypatch.setenv("RISK_ORACLE_PRIVATE_KEY", TEST_PRIVATE_KEY)
    app_module._signer = None
    with TestClient(app_module.app) as c:
        yield c
    app_module._signer = None


def test_health_endpoint(client):
    resp = client.get("/v1/health")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert body["oracle_address"].startswith("0x")


def test_models_garch_endpoint(client):
    resp = client.get("/v1/models/garch")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "params" in body and "vol_history" in body
    assert body["meta"]["asset"] == "ETH-USD"


def test_models_garch_rejects_unsupported_asset(client):
    resp = client.get("/v1/models/garch", params={"asset": "BTC-USD"})
    assert resp.status_code == 422


def test_risk_snapshot_endpoint(client):
    resp = client.get("/v1/risk/snapshot")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["horizons"]) == len(SUPPORTED_HORIZONS_DAYS)
    # Money-like fields must be decimal strings, never floats.
    assert isinstance(body["spot_price_usd"], str)
    assert isinstance(body["horizons"][0]["required_collateral_per_unit"], str)


def test_risk_snapshot_rejects_unsupported_confidence(client):
    resp = client.get("/v1/risk/snapshot", params={"confidence": 0.50})
    assert resp.status_code == 422


def test_validation_volatility_endpoint(client):
    resp = client.get("/v1/validation/volatility")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body["metrics"]) == {"rolling_hist_vol", "ewma", "garch"}


def test_validation_var_backtest_endpoint(client):
    resp = client.get("/v1/validation/var-backtest")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["horizon_days"] == 1
    assert len(body["results"]) >= 1


def test_validation_tail_comparison_endpoint(client):
    resp = client.get("/v1/validation/tail-comparison")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["rows"]) == len(SUPPORTED_HORIZONS_DAYS) * 3
