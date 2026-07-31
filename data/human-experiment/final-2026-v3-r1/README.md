# Muestra humana final 2026 V3-R1

## Estado: preparada, pendiente de binding

V3-R1 repite desde cero el protocolo de V3 después de que V3 se cerrara por una discrepancia
entre la transición esperada del motor y el estado comprometido en el store. No cambia reglas,
IA, configuración MCTS, asignación de colores ni número de partidas.

V3 permanece archivada en `data/human-experiment/final-2026-v3`. Su P01-1 se conserva íntegra
como evidencia histórica y no se copia ni contabiliza en V3-R1. El registro de esta repetición
empieza con cero participantes y cero partidas, y todos los directorios de trazas están vacíos.

La IA sigue vinculada a `d24414802111390f0d4cffc5cb87b0de56932904`.
`securedTerritoryPolicy` continúa rechazada y desactivada.

Antes de iniciar una partida oficial se requieren dos commits publicados:

1. Un commit de preparación que incluya el runtime endurecido, validadores y este árbol vacío.
2. Su hijo inmediato, que cambie exclusivamente `metadata.json`, sustituya los marcadores
   pendientes por el hash completo del commit de preparación y cambie `status` a `frozen`.

El launcher rechaza sesiones oficiales mientras falte ese binding.
