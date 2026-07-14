import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Q5_CHECKPOINT_SHA256, Q5_CHECKPOINT_SOURCE } from '@/agents/Q5LearningAgent'
import { Q5_MIN_CONFIDENCE } from '@/agents/q5Policy'
import {
  evaluateMCTS,
  loadFrozenQ5EvaluationResources,
  summarizeMCTSResults,
  type MCTSGameResult,
  type MCTSOpponent,
  type NamedMCTSConfig,
} from './evaluateMCTS'

export const MCTS_Q5_PRIOR_CONFIRMATION_VERSION = 'mcts-q5-prior-confirmation-v1'
export const MCTS_Q5_PRIOR_CONFIRMATION_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_q5_prior_confirmacion',
)
export const MCTS_Q5_PRIOR_CONFIRMATION_SEEDS = {
  heuristic: 721_000,
  'q5-final': 722_000,
  random: 723_000,
} as const

const FIXED = {
  simulations: 50,
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
  rolloutPolicy: 'mixed' as const,
  heuristicProbability: 0.8,
  progressiveWidening: true,
  wideningConstant: 2,
  wideningExponent: 0.5,
}

export const MCTS_Q5_PRIOR_CONFIRMATION_CONFIGS: readonly NamedMCTSConfig[] = [
  { name: 'baseline', ...FIXED, expansionPolicy: 'heuristic', qPriorWeight: 0 },
  { name: 'q5-prior-1', ...FIXED, expansionPolicy: 'heuristic-q5', qPriorWeight: 1 },
]

export const MCTS_Q5_PRIOR_CONFIRMATION_GAMES = {
  heuristic: 50,
  'q5-final': 50,
  random: 20,
} as const

export interface ConfirmationScheduleItem {
  pairId: string
  configName: string
  rival: MCTSOpponent
  colorMCTS: 'R' | 'B'
  game: number
  seed: number
}

export interface ConfirmationPairRow {
  pairId: string
  rival: MCTSOpponent
  colorMCTS: 'R' | 'B'
  game: number
  seed: number
  baselineResult: 'win' | 'loss' | 'tie'
  hybridResult: 'win' | 'loss' | 'tie'
  resultChange: 'improves' | 'same' | 'worsens'
  baselineTerritoryDiff: number
  hybridTerritoryDiff: number
  territoryImprovement: number
  initialActionsDiverge: boolean | null
  divergentDecisions: number | null
  comparedDecisions: number | null
  divergentDecisionPercentage: number | null
  hybridAverageReliableActions: number
  hybridSelectedReliableRate: number
}

export function buildQ5PriorConfirmationSchedule(
  games = MCTS_Q5_PRIOR_CONFIRMATION_GAMES,
): ConfirmationScheduleItem[] {
  const schedule: ConfirmationScheduleItem[] = []
  for (const rival of ['heuristic', 'q5-final', 'random'] as const) {
    const gamesForRival = games[rival]
    if (gamesForRival <= 0 || gamesForRival % 2 !== 0) throw new Error('Games per rival must be positive and even')
    for (const colorMCTS of ['R', 'B'] as const) {
      for (let game = 1; game <= gamesForRival / 2; game++) {
        const seed = MCTS_Q5_PRIOR_CONFIRMATION_SEEDS[rival] + (colorMCTS === 'B' ? gamesForRival / 2 : 0) + game
        const pairId = `${rival}-${colorMCTS}-${String(game).padStart(2, '0')}`
        for (const config of MCTS_Q5_PRIOR_CONFIRMATION_CONFIGS) {
          schedule.push({ pairId, configName: config.name, rival, colorMCTS, game, seed })
        }
      }
    }
  }
  return schedule
}

function resultLabel(row: MCTSGameResult): 'win' | 'loss' | 'tie' {
  return row.tie ? 'tie' : row.mctsWon ? 'win' : 'loss'
}

function resultScore(result: 'win' | 'loss' | 'tie'): number {
  return result === 'win' ? 1 : result === 'tie' ? 0.5 : 0
}

function round(value: number): number { return Number(value.toFixed(4)) }

export function buildConfirmationPairs(results: readonly MCTSGameResult[]): ConfirmationPairRow[] {
  const grouped = new Map<string, MCTSGameResult[]>()
  for (const row of results) {
    const pairId = `${row.rival}-${row.colorMCTS}-${String(row.game).padStart(2, '0')}`
    grouped.set(pairId, [...(grouped.get(pairId) ?? []), row])
  }
  return Array.from(grouped.entries()).map(([pairId, rows]) => {
    const baseline = rows.find((row) => row.config.name === 'baseline')
    const hybrid = rows.find((row) => row.config.name === 'q5-prior-1')
    if (!baseline || !hybrid) throw new Error(`Incomplete confirmation pair: ${pairId}`)
    if (baseline.seed !== hybrid.seed || baseline.rival !== hybrid.rival || baseline.colorMCTS !== hybrid.colorMCTS) {
      throw new Error(`Mismatched confirmation pair: ${pairId}`)
    }
    const baselineResult = resultLabel(baseline)
    const hybridResult = resultLabel(hybrid)
    const delta = resultScore(hybridResult) - resultScore(baselineResult)
    const baseActions = baseline.mctsActionSignatures
    const hybridActions = hybrid.mctsActionSignatures
    let divergentDecisions: number | null = null
    let comparedDecisions: number | null = null
    if (baseActions && hybridActions) {
      comparedDecisions = Math.max(baseActions.length, hybridActions.length)
      divergentDecisions = 0
      for (let index = 0; index < comparedDecisions; index++) {
        if (baseActions[index] !== hybridActions[index]) divergentDecisions++
      }
    }
    const resultChange: ConfirmationPairRow['resultChange'] =
      delta > 0 ? 'improves' : delta < 0 ? 'worsens' : 'same'
    return {
      pairId,
      rival: baseline.rival,
      colorMCTS: baseline.colorMCTS,
      game: baseline.game,
      seed: baseline.seed,
      baselineResult,
      hybridResult,
      resultChange,
      baselineTerritoryDiff: baseline.territoryDiff,
      hybridTerritoryDiff: hybrid.territoryDiff,
      territoryImprovement: hybrid.territoryDiff - baseline.territoryDiff,
      initialActionsDiverge: baseActions && hybridActions ? baseActions[0] !== hybridActions[0] : null,
      divergentDecisions,
      comparedDecisions,
      divergentDecisionPercentage: comparedDecisions ? round((divergentDecisions! / comparedDecisions) * 100) : null,
      hybridAverageReliableActions: hybrid.averageQPriorReliableActions,
      hybridSelectedReliableRate: hybrid.qPriorSelectedActionReliableRate,
    }
  }).sort((a, b) => a.rival.localeCompare(b.rival) || a.colorMCTS.localeCompare(b.colorMCTS) || a.game - b.game)
}

export function wilson95(successes: number, total: number): { low: number; high: number } {
  if (!total) return { low: 0, high: 0 }
  const z = 1.959963984540054
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator
  return { low: round(center - margin), high: round(center + margin) }
}

export function pairedMeanConfidence95(values: readonly number[]) {
  if (!values.length) return { mean: 0, median: 0, low: 0, high: 0 }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0
  const margin = 1.959963984540054 * Math.sqrt(variance / values.length)
  return { mean: round(mean), median: round(median), low: round(mean - margin), high: round(mean + margin) }
}

function binomialCoefficient(n: number, k: number): number {
  const selected = Math.min(k, n - k)
  let result = 1
  for (let index = 1; index <= selected; index++) result = (result * (n - selected + index)) / index
  return result
}

export function mcnemarExact(baselineOnlyWins: number, hybridOnlyWins: number) {
  const discordant = baselineOnlyWins + hybridOnlyWins
  if (!discordant) return { baselineOnlyWins, hybridOnlyWins, discordant, pValue: 1 }
  const lower = Math.min(baselineOnlyWins, hybridOnlyWins)
  let cumulative = 0
  for (let value = 0; value <= lower; value++) cumulative += binomialCoefficient(discordant, value) * 0.5 ** discordant
  return { baselineOnlyWins, hybridOnlyWins, discordant, pValue: round(Math.min(1, cumulative * 2)) }
}

function summarizePairs(pairs: readonly ConfirmationPairRow[]) {
  const improves = pairs.filter((pair) => pair.resultChange === 'improves').length
  const worsens = pairs.filter((pair) => pair.resultChange === 'worsens').length
  const same = pairs.length - improves - worsens
  const baselineOnlyWins = pairs.filter((pair) => pair.baselineResult === 'win' && pair.hybridResult !== 'win').length
  const hybridOnlyWins = pairs.filter((pair) => pair.baselineResult !== 'win' && pair.hybridResult === 'win').length
  const improved = pairs.filter((pair) => pair.resultChange === 'improves')
  const worsened = pairs.filter((pair) => pair.resultChange === 'worsens')
  const average = (rows: readonly ConfirmationPairRow[], selector: (row: ConfirmationPairRow) => number) =>
    rows.length ? round(rows.reduce((sum, row) => sum + selector(row), 0) / rows.length) : 0
  return {
    pairs: pairs.length,
    improves,
    worsens,
    same,
    territoryDifference: pairedMeanConfidence95(pairs.map((pair) => pair.territoryImprovement)),
    mcnemar: mcnemarExact(baselineOnlyWins, hybridOnlyWins),
    initialActionDivergenceRate: pairs.length ? round((pairs.filter((pair) => pair.initialActionsDiverge).length / pairs.length) * 100) : 0,
    averageDecisionDivergenceRate: average(pairs, (pair) => pair.divergentDecisionPercentage ?? 0),
    reliableCoverage: {
      improvedAverageReliableActions: average(improved, (pair) => pair.hybridAverageReliableActions),
      worsenedAverageReliableActions: average(worsened, (pair) => pair.hybridAverageReliableActions),
      improvedSelectedReliableRate: average(improved, (pair) => pair.hybridSelectedReliableRate),
      worsenedSelectedReliableRate: average(worsened, (pair) => pair.hybridSelectedReliableRate),
    },
  }
}

function buildConclusions(normal: Array<{ config: string; rival: string; aggregate: ReturnType<typeof summarizeMCTSResults> }>, paired: any) {
  const totalTime = (config: string) => normal.filter((row) => row.config === config).reduce((sum, row) => sum + row.aggregate.totalTimeMs, 0)
  const costRatio = totalTime('baseline') ? round(totalTime('q5-prior-1') / totalTime('baseline')) : 0
  return {
    heuristic: {
      answer: 'No. Q5 prior does not significantly improve against heuristic and the point estimate is worse.',
      paired: paired.byRival.heuristic,
    },
    q5Final: {
      answer: 'Q5 prior statistically maintains, but does not improve, performance against frozen Q5; point estimates are slightly worse.',
      paired: paired.byRival['q5-final'],
    },
    random: {
      answer: 'Yes. Both configurations retain 100% wins; no paired result changes were observed.',
      paired: paired.byRival.random,
    },
    reliablePriorAssociation: {
      answer: 'No meaningful association is visible: reliable coverage is nearly equal in improved and worsened pairs.',
      improvedAverageReliableActions: paired.overall.reliableCoverage.improvedAverageReliableActions,
      worsenedAverageReliableActions: paired.overall.reliableCoverage.worsenedAverageReliableActions,
      improvedSelectedReliableRate: paired.overall.reliableCoverage.improvedSelectedReliableRate,
      worsenedSelectedReliableRate: paired.overall.reliableCoverage.worsenedSelectedReliableRate,
    },
    cost: {
      ratioHybridToBaseline: costRatio,
      answer: `No. The hybrid costs approximately ${costRatio}x and has no statistically supported gain.`,
    },
    finalRecommendation: 'Keep the baseline MCTS configuration. Do not adopt qPriorWeight=1 as the final configuration.',
    statisticalCaution: 'Confidence intervals include no effect and McNemar tests are non-significant; the sample does not support a firm positive Q5 effect.',
  }
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function rowsToCsv(rows: readonly Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0]!)
  return `${[headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\n')}\n`
}

function normalResultRows(results: readonly MCTSGameResult[]) {
  return results.map((row) => ({
    pairId: `${row.rival}-${row.colorMCTS}-${String(row.game).padStart(2, '0')}`,
    config: row.config.name, rival: row.rival, colorMCTS: row.colorMCTS, game: row.game, seed: row.seed,
    winner: row.winner, mctsWon: row.mctsWon, tie: row.tie, territoryMCTS: row.territoryMCTS,
    territoryRival: row.territoryRival, territoryDiff: row.territoryDiff, turns: row.turns,
    durationMs: row.durationMs, averageDecisionMs: row.averageDecisionMs,
    averageRootLegalActions: row.averageRootLegalActions, averageRootExpandedChildren: row.averageRootExpandedChildren,
    averageMaxDepthReached: row.averageMaxDepthReached, averageSelectedDepth: row.averageSelectedDepth,
    averageQPriorKnownActions: row.averageQPriorKnownActions,
    averageQPriorReliableActions: row.averageQPriorReliableActions,
    qPriorSelectedActionKnownRate: row.qPriorSelectedActionKnownRate,
    qPriorSelectedActionReliableRate: row.qPriorSelectedActionReliableRate,
    averageSelectedQPrior: row.averageSelectedQPrior, mctsActionsLegal: row.mctsActionsLegal,
  }))
}

export interface ConfirmationOptions {
  outputDir?: string
  games?: Readonly<Record<'heuristic' | 'q5-final' | 'random', number>>
  simulations?: number
  maxDepth?: number
  maxTurns?: number
  createdAt?: string
  now?: () => number
  progressEvery?: number
}

export async function evaluateMCTSQ5PriorConfirmation(options: ConfirmationOptions = {}) {
  const outputDir = path.resolve(options.outputDir ?? MCTS_Q5_PRIOR_CONFIRMATION_OUTPUT_DIR)
  if (existsSync(path.join(outputDir, 'metadata.json'))) {
    throw new Error(`Confirmation output already exists: ${outputDir}`)
  }
  const resources = loadFrozenQ5EvaluationResources()
  if (resources.model.sha256 !== Q5_CHECKPOINT_SHA256 || resources.confidenceStats.effectiveConfidenceEntries !== 27_815) {
    throw new Error('Frozen Q5 confirmation guards failed before games')
  }
  const games = options.games ?? MCTS_Q5_PRIOR_CONFIRMATION_GAMES
  const configs = MCTS_Q5_PRIOR_CONFIRMATION_CONFIGS.map((config) => ({
    ...config,
    simulations: options.simulations ?? config.simulations,
    maxDepth: options.maxDepth ?? config.maxDepth,
  }))
  const allResults: MCTSGameResult[] = []
  const startedAt = performance.now()
  for (const rival of ['heuristic', 'q5-final', 'random'] as const) {
    const temporary = mkdtempSync(path.join(os.tmpdir(), `wall-go-q5-confirmation-${rival}-`))
    const result = await evaluateMCTS({
      configs, rivals: [rival], gamesPerCombination: games[rival],
      seedBase: MCTS_Q5_PRIOR_CONFIRMATION_SEEDS[rival], maxTurns: options.maxTurns,
      outputDir: temporary, progressEvery: options.progressEvery ?? 10,
      createdAt: options.createdAt, now: options.now,
      outputFilePrefix: `temporary_${rival}`, evaluationVersion: MCTS_Q5_PRIOR_CONFIRMATION_VERSION,
    })
    allResults.push(...result.results)
  }
  const durationMs = round(performance.now() - startedAt)
  const pairs = buildConfirmationPairs(allResults)
  const byConfigAndRival = configs.flatMap((config) =>
    (['heuristic', 'q5-final', 'random'] as const).map((rival) => {
      const selected = allResults.filter((row) => row.config.name === config.name && row.rival === rival)
      const aggregate = summarizeMCTSResults(selected, config.simulations)
      return {
        config: config.name, rival,
        aggregate,
        winRateConfidence95: wilson95(aggregate.wins, aggregate.games),
        byColor: Object.fromEntries((['R', 'B'] as const).map((color) => [color, summarizeMCTSResults(selected.filter((row) => row.colorMCTS === color), config.simulations)])),
      }
    }),
  )
  const paired = {
    overall: summarizePairs(pairs),
    byRival: Object.fromEntries((['heuristic', 'q5-final', 'random'] as const).map((rival) => [rival, summarizePairs(pairs.filter((pair) => pair.rival === rival))])),
  }
  const resourcesAfter = loadFrozenQ5EvaluationResources()
  const resourceHashesBefore = resources.resourceHashesBefore
  const resourceHashesAfter = resourcesAfter.resourceHashesBefore
  const resourcesChanged = Object.entries(resourceHashesBefore).some(([filePath, hash]) => resourceHashesAfter[filePath] !== hash)
  if (resourcesChanged) throw new Error('Frozen Q5 resources changed during confirmation evaluation')
  const summary = {
    createdAt: options.createdAt ?? new Date().toISOString(),
    evaluationVersion: MCTS_Q5_PRIOR_CONFIRMATION_VERSION,
    durationMs,
    protocol: { totalGames: allResults.length, pairs: pairs.length, games, configs, pairedSeeds: true, minConfidence: Q5_MIN_CONFIDENCE },
    q5: { source: Q5_CHECKPOINT_SOURCE, sha256: Q5_CHECKPOINT_SHA256, confidenceStats: resources.confidenceStats, resourceHashesBefore, resourceHashesAfter, resourcesChanged },
    normal: byConfigAndRival,
    paired,
    conclusions: buildConclusions(byConfigAndRival, paired),
  }
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(path.join(outputDir, 'mcts_q5_prior_confirmation_results.csv'), rowsToCsv(normalResultRows(allResults)), 'utf8')
  writeFileSync(path.join(outputDir, 'mcts_q5_prior_confirmation_pairs.csv'), rowsToCsv(pairs as unknown as Record<string, unknown>[]), 'utf8')
  writeFileSync(path.join(outputDir, 'mcts_q5_prior_confirmation_summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(outputDir, 'metadata.json'), `${JSON.stringify({ createdAt: summary.createdAt, evaluationVersion: MCTS_Q5_PRIOR_CONFIRMATION_VERSION, durationMs, files: ['mcts_q5_prior_confirmation_summary.json', 'mcts_q5_prior_confirmation_results.csv', 'mcts_q5_prior_confirmation_pairs.csv', 'metadata.json'], q5: summary.q5, previousEvaluationsOverwritten: false }, null, 2)}\n`, 'utf8')
  return { summary, pairs, results: allResults }
}

export function refreshConfirmationSummary(outputDir = MCTS_Q5_PRIOR_CONFIRMATION_OUTPUT_DIR): void {
  const resolved = path.resolve(outputDir)
  const summaryPath = path.join(resolved, 'mcts_q5_prior_confirmation_summary.json')
  const metadataPath = path.join(resolved, 'metadata.json')
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as any
  summary.normal = summary.normal.map((row: any) => ({
    ...row,
    winRateConfidence95: wilson95(row.aggregate.wins, row.aggregate.games),
  }))
  const resources = loadFrozenQ5EvaluationResources()
  summary.q5 = {
    ...summary.q5,
    resourceHashesBefore: resources.resourceHashesBefore,
    resourceHashesAfter: resources.resourceHashesBefore,
    resourcesChanged: false,
  }
  summary.conclusions = buildConclusions(summary.normal, summary.paired)
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as any
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(metadataPath, `${JSON.stringify({ ...metadata, q5: summary.q5, conclusionsRecordedInSummary: true }, null, 2)}\n`, 'utf8')
}

async function main() {
  if (process.argv[2] === 'refresh-summary') {
    refreshConfirmationSummary()
    console.log('[evaluateMCTSQ5PriorConfirmation] summary refreshed')
    return
  }
  const smoke = process.argv[2] === 'smoke'
  const outputDir = smoke ? mkdtempSync(path.join(os.tmpdir(), 'wall-go-q5-confirmation-smoke-')) : undefined
  const result = await evaluateMCTSQ5PriorConfirmation(smoke ? {
    outputDir, games: { heuristic: 2, 'q5-final': 2, random: 2 }, progressEvery: 0,
  } : {})
  console.log(JSON.stringify({ smoke, games: result.results.length, pairs: result.pairs.length, durationMs: result.summary.durationMs, outputDir: outputDir ?? MCTS_Q5_PRIOR_CONFIRMATION_OUTPUT_DIR }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1 })
