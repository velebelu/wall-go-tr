import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MCTS_BASELINE_MAX_TURNS,
  evaluateMCTS,
  type EvaluateMCTSOptions,
  type NamedMCTSConfig,
} from './evaluateMCTS'
import { MCTS_Q5_PRIOR_CONFIGS, MCTS_Q5_PRIOR_SEED } from './evaluateMCTSQ5Prior'

export const MCTS_Q5_PRIOR_CORRECTED_VERSION = 'mcts-q5-prior-corrected-v1'
export const MCTS_Q5_PRIOR_CORRECTED_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_q5_prior_corregida',
)

export interface EvaluateMCTSQ5PriorCorrectedOptions
  extends Omit<
    EvaluateMCTSOptions,
    'configs' | 'rivals' | 'gamesPerCombination' | 'seedBase' | 'maxTurns'
  > {
  configs?: readonly NamedMCTSConfig[]
  gamesPerCombination?: number
  seedBase?: number
  maxTurns?: number
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

interface ComparisonRow {
  configName: string
  mctsWon: boolean
  tie: boolean
  territoryDiff: number
  durationMs: number
  mctsDecisions: number
  averageQPriorKnownActions: number
  averageQPriorReliableActions: number
  qPriorSelectedActionReliableRate: number
  averageSelectedQPrior: number
}

export function buildQ5PriorWeightComparison(rows: readonly ComparisonRow[]) {
  const configNames = MCTS_Q5_PRIOR_CONFIGS.map((config) => config.name)
  const aggregates = configNames.map((configName) => {
    const selected = rows.filter((row) => row.configName === configName)
    const decisions = selected.reduce((sum, row) => sum + row.mctsDecisions, 0)
    const average = (selector: (row: ComparisonRow) => number) =>
      selected.length
        ? Number(
            (selected.reduce((sum, row) => sum + selector(row), 0) / selected.length).toFixed(4),
          )
        : 0
    const decisionAverage = (selector: (row: ComparisonRow) => number) =>
      decisions
        ? Number(
            (
              selected.reduce((sum, row) => sum + selector(row) * row.mctsDecisions, 0) / decisions
            ).toFixed(4),
          )
        : 0
    const wins = selected.filter((row) => row.mctsWon).length
    const ties = selected.filter((row) => row.tie).length
    return {
      configName,
      qPriorWeight:
        MCTS_Q5_PRIOR_CONFIGS.find((config) => config.name === configName)?.qPriorWeight ?? 0,
      games: selected.length,
      wins,
      losses: selected.length - wins - ties,
      ties,
      winRate: selected.length ? Number(((wins / selected.length) * 100).toFixed(4)) : 0,
      averageTerritoryDiff: average((row) => row.territoryDiff),
      totalTimeMs: Number(selected.reduce((sum, row) => sum + row.durationMs, 0).toFixed(4)),
      averageQPriorKnownActions: decisionAverage((row) => row.averageQPriorKnownActions),
      averageQPriorReliableActions: decisionAverage((row) => row.averageQPriorReliableActions),
      qPriorSelectedActionReliableRate: decisionAverage(
        (row) => row.qPriorSelectedActionReliableRate,
      ),
      averageSelectedQPrior: decisionAverage((row) => row.averageSelectedQPrior),
    }
  })
  const baseline = aggregates[0]!
  return aggregates.map((aggregate) => ({
    ...aggregate,
    versusBaseline: {
      wins: aggregate.wins - baseline.wins,
      winRatePoints: Number((aggregate.winRate - baseline.winRate).toFixed(4)),
      averageTerritoryDiff: Number(
        (aggregate.averageTerritoryDiff - baseline.averageTerritoryDiff).toFixed(4),
      ),
      totalTimeMs: Number((aggregate.totalTimeMs - baseline.totalTimeMs).toFixed(4)),
    },
  }))
}

export async function evaluateMCTSQ5PriorCorrected(
  options: EvaluateMCTSQ5PriorCorrectedOptions = {},
) {
  const outputDir = options.outputDir ?? MCTS_Q5_PRIOR_CORRECTED_OUTPUT_DIR
  const result = await evaluateMCTS({
    ...options,
    configs: options.configs ?? MCTS_Q5_PRIOR_CONFIGS,
    rivals: ['heuristic', 'random', 'q5-final'],
    gamesPerCombination: options.gamesPerCombination ?? 10,
    seedBase: options.seedBase ?? MCTS_Q5_PRIOR_SEED,
    maxTurns: options.maxTurns ?? MCTS_BASELINE_MAX_TURNS,
    outputDir,
    outputFilePrefix: 'mcts_q5_prior_corrected',
    evaluationVersion: MCTS_Q5_PRIOR_CORRECTED_VERSION,
  })
  const correction = {
    previousEvaluationInvalidated: true,
    correctedRepetition: true,
    parametersIdenticalToInvalidatedEvaluation: true,
    onlyChange: 'Q5 confidence map construction uses Array.from instead of iterator spread',
  }
  const comparisonRows: ComparisonRow[] = result.results.map((row) => ({
    configName: row.config.name,
    mctsWon: row.mctsWon,
    tie: row.tie,
    territoryDiff: row.territoryDiff,
    durationMs: row.durationMs,
    mctsDecisions: row.mctsDecisions,
    averageQPriorKnownActions: row.averageQPriorKnownActions,
    averageQPriorReliableActions: row.averageQPriorReliableActions,
    qPriorSelectedActionReliableRate: row.qPriorSelectedActionReliableRate,
    averageSelectedQPrior: row.averageSelectedQPrior,
  }))
  const summary = {
    ...result.summary,
    correction,
    weightComparison: buildQ5PriorWeightComparison(comparisonRows),
  }
  const metadata = { ...result.metadata, correction }
  writeJson(path.join(outputDir, 'mcts_q5_prior_corrected_summary.json'), summary)
  writeJson(path.join(outputDir, 'metadata.json'), metadata)
  return { ...result, summary, metadata }
}

export function refreshCorrectedSummary(outputDir = MCTS_Q5_PRIOR_CORRECTED_OUTPUT_DIR): void {
  const resolved = path.resolve(outputDir)
  const summaryPath = path.join(resolved, 'mcts_q5_prior_corrected_summary.json')
  const metadataPath = path.join(resolved, 'metadata.json')
  const csvLines = readFileSync(path.join(resolved, 'mcts_q5_prior_corrected_results.csv'), 'utf8')
    .trim()
    .split(/\r?\n/)
  const headers = csvLines[0]!.split(',')
  const index = (name: string) => headers.indexOf(name)
  const rows: ComparisonRow[] = csvLines.slice(1).map((line) => {
    const values = line.split(',')
    const number = (name: string) => Number(values[index(name)])
    return {
      configName: values[index('config')]!,
      mctsWon: values[index('winner')] === values[index('colorMCTS')],
      tie: values[index('winner')] === 'tie',
      territoryDiff: number('territoryDiff'),
      durationMs: number('durationMs'),
      mctsDecisions: number('mctsDecisions'),
      averageQPriorKnownActions: number('averageQPriorKnownActions'),
      averageQPriorReliableActions: number('averageQPriorReliableActions'),
      qPriorSelectedActionReliableRate: number('qPriorSelectedActionReliableRate'),
      averageSelectedQPrior: number('averageSelectedQPrior'),
    }
  })
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>
  writeJson(summaryPath, { ...summary, weightComparison: buildQ5PriorWeightComparison(rows) })
  writeJson(metadataPath, { ...metadata, weightComparisonRecordedInSummary: true })
}

async function main(): Promise<void> {
  if (process.argv[2] === 'refresh-summary') {
    refreshCorrectedSummary()
    console.log('[evaluateMCTSQ5PriorCorrected] summary refreshed')
    return
  }
  const result = await evaluateMCTSQ5PriorCorrected()
  console.log(`[evaluateMCTSQ5PriorCorrected] games: ${result.results.length}`)
  console.log(`[evaluateMCTSQ5PriorCorrected] output: ${MCTS_Q5_PRIOR_CORRECTED_OUTPUT_DIR}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
