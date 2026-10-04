"""Tests for the EIP-712 encoding layer (`signing/eip712.py`).

Two levels of proof that Python agrees with the chain:

1. A hardcoded digest vector, independently cross-checked by hand against
   both `eth_account` and ethers.js `TypedDataEncoder.hash` (see this
   file's git history / PR description for the derivation) - catches any
   regression without needing Node at all.
2. `TestCrossLanguageDigestParity`, which shells out to
   `scripts/cross_lang/eip712_digest.js` (ethers.js) for a battery of
   quotes and asserts byte-for-byte digest equality with Python - this is
   the real "Python and Solidity-tooling agree" proof, skipped only if
   Node isn't on PATH.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from eth_utils import to_checksum_address

from askgene_quant.signing.eip712 import (
    RISK_QUOTE_TYPES,
    InvalidRiskQuoteFields,
    build_domain,
    domain_separator,
    normalize_onchain_fields,
    struct_hash,
    typed_data_digest,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CROSS_LANG_SCRIPT = REPO_ROOT / "scripts" / "cross_lang" / "eip712_digest.js"

SAMPLE_FIELDS = {
    "quoteId": "0x" + "11" * 32,
    "depositor": "0x" + "22" * 20,
    "counterparty": "0x" + "33" * 20,
    "settlementAsset": "0x" + "00" * 20,
    "notional": 10 * 10**18,
    "requiredCollateral": 12 * 10**18,
    "quoteExpiration": 1999999999,
    "settlementHorizon": 604800,
    "modelVersion": "garch-1.1.0",
    "riskSnapshotHash": "0x" + "44" * 32,
}
SAMPLE_CHAIN_ID = 31337
SAMPLE_VERIFYING_CONTRACT = "0x" + "55" * 20

# Cross-checked by hand against both eth_account and ethers.js
# TypedDataEncoder.hash for SAMPLE_FIELDS/SAMPLE_CHAIN_ID/SAMPLE_VERIFYING_CONTRACT.
EXPECTED_DIGEST = "0x82d6f6f80804f27f91ae9feeca055b1d3792906b8136254d8d64d0be8354e347"


def test_digest_matches_known_vector():
    domain = build_domain(chain_id=SAMPLE_CHAIN_ID, verifying_contract=SAMPLE_VERIFYING_CONTRACT)
    normalized = normalize_onchain_fields(SAMPLE_FIELDS)
    digest = typed_data_digest(domain, normalized)
    assert "0x" + digest.hex() == EXPECTED_DIGEST


def test_digest_is_domain_separator_plus_struct_hash():
    """`typed_data_digest` must equal keccak256(0x1901 || domainSeparator ||
    structHash) exactly as `MessageHashUtils.toTypedDataHash` computes it -
    not just "some hash that happens to be stable"."""
    from askgene_quant.serialization import keccak256

    domain = build_domain(chain_id=SAMPLE_CHAIN_ID, verifying_contract=SAMPLE_VERIFYING_CONTRACT)
    normalized = normalize_onchain_fields(SAMPLE_FIELDS)

    expected = keccak256(b"\x19\x01" + domain_separator(domain) + struct_hash(normalized))
    assert typed_data_digest(domain, normalized) == expected


def test_normalize_checksums_addresses_and_lowercases_bytes32():
    normalized = normalize_onchain_fields(SAMPLE_FIELDS)
    assert normalized["depositor"] == "0x2222222222222222222222222222222222222222"
    assert normalized["quoteId"] == SAMPLE_FIELDS["quoteId"].lower()
    # Field order is canonical (struct order), not insertion order.
    assert list(normalized.keys()) == list(SAMPLE_FIELDS.keys())


def test_normalize_rejects_missing_field():
    fields = dict(SAMPLE_FIELDS)
    del fields["riskSnapshotHash"]
    with pytest.raises(InvalidRiskQuoteFields, match="missing"):
        normalize_onchain_fields(fields)


def test_normalize_rejects_unexpected_field():
    fields = dict(SAMPLE_FIELDS, extraField=1)
    with pytest.raises(InvalidRiskQuoteFields, match="unexpected"):
        normalize_onchain_fields(fields)


def test_normalize_rejects_invalid_address():
    fields = dict(SAMPLE_FIELDS, depositor="not-an-address")
    with pytest.raises(InvalidRiskQuoteFields):
        normalize_onchain_fields(fields)


@pytest.mark.parametrize("bad_hash", ["0x1234", "11" * 32, "0x" + "zz" * 32, "0x" + "11" * 31])
def test_normalize_rejects_malformed_bytes32(bad_hash):
    fields = dict(SAMPLE_FIELDS, riskSnapshotHash=bad_hash)
    with pytest.raises(InvalidRiskQuoteFields):
        normalize_onchain_fields(fields)


@pytest.mark.parametrize("field_name", ["notional", "requiredCollateral", "quoteExpiration", "settlementHorizon"])
def test_normalize_rejects_float_uint_fields(field_name):
    """A raw float reaching the signing boundary must be rejected, not
    silently truncated - the same invariant `serialization._canonicalize`
    enforces upstream of this module."""
    fields = dict(SAMPLE_FIELDS, **{field_name: 1.5})
    with pytest.raises(InvalidRiskQuoteFields):
        normalize_onchain_fields(fields)


@pytest.mark.parametrize("field_name", ["notional", "requiredCollateral", "quoteExpiration", "settlementHorizon"])
def test_normalize_rejects_negative_uint_fields(field_name):
    fields = dict(SAMPLE_FIELDS, **{field_name: -1})
    with pytest.raises(InvalidRiskQuoteFields):
        normalize_onchain_fields(fields)


def test_normalize_rejects_empty_model_version():
    fields = dict(SAMPLE_FIELDS, modelVersion="")
    with pytest.raises(InvalidRiskQuoteFields):
        normalize_onchain_fields(fields)


def test_build_domain_rejects_non_positive_chain_id():
    with pytest.raises(InvalidRiskQuoteFields):
        build_domain(chain_id=0, verifying_contract=SAMPLE_VERIFYING_CONTRACT)


_NODE_AVAILABLE = shutil.which("node") is not None


def _ethers_digest(domain: dict, fields: dict) -> str:
    # uint256 values must cross the JSON boundary as decimal strings - a
    # bare JSON number loses precision above 2**53 and ethers.js's
    # TypedDataEncoder rejects it outright (the same reason production
    # code never puts a uint256 on the wire as a JSON number either).
    json_safe_fields = {k: (str(v) if isinstance(v, int) else v) for k, v in fields.items()}
    payload = json.dumps({"domain": domain, "types": RISK_QUOTE_TYPES, "value": json_safe_fields}).encode()
    proc = subprocess.run(
        ["node", str(CROSS_LANG_SCRIPT)],
        input=payload,
        capture_output=True,
        check=True,
        timeout=30,
    )
    return json.loads(proc.stdout)["digest"]


@pytest.mark.skipif(not _NODE_AVAILABLE, reason="node not on PATH; cross-language check skipped")
class TestCrossLanguageDigestParity:
    """Each case proves Python's digest matches ethers.js's
    `TypedDataEncoder.hash` for the *same* domain/types/values - the
    actual claim this phase needs: Python and the Solidity tooling agree
    on the encoding, not just that Python is internally consistent."""

    @pytest.mark.parametrize(
        "fields",
        [
            SAMPLE_FIELDS,
            dict(SAMPLE_FIELDS, notional=0, requiredCollateral=0),
            dict(SAMPLE_FIELDS, notional=2**255, requiredCollateral=2**256 - 1),
            dict(SAMPLE_FIELDS, modelVersion=""),
            dict(SAMPLE_FIELDS, modelVersion="x" * 200),
            dict(
                SAMPLE_FIELDS,
                settlementAsset=to_checksum_address("0x" + "ab" * 20),
                quoteId="0x" + "00" * 32,
                riskSnapshotHash="0x" + "ff" * 32,
            ),
        ],
        ids=["sample", "zeros", "max-uint256", "empty-model-version", "long-model-version", "other-addresses"],
    )
    def test_matches_ethers(self, fields):
        domain = build_domain(chain_id=SAMPLE_CHAIN_ID, verifying_contract=SAMPLE_VERIFYING_CONTRACT)
        # Addresses must already be checksummed here (eth_abi's encoder
        # validates strictly) - that's the only normalize_onchain_fields
        # behavior this test relies on. modelVersion="" deliberately fails
        # our own business-rule validation (see
        # test_normalize_rejects_empty_model_version) but ethers.js has no
        # such opinion, so this test calls the raw encoder directly rather
        # than going through normalize_onchain_fields.
        python_digest = "0x" + typed_data_digest(domain, fields).hex()
        ethers_digest = _ethers_digest(domain, fields)
        assert python_digest == ethers_digest

    def test_matches_ethers_across_chain_ids_and_contracts(self):
        for chain_id, contract in [(1, "0x" + "ab" * 20), (80002, "0x" + "cd" * 20), (31337, "0x" + "ef" * 20)]:
            domain = build_domain(chain_id=chain_id, verifying_contract=contract)
            normalized = normalize_onchain_fields(SAMPLE_FIELDS)
            python_digest = "0x" + typed_data_digest(domain, normalized).hex()
            ethers_digest = _ethers_digest(domain, normalized)
            assert python_digest == ethers_digest, f"mismatch for chain_id={chain_id} contract={contract}"
