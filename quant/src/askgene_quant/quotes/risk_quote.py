"""Canonical `RiskQuote`: the signed-quote representation the risk engine
hands downstream, ultimately to be consumed by `RiskEscrow.sol` via
`RiskQuoteVerifier.sol` (Phase E signs it; this phase only builds it).

Binds together everything that determined a price: the asset, notional,
settlement horizon, spot price, which model/method produced the risk
figures, the VaR/ES/stress numbers themselves, and the collateral policy's
output - plus a `risk_snapshot_hash` (keccak256 over a deterministic
encoding of the full pricing inputs/outputs, see `quotes/serialization.py`)
so the quote can be audited against exactly what produced it, without the
chain needing to store or re-derive the full risk computation.

`depositor` / `counterparty` are deliberately *not* part of this
representation: the risk engine prices a quote before it knows which two
parties will use it (`to_onchain_fields` takes them as parameters, applied
only when a quote is bound to a specific escrow). This matches
`contracts/RiskQuoteVerifier.sol`'s own comment that the engine prices
`requiredCollateral` against the settlement horizon, independent of quote
acceptance - the depositor/counterparty binding happens later still.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import ROUND_CEILING, Decimal
from uuid import uuid4

from pydantic import BaseModel

from askgene_quant.policy.collateral import CollateralDecision
from askgene_quant.risk.engine import RiskResult
from askgene_quant.risk.stress import StressTestSummary
from askgene_quant.serialization import hash_snapshot, keccak256, to_fixed_point

DEFAULT_QUOTE_VALIDITY = timedelta(minutes=5)


class RiskQuote(BaseModel):
    quote_id: str  # 0x-prefixed bytes32 hex
    asset: str
    notional: Decimal  # in units of the settlement asset (e.g. whole ETH)
    settlement_horizon_days: int
    settlement_horizon_seconds: int
    spot_price_usd: Decimal
    model_name: str
    model_version: str
    simulation_method: str
    confidence_level: Decimal
    forecast_volatility_annualized: Decimal
    value_at_risk: Decimal  # loss fraction of notional, at confidence_level
    expected_shortfall: Decimal  # loss fraction of notional, at confidence_level
    stress_loss: Decimal  # worst stress-scenario loss fraction of notional
    collateral_ratio: Decimal
    collateral_buffer: Decimal  # in units of the settlement asset
    required_collateral: Decimal  # in units of the settlement asset
    quote_created_at: datetime
    quote_expiration: datetime
    risk_snapshot_id: str
    risk_snapshot_hash: str  # 0x-prefixed keccak256 hex

    def to_onchain_fields(
        self,
        *,
        depositor: str,
        counterparty: str,
        settlement_asset_address: str,
        asset_decimals: int = 18,
    ) -> dict:
        """Map to exactly the field set of
        `RiskQuoteVerifier.RiskQuote` (`contracts/RiskQuoteVerifier.sol`),
        in the order its EIP-712 typehash expects. `requiredCollateral`
        rounds up (never under-collateralize via rounding); `notional`
        rounds to nearest (it's a fixed input, not a safety margin)."""
        return {
            "quoteId": self.quote_id,
            "depositor": depositor,
            "counterparty": counterparty,
            "settlementAsset": settlement_asset_address,
            "notional": to_fixed_point(self.notional, asset_decimals),
            "requiredCollateral": to_fixed_point(
                self.required_collateral, asset_decimals, rounding=ROUND_CEILING
            ),
            "quoteExpiration": int(self.quote_expiration.timestamp()),
            "settlementHorizon": self.settlement_horizon_seconds,
            "modelVersion": self.model_version,
            "riskSnapshotHash": self.risk_snapshot_hash,
        }


def build_risk_quote(
    *,
    asset: str,
    notional: Decimal,
    spot_price_usd: Decimal,
    horizon_days: int,
    confidence_level: float,
    risk_result: RiskResult,
    stress_summary: StressTestSummary,
    collateral_decision: CollateralDecision,
    quote_validity: timedelta = DEFAULT_QUOTE_VALIDITY,
    now: datetime | None = None,
) -> RiskQuote:
    created_at = now or datetime.now(UTC)
    expiration = created_at + quote_validity

    risk_snapshot = {
        "asset": asset,
        "notional": notional,
        "spot_price_usd": spot_price_usd,
        "horizon_days": horizon_days,
        "confidence_level": Decimal(str(confidence_level)),
        "model_name": risk_result.model_name,
        "model_version": risk_result.model_version,
        "simulation_method": str(risk_result.simulation_method),
        "n_scenarios": risk_result.n_scenarios,
        "seed": risk_result.seed,
        "forecast_volatility_annualized": risk_result.forecast_volatility_annualized,
        "var": risk_result.var,
        "expected_shortfall": risk_result.expected_shortfall,
        "stress_scenarios": {s.name: Decimal(str(s.loss_fraction)) for s in stress_summary.scenarios},
        "worst_stress_scenario": stress_summary.worst_scenario_name,
        "collateral_ratio": collateral_decision.collateral_ratio,
        "required_collateral": collateral_decision.required_collateral,
        "created_at": created_at,
    }
    risk_snapshot_id = uuid4().hex
    risk_snapshot_hash = hash_snapshot(risk_snapshot)
    quote_id = "0x" + keccak256(f"{asset}|{horizon_days}|{created_at.isoformat()}|{uuid4()}".encode()).hex()

    return RiskQuote(
        quote_id=quote_id,
        asset=asset,
        notional=notional,
        settlement_horizon_days=horizon_days,
        settlement_horizon_seconds=horizon_days * 86_400,
        spot_price_usd=spot_price_usd,
        model_name=risk_result.model_name,
        model_version=risk_result.model_version,
        simulation_method=str(risk_result.simulation_method),
        confidence_level=Decimal(str(confidence_level)),
        forecast_volatility_annualized=risk_result.forecast_volatility_annualized,
        value_at_risk=risk_result.var_at(confidence_level),
        expected_shortfall=risk_result.es_at(confidence_level),
        stress_loss=Decimal(str(stress_summary.worst_loss_fraction)),
        collateral_ratio=collateral_decision.collateral_ratio,
        collateral_buffer=collateral_decision.collateral_buffer,
        required_collateral=collateral_decision.required_collateral,
        quote_created_at=created_at,
        quote_expiration=expiration,
        risk_snapshot_id=risk_snapshot_id,
        risk_snapshot_hash=risk_snapshot_hash,
    )
