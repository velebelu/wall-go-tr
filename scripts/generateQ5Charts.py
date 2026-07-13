#!/usr/bin/env python3
"""Genera las gráficas finales de Q5 a partir de resultados existentes."""

from __future__ import annotations

import csv
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "wall-go-tr-matplotlib"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "data" / "graficas" / "q5"

CHECKPOINT_SOURCE = Path(
    "data/entrenamiento/q5/hybrid/evaluacion_1500_conservative_alpha/"
    "conservative_alpha_comparison_summary.json"
)
POLICY_SOURCE = Path(
    "data/entrenamiento/q5/hybrid/policy_comparison_checkpoint_1000/"
    "policy_comparison_summary.json"
)

MODEL_LABELS = {
    "q5_1000": "Q5-1000",
    "q5_1500": "Q5-1500 normal",
    "q5_1500_conservative_alpha": "Q5-1500 conservadora",
}
MODEL_ORDER = list(MODEL_LABELS)
POLICY_LABELS = {
    "minConfidence10_margin0.50": "10/0.50",
    "minConfidence5_margin0.50": "5/0.50",
    "minConfidence5_margin0.25": "5/0.25",
}
POLICY_ORDER = list(POLICY_LABELS)

EXPECTED = {
    "entries": [27815, 31244, 31435],
    "territory_diff": [-0.768, -1.928, -1.262],
    "q_decision_pct": [8.0809, 5.0752, 6.4117],
    "override_win_rate": [48.5232, 43.75, 47.4576],
}

COLORS = ["#4C78A8", "#72A0C1", "#A9BBC7"]
POLICY_COLORS = ["#4C78A8", "#7A9E7E", "#B07C62"]


@dataclass
class CsvRow:
    chart: str
    series: str
    category: str
    value: float | int
    unit: str
    policy: str
    source_file: str
    source_field: str


def load_json(relative_path: Path) -> dict[str, Any]:
    path = ROOT / relative_path
    if not path.is_file():
        raise FileNotFoundError(f"No se encuentra el resultado requerido: {path}")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def assert_close(name: str, actual: list[float | int], expected: list[float | int]) -> None:
    if len(actual) != len(expected) or any(
        not np.isclose(float(a), float(e), rtol=0, atol=1e-9)
        for a, e in zip(actual, expected)
    ):
        raise ValueError(f"Validación fallida para {name}: {actual} != {expected}")


def configure_style() -> None:
    plt.rcParams.update(
        {
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "axes.edgecolor": "#555555",
            "axes.labelcolor": "#222222",
            "axes.titleweight": "normal",
            "font.size": 9.5,
            "axes.titlesize": 12,
            "axes.labelsize": 10,
            "xtick.color": "#333333",
            "ytick.color": "#333333",
            "grid.color": "#D9D9D9",
            "grid.linewidth": 0.7,
        }
    )


def format_es(value: float | int, decimals: int = 1, integer: bool = False) -> str:
    if integer:
        return f"{int(value):,}".replace(",", ".")
    return f"{float(value):.{decimals}f}".replace(".", ",")


def label_bars(ax: plt.Axes, bars: Any, formatter: Any, padding: int = 3) -> None:
    ax.bar_label(bars, labels=[formatter(bar.get_height()) for bar in bars], padding=padding, fontsize=8.5)


def finish(ax: plt.Axes, filename: str, legend: bool = False) -> None:
    ax.spines[["top", "right"]].set_visible(False)
    ax.yaxis.grid(True)
    ax.set_axisbelow(True)
    if legend:
        ax.legend(frameon=False, ncols=2, loc="upper center")
    ax.figure.tight_layout()
    ax.figure.savefig(OUTPUT_DIR / filename, dpi=300, bbox_inches="tight", facecolor="white")
    plt.close(ax.figure)


def simple_bar(
    filename: str,
    title: str,
    ylabel: str,
    labels: list[str],
    values: list[float | int],
    formatter: Any,
    colors: list[str],
    zero_line: bool = False,
) -> None:
    fig, ax = plt.subplots(figsize=(7.2, 4.5))
    x = np.arange(len(labels))
    bars = ax.bar(x, values, width=0.62, color=colors, edgecolor="#444444", linewidth=0.5)
    ax.set_title(title, pad=12)
    ax.set_ylabel(ylabel)
    ax.set_xticks(x, labels)
    margin = max(abs(float(v)) for v in values) * 0.16 if values else 1
    if zero_line:
        ax.axhline(0, color="#555555", linewidth=0.9)
        ax.set_ylim(min(float(v) for v in values) - margin, max(0, max(float(v) for v in values) + margin))
    else:
        ax.set_ylim(0, max(float(v) for v in values) + margin)
    label_bars(ax, bars, formatter)
    finish(ax, filename)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    configure_style()

    checkpoint_data = load_json(CHECKPOINT_SOURCE)
    policy_data = load_json(POLICY_SOURCE)

    combinations = {item["table"]: item for item in checkpoint_data["combinations"]}
    qtables = {item["label"]: item for item in checkpoint_data["qTables"]}
    policies = {item["policy"]["label"]: item for item in policy_data["policies"]}

    missing_models = set(MODEL_ORDER) - combinations.keys()
    missing_policies = set(POLICY_ORDER) - policies.keys()
    if missing_models or missing_policies:
        raise ValueError(
            f"Resultados incompletos. Modelos ausentes: {sorted(missing_models)}; "
            f"políticas ausentes: {sorted(missing_policies)}"
        )

    entries = [qtables[key]["qTableEntries"] for key in MODEL_ORDER]
    territory = [combinations[key]["byRival"]["heuristic"]["averageTerritorialDiff"] for key in MODEL_ORDER]
    q_pct = [combinations[key]["byRival"]["heuristic"]["decisionPercentages"]["qFinalDecisions"] for key in MODEL_ORDER]
    override_win = [combinations[key]["byRival"]["heuristic"]["overrideGames"]["winRate"] for key in MODEL_ORDER]
    assert_close("entradas de tabla Q", entries, EXPECTED["entries"])
    assert_close("diferencia territorial", territory, EXPECTED["territory_diff"])
    assert_close("porcentaje de decisiones Q", q_pct, EXPECTED["q_decision_pct"])
    assert_close("victorias con sustituciones", override_win, EXPECTED["override_win_rate"])

    rows: list[CsvRow] = []
    source_checkpoint = CHECKPOINT_SOURCE.as_posix()
    source_policy = POLICY_SOURCE.as_posix()
    model_labels = [MODEL_LABELS[key] for key in MODEL_ORDER]
    policy_labels = [POLICY_LABELS[key] for key in POLICY_ORDER]

    # 01: porcentaje de victorias por rival y checkpoint (política 5/0.25).
    fig, ax = plt.subplots(figsize=(7.2, 4.5))
    x = np.arange(len(model_labels))
    width = 0.34
    for index, (rival, rival_label) in enumerate((("random", "Aleatorio"), ("heuristic", "Heurístico"))):
        values = [combinations[key]["byRival"][rival]["winRate"] for key in MODEL_ORDER]
        bars = ax.bar(x + (index - 0.5) * width, values, width, label=rival_label, color=COLORS[index], edgecolor="#444444", linewidth=0.5)
        label_bars(ax, bars, lambda value: f"{format_es(value, 1)} %")
        for key, label, value in zip(MODEL_ORDER, model_labels, values):
            rows.append(CsvRow("01_win_rate_by_opponent.png", rival_label, label, value, "%", "5/0.25", source_checkpoint, f"combinations[{key}].byRival.{rival}.winRate"))
    ax.set_title("Porcentaje de victorias por rival", pad=12)
    ax.set_ylabel("Victorias (%)")
    ax.set_xlabel("Checkpoint")
    ax.set_xticks(x, model_labels)
    ax.set_ylim(0, 112)
    finish(ax, "01_win_rate_by_opponent.png", legend=True)

    # 02 y 03: comparación de políticas sobre Q5-1000 contra heuristic.
    policy_win = [policies[key]["byRival"]["heuristic"]["winRate"] for key in POLICY_ORDER]
    policy_overrides = [policies[key]["byRival"]["heuristic"]["decisions"]["qOverridesAccepted"] for key in POLICY_ORDER]
    for key, label, value in zip(POLICY_ORDER, policy_labels, policy_win):
        rows.append(CsvRow("02_policy_win_rate.png", "Q5-1000 contra heurístico", label, value, "%", label, source_policy, f"policies[{key}].byRival.heuristic.winRate"))
    simple_bar("02_policy_win_rate.png", "Victorias por política contra el rival heurístico", "Victorias (%)", policy_labels, policy_win, lambda value: f"{format_es(value, 1)} %", POLICY_COLORS)

    for key, label, value in zip(POLICY_ORDER, policy_labels, policy_overrides):
        rows.append(CsvRow("03_policy_q_overrides.png", "Q5-1000 contra heurístico", label, value, "sustituciones", label, source_policy, f"policies[{key}].byRival.heuristic.decisions.qOverridesAccepted"))
    simple_bar("03_policy_q_overrides.png", "Sustituciones Q por política contra el rival heurístico", "Sustituciones Q aceptadas", policy_labels, policy_overrides, lambda value: format_es(value, integer=True), POLICY_COLORS)

    # 04-07: métricas comparables de checkpoints bajo la política 5/0.25.
    metrics = [
        ("04_qtable_growth.png", "Entradas de la tabla Q", "Número de entradas", entries, "entradas", "qTables[{key}].qTableEntries", lambda value: format_es(value, integer=True), False),
        ("05_territory_difference_heuristic.png", "Diferencia territorial media contra el rival heurístico", "Territorio Q5 − territorio rival", territory, "territorio", "combinations[{key}].byRival.heuristic.averageTerritorialDiff", lambda value: format_es(value, 3), True),
        ("06_q_decision_percentage.png", "Decisiones finales tomadas por Q contra el rival heurístico", "Decisiones Q (%)", q_pct, "%", "combinations[{key}].byRival.heuristic.decisionPercentages.qFinalDecisions", lambda value: f"{format_es(value, 4)} %", False),
        ("07_override_win_rate.png", "Victorias en partidas con sustituciones Q", "Victorias (%)", override_win, "%", "combinations[{key}].byRival.heuristic.overrideGames.winRate", lambda value: f"{format_es(value, 4)} %", False),
    ]
    for filename, title, ylabel, values, unit, field, formatter, zero_line in metrics:
        for key, label, value in zip(MODEL_ORDER, model_labels, values):
            rows.append(CsvRow(filename, "Contra heurístico", label, value, unit, "5/0.25", source_checkpoint, field.format(key=key)))
        simple_bar(filename, title, ylabel, model_labels, values, formatter, COLORS, zero_line)

    csv_path = OUTPUT_DIR / "chart_data.csv"
    with csv_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(CsvRow.__annotations__))
        writer.writeheader()
        writer.writerows(row.__dict__ for row in rows)

    readme = f"""# Gráficas finales de Q5

Estas gráficas se generan con `python scripts/generateQ5Charts.py`. El script lee
los resultados existentes, valida las métricas indicadas y escribe las imágenes
a 300 dpi, junto con `chart_data.csv`. No modifica tablas Q ni resultados de
entrenamiento.

## Gráficas

1. **`01_win_rate_by_opponent.png`**: porcentaje de victorias de Q5-1000,
   Q5-1500 normal y Q5-1500 conservadora contra los rivales aleatorio y
   heurístico, bajo la política 5/0.25.
2. **`02_policy_win_rate.png`**: porcentaje de victorias de Q5-1000 contra el
   rival heurístico para las políticas 10/0.50, 5/0.50 y 5/0.25.
3. **`03_policy_q_overrides.png`**: número de decisiones en las que la propuesta
   Q sustituye a la heurística, para esas tres políticas y contra el rival
   heurístico.
4. **`04_qtable_growth.png`**: número de entradas de cada tabla Q.
5. **`05_territory_difference_heuristic.png`**: diferencia media entre el
   territorio de Q5 y el del rival heurístico, bajo la política 5/0.25.
6. **`06_q_decision_percentage.png`**: porcentaje de decisiones finales tomadas
   por Q contra el rival heurístico, bajo la política 5/0.25.
7. **`07_override_win_rate.png`**: porcentaje de victorias entre las partidas
   que tuvieron al menos una sustitución Q contra el rival heurístico, bajo la
   política 5/0.25.

## Procedencia

- Gráficas 01 y 04-07: `{source_checkpoint}`. Los valores proceden de
  `qTables[].qTableEntries` y de `combinations[].byRival` para la política
  `minConfidence5_margin0.25`.
- Gráficas 02 y 03: `{source_policy}`. Los valores proceden de
  `policies[].byRival.heuristic.winRate` y
  `policies[].byRival.heuristic.decisions.qOverridesAccepted`.
- `chart_data.csv` contiene cada valor representado, su unidad, política,
  archivo fuente y ruta del campo JSON.

La política 5/0.25 de las gráficas comparativas de checkpoints es la única
evaluada de forma homogénea para los tres modelos en el archivo de comparación.
Esto no cambia la selección final documentada: Q5-1000 con política 10/0.50.
"""
    (OUTPUT_DIR / "README.md").write_text(readme, encoding="utf-8")

    print(f"Generadas 7 gráficas, chart_data.csv y README.md en {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
