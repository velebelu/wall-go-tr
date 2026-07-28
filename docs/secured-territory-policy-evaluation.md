# Criterios previos: política de territorio asegurado

La política candidata permanece desactivada en `FINAL_HUMAN_CHALLENGE_MCTS_CONFIG` hasta completar
esta evaluación.

## Diseño

- Semillas emparejadas y colores equilibrados.
- Comparación contra random, heurística, MCTS jugable anterior y enfrentamiento directo contra la
  IA Human Challenge sin la política.
- Límite metodológico de 100 turnos de juego; al alcanzarlo se adjudica por territorio.
- Se registran victorias, derrotas, empates, territorio medio, intervalo Wilson del 95 % para la
  proporción de victorias, tiempo medio de decisión e intervenciones.
- Cada intervención se compara contrafactualmente a un paso mediante la evaluación posicional de
  la acción original y la seleccionada.

## Criterios de adopción

1. En el enfrentamiento directo, territorio medio candidato menos baseline >= -1,5 y puntuación
   candidato (victoria + 0,5 empates) >= 45 %.
2. Contra cada control, la tasa de puntuación no cae más de 10 puntos porcentuales y el territorio
   medio no cae más de 2 puntos respecto al baseline emparejado.
3. Cero acciones ilegales, partidas sin acción o fallbacks de la política.
4. Las intervenciones perjudiciales no superan a las beneficiosas.
5. Si los intervalos o el número de intervenciones dejan una señal ambigua, la política se rechaza
   para el experimento humano.

## Resultado

El piloto emparejado ejecutó los cuatro enfrentamientos solicitados con ambos colores. Se detuvo
antes de una campaña de 250 simulaciones porque ya incumplió un criterio eliminatorio: 9
intervenciones no proporcionan potencia suficiente y una de ellas necesitó fallback. La política
queda disponible solo como prototipo desactivado; no forma parte de la configuración final ni
altera su hash.
