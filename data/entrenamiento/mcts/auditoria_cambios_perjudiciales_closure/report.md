# Auditoría de cambios perjudiciales de closureThreatVerification

## Resultado

La auditoría causal de los siete casos queda **no concluyente**. Los artefactos fuente no
persisten el estado ni la secuencia completa de acciones. La reproducción dirigida diverge antes
del primer caso porque la ejecución original estuvo limitada por tiempo en decisiones tempranas.
No se rellenan métricas con valores inferidos o inventados.

Sí se confirma un patrón común en los 7/7 registros: la etiqueta `harmful` se asignó a nivel de
partida. `pairQuality` calcula una sola diferencia territorial final entre la partida
`closure` y la congelada y copia esa etiqueta a **todos** los cambios de la partida. Por tanto,
los datos no prueban que cada uno de estos siete cambios fuese perjudicial, ni permiten atribuir
el delta final a una decisión concreta. Dos casos pertenecen además a la misma partida.

## Comprobaciones solicitadas

Las comprobaciones sobre colapso de todas las candidatas, valores/visitas, accesibilidad temporal,
componentes, horizonte de una respuesta, límite 80, orden y territorio potencial quedan
`indeterminate`: requieren el estado raíz y los hijos MCTS de cada decisión, datos ausentes.

## Corrección mínima

No hay base para proponer una corrección lógica del detector. Antes de repetir la evaluación debe
corregirse una sola vez la instrumentación: persistir en cada activación el estado raíz, todos los
hijos MCTS, diagnóstico por candidata, respuestas examinadas en orden y la secuencia completa de
acciones. La calidad debe evaluarse con continuaciones contrafactuales emparejadas desde el mismo
estado y una única acción forzada, no heredarse del delta de toda la partida.

## Reproducción

Intentos de replay: 1. Divergencias: 1. Errores:

- Missing MCTS child in competitive-heuristic-9-R-closure/40
