"""Request/response shapes for the risk-quote HTTP service
(`service/app.py`).

`QuoteRequest.notional` is typed `str`, not `float` or `Decimal`: a JSON
request body can only carry IEEE-754 numbers or strings, and pydantic
rejects a bare JSON number against a `str`-typed field outright (it does
not silently stringify it) - so a client that sends `"notional": 10.5`
instead of `"notional": "10.5"` fails validation instead of smuggling a
float across the HTTP boundary. See `serialization.py` for why floats are
disallowed everywhere past this point.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from pydantic import BaseModel, field_validator

from askgene_quant.service.signing_service import ZERO_ADDRESS

DEFAULT_CONFIDENCE_LEVEL = 0.99


class QuoteRequest(BaseModel):
    asset: str = "ETH-USD"
    notional: str
    horizon_days: int
    depositor: str
    counterparty: str
    settlement_asset: str = ZERO_ADDRESS
    settlement_asset_decimals: int = 18
    chain_id: int
    verifying_contract: str
    confidence_level: float = DEFAULT_CONFIDENCE_LEVEL

    @field_validator("notional")
    @classmethod
    def _validate_notional(cls, value: str) -> str:
        try:
            parsed = Decimal(value)
        except InvalidOperation as exc:
            raise ValueError(f"notional is not a valid decimal string: {value!r}") from exc
        if parsed <= 0:
            raise ValueError(f"notional must be positive, got {value!r}")
        return value

    def notional_decimal(self) -> Decimal:
        return Decimal(self.notional)


class QuoteResponse(BaseModel):
    """`quote`: the full `RiskQuote` (model outputs, for display/audit).
    `onchain`: exactly the `RiskQuoteVerifier.RiskQuote` struct fields,
    uint256s as decimal strings (never bare JSON numbers - see
    `QuoteRequest` docstring) so large fixed-point values round-trip
    through JS without precision loss.
    `signature` / `digest` / `signer`: the EIP-712 signature and the
    values it was computed over, for the caller to submit to
    `RiskEscrow.createEscrow` and to audit independently.
    """

    quote: dict
    onchain: dict
    signature: str
    digest: str
    signer: str
    chain_id: int
    verifying_contract: str


class HealthResponse(BaseModel):
    status: str
    oracle_address: str
    data_as_of: str
    model_fit_timestamp: str


class GarchViewResponse(BaseModel):
    """`/v1/models/garch`: the current fitted GARCH(1,1) state - see
    `service/analytics.build_garch_view`. Decimal-sensitive quantities
    here (persistence, vols, diagnostics) are float statistics, not
    on-chain amounts, so they're left as JSON numbers rather than strings.
    """

    params: dict
    persistence: float
    half_life_days: float | None
    current_vol_annualized: float
    long_run_vol_annualized: float | None
    diagnostics: dict
    training_window: dict
    refit_frequency: int
    fit_timestamp: str
    staleness_days: int
    vol_history: list[dict]
    meta: dict


class RiskSnapshotResponse(BaseModel):
    """`/v1/risk/snapshot`: per-horizon VaR/ES/stress/collateral at a
    notional of 1 unit, for display - never signed, never a substitute for
    `POST /v1/quotes`. See `service/analytics.build_risk_snapshot`."""

    spot_price_usd: str
    confidence_level: float
    model_version: str
    simulation_method: str
    policy: dict
    horizons: list[dict]
    meta: dict


class VolatilityValidationResponse(BaseModel):
    """`/v1/validation/volatility`: RMSE/QLIKE comparison of rolling,
    EWMA, and GARCH volatility. See
    `service/analytics.build_volatility_comparison`."""

    oos_start: str
    oos_end: str
    n_oos: int
    proxy: str
    metrics: dict
    series: list[dict]
    meta: dict


class VarBacktestResponse(BaseModel):
    """`/v1/validation/var-backtest`: Kupiec coverage test + ES diagnostic
    per confidence level, 1-day horizon only. See
    `service/analytics.build_var_backtest`."""

    horizon_days: int
    results: list[dict]
    series: list[dict]
    assumptions: list[str]
    meta: dict


class TailComparisonResponse(BaseModel):
    """`/v1/validation/tail-comparison`: horizon x method VaR/ES table
    (historical / filtered historical / GBM). See
    `service/analytics.build_tail_comparison`."""

    n_scenarios: int
    rows: list[dict]
    meta: dict
