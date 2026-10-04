"""Raw OHLCV candle fetching from the Coinbase Exchange public market-data
API (no API key required).

Coinbase caps each request at 300 candles, so pulling several years of
daily history requires pagination. This module only talks to the wire
format; `loader.py` turns the result into a tidy, cached DataFrame.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

_BASE_URL = "https://api.exchange.coinbase.com"
_USER_AGENT = "askgene-quant/0.1 (+https://github.com)"
_MAX_CANDLES_PER_REQUEST = 300

_COLUMNS = ["time", "low", "high", "open", "close", "volume"]


class CoinbaseAPIError(RuntimeError):
    """Raised when the Coinbase Exchange API returns an error response."""


def _request_candles(
    product_id: str, start: datetime, end: datetime, granularity_seconds: int
) -> list[list[float]]:
    resp = requests.get(
        f"{_BASE_URL}/products/{product_id}/candles",
        params={
            "start": start.isoformat(),
            "end": end.isoformat(),
            "granularity": granularity_seconds,
        },
        headers={"User-Agent": _USER_AGENT},
        timeout=15,
    )
    if resp.status_code != 200:
        raise CoinbaseAPIError(
            f"Coinbase candles request failed ({resp.status_code}): {resp.text[:300]}"
        )
    return resp.json()


def fetch_daily_ohlc(
    product_id: str,
    start: datetime,
    end: datetime,
    granularity_seconds: int = 86400,
    *,
    request_sleep_seconds: float = 0.4,
    max_retries: int = 3,
) -> pd.DataFrame:
    """Fetch OHLCV candles for ``product_id`` between ``start`` and ``end``
    (inclusive), paginating as needed.

    Returns a DataFrame indexed by UTC date with columns
    ``open, high, low, close, volume``, sorted ascending.
    """
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if start >= end:
        raise ValueError(f"start ({start}) must be before end ({end})")

    step = timedelta(seconds=granularity_seconds * _MAX_CANDLES_PER_REQUEST)
    chunks: list[pd.DataFrame] = []
    window_start = start
    while window_start < end:
        window_end = min(window_start + step, end)

        last_error: Exception | None = None
        rows: list[list[float]] | None = None
        for attempt in range(max_retries):
            try:
                rows = _request_candles(
                    product_id, window_start, window_end, granularity_seconds
                )
                break
            except (CoinbaseAPIError, requests.RequestException) as exc:
                last_error = exc
                time.sleep(request_sleep_seconds * (attempt + 1))
        if rows is None:
            raise CoinbaseAPIError(
                f"Failed to fetch candles for {product_id} in "
                f"[{window_start}, {window_end}] after {max_retries} attempts"
            ) from last_error

        if rows:
            chunks.append(pd.DataFrame(rows, columns=_COLUMNS))

        window_start = window_end
        time.sleep(request_sleep_seconds)

    if not chunks:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"]).set_axis(
            pd.DatetimeIndex([], name="date", tz="UTC"), axis=0
        )

    df = pd.concat(chunks, ignore_index=True)
    df = df.drop_duplicates(subset="time").sort_values("time")
    df["date"] = pd.to_datetime(df["time"], unit="s", utc=True).dt.normalize()
    df = df.set_index("date")[["open", "high", "low", "close", "volume"]]
    df = df.astype(float)
    return df
