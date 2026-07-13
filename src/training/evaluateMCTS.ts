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
  type FrozenQ5Model,
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
export const MCTS_BASELINE_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_baseline',
)
export const MCTS_BASELINE_SEED = 613_000
export const MCTS_BASELINE_MAX_TURNS = 250

export interface NamedMCTSConfig extends MCTSConfig {
  name: string
}

export const MCTS_BASELINE_CONFIGS: NamedMCTSConfig[] = [
  { name: 'MCTS-50', simulations: 50, explorationConstant: Math.SQRT2, maxDepth: 60 },
  { name: 'MCTS-200', simulations: 200, explorationConstant: Math.SQRT2, maxDepth: 60 },
  { name: 'MCTS-500', simulations: 500, explorationConstant: Math.SQRT2, maxDepth: 60 },
]

export type MCTSOpponent = 'random' | 'heuristic' | 'q5-final'

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
  mctsActionsLegal: boolean
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
  seedBase?: number
  maxTurns?: number
  outputDir?: string
  overwrite?: boolean
  progressEvery?: number
  now?: () => number
  createdAt?: string
}

interface FrozenQ5EvaluationResources {
  model: FrozenQ5Model
  qTablePath: string
  qTableFingerprintBefore: string
  resourceHashesBefore: Record<string, string>
}

export function buildMCTSEvaluationSchedule(
  configs: readonly NamedMCTSConfig[] = MCTS_BASELINE_CONFIGS,
  rivals: readonly MCTSOpponent[] = ['random', 'heuristic', 'q5-final'],
  gamesPerCombination = 100,
  seedBase = MCTS_BASELINE_SEED,
): MCTSScheduleItem[] {
  if (gamesPerCombination <= 0 || gamesPerCombination % 2 !== 0) {
    throw new Error('gamesPerCombination must be a positive even number')
  }

  const schedule: MCTSScheduleItem[] = []
  for (const config of configs) {
    for (let rivalIndex = 0; rivalIndex < rivals.length; rivalIndex++) {
      const rival = rivals[rivalIndex]!
      for (const colorMCTS of ['R', 'B'] as const) {
        for (let game = 1; game <= gamesPerCombination / 2; game++) {
          const colorOffset = colorMCTS === 'R' ? 0 : gamesPerCombination / 2
          schedule.push({
            config,
            rival,
            colorMCTS,
            game,
            seed: seedBase + rivalIndex * gamesPerCombination + colorOffset + game,
          })
        }
      }
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

function loadFrozenQ5EvaluationResources(): FrozenQ5EvaluationResources {
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
  const confidence = new Map<string, number>()
  for (const key of new Set([...inheritedConfidence.keys(), ...updateCounts.keys()])) {
    confidence.set(
      key,
      Math.max(inheritedConfidence.get(key)?.observations ?? 0, updateCounts.get(key) ?? 0),
    )
  }
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
  }
}

async function runSingleMCTSGame(params: {
  pairing: MCTSScheduleItem
  maxTurns: number
  now: () => number
  q5Resources?: FrozenQ5EvaluationResources
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
  let mctsActionsLegal = true
  const gameStartedAt = params.now()

  while (state.phase !== 'finished' && !state.result && turns < params.maxTurns) {
    const previousState = snapshotFromState(state)
    const legalActions = getLegalActions(previousState)
    if (legalActions.length === 0) break
    let action: PlayerAction

    if (previousState.turn === params.pairing.colorMCTS) {
      const decisionStartedAt = params.now()
      action = searchBestAction(previousState, params.pairing.colorMCTS, params.pairing.config, mctsRng)
        .action
      mctsDecisionTimeMs += params.now() - decisionStartedAt
      mctsDecisions++
      rootLegalActions += legalActions.length
      const legal = isLegalAction(action, legalActions)
      mctsActionsLegal &&= legal
      if (!legal) throw new Error('MCTS returned an illegal action during baseline evaluation')
    } else if (params.pairing.rival === 'random') {
      action = chooseRandomActionWithRngQ4(legalActions, rivalRng)
    } else if (params.pairing.rival === 'heuristic') {
      action = chooseHeuristicOpponentActionQ4(previousState, rivalRng)
    } else {
      if (!q5Agent) throw new Error('Frozen Q5 resources were not loaded')
      action = await q5Agent.getAction(previousState)
      if (!isLegalAction(action, legalActions)) {
        throw new Error('Frozen Q5 returned an illegal action during baseline evaluation')
      }
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
    mctsActionsLegal,
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
    'mctsActionsLegal',
  ]
  const rows = results.map((result) => [
    result.config.name,
    result.config.simulations,
    result.config.explorationConstant,
    result.config.maxDepth,
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
    result.mctsActionsLegal,
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
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)
  const schedule = buildMCTSEvaluationSchedule(configs, [...rivals], gamesPerCombination, seedBase)
  const q5Resources = rivals.includes('q5-final') ? loadFrozenQ5EvaluationResources() : undefined
  const results: MCTSGameResult[] = []

  for (const pairing of schedule) {
    results.push(await runSingleMCTSGame({ pairing, maxTurns, now, q5Resources }))
    if (progressEvery > 0 && results.length % progressEvery === 0) {
      console.log(`[evaluateMCTS] ${results.length}/${schedule.length} games`)
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
      }
    | undefined
  if (q5Resources) {
    const resourceHashesAfter = Object.fromEntries(
      Object.keys(q5Resources.resourceHashesBefore).map((filePath) => [filePath, hashFile(filePath)]),
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
    }
    if (q5Verification.qTableChangedDuringEvaluation || q5Verification.resourcesChangedDuringEvaluation) {
      throw new Error('Frozen Q5 resources changed during MCTS evaluation')
    }
  }

  const createdAt = options.createdAt ?? new Date().toISOString()
  const groups = buildSummaryGroups(configs, [...rivals], results)
  const summary = {
    createdAt,
    evaluationVersion: MCTS_EVALUATION_VERSION,
    git: {
      branch: getGitValue(['branch', '--show-current']),
      commit: getGitValue(['rev-parse', 'HEAD']),
    },
    protocol: {
      gamesPerCombination,
      gamesPerColor: gamesPerCombination / 2,
      totalGames: schedule.length,
      seedBase,
      seeds: schedule.map((item) => item.seed),
      maxTurns,
      configurations: configs,
      rivals,
      learningEnabled: false,
      q5UsedOnlyAsFrozenOpponent: rivals.includes('q5-final'),
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
    evaluationVersion: MCTS_EVALUATION_VERSION,
    outputDir,
    git: summary.git,
    protocol: summary.protocol,
    positionEvaluation: summary.positionEvaluation,
    q5: q5Verification,
    files: {
      summary: 'mcts_baseline_summary.json',
      results: 'mcts_baseline_results.csv',
      metadata: 'metadata.json',
    },
  }

  writeJson(path.join(outputDir, 'mcts_baseline_summary.json'), summary)
  writeFileSync(
    path.join(outputDir, 'mcts_baseline_results.csv'),
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
