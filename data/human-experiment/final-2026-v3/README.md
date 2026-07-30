# Muestra humana final 2026 V3

## Estado: archivada y cerrada

V3 queda cerrada permanentemente para nuevas partidas oficiales desde el 30 de julio de 2026.
Conserva una partida P01-1 técnicamente válida y un intento P01-2 rechazado, pero no se usará
como pareja en el análisis final. P01-1 no se modifica, elimina ni traslada a otro experimento.

`npm run human-experiment:validate-v3-archive` valida los datos conservados y la relación entre
los commits históricos de implementación y binding. Esta validación documental no autoriza una
nueva ejecución. El launcher `human-experiment:start -- official ...` rechaza siempre V3.

V3 sustituye a V2 por trazabilidad insuficiente. Empieza con cero participantes registrados,
cero partidas y cero trazas oficiales. Las plantillas no equivalen a registros.

La IA jugable conserva exactamente la configuración final previa. `securedTerritoryPolicy`
está rechazada y desactivada por efecto contrafactual negativo.

Cada participante realiza exactamente una práctica no oficial y dos partidas oficiales, una
como R y otra como B. Los órdenes alternan R→B y B→R.

El congelado histórico permanece vinculado a sus commits originales. No se actualizan
`implementationCommit`, `experimentPreparationCommit` ni el binding de V3 para hacer compatible
un `HEAD` posterior.
