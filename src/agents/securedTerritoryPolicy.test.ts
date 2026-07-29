import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeWallOnlyTurnFixture } from '@/fixtures/wallOnlyTurn'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { countTerritoryQ3, calculatePlayerMobilityQ3 } from './learningPolicyQ3'
import {
  analyzeSecuredTerritory,
  chooseSecuredTerritoryCandidate,
  filterSecuredTerritoryMovements,
  isClearlyUselessSecuredMovement,
} from './securedTerritoryPolicy'

function playing() {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = 'R'
  state.stonesPlaced = { R: 4, B: 4 }
  return state
}

function securedButNonTerminal(player: 'R' | 'B' = 'B') {
  const state = playing()
  state.turn = player
  const opponent = player === 'R' ? 'B' : 'R'
  for (const [x, y] of [
    [0, 0],
    [0, 1],
    [1, 1],
  ])
    state.board[y][x].stone = player
  state.board[0][2].wallLeft = player
  state.board[1][2].wallLeft = player
  state.board[2][0].wallTop = player
  state.board[2][1].wallTop = player
  state.board[4][4].stone = player
  for (const [x, y] of [
    [4, 5],
    [5, 4],
    [5, 5],
    [6, 6],
  ])
    state.board[y][x].stone = opponent
  return state
}

function swapColors(state: ReturnType<typeof securedButNonTerminal>) {
  const swap = (value: 'R' | 'B' | null) =>
    value === 'R' ? ('B' as const) : value === 'B' ? ('R' as const) : null
  return {
    ...structuredClone(state),
    board: state.board.map((row) =>
      row.map((cell) => ({
        stone: swap(cell.stone),
        wallTop: swap(cell.wallTop),
        wallLeft: swap(cell.wallLeft),
      })),
    ),
    turn: swap(state.turn)!,
    stonesPlaced: { R: state.stonesPlaced.B, B: state.stonesPlaced.R },
    legal: new Set<string>(),
  }
}

describe('secured territory policy', () => {
  it('records the definitive negative-counterfactual rejection', () => {
    const report = JSON.parse(
      readFileSync(
        'data/diagnostics/secured-territory-behaviour/counterfactual-report.json',
        'utf8',
      ),
    )
    expect(report.decision).toEqual({
      status: 'rejected',
      accepted: false,
      reason: 'negative-counterfactual-effect',
    })
    expect(report.uniqueInterventions).toBe(4)
    expect(report.classifications).toMatchObject({ beneficial: 1, harmful: 3 })
    expect(report.meanTerritoryEffect).toBe(-1.55)
    expect(report.bootstrapMeanTerritoryEffect95).toEqual([-2.9, -0.3])
  })

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

  it.each(['R', 'B'] as const)(
    'rejects only a demonstrably redundant internal move for %s',
    (player) => {
      const state = securedButNonTerminal(player)
      const redundant = getLegalActions(state).find(
        (action) => action.type === 'move' && isClearlyUselessSecuredMovement(state, action),
      )
      expect(redundant).toBeDefined()
    },
  )

  it('keeps a movement by the frontier stone outside the secured component', () => {
    const state = securedButNonTerminal()
    const strategic = getLegalActions(state).find(
      (action) =>
        action.type === 'move' &&
        action.from?.x === 4 &&
        action.from.y === 4 &&
        !isClearlyUselessSecuredMovement(state, action),
    )
    expect(strategic).toBeDefined()
  })

  it('never removes wall-only actions or leaves an empty candidate set', () => {
    const state = securedButNonTerminal()
    const legal = getLegalActions(state)
    const filtered = filterSecuredTerritoryMovements(state, legal)
    expect(filtered.actions.length).toBeGreaterThan(0)
    expect(
      legal
        .filter((action) => action.type === 'wall')
        .every((wall) => filtered.actions.includes(wall)),
    ).toBe(true)
    expect(filtered.usedFallback).toBe(false)
  })

  it('is invariant under an exact R/B color exchange', () => {
    const blue = securedButNonTerminal('B')
    const red = swapColors(blue)
    const blueActions = getLegalActions(blue)
    const redActions = getLegalActions(red)
    expect(redActions).toEqual(blueActions)
    expect(countTerritoryQ3(red)).toEqual({
      R: countTerritoryQ3(blue).B,
      B: countTerritoryQ3(blue).R,
    })
    expect(calculatePlayerMobilityQ3(red, 'R')).toEqual(calculatePlayerMobilityQ3(blue, 'B'))
    expect(redActions.map((action) => isClearlyUselessSecuredMovement(red, action))).toEqual(
      blueActions.map((action) => isClearlyUselessSecuredMovement(blue, action)),
    )
  })
})
