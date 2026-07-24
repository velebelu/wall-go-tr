import { calculatePlayerMobilityQ3 } from '@/agents/learningPolicyQ3'
import { createPlayableMCTSRng } from '@/agents/mctsWorkerDecision'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import { evaluatePosition } from '@/engine/evaluatePosition'
import { applyFullAction } from '@/engine/gameSimulator'
import { searchBestActionStaged, type MCTSStageDecision } from '@/engine/mcts/MCTS'
import type { MCTSConfig, MCTSResult } from '@/engine/mcts/types'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'
import { floodRegions } from '@/utils/region'
import { getTerritoryCounts } from '@/training/compareLearningAgents'

export interface HumanChallengeConfig {
  mcts: Readonly<MCTSConfig>
  budget: {
    enable750: boolean
    base: number
    lowConfidence: number
    highUncertainty: number
    maxDecisionMs: number
    maxVisitGap: number
    maxValueGap: number
    maxSelectedVisitShare: number
    highUncertaintyVisitGap: number
    highUncertaintyValueGap: number
    highUncertaintySelectedVisitShare: number
  }
  endgame: {
    enabled: boolean
    maxLegalActions: number
    maxConnectedRegions: number
    maxMobilePieces: number
    maxDepth: number
    maxNodes: number
    maxTimeMs: number
  }
}

export const FINAL_HUMAN_CHALLENGE_MCTS_CONFIG: Readonly<HumanChallengeConfig> = Object.freeze({
  mcts: Object.freeze({ ...FINAL_MCTS_CONFIG, simulations: 250, qPriorWeight: 0 }),
  budget: Object.freeze({
    enable750: true,
    base: 250,
    lowConfidence: 500,
    highUncertainty: 750,
    maxDecisionMs: 5_000,
    maxVisitGap: 3,
    maxValueGap: 0.04,
    maxSelectedVisitShare: 0.12,
    highUncertaintyVisitGap: 1,
    highUncertaintyValueGap: 0.015,
    highUncertaintySelectedVisitShare: 0.08,
  }),
  endgame: Object.freeze({
    enabled: true,
    maxLegalActions: 8,
    maxConnectedRegions: 3,
    maxMobilePieces: 2,
    maxDepth: 8,
    maxNodes: 40_000,
    maxTimeMs: 1_500,
  }),
})

export const MODERATE_HUMAN_CHALLENGE_MCTS_CONFIG: Readonly<HumanChallengeConfig> = Object.freeze({
  ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
  budget: Object.freeze({ ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.budget, enable750: false }),
})

export const FINAL_HUMAN_CHALLENGE_MCTS_CONFIG_CANDIDATE = MODERATE_HUMAN_CHALLENGE_MCTS_CONFIG

export interface ConfidenceMetrics {
  visitGap: number
  valueGap: number
  selectedVisitShare: number
  lowConfidence: boolean
  highUncertainty: boolean
  lowConfidenceSignals: number
  highUncertaintySignals: number
}

export function measureHumanChallengeConfidence(
  result: MCTSResult,
  config = FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.budget,
): ConfidenceMetrics {
  const ranked = [...result.children].sort(
    (left, right) => right.visits - left.visits || right.value - left.value,
  )
  const first = ranked[0]
  const second = ranked[1]
  const visitGap = first && second ? first.visits - second.visits : result.rootVisits
  const valueGap = first && second ? Math.abs(first.value - second.value) : 1
  const selectedVisitShare = result.rootVisits ? result.visits / result.rootVisits : 0
  const lowConfidenceSignals =
    Number(visitGap <= config.maxVisitGap) +
    Number(valueGap <= config.maxValueGap) +
    Number(selectedVisitShare <= config.maxSelectedVisitShare)
  const highUncertaintySignals =
    Number(visitGap <= config.highUncertaintyVisitGap) +
    Number(valueGap <= config.highUncertaintyValueGap) +
    Number(selectedVisitShare <= config.highUncertaintySelectedVisitShare)
  return {
    visitGap,
    valueGap,
    selectedVisitShare,
    lowConfidenceSignals,
    highUncertaintySignals,
    lowConfidence: lowConfidenceSignals >= 2,
    highUncertainty: highUncertaintySignals >= 2,
  }
}

export function detectSmallEndgame(
  state: GameSnapshot,
  config = FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.endgame,
) {
  const legalActions = getLegalActions(state).length
  const connectedRegions = floodRegions(state.board).length
  const mobilePieces = state.players.reduce(
    (sum, player) => sum + Math.max(0, 2 - calculatePlayerMobilityQ3(state, player).trapPieces),
    0,
  )
  return {
    legalActions,
    connectedRegions,
    mobilePieces,
    active:
      config.enabled &&
      legalActions <= config.maxLegalActions &&
      connectedRegions <= config.maxConnectedRegions &&
      mobilePieces <= config.maxMobilePieces,
  }
}

interface SolverResult {
  action?: PlayerAction
  completed: boolean
  nodes: number
  elapsedMs: number
  score?: number
}

export function solveSmallEndgame(
  state: GameSnapshot,
  perspective: Player,
  config = FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.endgame,
  now: () => number = () => performance.now(),
): SolverResult {
  const startedAt = now()
  let nodes = 0
  let aborted = false
  const terminalScore = (snapshot: GameSnapshot): number => {
    const territory = snapshot.result?.score ?? getTerritoryCounts(snapshot.board)
    return territory[perspective] - territory[perspective === 'R' ? 'B' : 'R']
  }
  const search = (snapshot: GameSnapshot, depth: number, alpha: number, beta: number): number => {
    if (++nodes > config.maxNodes || now() - startedAt >= config.maxTimeMs) {
      aborted = true
      return evaluatePosition(snapshot, perspective)
    }
    if (snapshot.phase === 'finished' || snapshot.result) return terminalScore(snapshot)
    if (depth === 0) {
      aborted = true
      return evaluatePosition(snapshot, perspective)
    }
    const maximizing = snapshot.turn === perspective
    let best = maximizing ? -Infinity : Infinity
    for (const action of getLegalActions(snapshot)) {
      const score = search(applyFullAction(snapshot, action).state, depth - 1, alpha, beta)
      best = maximizing ? Math.max(best, score) : Math.min(best, score)
      if (maximizing) alpha = Math.max(alpha, best)
      else beta = Math.min(beta, best)
      if (beta <= alpha || aborted) break
    }
    return best
  }
  let bestAction: PlayerAction | undefined
  let bestScore = -Infinity
  for (const action of getLegalActions(state)) {
    const score = search(
      applyFullAction(state, action).state,
      config.maxDepth - 1,
      -Infinity,
      Infinity,
    )
    if (aborted) break
    if (score > bestScore) {
      bestScore = score
      bestAction = action
    }
  }
  return {
    action: aborted ? undefined : bestAction,
    completed: !aborted && bestAction !== undefined,
    nodes,
    elapsedMs: now() - startedAt,
    score: aborted ? undefined : bestScore,
  }
}

export interface HumanChallengeDecision {
  action: PlayerAction
  mcts: MCTSResult
  simulations: number
  expandedTo500: boolean
  expandedTo750: boolean
  stoppedByTimeLimit: boolean
  decisionMs: number
  confidence: ConfidenceMetrics
  tacticalChanged: boolean
  endgameDetected: boolean
  endgameSolverActivated: boolean
  endgameSolverCompleted: boolean
  endgameNodes: number
  endgameMs: number
  endgameChangedAction: boolean
}

export function chooseHumanChallengeMCTSDecision(params: {
  gameState: GameSnapshot
  seed: number
  config?: Readonly<HumanChallengeConfig>
  endgameEnabled?: boolean
  now?: () => number
}): HumanChallengeDecision {
  const config = params.config ?? FINAL_HUMAN_CHALLENGE_MCTS_CONFIG
  const now = params.now ?? (() => performance.now())
  const startedAt = now()
  let latestConfidence!: ConfidenceMetrics
  const staged = searchBestActionStaged(
    params.gameState,
    params.gameState.turn,
    config.mcts,
    {
      simulationTargets: config.budget.enable750
        ? [config.budget.base, config.budget.lowConfidence, config.budget.highUncertainty]
        : [config.budget.base, config.budget.lowConfidence],
      timeLimitMs: config.budget.maxDecisionMs,
      now,
      shouldContinue: (result, stageIndex): MCTSStageDecision => {
        latestConfidence = measureHumanChallengeConfidence(result, config.budget)
        if (stageIndex === 0)
          return {
            continueSearch: latestConfidence.lowConfidence,
            reason: latestConfidence.lowConfidence ? 'low-confidence' : 'confident',
          }
        const terminalThreat = result.immediateTerminalLossAvoided === true
        const changedAndMinimal =
          result.tacticalSelectionChanged === true && latestConfidence.highUncertainty
        return {
          continueSearch: latestConfidence.highUncertainty || terminalThreat || changedAndMinimal,
          reason: terminalThreat
            ? 'terminal-threat'
            : changedAndMinimal
              ? 'tactical-minimal-gap'
              : latestConfidence.highUncertainty
                ? 'high-uncertainty'
                : 'resolved',
        }
      },
    },
    createPlayableMCTSRng(params.seed),
  )
  latestConfidence = measureHumanChallengeConfidence(staged.result, config.budget)
  const detection = detectSmallEndgame(params.gameState, {
    ...config.endgame,
    enabled: params.endgameEnabled ?? config.endgame.enabled,
  })
  const solver = detection.active
    ? solveSmallEndgame(params.gameState, params.gameState.turn, config.endgame, now)
    : { completed: false, nodes: 0, elapsedMs: 0 }
  const action = solver.completed && solver.action ? solver.action : staged.result.action
  return {
    action,
    mcts: staged.result,
    simulations: staged.result.rootVisits,
    expandedTo500: staged.completedTargets.includes(500),
    expandedTo750: staged.completedTargets.includes(750),
    stoppedByTimeLimit: staged.stoppedByTimeLimit,
    decisionMs: now() - startedAt,
    confidence: latestConfidence,
    tacticalChanged: staged.result.tacticalSelectionChanged === true,
    endgameDetected: detection.active,
    endgameSolverActivated: detection.active,
    endgameSolverCompleted: solver.completed,
    endgameNodes: solver.nodes,
    endgameMs: solver.elapsedMs,
    endgameChangedAction:
      solver.completed &&
      solver.action !== undefined &&
      JSON.stringify(solver.action) !== JSON.stringify(staged.result.action),
  }
}
