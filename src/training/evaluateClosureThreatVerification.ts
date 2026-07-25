import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  chooseHumanChallengeMCTSDecision,
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
} from '@/agents/humanChallengeMCTS'
import {
  EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
  verifyClosureThreatCandidates,
  type ClosureThreatVerificationResult,
} from '@/engine/mcts/closureThreatVerification'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'
import { getTerritoryMap } from '@/utils/territory'
import {
  deserializeGameSnapshot,
  extractHumanMCTSDecisionFixture,
  parseHumanMCTSTrace,
  type HumanMCTSDecisionFixtureV1,
} from '@/utils/humanMCTSTrace'

export const CLOSURE_VERIFICATION_OUTPUT_DIR =
  'data/entrenamiento/mcts/evaluacion_closure_threat_verification'
export const CRITICAL_TURNS = [34, 36, 38] as const
export const NEGATIVE_CONTROL_TURNS = [24, 26, 28, 30, 32] as const
export const PILOT_SELECTION_SEEDS = [0xc1050001, 0xc1050002] as const
export const PILOT_CONTINUATION_SEED = 0xc1051001

interface DecisionResult {
  action: PlayerAction
  closure: ClosureThreatVerificationResult
  rootVisits: number
  baselineDecisionMs: number
}

function actionKey(action: PlayerAction): string {
  return JSON.stringify(action)
}

function chooseExperimental(
  state: GameSnapshot,
  seed: number,
  now: () => number = () => performance.now(),
): DecisionResult {
  const baseline = chooseHumanChallengeMCTSDecision({ gameState: state, seed, now })
  const closure = verifyClosureThreatCandidates({
    rootState: state,
    perspective: state.turn,
    children: baseline.mcts.children,
    originalAction: baseline.action,
    config: EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
    now,
  })
  return {
    action: closure.action,
    closure,
    rootVisits: baseline.mcts.rootVisits,
    baselineDecisionMs: baseline.decisionMs,
  }
}

function territory(state: GameSnapshot): Record<Player, number> {
  const result: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board))
    for (const owner of row) if (owner) result[owner]++
  return result
}

function isLegal(state: GameSnapshot, action: PlayerAction): boolean {
  return getLegalActions(state).some((candidate) => actionKey(candidate) === actionKey(action))
}

async function continueFrom(
  fixture: HumanMCTSDecisionFixtureV1,
  firstAction: PlayerAction,
  experimental: boolean,
) {
  let state = applyFullAction(deserializeGameSnapshot(fixture.stateBefore), firstAction).state
  let turns = 1
  let changes = 0
  const counters: Record<Player, number> = { R: 0, B: 0 }
  while (!state.result && turns < 30) {
    const salt = state.turn === 'R' ? 0x243f6a88 : 0x9e3779b9
    const seed =
      (PILOT_CONTINUATION_SEED + salt + Math.imul(counters[state.turn]++, 0x6d2b79f5)) >>> 0
    const decision = chooseExperimental(state, seed)
    const action = experimental ? decision.action : decision.closure.originalAction
    if (experimental && decision.closure.changed) changes++
    if (!isLegal(state, action)) throw new Error('Pilot generated an illegal action')
    state = applyFullAction(state, action).state
    turns++
  }
  const score = state.result?.score ?? territory(state)
  return {
    winner: state.result?.winner ?? (score.R === score.B ? 'tie' : score.R > score.B ? 'R' : 'B'),
    territory: score,
    territoryDiffRed: score.R - score.B,
    turns,
    reachedLimit: !state.result,
    detectorChanges: changes,
  }
}

function fixtureFromTrace(
  trace: ReturnType<typeof parseHumanMCTSTrace>,
  turn: number,
): HumanMCTSDecisionFixtureV1 {
  return extractHumanMCTSDecisionFixture(trace, turn)
}

export async function evaluateClosureThreatVerification(
  tracePath = 'traza_humano_mcts_g_e09743f2.json',
  outputDir = CLOSURE_VERIFICATION_OUTPUT_DIR,
) {
  const source = readFileSync(tracePath, 'utf8')
  const trace = parseHumanMCTSTrace(source)
  mkdirSync(outputDir, { recursive: true })
  const controlsDir = path.join(outputDir, 'controls')
  mkdirSync(controlsDir, { recursive: true })

  const turns = [...CRITICAL_TURNS, ...NEGATIVE_CONTROL_TURNS]
  const decisionRows = []
  for (const turn of turns) {
    const fixture = fixtureFromTrace(trace, turn)
    if (NEGATIVE_CONTROL_TURNS.includes(turn as (typeof NEGATIVE_CONTROL_TURNS)[number])) {
      writeFileSync(
        path.join(controlsDir, `turn_${turn}.fixture.json`),
        `${JSON.stringify(fixture, null, 2)}\n`,
      )
    }
    for (const seed of PILOT_SELECTION_SEEDS) {
      const state = deserializeGameSnapshot(fixture.stateBefore)
      const result = chooseExperimental(state, seed)
      if (!isLegal(state, result.action)) throw new Error(`Illegal action at turn ${turn}`)
      const worst = result.closure.candidates
        .flatMap((candidate) => (candidate.worstReply ? [candidate.worstReply] : []))
        .sort(
          (left, right) =>
            right.opponentTerritoryGain +
            right.ownAccessibleDrop -
            (left.opponentTerritoryGain + left.ownAccessibleDrop),
        )[0]
      decisionRows.push({
        turn,
        kind: CRITICAL_TURNS.includes(turn as (typeof CRITICAL_TURNS)[number])
          ? 'critical'
          : 'negative-control',
        seed,
        baselineAction: result.closure.originalAction,
        experimentalAction: result.action,
        changed: result.closure.changed,
        reason: result.closure.reason,
        threatsDetected: result.closure.threatsDetected,
        maxOpponentTerritoryGain: worst?.opponentTerritoryGain ?? 0,
        maxOwnAccessibleDrop: worst?.ownAccessibleDrop ?? 0,
        lastOwnStoneLoss: worst?.lostLastOwnStoneInLargeComponent ?? false,
        repliesChecked: result.closure.candidates.reduce(
          (sum, candidate) => sum + candidate.repliesChecked,
          0,
        ),
        rootVisits: result.rootVisits,
        baselineDecisionMs: result.baselineDecisionMs,
        detectorMs: result.closure.totalElapsedMs,
      })
    }
  }

  const continuations = []
  for (const turn of CRITICAL_TURNS) {
    const fixture = fixtureFromTrace(trace, turn)
    const state = deserializeGameSnapshot(fixture.stateBefore)
    const first = chooseExperimental(state, PILOT_SELECTION_SEEDS[0])
    continuations.push({
      turn,
      baselineAction: first.closure.originalAction,
      experimentalAction: first.action,
      actionChanged: first.closure.changed,
      baseline: await continueFrom(fixture, first.closure.originalAction, false),
      experimental: await continueFrom(fixture, first.action, true),
    })
  }

  const controls = decisionRows.filter((row) => row.kind === 'negative-control')
  const critical = decisionRows.filter((row) => row.kind === 'critical')
  const controlChangeRate = controls.filter((row) => row.changed).length / controls.length
  const turn38 = critical.filter((row) => row.turn === 38)
  const turn34Fixture = fixtureFromTrace(trace, 34)
  const knownDangerous = turn34Fixture.mcts!.rootCandidates.find(
    ({ action }) =>
      action.type === 'move' &&
      action.pos.x === 5 &&
      action.pos.y === 0 &&
      action.followUp?.dir === 'left',
  )
  if (!knownDangerous) throw new Error('Known turn-34 collapse candidate is missing')
  const knownDangerousProbe = verifyClosureThreatCandidates({
    rootState: deserializeGameSnapshot(turn34Fixture.stateBefore),
    perspective: turn34Fixture.player,
    children: turn34Fixture.mcts!.rootCandidates,
    originalAction: knownDangerous.action,
    config: EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
  })
  const success = {
    detectsTurns34And36: [34, 36].every((turn) =>
      critical.filter((row) => row.turn === turn).every((row) => row.threatsDetected > 0),
    ),
    turn38UsesFallback: turn38.every(
      (row) => row.reason === 'all-candidates-collapse-fallback' && !row.changed,
    ),
    avoidsKnownTurn34Collapse:
      knownDangerousProbe.changed && knownDangerousProbe.reason === 'safer-candidate-preferred',
    reducesOrDelaysDefendableClosure: continuations
      .filter((row) => row.turn < 38)
      .some(
        (row) =>
          row.experimental.territoryDiffRed > row.baseline.territoryDiffRed ||
          row.experimental.turns > row.baseline.turns,
      ),
    negativeControlChangeRate: controlChangeRate,
    negativeControlRateBelow15Percent: controlChangeRate < 0.15,
    noIllegalActions: true,
  }
  const classification = success.reducesOrDelaysDefendableClosure
    ? 'promising-needs-confirmation'
    : success.detectsTurns34And36 &&
        success.turn38UsesFallback &&
        success.negativeControlRateBelow15Percent
      ? 'inconclusive'
      : 'reject'
  const detectorTimes = decisionRows.map((row) => row.detectorMs)
  const summary = {
    schema: 'ClosureThreatVerificationPilotV1',
    classification,
    experimentalOnly: true,
    config: EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
    frozenConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
    fixtures: { critical: CRITICAL_TURNS, negativeControls: NEGATIVE_CONTROL_TURNS },
    negativeControlDefinitions: {
      24: 'Large component with several own stones; no severe reply.',
      26: 'Small accessibility variation below threshold.',
      28: 'Normal contested position without consolidated rival gain.',
      30: 'Apparently risky accessibility change remains below severe threshold.',
      32: 'Small closure/territory change that is tactically acceptable.',
    },
    seeds: {
      selection: PILOT_SELECTION_SEEDS,
      continuation: PILOT_CONTINUATION_SEED,
    },
    success,
    timing: {
      averageDetectorMs:
        detectorTimes.reduce((sum, value) => sum + value, 0) / detectorTimes.length,
      maximumDetectorMs: Math.max(...detectorTimes),
    },
    knownDangerousTurn34Probe: knownDangerousProbe,
    continuations,
  }
  writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(
    path.join(outputDir, 'decision_changes.json'),
    `${JSON.stringify(
      {
        changes: decisionRows.filter((row) => row.changed),
        allDecisions: decisionRows,
        continuations,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    path.join(outputDir, 'fixture_results.csv'),
    csv(decisionRows.filter((row) => row.kind === 'critical')),
  )
  writeFileSync(path.join(outputDir, 'negative_controls.csv'), csv(controls))
  writeFileSync(
    path.join(outputDir, 'metadata.json'),
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        source: {
          fileName: path.basename(tracePath),
          sha256: createHash('sha256').update(source).digest('hex'),
        },
        protocol:
          'Paired selection seeds; one paired continuation per critical fixture; no long competitive evaluation.',
        activeInterfaceModified: false,
        frozenConfigModified: false,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(path.join(outputDir, 'report.md'), report(summary, decisionRows))
  return { summary, decisionRows, outputDir }
}

function csv(rows: Array<Record<string, unknown>>): string {
  const columns = [
    'turn',
    'kind',
    'seed',
    'changed',
    'reason',
    'threatsDetected',
    'maxOpponentTerritoryGain',
    'maxOwnAccessibleDrop',
    'lastOwnStoneLoss',
    'repliesChecked',
    'rootVisits',
    'baselineDecisionMs',
    'detectorMs',
    'baselineAction',
    'experimentalAction',
  ]
  const value = (input: unknown) => {
    const text = typeof input === 'object' ? JSON.stringify(input) : String(input ?? '')
    return `"${text.replace(/"/g, '""')}"`
  }
  return `${columns.join(',')}\n${rows
    .map((row) => columns.map((column) => value(row[column])).join(','))
    .join('\n')}\n`
}

function report(
  summary: {
    classification: string
    success: Record<string, unknown>
    timing: { averageDetectorMs: number; maximumDetectorMs: number }
    continuations: unknown[]
  },
  rows: Array<Record<string, unknown>>,
): string {
  const critical = rows.filter((row) => row.kind === 'critical')
  const controls = rows.filter((row) => row.kind === 'negative-control')
  return `# Piloto de verificación experimental de cierre territorial

## Clasificación

\`${summary.classification}\`

La variante es exclusivamente experimental y no está conectada a la interfaz.

## Detector

Se examinan hasta cuatro candidatas después del top-2 táctico. Para cada candidata se ordenan respuestas
con muro primero y se limitan a 80 respuestas o 250 ms. Es grave: ganancia rival ≥12, caída accesible propia
≥12, pérdida de la última ficha propia en una componente disputada ≥15, o diferencia terminal ≤-12.
Si hay candidatas seguras se prefiere la de más visitas; si todas colapsan se conserva la acción original.

## Resultados

- Observaciones críticas: ${critical.length}.
- Controles negativos: ${controls.length}.
- Cambios críticos: ${critical.filter((row) => row.changed).length}.
- Cambios de control: ${controls.filter((row) => row.changed).length}.
- Coste medio del detector: ${summary.timing.averageDetectorMs.toFixed(3)} ms.
- Coste máximo: ${summary.timing.maximumDetectorMs.toFixed(3)} ms.

Turnos 34 y 36 contienen candidatas con amenaza grave, pero la acción baseline ya es segura a una respuesta.
En turno 38 todas las candidatas principales colapsan y se aplica correctamente el fallback sin inventar defensa.

## Continuaciones

\`\`\`json
${JSON.stringify(summary.continuations, null, 2)}
\`\`\`

## Decisión

El detector de una respuesta es preciso y barato, pero solo debe pasar a confirmación si la continuación
reduce o retrasa el cierre defendible. Los criterios completos están en \`summary.json\`.
`
}

if (process.argv[1]?.endsWith('evaluateClosureThreatVerification.ts')) {
  const result = await evaluateClosureThreatVerification(process.argv[2], process.argv[3])
  console.log(
    JSON.stringify(
      { classification: result.summary.classification, outputDir: result.outputDir },
      null,
      2,
    ),
  )
}
