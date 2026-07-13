import { describe, expect, it, vi } from 'vitest'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { createEmptyBoard, makeInitialState, snapshotFromState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { searchBestAction } from './MCTS'
import type { MCTSConfig } from './types'

const QUICK_CONFIG: MCTSConfig = {
  simulations: 12,
  explorationConstant: Math.SQRT2,
  maxDepth: 2,
  rolloutPolicy: 'random',
}

function seededRng(initialSeed: number): () => number {
  let seed = initialSeed >>> 0
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

function makePlayingState(): GameSnapshot {
  const state = makeInitialState()
  state.phase = 'playing'
  state.turn = 'R'
  state.stonesPlaced = { R: 4, B: 4 }
  return state
}

function makeSingleActionTieState(): GameSnapshot {
  const state = makePlayingState()
  state.board = createEmptyBoard()
  state.board[0][0].stone = 'R'
  state.board[1][0].stone = 'B'
  state.board[0][1].wallLeft = 'R'
  state.board[1][1].wallLeft = 'B'
  state.board[2][0].wallTop = 'B'
  return state
}

function makeTacticalState(): GameSnapshot {
  const state = makePlayingState()
  state.board = createEmptyBoard()
  state.board[4][2].stone = 'R'
  state.board[1][4].stone = 'B'

  const topWalls: Array<[number, number, Player]> = [
    [0, 1, 'R'],
    [1, 1, 'B'],
    [2, 1, 'R'],
    [3, 1, 'B'],
    [2, 4, 'B'],
    [4, 5, 'R'],
    [5, 5, 'R'],
    [3, 6, 'R'],
  ]
  const leftWalls: Array<[number, number, Player]> = [
    [4, 1, 'R'],
    [4, 2, 'R'],
    [4, 3, 'B'],
    [2, 4, 'R'],
    [2, 5, 'B'],
    [6, 5, 'R'],
    [2, 6, 'R'],
    [6, 6, 'B'],
  ]
  for (const [x, y, player] of topWalls) state.board[y][x].wallTop = player
  for (const [x, y, player] of leftWalls) state.board[y][x].wallLeft = player
  return state
}

function makeAvoidLossState(): GameSnapshot {
  const state = makePlayingState()
  state.board = createEmptyBoard()
  state.board[0][5].stone = 'R'
  state.board[1][3].stone = 'B'
  state.board[1][6].wallLeft = 'R'
  state.board[2][5].wallTop = 'R'
  state.board[2][6].wallTop = 'B'
  return state
}

function searchTacticalState() {
  return searchBestAction(
    makeTacticalState(),
    'R',
    { simulations: 120, explorationConstant: Math.SQRT2, maxDepth: 1, rolloutPolicy: 'random' },
    seededRng(17),
  )
}

function actionKey(action: PlayerAction): string {
  return JSON.stringify(action)
}

describe('searchBestAction', () => {
  it('returns a legal action', () => {
    const state = makeInitialState()
    const result = searchBestAction(state, 'R', QUICK_CONFIG, seededRng(1))

    expect(getLegalActions(state)).toContainEqual(result.action)
  })

  it('does not modify the root state', () => {
    const state = makeInitialState()
    state.legal = new Set(['1,2'])
    const before = snapshotFromState(state)

    searchBestAction(state, 'R', QUICK_CONFIG, seededRng(2))

    expect(state).toEqual(before)
  })

  it('performs exactly the configured number of simulations', () => {
    const result = searchBestAction(makeInitialState(), 'R', QUICK_CONFIG, seededRng(3))
    const childVisits = result.children.reduce((total, child) => total + child.visits, 0)

    expect(childVisits).toBe(QUICK_CONFIG.simulations)
  })

  it('accumulates every simulation as a root visit', () => {
    const result = searchBestAction(makeInitialState(), 'R', QUICK_CONFIG, seededRng(4))

    expect(result.rootVisits).toBe(QUICK_CONFIG.simulations)
  })

  it('does not generate duplicate children', () => {
    const result = searchBestAction(makeInitialState(), 'R', QUICK_CONFIG, seededRng(5))
    const keys = result.children.map((child) => actionKey(child.action))

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is deterministic when supplied the same RNG sequence', () => {
    const first = searchBestAction(makeInitialState(), 'R', QUICK_CONFIG, seededRng(6))
    const second = searchBestAction(makeInitialState(), 'R', QUICK_CONFIG, seededRng(6))

    expect(first).toEqual(second)
  })

  it('selects an available immediate win', () => {
    const state = makeTacticalState()
    const winningActions = getLegalActions(state).filter(
      (action) => applyFullAction(state, action).state.result?.winner === 'R',
    )
    const result = searchTacticalState()

    expect(winningActions.length).toBeGreaterThan(0)
    expect(winningActions).toContainEqual(result.action)
    expect(result.value).toBe(1)
  })

  it('avoids an immediate loss when a safe action exists', () => {
    const state = makeAvoidLossState()
    const actions = getLegalActions(state)
    const losingActions = actions.filter(
      (action) => applyFullAction(state, action).state.result?.winner === 'B',
    )
    const safeActions = actions.filter(
      (action) => applyFullAction(state, action).state.result?.winner !== 'B',
    )
    const result = searchBestAction(
      state,
      'R',
      { simulations: 120, explorationConstant: Math.SQRT2, maxDepth: 1, rolloutPolicy: 'random' },
      seededRng(18),
    )

    expect(losingActions.length).toBeGreaterThan(0)
    expect(safeActions.length).toBeGreaterThan(0)
    expect(actions.some((action) => applyFullAction(state, action).state.result?.winner === 'R')).toBe(
      false,
    )
    expect(losingActions).not.toContainEqual(result.action)
  })

  it('backs up zero for a terminal tie', () => {
    const state = makeSingleActionTieState()
    const result = searchBestAction(
      state,
      'R',
      { simulations: 4, explorationConstant: Math.SQRT2, maxDepth: 2, rolloutPolicy: 'random' },
      seededRng(7),
    )

    expect(applyFullAction(state, result.action).state.result?.tie).toBe(true)
    expect(result.value).toBe(0)
  })

  it('works with placement actions', () => {
    const result = searchBestAction(
      makeInitialState(),
      'R',
      { simulations: 1, explorationConstant: Math.SQRT2, maxDepth: 1, rolloutPolicy: 'random' },
      () => 0,
    )

    expect(result.action.type).toBe('place')
  })

  it('works with movement actions and their follow-up wall', () => {
    const result = searchBestAction(
      makePlayingState(),
      'R',
      { simulations: 1, explorationConstant: Math.SQRT2, maxDepth: 1, rolloutPolicy: 'random' },
      () => 0,
    )

    expect(result.action.type).toBe('move')
    expect(result.action.followUp?.type).toBe('wall')
  })

  it('works with wall actions', () => {
    const result = searchBestAction(
      makePlayingState(),
      'R',
      { simulations: 1, explorationConstant: Math.SQRT2, maxDepth: 1, rolloutPolicy: 'random' },
      () => 1,
    )

    expect(result.action.type).toBe('wall')
  })

  it('never assigns more child visits than root visits', () => {
    const result = searchBestAction(makeInitialState(), 'R', QUICK_CONFIG, seededRng(8))
    const childVisits = result.children.reduce((total, child) => total + child.visits, 0)

    expect(childVisits).toBeLessThanOrEqual(result.rootVisits)
  })

  it('keeps every reported mean value between minus one and one', () => {
    const result = searchTacticalState()

    expect(result.value).toBeGreaterThanOrEqual(-1)
    expect(result.value).toBeLessThanOrEqual(1)
    for (const child of result.children) {
      expect(child.value).toBeGreaterThanOrEqual(-1)
      expect(child.value).toBeLessThanOrEqual(1)
    }
  })

  it('returns the only legal action when there is exactly one', () => {
    const state = makeSingleActionTieState()
    const legalActions = getLegalActions(state)
    const result = searchBestAction(state, 'R', QUICK_CONFIG, seededRng(9))

    expect(legalActions).toHaveLength(1)
    expect(result.action).toEqual(legalActions[0])
  })
})

describe('MCTS rollout policies', () => {
  const rolloutConfig = (
    rolloutPolicy: MCTSConfig['rolloutPolicy'],
    heuristicProbability?: number,
    maxDepth = 4,
  ): MCTSConfig => ({
    simulations: 10,
    explorationConstant: Math.SQRT2,
    maxDepth,
    rolloutPolicy,
    heuristicProbability,
  })

  it('keeps random rollouts deterministic with the same seed', () => {
    const first = searchBestAction(makeInitialState(), 'R', rolloutConfig('random'), seededRng(20))
    const second = searchBestAction(makeInitialState(), 'R', rolloutConfig('random'), seededRng(20))

    expect(first).toEqual(second)
  })

  it('returns a legal action with heuristic rollouts', () => {
    const state = makeInitialState()
    const result = searchBestAction(state, 'R', rolloutConfig('heuristic'), seededRng(21))

    expect(getLegalActions(state)).toContainEqual(result.action)
  })

  it('makes mixed probability one equivalent to heuristic with the same RNG', () => {
    const heuristic = searchBestAction(
      makeInitialState(),
      'R',
      rolloutConfig('heuristic'),
      seededRng(22),
    )
    const mixed = searchBestAction(
      makeInitialState(),
      'R',
      rolloutConfig('mixed', 1),
      seededRng(22),
    )

    expect(mixed).toEqual(heuristic)
  })

  it('makes mixed probability zero equivalent to random with the same RNG', () => {
    const random = searchBestAction(
      makeInitialState(),
      'R',
      rolloutConfig('random'),
      seededRng(23),
    )
    const mixed = searchBestAction(
      makeInitialState(),
      'R',
      rolloutConfig('mixed', 0),
      seededRng(23),
    )

    expect(mixed).toEqual(random)
  })

  it('does not call uncontrolled Math.random when an RNG is supplied', () => {
    const uncontrolledRandom = vi.spyOn(Math, 'random')

    searchBestAction(makeInitialState(), 'R', rolloutConfig('heuristic'), seededRng(24))

    expect(uncontrolledRandom).not.toHaveBeenCalled()
    uncontrolledRandom.mockRestore()
  })

  it('respects maxDepth for all three rollout policies', () => {
    const results = (['random', 'mixed', 'heuristic'] as const).map((policy) =>
      searchBestAction(makeInitialState(), 'R', rolloutConfig(policy, 0.8, 1), seededRng(25)),
    )

    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
  })

  it('keeps reported values between minus one and one for every rollout policy', () => {
    for (const policy of ['random', 'mixed', 'heuristic'] as const) {
      const result = searchBestAction(
        makeInitialState(),
        'R',
        rolloutConfig(policy),
        seededRng(26),
      )
      expect(result.value).toBeGreaterThanOrEqual(-1)
      expect(result.value).toBeLessThanOrEqual(1)
      expect(result.children.every((child) => child.value >= -1 && child.value <= 1)).toBe(true)
    }
  })

  it('does not modify the root state under any rollout policy', () => {
    for (const policy of ['random', 'mixed', 'heuristic'] as const) {
      const state = makeInitialState()
      state.legal = new Set(['1,2'])
      const before = snapshotFromState(state)

      searchBestAction(state, 'R', rolloutConfig(policy), seededRng(27))

      expect(state).toEqual(before)
    }
  })
})
