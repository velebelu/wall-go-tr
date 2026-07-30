// Controla el bucle principal y espera secuencialmente la acción de cada agente.
import type { GameSnapshot } from '@/lib/types'
import type { Player } from '@/lib/types'
import type { PlayerAgent } from './PlayerAgent'
import type { PlayerAction } from '@/lib/types'
import { getLegalActions, getRandomWallActionForPlayer } from '@/utils/ai'
import type { AgentDecisionDiagnostics } from './PlayerAgent'

export interface TurnDecisionTrace {
  turnNumber: number
  player: Player
  stateBefore: GameSnapshot
  stateAfter: GameSnapshot
  action: PlayerAction
  legalActionCount: number
  decisionMs: number
  agentDiagnostics?: AgentDecisionDiagnostics
}

export class TurnManager {
  private agents: Record<Player, PlayerAgent>
  private getGameState: () => GameSnapshot
  private applyAction: (action: PlayerAction) => Promise<void> | void
  private isGameOver: (state: GameSnapshot) => boolean
  private onTurnStart?: (state: GameSnapshot) => void
  private onDecision?: (trace: TurnDecisionTrace) => void
  private turnTimeLimit: number
  private turnNumber = 0
  private stopped = false
  private loopPromise?: Promise<void>
  private stopLoop?: () => void

  constructor(params: {
    agents: Record<Player, PlayerAgent>
    getGameState: () => GameSnapshot
    applyAction: (action: PlayerAction) => Promise<void> | void
    isGameOver: (state: GameSnapshot) => boolean
    onTurnStart?: (state: GameSnapshot) => void
    onDecision?: (trace: TurnDecisionTrace) => void
    turnTimeLimit?: number
  }) {
    this.agents = params.agents
    this.getGameState = params.getGameState
    this.applyAction = params.applyAction
    this.isGameOver = params.isGameOver
    this.onTurnStart = params.onTurnStart
    this.onDecision = params.onDecision
    this.turnTimeLimit = params.turnTimeLimit ?? 90_000
  }

  // Ejecuta una acción y su continuación, si existe.
  private async executeAction(action: PlayerAction) {
    if (!action) return
    await this.applyAction(action)
    if (action.followUp) {
      await this.executeAction(action.followUp)
    }
  }

  startLoop(): Promise<void> {
    if (!this.loopPromise) this.loopPromise = this.runLoop()
    return this.loopPromise
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.stopLoop?.()
    this.stopLoop = undefined
    for (const agent of new Set(Object.values(this.agents))) agent.cancel?.()
  }

  private async runLoop(): Promise<void> {
    while (!this.isGameOver(this.getGameState())) {
      if (this.stopped) return
      const state = this.getGameState()
      if (this.onTurnStart) this.onTurnStart(state)
      const agent = this.agents[state.turn]
      const decisionStartedAt = performance.now()
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      const timeoutPromise = new Promise<PlayerAction>((resolve) => {
        timeoutId = setTimeout(() => {
          agent.cancel?.()
          const auto =
            getRandomWallActionForPlayer(state, state.turn) ??
            ({
              type: 'wall',
              from: { x: 0, y: 0 },
              pos: { x: 0, y: 0 },
              dir: 'top',
            } as PlayerAction)
          resolve(auto)
        }, this.turnTimeLimit)
      })

      const stoppedPromise = new Promise<null>((resolve) => {
        this.stopLoop = () => resolve(null)
      })
      const action = await Promise.race([agent.getAction(state), timeoutPromise, stoppedPromise])
      const measuredDecisionMs = performance.now() - decisionStartedAt
      if (timeoutId) clearTimeout(timeoutId)
      this.stopLoop = undefined
      if (this.stopped || action === null) return
      await this.executeAction(action as PlayerAction)
      if (this.stopped) return
      this.onDecision?.({
        turnNumber: this.turnNumber++,
        player: state.turn,
        stateBefore: state,
        stateAfter: this.getGameState(),
        action,
        legalActionCount: getLegalActions(state).length,
        decisionMs: agent.getDecisionDurationMs?.() ?? measuredDecisionMs,
        agentDiagnostics: agent.getDecisionDiagnostics?.(),
      })
    }
  }
}
