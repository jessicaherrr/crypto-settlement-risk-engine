"""Stdin/stdout JSON CLI the Hardhat integration tests (and any other
non-Python caller) use to drive the Python signing layer directly,
without going through the HTTP service.

Two modes, selected by `"mode"` in the JSON request on stdin:

- ``"raw"``: sign an already-built on-chain `RiskQuote` field dict as-is.
  Used for tests that need precise control over individual fields
  (tampering, expiry, replay, wrong-party cases) without re-running the
  quantitative pipeline for each case.
- ``"generate"``: run the real risk pipeline (`service.quoting`) for an
  (asset, notional, horizon) and sign the result. Used for the "real
  Python-generated quote" end-to-end tests.

The private key is always passed explicitly in the request (not read from
`RISK_ORACLE_PRIVATE_KEY`) so tests can sign with whichever account they
configured as `RiskEscrow`'s oracle, deterministically, without mutating
process environment between cases.

Usage:
    echo '{"mode": "raw", ...}' | python scripts/sign_quote_cli.py
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from askgene_quant.service.quoting import QuoteGenerationConfig, generate_risk_quote
from askgene_quant.signing.risk_oracle import RiskOracleSigner

_UINT_FIELD_NAMES = ("notional", "requiredCollateral", "quoteExpiration", "settlementHorizon")


def _coerce_raw_fields(fields: dict) -> dict:
    """JSON over stdin can't carry a uint256 as a native number without
    risking precision loss, so callers send large uints as decimal
    strings; coerce those (and plain ints) to Python `int` here before
    handing off to `normalize_onchain_fields`, which requires `int`."""
    coerced = dict(fields)
    for name in _UINT_FIELD_NAMES:
        if name in coerced:
            coerced[name] = int(coerced[name])
    return coerced


def _run_raw(request: dict, signer: RiskOracleSigner) -> dict:
    fields = _coerce_raw_fields(request["fields"])
    signed = signer.sign_onchain_quote(
        fields,
        chain_id=int(request["chain_id"]),
        verifying_contract=request["verifying_contract"],
    )
    return {
        "fields": {k: (str(v) if isinstance(v, int) else v) for k, v in signed.fields.items()},
        "signature": signed.signature,
        "digest": signed.digest,
        "signer": signed.signer,
    }


def _run_generate(request: dict, signer: RiskOracleSigner) -> dict:
    quote = generate_risk_quote(
        asset=request.get("asset", "ETH-USD"),
        notional=Decimal(request["notional"]),
        horizon_days=int(request["horizon_days"]),
        config=QuoteGenerationConfig(confidence_level=float(request.get("confidence_level", 0.99))),
    )
    onchain_fields = quote.to_onchain_fields(
        depositor=request["depositor"],
        counterparty=request["counterparty"],
        settlement_asset_address=request.get("settlement_asset", "0x0000000000000000000000000000000000000000"),
        asset_decimals=int(request.get("settlement_asset_decimals", 18)),
    )
    signed = signer.sign_onchain_quote(
        onchain_fields,
        chain_id=int(request["chain_id"]),
        verifying_contract=request["verifying_contract"],
    )
    return {
        "quote": json.loads(quote.model_dump_json()),
        "fields": {k: (str(v) if isinstance(v, int) else v) for k, v in signed.fields.items()},
        "signature": signed.signature,
        "digest": signed.digest,
        "signer": signed.signer,
    }


def main() -> None:
    request = json.load(sys.stdin)
    signer = RiskOracleSigner(request["private_key"])

    mode = request.get("mode", "raw")
    if mode == "raw":
        result = _run_raw(request, signer)
    elif mode == "generate":
        result = _run_generate(request, signer)
    else:
        raise ValueError(f"unknown mode: {mode!r}")

    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
