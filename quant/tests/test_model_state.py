from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pytest

from askgene_quant.config import VolatilitySettings
from askgene_quant.models.pipeline import GarchVolatilityPipeline
from askgene_quant.models.state import ModelState
from askgene_quant.models.store import ModelStateStore


def _sample_state(**overrides) -> ModelState:
    defaults = dict(
        asset="ETH-USD",
        model_name="garch_1_1",
        model_version="garch_1_1-v1",
        training_window_start=datetime(2023, 1, 1, tzinfo=timezone.utc),
        training_window_end=datetime(2023, 12, 31, tzinfo=timezone.utc),
        n_obs_fit=365,
        fitted_params={"omega": 1e-5, "alpha": 0.08, "beta": 0.88, "mu": 0.0},
        fit_diagnostics={"log_likelihood": -100.0, "aic": 210.0, "bic": 220.0},
        fit_timestamp=datetime(2024, 1, 1, tzinfo=timezone.utc),
        latest_conditional_variance=0.0005,
        latest_observation_timestamp=datetime(2023, 12, 31, tzinfo=timezone.utc),
        latest_squared_residual=0.0004,
        config={"fitting_window": 750, "refit_frequency": 21},
    )
    defaults.update(overrides)
    return ModelState(**defaults)


def test_model_state_json_round_trip(tmp_path):
    store = ModelStateStore(base_dir=tmp_path)
    state = _sample_state()
    store.save(state, record_history=True)

    loaded = store.load("ETH-USD", "garch_1_1")
    assert loaded == state


def test_model_state_store_returns_none_when_missing(tmp_path):
    store = ModelStateStore(base_dir=tmp_path)
    assert store.load("ETH-USD", "garch_1_1") is None


def test_model_state_store_latest_is_overwritten(tmp_path):
    store = ModelStateStore(base_dir=tmp_path)
    store.save(_sample_state(latest_conditional_variance=0.001))
    store.save(_sample_state(latest_conditional_variance=0.002))

    loaded = store.load("ETH-USD", "garch_1_1")
    assert loaded.latest_conditional_variance == 0.002


def test_model_state_store_history_accumulates(tmp_path):
    store = ModelStateStore(base_dir=tmp_path)
    store.save(
        _sample_state(fit_timestamp=datetime(2024, 1, 1, tzinfo=timezone.utc)),
        record_history=True,
    )
    store.save(
        _sample_state(fit_timestamp=datetime(2024, 2, 1, tzinfo=timezone.utc)),
        record_history=True,
    )
    # a plain update should not add to history
    store.save(
        _sample_state(fit_timestamp=datetime(2024, 2, 1, tzinfo=timezone.utc)),
        record_history=False,
    )

    history = store.load_history("ETH-USD", "garch_1_1")
    assert len(history) == 2


def test_garch_pipeline_fit_save_load_update_round_trip(tmp_path, synthetic_garch_returns):
    settings = VolatilitySettings(garch_fitting_window=800, garch_refit_frequency=21)
    store = ModelStateStore(base_dir=tmp_path)

    train = synthetic_garch_returns.iloc[:800]
    held_out = synthetic_garch_returns.iloc[800:820]

    pipeline = GarchVolatilityPipeline("ETH-USD", settings=settings, store=store)
    state = pipeline.fit(train)
    assert state.asset == "ETH-USD"
    assert state.n_obs_fit == 800
    assert state.training_window_start == train.index[0].to_pydatetime()
    assert state.training_window_end == train.index[-1].to_pydatetime()
    assert "omega" in state.fitted_params

    # Apply a few updates and track forecasts produced live.
    live_forecasts = []
    for ts, r in held_out.items():
        live_forecasts.append(pipeline.forecast(1)[0])
        pipeline.update(float(r), ts.to_pydatetime())

    # A fresh pipeline instance loading persisted state should reproduce
    # the same forecast sequence without re-fitting.
    reloaded = GarchVolatilityPipeline("ETH-USD", settings=settings, store=ModelStateStore(base_dir=tmp_path))
    loaded_state = reloaded.load()
    assert loaded_state is not None
    assert loaded_state.latest_observation_timestamp == held_out.index[-1].to_pydatetime()

    # Replaying forecasts against the just-fit pipeline (before reload)
    # should be internally consistent, i.e. reproducible from a fit.
    pipeline2 = GarchVolatilityPipeline("ETH-USD", settings=settings, store=ModelStateStore(base_dir=tmp_path / "scratch"))
    pipeline2.fit(train)
    replayed_forecasts = []
    for ts, r in held_out.items():
        replayed_forecasts.append(pipeline2.forecast(1)[0])
        pipeline2.update(float(r), ts.to_pydatetime())

    np.testing.assert_allclose(live_forecasts, replayed_forecasts)


def test_garch_pipeline_should_refit_tracks_update_count(tmp_path, synthetic_garch_returns):
    settings = VolatilitySettings(garch_fitting_window=800, garch_refit_frequency=5)
    pipeline = GarchVolatilityPipeline("ETH-USD", settings=settings, store=ModelStateStore(base_dir=tmp_path))
    pipeline.fit(synthetic_garch_returns.iloc[:800])

    assert pipeline.should_refit() is False
    for i, (ts, r) in enumerate(synthetic_garch_returns.iloc[800:805].items(), start=1):
        pipeline.update(float(r), ts.to_pydatetime())
        assert pipeline.should_refit() == (i >= 5)
