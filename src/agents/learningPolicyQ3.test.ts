import { describe, expect, it } from 'vitest'
import { getLearningActionKey, getLearningStateKey } from './learningPolicy'
import {
  bucketMobilityQ3,
  bucketTerritoryDiffQ3,
  bucketWallsQ3,
  calculatePlayerMobilityQ3,
  getLearningActionKeyQ3,
  getLearningQTableKeyQ3,
  getLearningStateKeyQ3,
} from './learningPolicyQ3'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import type { GameSnapshot, PlayerAction } from '@/lib/types'

function clearBoard(state: GameSnapshot): GameSnapshot {
  const next = snapshotFromState(state)
  next.board = next.board.map((row) =>
    row.map(() => ({ stone: null, wallTop: null, wallLeft: null })),
  )
  next.stonesPlaced = { R: 0, B: 0 }
  return next
}

describe('learningPolicyQ3 buckets', () => {
  it('buckets territory difference limits', () => {
    expect(bucketTerritoryDiffQ3(-16)).toBe('L3')
    expect(bucketTerritoryDiffQ3(-15)).toBe('L2')
    expect(bucketTerritoryDiffQ3(-8)).toBe('L2')
    expect(bucketTerritoryDiffQ3(-7)).toBe('L1')
    expect(bucketTerritoryDiffQ3(-3)).toBe('L1')
    expect(bucketTerritoryDiffQ3(-2)).toBe('E')
    expect(bucketTerritoryDiffQ3(2)).toBe('E')
    expect(bucketTerritoryDiffQ3(3)).toBe('W1')
    expect(bucketTerritoryDiffQ3(8)).toBe('W2')
    expect(bucketTerritoryDiffQ3(16)).toBe('W3')
  })

  it('buckets mobility limits', () => {
    expect(bucketMobilityQ3(0)).toBe('0')
    expect(bucketMobilityQ3(1)).toBe('1-5')
    expect(bucketMobilityQ3(5)).toBe('1-5')
    expect(bucketMobilityQ3(6)).toBe('6-15')
    expect(bucketMobilityQ3(15)).toBe('6-15')
    expect(bucketMobilityQ3(16)).toBe('16-35')
    expect(bucketMobilityQ3(35)).toBe('16-35')
    expect(bucketMobilityQ3(36)).toBe('36+')
  })

  it('buckets wall limits', () => {
    expect(bucketWallsQ3(0)).toBe('0')
    expect(bucketWallsQ3(1)).toBe('1-8')
    expect(bucketWallsQ3(8)).toBe('1-8')
    expect(bucketWallsQ3(9)).toBe('9-20')
    expect(bucketWallsQ3(20)).toBe('9-20')
    expect(bucketWallsQ3(21)).toBe('21-36')
    expect(bucketWallsQ3(36)).toBe('21-36')
    expect(bucketWallsQ3(37)).toBe('37+')
  })
})

describe('learningPolicyQ3 state key', () => {
  it('uses mine/opponent perspective for R and B', () => {
    const stateR = makeInitialState()
    stateR.turn = 'R'
    stateR.stonesPlaced = { R: 3, B: 4 }
    const stateB = makeInitialState()
    stateB.turn = 'B'
    stateB.stonesPlaced = { R: 3, B: 4 }

    expect(getLearningStateKeyQ3(stateR)).toContain('sp:3,4')
    expect(getLearningStateKeyQ3(stateB)).toContain('sp:4,3')
  })

  it('gives equivalent aggregate keys for equivalent R and B perspectives', () => {
    const stateR = makeInitialState()
    const stateB = makeInitialState()
    stateR.turn = 'R'
    stateB.turn = 'B'

    expect(getLearningStateKeyQ3(stateR).replace('phase:placing', 'phase:placing')).toBe(
      getLearningStateKeyQ3(stateB),
    )
  })

  it('does not include low in the Q3 state key and preserves the remaining field order', () => {
    const state = makeInitialState()

    expect(getLearningStateKeyQ3(state)).toBe(
      'q3|phase:placing|step:0|sp:2,2|td:E|mob:16-35,16-35|trap:0,0|walls:0',
    )
    expect(getLearningStateKeyQ3(state)).not.toContain('|low:')
  })

  it('counts trap and low pieces without double-counting traps', () => {
    const state = clearBoard(makeInitialState())
    state.phase = 'playing'
    state.turn = 'R'
    state.board[0][0].stone = 'R'
    state.board[3][3].stone = 'R'
    state.stonesPlaced = { R: 2, B: 0 }

    state.board[0][0].wallTop = 'R'
    state.board[0][0].wallLeft = 'R'
    state.board[0][1].wallLeft = 'R'
    state.board[1][0].wallTop = 'R'

    state.board[3][3].wallTop = 'R'
    state.board[3][3].wallLeft = 'R'
    state.board[3][4].wallLeft = 'R'
    state.board[2][3].stone = 'B'
    state.board[3][2].stone = 'B'
    state.board[4][2].stone = 'B'
    state.board[4][4].stone = 'B'
    state.board[5][3].stone = 'B'

    const mobility = calculatePlayerMobilityQ3(state, 'R')
    expect(mobility.trapPieces).toBe(1)
    expect(mobility.lowPieces).toBe(1)
    expect(getLearningStateKeyQ3(state)).toContain('trap:1,')
    expect(getLearningStateKeyQ3(state)).not.toContain('|low:')
  })

  it('does not mutate the state', () => {
    const state = makeInitialState()
    const before = JSON.stringify(snapshotFromState(state))
    getLearningStateKeyQ3(state)
    expect(JSON.stringify(snapshotFromState(state))).toBe(before)
  })
})

describe('learningPolicyQ3 action key', () => {
  it('normalizes place coordinates for B with a vertical mirror', () => {
    const stateR = makeInitialState()
    stateR.turn = 'R'
    const stateB = makeInitialState()
    stateB.turn = 'B'

    expect(getLearningActionKeyQ3(stateR, { type: 'place', pos: { x: 2, y: 1 } })).toBe(
      getLearningActionKeyQ3(stateB, { type: 'place', pos: { x: 2, y: 5 } }),
    )
  })

  it('preserves move-wall origin, destination, wall and direction', () => {
    const state = makeInitialState()
    const action: PlayerAction = {
      type: 'move',
      from: { x: 1, y: 1 },
      pos: { x: 2, y: 2 },
      followUp: { type: 'wall', pos: { x: 2, y: 2 }, dir: 'top' },
    }

    expect(getLearningActionKeyQ3(state, action)).toBe('move-wall|1|1|2|2|2|2|top')
  })

  it('creates different keys for the four wall variants of the same move', () => {
    const state = makeInitialState()
    const keys = ['top', 'bottom', 'left', 'right'].map((dir) =>
      getLearningActionKeyQ3(state, {
        type: 'move',
        from: { x: 1, y: 1 },
        pos: { x: 2, y: 2 },
        followUp: { type: 'wall', pos: { x: 2, y: 2 }, dir: dir as PlayerAction['dir'] },
      }),
    )

    expect(new Set(keys).size).toBe(4)
  })

  it('uses only real fields for independent wall actions', () => {
    const state = makeInitialState()
    expect(getLearningActionKeyQ3(state, { type: 'wall', pos: { x: 2, y: 2 }, dir: 'left' })).toBe(
      'wall|2|2|left',
    )
  })

  it('supports movement without followUp', () => {
    const state = makeInitialState()
    expect(
      getLearningActionKeyQ3(state, { type: 'move', from: { x: 1, y: 1 }, pos: { x: 2, y: 1 } }),
    ).toBe('move|1|1|2|1')
  })

  it('normalizes top and bottom for B', () => {
    const state = makeInitialState()
    state.turn = 'B'
    expect(getLearningActionKeyQ3(state, { type: 'wall', pos: { x: 2, y: 5 }, dir: 'top' })).toBe(
      'wall|2|1|bottom',
    )
  })

  it('builds the Q-table key with the existing separator', () => {
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }

    expect(getLearningQTableKeyQ3(state, action)).toBe(
      `${getLearningStateKeyQ3(state)}|||${getLearningActionKeyQ3(state, action)}`,
    )
  })

  it('does not change Q1/Q2 key helpers', () => {
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }

    expect(getLearningStateKey(state)).toBe('placing|R|2|2|0')
    expect(getLearningActionKey(action)).toBe('place|3|3')
  })
})
