# Modelo final congelado para el experimento humano

## Estado y decisión

La configuración B del MCTS adaptativo es la versión definitiva para el experimento
humano. La decisión técnica es:

```text
adopt-with-documented-latency
```

La clasificación automática fue `retain-current-baseline` únicamente por dos
incumplimientos mínimos: 2.705,64 ms de latencia media frente al límite de
2.700 ms y 21,68 % de cortes temporales frente al límite del 20 %. Se aceptan
para el modo de desafío humano. El P95 fue 5.140,16 ms, dentro del límite de
5.300 ms.

## Arquitectura y configuración exacta

`FINAL_HUMAN_CHALLENGE_MCTS_CONFIG` es la única fuente de verdad. La búsqueda se
ejecuta en un Web Worker y conserva un único árbol durante las etapas:

- 250 simulaciones iniciales.
- Ampliación hasta 500 cuando se cumplen al menos dos condiciones: diferencia
  de visitas ≤ 3, diferencia de valor ≤ 0,04 y cuota de visitas de la acción
  elegida ≤ 0,12.
- No existe una etapa de 750 simulaciones.
- Límite total por decisión: 5.000 ms.
- Progressive widening: activo (`constant = 2`, `exponent = 0,5`).
- Ordenación/expansión heurística: activa.
- Rollout mixto actual: probabilidad heurística 0,8.
- Verificación táctica: top-2.
- Reutilización del árbol: activa entre 250 y 500.
- Profundidad máxima: 60.
- Exploración: √2.
- `qPriorWeight = 0`.
- Solucionador alfa-beta final: desactivado.

El perfil jugable anterior de 50 simulaciones se conserva únicamente como
“MCTS actual / modo rápido”; no es la IA final del experimento.

## Decisiones descartadas

Q5 no se usa como prior porque su confirmación no mostró mejora suficiente y
añadió coste de inferencia; la versión congelada no carga recursos Q5. La etapa
de 750 se descarta porque aumenta la latencia sin justificar su coste para el
resultado confirmado. El solucionador alfa-beta de final se deja inactivo
porque no aportó evidencia suficiente para incorporarlo y constituiría otra
ruta de decisión fuera de la arquitectura confirmada.

## Confirmación final

La confirmación se completó con 150 partidas terminales:

- 97-1-2 frente a la IA heurística.
- 31-19 frente al MCTS baseline.
- 62 % de victorias directas y diferencia territorial media de +2,28 frente al
  baseline.
- Cero divergencias y cero acciones ilegales.
- Ejecución reproducible.

No se realizará una nueva calibración ni otra confirmación.

## Congelación metodológica

Durante el experimento humano queda prohibido modificar presupuestos, umbrales,
rollout, profundidad, verificación táctica, progressive widening, ordenación,
prior Q5, solucionador o límite temporal. Cualquier cambio invalidaría la
comparabilidad experimental y requeriría una versión y un protocolo distintos.
