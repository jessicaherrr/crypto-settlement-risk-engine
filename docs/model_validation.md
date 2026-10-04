# Model Validation

Two parts: out-of-sample comparison of the three volatility estimators
(rolling historical, EWMA, GARCH(1,1)) against real ETH/USD data, and out-of-sample VaR/Expected Shortfall exceedance validation (Kupiec
test) built on top of those estimators (below).

Methodology (avoiding look-ahead bias) is documented in
`docs/methodology.md`; this file records results, which reproduce via
`notebooks/04_model_validation.ipynb` or `quant/scripts/run_pipeline.py`.

## Setup

- Asset: ETH-USD, daily, Coinbase Exchange
- Full sample: 2016-05-18 through present (~3,790 observations)
- Out-of-sample window: last ~30% of history (2023-08-23 through present,
  1,137 observations)
- GARCH: 750-day fitting window, refit every 21 observations
- EWMA: lambda = 0.94
- Rolling historical: 30-day window
- Proxy for realized variance: squared daily log return, `r_t^2`

## Results

<!-- BEGIN GENERATED:volatility_comparison -->
<!-- Regenerate with: cd quant && .venv/bin/python scripts/export_validation_report.py -->
| model              | RMSE (variance units) | QLIKE    |
|--------------------|------------------------|----------|
| GARCH(1,1)         | 0.002911               | -5.7498  |
| EWMA               | 0.002911               | -5.6799  |
| Rolling historical | 0.002931               | -5.6351  |
<!-- END GENERATED:volatility_comparison -->

(lower is better for both metrics)

## Interpretation

- GARCH(1,1) ranks best on both metrics, with the largest margin on
  QLIKE — consistent with it being the only estimator here with both a
  shock-reaction term (`alpha`) and a persistence/mean-reversion term
  (`beta`); EWMA has only persistence (and no mean reversion), and rolling
  historical has neither.
- The RMSE gap between models is small in absolute terms, which is
  expected: RMSE on raw variance is dominated by the handful of largest
  realized-variance days regardless of model, while QLIKE (which penalizes
  under-prediction and uses a log scale) more clearly separates reactive
  conditional-variance models from the rolling-window baseline.
- All three models track the broad level of realized variance; the
  qualitative difference (visible in the notebook) is that rolling
  historical volatility lags real shocks and exhibits step changes as old
  extreme observations exit its window, while EWMA and GARCH adapt within
  a day or two.

## Known limitation

GARCH MLE on short, shock-heavy fitting windows occasionally converges
to a near-integrated boundary solution (`alpha≈0, beta≈1`); see the
"Numerical stability note" in `docs/methodology.md` for how
`conditional_variance_path` stays numerically stable in that case. The
validation results above already reflect that fix. A production system
should additionally consider explicitly flagging/rejecting such boundary
refits rather than only guarding against the numerical blow-up.

## VaR / Expected Shortfall validation

This is risk-*model* validation — does the predicted loss distribution
match what actually happened — not trading-strategy backtesting; no
positions are taken or scored for profitability.

### Scope and methodology

Run at the **1-day horizon only**. The Kupiec unconditional-coverage test
assumes exceedance indicators are i.i.d. Bernoulli trials; the overlapping
multi-day windows a 7d/14d/30d VaR uses (`simulation/historical.py`,
`risk/engine.py`) make adjacent exceedance indicators highly dependent, so
running Kupiec at those horizons would produce a numerically well-defined
but statistically meaningless p-value. Multi-day horizons are sanity
checked qualitatively instead (simulated-vs-realized percentiles,
cross-method comparison — see `docs/methodology.md`'s results table), not
claimed to have a formal coverage test here.

No look-ahead bias: the walk-forward GARCH conditional-variance path is
the same no-look-ahead construction `garch_walk_forward_forecast`
uses (parameters fit once on the window preceding the out-of-sample
period, then only updated via the closed-form recursion as each day is
revealed). The VaR multiplier — the standardized-residual quantile
`z_q` — is estimated once from the pre-out-of-sample training window only,
so it never sees an out-of-sample observation either. `VaR_t = -(mu + z_q * sigma_t)`;
an exceedance is `return_t < -VaR_t`.

- Out-of-sample window: last ~30% of history, 1,137 observations
  (matching the volatility walk-forward split)
- `z_q`: `1 - confidence` quantile of standardized residuals from the
  pre-out-of-sample training window
- Expected Shortfall diagnostic: realized mean loss on exceedance days vs.
  the model's predicted ES on those same days

### Results

<!-- BEGIN GENERATED:var_backtest -->
<!-- Regenerate with: cd quant && .venv/bin/python scripts/export_validation_report.py -->
| confidence | n_obs | n_exceedances | exceedance rate | expected rate | Kupiec LR | p-value | reject at 5%? |
|-----------:|------:|---------------:|-----------------:|---------------:|----------:|--------:|:---:|
| 95%        | 1,137 | 57             | 5.01%            | 5.00%          | 0.000     | 0.984   | No  |
| 99%        | 1,137 | 8              | 0.70%            | 1.00%          | 1.125     | 0.289   | No  |
<!-- END GENERATED:var_backtest -->

Expected Shortfall diagnostic (realized vs. predicted mean loss on
exceedance days):

<!-- BEGIN GENERATED:es_diagnostic -->
<!-- Regenerate with: cd quant && .venv/bin/python scripts/export_validation_report.py -->
| confidence | predicted ES | realized ES | ratio (realized / predicted) |
|-----------:|-------------:|------------:|------------------------------:|
| 95%        | 7.93%        | 7.54%       | 0.952                          |
| 99%        | 14.06%       | 12.58%      | 0.895                          |
<!-- END GENERATED:es_diagnostic -->

Reproduces via `quant/scripts/run_risk_pipeline.py` (step 5) or
`askgene_quant.validation.var_backtest.walk_forward_var_backtest`.

### Interpretation

- Kupiec does not reject the null (observed exceedance rate matches the
  nominal rate) at either confidence level — the GARCH-filtered,
  empirical-quantile VaR is well-calibrated on this out-of-sample window,
  at the 1-day horizon.
- The ES ratio is below 1.0 at both confidence levels (0.956, 0.876): the
  model's predicted tail loss is somewhat larger than what was actually
  realized on exceedance days. That's the conservative direction for a
  collateral-sizing risk engine — it means ES-based collateral errs
  slightly toward over-collateralization rather than under.
- These results are for one out-of-sample window (the last ~30% of
  available ETH history) and one random seed where applicable; they
  describe this run, not a guarantee of future calibration. A production
  deployment should re-run this validation on a rolling basis as new data
  arrives, not treat it as a one-time certification.
