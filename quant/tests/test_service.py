"""Tests for the request-a-quote service layer
(`service/quoting.py`, `service/signing_service.py`).

These exercise the *real* pipeline (real cached ETH-USD data, real GARCH
state) rather than synthetic fixtures, since the point of this phase is
that a real quote - not a mocked one - gets signed and accepted on-chain.
`load_market_data` maintains its own local parquet cache
(`quant/data_cache/`, gitignored) and only hits the network for data not
already cached; if neither a cache nor network access is available in a
given environment, these are skipped rather than failing the suite on an
infrastructure gap unrelated to the signing logic under test.
"""

from __future__ import annotations

from decimal import ROUND_CEILING, Decimal

import pytest

from askgene_quant.quotes.risk_quote import RiskQuote
from askgene_quant.service.quoting import (
    SUPPORTED_HORIZONS_DAYS,
    QuoteGenerationConfig,
    UnsupportedHorizon,
    generate_risk_quote,
)
from askgene_quant.service.signing_service import ZERO_ADDRESS, request_signed_quote
from askgene_quant.signing.risk_oracle import RiskOracleSigner

TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
TEST_ORACLE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

ASSET = "ETH-USD"
# A small n_scenarios keeps these tests fast; correctness of the risk
# figures themselves is covered by quant/tests/test_risk_engine.py etc.
FAST_CONFIG = QuoteGenerationConfig(n_scenarios=2_000)


def _market_data_available() -> bool:
    try:
        from askgene_quant.data.loader import load_market_data

        load_market_data(ASSET)
        return True
    except Exception:  # noqa: BLE001 - any failure (network, parse, IO) means "skip", not "fail"
        return False


pytestmark = pytest.mark.skipif(
    not _market_data_available(),
    reason="ETH-USD market data not cached locally and not fetchable (no network)",
)


def test_generate_risk_quote_produces_a_consistent_quote():
    quote = generate_risk_quote(asset=ASSET, notional=Decimal(10), horizon_days=7, config=FAST_CONFIG)

    assert isinstance(quote, RiskQuote)
    assert quote.asset == ASSET
    assert quote.notional == Decimal(10)
    assert quote.settlement_horizon_days == 7
    assert quote.settlement_horizon_seconds == 7 * 86_400
    assert quote.required_collateral >= quote.notional
    assert quote.quote_expiration > quote.quote_created_at


def test_generate_risk_quote_rejects_unsupported_horizon():
    with pytest.raises(UnsupportedHorizon):
        generate_risk_quote(asset=ASSET, notional=Decimal(10), horizon_days=3, config=FAST_CONFIG)


def test_generate_risk_quote_rejects_float_notional():
    with pytest.raises(TypeError):
        generate_risk_quote(asset=ASSET, notional=10.0, horizon_days=7, config=FAST_CONFIG)  # type: ignore[arg-type]


@pytest.mark.parametrize("horizon_days", SUPPORTED_HORIZONS_DAYS)
def test_request_signed_quote_end_to_end(horizon_days):
    signer = RiskOracleSigner(TEST_PRIVATE_KEY)
    result = request_signed_quote(
        signer=signer,
        asset=ASSET,
        notional=Decimal(10),
        horizon_days=horizon_days,
        depositor="0x" + "22" * 20,
        counterparty="0x" + "33" * 20,
        chain_id=31337,
        verifying_contract="0x" + "55" * 20,
        config=FAST_CONFIG,
    )

    assert result.signed.signer == TEST_ORACLE_ADDRESS
    assert result.signed.fields["settlementAsset"] == ZERO_ADDRESS
    assert int(result.signed.fields["settlementHorizon"]) == horizon_days * 86_400
    # notional/requiredCollateral on-chain must be the exact wei integer
    # the fixed-point conversion produces from the Decimal RiskQuote.
    from askgene_quant.serialization import to_fixed_point

    assert result.signed.fields["notional"] == to_fixed_point(result.quote.notional)
    assert result.signed.fields["requiredCollateral"] == to_fixed_point(
        result.quote.required_collateral, rounding=ROUND_CEILING
    )
