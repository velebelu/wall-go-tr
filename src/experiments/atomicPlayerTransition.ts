import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { advanceTurn } from '@/store/actions'
import { snapshotFromState } from '@/store/gameState'
import { checkGameEnd } from '@/utils/game'

export function applyRecordedPlayerAction(state: GameSnapshot, action: PlayerAction): GameSnapshot {
  const applied = applyFullAction(state, action).state
  if (action.type !== 'move' || action.followUp || applied.phase !== 'playing') return applied

  const next = snapshotFromState(applied)
  const end = checkGameEnd(next.board, [...next.players])
  if (end.finished) {
    next.phase = 'finished'
    next.result = end
  } else {
    const advanced = advanceTurn(next.board, next.turn, [...next.players])
    if (advanced.skipReason === 'allBlocked') {
      const blockedEnd = checkGameEnd(next.board, [...next.players])
      next.phase = 'finished'
      next.result = blockedEnd.finished ? blockedEnd : { ...blockedEnd, finished: true, tie: true }
      next.skipReason = undefined
    } else {
      next.turn = advanced.turn
      next.skipReason = advanced.skipReason
    }
  }
  next.selected = undefined
  next.legal = new Set()
  next.stepsTaken = 0
  return next
}
