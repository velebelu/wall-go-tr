# Experimento humano definitivo 2026

Este directorio está reservado para `WGTR-HUMAN-FINAL-2026`. Parte de un registro vacío y no
contiene resultados, semillas, territorios ni trazas ficticias.

## Preparación de una sesión

1. Ejecute `npm run human-experiment:setup-participant -- Pxx <grupo> <partidas-previas>`.
   El comando completa la plantilla y registra el participante de forma transaccional.
2. Realice exactamente una partida de práctica, que no se registra.
3. Inicie la aplicación con `npm run human-experiment:start`; el comando obtiene e inyecta el
   commit completo.
4. Juegue las dos partidas en el orden de colores asignado.
5. Al finalizar cada partida, conserve la descarga JSON reproducible y ejecute
   `npm run human-experiment:ingest-latest -- Pxx N`. No mueva ni renombre manualmente el original.
6. Anote la comprobación manual en `checklist.md`. Si hubo incidencias, añada sus códigos a la
   plantilla de partida antes de registrarla.
7. La ingestión copia la traza, registra la partida y valida el directorio completo. Los
   comandos nunca crean un `registry.json` dentro de `participants/Pxx/`.

Los CSV auxiliares de pantalla pueden guardarse en `auxiliary/game-1/` y `auxiliary/game-2/`.
Nunca sustituya la traza JSON reproducible por el CSV ligero.

## Condiciones invariantes

- Modo: `IA final / Desafío MCTS`.
- Una partida humana como R y otra como B.
- Una partida de práctica por participante.
- Sin ayuda, reinicios por resultado ni adaptación de la IA.
- El pseudónimo P01–P08 es la única identificación permitida.
- Una descarga fallida o recarga debe registrarse como incidencia.
- El participante del piloto real no forma parte de esta muestra.

## Cierre

Tras registrar las 16 partidas, ejecute la validación y exportación de `commands.md`. Compruebe
manualmente que hay 8 participantes, 16 partidas, 8 partidas humanas como R y 8 como B, todas con
turnos y duración positivos, commit completo y configuración final correcta.
