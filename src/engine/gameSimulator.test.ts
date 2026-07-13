import { describe, expect, it } from 'vitest'
import type { GameSnapshot, PlayerAction, WallDir } from '@/lib/types'
import { createEmptyBoard, makeInitialState, snapshotFromState } from '@/store/gameState'
import { checkGameEnd } from '@/utils/game'
import { applyActionToState, applyFullAction } from './gameSimulator'

function makePlayingState(): GameSnapshot {
  const state = makeInitialState()
  state.phase = 'playing'
  state.turn = 'R'
  state.stonesPlaced = { R: 4, B: 4 }
  return state
}

describe('applyActionToState', () => {
  it('does not mutate the received state', () => {
    const state = makePlayingState()
    state.selected = { x: 1, y: 1 }
    state.legal = new Set(['2,1'])
    const before = snapshotFromState(state)

    const next = applyActionToState(state, {
      type: 'move',
      from: { x: 1, y: 1 },
      pos: { x: 2, y: 1 },
    })

    expect(state).toEqual(before)
    expect(next).not.toBe(state)
    expect(next.board).not.toBe(state.board)
  })

  it('places stones and preserves the placing turn sequence and phase transition', () => {
    let state = makeInitialState()

    state = applyActionToState(state, { type: 'place', pos: { x: 0, y: 0 } })
    expect(state.board[0][0].stone).toBe('R')
    expect(state.stonesPlaced).toEqual({ R: 3, B: 2 })
    expect(state.phase).toBe('placing')
    expect(state.turn).toBe('B')

    state = applyActionToState(state, { type: 'place', pos: { x: 1, y: 0 } })
    state = applyActionToState(state, { type: 'place', pos: { x: 2, y: 0 } })
    state = applyActionToState(state, { type: 'place', pos: { x: 3, y: 0 } })

    expect(state.stonesPlaced).toEqual({ R: 4, B: 4 })
    expect(state.phase).toBe('playing')
    expect(state.turn).toBe('R')
  })

  it('moves a stone without changing player or phase', () => {
    const state = makePlayingState()
    const next = applyActionToState(state, {
      type: 'move',
      from: { x: 1, y: 1 },
      pos: { x: 2, y: 1 },
    })

    expect(next.board[1][1].stone).toBeNull()
    expect(next.board[1][2].stone).toBe('R')
    expect(next.turn).toBe('R')
    expect(next.phase).toBe('playing')
    expect(next.stepsTaken).toBe(1)
  })

  it.each([
    ['top', 1, 1, 'wallTop'],
    ['left', 1, 1, 'wallLeft'],
    ['right', 2, 1, 'wallLeft'],
    ['bottom', 1, 2, 'wallTop'],
  ] as const)('places a %s wall and then changes turn', (dir, x, y, field) => {
    const state = makePlayingState()
    const next = applyActionToState(state, {
      type: 'wall',
      pos: { x: 1, y: 1 },
      dir,
    })

    expect(next.board[y][x][field]).toBe('R')
    expect(next.turn).toBe('B')
    expect(next.phase).toBe('playing')
    expect(next.stepsTaken).toBe(0)
  })

  it('uses checkGameEnd output when a wall finishes the game', () => {
    const state = makePlayingState()
    state.board = createEmptyBoard()
    state.board[1][1].stone = 'R'

    const next = applyActionToState(state, {
      type: 'wall',
      pos: { x: 1, y: 1 },
      dir: 'top',
    })

    expect(next.phase).toBe('finished')
    expect(next.result).toEqual(checkGameEnd(next.board, ['R', 'B']))
    expect(next.result).toEqual({ finished: true, winner: 'R', score: { R: 49, B: 0 } })
    expect(next.turn).toBe('R')
  })

  it('matches representative snapshots captured from the previous implementation', () => {
    const placing = makeInitialState()
    const placedExpected = snapshotFromState(placing)
    placedExpected.board[0][0].stone = 'R'
    placedExpected.stonesPlaced.R = 3
    placedExpected.turn = 'B'
    placedExpected.selected = undefined
    placedExpected.legal = new Set()
    placedExpected.stepsTaken = 0
    placedExpected.result = undefined
    placedExpected.skipReason = undefined

    const playing = makePlayingState()
    const movedExpected = snapshotFromState(playing)
    movedExpected.board[1][1].stone = null
    movedExpected.board[1][2].stone = 'R'
    movedExpected.selected = { x: 2, y: 1 }
    movedExpected.stepsTaken = 1
    movedExpected.legal = new Set()

    const wallExpected = snapshotFromState(playing)
    wallExpected.board[1][1].wallTop = 'R'
    wallExpected.turn = 'B'
    wallExpected.selected = undefined
    wallExpected.legal = new Set()
    wallExpected.stepsTaken = 0
    wallExpected.skipReason = undefined

    const cases: Array<{
      state: GameSnapshot
      action: PlayerAction
      expected: GameSnapshot
    }> = [
      {
        state: placing,
        action: { type: 'place', pos: { x: 0, y: 0 } },
        expected: placedExpected,
      },
      {
        state: playing,
        action: { type: 'move', from: { x: 1, y: 1 }, pos: { x: 2, y: 1 } },
        expected: movedExpected,
      },
      {
        state: playing,
        action: { type: 'wall', pos: { x: 1, y: 1 }, dir: 'top' },
        expected: wallExpected,
      },
      {
        state: placing,
        action: { type: 'place', pos: { x: 1, y: 1 } },
        expected: snapshotFromState(placing),
      },
    ]

    for (const parityCase of cases) {
      expect(applyActionToState(parityCase.state, parityCase.action)).toEqual(parityCase.expected)
    }
  })
})

describe('applyFullAction', () => {
  it('applies movement before its follow-up wall and counts both atomic actions', () => {
    const state = makePlayingState()
    const result = applyFullAction(state, {
      type: 'move',
      from: { x: 1, y: 1 },
      pos: { x: 2, y: 1 },
      followUp: {
        type: 'wall',
        pos: { x: 2, y: 1 },
        dir: 'top',
      },
    })

    expect(result.atomicActions).toBe(2)
    expect(result.state.board[1][1].stone).toBeNull()
    expect(result.state.board[1][2].stone).toBe('R')
    expect(result.state.board[1][2].wallTop).toBe('R')
    expect(result.state.turn).toBe('B')
  })

  it('does not apply a follow-up after the main action finishes the game', () => {
    const state = makePlayingState()
    state.board = createEmptyBoard()
    state.board[1][1].stone = 'R'
    const followUp: PlayerAction = {
      type: 'wall',
      pos: { x: 1, y: 1 },
      dir: 'left' as WallDir,
    }

    const result = applyFullAction(state, {
      type: 'wall',
      pos: { x: 1, y: 1 },
      dir: 'top',
      followUp,
    })

    expect(result.atomicActions).toBe(1)
    expect(result.state.phase).toBe('finished')
    expect(result.state.board[1][1].wallTop).toBe('R')
    expect(result.state.board[1][1].wallLeft).toBeNull()
  })
})
