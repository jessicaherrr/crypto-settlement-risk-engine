"""End-to-end Phase C pipeline runner for ETH/USD.

historical data -> quality checks -> log returns -> fit GARCH(1,1)
-> save model state -> simulate online updates -> out-of-sample
validation (rolling historical vol vs EWMA vs GARCH, RMSE/QLIKE).

Usage:
    python scripts/run_pipeline.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np
import pandas as pd

from askgene_quant.config import DEFAULT_VOLATILITY_SETTINGS
from askgene_quant.data.loader import load_market_data
from askgene_quant.data.quality import check_data_quality
from askgene_quant.data.returns import log_returns
from askgene_quant.models.pipeline import GarchVolatilityPipeline
from askgene_quant.models.store import ModelStateStore
from askgene_quant.validation.backtest import run_volatility_backtest
from askgene_quant.volatility.ewma import EWMAVolatility
from askgene_quant.volatility.realized import rolling_volatility

ASSET = "ETH-USD"


def main() -> None:
    print(f"=== Phase C pipeline: {ASSET} ===\n")

    print("[1/6] Loading market data (Coinbase Exchange, daily)...")
    ohlcv = load_market_data(ASSET)
    print(f"  {len(ohlcv)} daily candles, {ohlcv.index.min().date()} -> {ohlcv.index.max().date()}")

    print("\n[2/6] Running data-quality checks...")
    report = check_data_quality(ohlcv)
    print(f"  errors: {report.errors or 'none'}")
    print(f"  warnings: {len(report.warnings)}")
    for w in report.warnings[:5]:
        print(f"    - {w}")
    report.raise_if_invalid()

    print("\n[3/6] Computing log returns...")
    returns = log_returns(ohlcv["close"])
    print(f"  {len(returns)} returns")
    print(f"  mean={returns.mean():.6f}  std={returns.std():.6f}  "
          f"skew={returns.skew():.3f}  kurtosis={returns.kurtosis():.3f}")

    settings = DEFAULT_VOLATILITY_SETTINGS
    print(f"\n[4/6] Fitting GARCH(1,1) on trailing {settings.garch_fitting_window} obs "
          f"and realized/EWMA vol...")

    fit_window = returns.iloc[-settings.garch_fitting_window:]
    store = ModelStateStore()
    pipeline = GarchVolatilityPipeline(ASSET, settings=settings, store=store)
    state = pipeline.fit(fit_window)
    print(f"  fitted params: {state.fitted_params}")
    print(f"  persistence (alpha+beta): "
          f"{state.fitted_params['alpha'] + state.fitted_params['beta']:.4f}")
    print(f"  converged: {bool(state.fit_diagnostics['converged'])}, "
          f"log-likelihood: {state.fit_diagnostics['log_likelihood']:.2f}")
    print(f"  state saved under: {store.base_dir}")

    current_annualized_garch_vol = np.sqrt(
        state.latest_conditional_variance * settings.periods_per_year
    )
    realized_vol = rolling_volatility(returns, settings.realized_window).iloc[-1]
    ewma = EWMAVolatility(lam=settings.ewma_lambda).seed(returns)
    ewma_vol = ewma.volatility(periods_per_year=settings.periods_per_year)

    print(f"\n  current annualized vol estimates:")
    print(f"    rolling {settings.realized_window}d historical: {realized_vol:.1%}")
    print(f"    EWMA (lambda={settings.ewma_lambda}):            {ewma_vol:.1%}")
    print(f"    GARCH(1,1):                           {current_annualized_garch_vol:.1%}")

    print(f"\n[5/6] Simulating 10 online updates (no refit)...")
    tail = returns.iloc[-10:]
    pre_update_variance = pipeline.state.latest_conditional_variance
    for ts, r in tail.items():
        new_var = pipeline.update(float(r), ts.to_pydatetime())
    print(f"  conditional variance: {pre_update_variance:.8f} -> {new_var:.8f}")
    print(f"  pipeline.should_refit() after 10 updates "
          f"(refit_frequency={settings.garch_refit_frequency}): {pipeline.should_refit()}")

    print(f"\n[6/6] Out-of-sample validation "
          f"(rolling hist vol vs EWMA vs GARCH, walk-forward, no look-ahead)...")
    result = run_volatility_backtest(returns, settings=settings, oos_fraction=0.3)
    print(f"  OOS period: {result.oos_start.date()} -> {result.oos_end.date()} "
          f"({result.n_oos} obs)")
    print(f"  {'model':<18}{'RMSE (var)':>14}{'QLIKE':>12}")
    for model, m in sorted(result.metrics.items(), key=lambda kv: kv[1]["qlike"]):
        print(f"  {model:<18}{m['rmse']:>14.3e}{m['qlike']:>12.4f}")

    out_path = Path(__file__).resolve().parents[1] / "data_cache" / "validation_forecasts.parquet"
    result.forecasts.to_parquet(out_path)
    print(f"\n  forecasts saved to {out_path}")

    print("\nDone.")


if __name__ == "__main__":
    main()
