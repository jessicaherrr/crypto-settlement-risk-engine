"""EIP-712 typed-data encoding for `RiskQuote`, mirroring
`contracts/RiskQuoteVerifier.sol` field-for-field.

The domain and struct type here must byte-for-byte match the Solidity
side: `EIP712(name="AskGeneRiskEscrow", version="1")` (the standard
4-field OpenZeppelin domain - name, version, chainId, verifyingContract;
no salt) and the `RiskQuote` struct's field order, which fixes its
EIP-712 typehash. Changing a field name, type, or order here without a
matching Solidity change produces a *different* typehash and therefore a
signature `RiskQuoteVerifier._verifyRiskQuote` will never accept - get the
order from `RISK_QUOTE_TYPEHASH` in `RiskQuoteVerifier.sol`, not from
`RiskQuote.to_onchain_fields`' dict ordering (Python dicts preserve
insertion order, but that's incidental, not load-bearing here).

Hashing is delegated to `eth_account.messages.hash_domain` /
`hash_eip712_message` rather than re-implemented: both are documented
public entry points, and using the same library ethers.js/viem-compatible
tooling relies on avoids a second, hand-rolled ABI encoder that could
silently drift from the real one. Cross-language parity (this module's
digest vs. `riskEscrow.hashRiskQuote(quote)` vs. ethers.js
`TypedDataEncoder.hash`) is verified in `tests/test_signing.py`.
"""

from __future__ import annotations

from eth_account.messages import hash_domain, hash_eip712_message
from eth_utils import to_checksum_address

from askgene_quant.serialization import keccak256

EIP712_DOMAIN_NAME = "AskGeneRiskEscrow"
EIP712_DOMAIN_VERSION = "1"

# Field order fixes the typehash - must match RiskQuoteVerifier.sol's
# `RISK_QUOTE_TYPEHASH` exactly.
RISK_QUOTE_TYPES: dict[str, list[dict[str, str]]] = {
    "RiskQuote": [
        {"name": "quoteId", "type": "bytes32"},
        {"name": "depositor", "type": "address"},
        {"name": "counterparty", "type": "address"},
        {"name": "settlementAsset", "type": "address"},
        {"name": "notional", "type": "uint256"},
        {"name": "requiredCollateral", "type": "uint256"},
        {"name": "quoteExpiration", "type": "uint256"},
        {"name": "settlementHorizon", "type": "uint256"},
        {"name": "modelVersion", "type": "string"},
        {"name": "riskSnapshotHash", "type": "bytes32"},
    ]
}

ONCHAIN_FIELD_NAMES = tuple(f["name"] for f in RISK_QUOTE_TYPES["RiskQuote"])

_BYTES32_FIELDS = ("quoteId", "riskSnapshotHash")
_ADDRESS_FIELDS = ("depositor", "counterparty", "settlementAsset")
_UINT_FIELDS = ("notional", "requiredCollateral", "quoteExpiration", "settlementHorizon")


class InvalidRiskQuoteFields(ValueError):
    """An on-chain RiskQuote field dict doesn't match what
    `RiskQuoteVerifier.sol` expects (wrong keys, shape, or type) - raised
    before anything is hashed or signed, since this is the boundary where
    a malformed value would otherwise silently sign garbage."""


def build_domain(*, chain_id: int, verifying_contract: str) -> dict:
    """EIP-712 domain for a `RiskEscrow` deployment. `chain_id` and
    `verifying_contract` are per-deployment; name/version are fixed by
    `RiskQuoteVerifier`'s constructor call (`EIP712("AskGeneRiskEscrow", "1")`)."""
    if chain_id <= 0:
        raise InvalidRiskQuoteFields(f"chain_id must be positive, got {chain_id}")
    return {
        "name": EIP712_DOMAIN_NAME,
        "version": EIP712_DOMAIN_VERSION,
        "chainId": int(chain_id),
        "verifyingContract": to_checksum_address(verifying_contract),
    }


def normalize_onchain_fields(fields: dict) -> dict:
    """Validate and normalize an on-chain `RiskQuote` field dict (as
    produced by `RiskQuote.to_onchain_fields`) into the exact shapes
    `eth_account`'s typed-data encoder requires: checksummed addresses,
    lowercase `0x`-prefixed 32-byte hex strings, non-negative ints.
    Raises `InvalidRiskQuoteFields` rather than coercing silently - a
    quote is signed exactly once, so a shape mismatch here means the
    caller built the wrong thing, not something to paper over.
    """
    missing = [name for name in ONCHAIN_FIELD_NAMES if name not in fields]
    if missing:
        raise InvalidRiskQuoteFields(f"missing RiskQuote field(s): {missing}")
    extra = [name for name in fields if name not in ONCHAIN_FIELD_NAMES]
    if extra:
        raise InvalidRiskQuoteFields(f"unexpected RiskQuote field(s): {extra}")

    staged: dict = {}

    for name in _ADDRESS_FIELDS:
        try:
            staged[name] = to_checksum_address(fields[name])
        except ValueError as exc:
            raise InvalidRiskQuoteFields(f"{name}: invalid address {fields[name]!r}") from exc

    for name in _BYTES32_FIELDS:
        value = fields[name]
        if not isinstance(value, str) or not value.lower().startswith("0x") or len(value) != 66:
            raise InvalidRiskQuoteFields(
                f"{name}: expected a 0x-prefixed 32-byte hex string, got {value!r}"
            )
        try:
            int(value, 16)
        except ValueError as exc:
            raise InvalidRiskQuoteFields(f"{name}: not valid hex: {value!r}") from exc
        staged[name] = value.lower()

    for name in _UINT_FIELDS:
        value = fields[name]
        if isinstance(value, bool) or not isinstance(value, int):
            raise InvalidRiskQuoteFields(
                f"{name}: expected an int (fixed-point/timestamp/duration), got {type(value).__name__}"
            )
        if value < 0:
            raise InvalidRiskQuoteFields(f"{name}: must be non-negative, got {value}")
        staged[name] = value

    model_version = fields["modelVersion"]
    if not isinstance(model_version, str) or not model_version:
        raise InvalidRiskQuoteFields(f"modelVersion: expected a non-empty str, got {model_version!r}")
    staged["modelVersion"] = model_version

    # Assemble in canonical struct order (not insertion order above) so
    # downstream JSON (CLI/service output, cross-language fixtures) always
    # lists fields the same way RiskQuoteVerifier.RiskQuote declares them.
    return {name: staged[name] for name in ONCHAIN_FIELD_NAMES}


def domain_separator(domain: dict) -> bytes:
    """`keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, ...))` - matches
    OpenZeppelin `EIP712._domainSeparatorV4` (see
    `node_modules/@openzeppelin/contracts/utils/cryptography/EIP712.sol`:
    the 4-field domain, no `salt`)."""
    return hash_domain(domain)


def struct_hash(normalized_fields: dict) -> bytes:
    """`keccak256(abi.encode(RISK_QUOTE_TYPEHASH, ...))` with
    `modelVersion` pre-hashed per EIP-712's encoding of dynamic types -
    matches `RiskQuoteVerifier.hashRiskQuote`'s inner `keccak256(abi.encode(...))`."""
    return hash_eip712_message(RISK_QUOTE_TYPES, normalized_fields)


def typed_data_digest(domain: dict, normalized_fields: dict) -> bytes:
    """The final EIP-712 digest actually signed/verified:
    `keccak256(0x1901 || domainSeparator || structHash)`, matching
    `MessageHashUtils.toTypedDataHash` and `riskEscrow.hashRiskQuote(quote)`."""
    return keccak256(b"\x19\x01" + domain_separator(domain) + struct_hash(normalized_fields))
