"""The risk oracle's HTTP service: the Python side of

    real market data -> quantitative risk engine -> RiskQuote
      -> EIP-712 signature -> Solidity verification -> RiskEscrow

`POST /v1/quotes` is the only endpoint - request a notional/horizon/party
binding, get back a `RiskQuote` signed with the configured risk oracle
key. `apps/web/app/api/quote/request/route.ts` calls this and hands the
result to the frontend, which submits it to `RiskEscrow.createEscrow`.

Run locally with:

    cd quant && .venv/bin/uvicorn askgene_quant.service.app:app --port 8001

The signing key comes from `RISK_ORACLE_PRIVATE_KEY` (see
`signing/risk_oracle.py`); it is loaded once at process start, not per
request, and the process exits immediately if it's missing rather than
serving unsigned or differently-signed quotes.
"""

from __future__ import annotations

import logging
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from askgene_quant.service.analytics import (
    DEFAULT_CONFIDENCE,
    SUPPORTED_CONFIDENCES,
    AnalyticsInputs,
    build_garch_view,
    build_risk_snapshot,
    build_tail_comparison,
    build_var_backtest,
    build_volatility_comparison,
    load_analytics_inputs,
)
from askgene_quant.service.quoting import (
    SUPPORTED_HORIZONS_DAYS,
    QuoteGenerationConfig,
    UnsupportedHorizon,
)
from askgene_quant.service.schemas import (
    GarchViewResponse,
    HealthResponse,
    QuoteRequest,
    QuoteResponse,
    RiskSnapshotResponse,
    TailComparisonResponse,
    VarBacktestResponse,
    VolatilityValidationResponse,
)
from askgene_quant.service.signing_service import request_signed_quote
from askgene_quant.signing.risk_oracle import RiskOracleSigner

logger = logging.getLogger("askgene_quant.service")

# The service only ever analyzes/prices this asset today - a dashboard
# asking for anything else gets a clear 422, not a silent mismatch.
SUPPORTED_ASSET = "ETH-USD"

_signer: RiskOracleSigner | None = None


def get_signer() -> RiskOracleSigner:
    global _signer
    if _signer is None:
        _signer = RiskOracleSigner.from_env()
        logger.info("risk oracle signer ready: address=%s", _signer.address)
    return _signer


def _validate_asset(asset: str) -> None:
    if asset != SUPPORTED_ASSET:
        raise HTTPException(
            status_code=422,
            detail=f"unsupported asset {asset!r}; only {SUPPORTED_ASSET!r} is available",
        )


def _validate_confidence(confidence: float) -> None:
    if confidence not in SUPPORTED_CONFIDENCES:
        raise HTTPException(
            status_code=422,
            detail=f"unsupported confidence {confidence!r}; choose one of {SUPPORTED_CONFIDENCES}",
        )


def _load_inputs(asset: str) -> AnalyticsInputs:
    _validate_asset(asset)
    try:
        return load_analytics_inputs(asset)
    except Exception as exc:
        raise HTTPException(
            status_code=503, detail=f"analytics inputs unavailable: {exc}"
        ) from exc


def _warm_analytics() -> None:
    """Pre-computes the expensive backtests once at startup so the first
    real request to /v1/models/* isn't the one paying for them. Opt-in
    (`ASKGENE_WARM_ANALYTICS=1`) - the local demo stack sets it; tests
    leave it off so they don't pay for an unused warm-up on every run."""
    try:
        inputs = load_analytics_inputs(SUPPORTED_ASSET)
        build_garch_view(inputs)
        build_volatility_comparison(inputs)
        build_var_backtest(inputs)
        build_tail_comparison(inputs)
        for confidence in SUPPORTED_CONFIDENCES:
            build_risk_snapshot(inputs, confidence)
        logger.info("analytics warm-up complete")
    except Exception:
        logger.exception("analytics warm-up failed; endpoints will compute on first request")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Fail fast: a service that can't sign is useless, so surface a
    # missing/invalid key immediately rather than on the first request.
    get_signer()
    if os.environ.get("ASKGENE_WARM_ANALYTICS") == "1":
        threading.Thread(target=_warm_analytics, daemon=True).start()
    yield


app = FastAPI(title="Crypto Settlement Risk Engine - Risk Oracle", version="1", lifespan=lifespan)


@app.get("/v1/oracle")
def oracle_info() -> dict:
    signer = get_signer()
    return {"address": signer.address, "supported_horizons_days": list(SUPPORTED_HORIZONS_DAYS)}


@app.get("/v1/health", response_model=HealthResponse)
def health() -> HealthResponse:
    signer = get_signer()
    inputs = _load_inputs(SUPPORTED_ASSET)
    return HealthResponse(
        status="ok",
        oracle_address=signer.address,
        data_as_of=inputs.returns.index[-1].isoformat(),
        model_fit_timestamp=inputs.state.fit_timestamp.isoformat(),
    )


@app.get("/v1/models/garch", response_model=GarchViewResponse)
def models_garch(asset: str = SUPPORTED_ASSET) -> GarchViewResponse:
    inputs = _load_inputs(asset)
    return GarchViewResponse(**build_garch_view(inputs))


@app.get("/v1/risk/snapshot", response_model=RiskSnapshotResponse)
def risk_snapshot(asset: str = SUPPORTED_ASSET, confidence: float = DEFAULT_CONFIDENCE) -> RiskSnapshotResponse:
    _validate_confidence(confidence)
    inputs = _load_inputs(asset)
    return RiskSnapshotResponse(**build_risk_snapshot(inputs, confidence))


@app.get("/v1/validation/volatility", response_model=VolatilityValidationResponse)
def validation_volatility(asset: str = SUPPORTED_ASSET) -> VolatilityValidationResponse:
    inputs = _load_inputs(asset)
    return VolatilityValidationResponse(**build_volatility_comparison(inputs))


@app.get("/v1/validation/var-backtest", response_model=VarBacktestResponse)
def validation_var_backtest(asset: str = SUPPORTED_ASSET) -> VarBacktestResponse:
    inputs = _load_inputs(asset)
    return VarBacktestResponse(**build_var_backtest(inputs))


@app.get("/v1/validation/tail-comparison", response_model=TailComparisonResponse)
def validation_tail_comparison(asset: str = SUPPORTED_ASSET) -> TailComparisonResponse:
    inputs = _load_inputs(asset)
    return TailComparisonResponse(**build_tail_comparison(inputs))


@app.post("/v1/quotes", response_model=QuoteResponse)
def request_quote(req: QuoteRequest) -> QuoteResponse:
    signer = get_signer()

    try:
        result = request_signed_quote(
            signer=signer,
            asset=req.asset,
            notional=req.notional_decimal(),
            horizon_days=req.horizon_days,
            depositor=req.depositor,
            counterparty=req.counterparty,
            chain_id=req.chain_id,
            verifying_contract=req.verifying_contract,
            settlement_asset=req.settlement_asset,
            settlement_asset_decimals=req.settlement_asset_decimals,
            config=QuoteGenerationConfig(confidence_level=req.confidence_level),
        )
    except UnsupportedHorizon as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    onchain_json = {
        key: (str(value) if isinstance(value, int) else value)
        for key, value in result.signed.fields.items()
    }

    return QuoteResponse(
        quote=result.quote.model_dump(mode="json"),
        onchain=onchain_json,
        signature=result.signed.signature,
        digest=result.signed.digest,
        signer=result.signed.signer,
        chain_id=result.signed.chain_id,
        verifying_contract=result.signed.verifying_contract,
    )
