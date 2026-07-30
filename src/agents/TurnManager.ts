// Controla el bucle principal y espera secuencialmente la acción de cada agente.
import type { GameSnapshot } from '@/lib/types'
import type { Player } from '@/lib/types'
import type { PlayerAgent } from './PlayerAgent'
import type { PlayerAction } from '@/lib/types'
import { getLegalActions, getRandomWallActionForPlayer } from '@/utils/ai'
import type { AgentDecisionDiagnostics } from './PlayerAgent'
import { snapshotFromState } from '@/store/gameState'
import { applyRecordedPlayerAction } from '@/experiments/atomicPlayerTransition'

export interface TurnDecisionTrace {
  turnNumber: number
  player: Player
  stateBefore: GameSnapshot
  stateAfter: GameSnapshot
  action: PlayerAction
  legalActionCount: number
  decisionMs: number
  agentDiagnostics?: AgentDecisionDiagnostics
  transition?: {
    transitionId: string
    capturedAt: string
    committedAt: string
    stateBeforeHash: string
    engineStateAfterHash: string
    committedStateHash: string
    turnBefore: Player
    turnAfter: Player
    stonesPlacedBefore: Record<Player, number>
    stonesPlacedAfter: Record<Player, number>
    affectedCellBefore: string | null
    affectedCellAfter: string | null
  }
}

export class TurnManager {
  private agents: Record<Player, PlayerAgent>
  private getGameState: () => GameSnapshot
  private applyAction: (
    action: PlayerAction,
    transition: Readonly<{
      stateBefore: GameSnapshot
      stateAfter: GameSnapshot
      stateChangeWhileDeciding: 'selection' | 'move' | false
    }>,
  ) => Promise<GameSnapshot> | GameSnapshot
  private isGameOver: (state: GameSnapshot) => boolean
  private onTurnStart?: (state: GameSnapshot) => void
  private onDecision?: (trace: TurnDecisionTrace) => void
  private allowStateChangeWhileDeciding?: (action: PlayerAction) => 'selection' | 'move' | false
  private turnTimeLimit: number
  private turnNumber = 0
  private stopped = false
  private loopPromise?: Promise<void>
  private stopLoop?: () => void

  constructor(params: {
    agents: Record<Player, PlayerAgent>
    getGameState: () => GameSnapshot
    applyAction: (
      action: PlayerAction,
      transition: Readonly<{
        stateBefore: GameSnapshot
        stateAfter: GameSnapshot
        stateChangeWhileDeciding: 'selection' | 'move' | false
      }>,
    ) => Promise<GameSnapshot> | GameSnapshot
    isGameOver: (state: GameSnapshot) => boolean
    onTurnStart?: (state: GameSnapshot) => void
    onDecision?: (trace: TurnDecisionTrace) => void
    allowStateChangeWhileDeciding?: (action: PlayerAction) => 'selection' | 'move' | false
    turnTimeLimit?: number
  }) {
    this.agents = params.agents
    this.getGameState = params.getGameState
    this.applyAction = params.applyAction
    this.isGameOver = params.isGameOver
    this.onTurnStart = params.onTurnStart
    this.onDecision = params.onDecision
    this.allowStateChangeWhileDeciding = params.allowStateChangeWhileDeciding
    this.turnTimeLimit = params.turnTimeLimit ?? 90_000
  }

  // Ejecuta una acción y su continuación, si existe.
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
      const stateBefore = snapshotFromState(this.getGameState())
      const transitionId = globalThis.crypto.randomUUID()
      const capturedAt = new Date().toISOString()
      if (this.onTurnStart) this.onTurnStart(stateBefore)
      const agent = this.agents[stateBefore.turn]
      const decisionStartedAt = performance.now()
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      const timeoutPromise = new Promise<PlayerAction>((resolve) => {
        timeoutId = setTimeout(() => {
          agent.cancel?.()
          const auto =
            getRandomWallActionForPlayer(stateBefore, stateBefore.turn) ??
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
      const action = await Promise.race([
        agent.getAction(snapshotFromState(stateBefore)),
        timeoutPromise,
        stoppedPromise,
      ])
      const measuredDecisionMs = performance.now() - decisionStartedAt
      if (timeoutId) clearTimeout(timeoutId)
      this.stopLoop = undefined
      if (this.stopped || action === null) return
      const recordedAction = structuredClone(action as PlayerAction)
      const stateChangedWhileDeciding = !sameSnapshot(this.getGameState(), stateBefore)
      const stateChangeWhileDeciding =
        this.allowStateChangeWhileDeciding?.(action as PlayerAction) ?? false
      if (stateChangedWhileDeciding && !stateChangeWhileDeciding) {
        throw new Error(
          'Official session stopped: the game state changed while the agent was deciding.',
        )
      }
      const legalActions = getLegalActions(stateBefore)
      if (!legalActions.some((legal) => samePlayableAction(legal, recordedAction))) {
        throw new Error('Official session stopped: the agent returned an illegal action.')
      }
      const stateAfter = applyRecordedPlayerAction(stateBefore, recordedAction)
      if (sameSnapshot(stateBefore, stateAfter)) {
        throw new Error('Official session stopped: a legal action produced no state transition.')
      }
      const committedState = await this.applyAction(recordedAction, {
        stateBefore: snapshotFromState(stateBefore),
        stateAfter: snapshotFromState(stateAfter),
        stateChangeWhileDeciding,
      })
      if (!sameSnapshot(committedState, stateAfter)) {
        throw new Error(
          'Official session stopped: the committed state does not match the engine transition.',
        )
      }
      if (this.stopped) return
      this.onDecision?.({
        turnNumber: this.turnNumber++,
        player: stateBefore.turn,
        stateBefore: snapshotFromState(stateBefore),
        stateAfter: snapshotFromState(stateAfter),
        action: recordedAction,
        legalActionCount: legalActions.length,
        decisionMs: agent.getDecisionDurationMs?.() ?? measuredDecisionMs,
        agentDiagnostics: agent.getDecisionDiagnostics?.(),
        transition: {
          transitionId,
          capturedAt,
          committedAt: new Date().toISOString(),
          stateBeforeHash: snapshotHash(stateBefore),
          engineStateAfterHash: snapshotHash(stateAfter),
          committedStateHash: snapshotHash(committedState),
          turnBefore: stateBefore.turn,
          turnAfter: stateAfter.turn,
          stonesPlacedBefore: structuredClone(stateBefore.stonesPlaced),
          stonesPlacedAfter: structuredClone(stateAfter.stonesPlaced),
          affectedCellBefore: affectedCell(stateBefore, recordedAction),
          affectedCellAfter: affectedCell(stateAfter, recordedAction),
        },
      })
    }
  }
}

function sameSnapshot(left: GameSnapshot, right: GameSnapshot): boolean {
  return JSON.stringify(serializableSnapshot(left)) === JSON.stringify(serializableSnapshot(right))
}

function serializableSnapshot(state: GameSnapshot) {
  const snapshot = snapshotFromState(state)
  return { ...snapshot, legal: [...snapshot.legal].sort() }
}

function snapshotHash(state: GameSnapshot): string {
  const input = JSON.stringify(serializableSnapshot(state))
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function affectedCell(state: GameSnapshot, action: PlayerAction): string | null {
  const cell = state.board[action.pos.y]?.[action.pos.x]
  if (!cell) return null
  return JSON.stringify({ stone: cell.stone, wallTop: cell.wallTop, wallLeft: cell.wallLeft })
}

function samePlayableAction(left: PlayerAction, right: PlayerAction): boolean {
  if (
    left.type === 'move' &&
    right.type === 'move' &&
    !right.followUp &&
    JSON.stringify(left.from) === JSON.stringify(right.from) &&
    JSON.stringify(left.pos) === JSON.stringify(right.pos)
  )
    return true
  return (
    JSON.stringify(normalizePlayableAction(left)) === JSON.stringify(normalizePlayableAction(right))
  )
}

function normalizePlayableAction(action: PlayerAction): PlayerAction {
  const normalized = structuredClone(action)
  if (normalized.type === 'wall') delete normalized.from
  if (normalized.followUp) normalized.followUp = normalizePlayableAction(normalized.followUp)
  return normalized
}
