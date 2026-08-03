import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SELF_PLAY_OUTPUT_DIRECTORY } from '@/experiments/mctsSelfPlayColorBias'
import type { SelfPlayColorBiasSummary } from './mctsSelfPlayColorBiasAnalysis'
import {
  SELF_PLAY_RUN_COMMAND,
  SELF_PLAY_VALIDATE_COMMAND,
  parseArgs,
  toCsv,
} from './runMCTSSelfPlayColorBias'

export const TECHNICAL_REPORT_FILE = 'informe-tecnico.md'
export const PLAIN_SUMMARY_FILE = 'resumen-bachillerato.md'
export const TR_TABLE_FILE = 'resumen-tr.csv'

interface ReportMetadata {
  implementationCommit: string
  startedAt: string
  finishedAt: string
  runtime: { node: string; platform: string; workers: number; latencyGuardMs: number }
  agent: { configSha256: string }
}

function decimal(value: number, digits = 2): string {
  return value.toFixed(digits).replace('.', ',')
}

function percent(value: number): string {
  return `${decimal(value, 1)} %`
}

function interval(ci: { low: number; high: number }, digits = 4): string {
  return `[${decimal(ci.low, digits)} ; ${decimal(ci.high, digits)}]`
}

function pValue(value: number): string {
  return value < 0.0001 ? 'p < 0,0001' : `p = ${decimal(value, 4)}`
}

/** Rows of the compact table meant to be pasted into the research project. */
export function buildTrTable(summary: SelfPlayColorBiasSummary) {
  const outcomes = summary.outcomes
  const colour = summary.inference.primaryColourTest
  const territory = summary.inference.primaryTerritoryTest
  return [
    { magnitud: 'Partidas jugadas', valor: outcomes.games },
    { magnitud: 'Parejas', valor: summary.pairAnalysis.pairs },
    { magnitud: 'Victorias de rojo', valor: outcomes.redWins },
    { magnitud: 'Victorias de azul', valor: outcomes.blueWins },
    { magnitud: 'Empates', valor: outcomes.ties },
    { magnitud: 'Porcentaje de victorias de rojo', valor: outcomes.redWinPercentage },
    { magnitud: 'Porcentaje de victorias de azul', valor: outcomes.blueWinPercentage },
    { magnitud: 'Porcentaje de empates', valor: outcomes.tiePercentage },
    { magnitud: 'Territorio medio de rojo', valor: summary.territory.meanRed },
    { magnitud: 'Territorio medio de azul', valor: summary.territory.meanBlue },
    { magnitud: 'Diferencia media de territorio (R - A)', valor: summary.territory.diff.mean },
    { magnitud: 'Mediana de la diferencia de territorio', valor: summary.territory.diff.median },
    {
      magnitud: 'Desviación típica de la diferencia',
      valor: summary.territory.diff.standardDeviation,
    },
    { magnitud: 'Turnos medios por partida', valor: summary.turns.meanTotalDecisions },
    { magnitud: 'Movimientos medios de rojo', valor: summary.actions.meanRedMoves },
    { magnitud: 'Movimientos medios de azul', valor: summary.actions.meanBlueMoves },
    { magnitud: 'Muros medios de rojo', valor: summary.actions.meanRedWalls },
    { magnitud: 'Muros medios de azul', valor: summary.actions.meanBlueWalls },
    { magnitud: 'Duración media por partida (ms)', valor: summary.duration.meanMs },
    { magnitud: 'Puntuación media de rojo por pareja', valor: colour.mean },
    { magnitud: 'IC 95 % de la puntuación (inferior)', valor: colour.ci95.low },
    { magnitud: 'IC 95 % de la puntuación (superior)', valor: colour.ci95.high },
    { magnitud: 'p de Wilcoxon (color)', valor: summary.inference.colourWilcoxon.pValue },
    {
      magnitud: 'p del signo exacto (sensibilidad)',
      valor: summary.inference.sensitivityGameLevel.pValue,
    },
    { magnitud: 'd de Cohen (color)', valor: summary.effectSizes.colourCohensD },
    { magnitud: 'h de Cohen (color)', valor: summary.effectSizes.colourCohensH },
    { magnitud: 'Diferencia media de territorio por pareja', valor: territory.mean },
    { magnitud: 'IC 95 % del territorio (inferior)', valor: territory.ci95.low },
    { magnitud: 'IC 95 % del territorio (superior)', valor: territory.ci95.high },
    { magnitud: 'd de Cohen (territorio)', valor: summary.effectSizes.territoryCohensD },
    {
      magnitud: 'Correlación intraclase dentro de la pareja',
      valor: summary.inference.dependence.intraPairCorrelation,
    },
    { magnitud: 'Efecto de diseño', valor: summary.inference.dependence.designEffect },
  ]
}

function colourVerdict(summary: SelfPlayColorBiasSummary): string {
  if (!summary.findings.colourEffectDetected)
    return (
      'No se detecta ninguna ventaja sistemática de color con este tamaño de muestra. ' +
      'El intervalo de confianza del 95 % de la puntuación media de rojo por pareja, ' +
      `${interval(summary.inference.primaryColourTest.ci95)}, contiene el valor 0,5 previsto ` +
      'por la hipótesis de simetría.'
    )
  return (
    `Se detecta una desviación estadísticamente apreciable ${
      summary.findings.direction === 'favours-red' ? 'a favor de rojo' : 'a favor de azul'
    }. El intervalo de confianza del 95 % de la puntuación media de rojo por pareja, ` +
    `${interval(summary.inference.primaryColourTest.ci95)}, no contiene 0,5.`
  )
}

function streamVerdict(summary: SelfPlayColorBiasSummary): string {
  return summary.findings.seedStreamEffectDetected
    ? 'El control de flujos de aleatoriedad **sí** se desvía de 0,5, de modo que parte de la ' +
        'variación observada procede de las semillas concretas y no del color.'
    : 'El control de flujos de aleatoriedad no se desvía de 0,5, lo que indica que ninguna de ' +
        'las dos secuencias de semillas de cada pareja resultó sistemáticamente afortunada.'
}

export function buildTechnicalReport(
  summary: SelfPlayColorBiasSummary,
  metadata: ReportMetadata,
): string {
  const outcomes = summary.outcomes
  const colour = summary.inference.primaryColourTest
  const territory = summary.inference.primaryTerritoryTest
  const pairs = summary.pairAnalysis
  const detected = summary.findings.colourEffectDetected
  return `# Autoenfrentamiento MCTS: ¿existe ventaja de color u orden de juego?

Experimento \`${summary.experimentId}\`. Generado el ${summary.generatedAt}.
Commit de implementación: \`${metadata.implementationCommit}\`.
Huella SHA-256 de la configuración: \`${metadata.agent.configSha256}\`.

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

**Variables controladas.** Configuración del agente (\`FINAL_HUMAN_CHALLENGE_MCTS_CONFIG\`,
idéntica en ambos colores y verificada por huella criptográfica); reglas del juego y posición
inicial oficiales, sin modificar; semillas deterministas registradas; presupuesto de simulación
por decisión; ausencia de recortes por tiempo; commit de implementación único para las 200
partidas; motor de partida y funciones de territorio, turno y final de partida oficiales del
proyecto.

## 4. Procedimiento

1. Se construye un plan determinista de ${pairs.pairs} parejas y ${outcomes.games} partidas.
2. Cada pareja define dos flujos de semillas, alfa y beta, separados por bloques disjuntos.
3. La partida *directa* asigna alfa a rojo y beta a azul; la partida *intercambiada* asigna
   beta a rojo y alfa a azul. Así cada flujo juega exactamente una vez con cada color.
4. Cada decisión de un agente consume la semilla \`baseDelLado + índiceDeDecisiónDeEseLado\`,
   con lo que la partida es independiente del orden de ejecución y se puede repetir aislada.
5. Las partidas se juegan hasta el final con las funciones oficiales del proyecto
   (\`makeInitialState\`, \`getLegalActions\`, \`applyFullAction\`, \`checkGameEnd\`,
   \`getTerritoryMap\`). No se ha tocado ninguna regla ni el orden inicial de juego.
6. Se guardan las ${outcomes.games} partidas individuales con su secuencia completa de acciones
   y su huella SHA-256, más un CSV tabular, un resumen agregado y un manifiesto de integridad.
7. Un validador independiente comprueba el conjunto y vuelve a jugar una muestra de partidas.

Comandos: \`${SELF_PLAY_RUN_COMMAND}\` y \`${SELF_PLAY_VALIDATE_COMMAND}\`.
Entorno: Node ${metadata.runtime.node}, ${metadata.runtime.platform},
${metadata.runtime.workers} procesos en paralelo, del ${metadata.startedAt} al
${metadata.finishedAt}.

## 5. Resultados

### 5.1 Reparto de victorias

| Resultado | Partidas | Porcentaje |
| --- | ---: | ---: |
| Victorias de rojo | ${outcomes.redWins} | ${percent(outcomes.redWinPercentage)} |
| Victorias de azul | ${outcomes.blueWins} | ${percent(outcomes.blueWinPercentage)} |
| Empates | ${outcomes.ties} | ${percent(outcomes.tiePercentage)} |
| **Total** | **${outcomes.games}** | **100 %** |

Puntuación media de rojo por partida: ${decimal(outcomes.meanRedScore, 4)}.
Entre las ${outcomes.decisiveGames} partidas decisivas, rojo gana el
${percent(outcomes.redWinPercentageAmongDecisive)}.

### 5.2 Territorio

| Magnitud | Valor |
| --- | ---: |
| Territorio medio de rojo | ${decimal(summary.territory.meanRed)} |
| Territorio medio de azul | ${decimal(summary.territory.meanBlue)} |
| Diferencia media (R − A) | ${decimal(summary.territory.diff.mean)} |
| Mediana de la diferencia | ${decimal(summary.territory.diff.median)} |
| Desviación típica de la diferencia | ${decimal(summary.territory.diff.standardDeviation)} |
| Diferencia mínima / máxima | ${summary.territory.diff.min} / ${summary.territory.diff.max} |

### 5.3 Desarrollo de las partidas

| Magnitud | Rojo | Azul |
| --- | ---: | ---: |
| Decisiones por partida | ${decimal(summary.turns.meanRedDecisions)} | ${decimal(summary.turns.meanBlueDecisions)} |
| Movimientos por partida | ${decimal(summary.actions.meanRedMoves)} | ${decimal(summary.actions.meanBlueMoves)} |
| Muros por partida | ${decimal(summary.actions.meanRedWalls)} | ${decimal(summary.actions.meanBlueWalls)} |
| Colocaciones iniciales | ${decimal(summary.actions.meanRedPlacements)} | ${decimal(summary.actions.meanBluePlacements)} |

Turnos medios por partida: ${decimal(summary.turns.meanTotalDecisions)} decisiones
(mediana ${decimal(summary.turns.medianTotalDecisions)}). Duración media:
${decimal(summary.duration.meanMs / 1000, 1)} s por partida.
Motivos de finalización: ${Object.entries(summary.termination)
    .map(([reason, count]) => `${reason} = ${count}`)
    .join('; ')}.
Ninguna decisión se cortó por límite temporal
(${summary.searchDiagnostics.stoppedByTimeLimit} de ${summary.searchDiagnostics.decisions}).

### 5.4 Resultados emparejados

| Concordancia dentro de la pareja | Parejas |
| --- | ---: |
| Gana el mismo color las dos partidas | ${pairs.colourWinnerAgreement['same-colour-twice']} |
| El ganador cambia de color entre las dos partidas | ${pairs.colourWinnerAgreement['split-between-colours']} |
| Alguna de las dos partidas acaba en empate | ${pairs.colourWinnerAgreement['involves-tie']} |

| Concordancia por flujo de semillas | Parejas |
| --- | ---: |
| Gana el mismo flujo las dos partidas | ${pairs.streamWinnerAgreement['same-stream-twice']} |
| El ganador cambia de flujo | ${pairs.streamWinnerAgreement['split-between-streams']} |
| Alguna partida acaba en empate | ${pairs.streamWinnerAgreement['involves-tie']} |

## 6. Análisis estadístico

### 6.1 Elección de la prueba

Las dos partidas de una pareja comparten los mismos dos flujos de semillas, de modo que **no
se puede dar por supuesto que sean independientes**. Por eso la unidad de análisis es la
pareja y no la partida: hay ${pairs.pairs} unidades independientes, no ${outcomes.games}.
Todas las pruebas principales se aplican a valores por pareja. La prueba binomial por partida
se ofrece únicamente como análisis de sensibilidad, acompañada de la correlación intraclase
que permite juzgar si esa suposición de independencia era razonable.

La correlación intraclase medida es
${decimal(summary.inference.dependence.intraPairCorrelation, 4)} y el efecto de diseño
correspondiente es ${decimal(summary.inference.dependence.designEffect, 4)}.
${
  Math.abs(summary.inference.dependence.designEffect - 1) < 0.25
    ? 'Al estar próximo a 1, el análisis por parejas y el análisis por partidas coinciden en la práctica.'
    : 'Al apartarse de 1, la prueba por partidas sería demasiado optimista y prevalece el análisis por parejas.'
}

### 6.2 Prueba principal sobre el color

- Estadístico: puntuación media de rojo por pareja = ${decimal(colour.mean, 4)}.
- Bootstrap por conglomerados (${colour.iterations} remuestreos de parejas, semilla
  ${colour.seed}): IC 95 % = ${interval(colour.ci95)}.
- Wilcoxon de rangos con signo frente a 0,5: ${pValue(summary.inference.colourWilcoxon.pValue)}
  (n = ${summary.inference.colourWilcoxon.nonZero} parejas con diferencia no nula).
- Prueba z sobre las medias por pareja: z = ${decimal(summary.inference.colourZTest.z, 3)},
  ${pValue(summary.inference.colourZTest.pValue)}.

### 6.3 Prueba principal sobre el territorio

- Diferencia media de territorio por pareja = ${decimal(territory.mean, 4)}.
- Bootstrap por conglomerados: IC 95 % = ${interval(territory.ci95)}.
- Wilcoxon frente a 0: ${pValue(summary.inference.territoryWilcoxon.pValue)}.
- Prueba z: z = ${decimal(summary.inference.territoryZTest.z, 3)},
  ${pValue(summary.inference.territoryZTest.pValue)}.

### 6.4 Análisis de sensibilidad y control

- Signo exacto bilateral sobre las ${outcomes.decisiveGames} partidas decisivas
  (${outcomes.redWins} frente a ${outcomes.blueWins}):
  ${pValue(summary.inference.sensitivityGameLevel.pValue)}.
- IC 95 % de Wilson para el porcentaje de victorias de rojo sobre las ${outcomes.games}
  partidas: ${percent(summary.inference.sensitivityGameLevel.wilson95RedWinPercentage.low)} –
  ${percent(summary.inference.sensitivityGameLevel.wilson95RedWinPercentage.high)}.
- Control negativo de aleatoriedad: puntuación media del flujo alfa =
  ${decimal(summary.inference.seedStreamControl.mean, 4)}, IC 95 % =
  ${interval(summary.inference.seedStreamControl.ci95)}.

### 6.5 Tamaño del efecto

| Medida | Valor | Magnitud |
| --- | ---: | --- |
| h de Cohen (victorias de rojo frente a 0,5) | ${decimal(summary.effectSizes.colourCohensH, 4)} | — |
| d de Cohen (puntuación por pareja) | ${decimal(summary.effectSizes.colourCohensD, 4)} | ${summary.effectSizes.colourCohensDLabel} |
| d de Cohen (territorio por pareja) | ${decimal(summary.effectSizes.territoryCohensD, 4)} | ${summary.effectSizes.territoryCohensDLabel} |
| Correlación biserial de rangos (color) | ${decimal(summary.effectSizes.colourRankBiserial, 4)} | — |

## 7. Interpretación

${colourVerdict(summary)}

${streamVerdict(summary)}

Conviene separar con cuidado cinco explicaciones que este diseño **no** distingue por igual:

1. **Ventaja del color en sí.** En este juego el color es solo una etiqueta: la posición
   inicial es exactamente simétrica al reflejar el tablero en horizontal e intercambiar los
   colores. Por tanto, un efecto de color puro no tendría contenido geométrico.
2. **Ventaja de jugar primero.** Rojo coloca la primera piedra y realiza la primera acción de
   la fase de juego en las ${outcomes.games} partidas, porque así lo definen las reglas. Color
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
   ${pairs.colourWinnerAgreement['split-between-colours']} de las ${pairs.pairs} parejas el
   ganador cambia de color entre las dos partidas, lo que muestra que buena parte de la
   variación observada es ruido propio del método.

${
  detected
    ? 'La conclusión prudente es que existe una asimetría medible, atribuible sobre todo al ' +
      'turno inicial, y que no debe presentarse como una propiedad del color.'
    : 'La conclusión prudente es que, con 200 partidas, no hay pruebas de asimetría; esto no ' +
      'demuestra que la simetría sea perfecta, solo que un desequilibrio mayor que el ancho ' +
      'del intervalo de confianza habría sido poco probable pasar por alto.'
}

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
   del parámetro oficial \`now\`, de manera que todas las decisiones completan su presupuesto de
   250/500 simulaciones. Ningún parámetro de búsqueda se ha modificado y el cambio afecta por
   igual a los dos colores; a cambio, el experimento es completamente reproducible.
4. **Potencia estadística limitada.** Con 100 parejas solo se pueden detectar con fiabilidad
   desequilibrios de tamaño moderado; un sesgo muy pequeño podría pasar inadvertido.
5. **Un solo agente y un solo tablero.** Los resultados describen esta configuración concreta
   del MCTS en el tablero de 7 × 7 con 4 piedras por jugador, y no se pueden extrapolar a otras
   configuraciones ni a jugadores humanos.

## 9. Conclusión

Con ${outcomes.games} partidas de la IA final contra una copia idéntica de sí misma, repartidas
en ${pairs.pairs} parejas con intercambio de color de los flujos de aleatoriedad, el reparto
observado es ${outcomes.redWins} victorias de rojo, ${outcomes.blueWins} de azul y
${outcomes.ties} empates. ${colourVerdict(summary)} La diferencia media de territorio es de
${decimal(summary.territory.diff.mean)} puntos a favor de
${summary.territory.diff.mean >= 0 ? 'rojo' : 'azul'}, con un intervalo de confianza del 95 %
de ${interval(territory.ci95, 2)}.

${
  detected
    ? 'El resultado es compatible con una ventaja estructural de quien juega primero y debe ' +
      'describirse así, no como una ventaja del color rojo.'
    : 'El resultado es compatible con la hipótesis de partida: el sistema no muestra una ' +
      'ventaja sistemática asociada al color ni al orden de juego que sea detectable con este ' +
      'tamaño de muestra.'
} El experimento es reproducible: las mismas semillas y el mismo commit reproducen
exactamente las mismas 200 partidas.
`
}

export function buildPlainSummary(summary: SelfPlayColorBiasSummary): string {
  const outcomes = summary.outcomes
  const colour = summary.inference.primaryColourTest
  const detected = summary.findings.colourEffectDetected
  return `# Resumen sencillo del experimento de autoenfrentamiento

## ¿Qué queríamos saber?

En Wall Go siempre empieza el jugador rojo. Nos preguntamos si eso da alguna ventaja. Para
averiguarlo hicimos que la inteligencia artificial del proyecto jugara contra una copia
exactamente igual a ella misma. Como las dos son idénticas, si una gana más veces no puede ser
porque juegue mejor: tiene que ser por algo del propio juego, como el orden de los turnos.

## ¿Cómo lo hicimos?

Jugamos ${outcomes.games} partidas ordenadas en ${summary.pairAnalysis.pairs} parejas. En cada
pareja se juegan dos partidas iguales pero con los papeles cambiados: la serie de números
aleatorios que llevaba el rojo pasa a llevarla el azul. Así, si una serie de números tenía
suerte, esa suerte se reparte entre los dos colores y no falsea el resultado.

Todas las partidas usan exactamente la misma configuración de la IA, con semillas anotadas, de
modo que cualquiera puede volver a ejecutarlas y obtener el mismo resultado.

## ¿Qué salió?

- Rojo ganó ${outcomes.redWins} partidas (${percent(outcomes.redWinPercentage)}).
- Azul ganó ${outcomes.blueWins} partidas (${percent(outcomes.blueWinPercentage)}).
- Hubo ${outcomes.ties} empates (${percent(outcomes.tiePercentage)}).
- De media, rojo terminó con ${decimal(summary.territory.meanRed)} casillas de territorio y
  azul con ${decimal(summary.territory.meanBlue)}.

Para decidir si esa diferencia es real o es simple casualidad calculamos un intervalo de
confianza del 95 %. Un intervalo de confianza es el rango de valores donde razonablemente
esperamos que esté el resultado verdadero. Aquí va de ${interval(colour.ci95)} para la
puntuación media del rojo, donde 0,5 significaría empate perfecto entre colores.

## ¿Qué significa?

${
  detected
    ? `El 0,5 queda fuera de ese intervalo, así que la diferencia es demasiado grande para ` +
      `explicarla solo por casualidad. La explicación más probable es que jugar primero da algo ` +
      `de ventaja, no que el color rojo tenga nada especial: de hecho el tablero es simétrico y, ` +
      `si se le da la vuelta, rojo y azul empiezan exactamente igual.`
    : `El 0,5 queda dentro de ese intervalo, así que la pequeña diferencia que vemos es ` +
      `perfectamente compatible con la casualidad. Con ${outcomes.games} partidas no encontramos ` +
      `pruebas de que empezar primero dé ventaja.`
}

Hay que tener cuidado con una cosa importante: como las reglas dicen que rojo empieza siempre,
no podemos separar "ser rojo" de "jugar primero". Son la misma cosa en este experimento. Y
tampoco podemos afirmar que la simetría sea perfecta: solo que, si hay un desequilibrio, es
más pequeño que lo que ${outcomes.games} partidas permiten detectar.

## Conclusión en una frase

${
  detected
    ? 'Dos IA idénticas no reparten las victorias al 50 %, y la causa más razonable es la ' +
      'ventaja de mover primero.'
    : 'Dos IA idénticas reparten las victorias de forma aproximadamente equilibrada, tal como ' +
      'predecía la hipótesis.'
}
`
}

export function generateSelfPlayReports(outputDir: string) {
  const summary = JSON.parse(
    readFileSync(path.join(outputDir, 'summary.json'), 'utf8'),
  ) as SelfPlayColorBiasSummary
  const metadata = JSON.parse(
    readFileSync(path.join(outputDir, 'metadata.json'), 'utf8'),
  ) as ReportMetadata
  writeFileSync(
    path.join(outputDir, TECHNICAL_REPORT_FILE),
    buildTechnicalReport(summary, metadata),
    'utf8',
  )
  writeFileSync(path.join(outputDir, PLAIN_SUMMARY_FILE), buildPlainSummary(summary), 'utf8')
  writeFileSync(path.join(outputDir, TR_TABLE_FILE), toCsv(buildTrTable(summary)), 'utf8')
  return { summary, metadata }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const outputDir = path.resolve(args.output ?? SELF_PLAY_OUTPUT_DIRECTORY)
  generateSelfPlayReports(outputDir)
  console.log(`Reports written to ${outputDir}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
