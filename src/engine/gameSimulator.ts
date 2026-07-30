import type { Cell, GameSnapshot, Player, PlayerAction, WallDir } from '@/lib/types'
import { PLAYER_LIST } from '@/lib/types'
import { advanceTurn, placingTurnIndex } from '@/store/actions'
import { snapshotFromState } from '@/store/gameState'
import { checkGameEnd } from '@/utils/game'
import { isLegalMove } from '@/utils/move'

export interface ApplyFullActionResult {
  state: GameSnapshot
  atomicActions: number
}

export function applyActionToState(state: GameSnapshot, action: PlayerAction): GameSnapshot {
  const next = snapshotFromState(state)

  if (action.type === 'place') {
    if (next.phase !== 'placing' || next.board[action.pos.y][action.pos.x].stone) return next

    const totalPlaced = Object.values(next.stonesPlaced).reduce((sum, count) => sum + count, 0)
    const currentIdx = placingTurnIndex(totalPlaced, next.players.length)
    const currentPlayer = next.players[currentIdx]!
    next.board[action.pos.y][action.pos.x].stone = currentPlayer
    next.stonesPlaced[currentPlayer]++

    const newTotal = totalPlaced + 1
    const nextIdx = placingTurnIndex(newTotal, next.players.length)
    const allDone = Object.values(next.stonesPlaced).every((count) => count === next.stonesLimit)
    next.turn = next.players[nextIdx]!
    next.phase = allDone ? 'playing' : 'placing'
    next.selected = undefined
    next.legal = new Set<string>()
    next.stepsTaken = 0
    next.result = undefined
    next.skipReason = undefined
    return next
  }

  if (action.type === 'move') {
    if (next.phase !== 'playing' || !action.from) return next
    if (next.board[action.from.y][action.from.x].stone !== next.turn) return next
    if (!isLegalMove(action.from, action.pos, next.board)) return next

    next.board[action.from.y][action.from.x].stone = null
    next.board[action.pos.y][action.pos.x].stone = next.turn
    const distance = Math.abs(action.pos.x - action.from.x) + Math.abs(action.pos.y - action.from.y)
    next.selected = { ...action.pos }
    next.stepsTaken += distance
    next.legal = new Set<string>()
    return next
  }

  if (action.type === 'wall' && action.dir) {
    if (next.phase !== 'playing') return next
    const from = action.from ?? action.pos
    if (next.board[from.y][from.x].stone !== next.turn) return next
    next.selected = { ...from }
    placeWall(next.board, action.pos, action.dir, next.turn)

    const end = checkGameEnd(next.board, PLAYER_LIST.slice())
    if (end.finished) {
      next.phase = 'finished'
      next.result = end
      next.selected = undefined
      next.legal = new Set<string>()
      next.stepsTaken = 0
      return next
    }

    const advanced = advanceTurn(next.board, next.turn, PLAYER_LIST.slice())
    if (advanced.skipReason === 'allBlocked') {
      const blockedEnd = checkGameEnd(next.board, PLAYER_LIST.slice())
      next.phase = 'finished'
      next.result = blockedEnd.finished ? blockedEnd : { ...blockedEnd, finished: true, tie: true }
      next.selected = undefined
      next.legal = new Set<string>()
      next.stepsTaken = 0
      next.skipReason = undefined
      return next
    }

    next.turn = advanced.turn
    next.selected = undefined
    next.legal = new Set<string>()
    next.stepsTaken = 0
    next.skipReason = advanced.skipReason
  }

  return next
}

export function applyFullAction(state: GameSnapshot, action: PlayerAction): ApplyFullActionResult {
  let nextState = applyActionToState(state, action)
  let atomicActions = 1
  if (action.followUp && nextState.phase !== 'finished') {
    nextState = applyActionToState(nextState, action.followUp)
    atomicActions += 1
  }
  return { state: nextState, atomicActions }
}

function placeWall(
  board: Cell[][],
  pos: { x: number; y: number },
  dir: WallDir,
  player: Player,
): void {
  if (dir === 'top') board[pos.y][pos.x].wallTop = player
  if (dir === 'left') board[pos.y][pos.x].wallLeft = player
  if (dir === 'right') board[pos.y][pos.x + 1].wallLeft = player
  if (dir === 'bottom') board[pos.y + 1][pos.x].wallTop = player
}
