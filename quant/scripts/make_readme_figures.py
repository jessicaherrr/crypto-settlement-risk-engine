"""Render the README figures from docs/generated/validation_report.json.

Run export_validation_report.py first so the figures match the published tables:

    cd quant && .venv/bin/python scripts/export_validation_report.py
    cd quant && .venv/bin/python scripts/make_readme_figures.py
"""

import json
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
REPORT_PATH = REPO_ROOT / "docs" / "generated" / "validation_report.json"
OUT_DIR = REPO_ROOT / "docs" / "images"

INK = "#1f2937"
MUTED = "#6b7280"
GRID = "#e5e7eb"
BLUE = "#2563eb"
ORANGE = "#ea580c"
GRAY = "#9ca3af"
RED = "#dc2626"


def _style(ax):
    ax.spines[["top", "right"]].set_visible(False)
    ax.spines[["left", "bottom"]].set_color(GRID)
    ax.tick_params(colors=MUTED, labelsize=9)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def _dates(rows):
    return [date.fromisoformat(r["date"][:10]) for r in rows]


def garch_volatility(report):
    rows = report["garch_view"]["vol_history"]
    x = _dates(rows)
    fig, ax = plt.subplots(figsize=(8, 3.4), dpi=150)
    ax.plot(x, [r["conditional_vol"] * 100 for r in rows], color=BLUE, lw=1.6, label="GARCH(1,1) conditional volatility")
    ax.plot(x, [r["realized_vol_30d"] * 100 for r in rows], color=GRAY, lw=1.2, label="30-day realized volatility")
    ax.set_ylabel("Annualized volatility (%)", color=MUTED, fontsize=9)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
    ax.set_title("ETH/USD volatility, last 365 days", loc="left", color=INK, fontsize=11)
    ax.legend(frameon=False, fontsize=8.5, loc="upper left")
    _style(ax)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "garch_volatility.png")
    plt.close(fig)


def var_backtest(report):
    rows = report["var_backtest"]["series"]
    x = _dates(rows)
    returns = [r["return"] * 100 for r in rows]
    fig, ax = plt.subplots(figsize=(8, 3.4), dpi=150)
    ax.bar(x, returns, width=1.0, color=GRAY, label="Daily log return")
    ax.plot(x, [-r["var_loss"] * 100 for r in rows], color=BLUE, lw=1.3, label="99% one-day VaR (FHS)")
    hits = [(d, r) for d, r, row in zip(x, returns, rows) if row["exceed"]]
    ax.scatter([d for d, _ in hits], [r for _, r in hits], color=RED, s=18, zorder=3, label=f"Exceedances ({len(hits)} of {len(rows)})")
    ax.set_ylabel("Return (%)", color=MUTED, fontsize=9)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
    ax.set_title("Out-of-sample 99% VaR backtest", loc="left", color=INK, fontsize=11)
    ax.legend(frameon=False, fontsize=8.5, loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=3)
    _style(ax)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "var_backtest.png")
    plt.close(fig)


def tail_comparison(report):
    rows = report["tail_comparison"]["rows"]
    horizons = sorted({r["horizon_days"] for r in rows})
    methods = [
        ("historical_simulation", "Historical Simulation", GRAY),
        ("filtered_historical_simulation", "Filtered Historical Simulation", BLUE),
        ("gbm_monte_carlo", "GBM benchmark", ORANGE),
    ]
    width = 0.26
    fig, ax = plt.subplots(figsize=(8, 3.4), dpi=150)
    for i, (key, label, color) in enumerate(methods):
        values = [
            float(next(r for r in rows if r["method"] == key and r["horizon_days"] == h)["expected_shortfall"]["0.9900"]) * 100
            for h in horizons
        ]
        pos = [j + (i - 1) * width for j in range(len(horizons))]
        ax.bar(pos, values, width=width, color=color, label=label)
    ax.set_xticks(range(len(horizons)), [f"{h}-day" for h in horizons])
    ax.set_ylabel("99% Expected Shortfall (% of notional)", color=MUTED, fontsize=9)
    ax.set_title("Tail loss by method and settlement horizon", loc="left", color=INK, fontsize=11)
    ax.legend(frameon=False, fontsize=8.5, loc="upper left")
    _style(ax)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "tail_comparison.png")
    plt.close(fig)


def main() -> None:
    report = json.loads(REPORT_PATH.read_text())
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    garch_volatility(report)
    var_backtest(report)
    tail_comparison(report)
    print(f"Wrote figures to {OUT_DIR.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
