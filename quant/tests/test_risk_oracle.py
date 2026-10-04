"""Tests for `signing/risk_oracle.py`: the actual ECDSA signing step on
top of the EIP-712 encoding tested in `test_eip712.py`."""

from __future__ import annotations

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from askgene_quant.signing.eip712 import (
    RISK_QUOTE_TYPES,
    InvalidRiskQuoteFields,
    build_domain,
)
from askgene_quant.signing.risk_oracle import MissingRiskOracleKey, RiskOracleSigner

# Hardhat/Anvil's well-known default test account #0 - public, intentionally
# published for local development, never used for anything real.
TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

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
CHAIN_ID = 31337
VERIFYING_CONTRACT = "0x" + "55" * 20


def test_signer_address_matches_private_key():
    signer = RiskOracleSigner(TEST_PRIVATE_KEY)
    assert signer.address == TEST_ADDRESS


def test_from_env_reads_configured_var(monkeypatch):
    monkeypatch.setenv("RISK_ORACLE_PRIVATE_KEY", TEST_PRIVATE_KEY)
    signer = RiskOracleSigner.from_env()
    assert signer.address == TEST_ADDRESS


def test_from_env_raises_when_unset(monkeypatch):
    monkeypatch.delenv("RISK_ORACLE_PRIVATE_KEY", raising=False)
    with pytest.raises(MissingRiskOracleKey):
        RiskOracleSigner.from_env()


def test_sign_onchain_quote_recovers_to_signer_address():
    signer = RiskOracleSigner(TEST_PRIVATE_KEY)
    result = signer.sign_onchain_quote(SAMPLE_FIELDS, chain_id=CHAIN_ID, verifying_contract=VERIFYING_CONTRACT)

    assert result.signer == TEST_ADDRESS
    assert result.chain_id == CHAIN_ID
    assert len(result.signature) == 2 + 65 * 2  # 0x + 65 bytes
    assert len(result.digest) == 2 + 32 * 2  # 0x + 32 bytes


def test_signature_is_useless_under_a_different_domain():
    """The same fields signed for one (chain_id, verifying_contract) must
    not recover to the signer under a different one - this is exactly
    what stops a quote signed for one RiskEscrow deployment (or chain)
    from being replayed against another."""
    signer = RiskOracleSigner(TEST_PRIVATE_KEY)
    result = signer.sign_onchain_quote(SAMPLE_FIELDS, chain_id=CHAIN_ID, verifying_contract=VERIFYING_CONTRACT)

    other_result = signer.sign_onchain_quote(
        SAMPLE_FIELDS, chain_id=CHAIN_ID, verifying_contract="0x" + "99" * 20
    )
    assert other_result.digest != result.digest
    assert other_result.signature != result.signature


def test_tampering_with_a_signed_field_changes_the_digest():
    signer = RiskOracleSigner(TEST_PRIVATE_KEY)
    result = signer.sign_onchain_quote(SAMPLE_FIELDS, chain_id=CHAIN_ID, verifying_contract=VERIFYING_CONTRACT)

    tampered_fields = dict(SAMPLE_FIELDS, requiredCollateral=SAMPLE_FIELDS["requiredCollateral"] * 2)
    tampered = signer.sign_onchain_quote(tampered_fields, chain_id=CHAIN_ID, verifying_contract=VERIFYING_CONTRACT)

    assert tampered.digest != result.digest
    assert result.signature != tampered.signature

    # Replaying the *original* signature against the tampered fields -
    # exactly what `RiskQuoteVerifier._verifyRiskQuote` is asked to check
    # when a quote is tampered with after signing - must not recover to
    # the oracle's address (mirrors the "Invalid risk quote signature"
    # revert in contracts/test/riskEscrow.test.js's tampering test).
    domain = build_domain(chain_id=CHAIN_ID, verifying_contract=VERIFYING_CONTRACT)
    tampered_message = encode_typed_data(
        domain_data=domain, message_types=RISK_QUOTE_TYPES, message_data=tampered.fields
    )
    recovered = Account.recover_message(tampered_message, signature=bytes.fromhex(result.signature[2:]))
    assert recovered != TEST_ADDRESS


def test_sign_onchain_quote_rejects_invalid_fields():
    signer = RiskOracleSigner(TEST_PRIVATE_KEY)
    bad_fields = dict(SAMPLE_FIELDS, notional=-1)
    with pytest.raises(InvalidRiskQuoteFields):
        signer.sign_onchain_quote(bad_fields, chain_id=CHAIN_ID, verifying_contract=VERIFYING_CONTRACT)
