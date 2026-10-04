#!/usr/bin/env python
"""Regenerates the result tables in docs/model_validation.md (and, once a
doc carries the same markers, that doc too) from a fresh run of the
functions `service/analytics.py` exposes to the dashboard - so published
numbers are reproducible from the pipeline rather than hand-copied, and
can't silently drift out of sync with what `/models` actually shows.

    cd quant && .venv/bin/python scripts/export_validation_report.py
    cd quant && .venv/bin/python scripts/export_validation_report.py --as-of 2026-10-02

`--as-of` slices the market data to that date first, so a report is
reproducible from a fixed point rather than drifting with "today" - the
GARCH fit used is a fresh one on that sliced window, written to a
throwaway directory (never `quant/model_state/`, which is the live
service's actual persisted state and must not be overwritten by running
a report).

Always writes the full computed report to
docs/generated/validation_report.json; markdown tables are only rewritten
in files that already contain the matching
`<!-- BEGIN GENERATED:name -->` / `<!-- END GENERATED:name -->` markers.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from askgene_quant.config import DEFAULT_VOLATILITY_SETTINGS
from askgene_quant.data.loader import load_market_data
from askgene_quant.data.quality import check_data_quality
from askgene_quant.data.returns import log_returns
from askgene_quant.models.pipeline import GarchVolatilityPipeline
from askgene_quant.models.store import ModelStateStore
from askgene_quant.service.analytics import (
    AnalyticsInputs,
    build_garch_view,
    build_tail_comparison,
    build_var_backtest,
    build_volatility_comparison,
)
from askgene_quant.volatility.garch import GARCHParams

REPO_ROOT = Path(__file__).resolve().parents[2]
GENERATED_JSON_PATH = REPO_ROOT / "docs" / "generated" / "validation_report.json"
MARKER_DOCS = [REPO_ROOT / "docs" / "model_validation.md", REPO_ROOT / "README.md"]


def load_inputs_as_of(as_of: datetime | None) -> AnalyticsInputs:
    """The same loading path as `service.analytics.load_analytics_inputs`,
    except the data is sliced to `as_of` first and the GARCH fit is fresh,
    written to a throwaway directory - never the live service's
    `quant/model_state/`."""
    ohlcv = load_market_data("ETH-USD")
    if as_of is not None:
        ohlcv = ohlcv.loc[ohlcv.index <= as_of]
    check_data_quality(ohlcv).raise_if_invalid()
    returns = log_returns(ohlcv["close"])
    spot = Decimal(str(ohlcv["close"].iloc[-1]))

    scratch_dir = Path(tempfile.mkdtemp(prefix="askgene-validation-report-"))
    try:
        store = ModelStateStore(base_dir=scratch_dir)
        pipeline = GarchVolatilityPipeline("ETH-USD", settings=DEFAULT_VOLATILITY_SETTINGS, store=store)
        state = pipeline.fit(returns.iloc[-DEFAULT_VOLATILITY_SETTINGS.garch_fitting_window :])
    finally:
        shutil.rmtree(scratch_dir, ignore_errors=True)

    params = GARCHParams(**state.fitted_params)
    fingerprint = (returns.index[-1].isoformat(), len(returns), state.fit_timestamp.isoformat())
    return AnalyticsInputs(
        asset="ETH-USD",
        ohlcv=ohlcv,
        returns=returns,
        spot=spot,
        state=state,
        params=params,
        settings=DEFAULT_VOLATILITY_SETTINGS,
        fingerprint=fingerprint,
    )


def _pct(x: float, digits: int = 2) -> str:
    return f"{x * 100:.{digits}f}%"


def render_volatility_comparison_table(metrics: dict[str, dict[str, float]]) -> str:
    labels = {"garch": "GARCH(1,1)", "ewma": "EWMA", "rolling_hist_vol": "Rolling historical"}
    order = sorted(metrics, key=lambda k: metrics[k]["rmse"])  # best RMSE first
    lines = [
        "| model              | RMSE (variance units) | QLIKE    |",
        "|--------------------|------------------------|----------|",
    ]
    for key in order:
        m = metrics[key]
        lines.append(f"| {labels.get(key, key):<18} | {m['rmse']:<22.6f} | {m['qlike']:<8.4f} |")
    return "\n".join(lines)


def render_var_backtest_table(results: list[dict]) -> str:
    lines = [
        "| confidence | n_obs | n_exceedances | exceedance rate | expected rate | Kupiec LR | p-value | reject at 5%? |",
        "|-----------:|------:|---------------:|-----------------:|---------------:|----------:|--------:|:---:|",
    ]
    for r in sorted(results, key=lambda r: r["confidence"]):
        k = r["kupiec"]
        lines.append(
            f"| {_pct(r['confidence'], 0):<10} | {k['n_obs']:<5,} | {k['n_exceedances']:<14} | "
            f"{_pct(k['exceedance_rate']):<16} | {_pct(k['expected_rate']):<14} | "
            f"{k['lr_statistic']:<9.3f} | {k['p_value']:<7.3f} | {'Yes' if k['reject_at_5pct'] else 'No':<3} |"
        )
    return "\n".join(lines)


def render_es_diagnostic_table(results: list[dict]) -> str:
    lines = [
        "| confidence | predicted ES | realized ES | ratio (realized / predicted) |",
        "|-----------:|-------------:|------------:|------------------------------:|",
    ]
    for r in sorted(results, key=lambda r: r["confidence"]):
        es = r["expected_shortfall"]
        realized = _pct(es["realized_es"]) if es["realized_es"] is not None else "n/a"
        ratio = f"{es['ratio']:.3f}" if es["ratio"] is not None else "n/a"
        lines.append(f"| {_pct(r['confidence'], 0):<10} | {_pct(es['predicted_es']):<12} | {realized:<11} | {ratio:<30} |")
    return "\n".join(lines)


def replace_marked_block(text: str, name: str, new_content: str) -> tuple[str, bool]:
    begin = f"<!-- BEGIN GENERATED:{name} -->"
    end = f"<!-- END GENERATED:{name} -->"
    pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.DOTALL)
    if not pattern.search(text):
        return text, False
    replacement_comment = "<!-- Regenerate with: cd quant && .venv/bin/python scripts/export_validation_report.py -->"
    replacement = f"{begin}\n{replacement_comment}\n{new_content}\n{end}"
    return pattern.sub(replacement, text), True


def update_doc(path: Path, blocks: dict[str, str]) -> list[str]:
    if not path.exists():
        return []
    text = path.read_text()
    updated_names = []
    for name, content in blocks.items():
        text, changed = replace_marked_block(text, name, content)
        if changed:
            updated_names.append(name)
    if updated_names:
        path.write_text(text)
    return updated_names


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", type=str, default=None, help="ISO date (YYYY-MM-DD) to slice data to")
    args = parser.parse_args()

    as_of = datetime.fromisoformat(args.as_of).replace(tzinfo=UTC) if args.as_of else None

    print(f"Loading ETH-USD data{f' as of {args.as_of}' if args.as_of else ''} and fitting GARCH(1,1)...")
    inputs = load_inputs_as_of(as_of)

    print("Running volatility model comparison...")
    vol_comparison = build_volatility_comparison(inputs)
    print("Running VaR/ES backtest...")
    var_backtest = build_var_backtest(inputs)
    print("Running tail-risk comparison...")
    tail_comparison = build_tail_comparison(inputs)
    print("Loading GARCH diagnostics...")
    garch_view = build_garch_view(inputs)

    report = {
        "generated_at": datetime.now(UTC).isoformat(),
        "as_of": args.as_of,
        "data_as_of": inputs.returns.index[-1].isoformat(),
        "n_returns": len(inputs.returns),
        "volatility_comparison": vol_comparison,
        "var_backtest": var_backtest,
        "tail_comparison": tail_comparison,
        "garch_view": garch_view,
    }

    GENERATED_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    GENERATED_JSON_PATH.write_text(json.dumps(report, indent=2, default=str))
    print(f"Wrote {GENERATED_JSON_PATH.relative_to(REPO_ROOT)}")

    blocks = {
        "volatility_comparison": render_volatility_comparison_table(vol_comparison["metrics"]),
        "var_backtest": render_var_backtest_table(var_backtest["results"]),
        "es_diagnostic": render_es_diagnostic_table(var_backtest["results"]),
    }

    for doc_path in MARKER_DOCS:
        updated = update_doc(doc_path, blocks)
        if updated:
            print(f"Updated {doc_path.relative_to(REPO_ROOT)}: {', '.join(updated)}")
        else:
            print(f"No generated-block markers found in {doc_path.relative_to(REPO_ROOT)}; left unchanged")


if __name__ == "__main__":
    main()
