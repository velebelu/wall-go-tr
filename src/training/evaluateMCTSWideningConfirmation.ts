import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MCTS_BASELINE_MAX_TURNS,
  buildMCTSEvaluationSchedule,
  evaluateMCTS,
  summarizeMCTSResults,
  type MCTSAggregateMetrics,
  type MCTSGameResult,
  type NamedMCTSConfig,
} from './evaluateMCTS'
import {
  calculateWilson95Interval,
  type WinRateConfidenceInterval,
} from './evaluateMCTSMixedConfirmation'

export const MCTS_WIDENING_CONFIRMATION_VERSION = 'mcts-widening-confirmation-v1'
export const MCTS_WIDENING_CONFIRMATION_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_widening_confirmacion',
)
export const MCTS_WIDENING_CONFIRMATION_SEED = 617_000
export const MCTS_WIDENING_CONFIRMATION_CONFIG: Readonly<NamedMCTSConfig> = Object.freeze({
  name: 'MCTS-50-mixed80-heuristic-widening',
  simulations: 50,
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
  rolloutPolicy: 'mixed',
  heuristicProbability: 0.8,
  expansionPolicy: 'heuristic',
  progressiveWidening: true,
  wideningConstant: 2,
  wideningExponent: 0.5,
})

const PREVIOUS_EXPERIMENTS = {
  mixed80Confirmation: {
    source:
      'data/entrenamiento/mcts/evaluacion_mixed80_confirmacion/mcts_mixed80_confirmation_summary.json',
    games: 100,
    winRate: 17,
    averageTerritoryDiff: -23.26,
  },
  expansionPilot: {
    source: 'data/entrenamiento/mcts/evaluacion_expansion/mcts_expansion_summary.json',
    games: 10,
    winRate: 80,
    averageTerritoryDiff: -2.1,
  },
} as const

export interface WideningConfirmationMetrics extends MCTSAggregateMetrics {
  winRate95CI: WinRateConfidenceInterval
}

export interface EvaluateMCTSWideningConfirmationOptions {
  heuristicGames?: number
  randomGames?: number
  seedBase?: number
  maxTurns?: number
  outputDir?: string
  overwrite?: boolean
  progressEvery?: number
  now?: () => number
  createdAt?: string
}

export function buildMCTSWideningConfirmationSchedule(
  heuristicGames = 100,
  randomGames = 50,
  seedBase = MCTS_WIDENING_CONFIRMATION_SEED,
) {
  return [
    ...buildMCTSEvaluationSchedule(
      [MCTS_WIDENING_CONFIRMATION_CONFIG],
      ['heuristic'],
      heuristicGames,
      seedBase,
    ),
    ...buildMCTSEvaluationSchedule(
      [MCTS_WIDENING_CONFIRMATION_CONFIG],
      ['random'],
      randomGames,
      seedBase + 10_000,
    ),
  ]
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function withConfidence(metrics: MCTSAggregateMetrics): WideningConfirmationMetrics {
  return {
    ...metrics,
    winRate95CI: calculateWilson95Interval(metrics.wins, metrics.games),
  }
}

function summarizeGroup(results: MCTSGameResult[]) {
  const summarize = (subset: MCTSGameResult[]) =>
    withConfidence(
      summarizeMCTSResults(subset, MCTS_WIDENING_CONFIRMATION_CONFIG.simulations),
    )
  return {
    aggregate: summarize(results),
    byColor: {
      R: summarize(results.filter((result) => result.colorMCTS === 'R')),
      B: summarize(results.filter((result) => result.colorMCTS === 'B')),
    },
  }
}

function buildComparisons(heuristic: ReturnType<typeof summarizeGroup>) {
  const current = heuristic.aggregate
  const compare = (previous: (typeof PREVIOUS_EXPERIMENTS)[keyof typeof PREVIOUS_EXPERIMENTS]) => ({
    previous,
    winRateDeltaPercentagePoints: roundMetric(current.winRate - previous.winRate),
    territoryDiffDelta: roundMetric(
      current.averageTerritoryDiff - previous.averageTerritoryDiff,
    ),
  })
  return {
    current: {
      games: current.games,
      wins: current.wins,
      losses: current.losses,
      ties: current.ties,
      winRate: current.winRate,
      winRate95CI: current.winRate95CI,
      averageTerritoryDiff: current.averageTerritoryDiff,
    },
    versusMixed80WithoutWidening: compare(PREVIOUS_EXPERIMENTS.mixed80Confirmation),
    versusExpansionPilot: {
      ...compare(PREVIOUS_EXPERIMENTS.expansionPilot),
      pilotWinRateWithinCurrent95CI:
        PREVIOUS_EXPERIMENTS.expansionPilot.winRate >= current.winRate95CI.lower &&
        PREVIOUS_EXPERIMENTS.expansionPilot.winRate <= current.winRate95CI.upper,
    },
  }
}

function assertOutputCanBeWritten(outputDir: string, overwrite: boolean): void {
  if (existsSync(outputDir) && !overwrite && readdirSync(outputDir).length > 0) {
    throw new Error(`Output directory already exists and is not empty: ${outputDir}`)
  }
  mkdirSync(outputDir, { recursive: true })
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
    'averageDecisionMs',
    'averageRootLegalActions',
    'averageRootExpandedChildren',
    'averageRootExplorationRatio',
    'averageMaxDepthReached',
    'averageSelectedDepth',
    'mctsActionsLegal',
  ]
  const rows = results.map((result) => [
    result.config.name,
    result.config.simulations,
    result.config.explorationConstant,
    result.config.maxDepth,
    result.config.rolloutPolicy,
    result.config.heuristicProbability ?? '',
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
    result.averageDecisionMs,
    result.averageRootLegalActions,
    result.averageRootExpandedChildren,
    result.averageRootExplorationRatio,
    result.averageMaxDepthReached,
    result.averageSelectedDepth,
    result.mctsActionsLegal,
  ])
  return [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n')
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function evaluateMCTSWideningConfirmation(
  options: EvaluateMCTSWideningConfirmationOptions = {},
) {
  const heuristicGames = options.heuristicGames ?? 100
  const randomGames = options.randomGames ?? 50
  const seedBase = options.seedBase ?? MCTS_WIDENING_CONFIRMATION_SEED
  const maxTurns = options.maxTurns ?? MCTS_BASELINE_MAX_TURNS
  const outputDir = path.resolve(options.outputDir ?? MCTS_WIDENING_CONFIRMATION_OUTPUT_DIR)
  const now = options.now ?? (() => performance.now())
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'wall-go-mcts-widening-confirmation-'))
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)

  try {
    const common = {
      configs: [MCTS_WIDENING_CONFIRMATION_CONFIG],
      maxTurns,
      progressEvery: options.progressEvery ?? 10,
      now,
      createdAt: options.createdAt,
    }
    const heuristicEvaluation = await evaluateMCTS({
      ...common,
      rivals: ['heuristic'],
      gamesPerCombination: heuristicGames,
      seedBase,
      outputDir: path.join(temporaryRoot, 'heuristic'),
    })
    const randomEvaluation = await evaluateMCTS({
      ...common,
      rivals: ['random'],
      gamesPerCombination: randomGames,
      seedBase: seedBase + 10_000,
      outputDir: path.join(temporaryRoot, 'random'),
    })
    const results = [...heuristicEvaluation.results, ...randomEvaluation.results]
    const heuristic = summarizeGroup(results.filter((result) => result.rival === 'heuristic'))
    const random = summarizeGroup(results.filter((result) => result.rival === 'random'))
    const total = summarizeGroup(results)
    const createdAt = options.createdAt ?? new Date().toISOString()
    const summary = {
      createdAt,
      evaluationVersion: MCTS_WIDENING_CONFIRMATION_VERSION,
      git: heuristicEvaluation.summary.git,
      protocol: {
        configuration: MCTS_WIDENING_CONFIRMATION_CONFIG,
        heuristicGames,
        heuristicGamesPerColor: heuristicGames / 2,
        randomGames,
        randomGamesPerColor: randomGames / 2,
        totalGames: results.length,
        seedBase,
        maxTurns,
        learningEnabled: false,
        q5Included: false,
        turnLimitResolution: 'finalizeGameIfNeeded using getTerritoryCounts',
      },
      total,
      byRival: { heuristic, random },
      comparisons: buildComparisons(heuristic),
    }
    const metadata = {
      createdAt,
      evaluationVersion: MCTS_WIDENING_CONFIRMATION_VERSION,
      git: summary.git,
      protocol: summary.protocol,
      confidenceInterval: 'Wilson score interval, 95%',
      previousExperiments: PREVIOUS_EXPERIMENTS,
      files: {
        summary: 'mcts_widening_confirmation_summary.json',
        results: 'mcts_widening_confirmation_results.csv',
        metadata: 'metadata.json',
      },
    }

    writeJson(path.join(outputDir, 'mcts_widening_confirmation_summary.json'), summary)
    writeFileSync(
      path.join(outputDir, 'mcts_widening_confirmation_results.csv'),
      `${resultsToCsv(results)}\n`,
      'utf8',
    )
    writeJson(path.join(outputDir, 'metadata.json'), metadata)
    return { summary, metadata, results }
  } finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot)
    if (!resolvedTemporaryRoot.startsWith(path.resolve(os.tmpdir()))) {
      throw new Error('Refusing to clean a temporary directory outside the system temp path')
    }
    rmSync(resolvedTemporaryRoot, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'full'
  if (command !== 'smoke' && command !== 'full') throw new Error(`Unknown command: ${command}`)
  const smoke = command === 'smoke'
  const result = await evaluateMCTSWideningConfirmation(
    smoke
      ? {
          heuristicGames: 2,
          randomGames: 2,
          outputDir: mkdtempSync(
            path.join(os.tmpdir(), 'wall-go-mcts-widening-confirmation-smoke-'),
          ),
        }
      : {},
  )
  console.log(`[evaluateMCTSWideningConfirmation] mode: ${command}`)
  console.log(`[evaluateMCTSWideningConfirmation] games: ${result.results.length}`)
  console.log(
    `[evaluateMCTSWideningConfirmation] output: ${smoke ? 'system temp directory' : MCTS_WIDENING_CONFIRMATION_OUTPUT_DIR}`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

export { calculateWilson95Interval }
