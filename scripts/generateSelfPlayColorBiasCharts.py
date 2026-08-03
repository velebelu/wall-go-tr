#!/usr/bin/env python3
"""Genera las gráficas del experimento de autoenfrentamiento MCTS (sesgo de color)."""

from __future__ import annotations

import csv
import json
import os
import statistics
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "wall-go-tr-matplotlib"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIR = ROOT / "data" / "mcts-selfplay" / "final-2026-color-bias-v1"

RED = "#c0392b"
BLUE = "#2456a6"
GREY = "#7f8c8d"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def save(fig, output_dir: Path, name: str) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for extension in ("svg", "png"):
        fig.savefig(output_dir / f"{name}.{extension}", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print(f"  {name}.svg / {name}.png")


def chart_wins(summary: dict, output_dir: Path) -> None:
    outcomes = summary["outcomes"]
    labels = ["Rojo", "Azul", "Empates"]
    values = [outcomes["redWins"], outcomes["blueWins"], outcomes["ties"]]
    fig, axes = plt.subplots(figsize=(6.4, 4.2))
    bars = axes.bar(labels, values, color=[RED, BLUE, GREY], width=0.6)
    total = outcomes["games"]
    for bar, value in zip(bars, values):
        axes.annotate(
            f"{value}\n({100 * value / total:.1f} %)".replace(".", ","),
            (bar.get_x() + bar.get_width() / 2, value),
            textcoords="offset points",
            xytext=(0, 4),
            ha="center",
            fontsize=10,
        )
    axes.axhline(total / 2, color="black", linestyle="--", linewidth=1, label="Reparto 50/50")
    axes.set_ylabel("Partidas")
    axes.set_title(f"Reparto de victorias en {total} partidas MCTS contra MCTS")
    axes.set_ylim(0, max(values + [total / 2]) * 1.25)
    axes.legend(loc="upper right", fontsize=9)
    axes.yaxis.set_major_locator(MaxNLocator(integer=True))
    axes.spines[["top", "right"]].set_visible(False)
    save(fig, output_dir, "victorias-por-color")


def chart_territory(summary: dict, results: list[dict[str, str]], output_dir: Path) -> None:
    red = [float(row["territoryRed"]) for row in results]
    blue = [float(row["territoryBlue"]) for row in results]
    means = [statistics.fmean(red), statistics.fmean(blue)]
    deviations = [statistics.stdev(red), statistics.stdev(blue)]
    fig, axes = plt.subplots(figsize=(6.4, 4.2))
    bars = axes.bar(
        ["Rojo", "Azul"], means, yerr=deviations, capsize=8, color=[RED, BLUE], width=0.5
    )
    for bar, value in zip(bars, means):
        axes.annotate(
            f"{value:.2f}".replace(".", ","),
            (bar.get_x() + bar.get_width() / 2, value),
            textcoords="offset points",
            xytext=(0, 4),
            ha="center",
            fontsize=10,
        )
    axes.set_ylabel("Casillas de territorio")
    axes.set_title("Territorio medio por color (barras de error: desviación típica)")
    axes.spines[["top", "right"]].set_visible(False)
    save(fig, output_dir, "territorio-medio-por-color")


def chart_territory_distribution(results: list[dict[str, str]], output_dir: Path) -> None:
    diffs = [int(row["territoryDiff"]) for row in results]
    fig, axes = plt.subplots(figsize=(7.2, 4.2))
    axes.hist(
        diffs,
        bins=range(min(diffs), max(diffs) + 2),
        color="#4a6fa5",
        edgecolor="white",
        align="left",
    )
    axes.axvline(0, color="black", linestyle="--", linewidth=1, label="Empate territorial")
    average = statistics.fmean(diffs)
    axes.axvline(
        average,
        color=RED if average >= 0 else BLUE,
        linewidth=2,
        label=f"Media = {average:.2f}".replace(".", ","),
    )
    axes.set_xlabel("Diferencia de territorio (rojo − azul)")
    axes.set_ylabel("Partidas")
    axes.yaxis.set_major_locator(MaxNLocator(integer=True))
    axes.set_title("Distribución de la diferencia territorial")
    axes.legend(fontsize=9)
    axes.spines[["top", "right"]].set_visible(False)
    save(fig, output_dir, "distribucion-diferencia-territorial")


def chart_pairs(summary: dict, pairs: list[dict[str, str]], output_dir: Path) -> None:
    scores = [float(row["pairRedScore"]) for row in pairs]
    buckets = [0.0, 0.25, 0.5, 0.75, 1.0]
    counts = [sum(1 for score in scores if abs(score - bucket) < 1e-9) for bucket in buckets]
    fig, axes = plt.subplots(1, 2, figsize=(11.5, 4.2))

    bars = axes[0].bar(
        [f"{bucket:.2f}".replace(".", ",") for bucket in buckets],
        counts,
        color=["#2456a6", "#6f8fc4", GREY, "#d98880", RED],
        width=0.65,
    )
    for bar, value in zip(bars, counts):
        if value:
            axes[0].annotate(
                str(value),
                (bar.get_x() + bar.get_width() / 2, value),
                textcoords="offset points",
                xytext=(0, 4),
                ha="center",
                fontsize=10,
            )
    axes[0].set_xlabel("Puntuación de rojo en la pareja (0 = azul gana las dos)")
    axes[0].set_ylabel("Parejas")
    axes[0].yaxis.set_major_locator(MaxNLocator(integer=True))
    axes[0].set_title("Resultado emparejado por color")
    axes[0].spines[["top", "right"]].set_visible(False)

    direct = [int(row["directTerritoryDiff"]) for row in pairs]
    swapped = [int(row["swappedTerritoryDiff"]) for row in pairs]
    axes[1].axhline(0, color=GREY, linewidth=0.8)
    axes[1].axvline(0, color=GREY, linewidth=0.8)
    axes[1].scatter(direct, swapped, s=26, alpha=0.7, color="#4a6fa5", edgecolor="white")
    limit = max(max(map(abs, direct)), max(map(abs, swapped))) + 2
    axes[1].plot([-limit, limit], [limit, -limit], color="black", linestyle="--", linewidth=1)
    axes[1].set_xlim(-limit, limit)
    axes[1].set_ylim(-limit, limit)
    axes[1].set_xlabel("Diferencia territorial, partida directa")
    axes[1].set_ylabel("Diferencia territorial, partida intercambiada")
    axes[1].set_title("Las dos partidas de cada pareja")
    axes[1].spines[["top", "right"]].set_visible(False)

    control = summary["inference"]["seedStreamControl"]
    fig.suptitle(
        "Control de aleatoriedad: puntuación media del flujo alfa = "
        f"{control['mean']:.3f}".replace(".", ","),
        fontsize=10,
        y=1.02,
    )
    save(fig, output_dir, "resultados-emparejados")


def main() -> int:
    directory = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DIR
    summary = json.loads((directory / "summary.json").read_text(encoding="utf-8"))
    results = read_csv(directory / "results.csv")
    pairs = read_csv(directory / "pairs.csv")
    output_dir = directory / "graficas"
    print(f"Gráficas en {output_dir}:")
    chart_wins(summary, output_dir)
    chart_territory(summary, results, output_dir)
    chart_territory_distribution(results, output_dir)
    chart_pairs(summary, pairs, output_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
