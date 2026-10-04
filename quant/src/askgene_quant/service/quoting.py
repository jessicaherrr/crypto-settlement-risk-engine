"""Callable quote-generation pipeline: the same steps
`scripts/run_risk_pipeline.py` runs for its demo sweep across horizons,
factored out so a single (asset, notional, horizon) request - from the
HTTP service (`service/app.py`) or a CLI - can produce one `RiskQuote`
without re-running the whole multi-horizon report.

    market data -> GARCH state -> return-distribution scenarios
      -> VaR / Expected Shortfall -> stress tests -> collateral policy
      -> RiskQuote

No signing happens here - see `service/signing_service.py`, which adds
the EIP-712 signature on top of what this module produces.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from askgene_quant.config import DEFAULT_VOLATILITY_SETTINGS, VolatilitySettings
from askgene_quant.data.loader import load_market_data
from askgene_quant.data.quality import check_data_quality
from askgene_quant.data.returns import log_returns
from askgene_quant.models.pipeline import GarchVolatilityPipeline
from askgene_quant.models.store import ModelStateStore
from askgene_quant.policy.collateral import (
    CollateralPolicyConfig,
    apply_collateral_policy,
)
from askgene_quant.quotes.risk_quote import (
    DEFAULT_QUOTE_VALIDITY,
    RiskQuote,
    build_risk_quote,
)
from askgene_quant.risk.engine import (
    DEFAULT_PRIMARY_CONFIDENCE,
    RiskEngineConfig,
    SimulationMethod,
    run_risk_engine,
)
from askgene_quant.risk.stress import run_stress_tests

# The horizons the product actually offers; the collateral policy and
# on-chain settlement-horizon bounds (RiskEscrow.MIN/MAX_SETTLEMENT_HORIZON)
# are tuned around this discrete set, not an arbitrary continuous input.
SUPPORTED_HORIZONS_DAYS: tuple[int, ...] = (1, 7, 14, 30)

DEFAULT_N_SCENARIOS = 50_000


class UnsupportedHorizon(ValueError):
    pass


@dataclass(frozen=True)
class QuoteGenerationConfig:
    simulation_method: SimulationMethod = SimulationMethod.FILTERED_HISTORICAL
    confidence_level: float = DEFAULT_PRIMARY_CONFIDENCE
    n_scenarios: int = DEFAULT_N_SCENARIOS
    seed: int = 42
    volatility_settings: VolatilitySettings = field(default_factory=lambda: DEFAULT_VOLATILITY_SETTINGS)
    collateral_policy: CollateralPolicyConfig | None = None
    quote_validity: timedelta = field(default=DEFAULT_QUOTE_VALIDITY)


DEFAULT_QUOTE_GENERATION_CONFIG = QuoteGenerationConfig()


def generate_risk_quote(
    *,
    asset: str,
    notional: Decimal,
    horizon_days: int,
    config: QuoteGenerationConfig = DEFAULT_QUOTE_GENERATION_CONFIG,
    model_store: ModelStateStore | None = None,
) -> RiskQuote:
    """Run the full risk pipeline for one (asset, notional, horizon) and
    return the resulting unsigned `RiskQuote`. ``notional`` must already
    be a `Decimal` - this function is on the signing/on-chain boundary's
    input side, so it never accepts a raw `float` (see
    `serialization.py`'s module docstring)."""
    if not isinstance(notional, Decimal):
        raise TypeError(f"notional must be a Decimal, got {type(notional).__name__}")
    if notional <= 0:
        raise ValueError(f"notional must be positive, got {notional}")
    if horizon_days not in SUPPORTED_HORIZONS_DAYS:
        raise UnsupportedHorizon(
            f"horizon_days={horizon_days} is not supported; choose one of {SUPPORTED_HORIZONS_DAYS}"
        )

    settings = config.volatility_settings
    store = model_store or ModelStateStore()

    ohlcv = load_market_data(asset)
    check_data_quality(ohlcv).raise_if_invalid()
    returns = log_returns(ohlcv["close"])
    spot = Decimal(str(ohlcv["close"].iloc[-1]))

    pipeline = GarchVolatilityPipeline(asset, settings=settings, store=store)
    state = pipeline.load()
    if state is None:
        state = pipeline.fit(returns.iloc[-settings.garch_fitting_window :])
    params = pipeline._model.params

    engine_config = RiskEngineConfig(
        simulation_method=config.simulation_method,
        n_scenarios=config.n_scenarios,
        seed=config.seed,
        confidence_levels=(config.confidence_level,),
        primary_confidence=config.confidence_level,
    )
    risk_result = run_risk_engine(
        asset=asset,
        spot_price_usd=spot,
        horizon_days=horizon_days,
        returns=returns,
        garch_params=params,
        model_state=state,
        config=engine_config,
    )

    stress_summary = run_stress_tests(
        returns=returns,
        garch_params=params,
        model_state=state,
        horizon_days=horizon_days,
        confidence=config.confidence_level,
        n_scenarios=config.n_scenarios,
    )

    policy = config.collateral_policy or CollateralPolicyConfig(confidence_level=config.confidence_level)
    collateral_decision = apply_collateral_policy(
        notional=notional,
        es_loss_fraction=risk_result.es_at(config.confidence_level),
        stress_loss_fraction=Decimal(str(stress_summary.worst_loss_fraction)),
        policy=policy,
    )

    return build_risk_quote(
        asset=asset,
        notional=notional,
        spot_price_usd=spot,
        horizon_days=horizon_days,
        confidence_level=config.confidence_level,
        risk_result=risk_result,
        stress_summary=stress_summary,
        collateral_decision=collateral_decision,
        quote_validity=config.quote_validity,
    )
