import type { PlayerAction } from '@/lib/types'

export interface MCTSConfig {
  simulations: number
  explorationConstant: number
  maxDepth: number
  rolloutPolicy: 'random' | 'mixed' | 'heuristic'
  heuristicProbability?: number
  expansionPolicy?: 'unordered' | 'heuristic'
  progressiveWidening?: boolean
  wideningConstant?: number
  wideningExponent?: number
}

export interface MCTSChildResult {
  action: PlayerAction
  visits: number
  value: number
}

export interface MCTSResult {
  action: PlayerAction
  visits: number
  value: number
  rootVisits: number
  children: MCTSChildResult[]
  rootLegalActions: number
  rootExpandedChildren: number
  maxDepthReached: number
  averageSelectedDepth: number
}

export const DEFAULT_WIDENING_CONSTANT = 2
export const DEFAULT_WIDENING_EXPONENT = 0.5

export const DEFAULT_MCTS_CONFIG: Readonly<MCTSConfig> = {
  simulations: 200,
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
  rolloutPolicy: 'random',
  expansionPolicy: 'unordered',
  progressiveWidening: false,
}
