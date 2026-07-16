import { applyFullAction } from '@/engine/gameSimulator'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { getLegalActions, scoreHeuristicAction } from '@/utils/ai'
import {
  DEFAULT_WIDENING_CONSTANT,
  DEFAULT_WIDENING_EXPONENT,
  type MCTSConfig,
  type MCTSQPriorSource,
} from './types'

export interface MCTSNodeOptions {
  expansionPolicy: NonNullable<MCTSConfig['expansionPolicy']>
  progressiveWidening: boolean
  wideningConstant: number
  wideningExponent: number
  rng: () => number
  qPriorWeight?: number
  qPriorSource?: MCTSQPriorSource
}

const DEFAULT_NODE_OPTIONS: MCTSNodeOptions = {
  expansionPolicy: 'unordered',
  progressiveWidening: false,
  wideningConstant: DEFAULT_WIDENING_CONSTANT,
  wideningExponent: DEFAULT_WIDENING_EXPONENT,
  rng: Math.random,
  qPriorWeight: 0,
}

export interface ActionExpansionScore {
  action: PlayerAction
  heuristicScore: number
  normalizedHeuristicScore: number
  qKnown: boolean
  qReliable: boolean
  qValue: number
  normalizedQ5Value: number
  combinedScore: number
}

export class MCTSNode {
  readonly children: MCTSNode[] = []
  readonly state: GameSnapshot
  readonly parent?: MCTSNode
  readonly action?: PlayerAction
  private readonly options: MCTSNodeOptions
  private actionsOrdered: boolean
  private actionScores?: ActionExpansionScore[]
  private legalActionsCache?: PlayerAction[]
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
    this.actionsOrdered = options.expansionPolicy === 'unordered'
  }

  // Lazy: los hijos creados en la expansión pueden no visitarse nunca más,
  // y generar sus acciones legales por adelantado domina el coste de la búsqueda.
  get untriedActions(): PlayerAction[] {
    return (this.legalActionsCache ??= isTerminalState(this.state)
      ? []
      : getLegalActions(this.state))
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
      Math.floor(this.options.wideningConstant * this.visits ** this.options.wideningExponent),
    )
  }

  get canExpand(): boolean {
    return this.untriedActions.length > 0 && this.children.length < this.maxChildrenAllowed
  }

  get expansionScores(): readonly ActionExpansionScore[] {
    this.ensureActionsOrdered()
    return this.actionScores ?? []
  }

  getExpansionScore(action: PlayerAction): ActionExpansionScore | undefined {
    const signature = JSON.stringify(action)
    return this.expansionScores.find((score) => JSON.stringify(score.action) === signature)
  }

  private ensureActionsOrdered(): void {
    if (this.actionsOrdered) return
    const scored = scoreActionsForExpansion(
      this.state,
      this.untriedActions,
      this.options.expansionPolicy,
      this.options.rng,
      this.options.qPriorSource,
      this.options.qPriorWeight,
    )
    this.actionScores = scored
    this.untriedActions.splice(0, this.untriedActions.length, ...scored.map(({ action }) => action))
    this.actionsOrdered = true
  }

  // Expansion consumes one legal action so the same child cannot be created twice.
  expand(rng: () => number): MCTSNode | undefined {
    if (!this.canExpand) return undefined
    this.ensureActionsOrdered()
    const index =
      this.options.expansionPolicy !== 'unordered'
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
  qPriorSource?: MCTSQPriorSource,
  qPriorWeight = 0,
): PlayerAction[] {
  return scoreActionsForExpansion(state, actions, policy, rng, qPriorSource, qPriorWeight).map(
    ({ action }) => action,
  )
}

export function scoreActionsForExpansion(
  state: GameSnapshot,
  actions: readonly PlayerAction[],
  policy: NonNullable<MCTSConfig['expansionPolicy']>,
  rng: () => number,
  qPriorSource?: MCTSQPriorSource,
  qPriorWeight = 0,
): ActionExpansionScore[] {
  if (policy === 'unordered') {
    return actions.map((action) => emptyExpansionScore(action))
  }

  const scored = actions.map((action) => ({
    action,
    heuristicScore: scoreHeuristicAction(state, action, 'default'),
    qKnown: false,
    qReliable: false,
    qValue: 0,
  }))
  const normalizedHeuristic = normalizeMinMax(scored.map(({ heuristicScore }) => heuristicScore))

  if (policy === 'heuristic-q5' && qPriorSource) {
    for (const item of scored) {
      const key = getLearningQTableKeyQ3(state, item.action)
      item.qKnown = Object.prototype.hasOwnProperty.call(qPriorSource.qTable, key)
      item.qReliable =
        item.qKnown && (qPriorSource.confidence.get(key) ?? 0) >= qPriorSource.minConfidence
      item.qValue = item.qKnown ? qPriorSource.qTable[key]! : 0
    }
  }

  const reliableValues = scored.filter(({ qReliable }) => qReliable).map(({ qValue }) => qValue)
  const normalizedReliableQ = normalizeMinMax(reliableValues)
  let reliableIndex = 0
  const combined: ActionExpansionScore[] = scored.map((item, index) => {
    const normalizedQ5Value = item.qReliable ? normalizedReliableQ[reliableIndex++]! : 0
    return {
      ...item,
      normalizedHeuristicScore: normalizedHeuristic[index]!,
      normalizedQ5Value,
      combinedScore: normalizedHeuristic[index]! + qPriorWeight * normalizedQ5Value,
    }
  })
  combined.sort((left, right) => right.combinedScore - left.combinedScore)

  for (let start = 0; start < combined.length; ) {
    let end = start + 1
    while (end < combined.length && combined[end].combinedScore === combined[start].combinedScore) {
      end++
    }
    shuffleRange(combined, start, end, rng)
    start = end
  }
  return combined
}

/** Min-max normalization bounds each node-local component to [-1, 1]. */
export function normalizeMinMax(values: readonly number[]): number[] {
  if (values.length === 0) return []
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  if (minimum === maximum) return values.map(() => 0)
  return values.map((value) => ((value - minimum) / (maximum - minimum)) * 2 - 1)
}

function emptyExpansionScore(action: PlayerAction): ActionExpansionScore {
  return {
    action,
    heuristicScore: 0,
    normalizedHeuristicScore: 0,
    qKnown: false,
    qReliable: false,
    qValue: 0,
    normalizedQ5Value: 0,
    combinedScore: 0,
  }
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
