from __future__ import annotations

from datetime import UTC, datetime
from decimal import ROUND_CEILING, Decimal

import pytest

from askgene_quant.serialization import (
    canonical_json_bytes,
    from_fixed_point,
    hash_snapshot,
    keccak256,
    to_fixed_point,
)


def test_keccak256_matches_known_ethereum_test_vector():
    # keccak256("") - the standard sanity check that this is Ethereum's
    # original-padding Keccak, not NIST SHA3-256 (which differs).
    assert keccak256(b"").hex() == (
        "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4"
        "70"
    )


def test_to_fixed_point_matches_wei_conversion():
    assert to_fixed_point(Decimal("1.5")) == 1_500_000_000_000_000_000
    assert to_fixed_point(Decimal(0)) == 0


def test_to_fixed_point_and_from_fixed_point_round_trip():
    value = Decimal("123.456789012345678901")
    raw = to_fixed_point(value)
    back = from_fixed_point(raw)
    assert abs(back - value) < Decimal("1e-18")


def test_to_fixed_point_rounding_direction_is_explicit():
    value = Decimal("1.0000000000000000001")  # 19th decimal, beyond wei precision
    rounded_up = to_fixed_point(value, rounding=ROUND_CEILING)
    rounded_half_up = to_fixed_point(value)
    assert rounded_up >= rounded_half_up


def test_canonical_json_rejects_raw_floats():
    with pytest.raises(TypeError):
        canonical_json_bytes({"var": 0.5})


def test_canonical_json_is_deterministic_regardless_of_key_order():
    a = {"b": Decimal(1), "a": Decimal(2)}
    b = {"a": Decimal(2), "b": Decimal(1)}
    assert canonical_json_bytes(a) == canonical_json_bytes(b)


def test_hash_snapshot_is_deterministic_and_sensitive_to_changes():
    snapshot = {"notional": Decimal(10), "created_at": datetime(2026, 1, 1, tzinfo=UTC)}
    h1 = hash_snapshot(snapshot)
    h2 = hash_snapshot(dict(snapshot))
    assert h1 == h2
    assert h1.startswith("0x")
    assert len(h1) == 2 + 64  # 0x + 32 bytes hex

    mutated = dict(snapshot, notional=Decimal(11))
    assert hash_snapshot(mutated) != h1
