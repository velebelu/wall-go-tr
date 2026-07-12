# Analisis Q5 final_finetuning_500

Entradas iniciales: 19652; finales: 22752; añadidas: 3100.
Cambio absoluto medio heredado: 0.009557; mediana: 0; maximo: 6.53037.

## Cambio maximo
Clave: `q3|phase:playing|step:0|sp:4,4|td:L1|mob:6-15,6-15|trap:1,2|walls:37+|||move-wall|4|5|5|6|5|6|left`
Q inicial 1.27, Q final 7.800369999999999, diferencia 6.53037, abs 6.53037.
With alpha=0.03, a 6.5304 absolute move implies an update target roughly 217.68 points away from the then-current Q if it happened in one update. This scale cannot be explained by the bounded intermediate reward alone; it requires terminal reward (+/-100 plus territory final), bootstrapping from future Q values, repeated updates, or a combination. Exact update count and per-key reward decomposition were not logged.

## Distribucion por umbral
- > 0.1: 109
- > 0.5: 41
- > 1: 41
- > 2: 41
- > 5: 1
- Signo positivo a negativo: 8
- Signo negativo a positivo: 6

## Confianza inicial
- 1 observacion: entradas 15462, cambiadas 1310, abs medio 0.009987, max 6.53037, >1 36, >5 1
- 2-5: entradas 3437, cambiadas 475, abs medio 0.0081, max 3.5043, >1 5, >5 0
- 6-20: entradas 595, cambiadas 115, abs medio 0.005648, max 0.169558, >1 0, >5 0
- mas de 20: entradas 158, cambiadas 45, abs medio 0.013855, max 0.338083, >1 0, >5 0

## Salud de valores
NaN/inf/no numericos: 0; fuera de abs>500: 0; rango final -6.9938733..7.800369999999999.

## Comportamiento en estados no cubiertos
- knownStateNoKnownAction: Q5 evaluates every legal action with qTable[key] ?? 0. If no legal action has a known key, all actions tie at 0 and selection is random among all legal actions using the seeded RNG.
- tieBreaks: When several actions share the same max Q value, chooseLearningActionQ4 chooses randomly among tied best actions with the seeded RNG.
- newStateEpsilonZero: With epsilon=0 in evaluation, a completely new state still uses greedy selection over default value 0, so every legal action ties and behavior becomes seeded-random for that decision.
- coverageRisk: Yes. Any state with no known positive action, or only unknown actions, can retain random behavior during evaluation. Unknown actions with default 0 can also beat known inherited negative actions.

## Top 50
| # | abs | diff | Q inicial | Q final | obs | confianza | origen rival/color | accion |
|---:|---:|---:|---:|---:|---:|---|---|---|
| 1 | 6.53037 | 6.53037 | 1.27 | 7.800369999999999 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|4|5|5|6|5|6|left` |
| 2 | 3.58692 | -3.58692 | 0.98 | -2.60692 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `wall|3|1|top` |
| 3 | 3.52833 | 3.52833 | 0.94 | 4.46833 | 1 | 1 observacion | r:1/h:0/R:1/B:0 | `move-wall|5|3|4|2|4|2|bottom` |
| 4 | 3.5043 | -3.5043 | -0.29 | -3.7942999999999993 | 2 | 2-5 | r:0/h:2/R:0/B:2 | `move-wall|1|1|0|2|0|2|bottom` |
| 5 | 3.49842 | 3.49842 | 1.44 | 4.93842 | 1 | 1 observacion | r:1/h:0/R:0/B:1 | `move-wall|2|5|2|4|2|4|top` |
| 6 | 3.49695 | 3.49695 | 0.98 | 4.47695 | 1 | 1 observacion | r:1/h:0/R:0/B:1 | `move-wall|2|3|1|4|1|4|top` |
| 7 | 3.496376 | 3.496376 | 1.02 | 4.5163761 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|1|1|2|0|2|0|bottom` |
| 8 | 3.49506 | 3.49506 | 1.04 | 4.53506 | 1 | 1 observacion | r:1/h:0/R:1/B:0 | `move-wall|4|4|3|5|3|5|bottom` |
| 9 | 3.494013 | -3.494013 | 0.9767 | -2.5173129700000003 | 3 | 2-5 | r:0/h:3/R:3/B:0 | `move-wall|1|6|0|5|0|5|right` |
| 10 | 3.439661 | -3.439661 | 0.98 | -2.4596605429 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|0|4|1|3|1|3|right` |
| 11 | 3.41436 | 3.41436 | 1.23 | 4.64436 | 2 | 2-5 | r:2/h:0/R:1/B:1 | `move-wall|2|2|3|1|3|1|bottom` |
| 12 | 3.40404 | 3.40404 | 1.02 | 4.42404 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|6|2|5|1|5|1|top` |
| 13 | 3.378656 | 3.378656 | 1.15 | 4.5286558 | 1 | 1 observacion | r:1/h:0/R:1/B:0 | `move-wall|1|1|1|0|1|0|right` |
| 14 | 3.37734 | -3.37734 | 1 | -2.37734 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|6|3|6|4|6|4|bottom` |
| 15 | 3.375654 | 3.375654 | 1.48 | 4.855654084000001 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|0|2|0|3|0|3|bottom` |
| 16 | 3.366942 | -3.366942 | 1.09 | -2.2769417 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|5|4|6|3|6|3|left` |
| 17 | 3.358941 | 3.358941 | 1.48 | 4.8389407 | 2 | 2-5 | r:2/h:0/R:1/B:1 | `move-wall|5|4|6|5|6|5|top` |
| 18 | 3.3522 | 3.3522 | 1.3 | 4.652200000000001 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|2|1|3|0|3|0|right` |
| 19 | 3.304152 | 3.304152 | 1 | 4.304152 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|1|1|2|0|2|0|left` |
| 20 | 3.30372 | 3.30372 | 0.93 | 4.23372 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `wall|3|3|bottom` |
| 21 | 3.30138 | 3.30138 | 1.02 | 4.3213799999999996 | 1 | 1 observacion | r:1/h:0/R:0/B:1 | `move-wall|2|2|1|1|1|1|top` |
| 22 | 3.2703 | -3.2703 | 0.45 | -2.8203 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|5|5|4|6|4|6|left` |
| 23 | 3.22873 | 3.22873 | 1.52 | 4.748729931516218 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|2|1|2|0|2|0|right` |
| 24 | 3.22782 | 3.22782 | 0.96 | 4.18782 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|3|5|4|5|4|5|left` |
| 25 | 3.22482 | 3.22482 | 0.04 | 3.26482 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|3|0|4|1|4|1|left` |
| 26 | 3.213813 | 3.213813 | 0.78 | 3.9938133 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|6|3|6|2|6|2|bottom` |
| 27 | 3.160219 | 3.160219 | 0.96 | 4.1202192 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|0|3|1|4|1|4|right` |
| 28 | 3.1554 | 3.1554 | 0.88 | 4.0354 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|6|4|6|5|6|5|bottom` |
| 29 | 3.152393 | 3.152393 | 0.9 | 4.0523928708 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|4|5|5|5|5|5|right` |
| 30 | 3.1518 | 3.1518 | 1.48 | 4.6318 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `wall|3|1|bottom` |
| 31 | 3.1368 | 3.1368 | 1 | 4.1368 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|1|0|0|1|0|1|bottom` |
| 32 | 3.13458 | -3.13458 | 0.98 | -2.15458 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|1|1|2|1|2|1|top` |
| 33 | 3.114192 | 3.114192 | 0.46 | 3.574192 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|5|1|4|1|4|1|right` |
| 34 | 3.10838 | 3.10838 | 0.83 | 3.9383804 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|5|4|6|4|6|4|left` |
| 35 | 3.09297 | 3.09297 | 0.88 | 3.97297 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|2|0|1|0|1|0|bottom` |
| 36 | 3.07956 | 3.07956 | 0.81 | 3.88956 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|4|6|5|6|5|6|left` |
| 37 | 3.05898 | -3.05898 | 1 | -2.0589799999999996 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|3|2|3|1|3|1|right` |
| 38 | 2.98386 | 2.98386 | 1.48 | 4.4638599999999995 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|0|2|0|3|0|3|bottom` |
| 39 | 2.978207 | 2.978207 | 0.98 | 3.9582073999999996 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|2|1|1|1|1|1|left` |
| 40 | 2.952469 | 2.952469 | 0.51 | 3.462469190946 | 2 | 2-5 | r:0/h:2/R:2/B:0 | `move-wall|4|4|5|4|5|4|left` |
| 41 | 2.693048 | 2.693048 | 1.42 | 4.113047781999999 | 1 | 1 observacion | r:1/h:0/R:0/B:1 | `move-wall|1|1|2|0|2|0|left` |
| 42 | 0.465247 | -0.465247 | 1.38 | 0.9147530464745295 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|5|5|4|6|4|6|right` |
| 43 | 0.423622 | -0.423622 | 1.3 | 0.8763784974090759 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|1|1|1|0|1|0|right` |
| 44 | 0.413943 | -0.413943 | 1.54 | 1.1260567814431908 | 1 | 1 observacion | r:1/h:0/R:0/B:1 | `move-wall|1|1|0|2|0|2|top` |
| 45 | 0.385071 | -0.385071 | 1 | 0.6149292384084466 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|1|1|1|2|1|2|left` |
| 46 | 0.368654 | -0.368654 | 1.04 | 0.6713455499018256 | 1 | 1 observacion | r:0/h:1/R:0/B:1 | `move-wall|2|1|1|0|1|0|bottom` |
| 47 | 0.366921 | -0.366921 | 0.98 | 0.6130792359378103 | 2 | 2-5 | r:0/h:2/R:0/B:2 | `move-wall|5|5|6|4|6|4|left` |
| 48 | 0.338083 | 0.338083 | 0.3332 | 0.6712829236193999 | 88 | mas de 20 | r:3/h:85/R:88/B:0 | `place|3|2` |
| 49 | 0.333717 | -0.333717 | 1.04 | 0.7062833764713539 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|1|1|0|2|0|2|top` |
| 50 | 0.286237 | -0.286237 | 1.4 | 1.113762860376445 | 1 | 1 observacion | r:0/h:1/R:1/B:0 | `move-wall|5|5|6|5|6|5|top` |

## Recomendacion
Antes de continuar, instrumentar el entrenamiento para registrar cada update estado-accion con reward intermedio acumulado, reward final aplicado, rival, color, oldQ, target y newQ. Para el siguiente tramo, mantener alpha conservador o aplicar clipping/regularizacion de cambios heredados, porque los mayores saltos parecen venir de objetivos terminales/bootstrapping y no de la señal intermedia.
