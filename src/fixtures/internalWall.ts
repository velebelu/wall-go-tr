import type { GameSnapshot, Player } from '@/lib/types'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'

function baseFixture(): GameSnapshot {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = 'B'
  state.stonesPlaced = { R: 4, B: 4 }
  for (const y of [0, 1, 2]) state.board[y][3].wallLeft = 'B'
  state.board[0][2].wallLeft = 'B'
  state.board[2][2].wallLeft = 'B'
  for (const x of [0, 1, 2]) state.board[3][x].wallTop = 'B'
  for (const [x, y] of [
    [0, 0],
    [1, 1],
    [0, 2],
    [1, 2],
  ])
    state.board[y][x].stone = 'B'
  for (const [x, y] of [
    [5, 5],
    [6, 5],
    [5, 6],
    [6, 6],
  ])
    state.board[y][x].stone = 'R'
  return state
}

export function makeInternalWallLossFixture(): GameSnapshot {
  return baseFixture()
}

export function makeInternalWallNeutralFixture(): GameSnapshot {
  const state = baseFixture()
  state.board[2][2].stone = 'B'
  return state
}

export const INTERNAL_WALL_DIAGNOSTIC_FIXTURES = Object.freeze([
  {
    id: 'synthetic-own-only-internal-wall-immediate-loss',
    source: 'generated-from-game-rules',
    player: 'B' as Player,
    observedP02Replacement: false,
  },
  {
    id: 'synthetic-own-only-internal-wall-neutral',
    source: 'generated-from-game-rules',
    player: 'B' as Player,
    observedP02Replacement: false,
  },
])
