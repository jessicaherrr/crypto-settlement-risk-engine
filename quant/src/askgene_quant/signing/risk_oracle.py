"""The risk oracle: the signing identity `RiskEscrow.riskOracle()` trusts.

Wraps a single secp256k1 private key and produces EIP-712 signatures over
`RiskQuote`s that `RiskQuoteVerifier._verifyRiskQuote` accepts. Holds no
risk-modeling logic itself (that's `quotes/risk_quote.py` and upstream) -
this is purely the signing boundary between "a quote the engine computed"
and "a quote the chain will accept as authentic."

Key management: the private key is read from an environment variable
(`RISK_ORACLE_PRIVATE_KEY` by default), never hardcoded or committed. This
mirrors `contracts/scripts/deploy.js`'s `RISK_ORACLE_ADDRESS` - the two
must name the same key pair (this module's `.address` must equal the
on-chain `riskOracle()`), rotated together via `RiskEscrow.setRiskOracle`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from eth_account import Account
from eth_account.datastructures import SignedMessage
from eth_account.messages import encode_typed_data

from askgene_quant.signing.eip712 import (
    RISK_QUOTE_TYPES,
    build_domain,
    normalize_onchain_fields,
    typed_data_digest,
)

RISK_ORACLE_PRIVATE_KEY_ENV = "RISK_ORACLE_PRIVATE_KEY"


class MissingRiskOracleKey(RuntimeError):
    """No risk oracle private key is configured."""


@dataclass(frozen=True)
class SignedRiskQuote:
    """A fully signed, on-chain-ready `RiskQuote`: the exact struct
    `RiskEscrow.createEscrow` expects, plus the signature and the digest
    it was computed over (kept for audit/testing - not needed on-chain,
    since `hashRiskQuote` recomputes it from the quote itself)."""

    fields: dict  # RiskQuoteVerifier.RiskQuote-shaped dict, normalized
    signature: str  # 0x-prefixed 130-hex-char (65-byte) hex string
    digest: str  # 0x-prefixed EIP-712 digest that was signed
    signer: str  # checksummed address recovered from the signature
    chain_id: int
    verifying_contract: str


class RiskOracleSigner:
    """Signs `RiskQuote`s with a single secp256k1 key."""

    def __init__(self, private_key: str):
        self._account = Account.from_key(private_key)

    @classmethod
    def from_env(cls, env_var: str = RISK_ORACLE_PRIVATE_KEY_ENV) -> RiskOracleSigner:
        private_key = os.environ.get(env_var)
        if not private_key:
            raise MissingRiskOracleKey(
                f"{env_var} is not set; the risk oracle signing key must come from the "
                "environment (or a secrets manager in production), never be hardcoded"
            )
        return cls(private_key)

    @property
    def address(self) -> str:
        """Checksummed address this signer signs as - must equal the
        target `RiskEscrow`'s `riskOracle()` for its signatures to verify."""
        return self._account.address

    def sign_onchain_quote(
        self,
        onchain_fields: dict,
        *,
        chain_id: int,
        verifying_contract: str,
    ) -> SignedRiskQuote:
        """Sign an on-chain `RiskQuote` dict (e.g. from
        `RiskQuote.to_onchain_fields`) under the EIP-712 domain for a
        specific `RiskEscrow` deployment. Binding to `chain_id` and
        `verifying_contract` here (not left to the caller to get right
        later) is deliberate: a quote signed for the wrong chain or
        contract address will simply fail `_verifyRiskQuote` rather than
        silently settle somewhere unintended.
        """
        normalized = normalize_onchain_fields(onchain_fields)
        domain = build_domain(chain_id=chain_id, verifying_contract=verifying_contract)

        signable_message = encode_typed_data(
            domain_data=domain,
            message_types=RISK_QUOTE_TYPES,
            message_data=normalized,
        )
        signed: SignedMessage = Account.sign_message(signable_message, private_key=self._account.key)

        digest = typed_data_digest(domain, normalized)
        if bytes(signed.message_hash) != digest:
            # Would indicate a divergence between eth_account's internal
            # encoding and this module's independently-computed digest -
            # a bug, not a user error, so fail loudly rather than sign.
            raise RuntimeError(
                "EIP-712 digest mismatch between eth_account's typed-data encoder and "
                "askgene_quant.signing.eip712.typed_data_digest"
            )

        signature_hex = "0x" + signed.signature.hex()
        recovered = Account.recover_message(signable_message, signature=signed.signature)

        return SignedRiskQuote(
            fields=normalized,
            signature=signature_hex,
            digest="0x" + digest.hex(),
            signer=recovered,
            chain_id=chain_id,
            verifying_contract=domain["verifyingContract"],
        )
