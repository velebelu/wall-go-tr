# Auditoria Q5 1000 vs 1500

## Resumen
- Entradas comunes: 27815
- Entradas nuevas en Q5-1500: 3429
- Entradas desaparecidas: 0
- Cambios: 2063 suben, 937 bajan, 24815 iguales
- Cambios de signo: 6 positivo->negativo, 49 negativo->positivo

## Filtros observados Q vs heuristica
- C (confianza 5, margen 0.25) en Q5-1000: 166
- C (confianza 5, margen 0.25) en Q5-1500: 180
- Perdidos C: 3
- Ganados C: 17
- Causa dominante de perdida: lower_q_and_higher_heuristic

## Conclusion
Q5-1500 reduce intervenciones porque varios candidatos observados pierden margen frente a la heuristica; la perdida se explica principalmente por cambios relativos entre el valor Q aprendido y el valor de la accion heuristica, no por falta de confianza.

## Limitaciones
Los margenes contra la accion heuristica solo se pueden auditar directamente en estados presentes en q_vs_heuristic_decision_log.jsonl, porque ese log contiene heuristicKey y qKey comparables.
