# Diagnóstico de movimientos en territorio asegurado

Estas capturas son diagnósticas, no forman parte de la muestra humana y nunca modifican el
registro oficial.

- `capture-report.json`: turnos detectados durante la campaña.
- `counterfactual-report.json`: cinco continuaciones emparejadas por intervención independiente.
- `corpus-manifest.json`: tamaño, SHA-256 y resumen de cada una de las 36 trazas completas.
- `fixtures/`: cuatro fixtures de una sola decisión, uno por caso independiente.

Las trazas completas ocupan 89.489.023 bytes y siguen localmente en este directorio. El patrón
`trace-*.json` está ignorado por Git; sólo se versionan los cuatro fixtures mínimos. Git LFS está
instalado, pero su política actual únicamente cubre otro dataset de entrenamiento.

## Decisión final

- `status`: `rejected`
- `accepted`: `false`
- `reason`: `negative-counterfactual-effect`
- Intervenciones independientes: 4; beneficiosas: 1; perjudiciales: 3.
- Efecto territorial medio: -1,55; IC bootstrap 95 %: [-2,9; -0,3].
- Frecuencia: aproximadamente 0,24 intervenciones independientes por cada 100 decisiones.

El comportamiento redundante existe, pero el filtro elimina con frecuencia acciones
estratégicamente superiores. La política queda desactivada y fuera de la selección final.
