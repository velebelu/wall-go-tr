import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Player, PlayerAction } from '@/lib/types'
import * as ai from '@/utils/ai'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { getTerritoryCounts } from './compareLearningAgents'
import {
  chooseHeuristicOpponentActionQ4,
  chooseRandomActionWithRngQ4,
  createSeededRngQ4,
} from './trainLearningAgentQ4'
import {
  Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
  Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR,
  Q5_HYBRID_FINAL_CHECKPOINT_1500_DIR,
  Q5_HYBRID_FINAL_CHECKPOINT_1500_CONSERVATIVE_ALPHA_DIR,
  applyFullActionQ5,
  chooseThresholdHybridQ5Action,
  finalizeGameIfNeeded,
  hashFile,
  loadQ5ConfidenceMap,
  loadQTable,
  loadQUpdateCountsFromJsonl,
  qTableFingerprint,
  type Q5OpponentKind,
  type Q5ThresholdPolicyVariant,
} from './trainLearningAgentQ5'

export const Q5_POLICY_COMPARISON_CHECKPOINT_1000_DIR = path.join(
  'data/entrenamiento/q5/hybrid/policy_comparison_checkpoint_1000',
)

export const Q5_1000_VS_1500_EVAL_DIR = path.join(
  'data/entrenamiento/q5/hybrid/evaluacion_checkpoint_1000_vs_1500',
)

export const Q5_1500_CONSERVATIVE_ALPHA_EVAL_DIR = path.join(
  'data/entrenamiento/q5/hybrid/evaluacion_1500_conservative_alpha',
)

export const Q5_POLICY_COMPARISON_QTABLE_PATH = path.join(
  Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR,
  'qtable_q5_hybrid_final_1000.json',
)

export const Q5_POLICY_COMPARISON_1500_QTABLE_PATH = path.join(
  Q5_HYBRID_FINAL_CHECKPOINT_1500_DIR,
  'qtable_q5_hybrid_final_1500.json',
)

export const Q5_POLICY_COMPARISON_1500_CONSERVATIVE_ALPHA_QTABLE_PATH = path.join(
  Q5_HYBRID_FINAL_CHECKPOINT_1500_CONSERVATIVE_ALPHA_DIR,
  'qtable_q5_hybrid_final_1500_conservative_alpha.json',
)

export const Q5_POLICY_COMPARISON_Q_UPDATE_LOG_PATHS = [
  path.join('data/entrenamiento/q5/hybrid/final_checkpoint_500/q_update_log.jsonl'),
  path.join(Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR, 'q_update_log.jsonl'),
]

export const Q5_POLICY_COMPARISON_1500_Q_UPDATE_LOG_PATHS = [
  ...Q5_POLICY_COMPARISON_Q_UPDATE_LOG_PATHS,
  path.join(Q5_HYBRID_FINAL_CHECKPOINT_1500_DIR, 'q_update_log.jsonl'),
]

export const Q5_POLICY_COMPARISON_1500_CONSERVATIVE_ALPHA_Q_UPDATE_LOG_PATHS = [
  ...Q5_POLICY_COMPARISON_Q_UPDATE_LOG_PATHS,
  path.join(Q5_HYBRID_FINAL_CHECKPOINT_1500_CONSERVATIVE_ALPHA_DIR, 'q_update_log.jsonl'),
]

export interface Q5PolicyComparisonPolicy extends Q5ThresholdPolicyVariant {
  label: string
}

export const Q5_POLICY_COMPARISON_POLICIES: Q5PolicyComparisonPolicy[] = [
  { id: 'E', label: 'minConfidence10_margin0.50', minConfidence: 10, minMargin: 0.5 },
  { id: 'D', label: 'minConfidence5_margin0.50', minConfidence: 5, minMargin: 0.5 },
  { id: 'C', label: 'minConfidence5_margin0.25', minConfidence: 5, minMargin: 0.25 },
]

export const Q5_1000_VS_1500_POLICIES: Q5PolicyComparisonPolicy[] = [
  { id: 'E', label: 'minConfidence10_margin0.50', minConfidence: 10, minMargin: 0.5 },
  { id: 'C', label: 'minConfidence5_margin0.25', minConfidence: 5, minMargin: 0.25 },
]

export const Q5_CONSERVATIVE_ALPHA_COMPARISON_POLICIES: Q5PolicyComparisonPolicy[] = [
  { id: 'C', label: 'minConfidence5_margin0.25', minConfidence: 5, minMargin: 0.25 },
]

export interface Q5PolicyComparisonTableConfig {
  label: string
  qTablePath: string
  qUpdateLogPath?: string | string[]
}

export interface Q5PolicyComparisonPairing {
  rival: Q5OpponentKind
  colorQ5: Player
  game: number
  seed: number
}

interface DecisionStats {
  qProposals: number
  qProposalHits: number
  qProposalMisses: number
  qFinalDecisions: number
  heuristicFinalDecisions: number
  heuristicMatches: number
  qOverridesAccepted: number
  qOverridesRejected: number
}

export interface Q5PolicyComparisonGameResult extends Q5PolicyComparisonPairing {
  table: string
  policy: string
  minConfidence: number
  qMargin: number
  winner: Player | 'tie'
  q5Won: boolean
  tie: boolean
  territoryQ5: number
  territoryRival: number
  territorialDiff: number
  turns: number
  qHits: number
  qMisses: number
  decisions: DecisionStats
  qTableChangedDuringEvaluation: boolean
}

export interface Q5PolicyComparisonOptions {
  qTablePath?: string
  tableLabel?: string
  tableConfigs?: Q5PolicyComparisonTableConfig[]
  outputDir?: string
  outputFilePrefix?: string
  gamesPerRival?: number
  seedBase?: number
  overwrite?: boolean
  policies?: Q5PolicyComparisonPolicy[]
  qUpdateLogPath?: string | string[]
  progressEvery?: number
}

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function createDecisionStats(): DecisionStats {
  return {
    qProposals: 0,
    qProposalHits: 0,
    qProposalMisses: 0,
    qFinalDecisions: 0,
    heuristicFinalDecisions: 0,
    heuristicMatches: 0,
    qOverridesAccepted: 0,
    qOverridesRejected: 0,
  }
}

function addDecisionStats(target: DecisionStats, source: DecisionStats): void {
  target.qProposals += source.qProposals
  target.qProposalHits += source.qProposalHits
  target.qProposalMisses += source.qProposalMisses
  target.qFinalDecisions += source.qFinalDecisions
  target.heuristicFinalDecisions += source.heuristicFinalDecisions
  target.heuristicMatches += source.heuristicMatches
  target.qOverridesAccepted += source.qOverridesAccepted
  target.qOverridesRejected += source.qOverridesRejected
}

function assertOutputCanBeWritten(outputDir: string, overwrite: boolean): void {
  try {
    mkdirSync(outputDir, { recursive: false })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' && overwrite) return
    if (code === 'EEXIST') throw new Error(`Output directory already exists: ${outputDir}`)
    throw error
  }
}

export function buildQ5PolicyComparisonPairings(
  gamesPerRival = 1000,
  seedBase = 802000,
): Q5PolicyComparisonPairing[] {
  if (gamesPerRival <= 0 || gamesPerRival % 2 !== 0) {
    throw new Error('gamesPerRival must be a positive even number')
  }
  const pairings: Q5PolicyComparisonPairing[] = []
  let index = 0
  for (const rival of ['random', 'heuristic'] as const) {
    for (const colorQ5 of ['R', 'B'] as const) {
      for (let game = 1; game <= gamesPerRival / 2; game++) {
        index++
        pairings.push({ rival, colorQ5, game, seed: seedBase + index })
      }
    }
  }
  return pairings
}

async function runSinglePolicyComparisonGame(params: {
  table: string
  policy: Q5PolicyComparisonPolicy
  pairing: Q5PolicyComparisonPairing
  qTable: ReturnType<typeof loadQTable>
  confidenceMap: ReturnType<typeof loadQ5ConfidenceMap>
  qLearningUpdateCounts: ReturnType<typeof loadQUpdateCountsFromJsonl>
}): Promise<Q5PolicyComparisonGameResult> {
  const rng = createSeededRngQ4(params.pairing.seed)
  let state = makeInitialState()
  let turns = 0
  let qHits = 0
  let qMisses = 0
  const decisions = createDecisionStats()

  while (state.phase !== 'finished' && !state.result && turns < 250) {
    const previousState = snapshotFromState(state)
    let action: PlayerAction
    if (previousState.turn === params.pairing.colorQ5) {
      const legalActions = ai.getLegalActions(previousState)
      const choice = chooseThresholdHybridQ5Action({
        state: previousState,
        legalActions,
        qTable: params.qTable,
        confidenceMap: params.confidenceMap,
        qLearningUpdateCounts: params.qLearningUpdateCounts,
        variant: params.policy,
        rng,
      })
      action = choice.action
      decisions.qProposals++
      if (params.qTable[choice.qKey] !== undefined) decisions.qProposalHits++
      else decisions.qProposalMisses++

      if (choice.mechanism === 'heuristicMatch') {
        decisions.heuristicMatches++
        decisions.qFinalDecisions++
      } else if (choice.mechanism === 'qOverrideAccepted') {
        decisions.qOverridesAccepted++
        decisions.qFinalDecisions++
      } else {
        decisions.qOverridesRejected++
        decisions.heuristicFinalDecisions++
      }

      if (params.qTable[getLearningQTableKeyQ3(previousState, action)] !== undefined) qHits++
      else qMisses++
    } else if (params.pairing.rival === 'random') {
      action = chooseRandomActionWithRngQ4(ai.getLegalActions(previousState), rng)
    } else {
      action = chooseHeuristicOpponentActionQ4(previousState, rng)
    }
    const applied = applyFullActionQ5(state, action)
    state = applied.state
    turns += applied.turns
  }

  state = finalizeGameIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')
  const rivalColor = getOpponent(params.pairing.colorQ5)
  return {
    ...params.pairing,
    table: params.table,
    policy: params.policy.label,
    minConfidence: params.policy.minConfidence,
    qMargin: params.policy.minMargin,
    winner,
    q5Won: winner === params.pairing.colorQ5,
    tie: winner === 'tie',
    territoryQ5: territory[params.pairing.colorQ5],
    territoryRival: territory[rivalColor],
    territorialDiff: territory[params.pairing.colorQ5] - territory[rivalColor],
    turns,
    qHits,
    qMisses,
    decisions,
    qTableChangedDuringEvaluation: false,
  }
}

function summarizeGroup(results: Q5PolicyComparisonGameResult[]) {
  const wins = results.filter((result) => result.q5Won).length
  const ties = results.filter((result) => result.tie).length
  const losses = results.length - wins - ties
  const qHits = results.reduce((sum, result) => sum + result.qHits, 0)
  const qMisses = results.reduce((sum, result) => sum + result.qMisses, 0)
  const decisions = createDecisionStats()
  for (const result of results) addDecisionStats(decisions, result.decisions)
  const overrideGames = results.filter((result) => result.decisions.qOverridesAccepted > 0)
  const overrideWins = overrideGames.filter((result) => result.q5Won).length
  const overrideTies = overrideGames.filter((result) => result.tie).length
  const totalFinalDecisions = decisions.qFinalDecisions + decisions.heuristicFinalDecisions

  return {
    games: results.length,
    wins,
    losses,
    ties,
    winRate: results.length ? roundMetric((wins / results.length) * 100) : 0,
    averageTerritoryQ5: results.length
      ? roundMetric(results.reduce((sum, result) => sum + result.territoryQ5, 0) / results.length)
      : 0,
    averageTerritoryRival: results.length
      ? roundMetric(results.reduce((sum, result) => sum + result.territoryRival, 0) / results.length)
      : 0,
    averageTerritorialDiff: results.length
      ? roundMetric(results.reduce((sum, result) => sum + result.territorialDiff, 0) / results.length)
      : 0,
    averageTurns: results.length
      ? roundMetric(results.reduce((sum, result) => sum + result.turns, 0) / results.length)
      : 0,
    qHits,
    qMisses,
    qHitRate: qHits + qMisses ? roundMetric((qHits / (qHits + qMisses)) * 100) : 0,
    decisions,
    decisionPercentages: {
      qFinalDecisions: totalFinalDecisions
        ? roundMetric((decisions.qFinalDecisions / totalFinalDecisions) * 100)
        : 0,
      heuristicFinalDecisions: totalFinalDecisions
        ? roundMetric((decisions.heuristicFinalDecisions / totalFinalDecisions) * 100)
        : 0,
      qOverridesAccepted: decisions.qProposals
        ? roundMetric((decisions.qOverridesAccepted / decisions.qProposals) * 100)
        : 0,
      qOverridesRejected: decisions.qProposals
        ? roundMetric((decisions.qOverridesRejected / decisions.qProposals) * 100)
        : 0,
      heuristicMatches: decisions.qProposals
        ? roundMetric((decisions.heuristicMatches / decisions.qProposals) * 100)
        : 0,
    },
    overrideGames: {
      games: overrideGames.length,
      wins: overrideWins,
      losses: overrideGames.length - overrideWins - overrideTies,
      ties: overrideTies,
      winRate: overrideGames.length ? roundMetric((overrideWins / overrideGames.length) * 100) : 0,
    },
    qTableChangedDuringEvaluation: results.some((result) => result.qTableChangedDuringEvaluation),
  }
}

function summarizePolicy(policy: Q5PolicyComparisonPolicy, results: Q5PolicyComparisonGameResult[]) {
  return {
    policy,
    aggregate: summarizeGroup(results),
    byRival: {
      random: summarizeGroup(results.filter((result) => result.rival === 'random')),
      heuristic: summarizeGroup(results.filter((result) => result.rival === 'heuristic')),
    },
    byColor: {
      R: summarizeGroup(results.filter((result) => result.colorQ5 === 'R')),
      B: summarizeGroup(results.filter((result) => result.colorQ5 === 'B')),
    },
  }
}

function csvEscape(value: string | number | boolean): string {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function resultsToCsv(results: Q5PolicyComparisonGameResult[]): string {
  const headers = [
    'table',
    'policy',
    'minConfidence',
    'qMargin',
    'rival',
    'seed',
    'game',
    'colorQ5',
    'winner',
    'territoryQ5',
    'territoryRival',
    'territorialDiff',
    'turns',
    'qHits',
    'qMisses',
    'qProposals',
    'qProposalHits',
    'qProposalMisses',
    'qFinalDecisions',
    'heuristicFinalDecisions',
    'heuristicMatches',
    'qOverridesAccepted',
    'qOverridesRejected',
    'qTableChangedDuringEvaluation',
  ]
  const rows = results.map((result) => [
    result.table,
    result.policy,
    result.minConfidence,
    result.qMargin,
    result.rival,
    result.seed,
    result.game,
    result.colorQ5,
    result.winner,
    result.territoryQ5,
    result.territoryRival,
    result.territorialDiff,
    result.turns,
    result.qHits,
    result.qMisses,
    result.decisions.qProposals,
    result.decisions.qProposalHits,
    result.decisions.qProposalMisses,
    result.decisions.qFinalDecisions,
    result.decisions.heuristicFinalDecisions,
    result.decisions.heuristicMatches,
    result.decisions.qOverridesAccepted,
    result.decisions.qOverridesRejected,
    result.qTableChangedDuringEvaluation,
  ])
  return [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n')
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export async function evaluateQ5PolicyComparison(options: Q5PolicyComparisonOptions = {}) {
  const outputDir = path.resolve(options.outputDir ?? Q5_POLICY_COMPARISON_CHECKPOINT_1000_DIR)
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)
  const policies = options.policies ?? Q5_POLICY_COMPARISON_POLICIES
  const gamesPerRival = options.gamesPerRival ?? 1000
  const seedBase = options.seedBase ?? 802000
  const progressEvery = options.progressEvery ?? 500
  const pairings = buildQ5PolicyComparisonPairings(gamesPerRival, seedBase)
  const confidenceMap = loadQ5ConfidenceMap(Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH)
  const tableConfigs =
    options.tableConfigs ??
    [
      {
        label: options.tableLabel ?? 'q5_1000',
        qTablePath: options.qTablePath ?? Q5_POLICY_COMPARISON_QTABLE_PATH,
        qUpdateLogPath: options.qUpdateLogPath ?? Q5_POLICY_COMPARISON_Q_UPDATE_LOG_PATHS,
      },
    ]
  const allResults: Q5PolicyComparisonGameResult[] = []
  const tableSummaries: Array<{
    label: string
    qTablePath: string
    qTableEntries: number
    qTableHashBefore: string
    qTableHashAfter: string
    qTableChangedDuringEvaluation: boolean
    qLearningUpdatesAfterInitialization: string | string[] | undefined
    qLearningUpdateCountsLoaded: number
  }> = []

  for (const tableConfig of tableConfigs) {
    const qTablePath = path.resolve(tableConfig.qTablePath)
    const qTable = Object.freeze({ ...loadQTable(qTablePath) })
    const hashBefore = hashFile(qTablePath)
    const fingerprintBefore = qTableFingerprint(qTable)
    const qLearningUpdateCounts = loadQUpdateCountsFromJsonl(tableConfig.qUpdateLogPath)
    for (const policy of policies) {
      let completedForPolicy = 0
      for (const pairing of pairings) {
        const result = await runSinglePolicyComparisonGame({
          table: tableConfig.label,
          policy,
          pairing,
          qTable,
          confidenceMap,
          qLearningUpdateCounts,
        })
        allResults.push(result)
        completedForPolicy++
        if (progressEvery > 0 && completedForPolicy % progressEvery === 0) {
          console.log(
            `[evaluateQ5PolicyComparison] ${tableConfig.label} ${policy.label}: ${completedForPolicy}/${pairings.length}`,
          )
        }
      }
    }
    const hashAfter = hashFile(qTablePath)
    tableSummaries.push({
      label: tableConfig.label,
      qTablePath,
      qTableEntries: Object.keys(qTable).length,
      qTableHashBefore: hashBefore,
      qTableHashAfter: hashAfter,
      qTableChangedDuringEvaluation:
        hashBefore !== hashAfter || qTableFingerprint(qTable) !== fingerprintBefore,
      qLearningUpdatesAfterInitialization: tableConfig.qUpdateLogPath,
      qLearningUpdateCountsLoaded: qLearningUpdateCounts.size,
    })
    if (tableSummaries[tableSummaries.length - 1]!.qTableChangedDuringEvaluation) {
      throw new Error(`Q5 policy comparison qTable changed during evaluation: ${tableConfig.label}`)
    }
  }

  const summary = {
    createdAt: new Date().toISOString(),
    model: 'Q5',
    experiment: options.outputFilePrefix ?? 'policy_comparison_checkpoint_1000',
    qTables: tableSummaries,
    qTableChangedDuringEvaluation: tableSummaries.some((table) => table.qTableChangedDuringEvaluation),
    protocol: {
      epsilon: 0,
      learnsDuringEvaluation: false,
      qTableFrozen: true,
      alphaUpdates: false,
      updatesVisitCounts: false,
      representation: 'Q3',
      rewardChanged: false,
      rulesChanged: false,
      heuristicChanged: false,
      seedBase,
      gamesPerPolicy: pairings.length,
      gamesPerRival,
      gamesPerColor: gamesPerRival / 2,
      maxTurns: 250,
      sameSeedsAcrossPolicies: true,
      policies,
      tables: tableConfigs.map((table) => ({ label: table.label, qTablePath: table.qTablePath })),
    },
    confidenceDefinition: {
      value: 'max(originalDatasetObservations, qLearningUpdatesAfterInitialization)',
      originalDatasetObservations: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      byTable: tableSummaries.map((table) => ({
        label: table.label,
        qLearningUpdatesAfterInitialization: table.qLearningUpdatesAfterInitialization,
        qLearningUpdateCountsLoaded: table.qLearningUpdateCountsLoaded,
      })),
    },
    tables: tableSummaries.map((table) => ({
      table,
      policies: policies.map((policy) =>
        summarizePolicy(
          policy,
          allResults.filter((result) => result.table === table.label && result.policy === policy.label),
        ),
      ),
    })),
    policies: policies.map((policy) => ({
      policy,
      byTable: tableSummaries.map((table) => ({
        table: table.label,
        ...summarizePolicy(
          policy,
          allResults.filter((result) => result.table === table.label && result.policy === policy.label),
        ),
      })),
    })),
    combinations: tableSummaries.flatMap((table) =>
      policies.map((policy) => ({
        table: table.label,
        ...summarizePolicy(
          policy,
          allResults.filter((result) => result.table === table.label && result.policy === policy.label),
        ),
      })),
    ),
  }
  if (summary.qTableChangedDuringEvaluation) {
    throw new Error('Q5 policy comparison qTable changed during evaluation')
  }

  const prefix = options.outputFilePrefix ?? 'policy_comparison'
  writeJson(path.join(outputDir, `${prefix}_summary.json`), summary)
  writeFileSync(path.join(outputDir, `${prefix}_results.csv`), `${resultsToCsv(allResults)}\n`, 'utf8')
  writeJson(path.join(outputDir, `${prefix}_detailed.json`), {
    createdAt: summary.createdAt,
    protocol: summary.protocol,
    pairings,
    qTables: tableSummaries,
    results: allResults,
  })

  return { summary, results: allResults }
}

export async function evaluateQ5Checkpoint1000Vs1500(options: {
  outputDir?: string
  gamesPerRival?: number
  seedBase?: number
  overwrite?: boolean
} = {}) {
  return evaluateQ5PolicyComparison({
    outputDir: options.outputDir ?? Q5_1000_VS_1500_EVAL_DIR,
    outputFilePrefix: 'q5_1000_vs_1500',
    gamesPerRival: options.gamesPerRival ?? 1000,
    seedBase: options.seedBase ?? 902000,
    overwrite: options.overwrite,
    policies: Q5_1000_VS_1500_POLICIES,
    tableConfigs: [
      {
        label: 'q5_1000',
        qTablePath: Q5_POLICY_COMPARISON_QTABLE_PATH,
        qUpdateLogPath: Q5_POLICY_COMPARISON_Q_UPDATE_LOG_PATHS,
      },
      {
        label: 'q5_1500',
        qTablePath: Q5_POLICY_COMPARISON_1500_QTABLE_PATH,
        qUpdateLogPath: Q5_POLICY_COMPARISON_1500_Q_UPDATE_LOG_PATHS,
      },
    ],
  })
}

export async function evaluateQ5ConservativeAlphaComparison(options: {
  outputDir?: string
  gamesPerRival?: number
  seedBase?: number
  overwrite?: boolean
} = {}) {
  return evaluateQ5PolicyComparison({
    outputDir: options.outputDir ?? Q5_1500_CONSERVATIVE_ALPHA_EVAL_DIR,
    outputFilePrefix: 'conservative_alpha_comparison',
    gamesPerRival: options.gamesPerRival ?? 1000,
    seedBase: options.seedBase ?? 902000,
    overwrite: options.overwrite,
    policies: Q5_CONSERVATIVE_ALPHA_COMPARISON_POLICIES,
    tableConfigs: [
      {
        label: 'q5_1000',
        qTablePath: Q5_POLICY_COMPARISON_QTABLE_PATH,
        qUpdateLogPath: Q5_POLICY_COMPARISON_Q_UPDATE_LOG_PATHS,
      },
      {
        label: 'q5_1500',
        qTablePath: Q5_POLICY_COMPARISON_1500_QTABLE_PATH,
        qUpdateLogPath: Q5_POLICY_COMPARISON_1500_Q_UPDATE_LOG_PATHS,
      },
      {
        label: 'q5_1500_conservative_alpha',
        qTablePath: Q5_POLICY_COMPARISON_1500_CONSERVATIVE_ALPHA_QTABLE_PATH,
        qUpdateLogPath: Q5_POLICY_COMPARISON_1500_CONSERVATIVE_ALPHA_Q_UPDATE_LOG_PATHS,
      },
    ],
  })
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'policy-comparison-1000'
  if (command === 'checkpoint-1000-vs-1500') {
    const result = await evaluateQ5Checkpoint1000Vs1500()
    console.log(`[evaluateQ5PolicyComparison] Q5 1000 vs 1500 games: ${result.results.length}`)
    console.log(`[evaluateQ5PolicyComparison] output: ${Q5_1000_VS_1500_EVAL_DIR}`)
    return
  }
  if (command === 'conservative-alpha-comparison') {
    const result = await evaluateQ5ConservativeAlphaComparison()
    console.log(`[evaluateQ5PolicyComparison] Q5 conservative alpha comparison games: ${result.results.length}`)
    console.log(`[evaluateQ5PolicyComparison] output: ${Q5_1500_CONSERVATIVE_ALPHA_EVAL_DIR}`)
    return
  }
  if (command !== 'policy-comparison-1000') throw new Error(`Unknown command: ${command}`)
  const result = await evaluateQ5PolicyComparison()
  console.log(`[evaluateQ5PolicyComparison] games: ${result.results.length}`)
  console.log(`[evaluateQ5PolicyComparison] output: ${Q5_POLICY_COMPARISON_CHECKPOINT_1000_DIR}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
