import { describe, expect, it } from 'vitest'
import type { GameSnapshot, Player } from '@/lib/types'
import { createEmptyBoard, makeInitialState, snapshotFromState } from '@/store/gameState'
import {
  TERMINAL_SCORE,
  TRAPPED_WEIGHT,
  calculateContestedRegionSupport,
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

  it('is unchanged when contestedRegionSupport is enabled', () => {
    expect(
      evaluatePosition(makeTerminalState('R'), 'R', {
        contestedRegionSupport: { enabled: true, weight: 1 },
      }),
    ).toBe(TERMINAL_SCORE)
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

describe('contestedRegionSupport', () => {
  function support(stones: Array<[number, number, Player]>) {
    const state = makePlayingState()
    for (const [x, y, player] of stones) state.board[y][x].stone = player
    return { state, value: calculateContestedRegionSupport(state.board, 'R') }
  }

  it('gives equal half support to one stone per player and excludes occupied cells', () => {
    const { value } = support([
      [0, 0, 'R'],
      [6, 6, 'B'],
    ])
    expect(value).toEqual({ ownSupport: 23.5, opponentSupport: 23.5, differential: 0 })
  })

  it('gives half support to one own stone and full support to two rivals', () => {
    const { value } = support([
      [0, 0, 'R'],
      [5, 6, 'B'],
      [6, 6, 'B'],
    ])
    expect(value).toEqual({ ownSupport: 23, opponentSupport: 46, differential: -23 })
  })

  it('is symmetric for two own stones and one rival', () => {
    const { state, value } = support([
      [0, 0, 'R'],
      [1, 0, 'R'],
      [6, 6, 'B'],
    ])
    expect(value.differential).toBe(23)
    expect(calculateContestedRegionSupport(state.board, 'B').differential).toBe(-23)
  })

  it('caps support at 100 percent for three or more stones', () => {
    const two = support([
      [0, 0, 'R'],
      [1, 0, 'R'],
      [6, 6, 'B'],
    ]).value.ownSupport
    const three = support([
      [0, 0, 'R'],
      [1, 0, 'R'],
      [2, 0, 'R'],
      [6, 6, 'B'],
    ]).value.ownSupport
    expect(two).toBe(46)
    expect(three).toBe(45)
  })

  it('ignores single-player and empty regions', () => {
    expect(support([[0, 0, 'R']]).value.differential).toBe(0)
    expect(support([]).value.differential).toBe(0)
  })

  it('uses wall-separated components and sums them independently', () => {
    const state = makePlayingState()
    addVerticalDivider(state, 3)
    state.board[0][0].stone = 'R'
    state.board[0][1].stone = 'B'
    state.board[0][4].stone = 'R'
    state.board[0][5].stone = 'R'
    state.board[0][6].stone = 'B'
    const value = calculateContestedRegionSupport(state.board, 'R')
    expect(value.ownSupport).toBe(9.5 + 25)
    expect(value.opponentSupport).toBe(9.5 + 12.5)
    expect(value.differential).toBe(12.5)
  })

  it('has no evaluation effect when absent, disabled, or weight zero', () => {
    const { state } = support([
      [0, 0, 'R'],
      [5, 6, 'B'],
      [6, 6, 'B'],
    ])
    const baseline = evaluatePosition(state, 'R')
    expect(
      evaluatePosition(state, 'R', {
        contestedRegionSupport: { enabled: false, weight: 1 },
      }),
    ).toBe(baseline)
    expect(
      evaluatePosition(state, 'R', {
        contestedRegionSupport: { enabled: true, weight: 0 },
      }),
    ).toBe(baseline)
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
      breakdown.territory +
        breakdown.mobility +
        breakdown.trappedPieces +
        breakdown.expansion +
        breakdown.contestedRegionSupport,
    )
    expect(evaluatePosition(state, 'R')).toBe(breakdown.total)
  })
})
