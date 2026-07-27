# Experimento MCTS: `contestedRegionSupport`

## Estado y decisión

Experimento cerrado. La formulación evaluada se rechaza como candidata a la IA final. No se
integra ni se calibra retrospectivamente y `FINAL_HUMAN_CHALLENGE_MCTS_CONFIG` permanece
congelada.

La conclusión se limita al peso fijado previamente (`weight = 1`) y al conjunto analizado:

> La formulación evaluada, con el peso fijado previamente y sobre el conjunto analizado, no
> mostró capacidad para modificar las decisiones de la IA.

No se afirma que cualquier medida posible de soporte territorial sea necesariamente inútil.

## Hipótesis

La accesibilidad existente concede el valor completo de una componente a un jugador con que una
sola ficha esté presente. La hipótesis era que esto podía sobrevalorar regiones grandes sostenidas
por una sola ficha y que valorar la redundancia de presencia mejoraría las hojas no terminales
del MCTS.

## Métrica evaluada

Para cada componente disputada `r` producida por `floodRegions`:

```text
S_p(s)   = sum_r e_r * min(1, n_p,r / 2)
D_S(s,p) = S_p(s) - S_o(s)
E'(s,p)  = E(s,p) + D_S(s,p)
```

`e_r` excluye las casillas ocupadas. Solo contribuyen regiones que contienen fichas de ambos
jugadores. La métrica se aplicó a la evaluación de rollouts no terminales y a la evaluación ya
existente del top-2, sin añadir filtros, respuestas, búsquedas ni consumo de RNG.

## Diseño

- Baseline: métrica desactivada y peso cero.
- Candidate: métrica activa con peso uno.
- 27 posiciones verificadas: tres críticas humanas, cinco controles y 19 intervenciones
  dirigidas.
- Dos semillas de selección.
- 108 búsquedas MCTS y 54 comparaciones emparejadas.
- Configuración, presupuesto adaptativo 250→500, rollout, progressive widening y top-2
  constantes.
- Dos semillas de continuación previstas únicamente para cambios efectivos.

## Resultados

- 27/27 posiciones válidas y únicas; ninguna exclusión.
- 22 posiciones con término cero y cinco con término no nulo.
- Activación: 18,52 %.
- Media del diferencial: −1,426; mediana: 0; rango: −15 a +1,5.
- Activación concentrada en fase final: 5/22; fase media: 0/5.
- 0 cambios de acción inicial y 0 cambios finales en 54 comparaciones.
- 0 intervenciones efectivas y, por protocolo, 0 continuaciones causales.
- Mismas simulaciones medias en ambas ramas: 458,33.
- Sobrecoste total aproximado: 0,80 %.
- 9.056 evaluaciones de la métrica a una media de 16,73 µs.
- Repetición de dos fixtures, ambas semillas y ambas configuraciones: reproducible.

## Interpretación

La métrica representa de forma coherente la redundancia de fichas dentro de una componente,
pero su activación fue principalmente tardía y se solapa parcialmente con territorio, movilidad
y accesibilidad. Incluso la contribución extrema de −15 puntos del turno 38 no cambió la acción
inicial ni la final.

No hay evidencia de mejora ni de daño estratégico: para obtener evidencia causal debía existir
al menos una intervención, y no la hubo. La ausencia de cambios no se interpreta como mejora.
Para la política actual, el término debe considerarse irrelevante en la formulación probada.

## Conservación del código

La métrica se conserva como código experimental porque:

- está aislada en una función pura;
- tiene tests de conectividad, simetría, saturación y neutralidad por defecto;
- la ausencia de opción, `enabled: false` y `weight: 0` preservan la baseline;
- ninguna configuración final o agente jugable la activa;
- conservarla mantiene reproducible el resultado negativo.

La infraestructura general —serialización canónica, huellas SHA-256, validación de fixtures,
comparación emparejada, atribución árbol/top-2, medición y control de duplicados— es reutilizable.
Los campos `contestedRegionSupportRed`, `contestedRegionSupportBlue`,
`contestedRegionSupportDiff` y `newTermContribution` son específicos de esta hipótesis. Los
artefactos `benchmark_utilidad_territorial_v1_*` quedan inmutables y no deben reinterpretarse
como resultados de futuros términos.

## Artefactos

- `data/entrenamiento/mcts/benchmark_utilidad_territorial_v1_smoke`
- `data/entrenamiento/mcts/benchmark_utilidad_territorial_v1_pilot`

No se realizará benchmark confirmatorio ni partidas completas para esta formulación.
