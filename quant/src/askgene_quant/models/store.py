"""JSON-on-disk persistence for `ModelState`.

Layout under ``base_dir``::

    {asset}__{model_name}/
        latest.json              # current state, overwritten on every save
        history/
            {fit_timestamp}.json # one snapshot per fit/refit (audit trail)

``latest.json`` is what an online pipeline reloads on restart. The
``history/`` snapshots are written only when a state results from a fit
(not a plain recursive update), so they record how parameters evolved
across refits without growing one file per observation.
"""

from __future__ import annotations

from pathlib import Path

from askgene_quant.config import DEFAULT_MODEL_STATE_DIR
from askgene_quant.models.state import ModelState


class ModelStateStore:
    def __init__(self, base_dir: Path = DEFAULT_MODEL_STATE_DIR):
        self.base_dir = Path(base_dir)

    def _dir(self, asset: str, model_name: str) -> Path:
        key = f"{asset}__{model_name}".replace("/", "_")
        return self.base_dir / key

    def save(self, state: ModelState, *, record_history: bool = False) -> Path:
        state_dir = self._dir(state.asset, state.model_name)
        state_dir.mkdir(parents=True, exist_ok=True)

        latest_path = state_dir / "latest.json"
        latest_path.write_text(state.model_dump_json(indent=2))

        if record_history:
            history_dir = state_dir / "history"
            history_dir.mkdir(parents=True, exist_ok=True)
            ts = state.fit_timestamp.strftime("%Y%m%dT%H%M%S")
            (history_dir / f"{ts}.json").write_text(state.model_dump_json(indent=2))

        return latest_path

    def load(self, asset: str, model_name: str) -> ModelState | None:
        path = self._dir(asset, model_name) / "latest.json"
        if not path.exists():
            return None
        return ModelState.model_validate_json(path.read_text())

    def load_history(self, asset: str, model_name: str) -> list[ModelState]:
        history_dir = self._dir(asset, model_name) / "history"
        if not history_dir.exists():
            return []
        states = [
            ModelState.model_validate_json(p.read_text())
            for p in sorted(history_dir.glob("*.json"))
        ]
        return states
