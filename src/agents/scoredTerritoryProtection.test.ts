import { describe, expect, it } from 'vitest'
import { applyFullAction } from '@/engine/gameSimulator'
import { searchBestAction } from '@/engine/mcts/MCTS'
import { DEFAULT_MCTS_CONFIG } from '@/engine/mcts/types'
import type { PlayerAction } from '@/lib/types'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { floodRegions } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'
import {
  analyzeScoredTerritoryMove,
  chooseWithScoredTerritoryProtection,
  shouldKeepTerritoryLosingAction,
} from './scoredTerritoryProtection'

function scoredCorridorFixture() {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = 'B'
  state.stonesPlaced = { R: 4, B: 4 }
  for (const [x, y] of [
    [0, 0],
    [4, 0],
    [4, 2],
    [6, 1],
  ])
    state.board[y][x].stone = 'B'
  for (const [x, y] of [
    [4, 4],
    [6, 4],
    [4, 6],
    [6, 6],
  ])
    state.board[y][x].stone = 'R'
  state.board[0][2].wallLeft = 'B'
  state.board[1][3].wallLeft = 'B'
  for (let x = 0; x < 3; x++) state.board[2][x].wallTop = 'B'
  state.board[1][2].wallTop = 'B'
  return state
}

function originMoves(state: ReturnType<typeof scoredCorridorFixture>): PlayerAction[] {
  return getLegalActions(state).filter(
    (action) => action.type === 'move' && action.from?.x === 0 && action.from.y === 0,
  )
}

describe('scored territory move protection (experimental, not wired to official MCTS)', () => {
  it('locates an own stone inside a real five-cell component scored by the engine', () => {
    const state = scoredCorridorFixture()
    const map = getTerritoryMap(state.board)
    expect(map.flat().filter((owner) => owner === 'B')).toHaveLength(5)
    const component = floodRegions(state.board).find((region) =>
      region.cells.some(({ x, y }) => x === 0 && y === 0),
    )
    expect(component?.cells).toHaveLength(5)
    expect(component?.borderingCounts).toEqual({ R: 0, B: 1 })
  })

  it('distinguishes A, which stays in the component and keeps all five points', () => {
    const state = scoredCorridorFixture()
    const action = originMoves(state).find((candidate) => {
      const analysis = analyzeScoredTerritoryMove(state, candidate)
      return analysis?.internalWithoutTerritoryLoss
    })
    const analysis = analyzeScoredTerritoryMove(state, action!)
    expect(analysis).toMatchObject({
      territoryBefore: 5,
      territoryAfter: 5,
      internalWithoutTerritoryLoss: true,
      losesScoredTerritory: false,
    })
  })

  it('distinguishes B and identifies exactly cell (2,1) as no longer scored', () => {
    const state = scoredCorridorFixture()
    const action = originMoves(state).find(
      (candidate) => analyzeScoredTerritoryMove(state, candidate)?.losesScoredTerritory,
    )
    const analysis = analyzeScoredTerritoryMove(state, action!)
    expect(analysis).toMatchObject({
      territoryBefore: 5,
      territoryAfter: 4,
      losesScoredTerritory: true,
      lostCells: [{ x: 2, y: 1 }],
    })
    expect(getTerritoryMap(applyFullAction(state, action!).state.board)[1][2]).toBe(null)
  })

  it('proves that no legal move can leave a completely closed scored component', () => {
    const state = scoredCorridorFixture()
    const component = analyzeScoredTerritoryMove(state, originMoves(state)[0]!)!.originComponent
    expect(
      originMoves(state).every((action) =>
        component.some(({ x, y }) => x === action.pos.x && y === action.pos.y),
      ),
    ).toBe(true)
  })

  it('changes a higher-ranked B selection to a legal score-preserving alternative', () => {
    const state = scoredCorridorFixture()
    const losing = originMoves(state).find(
      (action) => analyzeScoredTerritoryMove(state, action)?.losesScoredTerritory,
    )!
    const preserving = originMoves(state).find(
      (action) => analyzeScoredTerritoryMove(state, action)?.internalWithoutTerritoryLoss,
    )!
    const withoutProtection = losing
    const withProtection = chooseWithScoredTerritoryProtection({
      state,
      selected: losing,
      candidates: [
        { action: losing, visits: 100, value: 1 },
        { action: preserving, visits: 90, value: 0.9 },
      ],
      replacementMode: 'expanded-only',
    })
    expect(withoutProtection).toEqual(losing)
    expect(withProtection).toMatchObject({
      action: preserving,
      changed: true,
      reason: 'scored-territory-loss-blocked',
    })
  })

  it('changes an actual raw MCTS B selection while the unprotected result keeps it', () => {
    const state = scoredCorridorFixture()
    let raw: ReturnType<typeof searchBestAction> | undefined
    for (let seed = 1; seed <= 500 && !raw; seed++) {
      const candidate = searchBestAction(
        state,
        'B',
        {
          ...DEFAULT_MCTS_CONFIG,
          simulations: 1,
          maxDepth: 1,
          tacticalVerification: false,
        },
        seededRng(seed),
      )
      if (analyzeScoredTerritoryMove(state, candidate.action)?.losesScoredTerritory) raw = candidate
    }
    expect(raw).toBeDefined()
    const protectedResult = chooseWithScoredTerritoryProtection({
      state,
      selected: raw!.action,
      candidates: raw!.children,
      replacementMode: 'blind-conservative',
    })
    expect(analyzeScoredTerritoryMove(state, raw!.action)?.losesScoredTerritory).toBe(true)
    expect(protectedResult.changed).toBe(true)
    expect(
      analyzeScoredTerritoryMove(state, protectedResult.action)?.losesScoredTerritory,
    ).not.toBe(true)
  })

  it('compares expanded-only, tactical and blind replacement when only B was expanded', () => {
    const state = scoredCorridorFixture()
    const losing = originMoves(state).find(
      (action) => analyzeScoredTerritoryMove(state, action)?.losesScoredTerritory,
    )!
    const input = {
      state,
      selected: losing,
      candidates: [{ action: losing, visits: 100, value: 1 }],
    }
    expect(
      chooseWithScoredTerritoryProtection({ ...input, replacementMode: 'expanded-only' }),
    ).toMatchObject({ action: losing, changed: false })
    expect(
      chooseWithScoredTerritoryProtection({ ...input, replacementMode: 'tactical-conservative' }),
    ).toMatchObject({
      changed: true,
      replacementSource: 'tactical-legal',
    })
    expect(
      chooseWithScoredTerritoryProtection({ ...input, replacementMode: 'blind-conservative' }),
    ).toMatchObject({
      changed: true,
      replacementSource: 'blind-legal',
    })
  })

  it('uses A only as a tie-break and leaves a strictly better-ranked A unchanged', () => {
    const state = scoredCorridorFixture()
    const internal = originMoves(state).find(
      (action) => analyzeScoredTerritoryMove(state, action)?.internalWithoutTerritoryLoss,
    )!
    const outside = getLegalActions(state).find(
      (action) => action.type === 'move' && action.from?.x === 4,
    )!
    expect(
      chooseWithScoredTerritoryProtection({
        state,
        selected: internal,
        candidates: [
          { action: internal, visits: 100, value: 1 },
          { action: outside, visits: 99, value: 2 },
        ],
      }),
    ).toMatchObject({ action: internal, changed: false })
  })

  it('uses A as the last tie-break when an equal candidate develops unscored space', () => {
    const state = scoredCorridorFixture()
    const internal = originMoves(state).find(
      (action) => analyzeScoredTerritoryMove(state, action)?.internalWithoutTerritoryLoss,
    )!
    const development = getLegalActions(state).find(
      (action) =>
        action.type === 'move' &&
        action.from?.x === 4 &&
        getTerritoryMap(state.board)[action.pos.y][action.pos.x] === null,
    )!
    expect(
      chooseWithScoredTerritoryProtection({
        state,
        selected: internal,
        candidates: [
          { action: internal, visits: 100, value: 1 },
          { action: development, visits: 100, value: 1 },
        ],
      }),
    ).toMatchObject({
      action: development,
      changed: true,
      reason: 'internal-move-tiebreak',
    })
  })

  it('does not modify a selected movement outside already scored territory', () => {
    const state = scoredCorridorFixture()
    const outside = getLegalActions(state).find(
      (action) => action.type === 'move' && action.from?.x === 4,
    )!
    expect(analyzeScoredTerritoryMove(state, outside)).toBeUndefined()
    expect(
      chooseWithScoredTerritoryProtection({
        state,
        selected: outside,
        candidates: [{ action: outside, visits: 10, value: 1 }],
      }),
    ).toMatchObject({ action: outside, changed: false, reason: 'unchanged' })
  })

  it('keeps an own-point loss that removes more rival territory and improves the differential', () => {
    expect(
      shouldKeepTerritoryLosingAction({
        terminalWin: false,
        legalConservativeAlternatives: 3,
        deltaDifferentialOriginal: 2,
        bestConservativeDeltaDifferential: 0,
      }),
    ).toBe(true)
  })

  it('keeps a terminal winning action even when it loses scored territory', () => {
    expect(
      shouldKeepTerritoryLosingAction({
        terminalWin: true,
        legalConservativeAlternatives: 3,
        deltaDifferentialOriginal: -2,
        bestConservativeDeltaDifferential: 0,
      }),
    ).toBe(true)
  })

  it('does not filter when no legal conservative alternative exists', () => {
    expect(
      shouldKeepTerritoryLosingAction({
        terminalWin: false,
        legalConservativeAlternatives: 0,
        deltaDifferentialOriginal: -1,
        bestConservativeDeltaDifferential: -Infinity,
      }),
    ).toBe(true)
  })

  it('is independent of candidate enumeration order', () => {
    const state = scoredCorridorFixture()
    const losing = originMoves(state).find(
      (action) => analyzeScoredTerritoryMove(state, action)?.losesScoredTerritory,
    )!
    const candidates = originMoves(state)
      .filter((action) => !analyzeScoredTerritoryMove(state, action)?.losesScoredTerritory)
      .slice(0, 3)
      .map((action) => ({ action, visits: 10, value: 1 }))
    const forward = chooseWithScoredTerritoryProtection({
      state,
      selected: losing,
      candidates,
      replacementMode: 'expanded-only',
    })
    const reverse = chooseWithScoredTerritoryProtection({
      state,
      selected: losing,
      candidates: [...candidates].reverse(),
      replacementMode: 'expanded-only',
    })
    expect(reverse.action).toEqual(forward.action)
  })
})

function seededRng(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let next = value
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296
  }
}
