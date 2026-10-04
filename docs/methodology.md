# Methodology

Covers the quantitative layer (`quant/src/askgene_quant/`): market data,
returns, and volatility modeling, and the VaR / Expected
Shortfall / stress-testing / collateral-pricing risk engine built on top
of it ("Risk engine" section below).

## Data

Daily OHLCV candles for ETH-USD from the Coinbase Exchange public
market-data API (`data/coinbase.py`), cached locally as parquet
(`data/loader.py`) so repeated runs don't re-hit the network. As of this
writing, ~3,790 daily candles are available, 2016-05-18 through today.

`data/quality.py` runs structural checks (duplicate/unsorted timestamps,
non-positive prices, NaNs, `high < low`) as hard errors, and calendar-gap /
extreme-single-day-move checks as warnings — crypto trades every day, so a
missing date usually signals a data-source gap, but a >50% single-day move
is a real (if rare) event, not necessarily bad data (e.g. 2020-03-12,
"Black Thursday").

## Returns

Log returns throughout: `r_t = log(P_t / P_{t-1})`. Chosen for
time-additivity and because it's the standard input for conditional
volatility models.

ETH/USD daily log returns (full history): mean ≈ 0.0014/day, std ≈ 0.049,
skew ≈ -0.39, excess kurtosis ≈ 9.5. The kurtosis alone rejects normality
(Jarque-Bera p ≈ 0) — see `notebooks/01_returns_and_volatility.ipynb` for
the distributional detail (fat tails, volatility clustering via the ACF of
squared returns).

## Volatility models

Three estimators are implemented, in increasing order of sophistication:

**Rolling/realized volatility** (`volatility/realized.py`) — trailing
sample standard deviation over a fixed window (default 30 days). Simple,
but equal-weights every observation in the window and "ghosts": the
estimate jumps whenever an old extreme observation rolls out of the
window, regardless of anything happening today.

**EWMA** (`volatility/ewma.py`, RiskMetrics-style) —
`sigma2_t = lambda * sigma2_{t-1} + (1-lambda) * r_t^2`, default
`lambda = 0.94`. No parameters are estimated by MLE; `lambda` is a
configuration choice. Because there's no mean reversion, the h-step-ahead
forecast for any horizon is just the current level. Naturally incremental:
`EWMAVolatility.update(r)` is the entire online story.

**GARCH(1,1)** (`volatility/garch.py`) — the dynamic conditional-variance
model:

```
sigma2_t = omega + alpha * eps_{t-1}^2 + beta * sigma2_{t-1}
```

estimated by maximum likelihood (via the `arch` package) on a fitting
window, then run forward via the closed-form recursion above under fixed
parameters. **Estimation and updating are deliberately separate
operations** — see "Online architecture" below — because re-running MLE on
every new observation is both unnecessary (the recursion is O(1) and exact
given fixed parameters) and undesirable (parameters should only change on
a controlled schedule, not drift with every tick).

Current fit (trailing 750-day window): omega ≈ 4.5e-4, alpha ≈ 0.096,
beta ≈ 0.55, persistence (alpha+beta) ≈ 0.65 — stationary, with returns
reverting to a long-run variance roughly 1/(1-0.65) ≈ 2.9x the
instantaneous shock variance. Standardized residuals pass a Ljung-Box test
for leftover autocorrelation in squared residuals (p ≈ 0.85-0.95 at
lags 10/20), i.e. the model materially removes the volatility clustering
present in raw squared returns. See `notebooks/02_garch_analysis.ipynb`.

### Numerical stability note

GARCH MLE on short, shock-heavy crypto windows occasionally converges to a
near-integrated boundary solution (alpha≈0, beta≈1 - observed during
out-of-sample walk-forward refitting around a 2025 window). At that
boundary, the model's *theoretical* unconditional variance
`omega / (1 - alpha - beta)` divides by a near-zero denominator and
explodes numerically, even though the fitted dynamics themselves are a
legitimate (if extreme) high-persistence estimate. `conditional_variance_path`
therefore always seeds the variance recursion from the fitting window's
*empirical* sample variance rather than the theoretical unconditional
variance - stable regardless of how close the fit lands to the
stationarity boundary. Covered by a regression test
(`tests/test_garch.py::test_conditional_variance_path_stable_at_near_integrated_boundary`).

## Online architecture

```
historical data
  -> fit model parameters          (GARCHModel.fit / GarchVolatilityPipeline.fit)
  -> save model state              (ModelStateStore, automatic)
  -> receive new return
  -> update conditional variance   (GARCHModel.update / GarchVolatilityPipeline.update)
  -> produce new volatility forecast (GARCHModel.forecast)
  -> periodically refit parameters (GarchVolatilityPipeline.should_refit -> fit)
```

`update()` never re-estimates parameters; it only advances the closed-form
recursion with the current fitted (omega, alpha, beta). Fitting-window
length (default 750 observations) and refit frequency (default every 21
observations) are both configurable via `VolatilitySettings`
(`config.py`).

`models/state.py` defines `ModelState`, the serializable record of a
fitted model: asset, model name/version, training window, fitted
parameters, fit diagnostics (log-likelihood, AIC, BIC, convergence), fit
timestamp, and the latest conditional variance / observation timestamp /
squared residual needed to resume the recursion. `models/store.py`
persists it as JSON — `latest.json` is overwritten on every save (fit or
update) so a pipeline can restart from it, while `history/*.json`
snapshots are written only on a fit/refit (not every update), giving an
audit trail of how parameters evolved without one file per observation.

## Validation methodology

See `docs/model_validation.md` for results; this section covers how the
comparison avoids look-ahead bias.

For each out-of-sample day *t*, every model's forecast uses only
information available through day *t-1*:

- **Rolling historical**: `returns.rolling(window).var().shift(1)` — the
  `shift(1)` is what makes day *t*'s forecast depend only on
  `returns[t-window-1 : t-1]`.
- **EWMA**: the recursion is seeded only from the pre-out-of-sample
  training slice, then run forward through the full series and shifted by
  one — by construction, `sigma2_t` only ever depends on `r_1..r_t`.
- **GARCH**: parameters are fit once on the window immediately preceding
  the out-of-sample start, then updated one day at a time via the
  recursion as each return is revealed; refitting (on `garch_refit_frequency`)
  only uses data up to and including the day just revealed, never the day
  being forecast.

Forecasts are scored against the realized-variance proxy `r_t^2` using
RMSE and QLIKE (`validation/metrics.py`); QLIKE
(`mean(log(forecast) + proxy/forecast)`) is the more standard metric for
variance-forecast comparison since it penalizes under-prediction more
heavily and is robust to the choice of proxy.

## Risk engine

Built on top of the volatility layer:

```
volatility state (GARCH/EWMA/realized)
  -> future return / settlement-value distribution   (simulation/)
  -> VaR / Expected Shortfall                          (risk/measures.py, risk/engine.py)
  -> stress testing                                    (risk/stress.py)
  -> collateral policy                                 (policy/collateral.py)
  -> RiskQuote                                         (quotes/risk_quote.py)
```

Model outputs (VaR/ES/stress) and policy decisions (collateral) are
deliberately separate layers - `risk/` never decides collateral, and
`policy/` never computes a return distribution. This means a future change
to collateralization rules never touches the risk models and vice versa.

### Return-distribution methods (`simulation/`)

Three interchangeable ways to generate the settlement-horizon return
distribution a `RiskResult` is read off of:

**Historical simulation** (`simulation/historical.py`) - the empirical
distribution of actual overlapping *h*-day moves, built by summing *h*
consecutive daily log returns (`log(P_t/P_{t-h})`, which is exact because
log returns are additive). No distributional assumption at all, but
limited by how much history exists, and overlapping windows share up to
`h-1` days with their neighbors, so scenarios aren't independent draws.

**Filtered historical simulation (FHS)** (`simulation/filtered_historical.py`)
- the primary method (`RiskEngineConfig.simulation_method` defaults to
it). Combines two things no single simpler model does:

1. Time-varying volatility via the GARCH(1,1) recursion, seeded at the
   model's *current* filtered state - a simulated path starts from where
   volatility actually is right now, not an unconditional average.
2. The empirical shape of return shocks: each simulated day's innovation
   is a bootstrap draw from the model's own historical standardized
   residuals (`z_t = (r_t - mu)/sigma_t`), rather than a Normal or
   Student-t assumption. Crypto returns are fat-tailed and skewed (see
   "Returns" above); resampling realized residuals carries that empirical
   shape forward unchanged.

The residual pool defaults to the *full* return history passed in (not
just the shorter GARCH fitting window), a deliberate choice: parameters
should reflect recent dynamics, but the shock distribution should still be
able to produce a 2018-bear-market or 2020-COVID-crash-sized move even
though neither is recent. `RiskEngineConfig.residual_pool_window` can
override this.

**GBM Monte Carlo** (`simulation/gbm.py`) - i.i.d.-Normal daily
increments, constant drift/vol. Included as a *benchmark*, not as the
preferred crypto model: real ETH/USD returns visibly violate both of
GBM's core assumptions (volatility clustering, fat tails - see "Returns"
above), and the results below show GBM materially under-pricing tail risk
relative to historical simulation and FHS at every horizon.

### Multi-day horizons: no blind sqrt-time scaling

A settlement horizon's risk is explicitly *not* built by scaling a 1-day
VaR/ES by `sqrt(horizon)`. That scaling is only exact for i.i.d.,
constant-volatility processes - precisely what GARCH/FHS says ETH returns
are not, and what the historical record (volatility clustering, visible
in the ACF of squared returns) confirms they are not. Instead:

- Historical simulation uses the *actual* overlapping *h*-day realized
  moves - whatever autocorrelation or clustering existed in history is
  already baked into those numbers.
- FHS simulates day-by-day paths: each day's conditional variance is fed
  forward through the GARCH recursion using that same path's own simulated
  shocks, so an unusually large early shock in a path raises that path's
  later-day variance, exactly as the fitted dynamics say it should.
- GBM's own multi-day distribution genuinely is Normal with variance
  scaling linearly in time (volatility in `sqrt(time)`) - but that's
  intrinsic to GBM's i.i.d. assumption, sampled directly for efficiency,
  not a scaling rule imposed on top of a model that already captures
  time-varying volatility.

### Risk measures (`risk/measures.py`)

VaR and Expected Shortfall are both expressed as positive *loss fractions*
of notional, read off the settlement-horizon *simple* return distribution
(`simple_return = exp(log_return) - 1`, computed in `risk/engine.py` right
after the simulators produce their log-return scenarios). The conversion
matters at these horizons: 30-day ETH moves of 40-50%+ are common enough
in the data that the log/simple gap is not a rounding error.

- `VaR(c) = -quantile(simple_returns, 1 - c)`, floored at 0.
- `ES(c) = -mean(simple_returns <= quantile(simple_returns, 1 - c))`, i.e.
  the average loss in the tail beyond VaR - strictly more conservative
  than VaR and, unlike VaR, a coherent (subadditive) risk measure.

### Stress testing (`risk/stress.py`)

Four scenario families, each probing a different failure mode the
"normal" conditional distribution above may not emphasize:

- **Historical worst case** - the worst realized overlapping *h*-day ETH
  move that actually happened, read directly off real data.
- **Volatility shock** (2x / 3x) - annualized volatility instantaneously
  jumped to a multiple of its current GARCH-filtered level, priced via a
  zero-drift GBM Expected Shortfall at the shocked vol (not FHS - FHS's
  whole point is pricing the *current* regime, so a vol shock is
  explicitly priced as a deviation from it, not a resample of recent
  history).
- **Gap-down shock** (30% / 50%) - an instantaneous, model-independent
  price drop (exchange insolvency, stablecoin depeg, forced liquidation
  cascade) applied directly to spot. No continuous-path model (GBM or
  GARCH) can produce a true discontinuity, so this is deliberately
  outside the simulation layer entirely.
- **Extended horizon** - the same FHS engine run at roughly 2x the
  requested horizon, showing how tail loss grows if settlement is
  delayed.

`run_stress_tests` reports every scenario's loss fraction and detail; it
does not itself pick "the" stress number - `policy/collateral.py` decides
how stress results feed into required collateral (the maximum across
scenarios, by default).

### Collateral policy (`policy/collateral.py`)

```
GARCH/FHS -> conditional loss distribution -> VaR / Expected Shortfall
risk policy                                 -> required collateral
```

`required_collateral = notional * (1 + loss_basis)`, where
`loss_basis = max(ES(confidence) * es_buffer_multiplier, worst_stress_loss * stress_buffer_multiplier)`,
clamped to `notional * [min_collateral_ratio, max_collateral_ratio]`.
Expected Shortfall (not VaR) is the primary basis because VaR is silent
about how bad the tail beyond it is; the worst stress loss acts as a
floor that can bind even when ES is small (e.g. a short horizon priced
during a quiet period) - collateral should reflect visible tail scenarios
even if the simulated distribution hasn't recently sampled one. See
`docs/risk_policy.md` for the full policy writeup and configuration
surface.

`required_collateral` always rounds *up* (`ROUND_CEILING`) at the
configured precision - a rounding error must never leave an escrow
under-collateralized relative to what the policy computed.

### Deterministic serialization (`serialization.py`)

Solidity has no floating point, so every financial value crossing the
Python/Solidity boundary is converted to a fixed-point integer (18
decimals, wei-style) via an explicit rounding mode - never a raw float or
bare `Decimal` repr, neither of which is guaranteed to round-trip
bit-for-bit. `riskSnapshotHash` (the audit hash `RiskQuoteVerifier.sol`'s
`RiskQuote` struct carries) is computed as `keccak256` (verified against
Ethereum's own `keccak256("")` test vector in
`tests/test_serialization.py` - not NIST SHA3-256, which uses different
padding) over a canonical JSON encoding of the full pricing snapshot:
sorted keys, every `Decimal` replaced by its fixed-point integer, every
float rejected outright (a raw float reaching the canonicalizer means some
financial value skipped `Decimal` handling upstream).

### RiskQuote (`quotes/risk_quote.py`)

Binds together everything that determined a price: asset, notional,
settlement horizon, spot price, model name/version, simulation method,
forecast volatility, VaR, Expected Shortfall, stress loss, collateral
ratio/buffer/required-collateral, creation/expiration timestamps, and the
risk-snapshot id/hash. `RiskQuote.to_onchain_fields(...)` maps this to
exactly the field set `RiskQuoteVerifier.sol`'s `RiskQuote` struct expects
(`contracts/RiskQuoteVerifier.sol`) - `depositor`/`counterparty` are
supplied by the caller at that point, not stored on the quote itself: the
risk engine prices a quote before it knows which two parties will use it,
matching the contract's own comment that `requiredCollateral` is priced
against the settlement horizon independent of quote acceptance. Signing
this quote with the oracle key `RiskEscrow.sol` already verifies is handled by
the signing layer (`signing/`); this section covers only the representation and its hash.

### Real ETH/USD results (as of this writing, spot ≈ $2,669, current
GARCH-filtered annualized vol ≈ 61%)

99% VaR / Expected Shortfall by horizon and method:

| horizon | historical sim (VaR / ES) | FHS (VaR / ES) | GBM benchmark (VaR / ES) |
|---------|---------------------------|----------------|--------------------------|
| 1d      | 12.9% / 17.4%             | 10.6% / 14.0%  | 7.1% / 8.1%              |
| 7d      | 29.5% / 36.3%             | 25.4% / 32.4%  | 17.3% / 19.6%            |
| 14d     | 37.4% / 42.5%             | 34.6% / 42.3%  | 23.3% / 26.3%            |
| 30d     | 48.4% / 53.9%             | 45.8% / 54.4%  | 31.6% / 35.5%            |

GBM materially under-prices tail risk at every horizon relative to both
historical simulation and FHS - exactly the gap that motivates using a
fat-tailed, time-varying-volatility method as the primary engine rather
than the i.i.d.-Normal benchmark. Reproduces via
`quant/scripts/run_risk_pipeline.py`.

Worst stress scenario by horizon: 1d -> 50% gap-down shock; 7d -> 51.8%
historical worst case (2020-03-06 to 2020-03-12, the COVID "Black
Thursday" crash); 14d and 30d -> 3x volatility shock (64.0% and 78.4%
respectively), overtaking the historical worst case once the horizon is
long enough for a parametrically-shocked-vol tail to exceed anything
actually realized in the (finite) history. For a 10 ETH notional at a 7-day
horizon this produces required collateral of ~15.18 ETH (ratio ≈ 1.52),
rising to ~17.84 ETH (ratio ≈ 1.78) at 30 days as both the FHS tail and the
worst stress scenario grow with horizon.

### Known limitations and judgment calls

- The FHS residual pool spans the full return history by default, which
  includes early (2016-2018) low-liquidity market structure alongside the
  more mature recent market. This trades representativeness of "today's"
  market for tail richness; `residual_pool_window` lets a caller trade
  that back if desired.
- Volatility-shock stress scenarios are priced via a parametric GBM ES at
  the shocked vol, not via re-running FHS with inflated variance. This is
  simpler and keeps "stress" scenarios interpretably separate from the
  "normal" FHS distribution, at the cost of not capturing FHS's fat-tailed
  residual shape under the shocked vol.
- Gap-down shock sizes (30%/50%) and vol-shock multipliers (2x/3x) are
  configured constants, not statistically derived - they represent
  plausible discontinuous events a continuous-path model cannot produce,
  not a calibrated probability.
- GBM's drift is set to the full-sample historical mean return for the
  benchmark comparison (long-run realized drift) but to zero for stress
  scenarios (conservative: a stress test should not rely on an assumed
  positive drift to offset the shock).
