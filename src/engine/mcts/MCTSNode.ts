import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { getLegalActions, scoreHeuristicAction } from '@/utils/ai'
import {
  DEFAULT_WIDENING_CONSTANT,
  DEFAULT_WIDENING_EXPONENT,
  type MCTSConfig,
} from './types'

export interface MCTSNodeOptions {
  expansionPolicy: NonNullable<MCTSConfig['expansionPolicy']>
  progressiveWidening: boolean
  wideningConstant: number
  wideningExponent: number
  rng: () => number
}

const DEFAULT_NODE_OPTIONS: MCTSNodeOptions = {
  expansionPolicy: 'unordered',
  progressiveWidening: false,
  wideningConstant: DEFAULT_WIDENING_CONSTANT,
  wideningExponent: DEFAULT_WIDENING_EXPONENT,
  rng: Math.random,
}

export class MCTSNode {
  readonly children: MCTSNode[] = []
  readonly untriedActions: PlayerAction[]
  readonly state: GameSnapshot
  readonly parent?: MCTSNode
  readonly action?: PlayerAction
  private readonly options: MCTSNodeOptions
  private actionsOrdered: boolean
  visits = 0
  valueSum = 0

  constructor(
    state: GameSnapshot,
    parent?: MCTSNode,
    action?: PlayerAction,
    options: MCTSNodeOptions = DEFAULT_NODE_OPTIONS,
  ) {
    this.state = state
    this.parent = parent
    this.action = action
    this.options = options
    const legalActions = isTerminalState(state) ? [] : getLegalActions(state)
    this.untriedActions = legalActions
    this.actionsOrdered = options.expansionPolicy === 'unordered'
  }

  get meanValue(): number {
    return this.visits === 0 ? 0 : this.valueSum / this.visits
  }

  get isTerminal(): boolean {
    return isTerminalState(this.state)
  }

  get maxChildrenAllowed(): number {
    if (!this.options.progressiveWidening) {
      return this.children.length + this.untriedActions.length
    }
    return Math.max(
      1,
      Math.floor(
        this.options.wideningConstant * this.visits ** this.options.wideningExponent,
      ),
    )
  }

  get canExpand(): boolean {
    return (
      this.untriedActions.length > 0 && this.children.length < this.maxChildrenAllowed
    )
  }

  // Expansion consumes one legal action so the same child cannot be created twice.
  expand(rng: () => number): MCTSNode | undefined {
    if (!this.canExpand) return undefined
    if (!this.actionsOrdered) {
      const ordered = orderActionsForExpansion(
        this.state,
        this.untriedActions,
        this.options.expansionPolicy,
        this.options.rng,
      )
      this.untriedActions.splice(0, this.untriedActions.length, ...ordered)
      this.actionsOrdered = true
    }
    const index =
      this.options.expansionPolicy === 'heuristic'
        ? 0
        : randomIndex(this.untriedActions.length, rng)
    const [action] = this.untriedActions.splice(index, 1)
    const child = new MCTSNode(
      applyFullAction(this.state, action).state,
      this,
      action,
      this.options,
    )
    this.children.push(child)
    return child
  }

  // UCT = signed mean value + C * sqrt(ln(parent visits) / child visits).
  selectChild(
    explorationConstant: number,
    maximizeRootValue: boolean,
    rng: () => number,
  ): MCTSNode {
    if (this.children.length === 0) throw new Error('Cannot select a child from a leaf node')

    let bestScore = -Infinity
    const bestChildren: MCTSNode[] = []
    for (const child of this.children) {
      const exploitation = maximizeRootValue ? child.meanValue : -child.meanValue
      const exploration =
        child.visits === 0
          ? Infinity
          : explorationConstant * Math.sqrt(Math.log(Math.max(1, this.visits)) / child.visits)
      const score = exploitation + exploration
      if (score > bestScore) {
        bestScore = score
        bestChildren.length = 0
        bestChildren.push(child)
      } else if (score === bestScore) {
        bestChildren.push(child)
      }
    }
    return bestChildren[randomIndex(bestChildren.length, rng)]
  }
}

export function orderActionsForExpansion(
  state: GameSnapshot,
  actions: readonly PlayerAction[],
  policy: NonNullable<MCTSConfig['expansionPolicy']>,
  rng: () => number,
): PlayerAction[] {
  if (policy === 'unordered') return [...actions]

  const scored = actions.map((action) => ({
    action,
    score: scoreHeuristicAction(state, action, 'default'),
  }))
  scored.sort((left, right) => right.score - left.score)

  for (let start = 0; start < scored.length; ) {
    let end = start + 1
    while (end < scored.length && scored[end].score === scored[start].score) end++
    shuffleRange(scored, start, end, rng)
    start = end
  }
  return scored.map(({ action }) => action)
}

function shuffleRange<T>(items: T[], start: number, end: number, rng: () => number): void {
  for (let index = end - 1; index > start; index--) {
    const swapIndex = start + randomIndex(index - start + 1, rng)
    ;[items[index], items[swapIndex]] = [items[swapIndex], items[index]]
  }
}

function isTerminalState(state: GameSnapshot): boolean {
  return state.phase === 'finished' || state.result?.finished === true
}

function randomIndex(length: number, rng: () => number): number {
  if (length <= 0) throw new Error('Cannot choose from an empty collection')
  const sample = rng()
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error('rng must return a finite number between 0 and 1')
  }
  return Math.min(length - 1, Math.floor(sample * length))
}
