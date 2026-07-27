# Experimento humano definitivo 2026

Este directorio está reservado para `WGTR-HUMAN-FINAL-2026`. Parte de un registro vacío y no
contiene resultados, semillas, territorios ni trazas ficticias.

## Preparación de una sesión

1. Abra `participants/Pxx/participant.json`.
2. Sustituya `null` en `experienceGroup` por `none`, `basic` o `experienced`.
3. Sustituya `null` en `previousWallGoGames` por un entero no negativo.
4. Complete `notes` solo si es necesario, sin nombres ni información personal.
5. Registre el participante con el comando indicado en `commands.md`.
6. Realice exactamente una partida de práctica, que no se registra.
7. Inicie la aplicación con `VITE_GIT_COMMIT` igual al commit completo del código utilizado.
8. Juegue las dos partidas en el orden de colores asignado.
9. Al finalizar cada partida, descargue el JSON reproducible y guárdelo como
   `traces/game-1.json` o `traces/game-2.json`.
10. Anote la comprobación manual en `checklist.md`. Si hubo incidencias, añada sus códigos a la
    plantilla de partida antes de registrarla.
11. Registre cada partida y valide el directorio completo.

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
