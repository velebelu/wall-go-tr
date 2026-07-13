import type { PlayerAction } from '@/lib/types'

export interface MCTSConfig {
  simulations: number
  explorationConstant: number
  maxDepth: number
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
}

export const DEFAULT_MCTS_CONFIG: Readonly<MCTSConfig> = {
  simulations: 200,
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
}
