# Informe del piloto jugable real

## Objetivo

El piloto validó el procedimiento completo de una sesión humana contra la IA final congelada:
captura de tiempos, descarga de trazas, registro, reproducción, validación y exportación. Sus
resultados no se utilizan para evaluar el rendimiento de la IA.

## Participante y procedimiento

- Experimento: `WGTR-REAL-PILOT-2026`.
- Participante pseudónimo: `REAL-PILOT-001`.
- Experiencia previa declarada: ninguna.
- Práctica: una partida.
- Orden de colores: rojo y después azul (`R → B`).
- El participante queda excluido de la muestra definitiva.

## Resultados

| Partida | Humano | IA | Ganador | Territorio humano | Territorio IA | Diferencia humana | Turnos | Duración |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | R | B | IA | 22 | 26 | -4 | 31 | 143983 ms |
| 2 | B | R | Humano | 37 | 7 | +30 | 42 | 205462 ms |

## Validación automática

El registro contiene un participante y dos partidas. Las dos trazas se reproducen, sus datos
derivados coinciden con el registro y la validación termina correctamente:

```text
Valid registry: 1 participants, 2 games
validation.ok: true
globalIncidents: []
```

Ambas partidas usan el commit completo
`60d45a283e4b6f91af32f307a2bb613ffad76970` y el hash de configuración
`7d137f48f941045742aacbeeadffcd8db036477e355a2f8c61aace3af4e7fca8`.

## Comprobación manual

Los colores, ganadores, territorios, turnos y duraciones mostrados o anotados al finalizar
coinciden con el registro y con `games.csv`. Existe una partida completa por cada color humano;
ambas contienen decisiones y duración positiva. Las rutas exportadas son relativas y no se
detectaron nombres, correos, rutas absolutas ni información personal.

## Problemas encontrados y resolución

El intento inicial de registro produjo `ENOENT` porque el archivo de traza todavía no se
encontraba en la ruta esperada. Se resolvió guardando la descarga JSON reproducible en
`traces/game-1.json` y ejecutando de nuevo el comando de registro. No fue necesario alterar la
traza, el resultado, la IA ni la infraestructura. No se registraron incidencias durante las dos
partidas válidas.

## Conclusión

El flujo completo del piloto es apto: genera trazas reproducibles, conserva el commit y la
configuración final, deriva resultados coherentes y produce exportaciones verificables. Todos los
datos de este piloto quedan separados y excluidos del análisis de la muestra definitiva.
