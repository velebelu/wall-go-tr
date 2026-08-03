# Autoenfrentamiento MCTS — sesgo de color y orden de juego

Identificador del experimento: `WGTR-MCTS-SELFPLAY-COLOR-BIAS-2026-V1`.

## Qué contiene esta carpeta

| Archivo | Contenido |
| --- | --- |
| `metadata.json` | Configuración completa del agente, semillas, commit de implementación, entorno de ejecución y guardia del experimento humano congelado. |
| `plan.json` | Plan determinista de las 100 parejas y 200 partidas. |
| `games/game-XXX.json` | Resultado individual y autocontenido de cada partida, con la secuencia completa de acciones y sus huellas SHA-256. |
| `results.csv` | Tabla con una fila por partida. |
| `pairs.csv` | Tabla con una fila por pareja: resultado de cada miembro, puntuación de color y puntuación de flujo de semillas. |
| `summary.json` | Resumen agregado: recuentos, medias, pruebas estadísticas, tamaños del efecto y conclusiones automáticas. |
| `manifest.json` | Huella SHA-256 de cada archivo de partida, para detectar manipulaciones. |
| `informe-tecnico.md` | Informe técnico completo generado a partir de `summary.json`. |
| `resumen-bachillerato.md` | Resumen divulgativo con lenguaje de 1.º de Bachillerato. |
| `resumen-tr.csv` | Tabla compacta de magnitudes lista para el trabajo de recerca. |
| `graficas/` | Gráficas en SVG y PNG. |

## Diseño

Las dos IA son la misma: `FINAL_HUMAN_CHALLENGE_MCTS_CONFIG`, la configuración congelada del
experimento humano V3-R1. Se aplica a rojo y a azul sin ninguna diferencia, y el validador
comprueba por huella criptográfica que ambas configuraciones coinciden con esa constante.

Cada pareja define dos flujos de semillas, **alfa** y **beta**:

- Partida *directa*: alfa juega con rojo, beta con azul.
- Partida *intercambiada*: beta juega con rojo, alfa con azul.

Así cada flujo juega exactamente una vez con cada color. El contraste de color
(`pairRedScore`) y el contraste de flujo (`pairAlphaScore`) resultan ortogonales, de modo que
el segundo funciona como control negativo del primero.

Cada decisión consume la semilla `baseDelLado + índiceDeDecisiónDeEseLado`, con un generador
nuevo por decisión. Por eso una partida se puede repetir aislada, en cualquier orden y en
cualquier proceso, y da exactamente el mismo resultado.

## Unidad de análisis

Las dos partidas de una pareja comparten sus flujos de semillas, así que no se supone que sean
independientes. La unidad de análisis son las **100 parejas**, no las 200 partidas. Las pruebas
principales son un bootstrap por conglomerados sobre las medias por pareja y una prueba de
Wilcoxon de rangos con signo. La prueba binomial por partida se conserva solo como análisis de
sensibilidad, junto con la correlación intraclase que permite juzgar esa suposición.

## Reproducir y validar

```bash
npm run experiment:mcts-selfplay-color-bias            # juega las 200 partidas (reanudable)
npm run experiment:mcts-selfplay-color-bias:validate   # valida el conjunto completo
npm run experiment:mcts-selfplay-color-bias:report     # regenera informe, resumen y tabla
npm run experiment:mcts-selfplay-color-bias:charts     # regenera las gráficas
```

Opciones útiles del ejecutor: `--pairs=N`, `--workers=N`, `--output=ruta`. El ejecutor omite
las partidas ya guardadas, de modo que una interrupción se retoma sin perder trabajo.
Opciones del validador: `--replay=N` para volver a jugar N partidas repartidas por todo el
plan (2 por defecto) y `--pairs` / `--output` equivalentes.

### Pruebas de reproducibilidad realizadas

1. **Dentro del validador.** Se volvieron a jugar cuatro partidas repartidas por el plan
   (parejas 1, 26, 51 y 76), en un proceso nuevo, y sus huellas de secuencia de acciones y de
   resultado coincidieron exactamente con las guardadas.
2. **Repetición de las acciones.** Las 200 secuencias de acciones guardadas se vuelven a
   aplicar con el motor oficial y reproducen ganador, territorio, contadores y motivo de
   finalización.
3. **Entre ejecuciones independientes.** El piloto de 10 partidas se ejecutó horas antes, con
   otro commit (`52105ed`) y con 10 procesos en lugar de 12. Sus diez partidas coinciden bit a
   bit con las diez primeras de la ejecución definitiva. Es la comprobación más fuerte: ni el
   commit, ni el número de procesos, ni el momento de ejecución alteran el resultado.
4. **Entre compiladores.** Un test fija la huella de una partida medida bajo ts-node (ES5) y la
   comprueba bajo esbuild, de modo que los dos entornos de ejecución del repositorio producen
   partidas idénticas.

## Desviación documentada respecto a la IA desplegada

El agente desplegado corta cada decisión a los 5 000 ms para no hacer esperar a la persona que
juega. Ese límite se mide con el reloj real y haría que el resultado dependiera de la carga de
la máquina, lo que impediría reproducir el experimento. Aquí se inyecta un reloj virtual
congelado a través del parámetro oficial `now` de `chooseHumanChallengeMCTSDecision`: todas las
decisiones completan su presupuesto de 250/500 simulaciones. **Ningún parámetro de búsqueda se
modifica** y el cambio afecta exactamente igual a los dos colores. `summary.json` registra que
el número de decisiones cortadas por tiempo es cero.

## Datos humanos congelados

Este experimento no toca `data/human-experiment/final-2026-v3-r1`. El validador comprueba que
el árbol de Git de esa carpeta sigue siendo `c37c8db86ea74fd2df0b1b6398e046140b7de6a5`, el del
commit `941368c`, tanto en el historial como en el árbol de trabajo.
