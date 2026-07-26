# Confirmación de closureThreatVerification

## Resultado

- Clasificación: `promising-needs-more-evidence`.
- Duración: 86.81 minutos.
- Fixtures terminales: 120.
- Posiciones normales: 60 observaciones sobre 30 estados.
- Partidas competitivas terminales: 160.

## Fixtures críticos

- Turno 34: delta territorial emparejado 0.30;
  4 favorables, 14 neutrales y
  2 perjudiciales.
- Turno 36: delta territorial emparejado 4.15;
  cierre grande medio pasa de 10.50 a
  13.53 turnos.
- Turno 38: delta territorial emparejado 1.35;
  0 continuaciones emparejadas perjudiciales.

## Estabilidad y competición

- Cambios normales: 0/60
  (0.00 %); cambios en apertura: 0.
- Contra heurística: congelada 37-3-0;
  variante 37-3-0.
- Contra baseline: congelada 32-7-1;
  variante 26-14-0.
- Cambios evaluados: 42; perjudiciales:
  10
  (23.81 %).

## Tiempo

- Detector: media 48.26 ms, P95
  111.70 ms y máximo 135.73 ms.
- Decisión total de la variante: media 2482.70 ms, P95
  5343.20 ms y máximo 5662.94 ms.

## Recomendación

No integrar todavía. La mejora del turno 36 y la estabilidad en posiciones normales son sólidas, pero la
tasa de cambios posteriormente perjudiciales supera ampliamente el 5 % y aparece una regresión competitiva
frente al baseline. Debe investigarse la calidad de las activaciones posteriores antes de cualquier
integración o recalibración.

La variante sigue siendo experimental y no está conectada a la interfaz ni modifica la configuración
congelada. Los resultados completos, comparaciones emparejadas, tiempos y criterios están en
`summary.json`. La ejecución persiste después de cada partida y puede reanudarse sin duplicados.
