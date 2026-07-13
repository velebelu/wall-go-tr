import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'

export class MCTSNode {
  readonly children: MCTSNode[] = []
  readonly untriedActions: PlayerAction[]
  readonly state: GameSnapshot
  readonly parent?: MCTSNode
  readonly action?: PlayerAction
  visits = 0
  valueSum = 0

  constructor(state: GameSnapshot, parent?: MCTSNode, action?: PlayerAction) {
    this.state = state
    this.parent = parent
    this.action = action
    this.untriedActions = isTerminalState(state) ? [] : getLegalActions(state)
  }

  get meanValue(): number {
    return this.visits === 0 ? 0 : this.valueSum / this.visits
  }

  get isTerminal(): boolean {
    return isTerminalState(this.state)
  }

  // Expansion consumes one legal action so the same child cannot be created twice.
  expand(rng: () => number): MCTSNode | undefined {
    if (this.untriedActions.length === 0) return undefined
    const index = randomIndex(this.untriedActions.length, rng)
    const [action] = this.untriedActions.splice(index, 1)
    const child = new MCTSNode(applyFullAction(this.state, action).state, this, action)
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
