# notebooks

Research notebooks only — nothing here is production logic; it all reads
from the `askgene_quant` package in `quant/`. Each notebook runs against
real ETH/USD daily data (Coinbase Exchange, cached under
`quant/data_cache/`) and is checked in with its outputs already executed.

- `01_returns_and_volatility.ipynb` — return distribution, fat tails,
  volatility clustering, realized vol vs. EWMA
- `02_garch_analysis.ipynb` — GARCH(1,1) fitting, conditional volatility,
  standardized-residual diagnostics, forecast term structure
- `04_model_validation.ipynb` — out-of-sample walk-forward comparison of
  rolling historical vol, EWMA, and GARCH(1,1) (RMSE/QLIKE)

To re-run one: `cd quant && source .venv/bin/activate && cd ../notebooks
&& jupyter nbconvert --to notebook --execute --inplace <name>.ipynb`
(requires the `quant[notebook]` optional dependencies).
