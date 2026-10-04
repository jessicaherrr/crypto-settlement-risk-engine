from __future__ import annotations

import pandas as pd
import pytest

from askgene_quant.data.quality import check_data_quality


def test_well_formed_data_passes(well_formed_ohlcv):
    report = check_data_quality(well_formed_ohlcv)
    assert report.is_valid
    assert report.errors == []


def test_empty_data_is_invalid():
    report = check_data_quality(pd.DataFrame())
    assert not report.is_valid


def test_duplicate_timestamps_are_rejected(well_formed_ohlcv):
    dupe = pd.concat([well_formed_ohlcv, well_formed_ohlcv.iloc[[0]]])
    report = check_data_quality(dupe)
    assert not report.is_valid
    assert any("duplicate" in e for e in report.errors)


def test_non_positive_price_is_rejected(well_formed_ohlcv):
    bad = well_formed_ohlcv.copy()
    bad.iloc[5, bad.columns.get_loc("close")] = -1.0
    report = check_data_quality(bad)
    assert not report.is_valid
    assert any("non-positive" in e for e in report.errors)


def test_nan_values_are_rejected(well_formed_ohlcv):
    bad = well_formed_ohlcv.copy()
    bad.iloc[3, bad.columns.get_loc("close")] = float("nan")
    report = check_data_quality(bad)
    assert not report.is_valid
    assert any("NaN" in e for e in report.errors)


def test_unsorted_index_is_rejected(well_formed_ohlcv):
    report = check_data_quality(well_formed_ohlcv.iloc[::-1])
    assert not report.is_valid
    assert any("sorted" in e for e in report.errors)


def test_missing_calendar_day_is_a_warning_not_an_error(well_formed_ohlcv):
    gapped = well_formed_ohlcv.drop(well_formed_ohlcv.index[10])
    report = check_data_quality(gapped)
    assert report.is_valid
    assert any("missing date" in w for w in report.warnings)


def test_extreme_move_is_a_warning_not_an_error(well_formed_ohlcv):
    spiky = well_formed_ohlcv.copy()
    spiky.iloc[20, spiky.columns.get_loc("close")] = spiky.iloc[19]["close"] * 5
    report = check_data_quality(spiky)
    assert report.is_valid
    assert any("log return" in w for w in report.warnings)


def test_high_less_than_low_is_rejected(well_formed_ohlcv):
    bad = well_formed_ohlcv.copy()
    bad.iloc[0, bad.columns.get_loc("high")] = bad.iloc[0]["low"] - 1.0
    report = check_data_quality(bad)
    assert not report.is_valid
    assert any("high < low" in e for e in report.errors)
