# Comandos V3

```bash
npm run human-experiment:setup-participant -- P01 experienced 15
npm run human-experiment:start -- practice P01
npm run human-experiment:start -- official P01 1
npm run human-experiment:start -- official P01 2
npm run human-experiment:validate
```

La práctica incluye `participantId=P01` y `sessionType=practice` en su traza. El vigilante
no se inicia en practice y esa traza nunca modifica `registry.json` ni `metadata.gameCount`.
