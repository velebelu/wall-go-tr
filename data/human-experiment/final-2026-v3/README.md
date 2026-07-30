# Muestra humana final 2026 V3

V3 sustituye a V2 por trazabilidad insuficiente. Empieza con cero participantes registrados,
cero partidas y cero trazas oficiales. Las plantillas no equivalen a registros.

La IA jugable conserva exactamente la configuración final previa. `securedTerritoryPolicy`
está rechazada y desactivada por efecto contrafactual negativo.

Cada participante realiza exactamente una práctica no oficial y dos partidas oficiales, una
como R y otra como B. Los órdenes alternan R→B y B→R.

El arranque oficial permanece bloqueado hasta sustituir ambos marcadores `PENDING_*` de
`metadata.json` por hashes completos existentes. `implementationCommit` identifica el
commit funcional y de trazabilidad. `experimentPreparationCommit` identifica el commit de
preparación y debe ser el padre del HEAD limpio final, cuyo único cambio será fijar esos hashes
en metadata. El arranque oficial valida automáticamente la relación y la existencia de ambos.
