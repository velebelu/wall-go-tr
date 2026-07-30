// src/utils/player.ts
import type { GameSnapshot, Cell, Player, Stone } from '@/lib/types'
import { BOARD_SIZE } from '@/lib/types'
import { getLegalActions } from './ai'

export function getAllPlayerStones(board: Cell[][]): Stone[] {
  const stones: Stone[] = []
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (!board[y][x].stone) continue
      stones.push({
        player: board[y][x].stone as Player,
        position: { x, y },
      })
    }
  }
  return stones
}

export function playerHasMove(board: Cell[][], player: Player): boolean {
  return (
    getLegalActions({
      board,
      turn: player,
      phase: 'playing',
    } as GameSnapshot).length > 0
  )
}

/**
 * 判斷 snapshot 是否為 human 玩家回合
 */
export function isHumanTurn(state: GameSnapshot, humanSide: Player | null) {
  if (humanSide) return state.turn === humanSide
  return true // fallback: always allow
}
