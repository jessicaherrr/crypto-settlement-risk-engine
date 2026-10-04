from __future__ import annotations

from decimal import Decimal

import pytest

from askgene_quant.policy.collateral import (
    CollateralPolicyConfig,
    apply_collateral_policy,
)


def test_collateral_uses_the_larger_of_es_and_stress():
    policy = CollateralPolicyConfig()

    decision_es_dominant = apply_collateral_policy(
        notional=Decimal(10),
        es_loss_fraction=Decimal("0.30"),
        stress_loss_fraction=Decimal("0.10"),
        policy=policy,
    )
    assert decision_es_dominant.loss_basis_fraction == Decimal("0.30")

    decision_stress_dominant = apply_collateral_policy(
        notional=Decimal(10),
        es_loss_fraction=Decimal("0.10"),
        stress_loss_fraction=Decimal("0.40"),
        policy=policy,
    )
    assert decision_stress_dominant.loss_basis_fraction == Decimal("0.40")


def test_required_collateral_at_least_covers_notional():
    policy = CollateralPolicyConfig(min_collateral_ratio=Decimal("1.0"))
    decision = apply_collateral_policy(
        notional=Decimal(10),
        es_loss_fraction=Decimal("0.0"),
        stress_loss_fraction=Decimal("0.0"),
        policy=policy,
    )
    assert decision.required_collateral >= decision.notional


def test_required_collateral_floored_at_min_ratio_when_loss_basis_is_small():
    policy = CollateralPolicyConfig(min_collateral_ratio=Decimal("1.5"))
    decision = apply_collateral_policy(
        notional=Decimal(10),
        es_loss_fraction=Decimal("0.1"),
        stress_loss_fraction=Decimal("0.0"),
        policy=policy,
    )
    assert decision.required_collateral == Decimal("15.000000000000000000")
    assert decision.floored


def test_required_collateral_capped_at_max_ratio():
    policy = CollateralPolicyConfig(max_collateral_ratio=Decimal("2.0"))
    decision = apply_collateral_policy(
        notional=Decimal(10),
        es_loss_fraction=Decimal("5.0"),  # absurdly large loss fraction
        stress_loss_fraction=Decimal("0.0"),
        policy=policy,
    )
    assert decision.required_collateral == Decimal("20.000000000000000000")
    assert decision.capped


def test_collateral_buffer_and_ratio_are_consistent():
    policy = CollateralPolicyConfig()
    decision = apply_collateral_policy(
        notional=Decimal(10),
        es_loss_fraction=Decimal("0.25"),
        stress_loss_fraction=Decimal("0.10"),
        policy=policy,
    )
    assert decision.collateral_buffer == decision.required_collateral - decision.notional
    assert decision.collateral_ratio == decision.required_collateral / decision.notional


def test_required_collateral_rounds_up_never_under_collateralizing():
    # A loss basis chosen so the exact buffer has a long decimal tail;
    # rounding must go up, not to nearest/down.
    policy = CollateralPolicyConfig(rounding_decimals=2)
    decision = apply_collateral_policy(
        notional=Decimal(1),
        es_loss_fraction=Decimal("0.111111"),
        stress_loss_fraction=Decimal(0),
        policy=policy,
    )
    exact_required = Decimal(1) * (Decimal(1) + Decimal("0.111111"))
    assert decision.required_collateral >= exact_required
    assert str(decision.required_collateral) == "1.12"


def test_apply_collateral_policy_rejects_non_positive_notional():
    with pytest.raises(ValueError):
        apply_collateral_policy(
            notional=Decimal(0),
            es_loss_fraction=Decimal("0.1"),
            stress_loss_fraction=Decimal("0.1"),
        )
