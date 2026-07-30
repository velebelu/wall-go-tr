import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
  measureHumanChallengeConfidence,
} from '@/agents/humanChallengeMCTS'
import {
  calculateContestedRegionSupport,
  evaluatePositionWithBreakdown,
} from '@/engine/evaluatePosition'
import { applyFullAction } from '@/engine/gameSimulator'
import {
  searchBestActionStaged,
  type MCTSEvaluationDiagnostics,
  type MCTSStageDecision,
} from '@/engine/mcts/MCTS'
import type { MCTSConfig, MCTSResult } from '@/engine/mcts/types'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'
import { deserializeGameSnapshot, type SerializableGameSnapshot } from '@/utils/humanMCTSTrace'
import { getTerritoryMap } from '@/utils/territory'
import { createPlayableMCTSRng } from '@/agents/mctsWorkerDecision'
import { chooseHeuristicOpponentActionQ4, createSeededRngQ4 } from './trainLearningAgentQ4'

export const STRATEGIC_SMOKE_OUTPUT =
  'data/entrenamiento/mcts/benchmark_utilidad_territorial_v1_smoke'
export const STRATEGIC_SMOKE_SELECTION_SEED = 0xc2010001
export const STRATEGIC_SMOKE_CONTINUATION_SEED = 0xc2011001
export const STRATEGIC_PILOT_OUTPUT =
  'data/entrenamiento/mcts/benchmark_utilidad_territorial_v1_pilot'
export const STRATEGIC_PILOT_SELECTION_SEEDS = [0xc2020001, 0xc2020002] as const
export const STRATEGIC_PILOT_CONTINUATION_SEEDS = [0xc2021001, 0xc2021002] as const

const VOLATILE_STATE_KEYS = new Set(['result', 'createdAt', 'updatedAt', 'timestamp', 'metadata'])

export function canonicalize(value: unknown, excludeVolatileStateFields = false): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([key]) => !excludeVolatileStateFields || !VOLATILE_STATE_KEYS.has(key))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      )
    }
    return item
  }
  return JSON.stringify(normalize(value))
}

export function stateFingerprint(state: unknown): string {
  return createHash('sha256').update(canonicalize(state, true)).digest('hex')
}

export function stateActionFingerprint(state: unknown, action: PlayerAction): string {
  return createHash('sha256')
    .update(`${canonicalize(state, true)}|${canonicalize(action)}`)
    .digest('hex')
}

export function findDuplicateFingerprints(items: readonly { fingerprint: string }[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const { fingerprint } of items) {
    if (seen.has(fingerprint)) duplicates.add(fingerprint)
    seen.add(fingerprint)
  }
  return [...duplicates].sort()
}

export interface StrategicFixture {
  id: string
  type: string
  source: string
  state: SerializableGameSnapshot
  player: Player
  legalActions: PlayerAction[]
}

export function validateStrategicFixture(fixture: StrategicFixture): GameSnapshot {
  const state = deserializeGameSnapshot(fixture.state)
  if (state.turn !== fixture.player) throw new Error(`${fixture.id}: turn/player mismatch`)
  const generated = new Set(getLegalActions(state).map((action) => canonicalize(action)))
  if (
    !fixture.legalActions.length ||
    fixture.legalActions.some((action) => !generated.has(canonicalize(action)))
  )
    throw new Error(`${fixture.id}: persisted illegal action`)
  return state
}

function actionKey(action: PlayerAction): string {
  return canonicalize(action)
}

export function runDecision(
  state: GameSnapshot,
  config: MCTSConfig,
  selectionSeed = STRATEGIC_SMOKE_SELECTION_SEED,
) {
  const diagnostics: MCTSEvaluationDiagnostics = {
    metricEvaluationCalls: 0,
    metricTotalElapsedMs: 0,
  }
  const started = performance.now()
  const staged = searchBestActionStaged(
    state,
    state.turn,
    config,
    {
      simulationTargets: [250, 500],
      timeLimitMs: 5_000,
      evaluationDiagnostics: diagnostics,
      shouldContinue: (result): MCTSStageDecision => {
        const confidence = measureHumanChallengeConfidence(result)
        return {
          continueSearch: confidence.lowConfidence,
          reason: confidence.lowConfidence ? 'low-confidence' : 'confident',
        }
      },
    },
    createPlayableMCTSRng(selectionSeed),
  )
  return {
    result: staged.result,
    elapsedMs: performance.now() - started,
    completedSimulations: staged.result.rootVisits,
    stoppedByTimeLimit: staged.stoppedByTimeLimit,
    ...diagnostics,
    metricMeanElapsedUs: diagnostics.metricEvaluationCalls
      ? (diagnostics.metricTotalElapsedMs * 1_000) / diagnostics.metricEvaluationCalls
      : 0,
  }
}

function territory(state: GameSnapshot): Record<Player, number> {
  const result: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board))
    for (const owner of row) if (owner) result[owner]++
  return result
}

function continueHeuristic(
  state: GameSnapshot,
  action: PlayerAction,
  continuationSeed = STRATEGIC_SMOKE_CONTINUATION_SEED,
) {
  let current = applyFullAction(state, action).state
  const rng = createSeededRngQ4(continuationSeed)
  for (let turn = 0; turn < 250 && current.phase !== 'finished' && !current.result; turn++) {
    const legal = getLegalActions(current)
    if (!legal.length) break
    current = applyFullAction(current, chooseHeuristicOpponentActionQ4(current, rng)).state
  }
  return territory(current)
}

function loadHumanFixture(turn: number, type: string): StrategicFixture {
  const source = [24, 26, 28, 30, 32].includes(turn)
    ? `data/entrenamiento/mcts/evaluacion_closure_threat_verification/controls/turn_${turn}.fixture.json`
    : `data/entrenamiento/mcts/analisis_derrota_humana_g_e09743f2/turn_${turn}.fixture.json`
  const raw = JSON.parse(readFileSync(source, 'utf8'))
  return {
    id: `human-e09743f2-turn-${turn}`,
    type,
    source,
    state: raw.stateBefore,
    player: raw.player,
    legalActions: raw.legalActions,
  }
}

function loadHarmfulFixture(): StrategicFixture {
  const source =
    'data/entrenamiento/mcts/captura_dirigida_closure_threat/fixtures/directed-21-heuristic-R-3238526996-turn-40-7401577bec4a.json'
  const raw = JSON.parse(readFileSync(source, 'utf8'))
  return {
    id: raw.interventionId,
    type: 'historical-harmful-intervention',
    source,
    state: raw.state,
    player: raw.player,
    legalActions: raw.legalActions,
  }
}

export function loadSmokeFixtures(): StrategicFixture[] {
  return [
    loadHumanFixture(36, 'last-defensive-opportunity'),
    loadHumanFixture(38, 'closure-inevitable'),
    loadHarmfulFixture(),
    loadHumanFixture(28, 'negative-control'),
  ]
}

export function loadPilotFixtures(): StrategicFixture[] {
  const human = [
    loadHumanFixture(34, 'human-critical'),
    loadHumanFixture(36, 'human-critical'),
    loadHumanFixture(38, 'human-critical'),
    ...([24, 26, 28, 30, 32] as const).map((turn) => loadHumanFixture(turn, 'human-control')),
  ]
  const directory = 'data/entrenamiento/mcts/captura_dirigida_closure_threat/fixtures'
  const directed = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name): StrategicFixture => {
      const source = path.join(directory, name).split('\\').join('/')
      const raw = JSON.parse(readFileSync(source, 'utf8'))
      return {
        id: raw.interventionId,
        type: 'directed-closure-intervention',
        source,
        state: raw.state,
        player: raw.player,
        legalActions: raw.legalActions,
      }
    })
  return [...human, ...directed]
}

function summarizeDecision(result: MCTSResult) {
  return {
    initialMCTSAction: result.originalAction ?? result.action,
    finalActionAfterTacticalVerification: result.action,
    actionChangedByTacticalVerification:
      actionKey(result.originalAction ?? result.action) !== actionKey(result.action),
    score: result.value,
  }
}

export function runStrategicSmoke(outputDir = STRATEGIC_SMOKE_OUTPUT) {
  if (existsSync(outputDir)) throw new Error(`Refusing to overwrite existing smoke: ${outputDir}`)
  const baselineConfig: MCTSConfig = {
    ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
    contestedRegionSupport: { enabled: false, weight: 0 },
  }
  const candidateConfig: MCTSConfig = {
    ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
    contestedRegionSupport: { enabled: true, weight: 1 },
  }
  const rows = loadSmokeFixtures().map((fixture) => {
    const state = validateStrategicFixture(fixture)
    const baseline = runDecision(state, baselineConfig)
    const candidate = runDecision(state, candidateConfig)
    const baselineSummary = summarizeDecision(baseline.result)
    const candidateSummary = summarizeDecision(candidate.result)
    const initialChanged =
      actionKey(baselineSummary.initialMCTSAction) !== actionKey(candidateSummary.initialMCTSAction)
    const finalChanged =
      actionKey(baselineSummary.finalActionAfterTacticalVerification) !==
      actionKey(candidateSummary.finalActionAfterTacticalVerification)
    let continuation
    if (finalChanged) {
      const baseTerritory = continueHeuristic(
        state,
        baselineSummary.finalActionAfterTacticalVerification,
      )
      const candidateTerritory = continueHeuristic(
        state,
        candidateSummary.finalActionAfterTacticalVerification,
      )
      const perspective = fixture.player
      const rival = perspective === 'R' ? 'B' : 'R'
      continuation = {
        baselineTerritory: baseTerritory,
        candidateTerritory,
        territoryDiffDelta:
          candidateTerritory[perspective] -
          candidateTerritory[rival] -
          (baseTerritory[perspective] - baseTerritory[rival]),
      }
    }
    return {
      fixture: fixture.id,
      type: fixture.type,
      source: fixture.source,
      stateFingerprint: stateFingerprint(fixture.state),
      baseline: { ...baselineSummary, ...baseline },
      candidate: { ...candidateSummary, ...candidate },
      actionChangedInsideTree: initialChanged,
      finalActionChanged: finalChanged,
      changeOrigin: initialChanged
        ? finalChanged
          ? 'tree-and-possibly-tactical'
          : 'tree-only-final-converged'
        : finalChanged
          ? 'tactical-verification'
          : 'none',
      evaluationBreakdown: {
        baseline: evaluatePositionWithBreakdown(state, fixture.player),
        candidate: evaluatePositionWithBreakdown(state, fixture.player, {
          contestedRegionSupport: { enabled: true, weight: 1 },
        }),
      },
      continuation,
    }
  })
  const fingerprints = rows.map((row) => ({ fingerprint: row.stateFingerprint }))
  const artifact = {
    schema: 'StrategicPositionSmokeV1',
    selectionSeed: STRATEGIC_SMOKE_SELECTION_SEED,
    continuationSeed: STRATEGIC_SMOKE_CONTINUATION_SEED,
    duplicateStateFingerprints: findDuplicateFingerprints(fingerprints),
    rows,
  }
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(
    path.join(outputDir, 'smoke_results.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
  return artifact
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function jsonl(rows: readonly unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

function continuationResult(
  state: GameSnapshot,
  action: PlayerAction,
  continuationSeed: number,
  perspective: Player,
) {
  let current = applyFullAction(state, action).state
  const rng = createSeededRngQ4(continuationSeed)
  let turnCount = 0
  for (; turnCount < 250 && current.phase !== 'finished' && !current.result; turnCount++) {
    const legal = getLegalActions(current)
    if (!legal.length) break
    current = applyFullAction(current, chooseHeuristicOpponentActionQ4(current, rng)).state
  }
  const score = territory(current)
  const rival = perspective === 'R' ? 'B' : 'R'
  return {
    finalTerritory: score,
    territoryDiff: score[perspective] - score[rival],
    winner: current.result?.winner ?? null,
    terminalReason:
      current.phase === 'finished' || current.result?.finished
        ? current.result?.tie
          ? 'tie'
          : 'finished'
        : turnCount >= 250
          ? 'turn-limit'
          : 'no-legal-actions',
    turnCount,
  }
}

function classifyChange(baseline: MCTSResult, candidate: MCTSResult) {
  const baselineInitial = baseline.originalAction ?? baseline.action
  const candidateInitial = candidate.originalAction ?? candidate.action
  const initialChanged = actionKey(baselineInitial) !== actionKey(candidateInitial)
  const finalChanged = actionKey(baseline.action) !== actionKey(candidate.action)
  const baselineSubstituted = actionKey(baselineInitial) !== actionKey(baseline.action)
  const candidateSubstituted = actionKey(candidateInitial) !== actionKey(candidate.action)
  const differentialSubstitution = baselineSubstituted !== candidateSubstituted
  const classification =
    !initialChanged && !finalChanged
      ? 'no_change'
      : !initialChanged
        ? 'tactical_verification_change_only'
        : differentialSubstitution
          ? 'tree_and_tactical_change'
          : 'tree_change_only'
  return {
    classification,
    initialChanged,
    finalChanged,
    baselineSubstituted,
    candidateSubstituted,
  }
}

interface PilotSelectionRow {
  configuration: 'baseline' | 'candidate'
  elapsedMs: number
  completedSimulations: number
  stoppedByTimeLimit: boolean
  metricEvaluationCalls: number
  metricTotalElapsedMs: number
  [key: string]: unknown
}

interface PilotComparison extends ReturnType<typeof classifyChange> {
  fixtureId: string
  selectionSeed: number
  baselineFinalAction: PlayerAction
  candidateFinalAction: PlayerAction
}

interface PilotContinuationRow {
  pairedDelta: number
  [key: string]: unknown
}

interface PilotIntervention {
  fixtureId: string
  selectionSeed: number
  deltas: number[]
  classification: 'pilot_positive' | 'pilot_negative' | 'pilot_neutral' | 'pilot_mixed'
}

export function runStrategicPilot(outputDir = STRATEGIC_PILOT_OUTPUT) {
  if (existsSync(outputDir)) throw new Error(`Refusing to overwrite existing pilot: ${outputDir}`)
  const frozenBefore = JSON.stringify(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG)
  const baselineConfig: MCTSConfig = {
    ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
    contestedRegionSupport: { enabled: false, weight: 0 },
  }
  const candidateConfig: MCTSConfig = {
    ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
    contestedRegionSupport: { enabled: true, weight: 1 },
  }
  const exclusions: Array<{ fixtureId: string; reason: string }> = []
  const fixtures = loadPilotFixtures()
  if (fixtures.length !== 27)
    throw new Error(`Expected 27 pilot fixtures, found ${fixtures.length}`)
  const validated = fixtures.map((fixture) => ({
    fixture,
    state: validateStrategicFixture(fixture),
  }))
  const duplicateFingerprints = findDuplicateFingerprints(
    validated.map(({ fixture }) => ({ fingerprint: stateFingerprint(fixture.state) })),
  )
  if (duplicateFingerprints.length) throw new Error('Duplicate pilot states detected')

  const fixtureRows = validated.map(({ fixture, state }) => {
    const red = calculateContestedRegionSupport(state.board, 'R')
    const blue = calculateContestedRegionSupport(state.board, 'B')
    const base = evaluatePositionWithBreakdown(state, fixture.player)
    const candidate = evaluatePositionWithBreakdown(state, fixture.player, {
      contestedRegionSupport: { enabled: true, weight: 1 },
    })
    return {
      fixtureId: fixture.id,
      type: fixture.type,
      source: fixture.source,
      player: fixture.player,
      turn: fixture.id.match(/turn-(\d+)/)?.[1] ?? null,
      stateFingerprint: stateFingerprint(fixture.state),
      state: fixture.state,
      legalActions: fixture.legalActions,
      contestedRegionSupportRed: red.ownSupport,
      contestedRegionSupportBlue: blue.ownSupport,
      contestedRegionSupportDiff: fixture.player === 'R' ? red.differential : blue.differential,
      newTermContribution: candidate.contestedRegionSupport,
      baseEvaluation: base.total,
      candidateEvaluation: candidate.total,
    }
  })

  const selectionRows: PilotSelectionRow[] = []
  const comparisons: PilotComparison[] = []
  for (const { fixture, state } of validated) {
    const fixtureInfo = fixtureRows.find((row) => row.fixtureId === fixture.id)!
    for (const selectionSeed of STRATEGIC_PILOT_SELECTION_SEEDS) {
      const baseline = runDecision(state, baselineConfig, selectionSeed)
      const candidate = runDecision(state, candidateConfig, selectionSeed)
      const buildRow = (
        configuration: 'baseline' | 'candidate',
        decision: ReturnType<typeof runDecision>,
      ) => {
        const initial = decision.result.originalAction ?? decision.result.action
        const topChildren = [...decision.result.children]
          .sort((a, b) => b.visits - a.visits || b.value - a.value)
          .slice(0, 5)
          .map((child) => {
            const childState = applyFullAction(state, child.action).state
            const support = calculateContestedRegionSupport(childState.board, fixture.player)
            return {
              action: child.action,
              visits: child.visits,
              meanValue: child.value,
              baseEvaluation: evaluatePositionWithBreakdown(childState, fixture.player).total,
              contestedRegionSupportDiff: support.differential,
              newTermContribution: configuration === 'candidate' ? support.differential : 0,
            }
          })
        return {
          fixtureId: fixture.id,
          stateFingerprint: fixtureInfo.stateFingerprint,
          selectionSeed,
          configuration,
          initialMCTSAction: initial,
          finalActionAfterTacticalVerification: decision.result.action,
          initialActionFingerprint: stateActionFingerprint(fixture.state, initial),
          finalActionFingerprint: stateActionFingerprint(fixture.state, decision.result.action),
          completedSimulations: decision.completedSimulations,
          stoppedByTimeLimit: decision.stoppedByTimeLimit,
          elapsedMs: decision.elapsedMs,
          rootVisits: decision.result.rootVisits,
          rootMeanValue:
            decision.result.children.reduce((sum, child) => sum + child.visits * child.value, 0) /
            decision.result.rootVisits,
          topChildren,
          baseEvaluationAtRoot: fixtureInfo.baseEvaluation,
          contestedRegionSupportDiffAtRoot: fixtureInfo.contestedRegionSupportDiff,
          newTermContributionAtRoot:
            configuration === 'candidate' ? fixtureInfo.newTermContribution : 0,
          metricEvaluationCalls: decision.metricEvaluationCalls,
          metricTotalElapsedMs: decision.metricTotalElapsedMs,
          metricMeanElapsedUs: decision.metricMeanElapsedUs,
        }
      }
      selectionRows.push(buildRow('baseline', baseline), buildRow('candidate', candidate))
      comparisons.push({
        fixtureId: fixture.id,
        selectionSeed,
        ...classifyChange(baseline.result, candidate.result),
        baselineFinalAction: baseline.result.action,
        candidateFinalAction: candidate.result.action,
      })
    }
  }

  const continuationRows: PilotContinuationRow[] = []
  const interventions: PilotIntervention[] = []
  for (const comparison of comparisons.filter((row) => row.finalChanged)) {
    const loaded = validated.find(({ fixture }) => fixture.id === comparison.fixtureId)!
    const deltas: number[] = []
    for (const continuationSeed of STRATEGIC_PILOT_CONTINUATION_SEEDS) {
      const baseline = continuationResult(
        loaded.state,
        comparison.baselineFinalAction,
        continuationSeed,
        loaded.fixture.player,
      )
      const candidate = continuationResult(
        loaded.state,
        comparison.candidateFinalAction,
        continuationSeed,
        loaded.fixture.player,
      )
      const pairedDelta = candidate.territoryDiff - baseline.territoryDiff
      deltas.push(pairedDelta)
      continuationRows.push({
        fixtureId: comparison.fixtureId,
        selectionSeed: comparison.selectionSeed,
        continuationSeed,
        baselineFinalTerritory: baseline.finalTerritory,
        candidateFinalTerritory: candidate.finalTerritory,
        baselineTerritoryDiff: baseline.territoryDiff,
        candidateTerritoryDiff: candidate.territoryDiff,
        pairedDelta,
        winnerBaselineBranch: baseline.winner,
        winnerCandidateBranch: candidate.winner,
        terminalReason: { baseline: baseline.terminalReason, candidate: candidate.terminalReason },
        turnCount: { baseline: baseline.turnCount, candidate: candidate.turnCount },
      })
    }
    interventions.push({
      fixtureId: comparison.fixtureId,
      selectionSeed: comparison.selectionSeed,
      deltas,
      classification: deltas.every((delta) => delta > 0)
        ? 'pilot_positive'
        : deltas.every((delta) => delta < 0)
          ? 'pilot_negative'
          : deltas.every((delta) => delta === 0)
            ? 'pilot_neutral'
            : 'pilot_mixed',
    })
  }

  if (JSON.stringify(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG) !== frozenBefore)
    throw new Error('Frozen configuration mutated')
  const diffs = fixtureRows.map((row) => row.contestedRegionSupportDiff)
  const pairedDeltas = continuationRows.map((row) => row.pairedDelta as number)
  const byFixture = new Map<string, PilotComparison[]>()
  for (const row of comparisons) {
    const rows = byFixture.get(row.fixtureId) ?? []
    rows.push(row)
    byFixture.set(row.fixtureId, rows)
  }
  const sensitivity = Array.from(byFixture.entries()).map(([fixtureId, rows]) => {
    const baselineActions = new Set(rows.map((row) => actionKey(row.baselineFinalAction)))
    const candidateActions = new Set(rows.map((row) => actionKey(row.candidateFinalAction)))
    const changes = rows.filter((row) => row.finalChanged).length
    return {
      fixtureId,
      sameBaselineAcrossSeeds: baselineActions.size === 1,
      sameCandidateAcrossSeeds: candidateActions.size === 1,
      changeInBothSeeds: changes === 2,
      changeInOneSeed: changes === 1,
      stability:
        changes === 2 ? 'stable_change' : changes === 1 ? 'seed_sensitive_change' : 'no_change',
    }
  })
  const configurationRows = (configuration: 'baseline' | 'candidate') =>
    selectionRows.filter((row) => row.configuration === configuration)
  const cost = (configuration: 'baseline' | 'candidate') => {
    const rows = configurationRows(configuration)
    const calls = rows.reduce((sum, row) => sum + row.metricEvaluationCalls, 0)
    const metricMs = rows.reduce((sum, row) => sum + row.metricTotalElapsedMs, 0)
    return {
      totalElapsedMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
      meanElapsedMs: mean(rows.map((row) => row.elapsedMs)),
      meanCompletedSimulations: mean(rows.map((row) => row.completedSimulations)),
      stoppedByTimePercent:
        (rows.filter((row) => row.stoppedByTimeLimit).length / rows.length) * 100,
      metricEvaluationCalls: calls,
      metricTotalElapsedMs: metricMs,
      metricMeanElapsedUs: calls ? (metricMs * 1_000) / calls : 0,
    }
  }
  const summary = {
    schema: 'StrategicPositionPilotSummaryV1',
    fixtures: { expected: 27, loaded: fixtures.length, valid: validated.length, exclusions },
    coverage: {
      total: diffs.length,
      zero: diffs.filter((value) => value === 0).length,
      positive: diffs.filter((value) => value > 0).length,
      negative: diffs.filter((value) => value < 0).length,
      nonZero: diffs.filter((value) => value !== 0).length,
      activationPercent: (diffs.filter((value) => value !== 0).length / diffs.length) * 100,
      mean: mean(diffs),
      median: median(diffs),
      minimum: Math.min(...diffs),
      maximum: Math.max(...diffs),
    },
    influence: {
      searches: selectionRows.length,
      comparisons: comparisons.length,
      initialChanges: comparisons.filter((row) => row.initialChanged).length,
      finalChanges: comparisons.filter((row) => row.finalChanged).length,
      changeRatePercent:
        (comparisons.filter((row) => row.finalChanged).length / comparisons.length) * 100,
      classifications: Object.fromEntries(
        [
          'no_change',
          'tree_change_only',
          'tactical_verification_change_only',
          'tree_and_tactical_change',
        ].map((classification) => [
          classification,
          comparisons.filter((row) => row.classification === classification).length,
        ]),
      ),
    },
    provisional: {
      effectiveInterventions: interventions.length,
      classifications: Object.fromEntries(
        ['pilot_positive', 'pilot_negative', 'pilot_neutral', 'pilot_mixed'].map(
          (classification) => [
            classification,
            interventions.filter((row) => row.classification === classification).length,
          ],
        ),
      ),
      pairs: pairedDeltas.length,
      meanDelta: mean(pairedDeltas),
      medianDelta: median(pairedDeltas),
      minimumDelta: pairedDeltas.length ? Math.min(...pairedDeltas) : null,
      maximumDelta: pairedDeltas.length ? Math.max(...pairedDeltas) : null,
    },
    sensitivity,
    cost: { baseline: cost('baseline'), candidate: cost('candidate') },
  }
  const sources = [...new Set(fixtures.map((fixture) => fixture.source))]
  const manifest = {
    schema: 'StrategicPositionPilotManifestV1',
    createdAt: new Date().toISOString(),
    git: {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
    },
    baselineConfig,
    candidateConfig,
    weight: 1,
    selectionSeeds: STRATEGIC_PILOT_SELECTION_SEEDS,
    continuationSeeds: STRATEGIC_PILOT_CONTINUATION_SEEDS,
    sourceFiles: sources.map((file) => ({ file, sha256: sha256File(file) })),
    commands: [
      'npx vitest run src/engine/evaluatePosition.test.ts src/engine/mcts/MCTS.test.ts src/training/evaluateStrategicPositionBenchmark.test.ts',
      'npm run lint',
      'npm run build',
      'node --import ./scripts/run-ts-node-esm.mjs src/training/evaluateStrategicPositionBenchmark.ts --pilot',
    ],
  }
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(path.join(outputDir, 'fixtures.json'), `${JSON.stringify(fixtureRows, null, 2)}\n`)
  writeFileSync(path.join(outputDir, 'selection_results.jsonl'), jsonl(selectionRows))
  writeFileSync(path.join(outputDir, 'paired_continuations.jsonl'), jsonl(continuationRows))
  writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(
    path.join(outputDir, 'report.md'),
    `# Pilot contestedRegionSupport\n\n- Fixtures válidos: ${validated.length}/27\n- Activación: ${summary.coverage.nonZero}/${summary.coverage.total} (${summary.coverage.activationPercent.toFixed(2)} %)\n- Cambios finales: ${summary.influence.finalChanges}/${summary.influence.comparisons}\n- Intervenciones efectivas: ${summary.provisional.effectiveInterventions}\n- Delta territorial medio: ${summary.provisional.meanDelta}\n`,
  )
  return {
    manifest,
    fixtureRows,
    selectionRows,
    continuationRows,
    comparisons,
    interventions,
    summary,
  }
}

export function verifyStrategicPilot(outputDir = STRATEGIC_PILOT_OUTPUT) {
  const target = path.join(outputDir, 'reproducibility_and_sensitivity.json')
  if (existsSync(target)) throw new Error(`Refusing to overwrite verification: ${target}`)
  const fixtureRows = JSON.parse(
    readFileSync(path.join(outputDir, 'fixtures.json'), 'utf8'),
  ) as Array<{ fixtureId: string; contestedRegionSupportDiff: number }>
  const selections = readFileSync(path.join(outputDir, 'selection_results.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as Array<{
    fixtureId: string
    selectionSeed: number
    configuration: 'baseline' | 'candidate'
    initialActionFingerprint: string
    finalActionFingerprint: string
    completedSimulations: number
    stoppedByTimeLimit: boolean
  }>
  const fixtures = loadPilotFixtures()
  const sensitivity = fixtures.map((fixture) => {
    const rows = selections.filter((row) => row.fixtureId === fixture.id)
    const baseline = rows.filter((row) => row.configuration === 'baseline')
    const candidate = rows.filter((row) => row.configuration === 'candidate')
    const changes = STRATEGIC_PILOT_SELECTION_SEEDS.filter((seed) => {
      const left = baseline.find((row) => row.selectionSeed === seed)!
      const right = candidate.find((row) => row.selectionSeed === seed)!
      return left.finalActionFingerprint !== right.finalActionFingerprint
    }).length
    return {
      fixtureId: fixture.id,
      sameBaselineAcrossSeeds:
        new Set(baseline.map((row) => row.finalActionFingerprint)).size === 1,
      sameCandidateAcrossSeeds:
        new Set(candidate.map((row) => row.finalActionFingerprint)).size === 1,
      changeInBothSeeds: changes === 2,
      changeInOneSeed: changes === 1,
      stability:
        changes === 2 ? 'stable_change' : changes === 1 ? 'seed_sensitive_change' : 'no_change',
    }
  })
  const samples = [
    fixtureRows.find((row) => row.contestedRegionSupportDiff === 0)!,
    fixtureRows.find((row) => row.contestedRegionSupportDiff !== 0)!,
  ]
  const fixtureMap = new Map(fixtures.map((fixture) => [fixture.id, fixture]))
  const configs: Record<'baseline' | 'candidate', MCTSConfig> = {
    baseline: {
      ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
      contestedRegionSupport: { enabled: false, weight: 0 },
    },
    candidate: {
      ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
      contestedRegionSupport: { enabled: true, weight: 1 },
    },
  }
  const repeated = samples.flatMap((sample) => {
    const fixture = fixtureMap.get(sample.fixtureId)!
    const state = validateStrategicFixture(fixture)
    return STRATEGIC_PILOT_SELECTION_SEEDS.flatMap((selectionSeed) =>
      (['baseline', 'candidate'] as const).map((configuration) => {
        const decision = runDecision(state, configs[configuration], selectionSeed)
        const initial = decision.result.originalAction ?? decision.result.action
        const persisted = selections.find(
          (row) =>
            row.fixtureId === fixture.id &&
            row.selectionSeed === selectionSeed &&
            row.configuration === configuration,
        )!
        const actualInitial = stateActionFingerprint(fixture.state, initial)
        const actualFinal = stateActionFingerprint(fixture.state, decision.result.action)
        return {
          fixtureId: fixture.id,
          termKind: sample.contestedRegionSupportDiff === 0 ? 'zero' : 'non-zero',
          selectionSeed,
          configuration,
          actionsReproducible:
            actualInitial === persisted.initialActionFingerprint &&
            actualFinal === persisted.finalActionFingerprint,
          simulationsReproducible:
            persisted.stoppedByTimeLimit ||
            decision.completedSimulations === persisted.completedSimulations,
          persistedSimulations: persisted.completedSimulations,
          repeatedSimulations: decision.completedSimulations,
        }
      }),
    )
  })
  const artifact = {
    schema: 'StrategicPositionPilotVerificationV1',
    sensitivity,
    repeated,
    reproducible: repeated.every((row) => row.actionsReproducible && row.simulationsReproducible),
  }
  writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`)
  return artifact
}

if (process.argv[1]?.endsWith('evaluateStrategicPositionBenchmark.ts')) {
  if (process.argv.includes('--verify-pilot')) verifyStrategicPilot()
  else if (process.argv.includes('--pilot')) runStrategicPilot()
  else runStrategicSmoke()
}
