import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Q5_CHECKPOINT_SHA256, Q5_CHECKPOINT_SOURCE } from '@/agents/Q5LearningAgent'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { createEmptyBoard, makeInitialState, snapshotFromState } from '@/store/gameState'
import { getBestHeuristicAction, getLegalActions, scoreHeuristicAction } from '@/utils/ai'
import { chooseBestTacticalEvaluation, searchBestAction } from './MCTS'
import {
  MCTSNode,
  normalizeMinMax,
  orderActionsForExpansion,
  scoreActionsForExpansion,
} from './MCTSNode'
import {
  DEFAULT_WIDENING_CONSTANT,
  DEFAULT_WIDENING_EXPONENT,
  type MCTSConfig,
  type MCTSQPriorSource,
} from './types'

const QUICK_CONFIG: MCTSConfig = {
  simulations: 12,
  explorationConstant: Math.SQRT2,
  maxDepth: 2,
  rolloutPolicy: 'random',
}

describe('MCTS tactical verification', () => {
  const tacticalConfig: MCTSConfig = {
    simulations: 12,
    explorationConstant: Math.SQRT2,
    maxDepth: 3,
    rolloutPolicy: 'mixed',
    heuristicProbability: 0.8,
    expansionPolicy: 'heuristic',
    progressiveWidening: true,
    wideningConstant: 2,
    wideningExponent: 0.5,
    tacticalVerification: true,
    tacticalCandidateCount: 3,
  }

  it('desactivada conserva exactamente el comportamiento anterior', () => {
    const state = makePlayingState()
    const implicit = searchBestAction(state, 'R', QUICK_CONFIG, seededRng(91))
    const explicit = searchBestAction(
      state, 'R', { ...QUICK_CONFIG, tacticalVerification: false }, seededRng(91),
    )
    expect(explicit).toEqual(implicit)
  })

  it('devuelve una accion legal, no muta la raiz y limita candidatos a hijos', () => {
    const state = makePlayingState()
    const before = structuredClone(state)
    const result = searchBestAction(state, 'R', tacticalConfig, seededRng(12))
    expect(getLegalActions(state)).toContainEqual(result.action)
    expect(state).toEqual(before)
    expect(result.tacticalCandidatesChecked).toBeLessThanOrEqual(result.rootExpandedChildren)
    expect(result.tacticalCandidatesChecked).toBeLessThanOrEqual(3)
  })

  it('es determinista con la misma semilla salvo la metrica temporal', () => {
    const state = makePlayingState()
    const a = searchBestAction(state, 'R', tacticalConfig, seededRng(44))
    const b = searchBestAction(state, 'R', tacticalConfig, seededRng(44))
    const { verificationTimeMs: _a, ...stableA } = a
    const { verificationTimeMs: _b, ...stableB } = b
    expect(stableA).toEqual(stableB)
  })

  it('evita una derrota terminal inmediata y prioriza una victoria terminal', () => {
    const lose = { action: { type: 'place', pos: { x: 0, y: 0 } } as PlayerAction,
      score: -1_000_000, permitsImmediateTerminalLoss: true }
    const safe = { action: { type: 'place', pos: { x: 1, y: 0 } } as PlayerAction,
      score: 10, permitsImmediateTerminalLoss: false }
    const win = { action: { type: 'place', pos: { x: 2, y: 0 } } as PlayerAction,
      score: 1_000_000, permitsImmediateTerminalLoss: false }
    expect(chooseBestTacticalEvaluation([lose, safe], seededRng(1))).toBe(safe)
    expect(chooseBestTacticalEvaluation([safe, win], seededRng(1))).toBe(win)
  })

  it('entre opciones no terminales evita la que tiene peor puntuacion por movilidad', () => {
    const mobilityLoss = { action: { type: 'place', pos: { x: 0, y: 1 } } as PlayerAction,
      score: -20, permitsImmediateTerminalLoss: false }
    const mobilityKept = { action: { type: 'place', pos: { x: 1, y: 1 } } as PlayerAction,
      score: 4, permitsImmediateTerminalLoss: false }
    expect(chooseBestTacticalEvaluation([mobilityLoss, mobilityKept], seededRng(2)))
      .toBe(mobilityKept)
  })

  it('no carga ni modifica Q5 durante la verificacion tactica', () => {
    const before = createHash('sha256').update(readFileSync(Q5_CHECKPOINT_SOURCE)).digest('hex')
    searchBestAction(makePlayingState(), 'R', tacticalConfig, seededRng(72))
    const after = createHash('sha256').update(readFileSync(Q5_CHECKPOINT_SOURCE)).digest('hex')
    expect(before).toBe(Q5_CHECKPOINT_SHA256)
    expect(after).toBe(before)
  })
})

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

describe('MCTS expansion policies', () => {
  const mixedConfig = (overrides: Partial<MCTSConfig> = {}): MCTSConfig => ({
    simulations: 50,
    explorationConstant: Math.SQRT2,
    maxDepth: 4,
    rolloutPolicy: 'mixed',
    heuristicProbability: 0.8,
    ...overrides,
  })

  it('preserves the previous behavior with unordered expansion and no widening', () => {
    const legacy = searchBestAction(makeInitialState(), 'R', mixedConfig(), seededRng(30))
    const explicit = searchBestAction(
      makeInitialState(),
      'R',
      mixedConfig({ expansionPolicy: 'unordered', progressiveWidening: false }),
      seededRng(30),
    )

    expect(explicit).toEqual(legacy)
  })

  it('orders heuristic actions deterministically with the same seed', () => {
    const state = makePlayingState()
    const actions = getLegalActions(state)
    const first = orderActionsForExpansion(state, actions, 'heuristic', seededRng(31))
    const second = orderActionsForExpansion(state, actions, 'heuristic', seededRng(31))

    expect(first).toEqual(second)
  })

  it('does not lose or duplicate actions while ordering them', () => {
    const state = makePlayingState()
    const actions = getLegalActions(state)
    const ordered = orderActionsForExpansion(state, actions, 'heuristic', seededRng(32))
    const signatures = (items: PlayerAction[]) => items.map(actionKey).sort()

    expect(ordered).toHaveLength(actions.length)
    expect(new Set(ordered.map(actionKey)).size).toBe(actions.length)
    expect(signatures(ordered)).toEqual(signatures(actions))
  })

  it('expands one of the highest-scoring actions first', () => {
    const state = makePlayingState()
    const actions = getLegalActions(state)
    const bestScore = Math.max(...actions.map((action) => scoreHeuristicAction(state, action, 'default')))
    const result = searchBestAction(
      state,
      'R',
      mixedConfig({ simulations: 1, maxDepth: 1, expansionPolicy: 'heuristic' }),
      seededRng(33),
    )

    expect(scoreHeuristicAction(state, result.children[0].action, 'default')).toBe(bestScore)
  })

  it('progressive widening initially limits expanded children', () => {
    const result = searchBestAction(
      makeInitialState(),
      'R',
      mixedConfig({ simulations: 2, maxDepth: 1, progressiveWidening: true }),
      seededRng(34),
    )

    expect(result.rootLegalActions).toBe(getLegalActions(makeInitialState()).length)
    expect(result.rootExpandedChildren).toBe(2)
  })

  it('increases the allowed child count with visits', () => {
    const node = new MCTSNode(makeInitialState(), undefined, undefined, {
      expansionPolicy: 'unordered',
      progressiveWidening: true,
      wideningConstant: DEFAULT_WIDENING_CONSTANT,
      wideningExponent: DEFAULT_WIDENING_EXPONENT,
      rng: seededRng(35),
    })
    const initial = node.maxChildrenAllowed
    node.visits = 4
    const afterFourVisits = node.maxChildrenAllowed
    node.visits = 16

    expect(initial).toBe(1)
    expect(afterFourVisits).toBe(4)
    expect(node.maxChildrenAllowed).toBe(8)
  })

  it('can expand every legal action with enough visits', () => {
    const result = searchBestAction(
      makeInitialState(),
      'R',
      mixedConfig({
        simulations: 626,
        maxDepth: 1,
        expansionPolicy: 'heuristic',
        progressiveWidening: true,
      }),
      seededRng(36),
    )

    expect(result.rootExpandedChildren).toBe(result.rootLegalActions)
  })

  it('never exceeds the progressive widening allowance', () => {
    const result = searchBestAction(
      makeInitialState(),
      'R',
      mixedConfig({ simulations: 50, progressiveWidening: true }),
      seededRng(37),
    )
    const allowed = Math.max(
      1,
      Math.floor(DEFAULT_WIDENING_CONSTANT * result.rootVisits ** DEFAULT_WIDENING_EXPONENT),
    )

    expect(result.rootExpandedChildren).toBeLessThanOrEqual(allowed)
  })

  it('reports coherent branching and depth metrics', () => {
    const result = searchBestAction(
      makeInitialState(),
      'R',
      mixedConfig({ progressiveWidening: true }),
      seededRng(38),
    )

    expect(result.rootLegalActions).toBe(getLegalActions(makeInitialState()).length)
    expect(result.rootExpandedChildren).toBe(result.children.length)
    expect(result.maxDepthReached).toBeGreaterThan(0)
    expect(result.maxDepthReached).toBeLessThanOrEqual(4)
    expect(result.averageSelectedDepth).toBeGreaterThanOrEqual(0)
    expect(result.averageSelectedDepth).toBeLessThanOrEqual(result.maxDepthReached)
  })

  it('does not modify the root state with heuristic widening', () => {
    const state = makePlayingState()
    const before = snapshotFromState(state)

    searchBestAction(
      state,
      'R',
      mixedConfig({ expansionPolicy: 'heuristic', progressiveWidening: true }),
      seededRng(39),
    )

    expect(state).toEqual(before)
  })

  it('keeps the existing heuristic decision equal to the highest-score seeded tie choice', () => {
    const state = makePlayingState()
    const actions = getLegalActions(state)
    const scores = actions.map((action) => scoreHeuristicAction(state, action, 'default'))
    const bestScore = Math.max(...scores)
    const bestActions = actions.filter((_, index) => scores[index] === bestScore)
    const sample = 0.625
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(sample)

    const selected = getBestHeuristicAction(state)

    expect(selected).toEqual(bestActions[Math.floor(sample * bestActions.length)])
    randomSpy.mockRestore()
  })
})

describe('MCTS Q5 expansion prior', () => {
  const qConfig = (weight: number): MCTSConfig => ({
    simulations: 30,
    explorationConstant: Math.SQRT2,
    maxDepth: 4,
    rolloutPolicy: 'mixed',
    heuristicProbability: 0.8,
    expansionPolicy: 'heuristic-q5',
    qPriorWeight: weight,
    progressiveWidening: true,
    wideningConstant: 2,
    wideningExponent: 0.5,
  })

  function priorFor(
    state: GameSnapshot,
    entries: Array<{ action: PlayerAction; value: number; confidence: number }>,
  ): MCTSQPriorSource {
    const qTable: Record<string, number> = {}
    const confidence = new Map<string, number>()
    for (const entry of entries) {
      const key = getLearningQTableKeyQ3(state, entry.action)
      qTable[key] = entry.value
      confidence.set(key, entry.confidence)
    }
    return { qTable: Object.freeze(qTable), confidence, minConfidence: 10 }
  }

  it('makes weight zero equivalent to heuristic expansion', () => {
    const state = makePlayingState()
    const actions = getLegalActions(state)
    const prior = priorFor(state, [
      { action: actions[0], value: 1_000_000, confidence: 10 },
      { action: actions[1], value: -1_000_000, confidence: 10 },
    ])
    const heuristic = searchBestAction(
      state,
      'R',
      { ...qConfig(0), expansionPolicy: 'heuristic' },
      seededRng(40),
    )
    const withZeroPrior = searchBestAction(state, 'R', qConfig(0), seededRng(40), prior)

    expect(withZeroPrior.action).toEqual(heuristic.action)
    expect(withZeroPrior.children).toEqual(heuristic.children)
    expect(withZeroPrior.rootVisits).toBe(heuristic.rootVisits)
  })

  it('assigns zero prior to unknown actions', () => {
    const state = makePlayingState()
    const action = getLegalActions(state)[0]
    const [score] = scoreActionsForExpansion(
      state,
      [action],
      'heuristic-q5',
      seededRng(41),
      { qTable: {}, confidence: new Map(), minConfidence: 10 },
      1,
    )

    expect(score).toMatchObject({ qKnown: false, qReliable: false, normalizedQ5Value: 0 })
  })

  it('assigns zero prior to known but unreliable actions', () => {
    const state = makePlayingState()
    const action = getLegalActions(state)[0]
    const prior = priorFor(state, [{ action, value: 99, confidence: 9 }])
    const [score] = scoreActionsForExpansion(
      state,
      [action],
      'heuristic-q5',
      seededRng(42),
      prior,
      1,
    )

    expect(score).toMatchObject({ qKnown: true, qReliable: false, normalizedQ5Value: 0 })
  })

  it('normalizes reliable Q values within the legal action set', () => {
    const state = makePlayingState()
    const actions = getLegalActions(state).slice(0, 3)
    const prior = priorFor(state, [
      { action: actions[0], value: -50, confidence: 10 },
      { action: actions[1], value: 0, confidence: 11 },
      { action: actions[2], value: 50, confidence: 12 },
    ])
    const scores = scoreActionsForExpansion(
      state,
      actions,
      'heuristic-q5',
      seededRng(43),
      prior,
      1,
    )
    const byAction = new Map(scores.map((score) => [actionKey(score.action), score]))

    expect(byAction.get(actionKey(actions[0]))?.normalizedQ5Value).toBe(-1)
    expect(byAction.get(actionKey(actions[1]))?.normalizedQ5Value).toBe(0)
    expect(byAction.get(actionKey(actions[2]))?.normalizedQ5Value).toBe(1)
  })

  it('bounds min-max normalization and maps equal values to zero', () => {
    expect(normalizeMinMax([-1_000_000, 0, 1_000_000])).toEqual([-1, 0, 1])
    expect(normalizeMinMax([7, 7, 7])).toEqual([0, 0, 0])
    expect(normalizeMinMax([-5, 2, 9]).every((value) => value >= -1 && value <= 1)).toBe(true)
  })

  it('does not lose or duplicate actions in combined ordering', () => {
    const state = makePlayingState()
    const actions = getLegalActions(state)
    const prior = priorFor(state, [
      { action: actions[0], value: 2, confidence: 10 },
      { action: actions[1], value: 1, confidence: 10 },
    ])
    const ordered = orderActionsForExpansion(
      state,
      actions,
      'heuristic-q5',
      seededRng(44),
      prior,
      0.5,
    )

    expect(ordered).toHaveLength(actions.length)
    expect(new Set(ordered.map(actionKey)).size).toBe(actions.length)
    expect(ordered.map(actionKey).sort()).toEqual(actions.map(actionKey).sort())
  })

  it('orders combined scores deterministically with the same RNG', () => {
    const state = makePlayingState()
    const actions = getLegalActions(state)
    const prior = priorFor(state, actions.slice(0, 3).map((action, index) => ({
      action,
      value: index,
      confidence: 10,
    })))
    const first = orderActionsForExpansion(
      state,
      actions,
      'heuristic-q5',
      seededRng(45),
      prior,
      0.5,
    )
    const second = orderActionsForExpansion(
      state,
      actions,
      'heuristic-q5',
      seededRng(45),
      prior,
      0.5,
    )

    expect(first).toEqual(second)
  })

  it('does not modify Q5 data and reports coherent root prior metrics', () => {
    const state = makePlayingState()
    const actions = getLegalActions(state)
    const prior = priorFor(state, [
      { action: actions[0], value: 2, confidence: 10 },
      { action: actions[1], value: 1, confidence: 9 },
    ])
    const tableBefore = JSON.stringify(prior.qTable)
    const confidenceBefore = [...prior.confidence.entries()]

    const result = searchBestAction(state, 'R', qConfig(0.5), seededRng(46), prior)

    expect(JSON.stringify(prior.qTable)).toBe(tableBefore)
    expect([...prior.confidence.entries()]).toEqual(confidenceBefore)
    expect(result.qPriorKnownActions).toBe(2)
    expect(result.qPriorReliableActions).toBe(1)
    expect(typeof result.qPriorSelectedActionKnown).toBe('boolean')
    expect(typeof result.qPriorSelectedActionReliable).toBe('boolean')
    expect(result.averageSelectedQPrior).toBeGreaterThanOrEqual(-1)
    expect(result.averageSelectedQPrior).toBeLessThanOrEqual(1)
  })
})
