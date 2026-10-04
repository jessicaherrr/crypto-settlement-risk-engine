"""Data-quality checks for OHLCV market data.

These run before any price series is handed to the return/volatility
layer. Structural problems (duplicate timestamps, non-positive prices,
non-monotonic index) are errors - the data must not be used. Calendar
gaps and extreme single-day moves are warnings: crypto trades 24/7 so a
missing day usually means an exchange outage, not a holiday, but it
shouldn't silently corrupt a "daily" series into one with uneven spacing.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

REQUIRED_COLUMNS = ("open", "high", "low", "close", "volume")

# A single-day move beyond this is flagged for review, not rejected -
# crypto genuinely gaps 20-30% on liquidation cascades / exchange news.
DEFAULT_MAX_ABS_LOG_RETURN = 0.5


@dataclass
class QualityReport:
    n_rows: int
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return not self.errors

    def raise_if_invalid(self) -> None:
        if not self.is_valid:
            raise ValueError(
                f"Market data failed quality checks: {'; '.join(self.errors)}"
            )


def check_data_quality(
    df: pd.DataFrame,
    *,
    expected_freq: str = "D",
    max_abs_log_return: float = DEFAULT_MAX_ABS_LOG_RETURN,
) -> QualityReport:
    """Run structural and statistical sanity checks on an OHLCV frame.

    ``df`` must be indexed by (UTC) date/datetime with at least a
    ``close`` column.
    """
    report = QualityReport(n_rows=len(df))

    if df.empty:
        report.errors.append("data is empty")
        return report

    missing_cols = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing_cols:
        report.errors.append(f"missing columns: {missing_cols}")
        return report

    if df.index.duplicated().any():
        n_dupes = int(df.index.duplicated().sum())
        report.errors.append(f"{n_dupes} duplicate timestamp(s) in index")

    if not df.index.is_monotonic_increasing:
        report.errors.append("index is not sorted ascending")

    if df[list(REQUIRED_COLUMNS)].isna().any().any():
        na_cols = df[list(REQUIRED_COLUMNS)].columns[
            df[list(REQUIRED_COLUMNS)].isna().any()
        ].tolist()
        report.errors.append(f"NaN values present in columns: {na_cols}")

    price_cols = ["open", "high", "low", "close"]
    if (df[price_cols] <= 0).any().any():
        report.errors.append("non-positive price(s) found in OHLC columns")

    if (df["volume"] < 0).any():
        report.errors.append("negative volume(s) found")

    if not report.errors:
        bad_hl = df["high"] < df["low"]
        if bad_hl.any():
            report.errors.append(
                f"{int(bad_hl.sum())} row(s) where high < low"
            )

    # Calendar-gap check (warning only): crypto trades every day, so a
    # missing expected date usually means a data-source gap worth knowing
    # about, not a real non-trading day.
    if df.index.is_monotonic_increasing and len(df) > 1:
        full_range = pd.date_range(df.index.min(), df.index.max(), freq=expected_freq)
        missing_dates = full_range.difference(df.index)
        if len(missing_dates) > 0:
            report.warnings.append(
                f"{len(missing_dates)} missing date(s) in expected {expected_freq} "
                f"calendar between {df.index.min().date()} and {df.index.max().date()}"
            )

    # Outlier single-day move check (warning only); skipped once prices are
    # already known to be invalid, since log-returns would be meaningless.
    if "close" in df.columns and len(df) > 1 and not report.errors:
        log_ret = np.log(df["close"].astype(float)).diff().dropna()
        extreme = log_ret.abs() > max_abs_log_return
        if extreme.any():
            dates = ", ".join(str(d.date()) for d in log_ret.index[extreme][:5])
            report.warnings.append(
                f"{int(extreme.sum())} day(s) with |log return| > "
                f"{max_abs_log_return}: {dates}{'...' if extreme.sum() > 5 else ''}"
            )

    return report
