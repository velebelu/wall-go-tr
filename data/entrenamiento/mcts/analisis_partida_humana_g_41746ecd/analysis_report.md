# Análisis diagnóstico humano–MCTS: g_41746ecd

> Las señales identifican decisiones para revisión posterior. No demuestran que una acción sea errónea.

## Replay

- Correcto: **sí**
- Decisiones reproducidas: 34

## Resultado

- Resultado: ganador B
- Territorio final: R 9 – B 37
- Decisiones totales: 34
- Decisiones humanas: 17
- Decisiones MCTS: 17
- Tiempo MCTS medio: 562.5294 ms
- Tiempo MCTS máximo: 979.4 ms
- Cambios tácticos: 11
- Baja confianza: 14
- Posibles decisiones críticas: 11

## Umbrales

```json
{
  "lowConfidenceMaxVisitGap": 1,
  "lowConfidenceMaxValueGap": 0.1,
  "lowConfidenceMaxSelectedVisitShare": 0.12,
  "largeScoreChange": 10,
  "territorySwing": 5,
  "accessibleTerritorySwing": 5,
  "ownMobilityDrop": 4,
  "opponentMobilityGain": 4,
  "trappedPiecesIncrease": 1,
  "highSearchTimeMs": 750,
  "highVerificationTimeMs": 125,
  "criticalSignalCount": 2
}
```

## Cinco decisiones mejor clasificadas

### 1. Turno 3 (decisión MCTS 1)

- Relevancia: 8
- Categorías: tactical-change, low-confidence, large-score-change, high-cost, possible-critical-decision
- Motivos:
  - La verificación táctica cambió la acción inicialmente seleccionada.
  - Margen reducido: visitas=2, valor=-0.1714, cuota elegida=0.1.
  - La puntuación verificada cambió 10 puntos.
  - Coste alto: búsqueda=816.5 ms, verificación=141.1 ms.
  - Combina 4 señales diagnósticas.

### 2. Turno 6 (decisión MCTS 3)

- Relevancia: 5.6
- Categorías: tactical-change, low-confidence, high-cost, possible-critical-decision
- Motivos:
  - La verificación táctica cambió la acción inicialmente seleccionada.
  - Margen reducido: visitas=1, valor=0.1429, cuota elegida=0.12.
  - Coste alto: búsqueda=752.5 ms, verificación=143.1 ms.
  - Combina 3 señales diagnósticas.

### 3. Turno 10 (decisión MCTS 5)

- Relevancia: 4.8
- Categorías: tactical-change, low-confidence, possible-critical-decision
- Motivos:
  - La verificación táctica cambió la acción inicialmente seleccionada.
  - Margen reducido: visitas=0, valor=0.2857, cuota elegida=0.14.
  - Combina 2 señales diagnósticas.

### 4. Turno 8 (decisión MCTS 4)

- Relevancia: 4.6
- Categorías: tactical-change, low-confidence, possible-critical-decision
- Motivos:
  - La verificación táctica cambió la acción inicialmente seleccionada.
  - Margen reducido: visitas=0, valor=0, cuota elegida=0.14.
  - Combina 2 señales diagnósticas.

### 5. Turno 18 (decisión MCTS 9)

- Relevancia: 4.4
- Categorías: tactical-change, low-confidence, possible-critical-decision
- Motivos:
  - La verificación táctica cambió la acción inicialmente seleccionada.
  - Margen reducido: visitas=1, valor=0.1071, cuota elegida=0.14.
  - Combina 2 señales diagnósticas.
