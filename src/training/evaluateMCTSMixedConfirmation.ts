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

export const MCTS_MIXED_CONFIRMATION_VERSION = 'mcts-mixed80-confirmation-v1'
export const MCTS_MIXED_CONFIRMATION_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_mixed80_confirmacion',
)
export const MCTS_MIXED_CONFIRMATION_SEED = 615_000
export const MCTS_MIXED_CONFIRMATION_CONFIG: NamedMCTSConfig = {
  name: 'MCTS-50-mixed-80',
  simulations: 50,
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
  rolloutPolicy: 'mixed',
  heuristicProbability: 0.8,
}

export interface WinRateConfidenceInterval {
  confidence: 0.95
  lower: number
  upper: number
}

export interface ConfirmationMetrics extends MCTSAggregateMetrics {
  winRate95CI: WinRateConfidenceInterval
}

export interface EvaluateMCTSMixedConfirmationOptions {
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

const PREVIOUS_PILOT = {
  source: 'data/entrenamiento/mcts/evaluacion_rollout_policy/mcts_rollout_summary.json',
  games: 6,
  wins: 3,
  losses: 3,
  ties: 0,
  winRate: 50,
  averageTerritoryDiff: -7.6667,
  byColor: {
    R: { games: 3, wins: 3, losses: 0, ties: 0, winRate: 100, averageTerritoryDiff: 5 },
    B: {
      games: 3,
      wins: 0,
      losses: 3,
      ties: 0,
      winRate: 0,
      averageTerritoryDiff: -20.3333,
    },
  },
} as const

export function calculateWilson95Interval(
  wins: number,
  games: number,
): WinRateConfidenceInterval {
  if (!Number.isInteger(wins) || !Number.isInteger(games) || games < 0 || wins < 0 || wins > games) {
    throw new Error('wins and games must be valid non-negative integer counts')
  }
  if (games === 0) return { confidence: 0.95, lower: 0, upper: 0 }
  const z = 1.959963984540054
  const proportion = wins / games
  const zSquared = z * z
  const denominator = 1 + zSquared / games
  const center = (proportion + zSquared / (2 * games)) / denominator
  const margin =
    (z *
      Math.sqrt((proportion * (1 - proportion)) / games + zSquared / (4 * games * games))) /
    denominator
  return {
    confidence: 0.95,
    lower: roundMetric((center - margin) * 100),
    upper: roundMetric((center + margin) * 100),
  }
}

export function buildMCTSMixedConfirmationSchedule(
  heuristicGames = 100,
  randomGames = 50,
  seedBase = MCTS_MIXED_CONFIRMATION_SEED,
) {
  return [
    ...buildMCTSEvaluationSchedule(
      [MCTS_MIXED_CONFIRMATION_CONFIG],
      ['heuristic'],
      heuristicGames,
      seedBase,
    ),
    ...buildMCTSEvaluationSchedule(
      [MCTS_MIXED_CONFIRMATION_CONFIG],
      ['random'],
      randomGames,
      seedBase + 10_000,
    ),
  ]
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function withConfidence(metrics: MCTSAggregateMetrics): ConfirmationMetrics {
  return {
    ...metrics,
    winRate95CI: calculateWilson95Interval(metrics.wins, metrics.games),
  }
}

function summarizeGroup(results: MCTSGameResult[]) {
  return {
    aggregate: withConfidence(
      summarizeMCTSResults(results, MCTS_MIXED_CONFIRMATION_CONFIG.simulations),
    ),
    byColor: {
      R: withConfidence(
        summarizeMCTSResults(
          results.filter((result) => result.colorMCTS === 'R'),
          MCTS_MIXED_CONFIRMATION_CONFIG.simulations,
        ),
      ),
      B: withConfidence(
        summarizeMCTSResults(
          results.filter((result) => result.colorMCTS === 'B'),
          MCTS_MIXED_CONFIRMATION_CONFIG.simulations,
        ),
      ),
    },
  }
}

function compareWithPilot(heuristicSummary: ReturnType<typeof summarizeGroup>) {
  const current = heuristicSummary.aggregate
  const red = heuristicSummary.byColor.R
  const blue = heuristicSummary.byColor.B
  const winRateDelta = roundMetric(current.winRate - PREVIOUS_PILOT.winRate)
  const redBlueGap = roundMetric(red.winRate - blue.winRate)
  const intervalsOverlap = !(
    red.winRate95CI.lower > blue.winRate95CI.upper ||
    blue.winRate95CI.lower > red.winRate95CI.upper
  )
  return {
    previousPilot: PREVIOUS_PILOT,
    current: {
      games: current.games,
      wins: current.wins,
      losses: current.losses,
      ties: current.ties,
      winRate: current.winRate,
      averageTerritoryDiff: current.averageTerritoryDiff,
      byColor: { R: red, B: blue },
    },
    winRateDeltaPercentagePoints: winRateDelta,
    winRateTrend: winRateDelta > 0 ? 'improved' : winRateDelta < 0 ? 'worsened' : 'maintained',
    redBlueWinRateGapPercentagePoints: redBlueGap,
    colorIntervalsOverlap: intervalsOverlap,
    colorConclusion:
      Math.sign(redBlueGap) === 1 && !intervalsOverlap
        ? 'The red advantage observed in the pilot persists with non-overlapping Wilson intervals.'
        : 'The larger sample does not provide clear evidence of a persistent color advantage.',
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
    'rolloutPolicy',
    'heuristicProbability',
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
    'mctsActionsLegal',
  ]
  const rows = results.map((result) => [
    result.config.name,
    result.config.simulations,
    result.config.rolloutPolicy,
    result.config.heuristicProbability ?? '',
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
    result.mctsActionsLegal,
  ])
  return [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n')
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function evaluateMCTSMixedConfirmation(
  options: EvaluateMCTSMixedConfirmationOptions = {},
) {
  const heuristicGames = options.heuristicGames ?? 100
  const randomGames = options.randomGames ?? 50
  const seedBase = options.seedBase ?? MCTS_MIXED_CONFIRMATION_SEED
  const maxTurns = options.maxTurns ?? MCTS_BASELINE_MAX_TURNS
  const outputDir = path.resolve(options.outputDir ?? MCTS_MIXED_CONFIRMATION_OUTPUT_DIR)
  const now = options.now ?? (() => performance.now())
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'wall-go-mcts-mixed-confirmation-'))
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)

  try {
    const heuristicEvaluation = await evaluateMCTS({
      configs: [MCTS_MIXED_CONFIRMATION_CONFIG],
      rivals: ['heuristic'],
      gamesPerCombination: heuristicGames,
      seedBase,
      maxTurns,
      outputDir: path.join(temporaryRoot, 'heuristic'),
      progressEvery: options.progressEvery ?? 10,
      now,
      createdAt: options.createdAt,
    })
    const randomEvaluation = await evaluateMCTS({
      configs: [MCTS_MIXED_CONFIRMATION_CONFIG],
      rivals: ['random'],
      gamesPerCombination: randomGames,
      seedBase: seedBase + 10_000,
      maxTurns,
      outputDir: path.join(temporaryRoot, 'random'),
      progressEvery: options.progressEvery ?? 10,
      now,
      createdAt: options.createdAt,
    })
    const results = [...heuristicEvaluation.results, ...randomEvaluation.results]
    const heuristic = summarizeGroup(
      results.filter((result) => result.rival === 'heuristic'),
    )
    const random = summarizeGroup(results.filter((result) => result.rival === 'random'))
    const total = summarizeGroup(results)
    const createdAt = options.createdAt ?? new Date().toISOString()
    const comparison = compareWithPilot(heuristic)
    const summary = {
      createdAt,
      evaluationVersion: MCTS_MIXED_CONFIRMATION_VERSION,
      git: heuristicEvaluation.summary.git,
      protocol: {
        configuration: MCTS_MIXED_CONFIRMATION_CONFIG,
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
      comparisonWithPreviousPilot: comparison,
    }
    const metadata = {
      createdAt,
      evaluationVersion: MCTS_MIXED_CONFIRMATION_VERSION,
      git: summary.git,
      protocol: summary.protocol,
      confidenceInterval: 'Wilson score interval, 95%',
      previousPilot: PREVIOUS_PILOT.source,
      files: {
        summary: 'mcts_mixed80_confirmation_summary.json',
        results: 'mcts_mixed80_confirmation_results.csv',
        metadata: 'metadata.json',
      },
    }

    writeJson(path.join(outputDir, 'mcts_mixed80_confirmation_summary.json'), summary)
    writeFileSync(
      path.join(outputDir, 'mcts_mixed80_confirmation_results.csv'),
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
  const result = await evaluateMCTSMixedConfirmation(
    smoke
      ? {
          heuristicGames: 2,
          randomGames: 2,
          outputDir: mkdtempSync(path.join(os.tmpdir(), 'wall-go-mcts-confirmation-smoke-')),
        }
      : {},
  )
  console.log(`[evaluateMCTSMixedConfirmation] mode: ${command}`)
  console.log(`[evaluateMCTSMixedConfirmation] games: ${result.results.length}`)
  console.log(
    `[evaluateMCTSMixedConfirmation] output: ${smoke ? 'system temp directory' : MCTS_MIXED_CONFIRMATION_OUTPUT_DIR}`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
