import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXPANSION_WEIGHT,
  MOBILITY_WEIGHT,
  TERRITORY_WEIGHT,
  TRAPPED_WEIGHT,
} from '@/engine/evaluatePosition'
import { applyFullAction } from '@/engine/gameSimulator'
import { searchBestAction } from '@/engine/mcts/MCTS'
import type { MCTSConfig } from '@/engine/mcts/types'
import {
  Q5_CHECKPOINT_ENTRIES,
  Q5_CHECKPOINT_SHA256,
  Q5_CHECKPOINT_SOURCE,
  Q5LearningAgent,
  combineQ5Confidence,
  type FrozenQ5Model,
  type Q5ConfidenceLoadStats,
} from '@/agents/Q5LearningAgent'
import { Q5_EPSILON, Q5_MIN_CONFIDENCE, Q5_Q_MARGIN } from '@/agents/q5Policy'
import type { Player, PlayerAction } from '@/lib/types'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { getTerritoryCounts } from './compareLearningAgents'
import {
  chooseHeuristicOpponentActionQ4,
  chooseRandomActionWithRngQ4,
  createSeededRngQ4,
} from './trainLearningAgentQ4'
import {
  Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
  finalizeGameIfNeeded,
  hashFile,
  loadQ5ConfidenceMap,
  loadQTable,
  loadQUpdateCountsFromJsonl,
  qTableFingerprint,
} from './trainLearningAgentQ5'
import {
  Q5_POLICY_COMPARISON_QTABLE_PATH,
  Q5_POLICY_COMPARISON_Q_UPDATE_LOG_PATHS,
} from './evaluateQ5PolicyComparison'

export const MCTS_EVALUATION_VERSION = 'mcts-baseline-v1'
export const MCTS_BASELINE_OUTPUT_DIR = path.join('data/entrenamiento/mcts/evaluacion_baseline')
export const MCTS_BASELINE_SEED = 613_000
export const MCTS_BASELINE_MAX_TURNS = 250

export interface NamedMCTSConfig extends MCTSConfig {
  name: string
}

export const MCTS_BASELINE_CONFIGS: NamedMCTSConfig[] = [
  {
    name: 'MCTS-50',
    simulations: 50,
    explorationConstant: Math.SQRT2,
    maxDepth: 60,
    rolloutPolicy: 'random',
  },
  {
    name: 'MCTS-200',
    simulations: 200,
    explorationConstant: Math.SQRT2,
    maxDepth: 60,
    rolloutPolicy: 'random',
  },
  {
    name: 'MCTS-500',
    simulations: 500,
    explorationConstant: Math.SQRT2,
    maxDepth: 60,
    rolloutPolicy: 'random',
  },
]

export type MCTSOpponent = 'random' | 'heuristic' | 'q5-final' | 'baseline-mcts'

export interface MCTSScheduleItem {
  config: NamedMCTSConfig
  rival: MCTSOpponent
  colorMCTS: Player
  game: number
  seed: number
}

export interface MCTSGameResult extends MCTSScheduleItem {
  winner: Player | 'tie'
  mctsWon: boolean
  tie: boolean
  territoryMCTS: number
  territoryRival: number
  territoryDiff: number
  turns: number
  durationMs: number
  mctsDecisionTimeMs: number
  mctsDecisions: number
  averageDecisionMs: number
  averageRootLegalActions: number
  averageRootExpandedChildren: number
  averageMaxDepthReached: number
  averageSelectedDepth: number
  averageRootExplorationRatio: number
  averageQPriorKnownActions: number
  averageQPriorReliableActions: number
  qPriorSelectedActionKnownRate: number
  qPriorSelectedActionReliableRate: number
  averageSelectedQPrior: number
  mctsActionsLegal: boolean
  /** Optional evaluator trace; it does not participate in search or persisted baseline CSVs. */
  mctsActionSignatures?: string[]
  tacticalCandidatesChecked?: number
  tacticalSelectionChanges?: number
  tacticalSelectionChangeRate?: number
  averageVerificationTimeMs?: number
  immediateTerminalLossesAvoided?: number
  closureThreatsDetected?: number
  averageClosureThreatPenalty?: number
}

export interface MCTSAggregateMetrics {
  games: number
  wins: number
  losses: number
  ties: number
  winRate: number
  averageTerritoryMCTS: number
  averageTerritoryRival: number
  averageTerritoryDiff: number
  averageTurns: number
  totalTimeMs: number
  averageGameTimeMs: number
  averageDecisionMs: number
  averageRootLegalActions: number
  averageRootExpandedChildren: number
  averageMaxDepthReached: number
  averageSelectedDepth: number
  averageRootExplorationRatio: number
  averageQPriorKnownActions: number
  averageQPriorReliableActions: number
  qPriorSelectedActionKnownRate: number
  qPriorSelectedActionReliableRate: number
  averageSelectedQPrior: number
  simulations: number
}

export interface MCTSSummaryGroup {
  config: NamedMCTSConfig
  rival: MCTSOpponent
  aggregate: MCTSAggregateMetrics
  byColor: Record<Player, MCTSAggregateMetrics>
}

export interface EvaluateMCTSOptions {
  configs?: readonly NamedMCTSConfig[]
  rivals?: readonly MCTSOpponent[]
  gamesPerCombination?: number
  gamesPerRival?: Partial<Record<MCTSOpponent, number>>
  seedBase?: number
  maxTurns?: number
  outputDir?: string
  overwrite?: boolean
  progressEvery?: number
  now?: () => number
  createdAt?: string
  outputFilePrefix?: string
  evaluationVersion?: string
  mctsOpponentConfig?: MCTSConfig | ((pairing: MCTSScheduleItem) => MCTSConfig)
}

interface FrozenQ5EvaluationResources {
  model: FrozenQ5Model
  qTablePath: string
  qTableFingerprintBefore: string
  resourceHashesBefore: Record<string, string>
  confidenceStats: Q5ConfidenceLoadStats
}

export const EXPECTED_Q5_CONFIDENCE_STATS: Q5ConfidenceLoadStats = {
  confidenceMapEntries: 19_652,
  qLearningUpdateCountsEntries: 12_068,
  effectiveConfidenceEntries: 27_815,
  maxEffectiveConfidence: 778,
  effectiveEntriesAtLeast10: 404,
}

export function assertQ5ConfidenceStats(stats: Q5ConfidenceLoadStats): void {
  for (const [metric, expected] of Object.entries(EXPECTED_Q5_CONFIDENCE_STATS)) {
    const actual = stats[metric as keyof Q5ConfidenceLoadStats]
    if (actual !== expected) {
      throw new Error(
        `Invalid frozen Q5 confidence resources: ${metric} expected ${expected}, received ${actual}. MCTS games were not started.`,
      )
    }
  }
}

export function buildMCTSEvaluationSchedule(
  configs: readonly NamedMCTSConfig[] = MCTS_BASELINE_CONFIGS,
  rivals: readonly MCTSOpponent[] = ['random', 'heuristic', 'q5-final'],
  gamesPerCombination = 100,
  seedBase = MCTS_BASELINE_SEED,
  gamesPerRival?: Partial<Record<MCTSOpponent, number>>,
): MCTSScheduleItem[] {
  const schedule: MCTSScheduleItem[] = []
  let rivalOffset = 0
  for (const config of configs) {
    rivalOffset = 0
    for (const rival of rivals) {
      const gamesForRival = gamesPerRival?.[rival] ?? gamesPerCombination
      if (gamesForRival <= 0 || gamesForRival % 2 !== 0) {
        throw new Error('Games per rival must be positive even numbers')
      }
      for (const colorMCTS of ['R', 'B'] as const) {
        for (let game = 1; game <= gamesForRival / 2; game++) {
          const colorOffset = colorMCTS === 'R' ? 0 : gamesForRival / 2
          schedule.push({
            config,
            rival,
            colorMCTS,
            game,
            seed: seedBase + rivalOffset + colorOffset + game,
          })
        }
      }
      rivalOffset += gamesForRival
    }
  }
  return schedule
}

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function actionSignature(action: PlayerAction): string {
  return JSON.stringify(action)
}

function isLegalAction(action: PlayerAction, legalActions: PlayerAction[]): boolean {
  const signature = actionSignature(action)
  return legalActions.some((legalAction) => actionSignature(legalAction) === signature)
}

export function loadFrozenQ5EvaluationResources(): FrozenQ5EvaluationResources {
  const qTablePath = path.resolve(Q5_POLICY_COMPARISON_QTABLE_PATH)
  const confidencePath = path.resolve(Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH)
  const updatePaths = Q5_POLICY_COMPARISON_Q_UPDATE_LOG_PATHS.map((filePath) =>
    path.resolve(filePath),
  )
  const qTable = Object.freeze({ ...loadQTable(qTablePath) })
  if (hashFile(qTablePath) !== Q5_CHECKPOINT_SHA256) {
    throw new Error('Frozen Q5 checkpoint hash does not match the approved model')
  }
  if (Object.keys(qTable).length !== Q5_CHECKPOINT_ENTRIES) {
    throw new Error('Frozen Q5 checkpoint entry count does not match the approved model')
  }
  const inheritedConfidence = loadQ5ConfidenceMap(confidencePath)
  const updateCounts = loadQUpdateCountsFromJsonl(updatePaths)
  const inheritedObservations = new Map(
    Array.from(inheritedConfidence.entries(), ([key, value]) => [key, value.observations]),
  )
  const { confidence, stats: confidenceStats } = combineQ5Confidence(
    inheritedObservations,
    updateCounts,
  )
  assertQ5ConfidenceStats(confidenceStats)
  const resourcePaths = [qTablePath, confidencePath, ...updatePaths]
  return {
    model: Object.freeze({
      qTable,
      confidence,
      source: Q5_CHECKPOINT_SOURCE,
      sha256: Q5_CHECKPOINT_SHA256,
    }),
    qTablePath,
    qTableFingerprintBefore: qTableFingerprint(qTable),
    resourceHashesBefore: Object.fromEntries(
      resourcePaths.map((filePath) => [filePath, hashFile(filePath)]),
    ),
    confidenceStats,
  }
}

async function runSingleMCTSGame(params: {
  pairing: MCTSScheduleItem
  maxTurns: number
  now: () => number
  q5Resources?: FrozenQ5EvaluationResources
  mctsOpponentConfig?: MCTSConfig
}): Promise<MCTSGameResult> {
  const mctsRng = createSeededRngQ4(params.pairing.seed ^ 0x9e3779b9)
  const rivalRng = createSeededRngQ4(params.pairing.seed ^ 0x85ebca6b)
  const q5Agent = params.q5Resources
    ? new Q5LearningAgent({
        modelLoader: async () => params.q5Resources!.model,
        rng: rivalRng,
      })
    : undefined
  let state = makeInitialState()
  let turns = 0
  let mctsDecisions = 0
  let mctsDecisionTimeMs = 0
  let rootLegalActions = 0
  let rootExpandedChildren = 0
  let maxDepthReached = 0
  let selectedDepth = 0
  let rootExplorationRatio = 0
  let qPriorKnownActions = 0
  let qPriorReliableActions = 0
  let qPriorSelectedActionKnown = 0
  let qPriorSelectedActionReliable = 0
  let selectedQPrior = 0
  let mctsActionsLegal = true
  let tacticalCandidatesChecked = 0
  let tacticalSelectionChanges = 0
  let verificationTimeMs = 0
  let immediateTerminalLossesAvoided = 0
  let closureThreatsDetected = 0
  let closureThreatPenalty = 0
  const mctsActionSignatures: string[] = []
  const gameStartedAt = params.now()

  while (state.phase !== 'finished' && !state.result && turns < params.maxTurns) {
    const previousState = snapshotFromState(state)
    const legalActions = getLegalActions(previousState)
    if (legalActions.length === 0) break
    let action: PlayerAction

    if (previousState.turn === params.pairing.colorMCTS) {
      const decisionStartedAt = params.now()
      const searchResult = searchBestAction(
        previousState,
        params.pairing.colorMCTS,
        params.pairing.config,
        mctsRng,
        params.q5Resources
          ? {
              qTable: params.q5Resources.model.qTable,
              confidence: params.q5Resources.model.confidence,
              minConfidence: Q5_MIN_CONFIDENCE,
            }
          : undefined,
      )
      action = searchResult.action
      mctsActionSignatures.push(actionSignature(action))
      mctsDecisionTimeMs += params.now() - decisionStartedAt
      mctsDecisions++
      rootLegalActions += searchResult.rootLegalActions
      rootExpandedChildren += searchResult.rootExpandedChildren
      maxDepthReached += searchResult.maxDepthReached
      selectedDepth += searchResult.averageSelectedDepth
      rootExplorationRatio += searchResult.rootLegalActions
        ? searchResult.rootExpandedChildren / searchResult.rootLegalActions
        : 0
      qPriorKnownActions += searchResult.qPriorKnownActions ?? 0
      qPriorReliableActions += searchResult.qPriorReliableActions ?? 0
      qPriorSelectedActionKnown += Number(searchResult.qPriorSelectedActionKnown ?? false)
      qPriorSelectedActionReliable += Number(searchResult.qPriorSelectedActionReliable ?? false)
      selectedQPrior += searchResult.averageSelectedQPrior ?? 0
      tacticalCandidatesChecked += searchResult.tacticalCandidatesChecked ?? 0
      tacticalSelectionChanges += Number(searchResult.tacticalSelectionChanged ?? false)
      verificationTimeMs += searchResult.verificationTimeMs ?? 0
      immediateTerminalLossesAvoided += Number(searchResult.immediateTerminalLossAvoided ?? false)
      closureThreatsDetected += searchResult.closureThreatsDetected ?? 0
      closureThreatPenalty += searchResult.closureThreatPenalty ?? 0
      const legal = isLegalAction(action, legalActions)
      mctsActionsLegal &&= legal
      if (!legal) throw new Error('MCTS returned an illegal action during baseline evaluation')
    } else if (params.pairing.rival === 'random') {
      action = chooseRandomActionWithRngQ4(legalActions, rivalRng)
    } else if (params.pairing.rival === 'heuristic') {
      action = chooseHeuristicOpponentActionQ4(previousState, rivalRng)
    } else if (params.pairing.rival === 'q5-final') {
      if (!q5Agent) throw new Error('Frozen Q5 resources were not loaded')
      action = await q5Agent.getAction(previousState)
      if (!isLegalAction(action, legalActions)) {
        throw new Error('Frozen Q5 returned an illegal action during baseline evaluation')
      }
    } else {
      action = searchBestAction(
        previousState,
        previousState.turn,
        params.mctsOpponentConfig ?? {
          simulations: 50,
          explorationConstant: Math.SQRT2,
          maxDepth: 60,
          rolloutPolicy: 'mixed',
          heuristicProbability: 0.8,
          expansionPolicy: 'heuristic',
          progressiveWidening: true,
          wideningConstant: 2,
          wideningExponent: 0.5,
          qPriorWeight: 0,
          tacticalVerification: false,
        },
        rivalRng,
      ).action
    }

    const applied = applyFullAction(state, action)
    state = applied.state
    turns += applied.atomicActions
  }

  state = finalizeGameIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const rivalColor = getOpponent(params.pairing.colorMCTS)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')
  const durationMs = params.now() - gameStartedAt
  return {
    ...params.pairing,
    winner,
    mctsWon: winner === params.pairing.colorMCTS,
    tie: winner === 'tie',
    territoryMCTS: territory[params.pairing.colorMCTS],
    territoryRival: territory[rivalColor],
    territoryDiff: territory[params.pairing.colorMCTS] - territory[rivalColor],
    turns,
    durationMs: roundMetric(durationMs),
    mctsDecisionTimeMs: roundMetric(mctsDecisionTimeMs),
    mctsDecisions,
    averageDecisionMs: mctsDecisions ? roundMetric(mctsDecisionTimeMs / mctsDecisions) : 0,
    averageRootLegalActions: mctsDecisions ? roundMetric(rootLegalActions / mctsDecisions) : 0,
    averageRootExpandedChildren: mctsDecisions
      ? roundMetric(rootExpandedChildren / mctsDecisions)
      : 0,
    averageMaxDepthReached: mctsDecisions ? roundMetric(maxDepthReached / mctsDecisions) : 0,
    averageSelectedDepth: mctsDecisions ? roundMetric(selectedDepth / mctsDecisions) : 0,
    averageRootExplorationRatio: mctsDecisions
      ? roundMetric(rootExplorationRatio / mctsDecisions)
      : 0,
    averageQPriorKnownActions: mctsDecisions ? roundMetric(qPriorKnownActions / mctsDecisions) : 0,
    averageQPriorReliableActions: mctsDecisions
      ? roundMetric(qPriorReliableActions / mctsDecisions)
      : 0,
    qPriorSelectedActionKnownRate: mctsDecisions
      ? roundMetric(qPriorSelectedActionKnown / mctsDecisions)
      : 0,
    qPriorSelectedActionReliableRate: mctsDecisions
      ? roundMetric(qPriorSelectedActionReliable / mctsDecisions)
      : 0,
    averageSelectedQPrior: mctsDecisions ? roundMetric(selectedQPrior / mctsDecisions) : 0,
    mctsActionsLegal,
    mctsActionSignatures,
    tacticalCandidatesChecked,
    tacticalSelectionChanges,
    tacticalSelectionChangeRate: mctsDecisions
      ? roundMetric(tacticalSelectionChanges / mctsDecisions)
      : 0,
    averageVerificationTimeMs: mctsDecisions ? roundMetric(verificationTimeMs / mctsDecisions) : 0,
    immediateTerminalLossesAvoided,
    closureThreatsDetected,
    averageClosureThreatPenalty: mctsDecisions ? closureThreatPenalty / mctsDecisions : 0,
  }
}

export function summarizeMCTSResults(
  results: MCTSGameResult[],
  simulations: number,
): MCTSAggregateMetrics {
  const wins = results.filter((result) => result.mctsWon).length
  const ties = results.filter((result) => result.tie).length
  const losses = results.length - wins - ties
  const totalDecisionTime = results.reduce((sum, result) => sum + result.mctsDecisionTimeMs, 0)
  const totalDecisions = results.reduce((sum, result) => sum + result.mctsDecisions, 0)
  const totalRootLegalActions = results.reduce(
    (sum, result) => sum + result.averageRootLegalActions * result.mctsDecisions,
    0,
  )
  const weightedDecisionMetric = (selector: (result: MCTSGameResult) => number): number =>
    totalDecisions
      ? roundMetric(
          results.reduce((sum, result) => sum + selector(result) * result.mctsDecisions, 0) /
            totalDecisions,
        )
      : 0
  const average = (selector: (result: MCTSGameResult) => number): number =>
    results.length
      ? roundMetric(results.reduce((sum, result) => sum + selector(result), 0) / results.length)
      : 0
  const totalTimeMs = roundMetric(results.reduce((sum, result) => sum + result.durationMs, 0))

  return {
    games: results.length,
    wins,
    losses,
    ties,
    winRate: results.length ? roundMetric((wins / results.length) * 100) : 0,
    averageTerritoryMCTS: average((result) => result.territoryMCTS),
    averageTerritoryRival: average((result) => result.territoryRival),
    averageTerritoryDiff: average((result) => result.territoryDiff),
    averageTurns: average((result) => result.turns),
    totalTimeMs,
    averageGameTimeMs: results.length ? roundMetric(totalTimeMs / results.length) : 0,
    averageDecisionMs: totalDecisions ? roundMetric(totalDecisionTime / totalDecisions) : 0,
    averageRootLegalActions: totalDecisions
      ? roundMetric(totalRootLegalActions / totalDecisions)
      : 0,
    averageRootExpandedChildren: weightedDecisionMetric(
      (result) => result.averageRootExpandedChildren,
    ),
    averageMaxDepthReached: weightedDecisionMetric((result) => result.averageMaxDepthReached),
    averageSelectedDepth: weightedDecisionMetric((result) => result.averageSelectedDepth),
    averageRootExplorationRatio: weightedDecisionMetric(
      (result) => result.averageRootExplorationRatio,
    ),
    averageQPriorKnownActions: weightedDecisionMetric(
      (result) => result.averageQPriorKnownActions ?? 0,
    ),
    averageQPriorReliableActions: weightedDecisionMetric(
      (result) => result.averageQPriorReliableActions ?? 0,
    ),
    qPriorSelectedActionKnownRate: weightedDecisionMetric(
      (result) => result.qPriorSelectedActionKnownRate ?? 0,
    ),
    qPriorSelectedActionReliableRate: weightedDecisionMetric(
      (result) => result.qPriorSelectedActionReliableRate ?? 0,
    ),
    averageSelectedQPrior: weightedDecisionMetric((result) => result.averageSelectedQPrior ?? 0),
    simulations,
  }
}

function buildSummaryGroups(
  configs: readonly NamedMCTSConfig[],
  rivals: readonly MCTSOpponent[],
  results: MCTSGameResult[],
): MCTSSummaryGroup[] {
  return configs.flatMap((config) =>
    rivals.map((rival) => {
      const group = results.filter(
        (result) => result.config.name === config.name && result.rival === rival,
      )
      return {
        config,
        rival,
        aggregate: summarizeMCTSResults(group, config.simulations),
        byColor: {
          R: summarizeMCTSResults(
            group.filter((result) => result.colorMCTS === 'R'),
            config.simulations,
          ),
          B: summarizeMCTSResults(
            group.filter((result) => result.colorMCTS === 'B'),
            config.simulations,
          ),
        },
      }
    }),
  )
}

function assertOutputCanBeWritten(outputDir: string, overwrite: boolean): void {
  if (existsSync(outputDir) && !overwrite && readdirSync(outputDir).length > 0) {
    throw new Error(`Output directory already exists and is not empty: ${outputDir}`)
  }
  mkdirSync(outputDir, { recursive: true })
}

function getGitValue(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

function csvEscape(value: string | number | boolean): string {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function resultsToCsv(results: MCTSGameResult[]): string {
  const headers = [
    'config',
    'simulations',
    'explorationConstant',
    'maxDepth',
    'rolloutPolicy',
    'heuristicProbability',
    'qPriorWeight',
    'expansionPolicy',
    'progressiveWidening',
    'wideningConstant',
    'wideningExponent',
    'rival',
    'seed',
    'game',
    'colorMCTS',
    'winner',
    'territoryMCTS',
    'territoryRival',
    'territoryDiff',
    'turns',
    'durationMs',
    'mctsDecisionTimeMs',
    'mctsDecisions',
    'averageDecisionMs',
    'averageRootLegalActions',
    'averageRootExpandedChildren',
    'averageMaxDepthReached',
    'averageSelectedDepth',
    'averageRootExplorationRatio',
    'averageQPriorKnownActions',
    'averageQPriorReliableActions',
    'qPriorSelectedActionKnownRate',
    'qPriorSelectedActionReliableRate',
    'averageSelectedQPrior',
    'mctsActionsLegal',
    'tacticalCandidatesChecked',
    'tacticalSelectionChanges',
    'tacticalSelectionChangeRate',
    'averageVerificationTimeMs',
    'immediateTerminalLossesAvoided',
    'closureThreatsDetected',
    'averageClosureThreatPenalty',
  ]
  const rows = results.map((result) => [
    result.config.name,
    result.config.simulations,
    result.config.explorationConstant,
    result.config.maxDepth,
    result.config.rolloutPolicy,
    result.config.heuristicProbability ?? '',
    result.config.qPriorWeight ?? 0,
    result.config.expansionPolicy ?? 'unordered',
    result.config.progressiveWidening ?? false,
    result.config.wideningConstant ?? '',
    result.config.wideningExponent ?? '',
    result.rival,
    result.seed,
    result.game,
    result.colorMCTS,
    result.winner,
    result.territoryMCTS,
    result.territoryRival,
    result.territoryDiff,
    result.turns,
    result.durationMs,
    result.mctsDecisionTimeMs,
    result.mctsDecisions,
    result.averageDecisionMs,
    result.averageRootLegalActions,
    result.averageRootExpandedChildren,
    result.averageMaxDepthReached,
    result.averageSelectedDepth,
    result.averageRootExplorationRatio,
    result.averageQPriorKnownActions,
    result.averageQPriorReliableActions,
    result.qPriorSelectedActionKnownRate,
    result.qPriorSelectedActionReliableRate,
    result.averageSelectedQPrior,
    result.mctsActionsLegal,
    result.tacticalCandidatesChecked ?? 0,
    result.tacticalSelectionChanges ?? 0,
    result.tacticalSelectionChangeRate ?? 0,
    result.averageVerificationTimeMs ?? 0,
    result.immediateTerminalLossesAvoided ?? 0,
    result.closureThreatsDetected ?? 0,
    result.averageClosureThreatPenalty ?? 0,
  ])
  return [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n')
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function evaluateMCTS(options: EvaluateMCTSOptions = {}) {
  const configs = options.configs ?? MCTS_BASELINE_CONFIGS
  const rivals = options.rivals ?? (['random', 'heuristic', 'q5-final'] as const)
  const gamesPerCombination = options.gamesPerCombination ?? 100
  const seedBase = options.seedBase ?? MCTS_BASELINE_SEED
  const maxTurns = options.maxTurns ?? MCTS_BASELINE_MAX_TURNS
  const outputDir = path.resolve(options.outputDir ?? MCTS_BASELINE_OUTPUT_DIR)
  const progressEvery = options.progressEvery ?? 10
  const now = options.now ?? (() => performance.now())
  const outputFilePrefix = options.outputFilePrefix ?? 'mcts_baseline'
  const evaluationVersion = options.evaluationVersion ?? MCTS_EVALUATION_VERSION
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)
  const scheduledGames = buildMCTSEvaluationSchedule(
    configs,
    [...rivals],
    gamesPerCombination,
    seedBase,
    options.gamesPerRival,
  )
  const usesQ5Prior = configs.some((config) => config.expansionPolicy === 'heuristic-q5')
  const q5Resources =
    rivals.includes('q5-final') || usesQ5Prior ? loadFrozenQ5EvaluationResources() : undefined
  const results: MCTSGameResult[] = []

  for (const pairing of scheduledGames) {
    const mctsOpponentConfig =
      typeof options.mctsOpponentConfig === 'function'
        ? options.mctsOpponentConfig(pairing)
        : options.mctsOpponentConfig
    results.push(
      await runSingleMCTSGame({ pairing, maxTurns, now, q5Resources, mctsOpponentConfig }),
    )
    if (progressEvery > 0 && results.length % progressEvery === 0) {
      console.log(`[evaluateMCTS] ${results.length}/${scheduledGames.length} games`)
    }
  }

  let q5Verification:
    | {
        source: string
        sha256: string
        epsilon: number
        minConfidence: number
        qMargin: number
        qTableEntries: number
        qTableChangedDuringEvaluation: boolean
        resourcesChangedDuringEvaluation: boolean
        resourceHashesBefore: Record<string, string>
        resourceHashesAfter: Record<string, string>
        confidenceStats: Q5ConfidenceLoadStats
      }
    | undefined
  if (q5Resources) {
    const resourceHashesAfter = Object.fromEntries(
      Object.keys(q5Resources.resourceHashesBefore).map((filePath) => [
        filePath,
        hashFile(filePath),
      ]),
    )
    q5Verification = {
      source: q5Resources.model.source,
      sha256: q5Resources.model.sha256,
      epsilon: Q5_EPSILON,
      minConfidence: Q5_MIN_CONFIDENCE,
      qMargin: Q5_Q_MARGIN,
      qTableEntries: Object.keys(q5Resources.model.qTable).length,
      qTableChangedDuringEvaluation:
        qTableFingerprint(q5Resources.model.qTable) !== q5Resources.qTableFingerprintBefore,
      resourcesChangedDuringEvaluation: Object.entries(q5Resources.resourceHashesBefore).some(
        ([filePath, before]) => resourceHashesAfter[filePath] !== before,
      ),
      resourceHashesBefore: q5Resources.resourceHashesBefore,
      resourceHashesAfter,
      confidenceStats: q5Resources.confidenceStats,
    }
    if (
      q5Verification.qTableChangedDuringEvaluation ||
      q5Verification.resourcesChangedDuringEvaluation
    ) {
      throw new Error('Frozen Q5 resources changed during MCTS evaluation')
    }
  }

  const createdAt = options.createdAt ?? new Date().toISOString()
  const groups = buildSummaryGroups(configs, [...rivals], results)
  const summary = {
    createdAt,
    evaluationVersion,
    git: {
      branch: getGitValue(['branch', '--show-current']),
      commit: getGitValue(['rev-parse', 'HEAD']),
    },
    protocol: {
      gamesPerCombination,
      gamesPerRival: Object.fromEntries(
        rivals.map((rival) => [rival, options.gamesPerRival?.[rival] ?? gamesPerCombination]),
      ),
      gamesPerColor: options.gamesPerRival
        ? Object.fromEntries(
            rivals.map((rival) => [
              rival,
              (options.gamesPerRival?.[rival] ?? gamesPerCombination) / 2,
            ]),
          )
        : gamesPerCombination / 2,
      totalGames: scheduledGames.length,
      seedBase,
      seeds: scheduledGames.map((item) => item.seed),
      maxTurns,
      configurations: configs,
      rivals,
      learningEnabled: false,
      q5UsedOnlyAsFrozenOpponent: rivals.includes('q5-final') && !usesQ5Prior,
      q5UsedAsFrozenOpponent: rivals.includes('q5-final'),
      q5UsedAsExpansionPrior: usesQ5Prior,
      q5UsedInRollouts: false,
      turnLimitResolution: 'finalizeGameIfNeeded using getTerritoryCounts',
    },
    positionEvaluation: {
      version: 'evaluatePosition-v1',
      normalization: 'tanh(score / 100)',
      weights: {
        territory: TERRITORY_WEIGHT,
        mobility: MOBILITY_WEIGHT,
        trappedPieces: TRAPPED_WEIGHT,
        expansion: EXPANSION_WEIGHT,
      },
    },
    q5: q5Verification,
    aggregate: summarizeMCTSResults(results, 0),
    combinations: groups,
  }
  const metadata = {
    createdAt,
    evaluationVersion,
    outputDir,
    git: summary.git,
    protocol: summary.protocol,
    positionEvaluation: summary.positionEvaluation,
    q5: q5Verification,
    files: {
      summary: `${outputFilePrefix}_summary.json`,
      results: `${outputFilePrefix}_results.csv`,
      metadata: 'metadata.json',
    },
  }

  writeJson(path.join(outputDir, `${outputFilePrefix}_summary.json`), summary)
  writeFileSync(
    path.join(outputDir, `${outputFilePrefix}_results.csv`),
    `${resultsToCsv(results)}\n`,
    'utf8',
  )
  writeJson(path.join(outputDir, 'metadata.json'), metadata)
  return { summary, metadata, results }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'pilot'
  if (command !== 'pilot' && command !== 'full') throw new Error(`Unknown command: ${command}`)
  const pilot = command === 'pilot'
  const result = await evaluateMCTS(
    pilot
      ? {
          configs: MCTS_BASELINE_CONFIGS.filter((config) => config.simulations <= 200),
          rivals: ['random', 'heuristic'],
          gamesPerCombination: 4,
        }
      : {},
  )
  console.log(`[evaluateMCTS] mode: ${command}`)
  console.log(`[evaluateMCTS] games: ${result.results.length}`)
  console.log(`[evaluateMCTS] output: ${MCTS_BASELINE_OUTPUT_DIR}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
