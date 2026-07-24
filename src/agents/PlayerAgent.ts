import type { GameSnapshot } from '@/lib/types'
import type { PlayerAction } from '@/lib/types'
import type { MCTSConfig, MCTSResult } from '@/engine/mcts/types'

export interface AgentDecisionDiagnostics {
  baseSeed: number
  decisionIndex: number
  decisionSeed: number
  mcts?: {
    result: MCTSResult
    effectiveConfig: MCTSConfig
    searchTimeMs: number
  }
}

export interface PlayerAgent {
  getAction(gameState: GameSnapshot): Promise<PlayerAction>
  getDecisionDiagnostics?(): AgentDecisionDiagnostics | undefined
  getDecisionDurationMs?(): number | undefined
  cancel?(): void
}
