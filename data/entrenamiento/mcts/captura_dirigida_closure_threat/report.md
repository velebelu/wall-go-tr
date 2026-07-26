# Captura dirigida y contrafactual aislado de closureThreatVerification

## Resultado

Se capturaron 19 intervenciones completas y únicas en 42 partidas dirigidas. El límite de
captura se cerró a una intervención del objetivo mínimo porque ya se habían agotado las semillas
históricamente activas y varias semillas nuevas. Los 19 fixtures tienen huellas
estado–acción distintas.

Cada intervención se evaluó mediante 10 pares terminales (380 continuaciones): rama A fuerza la
acción MCTS original y rama B fuerza la acción del detector. Después de esa acción se usa en ambas
ramas la misma política heurística determinista, sin volver a invocar el detector, y la misma
semilla por par.

Resultado individual agregado:

- `beneficial`: 0;
- `harmful`: 4;
- `neutral`: 1;
- `inconclusive`: 14;
- efecto territorial emparejado medio: **-1.837**;
- tasa perjudicial confirmada: **21.05 %**;
- coste medio del detector: **27.90 ms** (p95 37.34 ms; máximo 44.29 ms).

## Patrones

Las 19 intervenciones activaron simultáneamente ganancia territorial rival y caída de
accesibilidad propia. Nueve incluyeron pérdida de última ficha en componente grande y dos
incluyeron resultado terminal negativo.

| Criterios presentes | Casos | Harmful | Neutral | Inconclusive | Efecto medio |
|---|---:|---:|---:|---:|---:|
| territorio + accesibilidad | 10 | 1 | 1 | 8 | -2.460 |
| territorio + accesibilidad + última ficha | 7 | 2 | 0 | 5 | -1.671 |
| anteriores + terminalidad | 2 | 1 | 0 | 1 | +0.700 |

No aparece un criterio aislado que explique todo el daño: el patrón común es que el detector
descarta la preferencia MCTS basándose en una respuesta inmediata, pero la acción alternativa
no demuestra ventaja estable bajo continuación emparejada. El daño confirmado aparece tanto con
como sin pérdida de última ficha.

Por rival:

- heurística: 12 intervenciones, 3 perjudiciales, efecto medio -1.708;
- MCTS baseline: 7 intervenciones, 1 perjudicial, efecto medio -2.057.

Por fase: 18 intervenciones ocurrieron en final y una en fase media; ninguna en apertura.

## Criterios de integración

| Criterio | Resultado |
|---|---|
| Perjudiciales confirmadas < 5 % | **No**: 21.05 % |
| Beneficiosas claramente superiores | **No**: 0 frente a 4 |
| Efecto territorial no negativo | **No**: -1.837 |
| Turno 36 mantiene mejora | Sí: referencia dirigida previa +4.15 |
| Sin patrones repetidos de daño | **No**: cuatro daños confirmados |
| Coste medio < 100 ms | Sí: 27.90 ms |
| Sin ilegales ni divergencias | Sí |

## Decisión

Clasificación final: **`reject`**.

Recomendación inequívoca: **descartar la integración de la variante actual**. La evidencia
aislada ya viola tres criterios decisivos y no existe ninguna intervención beneficiosa confirmada.
No se propone modificar parámetros ni el detector dentro de esta ejecución.

## Integridad

- fixtures válidos: 19/19;
- continuaciones: 380/380;
- pares completos: 190/190;
- duplicados de intervención: 0;
- huellas estado–acción duplicadas: 0;
- acciones ilegales: 0;
- divergencias: 0;
- detector activado después de la acción forzada: 0.
