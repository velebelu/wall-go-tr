import { describe, expect, it } from 'vitest'
import type { GameSnapshot, Player } from '@/lib/types'
import { createEmptyBoard, makeInitialState, snapshotFromState } from '@/store/gameState'
import {
  TERMINAL_SCORE,
  TRAPPED_WEIGHT,
  evaluatePosition,
  evaluatePositionWithBreakdown,
} from './evaluatePosition'

function makePlayingState(): GameSnapshot {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = 'R'
  state.stonesPlaced = { R: 4, B: 4 }
  return state
}

function makeTerminalState(winner?: Player, tie = false): GameSnapshot {
  const state = makePlayingState()
  state.phase = 'finished'
  state.result = tie ? { finished: true, tie: true } : { finished: true, winner }
  return state
}

function addVerticalDivider(state: GameSnapshot, dividerX: number): void {
  for (let y = 0; y < state.board.length; y++) {
    state.board[y][dividerX].wallLeft = 'R'
  }
}

function encloseCell(state: GameSnapshot, x: number, y: number): void {
  state.board[y][x].wallTop = 'R'
  state.board[y][x].wallLeft = 'R'
  state.board[y][x + 1].wallLeft = 'R'
  state.board[y + 1][x].wallTop = 'R'
}

describe('evaluatePosition terminal states', () => {
  it('returns a very high score for a win', () => {
    expect(evaluatePosition(makeTerminalState('R'), 'R')).toBe(TERMINAL_SCORE)
  })

  it('returns a very low score for a loss', () => {
    expect(evaluatePosition(makeTerminalState('B'), 'R')).toBe(-TERMINAL_SCORE)
  })

  it('returns zero for a tie', () => {
    expect(evaluatePosition(makeTerminalState(undefined, true), 'R')).toBe(0)
    expect(evaluatePosition(makeTerminalState(undefined, true), 'B')).toBe(0)
  })
})

describe('evaluatePosition strategic components', () => {
  it('is exactly symmetric between red and blue', () => {
    const state = makePlayingState()
    state.board[3][3].stone = 'R'
    state.board[0][0].stone = 'B'

    expect(evaluatePosition(state, 'R')).toBe(-evaluatePosition(state, 'B'))
  })

  it('scores a position with more territory more highly', () => {
    const favorable = makePlayingState()
    favorable.board[3][1].stone = 'R'
    favorable.board[3][5].stone = 'B'
    addVerticalDivider(favorable, 4)

    const unfavorable = makePlayingState()
    unfavorable.board[3][1].stone = 'R'
    unfavorable.board[3][5].stone = 'B'
    addVerticalDivider(unfavorable, 3)

    const favorableEvaluation = evaluatePositionWithBreakdown(favorable, 'R')
    const unfavorableEvaluation = evaluatePositionWithBreakdown(unfavorable, 'R')

    expect(favorableEvaluation.territory).toBeGreaterThan(0)
    expect(unfavorableEvaluation.territory).toBeLessThan(0)
    expect(favorableEvaluation.total).toBeGreaterThan(unfavorableEvaluation.total)
  })

  it('scores greater mobility more highly', () => {
    const state = makePlayingState()
    state.board[3][3].stone = 'R'
    state.board[0][0].stone = 'B'

    const evaluation = evaluatePositionWithBreakdown(state, 'R')

    expect(evaluation.mobility).toBeGreaterThan(0)
    expect(evaluation.total).toBeGreaterThan(0)
  })

  it('penalizes a trapped own piece', () => {
    const state = makePlayingState()
    state.board[1][1].stone = 'R'
    state.board[5][5].stone = 'B'
    encloseCell(state, 1, 1)

    expect(evaluatePositionWithBreakdown(state, 'R').trappedPieces).toBe(-TRAPPED_WEIGHT)
  })

  it('rewards a trapped opposing piece', () => {
    const state = makePlayingState()
    state.board[1][1].stone = 'R'
    state.board[5][5].stone = 'B'
    encloseCell(state, 5, 5)

    expect(evaluatePositionWithBreakdown(state, 'R').trappedPieces).toBe(TRAPPED_WEIGHT)
  })

  it('rewards access to a larger wall-connected region', () => {
    const state = makePlayingState()
    state.board[3][1].stone = 'R'
    state.board[3][5].stone = 'B'
    addVerticalDivider(state, 4)

    expect(evaluatePositionWithBreakdown(state, 'R').expansion).toBeGreaterThan(0)
  })
})

describe('evaluatePosition purity', () => {
  it('does not modify the received state', () => {
    const state = makePlayingState()
    state.board[3][3].stone = 'R'
    state.board[0][0].stone = 'B'
    state.legal = new Set(['3,4'])
    const before = snapshotFromState(state)

    evaluatePositionWithBreakdown(state, 'R')

    expect(state).toEqual(before)
  })

  it('is deterministic', () => {
    const state = makePlayingState()
    state.board[3][3].stone = 'R'
    state.board[0][0].stone = 'B'

    expect(evaluatePositionWithBreakdown(state, 'R')).toEqual(
      evaluatePositionWithBreakdown(state, 'R'),
    )
  })

  it('returns the same total from both public APIs', () => {
    const state = makePlayingState()
    state.board[3][3].stone = 'R'
    state.board[0][0].stone = 'B'
    const breakdown = evaluatePositionWithBreakdown(state, 'R')

    expect(breakdown.total).toBe(
      breakdown.territory + breakdown.mobility + breakdown.trappedPieces + breakdown.expansion,
    )
    expect(evaluatePosition(state, 'R')).toBe(breakdown.total)
  })
})
