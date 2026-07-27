# Cierre de mejoras territoriales experimentales

## Síntesis

| Variante                    | Resultado principal                                     | Decisión                       |
| --------------------------- | ------------------------------------------------------- | ------------------------------ |
| `closureThreatVerification` | 0 beneficiosas, 4 perjudiciales, efecto medio −1,837    | Rechazada por daño             |
| `contestedRegionSupport`    | 0 cambios en 54 comparaciones                           | Rechazada por irrelevancia     |
| `maxImmediateCutLoss`       | Detecta cierres demasiado tarde; coste estimado 28,88 % | Rechazada por concepto y coste |

Las tres pruebas mostraron que el fallo observado frente al jugador humano no podía corregirse de
forma fiable mediante filtros posteriores, indicadores estáticos de soporte o estimaciones
locales de cierre inmediato. Las aproximaciones que intervenían podían empeorar las decisiones,
mientras que las aproximaciones conservadoras no tenían influencia suficiente o resultaban
demasiado costosas.

Por este motivo, se decidió mantener la configuración final previamente validada y considerar
que una mejora posterior requeriría un enfoque diferente, como una función de valor aprendida o
una evaluación estratégica entrenada con posiciones y resultados completos. Esto se registra
únicamente como trabajo futuro; no inicia una nueva fase.

## Estado definitivo

La IA final continúa siendo `FINAL_HUMAN_CHALLENGE_MCTS_CONFIG`, sin:

- `closureThreatVerification`;
- `contestedRegionSupport`;
- `maxImmediateCutLoss`;
- Q5 como prior;
- etapa de 750 simulaciones;
- alfa-beta;
- nuevos filtros territoriales.

El objeto congelado y los agentes jugables no se modificaron. El código experimental y los
artefactos negativos se conservan para reproducibilidad, siempre desactivados y fuera de la ruta
de producción.
