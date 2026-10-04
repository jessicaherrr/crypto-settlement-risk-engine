# Risk Policy

Documents the collateral-policy layer (`quant/src/askgene_quant/policy/collateral.py`):
how model outputs (VaR, Expected Shortfall, stress losses) become a
required collateral amount. See `docs/methodology.md` for how those model
outputs themselves are produced (volatility state -> return distribution
-> VaR/ES/stress) — this document covers only the policy decision built
on top of them:

```
GARCH / FHS -> conditional loss distribution -> VaR / Expected Shortfall
risk policy (this document)                  -> required collateral
```

Model outputs and policy decisions are kept in separate modules
(`risk/` vs. `policy/`) so a change to collateralization rules never has
to touch the risk models, and a change to the risk models never has to
touch policy.

## The policy

```
weighted_es     = ES(confidence_level) * es_buffer_multiplier
weighted_stress = worst_stress_loss     * stress_buffer_multiplier
loss_basis      = max(weighted_es, weighted_stress)

raw_required    = notional * (1 + loss_basis)
required        = clamp(raw_required, notional * min_collateral_ratio, notional * max_collateral_ratio)
required        = round_up(required, rounding_decimals)   # never under-collateralize via rounding

collateral_buffer = required - notional
collateral_ratio  = required / notional
```

### Why Expected Shortfall, not VaR, is the primary basis

VaR answers "what's the loss at the boundary of the tail" but is silent
about how bad the tail *beyond* that boundary is — two distributions with
identical 99% VaR can have very different 99.9% losses. Expected
Shortfall is the mean loss *in* the tail, so it reflects that shape
directly, and it's a coherent (subadditive) risk measure where VaR is
not. For a collateral requirement meant to actually cover a bad outcome,
ES is the more defensible basis.

### Why stress loss acts as a floor, not just an input

`loss_basis` takes the *maximum* of the (weighted) ES and (weighted)
worst stress loss, not a weighted sum or a weighted average. Rationale:
stress scenarios exist specifically to cover outcomes the "normal"
simulated distribution may underweight (e.g. a short horizon priced
during an unusually quiet period, where ES is small even though a
historical crash of that or a similar size clearly can happen). Collateral
should reflect the visible worst case even when the model's current
conditional distribution hasn't recently sampled one — a pure ES-based
buffer could be too thin precisely when a regime shift is most likely.

### Rounding direction

`required_collateral` always rounds up (`ROUND_CEILING`) at the
configured precision (`rounding_decimals`, default 18 — wei-equivalent
for an 18-decimal asset like ETH). This is a deliberate, one-directional
choice: a rounding error must never leave an escrow under-collateralized
relative to what the policy computed. `notional` itself is not rounded by
this layer (it's a fixed input, not a safety margin).

## Configuration surface (`CollateralPolicyConfig`)

| field | default | meaning |
|---|---|---|
| `confidence_level` | `0.99` | Confidence level the ES component is read at (must match the `RiskResult` the caller supplies ES for). |
| `es_buffer_multiplier` | `1.00` | Multiplier on ES before comparing it to the stress basis. `>1.0` adds an explicit margin on top of the modeled tail loss. |
| `stress_buffer_multiplier` | `1.00` | Weight on the worst stress-test loss fraction. `<1.0` treats stress scenarios as a partial, not full, collateral requirement. |
| `min_collateral_ratio` | `1.00` | Floor: required collateral is never less than `notional * min_collateral_ratio`. At the default, collateral at least fully covers the notional. |
| `max_collateral_ratio` | `5.00` | Cap: required collateral never exceeds `notional * max_collateral_ratio`, regardless of how large ES/stress loss come out. Protects against a pathological model output (e.g. a degenerate GARCH fit) demanding an absurd collateral amount; a capped quote should be treated as a signal to reject the trade size/horizon combination, not a number to act on uncritically. |
| `rounding_decimals` | `18` (wei) | Fixed-point precision `required_collateral` is rounded up to. |

`CollateralDecision.floored` / `.capped` report whether either bound was
binding, so a caller (or a future dashboard) can distinguish "collateral
driven by modeled risk" from "collateral driven by a policy floor/cap."

## Example (real ETH data, 10 ETH notional, 99% confidence)

From `quant/scripts/run_risk_pipeline.py` against real ETH/USD data
(spot ≈ $2,669, current GARCH-filtered annualized vol ≈ 61% — see
`docs/methodology.md` for the full VaR/ES/stress tables):

| horizon | ES(99%) | worst stress loss | loss basis | collateral ratio | required collateral |
|---|---|---|---|---|---|
| 1d  | 14.0% | 50.0% (gap-down shock)            | 50.0% | 1.500 | 15.00 ETH |
| 7d  | 32.4% | 51.8% (historical worst case)     | 51.8% | 1.518 | 15.18 ETH |
| 14d | 42.3% | 64.0% (3x volatility shock)       | 64.0% | 1.640 | 16.40 ETH |
| 30d | 54.4% | 78.4% (3x volatility shock)       | 78.4% | 1.784 | 17.84 ETH |

Stress loss dominates ES at every horizon here (none of `floored`/`capped`
bind at the defaults) — a direct illustration of the floor described
above: even the FHS engine's own current-regime tail estimate (ES) is
consistently smaller than a plausible stress event, so collateral tracks
the stress scenario rather than the "normal" distribution.

## What this policy does not cover

- **Counterparty / default modeling.** Not implemented. There isn't yet
  sufficient real, labeled default/counterparty data to calibrate
  against, and this risk engine prices *market and tail risk on the
  settlement asset*, not counterparty credit risk. Revisit once such data
  exists.
- **Circuit breakers** (e.g. pausing quote generation under an extreme
  live implied-volatility move) and escrow size limits beyond the
  collateral-ratio cap above. Not yet implemented — `max_collateral_ratio`
  provides a crude per-quote backstop, but a venue-level circuit breaker
  is a separate, stateful concern (it needs to track *recent* market
  conditions across quotes, not just price one quote) left as future
  work.
- **Quote signing and on-chain binding.** This document covers how
  `required_collateral` is computed; `quotes/risk_quote.py` and
  `docs/methodology.md`'s "RiskQuote" section cover how that number is
  packaged, hashed, and signed for
  `RiskEscrow.sol`/`RiskQuoteVerifier.sol` to consume.
