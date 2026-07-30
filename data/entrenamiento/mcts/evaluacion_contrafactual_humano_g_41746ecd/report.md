# Evaluación contrafactual piloto humano–MCTS g_41746ecd

> Resultados provisionales: no demuestran por sí solos que una acción sea un error.

- Duración: 2885183.9374 ms
- Presupuestos: 50, 100, 250, 500, 1000
- Semillas por presupuesto: 20
- Semillas emparejadas contrafactuales: 2
- Presupuesto MCTS de referencia: 250

## 1_turn_3_mcts_1 — turno 3

- Clasificación provisional: budget-sensitive, seed-sensitive, tactical-improvement-supported
- Acciones candidatas: 4
- Modales por presupuesto: 50:0.2; 100:0.25; 250:0.15; 500:0.1; 1000:0.15

- {"type":"place","pos":{"x":4,"y":2}}: 2-0-0, territorio medio 24.5, diferencia 10.5, IC95 victoria 34.238–100%
- {"type":"place","pos":{"x":1,"y":2}}: 0-2-0, territorio medio 8.5, diferencia -13.5, IC95 victoria 0–65.762%
- {"type":"place","pos":{"x":3,"y":0}}: 1-1-0, territorio medio 14.5, diferencia 0.5, IC95 victoria 9.4531–90.5469%
- {"type":"place","pos":{"x":4,"y":1}}: 1-0-1, territorio medio 18, diferencia 1.5, IC95 victoria 9.4531–90.5469%

## 2_turn_6_mcts_3 — turno 6

- Clasificación provisional: budget-sensitive, seed-sensitive
- Acciones candidatas: 3
- Modales por presupuesto: 50:0.3; 100:0.25; 250:0.1; 500:0.2; 1000:0.15

- {"type":"move","from":{"x":3,"y":2},"pos":{"x":4,"y":1},"followUp":{"type":"wall","pos":{"x":4,"y":1},"dir":"right"}}: 0-2-0, territorio medio 15.5, diferencia -4.5, IC95 victoria 0–65.762%
- {"type":"move","from":{"x":3,"y":2},"pos":{"x":4,"y":3},"followUp":{"type":"wall","pos":{"x":4,"y":3},"dir":"left"}}: 0-2-0, territorio medio 16, diferencia -5.5, IC95 victoria 0–65.762%
- {"type":"move","from":{"x":3,"y":2},"pos":{"x":4,"y":2},"followUp":{"type":"wall","pos":{"x":4,"y":2},"dir":"top"}}: 1-1-0, territorio medio 22, diferencia 4, IC95 victoria 9.4531–90.5469%

## 3_turn_10_mcts_5 — turno 10

- Clasificación provisional: budget-sensitive, seed-sensitive, possible-suboptimal-action
- Acciones candidatas: 4
- Modales por presupuesto: 50:0.2; 100:0.2; 250:0.15; 500:0.15; 1000:0.15

- {"type":"move","from":{"x":5,"y":5},"pos":{"x":5,"y":4},"followUp":{"type":"wall","pos":{"x":5,"y":4},"dir":"left"}}: 1-1-0, territorio medio 17, diferencia -1.5, IC95 victoria 9.4531–90.5469%
- {"type":"move","from":{"x":5,"y":5},"pos":{"x":4,"y":5},"followUp":{"type":"wall","pos":{"x":4,"y":5},"dir":"top"}}: 2-0-0, territorio medio 28, diferencia 14, IC95 victoria 34.238–100%
- {"type":"move","from":{"x":1,"y":1},"pos":{"x":2,"y":1},"followUp":{"type":"wall","pos":{"x":2,"y":1},"dir":"bottom"}}: 1-1-0, territorio medio 20, diferencia 5, IC95 victoria 9.4531–90.5469%
- {"type":"move","from":{"x":4,"y":3},"pos":{"x":5,"y":2},"followUp":{"type":"wall","pos":{"x":5,"y":2},"dir":"top"}}: 0-2-0, territorio medio 15, diferencia -6.5, IC95 victoria 0–65.762%

## Interpretación

La confirmación extensa debe decidirse después de valorar el coste del piloto, la separación de los intervalos y la estabilidad de las alternativas.
