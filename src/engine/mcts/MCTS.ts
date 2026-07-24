import { evaluatePosition } from '@/engine/evaluatePosition'
import { immediateTerritorialClosureThreat } from '@/engine/immediateTerritorialClosureThreat'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player } from '@/lib/types'
import { getBestHeuristicAction, getBestPlacement, getLegalActions } from '@/utils/ai'
import { MCTSNode } from './MCTSNode'
import {
  DEFAULT_MCTS_CONFIG,
  DEFAULT_WIDENING_CONSTANT,
  DEFAULT_WIDENING_EXPONENT,
  type MCTSChildResult,
  type MCTSConfig,
  type MCTSResult,
  type MCTSQPriorSource,
} from './types'

// Keeps ordinary strategic evaluations useful without allowing them to exceed terminal rewards.
export const POSITION_EVALUATION_SCALE = 100
export const DEFAULT_HEURISTIC_PROBABILITY = 0.8

export function searchBestAction(
  state: GameSnapshot,
  perspective: Player,
  config: MCTSConfig = DEFAULT_MCTS_CONFIG,
  rng?: () => number,
  qPriorSource?: MCTSQPriorSource,
): MCTSResult {
  validateConfig(config)
  const random = rng ?? Math.random
  const root = new MCTSNode(state, undefined, undefined, {
    expansionPolicy: config.expansionPolicy ?? 'unordered',
    progressiveWidening: config.progressiveWidening ?? false,
    wideningConstant: config.wideningConstant ?? DEFAULT_WIDENING_CONSTANT,
    wideningExponent: config.wideningExponent ?? DEFAULT_WIDENING_EXPONENT,
    rng: random,
    qPriorWeight: config.qPriorWeight ?? 0,
    qPriorSource,
  })
  if (root.isTerminal) throw new Error('Cannot search from a terminal state')
  if (root.untriedActions.length === 0)
    throw new Error('Cannot search a state without legal actions')
  const rootLegalActions = root.untriedActions.length
  let maxDepthReached = 0
  let totalSelectedDepth = 0

  for (let simulation = 0; simulation < config.simulations; simulation++) {
    let node = root
    let depth = 0

    let selectedDepth = 0

    // Selection follows UCT while expansion is unavailable at the current node.
    while (!node.isTerminal && depth < config.maxDepth) {
      if (node.canExpand) {
        // Expansion adds the next allowed untried legal action.
        node = node.expand(random)!
        depth++
        break
      }
      if (node.children.length === 0) break
      const maximizeRootValue = node.state.turn === perspective
      node = node.selectChild(config.explorationConstant, maximizeRootValue, random)
      depth++
      selectedDepth++
    }
    totalSelectedDepth += selectedDepth
    maxDepthReached = Math.max(maxDepthReached, depth)

    // Simulation uses uniformly sampled legal full actions up to the depth limit.
    const value = simulate(node.state, perspective, depth, config, random)

    // Backpropagation stores every value from the unchanged root perspective.
    for (let current: MCTSNode | undefined = node; current; current = current.parent) {
      current.visits++
      current.valueSum += value
    }
  }

  const best = chooseFinalChild(root.children, random)
  const children = root.children.map(toChildResult)
  const verification = config.tacticalVerification
    ? verifyTacticalCandidates(
        state,
        perspective,
        children,
        best.action!,
        config.tacticalCandidateCount ?? 3,
        random,
        config,
      )
    : undefined
  const selectedAction = verification?.action ?? best.action!
  const selectedChild =
    root.children.find(
      (child) => JSON.stringify(child.action) === JSON.stringify(selectedAction),
    ) ?? best
  const result: MCTSResult = {
    action: selectedAction,
    visits: selectedChild.visits,
    value: selectedChild.meanValue,
    rootVisits: root.visits,
    children,
    rootLegalActions,
    rootExpandedChildren: root.children.length,
    maxDepthReached,
    averageSelectedDepth: totalSelectedDepth / config.simulations,
    ...(verification && verification.metrics),
  }
  if (config.expansionPolicy === 'heuristic-q5') {
    const scores = root.expansionScores
    const selectedScore = root.getExpansionScore(selectedAction)
    result.qPriorKnownActions = scores.filter(({ qKnown }) => qKnown).length
    result.qPriorReliableActions = scores.filter(({ qReliable }) => qReliable).length
    result.qPriorSelectedActionKnown = selectedScore?.qKnown ?? false
    result.qPriorSelectedActionReliable = selectedScore?.qReliable ?? false
    // One search reports the selected root action's prior; evaluators average it across decisions.
    result.averageSelectedQPrior = selectedScore?.normalizedQ5Value ?? 0
  }
  return result
}

export interface TacticalCandidateEvaluation {
  action: MCTSChildResult['action']
  score: number
  permitsImmediateTerminalLoss: boolean
  closureThreatDetected?: boolean
  closureThreatPenalty?: number
  closureThreatWorstReply?: MCTSChildResult['action']
}

export function verifyTacticalCandidates(
  rootState: GameSnapshot,
  perspective: Player,
  children: readonly MCTSChildResult[],
  originalAction: MCTSChildResult['action'],
  requestedCount = 3,
  rng: () => number = Math.random,
  config: MCTSConfig = DEFAULT_MCTS_CONFIG,
): {
  action: MCTSChildResult['action']
  metrics: Pick<
    MCTSResult,
    | 'tacticalCandidatesChecked'
    | 'tacticalSelectionChanged'
    | 'originalMCTSActionScore'
    | 'verifiedActionScore'
    | 'worstOpponentReplyScore'
    | 'verificationTimeMs'
    | 'immediateTerminalLossAvoided'
    | 'closureThreatsDetected'
    | 'closureThreatPenalty'
    | 'closureThreatWorstReply'
  >
} {
  if (!Number.isInteger(requestedCount) || requestedCount <= 0) {
    throw new Error('tacticalCandidateCount must be a positive integer')
  }
  const started = performance.now()
  const candidates = [...children]
    .sort((a, b) => b.visits - a.visits || b.value - a.value)
    .slice(0, Math.min(requestedCount, children.length))
  if (!candidates.length) throw new Error('Tactical verification requires expanded children')
  const evaluated = candidates.map(({ action }) =>
    evaluateTacticalCandidate(rootState, perspective, action, config),
  )
  const selected = chooseBestTacticalEvaluation(evaluated, rng)
  const original = evaluated.find(({ action }) => sameAction(action, originalAction))
  return {
    action: selected.action,
    metrics: {
      tacticalCandidatesChecked: evaluated.length,
      tacticalSelectionChanged: !sameAction(selected.action, originalAction),
      originalMCTSActionScore: original?.score ?? Number.NaN,
      verifiedActionScore: selected.score,
      worstOpponentReplyScore: selected.score,
      verificationTimeMs: performance.now() - started,
      immediateTerminalLossAvoided:
        (original?.permitsImmediateTerminalLoss ?? false) && !selected.permitsImmediateTerminalLoss,
      closureThreatsDetected: evaluated.filter((candidate) => candidate.closureThreatDetected)
        .length,
      closureThreatPenalty: selected.closureThreatPenalty ?? 0,
      closureThreatWorstReply: selected.closureThreatWorstReply,
    },
  }
}

export function chooseBestTacticalEvaluation(
  evaluated: readonly TacticalCandidateEvaluation[],
  rng: () => number,
): TacticalCandidateEvaluation {
  if (!evaluated.length) throw new Error('Cannot select from empty tactical evaluations')
  const bestScore = Math.max(...evaluated.map(({ score }) => score))
  const tied = evaluated.filter(({ score }) => score === bestScore)
  return tied[randomIndex(tied.length, rng)]!
}

function evaluateTacticalCandidate(
  rootState: GameSnapshot,
  perspective: Player,
  action: MCTSChildResult['action'],
  config: MCTSConfig,
): TacticalCandidateEvaluation {
  const afterAction = applyFullAction(rootState, action).state
  const threatConfig = config.immediateTerritorialClosureThreat
  const threat = threatConfig
    ? immediateTerritorialClosureThreat(afterAction, perspective, threatConfig)
    : undefined
  const direct = terminalValue(afterAction, perspective)
  if (direct !== undefined) {
    return {
      action,
      score: evaluatePosition(afterAction, perspective) - (threat?.penalty ?? 0),
      permitsImmediateTerminalLoss: direct < 0,
      closureThreatDetected: threat?.detected,
      closureThreatPenalty: threat?.penalty,
      closureThreatWorstReply: threat?.worstReply,
    }
  }
  const replies = getLegalActions(afterAction)
  if (!replies.length) {
    return {
      action,
      score: evaluatePosition(afterAction, perspective) - (threat?.penalty ?? 0),
      permitsImmediateTerminalLoss: false,
      closureThreatDetected: threat?.detected,
      closureThreatPenalty: threat?.penalty,
      closureThreatWorstReply: threat?.worstReply,
    }
  }
  let score = Infinity
  let permitsImmediateTerminalLoss = false
  for (const reply of replies) {
    const replied = applyFullAction(afterAction, reply).state
    const replyScore = evaluatePosition(replied, perspective)
    if (terminalValue(replied, perspective) === -1) permitsImmediateTerminalLoss = true
    score = Math.min(score, replyScore)
  }
  return {
    action,
    score: score - (threat?.penalty ?? 0),
    permitsImmediateTerminalLoss,
    closureThreatDetected: threat?.detected,
    closureThreatPenalty: threat?.penalty,
    closureThreatWorstReply: threat?.worstReply,
  }
}

function sameAction(a: MCTSChildResult['action'], b: MCTSChildResult['action']): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function simulate(
  initialState: GameSnapshot,
  perspective: Player,
  initialDepth: number,
  config: MCTSConfig,
  rng: () => number,
): number {
  let state = initialState
  let depth = initialDepth

  while (!isTerminalState(state) && depth < config.maxDepth) {
    const actions = getLegalActions(state)
    if (actions.length === 0) break
    state = applyFullAction(state, chooseRolloutAction(state, actions, config, rng)).state
    depth++
  }

  const terminal = terminalValue(state, perspective)
  if (terminal !== undefined) return terminal
  return Math.tanh(evaluatePosition(state, perspective) / POSITION_EVALUATION_SCALE)
}

function chooseRolloutAction(
  state: GameSnapshot,
  legalActions: ReturnType<typeof getLegalActions>,
  config: MCTSConfig,
  rng: () => number,
) {
  if (config.rolloutPolicy === 'random') {
    return legalActions[randomIndex(legalActions.length, rng)]
  }

  const probability = config.heuristicProbability ?? DEFAULT_HEURISTIC_PROBABILITY
  const useHeuristic =
    config.rolloutPolicy === 'heuristic' ||
    probability === 1 ||
    (probability > 0 && rng() < probability)
  if (!useHeuristic) return legalActions[randomIndex(legalActions.length, rng)]

  const heuristicAction = withSeededMathRandom(rng, () =>
    state.phase === 'placing' ? getBestPlacement(state) : getBestHeuristicAction(state),
  )
  return heuristicAction ?? legalActions[randomIndex(legalActions.length, rng)]
}

function withSeededMathRandom<T>(rng: () => number, fn: () => T): T {
  const previous = Math.random
  Math.random = rng
  try {
    return fn()
  } finally {
    Math.random = previous
  }
}

function terminalValue(state: GameSnapshot, perspective: Player): number | undefined {
  if (!isTerminalState(state)) return undefined
  if (state.result?.tie || !state.result?.winner) return 0
  return state.result.winner === perspective ? 1 : -1
}

function isTerminalState(state: GameSnapshot): boolean {
  return state.phase === 'finished' || state.result?.finished === true
}

function chooseFinalChild(children: MCTSNode[], rng: () => number): MCTSNode {
  if (children.length === 0) throw new Error('Search completed without expanding a root action')
  const maxVisits = Math.max(...children.map((candidate) => candidate.visits))
  let candidates = children.filter((child) => child.visits === maxVisits)
  const bestValue = Math.max(...candidates.map((child) => child.meanValue))
  candidates = candidates.filter((child) => child.meanValue === bestValue)
  return candidates[randomIndex(candidates.length, rng)]
}

function toChildResult(node: MCTSNode): MCTSChildResult {
  return {
    action: node.action!,
    visits: node.visits,
    value: node.meanValue,
  }
}

function randomIndex(length: number, rng: () => number): number {
  if (length <= 0) throw new Error('Cannot choose from an empty collection')
  const sample = rng()
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error('rng must return a finite number between 0 and 1')
  }
  return Math.min(length - 1, Math.floor(sample * length))
}

function validateConfig(config: MCTSConfig): void {
  if (!Number.isInteger(config.simulations) || config.simulations <= 0) {
    throw new Error('simulations must be a positive integer')
  }
  if (!Number.isFinite(config.explorationConstant) || config.explorationConstant < 0) {
    throw new Error('explorationConstant must be a finite non-negative number')
  }
  if (!Number.isInteger(config.maxDepth) || config.maxDepth <= 0) {
    throw new Error('maxDepth must be a positive integer')
  }
  if (!['random', 'mixed', 'heuristic'].includes(config.rolloutPolicy)) {
    throw new Error('rolloutPolicy must be random, mixed, or heuristic')
  }
  const probability = config.heuristicProbability ?? DEFAULT_HEURISTIC_PROBABILITY
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('heuristicProbability must be between 0 and 1')
  }
  const expansionPolicy = config.expansionPolicy ?? 'unordered'
  if (!['unordered', 'heuristic', 'heuristic-q5'].includes(expansionPolicy)) {
    throw new Error('expansionPolicy must be unordered, heuristic, or heuristic-q5')
  }
  const qPriorWeight = config.qPriorWeight ?? 0
  if (!Number.isFinite(qPriorWeight) || qPriorWeight < 0) {
    throw new Error('qPriorWeight must be a finite non-negative number')
  }
  const wideningConstant = config.wideningConstant ?? DEFAULT_WIDENING_CONSTANT
  if (!Number.isFinite(wideningConstant) || wideningConstant <= 0) {
    throw new Error('wideningConstant must be a finite positive number')
  }
  const wideningExponent = config.wideningExponent ?? DEFAULT_WIDENING_EXPONENT
  if (!Number.isFinite(wideningExponent) || wideningExponent <= 0 || wideningExponent > 1) {
    throw new Error('wideningExponent must be between zero and one')
  }
  const tacticalCandidateCount = config.tacticalCandidateCount ?? 3
  if (!Number.isInteger(tacticalCandidateCount) || tacticalCandidateCount <= 0) {
    throw new Error('tacticalCandidateCount must be a positive integer')
  }
  const threat = config.immediateTerritorialClosureThreat
  if (threat) {
    if (!Number.isFinite(threat.weight) || threat.weight < 0) {
      throw new Error('immediateTerritorialClosureThreat.weight must be non-negative')
    }
    if (!Number.isFinite(threat.minimumTerritoryDrop) || threat.minimumTerritoryDrop < 0) {
      throw new Error('immediateTerritorialClosureThreat.minimumTerritoryDrop must be non-negative')
    }
    if (!Number.isFinite(threat.minimumAccessibleDrop) || threat.minimumAccessibleDrop < 0) {
      throw new Error(
        'immediateTerritorialClosureThreat.minimumAccessibleDrop must be non-negative',
      )
    }
  }
}

export type { MCTSConfig, MCTSResult } from './types'
export { DEFAULT_MCTS_CONFIG } from './types'
