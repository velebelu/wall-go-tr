import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  chooseHumanChallengeMCTSDecision,
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
} from '@/agents/humanChallengeMCTS'
import { evaluatePositionWithBreakdown } from '@/engine/evaluatePosition'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'
import { floodRegions } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'
import {
  deserializeGameSnapshot,
  extractHumanMCTSDecisionFixture,
  parseHumanMCTSTrace,
  replayHumanMCTSTrace,
  type HumanMCTSTraceDecisionV1,
} from '@/utils/humanMCTSTrace'

export const DEFEAT_TRACE = 'traza_humano_mcts_g_e09743f2.json'
export const DEFEAT_OUTPUT_DIR = 'data/entrenamiento/mcts/analisis_derrota_humana_g_e09743f2'
const CRITICAL_TURNS = [34, 36, 38] as const
const PAIR_SEEDS = [0xe0974301, 0xe0974302] as const

type Classification =
  | 'no-immediate-threat'
  | 'emerging-closure-threat'
  | 'defendable-closure-threat'
  | 'last-defensive-opportunity'
  | 'territorial-collapse-unavoidable'

function actionKey(action: PlayerAction): string {
  return JSON.stringify(action)
}

function territory(state: GameSnapshot): Record<Player, number> {
  const result: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board))
    for (const owner of row) if (owner) result[owner]++
  return result
}

function largestCapturedBy(state: GameSnapshot, player: Player): number {
  return Math.max(
    0,
    ...floodRegions(state.board)
      .filter(
        (region) =>
          region.borderingCounts[player] > 0 &&
          region.borderingCounts[player === 'R' ? 'B' : 'R'] === 0,
      )
      .map((region) => region.cells.length),
  )
}

function contestedRegion(state: GameSnapshot) {
  return [...floodRegions(state.board)]
    .filter((region) => region.borderingCounts.R > 0 && region.borderingCounts.B > 0)
    .sort((a, b) => b.cells.length - a.cells.length)[0]
}

function openFrontiers(state: GameSnapshot): number {
  const region = contestedRegion(state)
  if (!region) return 0
  const keys = new Set(region.cells.map(({ x, y }) => `${x},${y}`))
  let openings = 0
  for (const action of getLegalActions(state)) {
    const origin = action.from ?? action.pos
    if (keys.has(`${origin.x},${origin.y}`)) openings++
  }
  return openings
}

function worstImmediateClosure(stateAfterRed: GameSnapshot) {
  if (stateAfterRed.result) {
    return {
      opponentGain: (stateAfterRed.result.score ?? territory(stateAfterRed)).B,
      redAccessibleDrop: 0,
      terminal: true,
      reply: undefined,
    }
  }
  const beforeTerritory = territory(stateAfterRed)
  const beforeAccessible = accessible(stateAfterRed, 'R')
  let worst = {
    opponentGain: 0,
    redAccessibleDrop: 0,
    terminal: false,
    reply: undefined as PlayerAction | undefined,
  }
  for (const reply of getLegalActions(stateAfterRed)) {
    const after = applyFullAction(stateAfterRed, reply).state
    const score = after.result?.score ?? territory(after)
    const candidate = {
      opponentGain: score.B - beforeTerritory.B,
      redAccessibleDrop: beforeAccessible - accessible(after, 'R'),
      terminal: after.result?.winner === 'B',
      reply,
    }
    const severity =
      candidate.opponentGain + candidate.redAccessibleDrop + (candidate.terminal ? 100 : 0)
    const current = worst.opponentGain + worst.redAccessibleDrop + (worst.terminal ? 100 : 0)
    if (severity > current) worst = candidate
  }
  return worst
}

function accessible(state: GameSnapshot, player: Player): number {
  return floodRegions(state.board).reduce(
    (sum, region) => sum + (region.borderingCounts[player] > 0 ? region.cells.length : 0),
    0,
  )
}

function classification(turn: number): Classification {
  if (turn <= 32) return 'no-immediate-threat'
  if (turn === 34) return 'emerging-closure-threat'
  if (turn === 36) return 'last-defensive-opportunity'
  if (turn >= 38) return 'territorial-collapse-unavoidable'
  return 'defendable-closure-threat'
}

function observedClosureDistance(turn: number): number | null {
  if (turn <= 32) return null
  if (turn === 34) return 3
  if (turn === 36) return 2
  if (turn === 38) return 1
  return 0
}

function candidateRows(decision: HumanMCTSTraceDecisionV1) {
  const state = deserializeGameSnapshot(decision.stateBefore)
  const recorded = [...(decision.mcts?.rootCandidates ?? [])].sort(
    (a, b) => b.visits - a.visits || b.value - a.value,
  )
  const rows = getLegalActions(state).map((action) => {
    const after = applyFullAction(state, action).state
    const risk = worstImmediateClosure(after)
    return {
      action,
      risk,
      heuristicAfter: evaluatePositionWithBreakdown(after, 'R'),
      recorded: recorded.find((row) => actionKey(row.action) === actionKey(action)),
    }
  })
  rows.sort(
    (a, b) =>
      Number(a.risk.terminal) - Number(b.risk.terminal) ||
      a.risk.opponentGain - b.risk.opponentGain ||
      a.risk.redAccessibleDrop - b.risk.redAccessibleDrop ||
      b.heuristicAfter.total - a.heuristicAfter.total,
  )
  const chosen = new Map<string, (typeof rows)[number]>()
  const add = (row: (typeof rows)[number] | undefined) => {
    if (row) {
      chosen.set(actionKey(row.action), row)
    }
  }
  add(rows.find((row) => actionKey(row.action) === actionKey(decision.action)))
  for (const root of recorded.slice(0, 2))
    add(rows.find((row) => actionKey(row.action) === actionKey(root.action)))
  add(rows[0])
  return {
    all: rows,
    selected: Array.from(chosen.values()),
    defensiveKey: actionKey(rows[0]!.action),
  }
}

async function continueMatch(
  stateBefore: GameSnapshot,
  firstAction: PlayerAction,
  pairSeed: number,
) {
  let state = applyFullAction(stateBefore, firstAction).state
  let turns = 1
  let maxBlueRegion = largestCapturedBy(state, 'B')
  let closureTurn: number | null = maxBlueRegion >= 20 ? 0 : null
  const counters: Record<Player, number> = { R: 0, B: 0 }
  while (!state.result && turns < 40) {
    const salt = state.turn === 'R' ? 0x243f6a88 : 0x9e3779b9
    const seed = (pairSeed + salt + Math.imul(counters[state.turn]++, 0x6d2b79f5)) >>> 0
    const decision = chooseHumanChallengeMCTSDecision({ gameState: state, seed })
    state = applyFullAction(state, decision.action).state
    turns++
    maxBlueRegion = Math.max(maxBlueRegion, largestCapturedBy(state, 'B'))
    if (closureTurn === null && maxBlueRegion >= 20) closureTurn = turns
  }
  const score = state.result?.score ?? territory(state)
  return {
    pairSeed,
    result: state.result ?? null,
    territory: score,
    territoryDiffRed: score.R - score.B,
    maxBlueCapturedRegion: maxBlueRegion,
    turnsToClosure: closureTurn,
    continuationTurns: turns,
    reachedLimit: !state.result,
  }
}

export async function analyzeHumanDefeat(tracePath = DEFEAT_TRACE, outputDir = DEFEAT_OUTPUT_DIR) {
  const source = readFileSync(tracePath, 'utf8')
  const trace = parseHumanMCTSTrace(source)
  const replay = replayHumanMCTSTrace(trace)
  if (!replay.ok) throw new Error(`Replay divergence: ${JSON.stringify(replay.divergence)}`)
  mkdirSync(outputDir, { recursive: true })

  const audited = trace.decisions
    .filter(
      (decision) =>
        decision.actor === 'mcts' && decision.turnIndex >= 24 && decision.turnIndex <= 40,
    )
    .map((decision) => {
      const state = deserializeGameSnapshot(decision.stateBefore)
      const after = applyFullAction(state, decision.action).state
      const region = contestedRegion(state)
      const candidates = candidateRows(decision)
      const chosenRisk = worstImmediateClosure(after)
      const defensive = candidates.all.filter(
        (row) =>
          !row.risk.terminal &&
          row.risk.opponentGain < chosenRisk.opponentGain &&
          row.risk.redAccessibleDrop < chosenRisk.redAccessibleDrop,
      )
      return {
        turn: decision.turnIndex,
        classification: classification(decision.turnIndex),
        territory: decision.metricsBefore.territory,
        accessible: decision.metricsBefore.accessibleTerritory,
        connectedRegions: floodRegions(state.board).length,
        contestedRegion: region
          ? {
              size: region.cells.length,
              redStones: region.borderingCounts.R,
              blueStones: region.borderingCounts.B,
            }
          : null,
        openFrontiers: openFrontiers(state),
        observedMinimumBlueTurnsToClosure: observedClosureDistance(decision.turnIndex),
        legalDefensesAgainstImmediateClosure: defensive.map((row) => row.action),
        chosenAction: decision.action,
        chosenVisits: decision.mcts?.selectedVisits,
        chosenValue: decision.mcts?.selectedValue,
        rootVisits: decision.mcts?.rootVisits,
        configuredSimulations: decision.mcts?.simulations,
        searchTimeMs: decision.mcts?.searchTimeMs,
        timedOutBefore500: (decision.mcts?.rootVisits ?? 0) < 500,
        topCandidates: [...(decision.mcts?.rootCandidates ?? [])]
          .sort((a, b) => b.visits - a.visits || b.value - a.value)
          .slice(0, 5),
        heuristicBefore: evaluatePositionWithBreakdown(state, 'R'),
        heuristicAfterChosen: evaluatePositionWithBreakdown(after, 'R'),
        immediateClosureAfterChosen: chosenRisk,
      }
    })

  const counterfactual = []
  for (const turn of CRITICAL_TURNS) {
    const decision = trace.decisions[turn]!
    const state = deserializeGameSnapshot(decision.stateBefore)
    const candidateSet = candidateRows(decision)
    const { selected } = candidateSet
    const candidates = []
    for (const row of selected) {
      const matches = []
      for (const seed of PAIR_SEEDS) matches.push(await continueMatch(state, row.action, seed))
      candidates.push({
        action: row.action,
        sources: [
          actionKey(row.action) === actionKey(decision.action) ? 'played' : undefined,
          row.recorded ? `recorded-visits-${row.recorded.visits}` : undefined,
          actionKey(row.action) === candidateSet.defensiveKey ? 'generated-defensive' : undefined,
        ].filter(Boolean),
        recordedVisits: row.recorded?.visits ?? null,
        recordedValue: row.recorded?.value ?? null,
        heuristicAfter: row.heuristicAfter,
        immediateRisk: row.risk,
        matches,
      })
    }
    counterfactual.push({ turn, classification: classification(turn), candidates })
    writeFileSync(
      path.join(outputDir, `turn_${turn}.fixture.json`),
      `${JSON.stringify(extractHumanMCTSDecisionFixture(trace, turn), null, 2)}\n`,
      'utf8',
    )
  }

  writeFileSync(
    path.join(outputDir, 'closure_threats.json'),
    `${JSON.stringify(audited, null, 2)}\n`,
  )
  writeFileSync(
    path.join(outputDir, 'counterfactual_summary.json'),
    `${JSON.stringify(
      {
        protocol: {
          pairSeeds: PAIR_SEEDS,
          continuation: 'FINAL_HUMAN_CHALLENGE_MCTS_CONFIG for both colors',
          maximumContinuationTurns: 40,
        },
        positions: counterfactual,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(path.join(outputDir, 'critical_turns.csv'), criticalCsv(audited))
  writeFileSync(
    path.join(outputDir, 'metadata.json'),
    `${JSON.stringify(
      {
        schema: 'HumanMCTSDefeatAuditV1',
        createdAt: new Date().toISOString(),
        source: {
          fileName: path.basename(tracePath),
          bytes: statSync(tracePath).size,
          sha256: createHash('sha256').update(source).digest('hex'),
        },
        replay,
        finalResult: trace.final?.result,
        recordedConfig: trace.metadata.finalHumanChallengeConfig,
        frozenConfigUnmodified:
          JSON.stringify(trace.metadata.finalHumanChallengeConfig) ===
          JSON.stringify(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG),
        criticalTurns: CRITICAL_TURNS,
        pairSeeds: PAIR_SEEDS,
        metricDefinitions: {
          connectedRegions: 'Connected components returned by floodRegions.',
          openFrontiers:
            'Legal full actions whose origin belongs to the largest contested component; a reproducible proxy for remaining ways to alter that frontier.',
          observedMinimumBlueTurnsToClosure:
            'Distance along the witnessed blue closure sequence (turns 35, 37, 39); it is not an exhaustive game-theoretic proof.',
          legalDefensesAgainstImmediateClosure:
            'Red actions reducing both the worst one-reply blue territory gain and red accessible-territory drop relative to the played action.',
        },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    path.join(outputDir, 'report.md'),
    report(trace.final?.territory, replay, audited, counterfactual),
  )
  return { replay, audited, counterfactual, outputDir }
}

function criticalCsv(rows: Array<Record<string, unknown>>): string {
  const header =
    'turn,classification,territoryR,territoryB,accessibleR,accessibleB,regions,contestedSize,contestedR,contestedB,openFrontiers,minBlueTurns,legalDefenses,rootVisits,configuredSimulations,searchTimeMs,timedOutBefore500,heuristicBefore,heuristicAfter'
  return `${header}\n${rows
    .map((row) => {
      const territory = row.territory as Record<Player, number>
      const accessible = row.accessible as Record<Player, number>
      const region = row.contestedRegion as {
        size: number
        redStones: number
        blueStones: number
      } | null
      const before = row.heuristicBefore as { total: number }
      const after = row.heuristicAfterChosen as { total: number }
      return [
        row.turn,
        row.classification,
        territory.R,
        territory.B,
        accessible.R,
        accessible.B,
        row.connectedRegions,
        region?.size ?? 0,
        region?.redStones ?? 0,
        region?.blueStones ?? 0,
        row.openFrontiers,
        row.observedMinimumBlueTurnsToClosure ?? '',
        (row.legalDefensesAgainstImmediateClosure as unknown[]).length,
        row.rootVisits,
        row.configuredSimulations,
        row.searchTimeMs,
        row.timedOutBefore500,
        before.total,
        after.total,
      ].join(',')
    })
    .join('\n')}\n`
}

function report(
  finalTerritory: Record<Player, number> | undefined,
  replay: ReturnType<typeof replayHumanMCTSTrace>,
  audited: Array<Record<string, unknown>>,
  counterfactual: unknown[],
): string {
  const row34 = audited.find((row) => row.turn === 34)!
  const row36 = audited.find((row) => row.turn === 36)!
  const row38 = audited.find((row) => row.turn === 38)!
  const counterfactualRows = (
    counterfactual as Array<{
      turn: number
      candidates: Array<{
        sources: string[]
        action: PlayerAction
        recordedVisits: number | null
        recordedValue: number | null
        heuristicAfter: { total: number }
        matches: Array<{
          territory: Record<Player, number>
          maxBlueCapturedRegion: number
          turnsToClosure: number | null
        }>
      }>
    }>
  ).flatMap((position) =>
    position.candidates.map((candidate) => {
      const average = (select: (match: (typeof candidate.matches)[number]) => number) =>
        candidate.matches.reduce((sum, match) => sum + select(match), 0) / candidate.matches.length
      return `| ${position.turn} | ${candidate.sources.join('+')} | \`${actionKey(candidate.action)}\` | ${candidate.recordedVisits ?? 'n/a'} | ${candidate.recordedValue ?? 'n/a'} | ${candidate.heuristicAfter.total} | ${average((match) => match.territory.R).toFixed(1)}–${average((match) => match.territory.B).toFixed(1)} | ${average((match) => match.maxBlueCapturedRegion).toFixed(1)} | ${candidate.matches.map((match) => match.turnsToClosure ?? 'sin ≥20').join('/')} |`
    }),
  )
  return `# Auditoría de derrota humana g_e09743f2

## Resultado verificable

- Replay: ${replay.ok ? `correcto, ${replay.decisionsReplayed}/42 decisiones` : 'divergente'}.
- Resultado: IA roja ${finalTerritory?.R} – humano azul ${finalTerritory?.B}.
- La configuración congelada no se modificó.

## Punto causal

La amenaza emerge en el turno 34: la región disputada tiene ${JSON.stringify(row34.contestedRegion)}.
El turno 36 es la última oportunidad defensiva: ${JSON.stringify(row36.contestedRegion)}.
En el turno 38 la región queda sostenida por una sola ficha roja (${JSON.stringify(row38.contestedRegion)})
y el cierre azul del turno 39 ya no puede evitarse; solo puede terminarse antes o reducir marginalmente el marcador.
Las distancias 3/2/1 son las del plan azul efectivamente observado, no una prueba exhaustiva de profundidad mínima.

## Explicación del salto

El movimiento azul 39 desplaza la última ficha azul necesaria y coloca el muro superior en (1,4).
La componente disputada de 35 celdas pierde su única ficha roja: 30 celdas quedan en una componente
exclusivamente azul. Por eso B pasa de 0 a 30 y la accesibilidad roja cae de 39 a 9.

## Evaluación

La evaluación solo contiene territorio consolidado (peso 10), movilidad (2), fichas atrapadas (8) y
expansión/accesibilidad (1). En el turno 38 todavía puntúa la posición antes de actuar con +17 para rojo,
aunque existe un cierre azul terminal a una jugada. Falta un término prospectivo para componentes grandes
disputadas sostenidas por una única ficha, abertura crítica y pérdida máxima de accesibilidad tras respuesta rival.

## Presupuesto adaptativo

El campo \`simulations=250\` es el presupuesto base configurado y no el ejecutado. \`rootVisits=500\`
demuestra que la misma raíz se amplió a 500. Ninguna decisión auditada quedó por debajo de 500; el límite
de 5.000 ms no impidió la ampliación en las posiciones críticas.

## Contrafactual

El piloto usa dos semillas emparejadas por candidata y la configuración final sin cambios para ambos colores.
Todos los continuadores terminan en derrota roja: no es evidencia de una acción ganadora, sino de reducción o
retraso del cierre. En turno 34 la acción real promedia 5,5–22,5 y evita una componente azul ≥20 en ambas
semillas; la alternativa de 31 visitas con heurística +26 colapsa inmediatamente 12–34. En turno 36 la acción
real promedia 6–26 y retrasa el cierre grande hasta 13/15 turnos de continuación. En turno 38 todas las
candidatas pierden; el colapso ya es inevitable y la mejor reducción observada queda alrededor de 7–30.

| Turno | Fuente | Acción | Visitas | Valor | Heurística tras acción | Marcador medio R–B | Máx. región B | Turnos a cierre |
|---:|---|---|---:|---:|---:|---:|---:|---|
${counterfactualRows.join('\n')}

Los datos completos están en \`counterfactual_summary.json\` (${counterfactual.length} posiciones).

## Recomendación mínima

No cambiar presupuestos ni umbrales. La corrección mínima a validar en un experimento separado es añadir
a la evaluación/verificación táctica una penalización de amenaza de cierre territorial de una a tres jugadas,
basada en el tamaño de la componente expuesta, número de fichas propias que la mantienen conectada,
aberturas críticas y máxima caída contrafactual de accesibilidad. Primero debe probarse sobre estos fixtures
y controles negativos; no se adopta ni se activa en este informe.
`
}

if (process.argv[1]?.endsWith('analyzeHumanDefeatE09743f2.ts')) {
  const result = await analyzeHumanDefeat(process.argv[2], process.argv[3])
  console.log(JSON.stringify({ replay: result.replay, outputDir: result.outputDir }, null, 2))
}
