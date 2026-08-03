# Autoenfrentamiento MCTS: ¿existe ventaja de color u orden de juego?

Experimento `WGTR-MCTS-SELFPLAY-COLOR-BIAS-2026-V1`. Generado el 2026-08-03T15:54:27.871Z.
Commit de implementación: `52105edc963c85c23b3ed5d8a7297117bdb3cd73`.
Huella SHA-256 de la configuración: `7d137f48f941045742aacbeeadffcd8db036477e355a2f8c61aace3af4e7fca8`.

## 1. Objetivo

Comprobar si, cuando la IA final del proyecto se enfrenta a una copia exactamente idéntica de
sí misma, el reparto de victorias entre el color rojo y el color azul se aparta de un reparto
equilibrado. El objetivo no es decidir qué IA es mejor —son la misma— sino medir si el sistema
de juego, el orden de turno o la implementación introducen una asimetría sistemática.

## 2. Hipótesis

Si dos agentes MCTS idénticos se enfrentan con la misma configuración, el porcentaje de
victorias debería repartirse de forma aproximadamente equilibrada entre ambos colores, salvo
que exista una ventaja estructural ligada al turno inicial, al orden de colocación, al consumo
de números aleatorios o a alguna asimetría de la implementación.

- Hipótesis nula: la puntuación media de rojo por pareja es 0,5.
- Hipótesis alternativa (bilateral): la puntuación media de rojo por pareja no es 0,5.

## 3. Variables

**Variable independiente.** El color asignado a cada uno de los dos flujos de aleatoriedad de
la pareja: rojo o azul. Es la única cosa que cambia entre las dos partidas de una misma pareja.

**Variables dependientes.** Ganador de la partida; puntuación de rojo (1 victoria, 0,5 empate,
0 derrota); territorio de rojo; territorio de azul; diferencia de territorio; número de turnos;
número de movimientos y de muros de cada color; duración de la partida.

**Variables controladas.** Configuración del agente (`FINAL_HUMAN_CHALLENGE_MCTS_CONFIG`,
idéntica en ambos colores y verificada por huella criptográfica); reglas del juego y posición
inicial oficiales, sin modificar; semillas deterministas registradas; presupuesto de simulación
por decisión; ausencia de recortes por tiempo; commit de implementación único para las 200
partidas; motor de partida y funciones de territorio, turno y final de partida oficiales del
proyecto.

## 4. Procedimiento

1. Se construye un plan determinista de 5 parejas y 10 partidas.
2. Cada pareja define dos flujos de semillas, alfa y beta, separados por bloques disjuntos.
3. La partida *directa* asigna alfa a rojo y beta a azul; la partida *intercambiada* asigna
   beta a rojo y alfa a azul. Así cada flujo juega exactamente una vez con cada color.
4. Cada decisión de un agente consume la semilla `baseDelLado + índiceDeDecisiónDeEseLado`,
   con lo que la partida es independiente del orden de ejecución y se puede repetir aislada.
5. Las partidas se juegan hasta el final con las funciones oficiales del proyecto
   (`makeInitialState`, `getLegalActions`, `applyFullAction`, `checkGameEnd`,
   `getTerritoryMap`). No se ha tocado ninguna regla ni el orden inicial de juego.
6. Se guardan las 10 partidas individuales con su secuencia completa de acciones
   y su huella SHA-256, más un CSV tabular, un resumen agregado y un manifiesto de integridad.
7. Un validador independiente comprueba el conjunto y vuelve a jugar una muestra de partidas.

Comandos: `npm run experiment:mcts-selfplay-color-bias` y `npm run experiment:mcts-selfplay-color-bias:validate`.
Entorno: Node v24.16.0, win32,
10 procesos en paralelo, del 2026-08-03T15:43:08.759Z al
2026-08-03T15:54:27.858Z.

## 5. Resultados

### 5.1 Reparto de victorias

| Resultado | Partidas | Porcentaje |
| --- | ---: | ---: |
| Victorias de rojo | 3 | 30,0 % |
| Victorias de azul | 7 | 70,0 % |
| Empates | 0 | 0,0 % |
| **Total** | **10** | **100 %** |

Puntuación media de rojo por partida: 0,3000.
Entre las 10 partidas decisivas, rojo gana el
30,0 %.

### 5.2 Territorio

| Magnitud | Valor |
| --- | ---: |
| Territorio medio de rojo | 15,70 |
| Territorio medio de azul | 18,70 |
| Diferencia media (R − A) | -3,00 |
| Mediana de la diferencia | -5,50 |
| Desviación típica de la diferencia | 10,08 |
| Diferencia mínima / máxima | -17 / 14 |

### 5.3 Desarrollo de las partidas

| Magnitud | Rojo | Azul |
| --- | ---: | ---: |
| Decisiones por partida | 28,30 | 27,90 |
| Movimientos por partida | 23,80 | 23,50 |
| Muros por partida | 26,30 | 25,90 |
| Colocaciones iniciales | 2,00 | 2,00 |

Turnos medios por partida: 56,20 decisiones
(mediana 54,50). Duración media:
652,5 s por partida.
Motivos de finalización: all-territory-closed = 10; all-players-blocked = 0; no-legal-actions = 0; safety-limit = 0.
Ninguna decisión se cortó por límite temporal
(0 de 562).

### 5.4 Resultados emparejados

| Concordancia dentro de la pareja | Parejas |
| --- | ---: |
| Gana el mismo color las dos partidas | 2 |
| El ganador cambia de color entre las dos partidas | 3 |
| Alguna de las dos partidas acaba en empate | 0 |

| Concordancia por flujo de semillas | Parejas |
| --- | ---: |
| Gana el mismo flujo las dos partidas | 3 |
| El ganador cambia de flujo | 2 |
| Alguna partida acaba en empate | 0 |

## 6. Análisis estadístico

### 6.1 Elección de la prueba

Las dos partidas de una pareja comparten los mismos dos flujos de semillas, de modo que **no
se puede dar por supuesto que sean independientes**. Por eso la unidad de análisis es la
pareja y no la partida: hay 5 unidades independientes, no 10.
Todas las pruebas principales se aplican a valores por pareja. La prueba binomial por partida
se ofrece únicamente como análisis de sensibilidad, acompañada de la correlación intraclase
que permite juzgar si esa suposición de independencia era razonable.

La correlación intraclase medida es
-0,3333 y el efecto de diseño
correspondiente es 0,6667.
Al apartarse de 1, la prueba por partidas sería demasiado optimista y prevalece el análisis por parejas.

### 6.2 Prueba principal sobre el color

- Estadístico: puntuación media de rojo por pareja = 0,3000.
- Bootstrap por conglomerados (10000 remuestreos de parejas, semilla
  2026080301): IC 95 % = [0,100 ; 0,500].
- Wilcoxon de rangos con signo frente a 0,5: p = 0,3458
  (n = 2 parejas con diferencia no nula).
- Prueba z sobre las medias por pareja: z = -1,633,
  p = 0,1025.

### 6.3 Prueba principal sobre el territorio

- Diferencia media de territorio por pareja = -3,0000.
- Bootstrap por conglomerados: IC 95 % = [-9,300 ; 2,600].
- Wilcoxon frente a 0: p = 0,7865.
- Prueba z: z = -0,876,
  p = 0,3810.

### 6.4 Análisis de sensibilidad y control

- Signo exacto bilateral sobre las 10 partidas decisivas
  (3 frente a 7):
  p = 0,3438.
- IC 95 % de Wilson para el porcentaje de victorias de rojo sobre las 10
  partidas: 10,8 % –
  60,3 %.
- Control negativo de aleatoriedad: puntuación media del flujo alfa =
  0,8000, IC 95 % =
  [0,600 ; 1,000].

### 6.5 Tamaño del efecto

| Medida | Valor | Magnitud |
| --- | ---: | --- |
| h de Cohen (victorias de rojo frente a 0,5) | -0,4115 | — |
| d de Cohen (puntuación por pareja) | -0,7303 | medium |
| d de Cohen (territorio por pareja) | -0,3918 | small |
| Correlación biserial de rangos (color) | -1,0000 | — |

## 7. Interpretación

No se detecta ninguna ventaja sistemática de color con este tamaño de muestra. El intervalo de confianza del 95 % de la puntuación media de rojo por pareja, [0,100 ; 0,500], contiene el valor 0,5 previsto por la hipótesis de simetría.

El control de flujos de aleatoriedad **sí** se desvía de 0,5, de modo que parte de la variación observada procede de las semillas concretas y no del color.

Conviene separar con cuidado cinco explicaciones que este diseño **no** distingue por igual:

1. **Ventaja del color en sí.** En este juego el color es solo una etiqueta: la posición
   inicial es exactamente simétrica al reflejar el tablero en horizontal e intercambiar los
   colores. Por tanto, un efecto de color puro no tendría contenido geométrico.
2. **Ventaja de jugar primero.** Rojo coloca la primera piedra y realiza la primera acción de
   la fase de juego en las 10 partidas, porque así lo definen las reglas. Color
   y turno inicial quedan por tanto **completamente confundidos**: si apareciera una ventaja,
   esta sería la explicación más plausible, pero el diseño no puede demostrarlo por separado
   sin alterar las reglas, cosa que este experimento no hace.
3. **Orden de colocación inicial.** La colocación sigue el orden R, A, A, R, que ya está
   equilibrado; aun así rojo coloca la primera piedra, lo que forma parte del mismo bloque
   confundido con el turno inicial.
4. **Consumo de números aleatorios.** El intercambio de flujos dentro de cada pareja hace que
   el contraste de color y el contraste de flujo sean ortogonales, y el control del apartado
   6.4 mide directamente esta fuente.
5. **Variación normal del MCTS.** El MCTS es estocástico: en
   3 de las 5 parejas el
   ganador cambia de color entre las dos partidas, lo que muestra que buena parte de la
   variación observada es ruido propio del método.

La conclusión prudente es que, con 200 partidas, no hay pruebas de asimetría; esto no demuestra que la simetría sea perfecta, solo que un desequilibrio mayor que el ancho del intervalo de confianza habría sido poco probable pasar por alto.

## 8. Limitaciones

1. **Color y turno inicial están confundidos por diseño.** Las reglas fijan que rojo empieza y
   no se han alterado, de modo que este experimento mide el bloque conjunto "ser rojo y jugar
   primero", no cada componente por separado.
2. **El intercambio de flujos no es un intercambio perfecto de aleatoriedad.** Cada decisión
   reinicia su generador a partir de la semilla y del índice de decisión, y el consumo de
   números aleatorios depende del estado del tablero. En cuanto las dos partidas de una pareja
   divergen, las tiradas dejan de ser comparables una a una. El emparejamiento garantiza que
   ningún flujo quede asignado sistemáticamente a un color, pero no reproduce las mismas
   tiradas en el papel contrario; era la simetría más fuerte posible sin modificar la
   arquitectura.
3. **Se ha desactivado el límite de latencia de 5 s por decisión.** Ese límite existe para la
   comodidad del usuario en la interfaz y, medido contra el reloj real, haría que el resultado
   dependiera de la carga de la máquina. Se sustituye por un reloj virtual congelado a través
   del parámetro oficial `now`, de manera que todas las decisiones completan su presupuesto de
   250/500 simulaciones. Ningún parámetro de búsqueda se ha modificado y el cambio afecta por
   igual a los dos colores; a cambio, el experimento es completamente reproducible.
4. **Potencia estadística limitada.** Con 100 parejas solo se pueden detectar con fiabilidad
   desequilibrios de tamaño moderado; un sesgo muy pequeño podría pasar inadvertido.
5. **Un solo agente y un solo tablero.** Los resultados describen esta configuración concreta
   del MCTS en el tablero de 7 × 7 con 4 piedras por jugador, y no se pueden extrapolar a otras
   configuraciones ni a jugadores humanos.

## 9. Conclusión

Con 10 partidas de la IA final contra una copia idéntica de sí misma, repartidas
en 5 parejas con intercambio de color de los flujos de aleatoriedad, el reparto
observado es 3 victorias de rojo, 7 de azul y
0 empates. No se detecta ninguna ventaja sistemática de color con este tamaño de muestra. El intervalo de confianza del 95 % de la puntuación media de rojo por pareja, [0,100 ; 0,500], contiene el valor 0,5 previsto por la hipótesis de simetría. La diferencia media de territorio es de
-3,00 puntos a favor de
azul, con un intervalo de confianza del 95 %
de [-9,30 ; 2,60].

El resultado es compatible con la hipótesis de partida: el sistema no muestra una ventaja sistemática asociada al color ni al orden de juego que sea detectable con este tamaño de muestra. El experimento es reproducible: las mismas semillas y el mismo commit reproducen
exactamente las mismas 200 partidas.
