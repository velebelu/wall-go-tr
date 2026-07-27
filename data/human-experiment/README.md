# Datos del experimento humano

`pilot/` contiene exclusivamente datos ficticios para validar la infraestructura. No debe
combinarse con la recogida definitiva.

Cada directorio experimental contiene:

- `registry.json`: registro canónico de participantes y partidas.
- entradas `participant.json` y `game-*.json`;
- `traces/`: trazas reproducibles;
- `export/`: CSV, resumen y manifiesto generados.

No se permiten nombres, correos, rutas absolutas ni otros identificadores personales.

Los comandos de operación están documentados en `docs/human-experiment-protocol.md` y expuestos
como scripts `human-experiment:*` de npm.
