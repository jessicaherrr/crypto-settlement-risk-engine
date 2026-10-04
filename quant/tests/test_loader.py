from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pandas as pd
import pytest

import askgene_quant.data.loader as loader_module
from askgene_quant.data.loader import load_market_data


def _fake_candles(start: datetime, end: datetime) -> pd.DataFrame:
    idx = pd.date_range(start.date(), end.date(), freq="D", tz="UTC", inclusive="left")
    return pd.DataFrame(
        {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "volume": 10.0},
        index=idx,
    )


def test_load_market_data_fetches_once_and_caches(tmp_path, monkeypatch):
    calls = []

    def fake_fetch(product_id, start, end, *a, **kw):
        calls.append((start, end))
        return _fake_candles(start, end)

    monkeypatch.setattr(loader_module, "fetch_daily_ohlc", fake_fetch)

    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    end = datetime(2024, 1, 10, tzinfo=timezone.utc)

    df1 = load_market_data("ETH-USD", start, end, cache_dir=tmp_path)
    assert len(calls) == 1
    assert not df1.empty

    df2 = load_market_data("ETH-USD", start, end, cache_dir=tmp_path)
    assert len(calls) == 1  # fully satisfied by cache, no second network call
    pd.testing.assert_frame_equal(df1, df2, check_freq=False)


def test_load_market_data_fetches_only_the_missing_tail(tmp_path, monkeypatch):
    calls = []

    def fake_fetch(product_id, start, end, *a, **kw):
        calls.append((start, end))
        return _fake_candles(start, end)

    monkeypatch.setattr(loader_module, "fetch_daily_ohlc", fake_fetch)

    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    mid = datetime(2024, 1, 10, tzinfo=timezone.utc)
    end = datetime(2024, 1, 20, tzinfo=timezone.utc)

    load_market_data("ETH-USD", start, mid, cache_dir=tmp_path)
    assert len(calls) == 1

    df = load_market_data("ETH-USD", start, end, cache_dir=tmp_path)
    assert len(calls) == 2
    # the second call should only have fetched the new tail, not the full range
    second_call_start, _ = calls[1]
    assert second_call_start > start
    assert df.index.max() >= pd.Timestamp(end) - pd.Timedelta(days=1)


def test_load_market_data_refresh_forces_refetch(tmp_path, monkeypatch):
    calls = []

    def fake_fetch(product_id, start, end, *a, **kw):
        calls.append((start, end))
        return _fake_candles(start, end)

    monkeypatch.setattr(loader_module, "fetch_daily_ohlc", fake_fetch)

    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    end = datetime(2024, 1, 5, tzinfo=timezone.utc)

    load_market_data("ETH-USD", start, end, cache_dir=tmp_path)
    load_market_data("ETH-USD", start, end, cache_dir=tmp_path, refresh=True)
    assert len(calls) == 2
