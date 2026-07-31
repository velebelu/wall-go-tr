import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, PlayerAction, Pos } from '@/lib/types'
import { calculatePlayerMobilityQ3, countTerritoryQ3 } from './learningPolicyQ3'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { floodRegions } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'

function playing(): GameSnapshot {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = 'R'
  state.stonesPlaced = { R: 4, B: 4 }
  return state
}

function closeTopLeftRectangle(state: GameSnapshot, width: number, height: number): void {
  for (let y = 0; y < height; y++) state.board[y][width].wallLeft = 'R'
  for (let x = 0; x < width; x++) state.board[height][x].wallTop = 'R'
}

function regionAt(state: GameSnapshot, position: Pos) {
  return floodRegions(state.board).find(({ cells }) =>
    cells.some(({ x, y }) => x === position.x && y === position.y),
  )!
}

describe('diagnosis: scored own-only wall components', () => {
  it('scores a closed component containing one own stone', () => {
    const state = playing()
    state.board[0][0].stone = 'R'
    closeTopLeftRectangle(state, 1, 1)

    expect(regionAt(state, { x: 0, y: 0 })).toMatchObject({
      borderingCounts: { R: 1, B: 0 },
    })
    expect(getTerritoryMap(state.board)[0][0]).toBe('R')
    expect(countTerritoryQ3(state)).toEqual({ R: 1, B: 0 })
  })

  it('scores every cell in a closed component containing several own stones', () => {
    const state = playing()
    state.board[0][0].stone = 'R'
    state.board[1][1].stone = 'R'
    closeTopLeftRectangle(state, 2, 2)

    expect(regionAt(state, { x: 0, y: 0 })).toMatchObject({
      cells: expect.arrayContaining([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ]),
      borderingCounts: { R: 2, B: 0 },
    })
    expect(countTerritoryQ3(state)).toEqual({ R: 4, B: 0 })
    expect(
      getLegalActions(state).some(
        (action) => action.type === 'move' && action.from?.x === 0 && action.from.y === 0,
      ),
    ).toBe(true)
  })

  it('does not score an apparently own area that is still connected to the opponent', () => {
    const state = playing()
    state.board[0][0].stone = 'R'
    state.board[6][6].stone = 'B'

    expect(regionAt(state, { x: 0, y: 0 }).borderingCounts).toEqual({ R: 1, B: 1 })
    expect(countTerritoryQ3(state)).toEqual({ R: 0, B: 0 })
  })

  it('does not score a closed component containing both players', () => {
    const state = playing()
    state.board[0][0].stone = 'R'
    state.board[1][1].stone = 'B'
    closeTopLeftRectangle(state, 2, 2)

    expect(regionAt(state, { x: 0, y: 0 }).borderingCounts).toEqual({ R: 1, B: 1 })
    expect(countTerritoryQ3(state)).toEqual({ R: 0, B: 0 })
  })

  it('allows an internal move whose mandatory wall legitimately loses an empty subcomponent', () => {
    const state = playing()
    state.board[0][0].stone = 'R'
    closeTopLeftRectangle(state, 1, 2)
    const action = getLegalActions(state).find(
      (candidate) =>
        candidate.type === 'move' &&
        candidate.from?.x === 0 &&
        candidate.from.y === 0 &&
        candidate.pos.x === 0 &&
        candidate.pos.y === 1 &&
        candidate.followUp?.type === 'wall' &&
        candidate.followUp.dir === 'top',
    )

    expect(action).toBeDefined()
    expect(countTerritoryQ3(state)).toEqual({ R: 2, B: 0 })
    expect(countTerritoryQ3(applyFullAction(state, action!).state)).toEqual({ R: 1, B: 0 })
  })

  it('reproduces V3-R1 P01 game 2 turn 40 as an isolated scored move', () => {
    const trace = JSON.parse(
      readFileSync(
        'data/human-experiment/final-2026-v3-r1/participants/P01/traces/game-2.json',
        'utf8',
      ),
    ) as { decisions: Array<Record<string, unknown>> }
    const decision = trace.decisions.find(({ turnIndex }) => turnIndex === 40) as {
      player: 'R'
      actor: 'mcts'
      stateBefore: GameSnapshot & { legal: string[] }
      stateAfter: GameSnapshot & { legal: string[] }
      action: PlayerAction
      metricsBefore: { territory: { R: number; B: number } }
      metricsAfter: { territory: { R: number; B: number } }
      mcts: { tacticalSelectionChanged: boolean; verifiedScore: number }
    }
    const before = { ...decision.stateBefore, legal: new Set(decision.stateBefore.legal) }
    const after = { ...decision.stateAfter, legal: new Set(decision.stateAfter.legal) }
    const source = decision.action.type === 'move' ? decision.action.from! : { x: -1, y: -1 }
    const component = regionAt(before, source)

    expect(decision.actor).toBe('mcts')
    expect(decision.action).toEqual({
      type: 'move',
      from: { x: 3, y: 5 },
      pos: { x: 5, y: 5 },
      followUp: {
        type: 'wall',
        from: { x: 5, y: 5 },
        pos: { x: 5, y: 5 },
        dir: 'bottom',
      },
    })
    expect(component.cells).toHaveLength(21)
    expect(component.borderingCounts).toEqual({ R: 2, B: 0 })
    expect(decision.metricsBefore.territory).toEqual({ R: 22, B: 3 })
    expect(decision.metricsAfter.territory).toEqual({ R: 22, B: 3 })
    expect(floodRegions(after.board).map(({ cells }) => cells.length)).toEqual(
      floodRegions(before.board).map(({ cells }) => cells.length),
    )
    expect(calculatePlayerMobilityQ3(after, 'R').totalDestinations).toBe(
      calculatePlayerMobilityQ3(before, 'R').totalDestinations + 3,
    )
    expect(decision.mcts).toMatchObject({ tacticalSelectionChanged: true, verifiedScore: 126 })
  })
})
