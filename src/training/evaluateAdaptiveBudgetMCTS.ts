import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import { choosePlayableMCTSAction } from '@/agents/mctsWorkerDecision'
import { applyFullAction } from '@/engine/gameSimulator'
import type { MCTSConfig } from '@/engine/mcts/types'
import type { Player, PlayerAction } from '@/lib/types'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { getTerritoryCounts } from './compareLearningAgents'
import { PLAYABLE_MCTS_BASELINE_CONFIG, getPlayableDecisionSeed } from './evaluatePlayableMCTS'
import { wilson95 } from './evaluateMCTSTacticalConfirmation'
import { chooseHeuristicOpponentActionQ4, createSeededRngQ4 } from './trainLearningAgentQ4'
import { ADAPTIVE_BUDGET_VERSION, getAdaptiveMCTSConfig } from './adaptiveMCTSBudget'

export const ADAPTIVE_PILOT_SEED = 1_260_000
export const ADAPTIVE_PILOT_PAIRS_PER_RIVAL = 10
export const ADAPTIVE_PILOT_OUTPUT_DIR =
  'data/entrenamiento/mcts/evaluacion_adaptive_budget_v1_pilot'
export const ADAPTIVE_PILOT_MAX_DECISIONS = 125

export type AdaptiveVariant = 'playable-baseline' | 'adaptive-budget-v1'
export type AdaptiveRival = 'heuristic' | 'baseline-mcts'

export interface AdaptivePilotScheduleItem {
  gameId: string
  pairId: string
  variant: AdaptiveVariant
  rival: AdaptiveRival
  subjectColor: Player
  scenarioSeed: number
  subjectBaseSeed: number
  opponentBaseSeed: number
}

export interface AdaptiveDecisionLog {
  gameId: string
  pairId: string
  variant: AdaptiveVariant
  rival: AdaptiveRival
  subjectColor: Player
  decisionIndex: number
  decisionSeed: number
  legalActionCount: number
  simulations: number
  decisionMs: number
  action: string
}

export interface AdaptivePilotGameResult extends AdaptivePilotScheduleItem {
  winner: Player | 'tie'
  outcome: 'win' | 'loss' | 'tie'
  territorySubject: number
  territoryOpponent: number
  territoryDiff: number
  decisions: number
  subjectDecisions: number
  averageDecisionMs: number
  p50DecisionMs: number
  p95DecisionMs: number
  allSubjectActionsLegal: boolean
}

export interface AdaptivePilotAggregate {
  games: number
  wins: number
  losses: number
  ties: number
  winRate: number
  winRateCI95: { low: number; high: number }
  averageTerritoryDiff: number
  averageDecisionMs: number
  p50DecisionMs: number
  p95DecisionMs: number
  subjectDecisions: number
}

export interface AdaptivePairedComparison {
  pairs: number
  adaptiveBetterOutcome: number
  baselineBetterOutcome: number
  equalOutcome: number
  averageTerritoryDiffDelta: number
}

function round(value: number): number {
  return Number(value.toFixed(4))
}

function opponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function percentile(values: readonly number[], probability: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil(probability * sorted.length) - 1
  return round(sorted[Math.max(0, index)]!)
}

function sameAction(a: PlayerAction, b: PlayerAction): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function buildAdaptivePilotSchedule(
  pairsPerRival = ADAPTIVE_PILOT_PAIRS_PER_RIVAL,
): readonly AdaptivePilotScheduleItem[] {
  const schedule: AdaptivePilotScheduleItem[] = []
  let scenarioIndex = 0
  for (const rival of ['heuristic', 'baseline-mcts'] as const) {
    for (let pairIndex = 0; pairIndex < pairsPerRival; pairIndex++) {
      const scenarioSeed = (ADAPTIVE_PILOT_SEED + scenarioIndex++) >>> 0
      for (const subjectColor of ['R', 'B'] as const) {
        const pairId = `${rival}-${String(pairIndex + 1).padStart(2, '0')}-${subjectColor}`
        for (const variant of ['playable-baseline', 'adaptive-budget-v1'] as const) {
          schedule.push({
            gameId: `${pairId}-${variant}`,
            pairId,
            variant,
            rival,
            subjectColor,
            scenarioSeed,
            subjectBaseSeed: scenarioSeed,
            opponentBaseSeed: (scenarioSeed + 0x9e3779b9) >>> 0,
          })
        }
      }
    }
  }
  return schedule
}

function subjectConfig(variant: AdaptiveVariant, legalActionCount: number): Readonly<MCTSConfig> {
  return variant === 'adaptive-budget-v1'
    ? getAdaptiveMCTSConfig(legalActionCount)
    : FINAL_MCTS_CONFIG
}

export function aggregateAdaptivePilot(
  results: readonly AdaptivePilotGameResult[],
  logs: readonly AdaptiveDecisionLog[],
): AdaptivePilotAggregate {
  const wins = results.filter((result) => result.outcome === 'win').length
  const losses = results.filter((result) => result.outcome === 'loss').length
  const ties = results.length - wins - losses
  const times = logs.map((log) => log.decisionMs)
  return {
    games: results.length,
    wins,
    losses,
    ties,
    winRate: results.length ? round((wins / results.length) * 100) : 0,
    winRateCI95: wilson95(wins, results.length),
    averageTerritoryDiff: results.length
      ? round(results.reduce((sum, result) => sum + result.territoryDiff, 0) / results.length)
      : 0,
    averageDecisionMs: times.length
      ? round(times.reduce((sum, time) => sum + time, 0) / times.length)
      : 0,
    p50DecisionMs: percentile(times, 0.5),
    p95DecisionMs: percentile(times, 0.95),
    subjectDecisions: times.length,
  }
}

export function compareAdaptivePairs(
  results: readonly AdaptivePilotGameResult[],
): AdaptivePairedComparison {
  const pairs = new Map<string, AdaptivePilotGameResult[]>()
  for (const result of results) {
    const pair = pairs.get(result.pairId) ?? []
    pair.push(result)
    pairs.set(result.pairId, pair)
  }
  let adaptiveBetterOutcome = 0
  let baselineBetterOutcome = 0
  let territoryDelta = 0
  const rank = { loss: 0, tie: 1, win: 2 } as const
  for (const [pairId, pair] of pairs) {
    const baseline = pair.find((result) => result.variant === 'playable-baseline')
    const adaptive = pair.find((result) => result.variant === 'adaptive-budget-v1')
    if (pair.length !== 2 || !baseline || !adaptive) {
      throw new Error(`Incomplete or duplicate adaptive pair: ${pairId}`)
    }
    if (rank[adaptive.outcome] > rank[baseline.outcome]) adaptiveBetterOutcome++
    if (rank[baseline.outcome] > rank[adaptive.outcome]) baselineBetterOutcome++
    territoryDelta += adaptive.territoryDiff - baseline.territoryDiff
  }
  return {
    pairs: pairs.size,
    adaptiveBetterOutcome,
    baselineBetterOutcome,
    equalOutcome: pairs.size - adaptiveBetterOutcome - baselineBetterOutcome,
    averageTerritoryDiffDelta: pairs.size ? round(territoryDelta / pairs.size) : 0,
  }
}

async function runAdaptivePilotGame(
  item: AdaptivePilotScheduleItem,
): Promise<{ result: AdaptivePilotGameResult; logs: AdaptiveDecisionLog[] }> {
  let state = makeInitialState()
  let decisions = 0
  let subjectDecisionIndex = 0
  let opponentDecisionIndex = 0
  let allSubjectActionsLegal = true
  const logs: AdaptiveDecisionLog[] = []
  const heuristicRng = createSeededRngQ4(item.opponentBaseSeed)

  while (state.phase !== 'finished' && !state.result && decisions < ADAPTIVE_PILOT_MAX_DECISIONS) {
    const snapshot = snapshotFromState(state)
    const legalActions = getLegalActions(snapshot)
    if (!legalActions.length) break
    let action: PlayerAction
    if (snapshot.turn === item.subjectColor) {
      const config = subjectConfig(item.variant, legalActions.length)
      const decisionSeed = getPlayableDecisionSeed(item.subjectBaseSeed, subjectDecisionIndex)
      const startedAt = performance.now()
      action = choosePlayableMCTSAction({
        gameState: snapshot,
        config,
        seed: decisionSeed,
      })
      const decisionMs = performance.now() - startedAt
      allSubjectActionsLegal &&= legalActions.some((legal) => sameAction(legal, action))
      logs.push({
        gameId: item.gameId,
        pairId: item.pairId,
        variant: item.variant,
        rival: item.rival,
        subjectColor: item.subjectColor,
        decisionIndex: subjectDecisionIndex,
        decisionSeed,
        legalActionCount: legalActions.length,
        simulations: config.simulations,
        decisionMs: round(decisionMs),
        action: JSON.stringify(action),
      })
      subjectDecisionIndex++
    } else if (item.rival === 'baseline-mcts') {
      action = choosePlayableMCTSAction({
        gameState: snapshot,
        config: PLAYABLE_MCTS_BASELINE_CONFIG,
        seed: getPlayableDecisionSeed(item.opponentBaseSeed, opponentDecisionIndex++),
      })
    } else {
      action = chooseHeuristicOpponentActionQ4(snapshot, heuristicRng)
    }
    state = applyFullAction(state, action).state
    decisions++
  }

  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const subjectTerritory = territory[item.subjectColor]
  const opponentTerritory = territory[opponent(item.subjectColor)]
  const winner: Player | 'tie' = state.result?.tie
    ? 'tie'
    : (state.result?.winner ??
      (territory.R === territory.B ? 'tie' : territory.R > territory.B ? 'R' : 'B'))
  const outcome = winner === 'tie' ? 'tie' : winner === item.subjectColor ? 'win' : 'loss'
  const times = logs.map((log) => log.decisionMs)
  return {
    result: {
      ...item,
      winner,
      outcome,
      territorySubject: subjectTerritory,
      territoryOpponent: opponentTerritory,
      territoryDiff: subjectTerritory - opponentTerritory,
      decisions,
      subjectDecisions: logs.length,
      averageDecisionMs: times.length
        ? round(times.reduce((sum, time) => sum + time, 0) / times.length)
        : 0,
      p50DecisionMs: percentile(times, 0.5),
      p95DecisionMs: percentile(times, 0.95),
      allSubjectActionsLegal,
    },
    logs,
  }
}

function csv(rows: readonly Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const columns = Object.keys(rows[0]!)
  const cell = (value: unknown) => {
    const text = String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => cell(row[column])).join(',')),
  ].join('\n')
}

function gitValue(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export async function evaluateAdaptiveBudgetPilot(
  options: {
    pairsPerRival?: number
    outputDir?: string
    overwrite?: boolean
    progressEvery?: number
  } = {},
) {
  const schedule = buildAdaptivePilotSchedule(
    options.pairsPerRival ?? ADAPTIVE_PILOT_PAIRS_PER_RIVAL,
  )
  const outputDir = path.resolve(options.outputDir ?? ADAPTIVE_PILOT_OUTPUT_DIR)
  if (existsSync(outputDir) && readdirSync(outputDir).length && !options.overwrite) {
    throw new Error(`Output directory already exists and is not empty: ${outputDir}`)
  }
  mkdirSync(outputDir, { recursive: true })
  const results: AdaptivePilotGameResult[] = []
  const logs: AdaptiveDecisionLog[] = []
  for (let index = 0; index < schedule.length; index++) {
    const game = await runAdaptivePilotGame(schedule[index]!)
    results.push(game.result)
    logs.push(...game.logs)
    if (options.progressEvery && (index + 1) % options.progressEvery === 0) {
      console.log(`[adaptive-budget-v1] ${index + 1}/${schedule.length}`)
    }
  }
  const variants = Object.fromEntries(
    (['playable-baseline', 'adaptive-budget-v1'] as const).map((variant) => [
      variant,
      {
        overall: aggregateAdaptivePilot(
          results.filter((result) => result.variant === variant),
          logs.filter((log) => log.variant === variant),
        ),
        byRival: Object.fromEntries(
          (['heuristic', 'baseline-mcts'] as const).map((rival) => [
            rival,
            aggregateAdaptivePilot(
              results.filter((result) => result.variant === variant && result.rival === rival),
              logs.filter((log) => log.variant === variant && log.rival === rival),
            ),
          ]),
        ),
      },
    ]),
  )
  const summary = {
    version: ADAPTIVE_BUDGET_VERSION,
    games: results.length,
    pairedProtocol:
      'Each pairId repeats color, scenario seed, subject seed and opponent seed across variants.',
    variants,
    pairedComparison: {
      overall: compareAdaptivePairs(results),
      byRival: Object.fromEntries(
        (['heuristic', 'baseline-mcts'] as const).map((rival) => [
          rival,
          compareAdaptivePairs(results.filter((result) => result.rival === rival)),
        ]),
      ),
    },
  }
  writeFileSync(
    path.join(outputDir, 'adaptive_budget_v1_results.csv'),
    `${csv(results as unknown as Record<string, unknown>[])}\n`,
    'utf8',
  )
  writeFileSync(
    path.join(outputDir, 'adaptive_budget_v1_decisions.csv'),
    `${csv(logs as unknown as Record<string, unknown>[])}\n`,
    'utf8',
  )
  writeFileSync(
    path.join(outputDir, 'adaptive_budget_v1_summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    path.join(outputDir, 'metadata.json'),
    `${JSON.stringify(
      {
        commit: gitValue('rev-parse', 'HEAD'),
        branch: gitValue('branch', '--show-current'),
        createdAt: new Date().toISOString(),
        version: ADAPTIVE_BUDGET_VERSION,
        finalConfigUnchanged: FINAL_MCTS_CONFIG,
        adaptiveThresholds: [
          { maxLegalActions: 30, simulations: 50 },
          { maxLegalActions: 70, simulations: 100 },
          { maxLegalActions: 110, simulations: 150 },
          { maxLegalActions: null, simulations: 200 },
        ],
        scheduleGames: schedule.length,
        masterSeed: ADAPTIVE_PILOT_SEED,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return { results, logs, summary, outputDir }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const allowed = new Set(['--smoke', '--overwrite'])
  const unsupported = [...args].filter((arg) => !allowed.has(arg))
  if (unsupported.length) throw new Error(`Unsupported arguments: ${unsupported.join(', ')}`)
  const smoke = args.has('--smoke')
  const evaluation = await evaluateAdaptiveBudgetPilot({
    pairsPerRival: smoke ? 1 : ADAPTIVE_PILOT_PAIRS_PER_RIVAL,
    outputDir: smoke ? `${ADAPTIVE_PILOT_OUTPUT_DIR}_smoke` : ADAPTIVE_PILOT_OUTPUT_DIR,
    overwrite: smoke || args.has('--overwrite'),
    progressEvery: smoke ? 1 : 4,
  })
  console.log(JSON.stringify(evaluation.summary, null, 2))
  console.log(`[adaptive-budget-v1] output: ${evaluation.outputDir}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main()
}
