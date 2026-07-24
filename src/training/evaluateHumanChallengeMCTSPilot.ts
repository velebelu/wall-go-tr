import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { choosePlayableMCTSDecision } from '@/agents/mctsWorkerDecision'
import {
  chooseHumanChallengeMCTSDecision,
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
  MODERATE_HUMAN_CHALLENGE_MCTS_CONFIG,
} from '@/agents/humanChallengeMCTS'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import { applyFullAction } from '@/engine/gameSimulator'
import type { Player, PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { getTerritoryCounts } from './compareLearningAgents'
import { wilson95 } from './evaluateMCTSTacticalConfirmation'
import {
  chooseHeuristicOpponentActionQ4,
  chooseRandomActionWithRngQ4,
  createSeededRngQ4,
} from './trainLearningAgentQ4'

type Variant = 'current' | 'moderate' | 'selective'
type Rival = 'heuristic' | 'current-mcts' | 'random'
const VARIANTS: readonly Variant[] = ['current', 'moderate', 'selective']
const RIVALS: readonly Rival[] = ['heuristic', 'current-mcts', 'random']
export const HUMAN_CHALLENGE_PILOT_OUTPUT =
  'data/entrenamiento/mcts/evaluacion_human_challenge_pilot'

function percentile(values: number[], p: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!
}
function round(value: number) {
  return Number(value.toFixed(4))
}
function other(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

export async function evaluateHumanChallengePilot(
  options: {
    outputDir?: string
    maxDecisions?: number
    now?: () => number
  } = {},
) {
  const maxDecisions = options.maxDecisions ?? 250
  const results: Record<string, unknown>[] = []
  const logs: Record<string, unknown>[] = []
  const startedAt = performance.now()
  for (let rivalIndex = 0; rivalIndex < RIVALS.length; rivalIndex++) {
    const rival = RIVALS[rivalIndex]!
    if (rival === 'random') continue
    for (let gameIndex = 0; gameIndex < 10; gameIndex++) {
      const subjectColor: Player = gameIndex % 2 ? 'B' : 'R'
      for (const variant of VARIANTS) {
        const seed = 1_720_000 + rivalIndex * 100 + gameIndex
        let state = makeInitialState()
        let decisions = 0
        let subjectIndex = 0
        let opponentIndex = 0
        const rivalRng = createSeededRngQ4(seed + 99_999)
        const decisionTimes: number[] = []
        while (state.phase !== 'finished' && !state.result && decisions < maxDecisions) {
          const legal = getLegalActions(state)
          if (!legal.length) break
          let action: PlayerAction
          if (state.turn === subjectColor) {
            const decisionSeed = seed + subjectIndex++
            const before = performance.now()
            if (variant === 'current') {
              const mcts = choosePlayableMCTSDecision({
                gameState: state,
                config: FINAL_MCTS_CONFIG,
                seed: decisionSeed,
              })
              action = mcts.action
              logs.push({
                variant,
                rival,
                decisionSeed,
                simulations: mcts.rootVisits,
                expanded500: false,
                expanded750: false,
                solverActivated: false,
                solverCompleted: false,
                actionChangedBySolver: false,
                tacticalChanged: mcts.tacticalSelectionChanged === true,
                nodes: 0,
                timeLimit: false,
              })
            } else {
              const decision = chooseHumanChallengeMCTSDecision({
                gameState: state,
                seed: decisionSeed,
                config:
                  variant === 'moderate'
                    ? MODERATE_HUMAN_CHALLENGE_MCTS_CONFIG
                    : FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
                endgameEnabled: false,
              })
              action = decision.action
              logs.push({
                variant,
                rival,
                decisionSeed,
                simulations: decision.simulations,
                expanded500: decision.expandedTo500,
                expanded750: decision.expandedTo750,
                solverActivated: decision.endgameSolverActivated,
                solverCompleted: decision.endgameSolverCompleted,
                actionChangedBySolver: decision.endgameChangedAction,
                tacticalChanged: decision.tacticalChanged,
                nodes: decision.endgameNodes,
                timeLimit: decision.stoppedByTimeLimit,
              })
            }
            const elapsed = performance.now() - before
            decisionTimes.push(elapsed)
            Object.assign(logs[logs.length - 1]!, { decisionMs: round(elapsed) })
          } else if (rival === 'current-mcts') {
            action = choosePlayableMCTSDecision({
              gameState: state,
              config: FINAL_MCTS_CONFIG,
              seed: seed + 50_000 + opponentIndex++,
            }).action
          } else if (rival === 'heuristic') {
            action = chooseHeuristicOpponentActionQ4(state, rivalRng)
          } else {
            action = chooseRandomActionWithRngQ4(legal, rivalRng)
          }
          state = applyFullAction(state, action).state
          decisions++
        }
        const territory = state.result?.score ?? getTerritoryCounts(state.board)
        const winner =
          state.result?.winner ??
          (territory.R === territory.B ? 'tie' : territory.R > territory.B ? 'R' : 'B')
        results.push({
          variant,
          rival,
          subjectColor,
          seed,
          outcome: winner === 'tie' ? 'tie' : winner === subjectColor ? 'win' : 'loss',
          territorySubject: territory[subjectColor],
          territoryOpponent: territory[other(subjectColor)],
          territoryDiff: territory[subjectColor] - territory[other(subjectColor)],
          decisions,
          reachedLimit: decisions >= maxDecisions,
          averageDecisionMs: round(
            decisionTimes.reduce((a, b) => a + b, 0) / Math.max(1, decisionTimes.length),
          ),
          maxDecisionMs: round(Math.max(0, ...decisionTimes)),
          p95DecisionMs: round(percentile(decisionTimes, 0.95)),
        })
        console.log(`[human-challenge-calibration] ${results.length}/60 ${variant} vs ${rival}`)
      }
    }
  }
  const summaryFor = (variant: Variant) => {
    const games = results.filter((row) => row.variant === variant)
    const variantLogs = logs.filter((row) => row.variant === variant)
    const wins = games.filter((row) => row.outcome === 'win').length
    const times = variantLogs.map((row) => Number(row.decisionMs))
    return {
      games: games.length,
      wins,
      losses: games.filter((row) => row.outcome === 'loss').length,
      ties: games.filter((row) => row.outcome === 'tie').length,
      winRate: round(wins / games.length),
      winRateCI95: wilson95(wins, games.length),
      averageTerritoryDiff: round(
        games.reduce((sum, row) => sum + Number(row.territoryDiff), 0) / games.length,
      ),
      averageDecisionMs: round(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length)),
      maxDecisionMs: round(Math.max(0, ...times)),
      p95DecisionMs: round(percentile(times, 0.95)),
      averageSimulations: round(
        variantLogs.reduce((sum, row) => sum + Number(row.simulations), 0) /
          Math.max(1, variantLogs.length),
      ),
      expansion500: variantLogs.filter((row) => row.expanded500).length,
      expansion750: variantLogs.filter((row) => row.expanded750).length,
      solverActivations: variantLogs.filter((row) => row.solverActivated).length,
      solverCompletions: variantLogs.filter((row) => row.solverCompleted).length,
      solverChanges: variantLogs.filter((row) => row.actionChangedBySolver).length,
      tacticalChanges: variantLogs.filter((row) => row.tacticalChanged).length,
      nodes: variantLogs.reduce((sum, row) => sum + Number(row.nodes), 0),
      timeLimitStops: variantLogs.filter((row) => row.timeLimit).length,
    }
  }
  const summary = {
    schema: 'HumanChallengeMCTSPilotV1',
    durationMs: round(performance.now() - startedAt),
    games: results.length,
    config: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
    variants: Object.fromEntries(VARIANTS.map((variant) => [variant, summaryFor(variant)])),
    note: 'Calibrated pilot; 10 paired games per variant/rival, five per color.',
  }
  const outputDir = path.resolve(options.outputDir ?? HUMAN_CHALLENGE_PILOT_OUTPUT)
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(path.join(outputDir, 'games.json'), `${JSON.stringify(results, null, 2)}\n`)
  writeFileSync(path.join(outputDir, 'decisions.json'), `${JSON.stringify(logs, null, 2)}\n`)
  return { summary, results, logs }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify((await evaluateHumanChallengePilot()).summary, null, 2))
