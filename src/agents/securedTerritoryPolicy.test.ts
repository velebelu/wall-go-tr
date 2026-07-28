import { describe, expect, it } from 'vitest'
import { makeWallOnlyTurnFixture } from '@/fixtures/wallOnlyTurn'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import {
  analyzeSecuredTerritory,
  chooseSecuredTerritoryCandidate,
  filterSecuredTerritoryMovements,
} from './securedTerritoryPolicy'

function playing() {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = 'R'
  state.stonesPlaced = { R: 4, B: 4 }
  return state
}

describe('secured territory policy', () => {
  it('marks stones in a completely closed own-only region with traceable evidence', () => {
    const state = makeWallOnlyTurnFixture('B')
    const analysis = analyzeSecuredTerritory(state, 'B')
    expect(analysis.inactiveKeys).toContain('0,0')
    expect(analysis.inactiveStones[0]?.reasons).toContain(
      'opponent-cannot-enter-without-crossing-wall',
    )
  })

  it('does not mark an apparently own region still reachable by the opponent', () => {
    const state = playing()
    state.board[1][1].stone = 'R'
    state.board[5][5].stone = 'B'
    expect(analyzeSecuredTerritory(state, 'R').inactiveStones).toHaveLength(0)
  })

  it('marks an irrelevant interior stone but keeps a frontier stone active', () => {
    const closed = makeWallOnlyTurnFixture('B')
    expect(analyzeSecuredTerritory(closed, 'B').inactiveKeys).toContain('1,1')
    closed.board[1][2].wallLeft = null
    closed.board[3][3].stone = 'R'
    expect(analyzeSecuredTerritory(closed, 'B').inactiveKeys).not.toContain('1,1')
  })

  it('handles several independent secured regions', () => {
    const state = playing()
    state.board[0][0].stone = 'R'
    state.board[6][6].stone = 'R'
    state.board[3][3].stone = 'B'
    state.board[0][1].wallLeft = 'R'
    state.board[1][0].wallTop = 'R'
    state.board[6][6].wallLeft = 'R'
    state.board[6][6].wallTop = 'R'
    expect(analyzeSecuredTerritory(state, 'R').inactiveStones).toHaveLength(2)
  })

  it('keeps useful walls when all own stones are secured and no movement is recommended', () => {
    const state = makeWallOnlyTurnFixture('B')
    const filtered = filterSecuredTerritoryMovements(state, getLegalActions(state))
    expect(filtered.actions.length).toBeGreaterThan(0)
    expect(filtered.actions.every((action) => action.type === 'wall')).toBe(true)
    expect(filtered.usedFallback).toBe(false)
  })

  it('falls back safely if a synthetic candidate set contains only excluded moves', () => {
    const state = makeWallOnlyTurnFixture('B')
    const move = {
      type: 'move',
      from: { x: 0, y: 0 },
      pos: { x: 1, y: 0 },
    } as const
    const filtered = filterSecuredTerritoryMovements(state, [move])
    expect(filtered.actions).toEqual([move])
    expect(filtered.usedFallback).toBe(true)
  })

  it('chooses deterministically from equal candidate input', () => {
    const state = makeWallOnlyTurnFixture('B')
    const walls = getLegalActions(state).filter((action) => action.type === 'wall')
    const selected = {
      type: 'move',
      from: { x: 0, y: 0 },
      pos: { x: 1, y: 0 },
    } as const
    const input = {
      state,
      selected,
      candidates: walls.slice(0, 2).map((action) => ({ action, visits: 5, value: 0 })),
    }
    expect(chooseSecuredTerritoryCandidate(input).action).toEqual(
      chooseSecuredTerritoryCandidate(input).action,
    )
  })
})
