"""In-process memoization for the analytics endpoints (`service/analytics.py`).

The volatility and VaR walk-forward backtests each refit GARCH dozens of
times over the out-of-sample window (see `validation/backtest.py`,
`validation/var_backtest.py`) - real but non-trivial compute, not
something a dashboard should re-run on every page load. This cache exists
to make that cheap on repeat requests without adding infrastructure: no
Redis, no external process, just a dict guarded by per-key locks so
concurrent cold requests for the same thing compute it once rather than
racing each other.

Keys are ``(name, params, fingerprint)``. ``fingerprint`` is the caller's
summary of "what data/model state produced this" (see
`AnalyticsInputs.fingerprint`); when the underlying data or model refit
changes, the fingerprint changes and the old entry is simply never hit
again (TTL eventually reclaims it; see `clear()` for an explicit evict).
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable, Hashable
from dataclasses import dataclass
from typing import Any

DEFAULT_TTL_SECONDS = 6 * 60 * 60


def _ttl_from_env() -> float:
    raw = os.environ.get("ASKGENE_ANALYTICS_TTL_SECONDS")
    if not raw:
        return float(DEFAULT_TTL_SECONDS)
    return float(raw)


@dataclass
class _Entry:
    value: Any
    computed_at: float


class AnalyticsCache:
    """Memoizes a compute function's result, keyed on
    ``(name, params, fingerprint)``, for up to ``ttl_seconds``.

    ``clock`` is injectable so tests can control TTL expiry without
    sleeping. A `threading.Lock` per key ensures that when several
    requests race on the same cold key, only one of them actually calls
    ``compute`` - the rest block briefly and then read its result.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._ttl = ttl_seconds if ttl_seconds is not None else _ttl_from_env()
        self._clock = clock
        self._entries: dict[tuple, _Entry] = {}
        self._locks: dict[tuple, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _lock_for(self, key: tuple) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    def _fresh(self, entry: _Entry | None) -> bool:
        return entry is not None and (self._clock() - entry.computed_at) < self._ttl

    def get_or_compute(
        self,
        *,
        name: str,
        params: Hashable,
        fingerprint: Hashable,
        compute: Callable[[], Any],
    ) -> tuple[Any, bool]:
        """Returns ``(value, was_cache_hit)``."""
        key = (name, params, fingerprint)

        entry = self._entries.get(key)
        if self._fresh(entry):
            return entry.value, True

        lock = self._lock_for(key)
        with lock:
            # Re-check after acquiring the lock: another thread may have
            # just finished computing this exact key while we waited.
            entry = self._entries.get(key)
            if self._fresh(entry):
                return entry.value, True

            value = compute()
            self._entries[key] = _Entry(value=value, computed_at=self._clock())
            return value, False

    def clear(self) -> None:
        self._entries.clear()
        self._locks.clear()

    def stats(self) -> dict:
        return {"n_entries": len(self._entries)}
