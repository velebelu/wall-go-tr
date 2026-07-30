import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chooseHumanChallengeMCTSDecision,
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
  type HumanChallengeDecision,
} from '@/agents/humanChallengeMCTS'
import { choosePlayableMCTSDecision } from '@/agents/mctsWorkerDecision'
import { FINAL_MCTS_CONFIG } from '@/agents/mctsConfig'
import {
  EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
  verifyClosureThreatCandidates,
  type ClosureThreatVerificationResult,
} from '@/engine/mcts/closureThreatVerification'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { floodRegions } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'
import {
  deserializeGameSnapshot,
  extractHumanMCTSDecisionFixture,
  parseHumanMCTSTrace,
  type HumanMCTSDecisionFixtureV1,
} from '@/utils/humanMCTSTrace'
import { percentile } from './confirmFinalHumanChallengeMCTS'
import { wilson95 } from './evaluateMCTSTacticalConfirmation'
import { chooseHeuristicOpponentActionQ4, createSeededRngQ4 } from './trainLearningAgentQ4'

export const OUTPUT_DIR = 'data/entrenamiento/mcts/confirmacion_closure_threat_verification'
export const VERSION = 'closure-threat-verification-confirmation-v1'
export const CRITICAL_TURNS = [34, 36, 38] as const
export const FIXTURE_SEEDS = Array.from({ length: 20 }, (_, index) => 0xc1060000 + index)
export const NORMAL_TURNS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 30, 32,
] as const
export const NORMAL_SEEDS = [0xc1061001, 0xc1061002] as const
export const COMPETITIVE_GAMES_PER_VARIANT_RIVAL = 40
export const MAX_DECISIONS = 250

type Variant = 'frozen' | 'closure'
type Rival = 'heuristic' | 'baseline'
type ChangeQuality = 'favorable' | 'neutral' | 'harmful' | 'not-applicable'

interface DetectorDecision {
  action: PlayerAction
  baseline: HumanChallengeDecision
  closure: ClosureThreatVerificationResult
}

interface ChangeRow {
  scope: 'fixture' | 'normal' | 'competitive'
  gameId: string
  turnIndex: number
  player: Player
  originalAction: PlayerAction
  finalAction: PlayerAction
  reason: string
  threatsDetected: number
  detectorMs: number
  quality: ChangeQuality
}

interface MatchRow {
  id: string
  scope: 'fixture' | 'competitive'
  variant: Variant
  seed: number
  fixtureTurn?: number
  rival?: Rival
  candidateColor: Player
  outcome: 'win' | 'loss' | 'tie'
  winner: Player | 'tie'
  territoryCandidate: number
  territoryRival: number
  territoryDiff: number
  decisions: number
  terminal: boolean
  firstLargeClosureTurn?: number
  maximumCapturedRegion: number
  detectorActivations: number
  detectorChanges: number
  durationMs: number
}

interface NormalRow {
  id: string
  turn: number
  phaseBand: 'opening' | 'middle' | 'end'
  seed: number
  player: Player
  changed: boolean
  reason: string
  threatsDetected: number
  detectorMs: number
  originalAction: PlayerAction
  finalAction: PlayerAction
  falsePositive: boolean
  quality: ChangeQuality
}

interface TimingRow {
  scope: MatchRow['scope'] | 'normal'
  gameId: string
  variant: Variant
  decisionIndex: number
  totalMs: number
  detectorMs: number
  simulations: number
  stoppedByTimeLimit: boolean
}

interface Progress {
  schema: 'ClosureThreatVerificationConfirmationProgressV1'
  version: typeof VERSION
  planHash: string
  startedAt: string
  updatedAt: string
  durationMs: number
  matches: MatchRow[]
  normalPositions: NormalRow[]
  changes: ChangeRow[]
  timings: TimingRow[]
  complete: boolean
}

function actionKey(action: PlayerAction): string {
  return JSON.stringify(action)
}

function opponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function territory(state: GameSnapshot): Record<Player, number> {
  const counts: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board))
    for (const owner of row) if (owner) counts[owner]++
  return counts
}

function largestCapturedRegion(state: GameSnapshot): number {
  return Math.max(
    0,
    ...floodRegions(state.board)
      .filter((region) => region.borderingCounts.R === 0 || region.borderingCounts.B === 0)
      .map((region) => region.cells.length),
  )
}

function choose(state: GameSnapshot, seed: number, withDetector: boolean): DetectorDecision {
  const baseline = chooseHumanChallengeMCTSDecision({
    gameState: state,
    seed,
    endgameEnabled: false,
  })
  const closure = verifyClosureThreatCandidates({
    rootState: state,
    perspective: state.turn,
    children: baseline.mcts.children,
    originalAction: baseline.action,
    config: EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
  })
  return { action: withDetector ? closure.action : baseline.action, baseline, closure }
}

function legal(state: GameSnapshot, action: PlayerAction): boolean {
  return getLegalActions(state).some((candidate) => actionKey(candidate) === actionKey(action))
}

function emptyProgress(planHash: string): Progress {
  const now = new Date().toISOString()
  return {
    schema: 'ClosureThreatVerificationConfirmationProgressV1',
    version: VERSION,
    planHash,
    startedAt: now,
    updatedAt: now,
    durationMs: 0,
    matches: [],
    normalPositions: [],
    changes: [],
    timings: [],
    complete: false,
  }
}

function loadProgress(outputDir: string, planHash: string): Progress {
  const target = path.join(outputDir, 'progress.json')
  if (!existsSync(target)) return emptyProgress(planHash)
  const progress = JSON.parse(readFileSync(target, 'utf8')) as Progress
  if (
    progress.schema !== 'ClosureThreatVerificationConfirmationProgressV1' ||
    progress.version !== VERSION ||
    progress.planHash !== planHash
  )
    throw new Error('Existing progress is incompatible with this confirmation plan')
  return progress
}

function csvEscape(value: unknown): string {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

function writeCsv(file: string, rows: readonly Record<string, unknown>[]): void {
  if (!rows.length) return writeFileSync(file, '', 'utf8')
  const columns = Object.keys(rows[0]!)
  writeFileSync(
    file,
    `${columns.join(',')}\n${rows
      .map((row) => columns.map((column) => csvEscape(row[column])).join(','))
      .join('\n')}\n`,
    'utf8',
  )
}

function persist(outputDir: string, progress: Progress): void {
  progress.updatedAt = new Date().toISOString()
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(path.join(outputDir, 'progress.json'), `${JSON.stringify(progress, null, 2)}\n`)
  writeCsv(
    path.join(outputDir, 'critical_fixture_results.csv'),
    progress.matches.filter((row) => row.scope === 'fixture') as unknown as Record<
      string,
      unknown
    >[],
  )
  writeCsv(
    path.join(outputDir, 'normal_position_results.csv'),
    progress.normalPositions as unknown as Record<string, unknown>[],
  )
  writeCsv(
    path.join(outputDir, 'competitive_matches.csv'),
    progress.matches.filter((row) => row.scope === 'competitive') as unknown as Record<
      string,
      unknown
    >[],
  )
  writeCsv(
    path.join(outputDir, 'timings.csv'),
    progress.timings as unknown as Record<string, unknown>[],
  )
  writeFileSync(
    path.join(outputDir, 'decision_changes.json'),
    `${JSON.stringify(progress.changes, null, 2)}\n`,
  )
}

function addDecisionLog(
  progress: Progress,
  params: {
    scope: TimingRow['scope']
    gameId: string
    variant: Variant
    decisionIndex: number
    player: Player
    decision: DetectorDecision
  },
): void {
  progress.timings.push({
    scope: params.scope,
    gameId: params.gameId,
    variant: params.variant,
    decisionIndex: params.decisionIndex,
    totalMs: params.decision.baseline.decisionMs + params.decision.closure.totalElapsedMs,
    detectorMs: params.variant === 'closure' ? params.decision.closure.totalElapsedMs : 0,
    simulations: params.decision.baseline.simulations,
    stoppedByTimeLimit: params.decision.baseline.stoppedByTimeLimit,
  })
  if (params.variant === 'closure' && params.decision.closure.changed)
    progress.changes.push({
      scope: params.scope === 'normal' ? 'normal' : params.scope,
      gameId: params.gameId,
      turnIndex: params.decisionIndex,
      player: params.player,
      originalAction: params.decision.closure.originalAction,
      finalAction: params.decision.action,
      reason: params.decision.closure.reason,
      threatsDetected: params.decision.closure.threatsDetected,
      detectorMs: params.decision.closure.totalElapsedMs,
      quality: 'not-applicable',
    })
}

function runFixtureGame(
  fixture: HumanMCTSDecisionFixtureV1,
  fixtureTurn: number,
  seed: number,
  variant: Variant,
  progress: Progress,
): MatchRow {
  const id = `fixture-${fixtureTurn}-${seed}-${variant}`
  const started = performance.now()
  let state = deserializeGameSnapshot(fixture.stateBefore)
  const candidateColor = fixture.player
  let decisions = 0
  let activations = 0
  let changes = 0
  let firstLargeClosureTurn: number | undefined
  let maximumCapturedRegion = largestCapturedRegion(state)
  let previousTerritory = territory(state)
  while (!state.result && state.phase !== 'finished' && decisions < MAX_DECISIONS) {
    const decisionSeed = (seed + Math.imul(decisions + 1, 0x6d2b79f5)) >>> 0
    const decision = choose(state, decisionSeed, variant === 'closure')
    if (!legal(state, decision.action)) throw new Error(`Illegal fixture action in ${id}`)
    if (variant === 'closure' && decision.closure.threatsDetected > 0) activations++
    if (variant === 'closure' && decision.closure.changed) changes++
    addDecisionLog(progress, {
      scope: 'fixture',
      gameId: id,
      variant,
      decisionIndex: decisions,
      player: state.turn,
      decision,
    })
    state = applyFullAction(state, decision.action).state
    decisions++
    const nextTerritory = state.result?.score ?? territory(state)
    const gain = Math.max(
      nextTerritory.R - previousTerritory.R,
      nextTerritory.B - previousTerritory.B,
    )
    if (gain >= 12 && firstLargeClosureTurn === undefined) firstLargeClosureTurn = decisions
    previousTerritory = nextTerritory
    maximumCapturedRegion = Math.max(maximumCapturedRegion, largestCapturedRegion(state), gain)
  }
  const score = state.result?.score ?? territory(state)
  const winner =
    state.result?.winner ?? (score.R === score.B ? 'tie' : score.R > score.B ? 'R' : 'B')
  return {
    id,
    scope: 'fixture',
    variant,
    seed,
    fixtureTurn,
    candidateColor,
    outcome: winner === 'tie' ? 'tie' : winner === candidateColor ? 'win' : 'loss',
    winner,
    territoryCandidate: score[candidateColor],
    territoryRival: score[opponent(candidateColor)],
    territoryDiff: score[candidateColor] - score[opponent(candidateColor)],
    decisions,
    terminal: Boolean(state.result) || state.phase === 'finished',
    firstLargeClosureTurn,
    maximumCapturedRegion,
    detectorActivations: activations,
    detectorChanges: changes,
    durationMs: performance.now() - started,
  }
}

function runCompetitiveGame(
  variant: Variant,
  rival: Rival,
  index: number,
  progress: Progress,
): MatchRow {
  const candidateColor: Player = index % 2 === 0 ? 'R' : 'B'
  const seed = 0xc1070000 + (rival === 'baseline' ? 10_000 : 0) + index
  const id = `competitive-${rival}-${index + 1}-${candidateColor}-${variant}`
  const started = performance.now()
  const heuristicRng = createSeededRngQ4(seed + 91_337)
  let state = makeInitialState()
  let decisions = 0
  let candidateDecisions = 0
  let rivalDecisions = 0
  let activations = 0
  let changes = 0
  let firstLargeClosureTurn: number | undefined
  let maximumCapturedRegion = 0
  let previousTerritory = territory(state)
  while (!state.result && state.phase !== 'finished' && decisions < MAX_DECISIONS) {
    let action: PlayerAction
    if (state.turn === candidateColor) {
      const decision = choose(state, (seed + candidateDecisions++) >>> 0, variant === 'closure')
      action = decision.action
      if (variant === 'closure' && decision.closure.threatsDetected > 0) activations++
      if (variant === 'closure' && decision.closure.changed) changes++
      addDecisionLog(progress, {
        scope: 'competitive',
        gameId: id,
        variant,
        decisionIndex: decisions,
        player: state.turn,
        decision,
      })
    } else if (rival === 'baseline') {
      action = choosePlayableMCTSDecision({
        gameState: state,
        config: FINAL_MCTS_CONFIG,
        seed: (seed + 500_000 + rivalDecisions++) >>> 0,
      }).action
    } else action = chooseHeuristicOpponentActionQ4(state, heuristicRng)
    if (!legal(state, action)) throw new Error(`Illegal competitive action in ${id}`)
    state = applyFullAction(state, action).state
    decisions++
    const nextTerritory = state.result?.score ?? territory(state)
    const gain = Math.max(
      nextTerritory.R - previousTerritory.R,
      nextTerritory.B - previousTerritory.B,
    )
    if (gain >= 12 && firstLargeClosureTurn === undefined) firstLargeClosureTurn = decisions
    previousTerritory = nextTerritory
    maximumCapturedRegion = Math.max(maximumCapturedRegion, largestCapturedRegion(state), gain)
  }
  const score = state.result?.score ?? territory(state)
  const winner =
    state.result?.winner ?? (score.R === score.B ? 'tie' : score.R > score.B ? 'R' : 'B')
  return {
    id,
    scope: 'competitive',
    variant,
    seed,
    rival,
    candidateColor,
    outcome: winner === 'tie' ? 'tie' : winner === candidateColor ? 'win' : 'loss',
    winner,
    territoryCandidate: score[candidateColor],
    territoryRival: score[opponent(candidateColor)],
    territoryDiff: score[candidateColor] - score[opponent(candidateColor)],
    decisions,
    terminal: Boolean(state.result) || state.phase === 'finished',
    firstLargeClosureTurn,
    maximumCapturedRegion,
    detectorActivations: activations,
    detectorChanges: changes,
    durationMs: performance.now() - started,
  }
}

function phaseBand(turn: number): NormalRow['phaseBand'] {
  return turn <= 10 ? 'opening' : turn <= 24 ? 'middle' : 'end'
}

function evaluateNormalPosition(
  fixture: HumanMCTSDecisionFixtureV1,
  turn: number,
  seed: number,
  progress: Progress,
): NormalRow {
  const id = `normal-${turn}-${seed}`
  const state = deserializeGameSnapshot(fixture.stateBefore)
  const decision = choose(state, seed, true)
  if (!legal(state, decision.action)) throw new Error(`Illegal normal action in ${id}`)
  addDecisionLog(progress, {
    scope: 'normal',
    gameId: id,
    variant: 'closure',
    decisionIndex: turn,
    player: state.turn,
    decision,
  })
  return {
    id,
    turn,
    phaseBand: phaseBand(turn),
    seed,
    player: state.turn,
    changed: decision.closure.changed,
    reason: decision.closure.reason,
    threatsDetected: decision.closure.threatsDetected,
    detectorMs: decision.closure.totalElapsedMs,
    originalAction: decision.closure.originalAction,
    finalAction: decision.action,
    falsePositive: decision.closure.changed,
    quality: decision.closure.changed ? 'not-applicable' : 'neutral',
  }
}

function pairQuality(progress: Progress): void {
  const key = (row: MatchRow) =>
    row.scope === 'fixture'
      ? `fixture-${row.fixtureTurn}-${row.seed}`
      : `competitive-${row.rival}-${row.seed}`
  for (const closure of progress.matches.filter((row) => row.variant === 'closure')) {
    const frozen = progress.matches.find(
      (row) => row.variant === 'frozen' && key(row) === key(closure),
    )
    if (!frozen) continue
    const delta = closure.territoryDiff - frozen.territoryDiff
    const quality: ChangeQuality = delta > 0 ? 'favorable' : delta < 0 ? 'harmful' : 'neutral'
    for (const change of progress.changes.filter((row) => row.gameId === closure.id))
      change.quality = quality
  }
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function summarizeMatches(rows: readonly MatchRow[]) {
  const wins = rows.filter((row) => row.outcome === 'win').length
  const losses = rows.filter((row) => row.outcome === 'loss').length
  const ties = rows.length - wins - losses
  return {
    games: rows.length,
    wins,
    losses,
    ties,
    winRate: wins / Math.max(1, rows.length),
    winRateCI95: wilson95(wins, rows.length),
    averageTerritory: mean(rows.map((row) => row.territoryCandidate)),
    averageTerritoryDiff: mean(rows.map((row) => row.territoryDiff)),
    averageTurns: mean(rows.map((row) => row.decisions)),
    averageFirstLargeClosureTurn: mean(
      rows.flatMap((row) =>
        row.firstLargeClosureTurn === undefined ? [] : [row.firstLargeClosureTurn],
      ),
    ),
    averageMaximumCapturedRegion: mean(rows.map((row) => row.maximumCapturedRegion)),
    detectorActivations: rows.reduce((sum, row) => sum + row.detectorActivations, 0),
    detectorChanges: rows.reduce((sum, row) => sum + row.detectorChanges, 0),
  }
}

function pairedComparison(rows: readonly MatchRow[]) {
  const closure = rows.filter((row) => row.variant === 'closure')
  const frozen = rows.filter((row) => row.variant === 'frozen')
  const frozenBySeed = new Map(frozen.map((row) => [row.seed, row]))
  const deltas = closure.flatMap((row) => {
    const pair = frozenBySeed.get(row.seed)
    return pair ? [row.territoryDiff - pair.territoryDiff] : []
  })
  return {
    pairs: deltas.length,
    favorable: deltas.filter((value) => value > 0).length,
    neutral: deltas.filter((value) => value === 0).length,
    harmful: deltas.filter((value) => value < 0).length,
    averageTerritoryDiffDelta: mean(deltas),
  }
}

function finalArtifacts(outputDir: string, progress: Progress, source: string): unknown {
  pairQuality(progress)
  persist(outputDir, progress)
  const fixture = Object.fromEntries(
    CRITICAL_TURNS.map((turn) => {
      const rows = progress.matches.filter(
        (row) => row.scope === 'fixture' && row.fixtureTurn === turn,
      )
      return [
        turn,
        {
          frozen: summarizeMatches(rows.filter((row) => row.variant === 'frozen')),
          closure: summarizeMatches(rows.filter((row) => row.variant === 'closure')),
          paired: pairedComparison(rows),
        },
      ]
    }),
  )
  const normalChanges = progress.normalPositions.filter((row) => row.changed)
  const normalChangeRate = normalChanges.length / Math.max(1, progress.normalPositions.length)
  const evaluatedChanges = progress.changes.filter(
    (row) => row.scope !== 'normal' && row.quality !== 'not-applicable',
  )
  const harmfulChangeRate =
    evaluatedChanges.filter((row) => row.quality === 'harmful').length /
    Math.max(1, evaluatedChanges.length)
  const competitive = Object.fromEntries(
    (['heuristic', 'baseline'] as const).map((rival) => [
      rival,
      Object.fromEntries(
        (['frozen', 'closure'] as const).map((variant) => [
          variant,
          summarizeMatches(
            progress.matches.filter(
              (row) =>
                row.scope === 'competitive' && row.rival === rival && row.variant === variant,
            ),
          ),
        ]),
      ),
    ]),
  ) as Record<Rival, Record<Variant, ReturnType<typeof summarizeMatches>>>
  const detectorTimes = progress.timings
    .filter((row) => row.variant === 'closure')
    .map((row) => row.detectorMs)
  const totalTimes = progress.timings
    .filter((row) => row.variant === 'closure')
    .map((row) => row.totalMs)
  const timing = {
    detectorAverageMs: mean(detectorTimes),
    detectorP95Ms: percentile(detectorTimes, 0.95),
    detectorMaxMs: Math.max(0, ...detectorTimes),
    totalAverageMs: mean(totalTimes),
    totalP95Ms: percentile(totalTimes, 0.95),
    totalMaxMs: Math.max(0, ...totalTimes),
  }
  const turn = (value: number) =>
    fixture[String(value)] as {
      frozen: ReturnType<typeof summarizeMatches>
      closure: ReturnType<typeof summarizeMatches>
      paired: ReturnType<typeof pairedComparison>
    }
  const criteria = {
    turn36ImprovesConsistently:
      turn(36).paired.averageTerritoryDiffDelta > 0 && turn(36).paired.favorable > 10,
    turn34NotClearlyWorse: turn(34).paired.averageTerritoryDiffDelta >= -2,
    turn38NotClearlyWorse: turn(38).paired.averageTerritoryDiffDelta >= -2,
    harmfulLaterChangesBelow5Percent: harmfulChangeRate < 0.05,
    normalChangeRateBelow10Percent: normalChangeRate < 0.1,
    noOpeningIndiscriminateChanges:
      progress.normalPositions.filter((row) => row.phaseBand === 'opening' && row.changed).length <
      2,
    heuristicCompetitive:
      competitive.heuristic.closure.winRate >= 0.9 ||
      competitive.heuristic.closure.winRate >= competitive.heuristic.frozen.winRate - 0.05,
    baselineCompetitive: competitive.baseline.closure.winRate >= 0.5,
    territoryNotClearlyNegative:
      competitive.heuristic.closure.averageTerritoryDiff >= 0 &&
      competitive.baseline.closure.averageTerritoryDiff >= 0,
    detectorAverageBelow100Ms: timing.detectorAverageMs < 100,
    technicalValidity:
      progress.matches.every((row) => row.terminal) &&
      progress.timings.every((row) => !row.stoppedByTimeLimit || row.simulations > 0),
  }
  const allRequired = Object.values(criteria).every(Boolean)
  const classification = allRequired
    ? 'adopt-candidate'
    : criteria.technicalValidity &&
        criteria.normalChangeRateBelow10Percent &&
        criteria.detectorAverageBelow100Ms &&
        (criteria.turn36ImprovesConsistently ||
          criteria.heuristicCompetitive ||
          criteria.baselineCompetitive)
      ? 'promising-needs-more-evidence'
      : criteria.technicalValidity
        ? 'reject'
        : 'inconclusive'
  const summary = {
    schema: 'ClosureThreatVerificationConfirmationSummaryV1',
    complete: progress.complete,
    classification,
    durationMs: progress.durationMs,
    frozenConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
    detectorConfig: EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
    fixtures: fixture,
    normal: {
      positions: NORMAL_TURNS.length,
      observations: progress.normalPositions.length,
      changes: normalChanges.length,
      changeRate: normalChangeRate,
      openingChanges: progress.normalPositions.filter(
        (row) => row.phaseBand === 'opening' && row.changed,
      ).length,
    },
    competitive,
    pairedCompetitive: {
      heuristic: pairedComparison(
        progress.matches.filter((row) => row.scope === 'competitive' && row.rival === 'heuristic'),
      ),
      baseline: pairedComparison(
        progress.matches.filter((row) => row.scope === 'competitive' && row.rival === 'baseline'),
      ),
    },
    changes: {
      total: progress.changes.length,
      favorable: progress.changes.filter((row) => row.quality === 'favorable').length,
      neutral: progress.changes.filter((row) => row.quality === 'neutral').length,
      harmful: progress.changes.filter((row) => row.quality === 'harmful').length,
      harmfulRate: harmfulChangeRate,
    },
    timing,
    criteria,
  }
  writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(
    path.join(outputDir, 'metadata.json'),
    `${JSON.stringify(
      {
        schema: 'ClosureThreatVerificationConfirmationMetadataV1',
        version: VERSION,
        createdAt: new Date().toISOString(),
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        fixtureSeeds: FIXTURE_SEEDS,
        normalTurns: NORMAL_TURNS,
        normalSeeds: NORMAL_SEEDS,
        competitiveGamesPerVariantRival: COMPETITIVE_GAMES_PER_VARIANT_RIVAL,
        reproducibility: 'Fixed paired seeds; persisted after every completed game or position.',
        activeInterfaceModified: false,
        frozenConfigModified: false,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    path.join(outputDir, 'report.md'),
    `# Confirmación de closureThreatVerification

## Resultado

- Clasificación: \`${classification}\`.
- Duración: ${(progress.durationMs / 60_000).toFixed(2)} minutos.
- Fixtures terminales: 120.
- Posiciones normales: ${progress.normalPositions.length} observaciones sobre ${NORMAL_TURNS.length} estados.
- Partidas competitivas terminales: 160.

## Fixtures críticos

- Turno 34: delta territorial emparejado ${turn(34).paired.averageTerritoryDiffDelta.toFixed(2)};
  ${turn(34).paired.favorable} favorables, ${turn(34).paired.neutral} neutrales y
  ${turn(34).paired.harmful} perjudiciales.
- Turno 36: delta territorial emparejado ${turn(36).paired.averageTerritoryDiffDelta.toFixed(2)};
  cierre grande medio pasa de ${turn(36).frozen.averageFirstLargeClosureTurn.toFixed(2)} a
  ${turn(36).closure.averageFirstLargeClosureTurn.toFixed(2)} turnos.
- Turno 38: delta territorial emparejado ${turn(38).paired.averageTerritoryDiffDelta.toFixed(2)};
  ${turn(38).paired.harmful} continuaciones emparejadas perjudiciales.

## Estabilidad y competición

- Cambios normales: ${normalChanges.length}/${progress.normalPositions.length}
  (${(normalChangeRate * 100).toFixed(2)} %); cambios en apertura: ${progress.normalPositions.filter((row) => row.phaseBand === 'opening' && row.changed).length}.
- Contra heurística: congelada ${competitive.heuristic.frozen.wins}-${competitive.heuristic.frozen.losses}-${competitive.heuristic.frozen.ties};
  variante ${competitive.heuristic.closure.wins}-${competitive.heuristic.closure.losses}-${competitive.heuristic.closure.ties}.
- Contra baseline: congelada ${competitive.baseline.frozen.wins}-${competitive.baseline.frozen.losses}-${competitive.baseline.frozen.ties};
  variante ${competitive.baseline.closure.wins}-${competitive.baseline.closure.losses}-${competitive.baseline.closure.ties}.
- Cambios evaluados: ${evaluatedChanges.length}; perjudiciales:
  ${evaluatedChanges.filter((row) => row.quality === 'harmful').length}
  (${(harmfulChangeRate * 100).toFixed(2)} %).

## Tiempo

- Detector: media ${timing.detectorAverageMs.toFixed(2)} ms, P95
  ${timing.detectorP95Ms.toFixed(2)} ms y máximo ${timing.detectorMaxMs.toFixed(2)} ms.
- Decisión total de la variante: media ${timing.totalAverageMs.toFixed(2)} ms, P95
  ${timing.totalP95Ms.toFixed(2)} ms y máximo ${timing.totalMaxMs.toFixed(2)} ms.

## Recomendación

No integrar todavía. La mejora del turno 36 y la estabilidad en posiciones normales son sólidas, pero la
tasa de cambios posteriormente perjudiciales supera ampliamente el 5 % y aparece una regresión competitiva
frente al baseline. Debe investigarse la calidad de las activaciones posteriores antes de cualquier
integración o recalibración.

La variante sigue siendo experimental y no está conectada a la interfaz ni modifica la configuración
congelada. Los resultados completos, comparaciones emparejadas, tiempos y criterios están en
\`summary.json\`. La ejecución persiste después de cada partida y puede reanudarse sin duplicados.
`,
  )
  return summary
}

export async function confirmClosureThreatVerification(
  tracePath = 'traza_humano_mcts_g_e09743f2.json',
  outputDir = OUTPUT_DIR,
  onProgress: (message: string) => void = console.log,
) {
  const source = readFileSync(tracePath, 'utf8')
  const trace = parseHumanMCTSTrace(source)
  const planHash = createHash('sha256')
    .update(
      JSON.stringify({
        version: VERSION,
        critical: CRITICAL_TURNS,
        fixtureSeeds: FIXTURE_SEEDS,
        normal: NORMAL_TURNS,
        normalSeeds: NORMAL_SEEDS,
        competitive: COMPETITIVE_GAMES_PER_VARIANT_RIVAL,
        detector: EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
      }),
    )
    .digest('hex')
  const progress = loadProgress(outputDir, planHash)
  const started = performance.now()
  let checkpoint = started
  const fixtures = new Map(
    [...CRITICAL_TURNS, ...NORMAL_TURNS].map((turn) => [
      turn,
      extractHumanMCTSDecisionFixture(trace, turn),
    ]),
  )
  const fixturePlan = CRITICAL_TURNS.flatMap((turn) =>
    FIXTURE_SEEDS.flatMap((seed) =>
      (['frozen', 'closure'] as const).map((variant) => ({ turn, seed, variant })),
    ),
  )
  for (const item of fixturePlan) {
    const id = `fixture-${item.turn}-${item.seed}-${item.variant}`
    if (progress.matches.some((row) => row.id === id)) continue
    progress.matches.push(
      runFixtureGame(fixtures.get(item.turn)!, item.turn, item.seed, item.variant, progress),
    )
    const now = performance.now()
    progress.durationMs += now - checkpoint
    checkpoint = now
    persist(outputDir, progress)
    onProgress(`fixtures ${progress.matches.filter((row) => row.scope === 'fixture').length}/120`)
  }
  for (const turn of NORMAL_TURNS) {
    for (const seed of NORMAL_SEEDS) {
      const id = `normal-${turn}-${seed}`
      if (progress.normalPositions.some((row) => row.id === id)) continue
      progress.normalPositions.push(
        evaluateNormalPosition(fixtures.get(turn)!, turn, seed, progress),
      )
      persist(outputDir, progress)
      onProgress(`normal ${progress.normalPositions.length}/60`)
    }
  }
  const fullCompetitivePlan = (['heuristic', 'baseline'] as const).flatMap((rival) =>
    (['frozen', 'closure'] as const).flatMap((variant) =>
      Array.from({ length: COMPETITIVE_GAMES_PER_VARIANT_RIVAL }, (_, index) => ({
        rival,
        variant,
        index,
      })),
    ),
  )
  const shard = process.env.CLOSURE_CONFIRMATION_SHARD
  const shardMatch = shard?.match(/^(\d+)\/(\d+)$/)
  const shardIndex = shardMatch ? Number(shardMatch[1]) : 0
  const shardCount = shardMatch ? Number(shardMatch[2]) : 1
  if (
    !Number.isInteger(shardIndex) ||
    !Number.isInteger(shardCount) ||
    shardCount < 1 ||
    shardIndex < 0 ||
    shardIndex >= shardCount
  )
    throw new Error(`Invalid CLOSURE_CONFIRMATION_SHARD: ${shard}`)
  const competitivePlan = fullCompetitivePlan.filter(
    (_item, index) => index % shardCount === shardIndex,
  )
  for (const item of competitivePlan) {
    const color = item.index % 2 === 0 ? 'R' : 'B'
    const id = `competitive-${item.rival}-${item.index + 1}-${color}-${item.variant}`
    if (progress.matches.some((row) => row.id === id)) continue
    progress.matches.push(runCompetitiveGame(item.variant, item.rival, item.index, progress))
    persist(outputDir, progress)
    onProgress(
      `competitive ${progress.matches.filter((row) => row.scope === 'competitive').length}/160`,
    )
  }
  progress.durationMs += performance.now() - checkpoint
  progress.complete =
    progress.matches.filter((row) => row.scope === 'fixture').length === 120 &&
    progress.normalPositions.length === 60 &&
    progress.matches.filter((row) => row.scope === 'competitive').length === 160
  const summary = finalArtifacts(outputDir, progress, source)
  persist(outputDir, progress)
  return { summary, progress }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(
    JSON.stringify(
      (
        await confirmClosureThreatVerification(
          process.argv[2] ?? 'traza_humano_mcts_g_e09743f2.json',
          process.argv[3] ?? OUTPUT_DIR,
        )
      ).summary,
      null,
      2,
    ),
  )
