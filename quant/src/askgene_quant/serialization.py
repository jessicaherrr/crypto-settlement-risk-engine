"""Deterministic serialization for financial values crossing the
Python/Solidity boundary.

Solidity has no floating point: every signed financial field becomes a
fixed-point integer (18 decimals, wei-style) via an explicit, documented
rounding mode - never a raw float or an unquantized `Decimal` repr, since
neither is guaranteed to round-trip bit-for-bit. Hashing (for
`riskSnapshotHash`, the keccak256 audit hash `RiskQuoteVerifier.sol`
expects - see its docstring) operates on exactly this canonical integer
representation, so a hash computed off-chain today is reproducible from
the same inputs indefinitely, independent of Python float/Decimal
formatting changes.

Rounding direction matters and is caller-controlled: collateral-style
"must not be under-covered" values should round up (`ROUND_CEILING`);
purely informational values (reported volatility, VaR) default to
round-half-up.
"""

from __future__ import annotations

import json
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal

from Crypto.Hash import keccak

WEI_DECIMALS = 18


def quantize_decimal(value: Decimal, decimals: int = WEI_DECIMALS, *, rounding=ROUND_HALF_UP) -> Decimal:
    """Round ``value`` to ``decimals`` fractional digits under ``rounding``."""
    quantum = Decimal(1).scaleb(-decimals)
    return value.quantize(quantum, rounding=rounding)


def to_fixed_point(value: Decimal, decimals: int = WEI_DECIMALS, *, rounding=ROUND_HALF_UP) -> int:
    """Convert a ``Decimal`` to an integer in the asset's smallest unit
    (e.g. wei for 18-decimal ETH), the representation Solidity's
    `uint256` fields expect."""
    scaled = quantize_decimal(value, decimals, rounding=rounding) * (Decimal(10) ** decimals)
    return int(scaled)


def from_fixed_point(raw: int, decimals: int = WEI_DECIMALS) -> Decimal:
    """Inverse of `to_fixed_point`."""
    return Decimal(raw) / (Decimal(10) ** decimals)


def keccak256(data: bytes) -> bytes:
    """Ethereum's keccak256 (original Keccak padding, *not* NIST SHA3-256
    - they differ). Verified against the known test vector
    ``keccak256(b"") == c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470``
    in `tests/test_quote_serialization.py`."""
    digest = keccak.new(digest_bits=256)
    digest.update(data)
    return digest.digest()


def _canonicalize(value: object) -> object:
    """Recursively replace every `Decimal` with its fixed-point integer
    (as a string, so JSON never emits a bare float for it) and every
    `datetime` with a Unix timestamp. Raises on raw `float`: a float
    reaching this function means some financial value skipped explicit
    `Decimal` handling upstream."""
    if isinstance(value, Decimal):
        return str(to_fixed_point(value))
    if isinstance(value, float):
        raise TypeError(
            "raw float in a canonical risk snapshot; convert financial values "
            "to Decimal before hashing/serializing"
        )
    if isinstance(value, datetime):
        return int(value.timestamp())
    if isinstance(value, dict):
        return {str(k): _canonicalize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonicalize(v) for v in value]
    return value


def canonical_json_bytes(obj: dict) -> bytes:
    """Canonical, hash-stable JSON encoding of ``obj``: sorted keys, no
    insignificant whitespace, Decimals/datetimes normalized to integers
    via `_canonicalize`."""
    canon = _canonicalize(obj)
    return json.dumps(canon, sort_keys=True, separators=(",", ":")).encode("utf-8")


def hash_snapshot(obj: dict) -> str:
    """keccak256 of ``obj``'s canonical JSON encoding, as a ``0x``-prefixed
    hex string suitable for a `bytes32` Solidity field."""
    return "0x" + keccak256(canonical_json_bytes(obj)).hex()
