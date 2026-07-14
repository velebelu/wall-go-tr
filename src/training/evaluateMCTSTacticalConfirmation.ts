import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MCTSConfig } from '@/engine/mcts/types'
import {
  buildMCTSEvaluationSchedule,
  evaluateMCTS,
  summarizeMCTSResults,
  type MCTSGameResult,
  type MCTSOpponent,
  type NamedMCTSConfig,
} from './evaluateMCTS'

export const MCTS_TACTICAL_CONFIRMATION_VERSION = 'mcts-tactical-confirmation-v1'
export const MCTS_TACTICAL_CONFIRMATION_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_verificacion_tactica_confirmacion',
)
export const MCTS_TACTICAL_CONFIRMATION_SEED = 836_000
export const MCTS_TACTICAL_CONFIRMATION_MAX_TURNS = 250

const FIXED = {
  simulations: 50,
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
  rolloutPolicy: 'mixed' as const,
  heuristicProbability: 0.8,
  expansionPolicy: 'heuristic' as const,
  progressiveWidening: true,
  wideningConstant: 2,
  wideningExponent: 0.5,
  qPriorWeight: 0,
}

export const MCTS_TACTICAL_CONFIRMATION_CONFIGS: readonly NamedMCTSConfig[] = [
  { name: 'baseline-final', ...FIXED, tacticalVerification: false },
  { name: 'tactical-top-2', ...FIXED, tacticalVerification: true, tacticalCandidateCount: 2 },
]

export const MCTS_TACTICAL_CONFIRMATION_RIVALS: readonly MCTSOpponent[] = [
  'heuristic', 'q5-final', 'baseline-mcts', 'random',
]

export const MCTS_TACTICAL_CONFIRMATION_GAMES: Readonly<Record<MCTSOpponent, number>> = {
  heuristic: 50,
  'q5-final': 50,
  'baseline-mcts': 50,
  random: 20,
}

function round(value: number): number {
  return Number(value.toFixed(4))
}

export function wilson95(successes: number, total: number) {
  if (!total) return { low: 0, high: 0 }
  const z = 1.959963984540054
  const p = successes / total
  const denominator = 1 + z * z / total
  const center = (p + z * z / (2 * total)) / denominator
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
  return { low: round(center * 100 - margin * 100), high: round(center * 100 + margin * 100) }
}

function outcomeScore(row: MCTSGameResult): number {
  return row.mctsWon ? 1 : row.tie ? 0.5 : 0
}

export function buildPairedUtility(results: readonly MCTSGameResult[]) {
  const pairs = [] as Array<{
    pairId: string
    rival: MCTSOpponent
    top2Changed: boolean
    resultDelta: number
    territoryDelta: number
    classification: 'benefit' | 'same' | 'harm'
  }>
  for (const rival of ['heuristic', 'q5-final', 'random'] as const) {
    for (const top2 of results.filter((row) => row.config.name === 'tactical-top-2' && row.rival === rival)) {
      const baseline = results.find((row) =>
        row.config.name === 'baseline-final' && row.rival === rival &&
        row.colorMCTS === top2.colorMCTS && row.game === top2.game && row.seed === top2.seed)
      if (!baseline) throw new Error(`Missing paired baseline for ${rival}-${top2.colorMCTS}-${top2.game}`)
      const resultDelta = outcomeScore(top2) - outcomeScore(baseline)
      const territoryDelta = top2.territoryDiff - baseline.territoryDiff
      const classification = resultDelta > 0 || (resultDelta === 0 && territoryDelta > 0)
        ? 'benefit' : resultDelta < 0 || territoryDelta < 0 ? 'harm' : 'same'
      pairs.push({
        pairId: `${rival}-${top2.colorMCTS}-${String(top2.game).padStart(2, '0')}`,
        rival,
        top2Changed: (top2.tacticalSelectionChanges ?? 0) > 0,
        resultDelta,
        territoryDelta,
        classification,
      })
    }
  }
  const summarize = (rows: typeof pairs) => ({
    pairs: rows.length,
    benefits: rows.filter((row) => row.classification === 'benefit').length,
    harms: rows.filter((row) => row.classification === 'harm').length,
    same: rows.filter((row) => row.classification === 'same').length,
    averageTerritoryDelta: rows.length
      ? round(rows.reduce((sum, row) => sum + row.territoryDelta, 0) / rows.length)
      : 0,
  })
  return {
    rows: pairs,
    all: summarize(pairs),
    changed: summarize(pairs.filter((row) => row.top2Changed)),
    unchanged: summarize(pairs.filter((row) => !row.top2Changed)),
  }
}

export function summarizeTacticalConfirmation(results: readonly MCTSGameResult[]) {
  const combinations = MCTS_TACTICAL_CONFIRMATION_CONFIGS.flatMap((config) =>
    MCTS_TACTICAL_CONFIRMATION_RIVALS.map((rival) => {
      const rows = results.filter((row) => row.config.name === config.name && row.rival === rival)
      const decisions = rows.reduce((sum, row) => sum + row.mctsDecisions, 0)
      const changes = rows.reduce((sum, row) => sum + (row.tacticalSelectionChanges ?? 0), 0)
      const changed = rows.filter((row) => (row.tacticalSelectionChanges ?? 0) > 0)
      const unchanged = rows.filter((row) => (row.tacticalSelectionChanges ?? 0) === 0)
      const aggregate = summarizeMCTSResults([...rows], config.simulations)
      return {
        config: config.name,
        rival,
        aggregate,
        winRateCI95: wilson95(aggregate.wins, aggregate.games),
        byColor: Object.fromEntries((['R', 'B'] as const).map((color) => [
          color,
          summarizeMCTSResults(rows.filter((row) => row.colorMCTS === color), config.simulations),
        ])),
        tactical: {
          decisions,
          candidatesChecked: rows.reduce((sum, row) => sum + (row.tacticalCandidatesChecked ?? 0), 0),
          changes,
          changeRate: decisions ? round(changes / decisions * 100) : 0,
          immediateTerminalLossesAvoided: rows.reduce(
            (sum, row) => sum + (row.immediateTerminalLossesAvoided ?? 0), 0,
          ),
          changedGames: summarizeMCTSResults(changed, config.simulations),
          unchangedGames: summarizeMCTSResults(unchanged, config.simulations),
        },
      }
    }),
  )
  const pairedUtility = buildPairedUtility(results)
  const weightedDecisionMs = (config: string) => {
    const rows = combinations.filter((row) => row.config === config)
    const games = rows.reduce((sum, row) => sum + row.aggregate.games, 0)
    return games
      ? rows.reduce((sum, row) => sum + row.aggregate.averageDecisionMs * row.aggregate.games, 0) / games
      : 0
  }
  const baselineDecisionMs = weightedDecisionMs('baseline-final')
  const top2DecisionMs = weightedDecisionMs('tactical-top-2')
  return {
    combinations,
    pairedUtility,
    directTop2VsBaseline: combineDirectTop2Results(combinations),
    cost: {
      baselineAverageDecisionMs: round(baselineDecisionMs),
      top2AverageDecisionMs: round(top2DecisionMs),
      ratio: baselineDecisionMs ? round(top2DecisionMs / baselineDecisionMs) : 0,
    },
  }
}

export function combineDirectTop2Results(combinations: Array<{
  config: string
  rival: MCTSOpponent
  aggregate: ReturnType<typeof summarizeMCTSResults>
  byColor: Record<string, ReturnType<typeof summarizeMCTSResults>>
}>) {
  const baseline = combinations.find(
    (row) => row.config === 'baseline-final' && row.rival === 'baseline-mcts',
  )
  const top2 = combinations.find(
    (row) => row.config === 'tactical-top-2' && row.rival === 'baseline-mcts',
  )
  if (!baseline || !top2) return undefined
  const wins = top2.aggregate.wins + baseline.aggregate.losses
  const losses = top2.aggregate.losses + baseline.aggregate.wins
  const ties = top2.aggregate.ties + baseline.aggregate.ties
  const games = wins + losses + ties
  const color = (top2Color: 'R' | 'B') => {
    const inverseBaselineColor = top2Color === 'R' ? 'B' : 'R'
    const direct = top2.byColor[top2Color]!
    const inverse = baseline.byColor[inverseBaselineColor]!
    const colorWins = direct.wins + inverse.losses
    const colorLosses = direct.losses + inverse.wins
    const colorTies = direct.ties + inverse.ties
    return { games: colorWins + colorLosses + colorTies, wins: colorWins, losses: colorLosses, ties: colorTies }
  }
  const winRate = games ? round(wins / games * 100) : 0
  const winRateCI95 = wilson95(wins, games)
  return {
    games,
    wins,
    losses,
    ties,
    winRate,
    winRateCI95,
    averageTerritoryDiff: round(
      (top2.aggregate.averageTerritoryDiff * top2.aggregate.games -
        baseline.aggregate.averageTerritoryDiff * baseline.aggregate.games) / games,
    ),
    byColor: { R: color('R'), B: color('B') },
    includesBothEvaluationOrientations: true,
    exceeds50Consistently: winRateCI95.low > 50,
  }
}

export function buildTacticalConfirmationSchedule() {
  return buildMCTSEvaluationSchedule(
    MCTS_TACTICAL_CONFIRMATION_CONFIGS,
    [...MCTS_TACTICAL_CONFIRMATION_RIVALS],
    50,
    MCTS_TACTICAL_CONFIRMATION_SEED,
    MCTS_TACTICAL_CONFIRMATION_GAMES,
  )
}

export function getDirectOpponentConfig(configName: string): MCTSConfig {
  return configName === 'baseline-final'
    ? MCTS_TACTICAL_CONFIRMATION_CONFIGS[1]
    : MCTS_TACTICAL_CONFIRMATION_CONFIGS[0]
}

export async function evaluateMCTSTacticalConfirmation(options: {
  outputDir?: string
  overwrite?: boolean
  maxTurns?: number
  progressEvery?: number
  createdAt?: string
  gamesPerRival?: Partial<Record<MCTSOpponent, number>>
  configs?: readonly NamedMCTSConfig[]
  rivals?: readonly MCTSOpponent[]
} = {}) {
  const outputDir = options.outputDir ?? MCTS_TACTICAL_CONFIRMATION_OUTPUT_DIR
  const configs = options.configs ?? MCTS_TACTICAL_CONFIRMATION_CONFIGS
  const rivals = options.rivals ?? MCTS_TACTICAL_CONFIRMATION_RIVALS
  const evaluation = await evaluateMCTS({
    configs,
    rivals,
    gamesPerCombination: 50,
    gamesPerRival: options.gamesPerRival ?? MCTS_TACTICAL_CONFIRMATION_GAMES,
    seedBase: MCTS_TACTICAL_CONFIRMATION_SEED,
    maxTurns: options.maxTurns ?? MCTS_TACTICAL_CONFIRMATION_MAX_TURNS,
    outputDir,
    overwrite: options.overwrite,
    progressEvery: options.progressEvery,
    createdAt: options.createdAt,
    outputFilePrefix: 'mcts_tactical_confirmation',
    evaluationVersion: MCTS_TACTICAL_CONFIRMATION_VERSION,
    mctsOpponentConfig: (pairing): MCTSConfig => getDirectOpponentConfig(pairing.config.name),
  })
  const analysis = summarizeTacticalConfirmation(evaluation.results)
  const summary = {
    ...evaluation.summary,
    experiment: {
      comparedConfigurations: ['baseline-final', 'tactical-top-2'],
      directOpponentIsOppositeConfiguration: true,
      playableFinalConfigurationReplaced: false,
    },
    analysis,
  }
  writeFileSync(
    path.join(path.resolve(outputDir), 'mcts_tactical_confirmation_summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  )
  return { ...evaluation, summary, analysis }
}

async function main() {
  const command = process.argv[2] ?? 'full'
  if (!['smoke', 'full', 'refresh-summary'].includes(command)) throw new Error(`Unknown command: ${command}`)
  if (command === 'refresh-summary') {
    const summaryPath = path.join(
      MCTS_TACTICAL_CONFIRMATION_OUTPUT_DIR,
      'mcts_tactical_confirmation_summary.json',
    )
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      analysis: { combinations: Parameters<typeof combineDirectTop2Results>[0]; directTop2VsBaseline: unknown }
    }
    summary.analysis.directTop2VsBaseline = combineDirectTop2Results(summary.analysis.combinations)
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    console.log('[evaluateMCTSTacticalConfirmation] summary refreshed from completed results')
    return
  }
  const started = performance.now()
  const result = await evaluateMCTSTacticalConfirmation(command === 'smoke' ? {
    outputDir: `${MCTS_TACTICAL_CONFIRMATION_OUTPUT_DIR}_smoke`,
    gamesPerRival: { heuristic: 2, 'q5-final': 2, 'baseline-mcts': 2, random: 2 },
    maxTurns: 40,
    progressEvery: 1,
  } : { progressEvery: 10 })
  console.log(`[evaluateMCTSTacticalConfirmation] ${result.results.length} games in ${round(performance.now() - started)} ms`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
