"""Cross-language parity for the fixed-point financial-amount conversion
(`serialization.to_fixed_point`) against ethers.js `parseUnits` - the
same conversion `apps/web` and the Hardhat tests use (`ethers.parseEther`
is `parseUnits(value, 18)`).

Only exact (<=18 fractional digits) values are used: `parseUnits` *throws*
on more fractional digits than `decimals` rather than rounding, so this
test deliberately stays where Python's ROUND_HALF_UP and ethers' exact
parsing have nothing to disagree about - the rounding *mode* itself is
Python-only policy (see `serialization.py`'s module docstring) with no
Solidity-side equivalent to cross-check against.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from decimal import Decimal
from pathlib import Path

import pytest

from askgene_quant.serialization import to_fixed_point

REPO_ROOT = Path(__file__).resolve().parents[2]
CROSS_LANG_SCRIPT = REPO_ROOT / "scripts" / "cross_lang" / "parse_units.js"

_NODE_AVAILABLE = shutil.which("node") is not None


def _ethers_parse_units(value: str, decimals: int) -> int:
    payload = json.dumps({"value": value, "decimals": decimals}).encode()
    proc = subprocess.run(
        ["node", str(CROSS_LANG_SCRIPT)],
        input=payload,
        capture_output=True,
        check=True,
        timeout=30,
    )
    return int(json.loads(proc.stdout)["result"])


@pytest.mark.skipif(not _NODE_AVAILABLE, reason="node not on PATH; cross-language check skipped")
@pytest.mark.parametrize(
    "value,decimals",
    [
        ("0", 18),
        ("1", 18),
        ("10", 18),
        ("0.000000000000000001", 18),  # 1 wei
        ("1.5", 18),
        ("10.123456789012345678", 18),  # exactly 18 fractional digits
        ("1000000.5", 18),
        ("15.175822253324002", 18),  # realistic collateral figure
        ("100", 6),  # a 6-decimal settlement asset (e.g. USDC-style)
        ("1.123456", 6),
    ],
)
def test_to_fixed_point_matches_ethers_parse_units(value, decimals):
    python_result = to_fixed_point(Decimal(value), decimals)
    ethers_result = _ethers_parse_units(value, decimals)
    assert python_result == ethers_result


def test_round_half_up_is_documented_python_only_policy():
    """Where Python's rounding mode actually matters (more fractional
    digits than the target decimals), there is no on-chain equivalent to
    agree with - `to_fixed_point` is the sole authority, which is exactly
    why `serialization.py` requires every financial value to go through
    it before crossing the signing boundary, rather than being formatted
    ad hoc per call site."""
    # 0.0000000000000000005 at 18 decimals rounds half-up to 1 wei.
    assert to_fixed_point(Decimal("0.0000000000000000005"), 18) == 1
