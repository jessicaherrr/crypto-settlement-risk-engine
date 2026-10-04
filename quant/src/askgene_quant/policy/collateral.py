"""Collateral policy: converts a conditional loss distribution (VaR / ES)
plus stress results into a required collateral amount.

Deliberately a separate layer from `risk/engine.py` and `risk/stress.py`:
those modules only describe risk (what could happen, statistically and
under stress); this module decides what to *do* about it (how much
collateral to require). The boundary is:

    GARCH/FHS -> conditional loss distribution -> VaR / Expected Shortfall
    risk policy (this module) -> required collateral

so a future change to collateralization rules (a different buffer
multiplier, a different floor/cap) never has to touch the risk models, and
a future change to the risk models never has to touch policy.

The policy itself: required collateral is notional plus a buffer sized off
the *larger* of (a) Expected Shortfall at the policy's confidence level and
(b) the worst stress-test loss, each scaled by its own configurable
multiplier - then clamped to a configured [min, max] collateral-ratio
range. Using ES rather than VaR as the primary buffer basis is deliberate:
VaR is silent about how bad the tail beyond it is, and ES is the coherent
(subadditive) measure of exactly that. Stress results act as a floor that
can bind even when ES is small (e.g. a very short horizon in a quiet
period) - collateral should reflect visible tail scenarios even if the
simulated distribution hasn't recently sampled one.
"""

from __future__ import annotations

from decimal import ROUND_CEILING, Decimal

from pydantic import BaseModel

from askgene_quant.serialization import WEI_DECIMALS, quantize_decimal

DEFAULT_CONFIDENCE = 0.99


class CollateralPolicyConfig(BaseModel):
    confidence_level: float = DEFAULT_CONFIDENCE
    # Multiplier applied to Expected Shortfall before comparing it to the
    # stress-loss basis - >1.0 adds an explicit margin on top of the
    # modeled tail loss itself.
    es_buffer_multiplier: Decimal = Decimal("1.00")
    # Weight applied to the worst stress-test loss fraction. <1.0 treats
    # stress scenarios as a partial (not full) collateral requirement.
    stress_buffer_multiplier: Decimal = Decimal("1.00")
    # required_collateral is clamped to notional * [min_ratio, max_ratio].
    min_collateral_ratio: Decimal = Decimal("1.00")
    max_collateral_ratio: Decimal = Decimal("5.00")
    rounding_decimals: int = WEI_DECIMALS


DEFAULT_COLLATERAL_POLICY = CollateralPolicyConfig()


class CollateralDecision(BaseModel):
    notional: Decimal
    es_loss_fraction: Decimal
    stress_loss_fraction: Decimal
    loss_basis_fraction: Decimal  # the max(weighted ES, weighted stress) actually used
    collateral_buffer: Decimal
    required_collateral: Decimal
    collateral_ratio: Decimal
    confidence_level: float
    floored: bool  # min_collateral_ratio bound was binding
    capped: bool  # max_collateral_ratio bound was binding


def apply_collateral_policy(
    *,
    notional: Decimal,
    es_loss_fraction: Decimal,
    stress_loss_fraction: Decimal,
    policy: CollateralPolicyConfig = DEFAULT_COLLATERAL_POLICY,
) -> CollateralDecision:
    if notional <= 0:
        raise ValueError(f"notional must be positive, got {notional}")

    weighted_es = es_loss_fraction * policy.es_buffer_multiplier
    weighted_stress = stress_loss_fraction * policy.stress_buffer_multiplier
    loss_basis = max(weighted_es, weighted_stress)

    raw_required = notional * (Decimal(1) + loss_basis)
    min_required = notional * policy.min_collateral_ratio
    max_required = notional * policy.max_collateral_ratio

    floored = raw_required < min_required
    capped = raw_required > max_required
    required = min(max(raw_required, min_required), max_required)

    # Round up: a rounding error must never leave an escrow under-
    # collateralized relative to what the policy computed.
    required = quantize_decimal(required, policy.rounding_decimals, rounding=ROUND_CEILING)

    buffer = required - notional
    ratio = required / notional

    return CollateralDecision(
        notional=notional,
        es_loss_fraction=es_loss_fraction,
        stress_loss_fraction=stress_loss_fraction,
        loss_basis_fraction=loss_basis,
        collateral_buffer=buffer,
        required_collateral=required,
        collateral_ratio=ratio,
        confidence_level=policy.confidence_level,
        floored=floored,
        capped=capped,
    )
