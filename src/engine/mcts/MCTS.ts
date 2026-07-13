import { evaluatePosition } from '@/engine/evaluatePosition'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'
import { MCTSNode } from './MCTSNode'
import {
  DEFAULT_MCTS_CONFIG,
  type MCTSChildResult,
  type MCTSConfig,
  type MCTSResult,
} from './types'

// Keeps ordinary strategic evaluations useful without allowing them to exceed terminal rewards.
export const POSITION_EVALUATION_SCALE = 100

export function searchBestAction(
  state: GameSnapshot,
  perspective: Player,
  config: MCTSConfig = DEFAULT_MCTS_CONFIG,
  rng?: () => number,
): MCTSResult {
  validateConfig(config)
  const random = rng ?? Math.random
  const root = new MCTSNode(state)
  if (root.isTerminal) throw new Error('Cannot search from a terminal state')
  if (root.untriedActions.length === 0) throw new Error('Cannot search a state without legal actions')

  for (let simulation = 0; simulation < config.simulations; simulation++) {
    let node = root
    let depth = 0

    // Selection follows UCT while the current node is fully expanded.
    while (
      !node.isTerminal &&
      depth < config.maxDepth &&
      node.untriedActions.length === 0 &&
      node.children.length > 0
    ) {
      const maximizeRootValue = node.state.turn === perspective
      node = node.selectChild(config.explorationConstant, maximizeRootValue, random)
      depth++
    }

    // Expansion adds one previously untried legal action.
    if (!node.isTerminal && depth < config.maxDepth && node.untriedActions.length > 0) {
      node = node.expand(random)!
      depth++
    }

    // Simulation uses uniformly sampled legal full actions up to the depth limit.
    const value = simulate(node.state, perspective, depth, config.maxDepth, random)

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
  }
}

function simulate(
  initialState: GameSnapshot,
  perspective: Player,
  initialDepth: number,
  maxDepth: number,
  rng: () => number,
): number {
  let state = initialState
  let depth = initialDepth

  while (!isTerminalState(state) && depth < maxDepth) {
    const actions = getLegalActions(state)
    if (actions.length === 0) break
    state = applyFullAction(state, actions[randomIndex(actions.length, rng)]).state
    depth++
  }

  const terminal = terminalValue(state, perspective)
  if (terminal !== undefined) return terminal
  return Math.tanh(evaluatePosition(state, perspective) / POSITION_EVALUATION_SCALE)
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
}

export type { MCTSConfig, MCTSResult } from './types'
export { DEFAULT_MCTS_CONFIG } from './types'
