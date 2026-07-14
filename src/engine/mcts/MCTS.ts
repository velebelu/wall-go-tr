import { evaluatePosition } from '@/engine/evaluatePosition'
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
} from './types'

// Keeps ordinary strategic evaluations useful without allowing them to exceed terminal rewards.
export const POSITION_EVALUATION_SCALE = 100
export const DEFAULT_HEURISTIC_PROBABILITY = 0.8

export function searchBestAction(
  state: GameSnapshot,
  perspective: Player,
  config: MCTSConfig = DEFAULT_MCTS_CONFIG,
  rng?: () => number,
): MCTSResult {
  validateConfig(config)
  const random = rng ?? Math.random
  const root = new MCTSNode(state, undefined, undefined, {
    expansionPolicy: config.expansionPolicy ?? 'unordered',
    progressiveWidening: config.progressiveWidening ?? false,
    wideningConstant: config.wideningConstant ?? DEFAULT_WIDENING_CONSTANT,
    wideningExponent: config.wideningExponent ?? DEFAULT_WIDENING_EXPONENT,
    rng: random,
  })
  if (root.isTerminal) throw new Error('Cannot search from a terminal state')
  if (root.untriedActions.length === 0) throw new Error('Cannot search a state without legal actions')
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
  return {
    action: best.action!,
    visits: best.visits,
    value: best.meanValue,
    rootVisits: root.visits,
    children,
    rootLegalActions,
    rootExpandedChildren: root.children.length,
    maxDepthReached,
    averageSelectedDepth: totalSelectedDepth / config.simulations,
  }
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
  let candidates = children.filter(
    (child) => child.visits === Math.max(...children.map((candidate) => candidate.visits)),
  )
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
  if (!['unordered', 'heuristic'].includes(expansionPolicy)) {
    throw new Error('expansionPolicy must be unordered or heuristic')
  }
  const wideningConstant = config.wideningConstant ?? DEFAULT_WIDENING_CONSTANT
  if (!Number.isFinite(wideningConstant) || wideningConstant <= 0) {
    throw new Error('wideningConstant must be a finite positive number')
  }
  const wideningExponent = config.wideningExponent ?? DEFAULT_WIDENING_EXPONENT
  if (!Number.isFinite(wideningExponent) || wideningExponent <= 0 || wideningExponent > 1) {
    throw new Error('wideningExponent must be between zero and one')
  }
}

export type { MCTSConfig, MCTSResult } from './types'
export { DEFAULT_MCTS_CONFIG } from './types'
