import type { GameSnapshot } from '@/lib/types'
import type { PlayerAction } from '@/lib/types'

export interface AgentDecisionDiagnostics {
  baseSeed: number
  decisionIndex: number
  decisionSeed: number
}

export interface PlayerAgent {
  getAction(gameState: GameSnapshot): Promise<PlayerAction>
  getDecisionDiagnostics?(): AgentDecisionDiagnostics | undefined
  getDecisionDurationMs?(): number | undefined
  cancel?(): void
}
