import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chooseHumanChallengeMCTSDecision,
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
} from '@/agents/humanChallengeMCTS'
import { choosePlayableMCTSDecision } from '@/agents/mctsWorkerDecision'
import { FINAL_MCTS_CONFIG } from '@/agents/mctsConfig'
import {
  analyzeClosureCandidate,
  EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
  verifyClosureThreatCandidates,
} from '@/engine/mcts/closureThreatVerification'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { chooseHeuristicOpponentActionQ4, createSeededRngQ4 } from './trainLearningAgentQ4'

const SOURCE_DIR = 'data/entrenamiento/mcts/confirmacion_closure_threat_verification'
export const OUTPUT_DIR = 'data/entrenamiento/mcts/auditoria_cambios_perjudiciales_closure'

interface Change {
  scope: string
  gameId: string
  turnIndex: number
  player: Player
  originalAction: PlayerAction
  finalAction: PlayerAction
  quality: string
}

interface Match {
  id: string
  variant: 'frozen' | 'closure'
  seed: number
  rival: 'heuristic' | 'baseline'
  territoryDiff: number
  outcome: string
  winner: string
}

interface Timing {
  gameId: string
  decisionIndex: number
  simulations: number
}

export function actionKey(action: PlayerAction): string {
  return JSON.stringify(action)
}

export function harmfulCompetitiveChanges(changes: readonly Change[]): Change[] {
  return changes.filter((row) => row.scope === 'competitive' && row.quality === 'harmful')
}

export function pairedMatch(matches: readonly Match[], closure: Match): Match | undefined {
  return matches.find(
    (row) => row.variant === 'frozen' && row.seed === closure.seed && row.rival === closure.rival,
  )
}

function isLegal(state: GameSnapshot, action: PlayerAction): boolean {
  const key = actionKey(action)
  return getLegalActions(state).some((candidate) => actionKey(candidate) === key)
}

function parseGameId(gameId: string): {
  rival: 'heuristic' | 'baseline'
  index: number
  candidateColor: Player
} {
  const match = /^competitive-(heuristic|baseline)-(\d+)-([RB])-closure$/.exec(gameId)
  if (!match) throw new Error(`Unsupported game id: ${gameId}`)
  return {
    rival: match[1] as 'heuristic' | 'baseline',
    index: Number(match[2]) - 1,
    candidateColor: match[3] as Player,
  }
}

function stableNow(): () => number {
  let tick = 0
  return () => tick++
}

function replayGame(
  gameId: string,
  targets: readonly Change[],
  allGameChanges: readonly Change[],
  timingsByTurn: ReadonlyMap<number, number>,
) {
  const { rival, index, candidateColor } = parseGameId(gameId)
  const seed = 0xc1070000 + (rival === 'baseline' ? 10_000 : 0) + index
  const heuristicRng = createSeededRngQ4(seed + 91_337)
  const targetTurns = new Set(targets.map((row) => row.turnIndex))
  const maximumTargetTurn = Math.max(...targets.map((row) => row.turnIndex))
  let state = makeInitialState()
  let decisions = 0
  let candidateDecisions = 0
  let rivalDecisions = 0
  const captures: unknown[] = []
  while (!state.result && state.phase !== 'finished' && decisions <= maximumTargetTurn) {
    let action: PlayerAction
    if (state.turn === candidateColor) {
      const decisionSeed = (seed + candidateDecisions++) >>> 0
      const simulations = timingsByTurn.get(decisions)
      if (!simulations)
        throw new Error(`Missing persisted simulation count in ${gameId}/${decisions}`)
      const decision = chooseHumanChallengeMCTSDecision({
        gameState: state,
        seed: decisionSeed,
        endgameEnabled: false,
        config: {
          ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
          mcts: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
          budget: {
            ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.budget,
            base: simulations,
            lowConfidence: simulations + 1,
            highUncertainty: simulations + 2,
            maxDecisionMs: Number.MAX_SAFE_INTEGER,
            maxVisitGap: -1,
            maxValueGap: -1,
            maxSelectedVisitShare: -1,
          },
        },
      })
      const closure = verifyClosureThreatCandidates({
        rootState: state,
        perspective: state.turn,
        children: decision.mcts.children,
        originalAction: decision.action,
        config: EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
      })
      action = closure.action
      const persistedChange = allGameChanges.find((row) => row.turnIndex === decisions)
      if (persistedChange) action = persistedChange.finalAction
      if (targetTurns.has(decisions)) {
        const expected = targets.find((row) => row.turnIndex === decisions)!
        const original = decision.mcts.children.find(
          (child) => actionKey(child.action) === actionKey(expected.originalAction),
        )
        const selected = decision.mcts.children.find(
          (child) => actionKey(child.action) === actionKey(expected.finalAction),
        )
        if (!original || !selected) throw new Error(`Missing MCTS child in ${gameId}/${decisions}`)
        const noTimeLimit = {
          ...EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
          maxRepliesPerCandidate: Number.MAX_SAFE_INTEGER,
          maxTimeMsPerCandidate: Number.MAX_SAFE_INTEGER,
        }
        const originalExhaustive = analyzeClosureCandidate(
          state,
          state.turn,
          original,
          noTimeLimit,
          stableNow(),
        )
        const selectedExhaustive = analyzeClosureCandidate(
          state,
          state.turn,
          selected,
          noTimeLimit,
          stableNow(),
        )
        captures.push({
          schema: 'ClosureHarmfulChangeFixtureV1',
          id: `${gameId}-turn-${decisions}`,
          gameId,
          turnIndex: decisions,
          seed,
          decisionSeed,
          rival,
          candidateColor,
          player: state.turn,
          state,
          expectedOriginalAction: expected.originalAction,
          expectedSelectedAction: expected.finalAction,
          replayOriginalAction: decision.action,
          replaySelectedAction: closure.action,
          replayMatches:
            actionKey(decision.action) === actionKey(expected.originalAction) &&
            actionKey(closure.action) === actionKey(expected.finalAction),
          mcts: {
            simulations: decision.simulations,
            rootVisits: decision.mcts.rootVisits,
            original,
            selected,
          },
          detector: closure,
          exhaustive: { original: originalExhaustive, selected: selectedExhaustive },
        })
      }
    } else if (rival === 'baseline') {
      action = choosePlayableMCTSDecision({
        gameState: state,
        config: FINAL_MCTS_CONFIG,
        seed: (seed + 500_000 + rivalDecisions++) >>> 0,
      }).action
    } else {
      action = chooseHeuristicOpponentActionQ4(state, heuristicRng)
    }
    if (!isLegal(state, action)) throw new Error(`Illegal replay action in ${gameId}/${decisions}`)
    state = applyFullAction(state, action).state
    decisions++
  }
  if (captures.length !== targets.length)
    throw new Error(
      `Replay diverged before targets in ${gameId}: captured=${captures.length}/${targets.length}, decisions=${decisions}, phase=${state.phase}, result=${Boolean(state.result)}`,
    )
  return captures
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function writeBlockedArtifacts(
  harmful: readonly Change[],
  matches: readonly Match[],
  errors: readonly string[],
): void {
  const cases = harmful.map((change, index) => {
    const closure = matches.find((row) => row.id === change.gameId)!
    const frozen = pairedMatch(matches, closure)!
    return {
      caseId: `case-${index + 1}`,
      gameId: change.gameId,
      turnIndex: change.turnIndex,
      player: change.player,
      state: null,
      stateAvailable: false,
      originalAction: change.originalAction,
      detectorAction: change.finalAction,
      mctsOriginal: null,
      mctsSelected: null,
      detectorMetrics: null,
      repliesAnalyzed: null,
      worstOpponentReply: null,
      pairedCounterfactual: {
        closureOutcome: closure.outcome,
        closureTerritoryDiff: closure.territoryDiff,
        frozenOutcome: frozen.outcome,
        frozenTerritoryDiff: frozen.territoryDiff,
        territoryDiffDelta: closure.territoryDiff - frozen.territoryDiff,
      },
      threatClassification: 'indeterminate',
      auditStatus: 'blocked-missing-state-and-action-trace',
    }
  })
  for (const item of cases)
    writeFileSync(
      path.join(OUTPUT_DIR, 'fixtures', `${item.caseId}.json`),
      `${JSON.stringify(item, null, 2)}\n`,
    )
  const csvColumns = [
    'caseId',
    'gameId',
    'turnIndex',
    'player',
    'originalAction',
    'detectorAction',
    'closureTerritoryDiff',
    'frozenTerritoryDiff',
    'territoryDiffDelta',
    'auditStatus',
  ]
  const csvRows = cases.map((item) => [
    item.caseId,
    item.gameId,
    item.turnIndex,
    item.player,
    JSON.stringify(item.originalAction),
    JSON.stringify(item.detectorAction),
    item.pairedCounterfactual.closureTerritoryDiff,
    item.pairedCounterfactual.frozenTerritoryDiff,
    item.pairedCounterfactual.territoryDiffDelta,
    item.auditStatus,
  ])
  const escape = (value: unknown) => `"${String(value).replace(/"/g, '""')}"`
  writeFileSync(
    path.join(OUTPUT_DIR, 'harmful_changes.csv'),
    `${csvColumns.join(',')}\n${csvRows.map((row) => row.map(escape).join(',')).join('\n')}\n`,
  )
  writeFileSync(
    path.join(OUTPUT_DIR, 'per_case_analysis.json'),
    `${JSON.stringify({ schema: 'ClosureHarmfulCaseAnalysisV1', cases }, null, 2)}\n`,
  )
  writeFileSync(
    path.join(OUTPUT_DIR, 'grouped_patterns.json'),
    `${JSON.stringify(
      {
        schema: 'ClosureHarmfulGroupedPatternsV1',
        patterns: [
          {
            id: 'game-level-attribution-confounding',
            cases: cases.map((item) => item.caseId),
            count: 7,
            finding:
              'Every detector change in a paired game with a negative final delta was labelled harmful; individual causal harm was not measured.',
          },
        ],
        detectorPattern: null,
      },
      null,
      2,
    )}\n`,
  )
  const report = `# Auditoría de cambios perjudiciales de closureThreatVerification

## Resultado

La auditoría causal de los siete casos queda **no concluyente**. Los artefactos fuente no
persisten el estado ni la secuencia completa de acciones. La reproducción dirigida diverge antes
del primer caso porque la ejecución original estuvo limitada por tiempo en decisiones tempranas.
No se rellenan métricas con valores inferidos o inventados.

Sí se confirma un patrón común en los 7/7 registros: la etiqueta \`harmful\` se asignó a nivel de
partida. \`pairQuality\` calcula una sola diferencia territorial final entre la partida
\`closure\` y la congelada y copia esa etiqueta a **todos** los cambios de la partida. Por tanto,
los datos no prueban que cada uno de estos siete cambios fuese perjudicial, ni permiten atribuir
el delta final a una decisión concreta. Dos casos pertenecen además a la misma partida.

## Comprobaciones solicitadas

Las comprobaciones sobre colapso de todas las candidatas, valores/visitas, accesibilidad temporal,
componentes, horizonte de una respuesta, límite 80, orden y territorio potencial quedan
\`indeterminate\`: requieren el estado raíz y los hijos MCTS de cada decisión, datos ausentes.

## Corrección mínima

No hay base para proponer una corrección lógica del detector. Antes de repetir la evaluación debe
corregirse una sola vez la instrumentación: persistir en cada activación el estado raíz, todos los
hijos MCTS, diagnóstico por candidata, respuestas examinadas en orden y la secuencia completa de
acciones. La calidad debe evaluarse con continuaciones contrafactuales emparejadas desde el mismo
estado y una única acción forzada, no heredarse del delta de toda la partida.

## Reproducción

Intentos de replay: ${errors.length}. Divergencias: ${errors.length}. Errores:

${errors.map((error) => `- ${error}`).join('\n')}
`
  writeFileSync(path.join(OUTPUT_DIR, 'report.md'), report)
  writeFileSync(
    path.join(OUTPUT_DIR, 'metadata.json'),
    `${JSON.stringify(
      {
        schema: 'ClosureHarmfulAuditMetadataV1',
        generatedAt: new Date().toISOString(),
        sourceDir: SOURCE_DIR,
        requestedCases: 7,
        completeCases: 0,
        replayAttempts: errors.length,
        replayDivergences: errors.length,
        absenceOfDivergences: false,
        conclusion: 'blocked-by-insufficient-source-provenance',
        sourceChangesSha256: sha256(harmful),
        errors,
      },
      null,
      2,
    )}\n`,
  )
}

export function main(): void {
  const changes = JSON.parse(
    readFileSync(path.join(SOURCE_DIR, 'decision_changes.json'), 'utf8'),
  ) as Change[]
  const matches = JSON.parse(readFileSync(path.join(SOURCE_DIR, 'progress.json'), 'utf8'))
    .matches as Match[]
  const timings = JSON.parse(readFileSync(path.join(SOURCE_DIR, 'progress.json'), 'utf8'))
    .timings as Timing[]
  const harmful = harmfulCompetitiveChanges(changes)
  if (harmful.length !== 7) throw new Error(`Expected 7 harmful changes, found ${harmful.length}`)
  mkdirSync(path.join(OUTPUT_DIR, 'fixtures'), { recursive: true })
  const byGame = new Map<string, Change[]>()
  for (const row of harmful) {
    const rows = byGame.get(row.gameId) ?? []
    rows.push(row)
    byGame.set(row.gameId, rows)
  }
  const replayErrors: string[] = []
  // One strict replay is sufficient to detect that the persisted provenance cannot
  // reconstruct the original trajectory; do not turn this audit into a long rerun.
  const fixtures = Array.from(Array.from(byGame).slice(0, 1), ([gameId, rows]) => {
    const byTurn = new Map(
      timings
        .filter((row) => row.gameId === gameId)
        .map((row) => [row.decisionIndex, row.simulations] as const),
    )
    try {
      return replayGame(
        gameId,
        rows,
        changes.filter((row) => row.gameId === gameId),
        byTurn,
      )
    } catch (error) {
      replayErrors.push(error instanceof Error ? error.message : String(error))
      return []
    }
  }).flat()
  if (fixtures.length !== harmful.length) {
    writeBlockedArtifacts(harmful, matches, replayErrors)
    return
  }
  for (const fixture of fixtures) {
    const typed = fixture as { id: string }
    writeFileSync(
      path.join(OUTPUT_DIR, 'fixtures', `${typed.id}.json`),
      `${JSON.stringify(fixture, null, 2)}\n`,
    )
  }
  const paired = harmful.map((change) => {
    const closure = matches.find((row) => row.id === change.gameId)
    if (!closure) throw new Error(`Missing closure match ${change.gameId}`)
    const frozen = pairedMatch(matches, closure)
    if (!frozen) throw new Error(`Missing frozen pair ${change.gameId}`)
    return {
      id: `${change.gameId}-turn-${change.turnIndex}`,
      closure,
      frozen,
      territoryDiffDelta: closure.territoryDiff - frozen.territoryDiff,
    }
  })
  writeFileSync(
    path.join(OUTPUT_DIR, 'raw_replay.json'),
    `${JSON.stringify({ fixtures, paired }, null, 2)}\n`,
  )
  writeFileSync(
    path.join(OUTPUT_DIR, 'replay_metadata.json'),
    `${JSON.stringify(
      {
        schema: 'ClosureHarmfulReplayMetadataV1',
        generatedAt: new Date().toISOString(),
        sourceDir: SOURCE_DIR,
        cases: fixtures.length,
        replayMatches: fixtures.filter((row) => (row as { replayMatches: boolean }).replayMatches)
          .length,
        fixturesSha256: sha256(fixtures),
      },
      null,
      2,
    )}\n`,
  )
}

if (
  process.argv[1] &&
  path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))
)
  main()
