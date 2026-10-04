"""Glues quote generation (`service/quoting.py`) to EIP-712 signing
(`signing/risk_oracle.py`): the single call a request handler or CLI needs
to go from (asset, notional, horizon, parties, chain) to a fully signed
`RiskQuote` ready for `RiskEscrow.createEscrow`.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from askgene_quant.quotes.risk_quote import RiskQuote
from askgene_quant.service.quoting import QuoteGenerationConfig, generate_risk_quote
from askgene_quant.signing.risk_oracle import RiskOracleSigner, SignedRiskQuote

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


@dataclass(frozen=True)
class QuoteAndSignature:
    quote: RiskQuote
    signed: SignedRiskQuote


def request_signed_quote(
    *,
    signer: RiskOracleSigner,
    asset: str,
    notional: Decimal,
    horizon_days: int,
    depositor: str,
    counterparty: str,
    chain_id: int,
    verifying_contract: str,
    settlement_asset: str = ZERO_ADDRESS,
    settlement_asset_decimals: int = 18,
    config: QuoteGenerationConfig | None = None,
) -> QuoteAndSignature:
    """End-to-end: compute a `RiskQuote` for (asset, notional, horizon),
    bind it to a depositor/counterparty/settlement asset, and sign it
    under the EIP-712 domain for `verifying_contract` on `chain_id`.
    """
    quote = generate_risk_quote(
        asset=asset,
        notional=notional,
        horizon_days=horizon_days,
        config=config or QuoteGenerationConfig(),
    )

    onchain_fields = quote.to_onchain_fields(
        depositor=depositor,
        counterparty=counterparty,
        settlement_asset_address=settlement_asset,
        asset_decimals=settlement_asset_decimals,
    )

    signed = signer.sign_onchain_quote(
        onchain_fields,
        chain_id=chain_id,
        verifying_contract=verifying_contract,
    )

    return QuoteAndSignature(quote=quote, signed=signed)
