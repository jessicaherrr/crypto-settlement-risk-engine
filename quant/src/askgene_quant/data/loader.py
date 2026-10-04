"""Cache-aware market data loading.

Wraps `coinbase.fetch_daily_ohlc` with a local parquet cache so repeated
runs (tests, notebooks, the validation pipeline) don't re-hit the network
for data that's already on disk, and so a fit/update pipeline can ask for
"everything up to today" cheaply.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from askgene_quant.data.coinbase import fetch_daily_ohlc
from askgene_quant.config import DEFAULT_DATA_CACHE_DIR

_EPOCH_START = datetime(2015, 1, 1, tzinfo=timezone.utc)


def _cache_path(product_id: str, cache_dir: Path) -> Path:
    name = product_id.replace("-", "_").replace("/", "_").lower()
    return cache_dir / f"{name}_daily.parquet"


def load_market_data(
    product_id: str,
    start: datetime | None = None,
    end: datetime | None = None,
    *,
    cache_dir: Path = DEFAULT_DATA_CACHE_DIR,
    refresh: bool = False,
) -> pd.DataFrame:
    """Load daily OHLCV data for ``product_id`` between ``start`` and
    ``end`` (defaults: earliest available data through now), using and
    maintaining a local parquet cache.

    Only the gap between what's cached and what's requested is fetched
    from Coinbase; an already-satisfied request never touches the network.
    """
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = _cache_path(product_id, cache_dir)

    start = start or _EPOCH_START
    end = end or datetime.now(timezone.utc)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    cached = pd.DataFrame()
    if path.exists() and not refresh:
        cached = pd.read_parquet(path)

    to_fetch: list[tuple[datetime, datetime]] = []
    if cached.empty:
        to_fetch.append((start, end))
    else:
        cached_min = cached.index.min().to_pydatetime()
        cached_max = cached.index.max().to_pydatetime()
        if start < cached_min:
            to_fetch.append((start, cached_min))
        if end > cached_max + timedelta(days=1):
            to_fetch.append((cached_max + timedelta(days=1), end))

    fetched_frames = [cached] if not cached.empty else []
    for fetch_start, fetch_end in to_fetch:
        if fetch_start >= fetch_end:
            continue
        fetched_frames.append(fetch_daily_ohlc(product_id, fetch_start, fetch_end))

    if not fetched_frames:
        combined = cached
    else:
        combined = pd.concat(fetched_frames)
        combined = combined[~combined.index.duplicated(keep="last")].sort_index()
        combined.to_parquet(path)

    # Parquet round-trips can change the index's datetime unit (e.g. ns -> ms);
    # normalize so cached and freshly-fetched results are bit-for-bit comparable.
    combined.index = pd.DatetimeIndex(combined.index, tz="UTC").as_unit("ms")

    mask = (combined.index >= pd.Timestamp(start)) & (combined.index <= pd.Timestamp(end))
    return combined.loc[mask].copy()
