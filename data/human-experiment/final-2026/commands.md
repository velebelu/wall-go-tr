# Comandos operativos

Ejecutar desde la raíz del repositorio.

## Aplicación trazable

```powershell
$env:VITE_GIT_COMMIT = git rev-parse HEAD
npm run dev
```

Antes de jugar, confirme que `$env:VITE_GIT_COMMIT` contiene el hash completo.

## Registro de participantes

```powershell
npm run human-experiment:register-participant -- data/human-experiment/final-2026/participants/P01/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026/participants/P02/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026/participants/P03/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026/participants/P04/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026/participants/P05/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026/participants/P06/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026/participants/P07/participant.json
npm run human-experiment:register-participant -- data/human-experiment/final-2026/participants/P08/participant.json
```

## Registro de partidas

```powershell
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P01/game-1.json data/human-experiment/final-2026/participants/P01/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P01/game-2.json data/human-experiment/final-2026/participants/P01/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P02/game-1.json data/human-experiment/final-2026/participants/P02/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P02/game-2.json data/human-experiment/final-2026/participants/P02/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P03/game-1.json data/human-experiment/final-2026/participants/P03/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P03/game-2.json data/human-experiment/final-2026/participants/P03/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P04/game-1.json data/human-experiment/final-2026/participants/P04/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P04/game-2.json data/human-experiment/final-2026/participants/P04/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P05/game-1.json data/human-experiment/final-2026/participants/P05/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P05/game-2.json data/human-experiment/final-2026/participants/P05/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P06/game-1.json data/human-experiment/final-2026/participants/P06/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P06/game-2.json data/human-experiment/final-2026/participants/P06/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P07/game-1.json data/human-experiment/final-2026/participants/P07/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P07/game-2.json data/human-experiment/final-2026/participants/P07/traces/game-2.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P08/game-1.json data/human-experiment/final-2026/participants/P08/traces/game-1.json
npm run human-experiment:register-game -- data/human-experiment/final-2026/participants/P08/game-2.json data/human-experiment/final-2026/participants/P08/traces/game-2.json
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
