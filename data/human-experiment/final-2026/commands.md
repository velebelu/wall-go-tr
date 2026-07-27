# Comandos operativos

Ejecutar desde la raíz del repositorio.

## Flujo simplificado

```powershell
npm run human-experiment:setup-participant -- P02 basic 3
npm run human-experiment:start
npm run human-experiment:ingest-latest -- P02 1
npm run human-experiment:ingest-latest -- P02 2
```

`start` muestra e inyecta el hash completo. `ingest-latest` conserva la descarga original,
rechaza ambigüedades y actualiza únicamente el registro raíz.

## Registro de participantes

```powershell
npm run human-experiment:register-participant -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P01/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P02/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P03/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P04/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P05/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P06/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P07/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P08/participant.json
```

## Registro de partidas

```powershell
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P01/game-1.json data/human-experiment/final-2026/participants/P01/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P01/game-2.json data/human-experiment/final-2026/participants/P01/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P02/game-1.json data/human-experiment/final-2026/participants/P02/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P02/game-2.json data/human-experiment/final-2026/participants/P02/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P03/game-1.json data/human-experiment/final-2026/participants/P03/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P03/game-2.json data/human-experiment/final-2026/participants/P03/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P04/game-1.json data/human-experiment/final-2026/participants/P04/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P04/game-2.json data/human-experiment/final-2026/participants/P04/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P05/game-1.json data/human-experiment/final-2026/participants/P05/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P05/game-2.json data/human-experiment/final-2026/participants/P05/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P06/game-1.json data/human-experiment/final-2026/participants/P06/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P06/game-2.json data/human-experiment/final-2026/participants/P06/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P07/game-1.json data/human-experiment/final-2026/participants/P07/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P07/game-2.json data/human-experiment/final-2026/participants/P07/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P08/game-1.json data/human-experiment/final-2026/participants/P08/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026 data/human-experiment/final-2026/participants/P08/game-2.json data/human-experiment/final-2026/participants/P08/traces/game-2.json
```

## Validación y exportación

Después de cada registro:

```powershell
npm run human-experiment:validate -- data/human-experiment/final-2026
```

Al cerrar las 16 partidas:

```powershell
npm run human-experiment:validate -- data/human-experiment/final-2026
npm run human-experiment:export -- data/human-experiment/final-2026 data/human-experiment/final-2026/export
```
