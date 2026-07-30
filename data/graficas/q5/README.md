# Gráficas finales de Q5

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

- Gráficas 01 y 04-07: `data/entrenamiento/q5/hybrid/evaluacion_1500_conservative_alpha/conservative_alpha_comparison_summary.json`. Los valores proceden de
  `qTables[].qTableEntries` y de `combinations[].byRival` para la política
  `minConfidence5_margin0.25`.
- Gráficas 02 y 03: `data/entrenamiento/q5/hybrid/policy_comparison_checkpoint_1000/policy_comparison_summary.json`. Los valores proceden de
  `policies[].byRival.heuristic.winRate` y
  `policies[].byRival.heuristic.decisions.qOverridesAccepted`.
- `chart_data.csv` contiene cada valor representado, su unidad, política,
  archivo fuente y ruta del campo JSON.

La política 5/0.25 de las gráficas comparativas de checkpoints es la única
evaluada de forma homogénea para los tres modelos en el archivo de comparación.
Esto no cambia la selección final documentada: Q5-1000 con política 10/0.50.
