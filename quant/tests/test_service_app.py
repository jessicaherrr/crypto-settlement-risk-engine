"""Tests for the risk-oracle HTTP service (`service/app.py`) - the layer
`apps/web/app/api/quote/request/route.ts` calls to get a signed
`RiskQuote` for a real request. Exercises the FastAPI app directly
in-process (no network), so these only need the local ETH-USD cache, not
a running server.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from askgene_quant.service import app as app_module

TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
TEST_ORACLE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"


def _market_data_available() -> bool:
    try:
        from askgene_quant.data.loader import load_market_data

        load_market_data("ETH-USD")
        return True
    except Exception:  # noqa: BLE001 - any failure (network, parse, IO) means "skip", not "fail"
        return False


pytestmark = pytest.mark.skipif(
    not _market_data_available(),
    reason="ETH-USD market data not cached locally and not fetchable (no network)",
)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("RISK_ORACLE_PRIVATE_KEY", TEST_PRIVATE_KEY)
    app_module._signer = None  # force re-read of the (now-patched) env var
    with TestClient(app_module.app) as c:
        yield c
    app_module._signer = None


def test_oracle_info(client):
    resp = client.get("/v1/oracle")
    assert resp.status_code == 200
    body = resp.json()
    assert body["address"] == TEST_ORACLE_ADDRESS
    assert 7 in body["supported_horizons_days"]


def test_request_quote_returns_signed_onchain_fields(client):
    resp = client.post(
        "/v1/quotes",
        json={
            "asset": "ETH-USD",
            "notional": "10",
            "horizon_days": 7,
            "depositor": "0x" + "22" * 20,
            "counterparty": "0x" + "33" * 20,
            "chain_id": 31337,
            "verifying_contract": "0x" + "55" * 20,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["signer"] == TEST_ORACLE_ADDRESS
    assert body["chain_id"] == 31337
    onchain = body["onchain"]
    assert onchain["depositor"] == "0x2222222222222222222222222222222222222222"
    # uint256 fields must be decimal strings, never bare JSON numbers.
    assert isinstance(onchain["notional"], str)
    assert isinstance(onchain["requiredCollateral"], str)
    assert int(onchain["requiredCollateral"]) >= int(onchain["notional"])


def test_request_quote_rejects_float_notional(client):
    resp = client.post(
        "/v1/quotes",
        json={
            "asset": "ETH-USD",
            "notional": 10.5,  # bare JSON number, not a string
            "horizon_days": 7,
            "depositor": "0x" + "22" * 20,
            "counterparty": "0x" + "33" * 20,
            "chain_id": 31337,
            "verifying_contract": "0x" + "55" * 20,
        },
    )
    assert resp.status_code == 422


def test_request_quote_rejects_unsupported_horizon(client):
    resp = client.post(
        "/v1/quotes",
        json={
            "asset": "ETH-USD",
            "notional": "10",
            "horizon_days": 3,
            "depositor": "0x" + "22" * 20,
            "counterparty": "0x" + "33" * 20,
            "chain_id": 31337,
            "verifying_contract": "0x" + "55" * 20,
        },
    )
    assert resp.status_code == 422
