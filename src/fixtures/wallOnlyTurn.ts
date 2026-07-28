import type { GameSnapshot, Player } from '@/lib/types'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'

export function makeWallOnlyTurnFixture(turn: Player = 'B'): GameSnapshot {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = turn
  state.stonesPlaced = { R: 4, B: 4 }

  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    state.board[y][x].stone = 'B'
  }
  state.board[0][2].wallLeft = 'B'
  state.board[1][2].wallLeft = 'B'
  state.board[2][0].wallTop = 'B'
  state.board[2][1].wallTop = 'B'

  for (const [x, y] of [
    [5, 5],
    [6, 5],
    [5, 6],
    [6, 6],
  ]) {
    state.board[y][x].stone = 'R'
  }
  state.board[5][5].wallLeft = 'R'
  state.board[6][5].wallLeft = 'R'
  state.board[5][5].wallTop = 'R'
  state.board[5][6].wallTop = 'R'

  return state
}

export function makeNonTerminalWallOnlyTurnFixture(turn: Player = 'B'): GameSnapshot {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = turn
  state.stonesPlaced = { R: 4, B: 4 }

  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    state.board[y][x].stone = 'B'
  }
  for (const [x, y] of [
    [2, 0],
    [2, 1],
    [0, 2],
    [1, 2],
  ]) {
    state.board[y][x].stone = 'R'
  }

  return state
}

export function makeSingleActionTurnFixture(turn: Player = 'B'): GameSnapshot {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = turn
  state.stonesPlaced = { R: 4, B: 4 }

  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [3, 3],
  ]) {
    state.board[y][x].stone = 'B'
  }
  for (const [x, y] of [
    [6, 6],
    [6, 5],
    [5, 6],
    [3, 5],
  ]) {
    state.board[y][x].stone = 'R'
  }

  return state
}

export function makeNoActionFixture(turn: Player = 'B'): GameSnapshot {
  const state = makeWallOnlyTurnFixture(turn)
  for (const [x, y, field] of [
    [1, 0, 'wallLeft'],
    [1, 1, 'wallLeft'],
    [0, 1, 'wallTop'],
    [1, 1, 'wallTop'],
  ] as const) {
    state.board[y][x][field] = 'B'
  }
  for (const [x, y, field] of [
    [6, 5, 'wallLeft'],
    [6, 6, 'wallLeft'],
    [5, 6, 'wallTop'],
    [6, 6, 'wallTop'],
  ] as const) {
    state.board[y][x][field] = 'R'
  }
  return state
}
