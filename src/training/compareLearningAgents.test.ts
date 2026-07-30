import { describe, expect, it } from 'vitest'
import { chooseLearningAction, getLearningQTableKey } from '@/agents/learningPolicy'
import { makeInitialState } from '@/store/gameState'
import { getTrainingTraceStateKey } from '@/utils/trainingTrace'
import {
  EXPERIMENTS,
  calculateMetricsBlock,
  calculateWins,
  groupResultsByBlocksOf10,
  runSingleGame,
  summarizeExperiment,
  type GameComparisonResult,
  type LearningDiagnosticsSummary,
} from './compareLearningAgents'

function makeResult(
  game: number,
  winner: GameComparisonResult['winner'],
  territoryR: number,
  territoryB: number,
  turns: number,
  learningDiagnostics?: GameComparisonResult['learningDiagnostics'],
): GameComparisonResult {
  return {
    experiment: 'test',
    game,
    players: { R: 'learning-empty', B: 'random' },
    winner,
    wins: { R: winner === 'R' ? 1 : 0, B: winner === 'B' ? 1 : 0 },
    territory: { R: territoryR, B: territoryB },
    territoryDiff: territoryR - territoryB,
    turns,
    ...(learningDiagnostics ? { learningDiagnostics } : {}),
  }
}

function makeLearningDiagnostics(
  overrides: Partial<LearningDiagnosticsSummary> = {},
): LearningDiagnosticsSummary {
  return {
    totalDecisions: 1,
    qTableHits: 0,
    qTableHitRate: 0,
    totalMaxTiedActions: 2,
    tiedBestActionDecisions: 1,
    distinctQTableKeysConsulted: 4,
    initialQTableEntries: 0,
    qTableChangedDuringEvaluation: false,
    ...overrides,
  }
}

describe('chooseLearningAction', () => {
  it('breaks ties randomly between actions with equal Q values', () => {
    const state = makeInitialState()
    const actions = [
      { type: 'place' as const, pos: { x: 0, y: 0 } },
      { type: 'place' as const, pos: { x: 1, y: 0 } },
      { type: 'place' as const, pos: { x: 2, y: 0 } },
    ]
    const randomValues = [1, 0.75]

    const action = chooseLearningAction(
      state,
      actions,
      0,
      {},
      undefined,
      () => randomValues.shift() ?? 0,
    )

    expect(action).toBe(actions[2])
  })

  it('records Q-table hits for compact learning keys', () => {
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const diagnostics = {
      decisions: 0,
      qTableHits: 0,
      totalMaxTiedActions: 0,
      tiedBestActionDecisions: 0,
      consultedKeys: new Set<string>(),
    }

    chooseLearningAction(
      state,
      [action],
      0,
      { [getLearningQTableKey(state, action)]: 1 },
      diagnostics,
    )

    expect(diagnostics.decisions).toBe(1)
    expect(diagnostics.qTableHits).toBe(1)
    expect(diagnostics.consultedKeys.size).toBeGreaterThan(0)
  })

  it('can use legacy training trace keys from the pretrained table', () => {
    const state = makeInitialState()
    const actions = [
      { type: 'place' as const, pos: { x: 0, y: 0 } },
      { type: 'place' as const, pos: { x: 3, y: 3 } },
    ]
    const legacyKey = `${getTrainingTraceStateKey(state)}|||place|3|3`
    const action = chooseLearningAction(state, actions, 0, { [legacyKey]: 2 }, undefined, () => 0)

    expect(action).toBe(actions[1])
  })

  it('behaves differently from an empty table when valid pretrained keys exist', () => {
    const state = makeInitialState()
    const actions = [
      { type: 'place' as const, pos: { x: 0, y: 0 } },
      { type: 'place' as const, pos: { x: 3, y: 3 } },
    ]

    const emptyChoice = chooseLearningAction(state, actions, 0, {}, undefined, () => 0)
    const pretrainedChoice = chooseLearningAction(
      state,
      actions,
      0,
      { [getLearningQTableKey(state, actions[1])]: 1 },
      undefined,
      () => 0,
    )

    expect(emptyChoice).toBe(actions[0])
    expect(pretrainedChoice).toBe(actions[1])
  })
})

describe('comparison experiments', () => {
  it('includes control experiments', () => {
    expect(EXPERIMENTS.map((experiment) => experiment.name)).toEqual(
      expect.arrayContaining([
        'random_vs_random',
        'heuristic_vs_heuristic',
        'learning_empty_vs_learning_empty',
      ]),
    )
  })

  it('does not modify the Q-table during evaluation', async () => {
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const pretrainedQTable = { [getLearningQTableKey(state, action)]: 1 }

    const result = await runSingleGame({
      experiment: {
        name: 'learning_pretrained_vs_random',
        players: { R: 'learning-pretrained', B: 'random' },
      },
      game: 1,
      pretrainedQTable,
    })

    expect(pretrainedQTable).toEqual({ [getLearningQTableKey(state, action)]: 1 })
    expect(result.learningDiagnostics?.R?.initialQTableEntries).toBe(1)
    expect(result.learningDiagnostics?.R?.qTableChangedDuringEvaluation).toBe(false)
  })

  it('reinitializes learning runtimes between games', async () => {
    const experiment = {
      name: 'learning_empty_vs_learning_empty',
      players: { R: 'learning-empty', B: 'learning-empty' },
    } as const

    const first = await runSingleGame({ experiment, game: 1, pretrainedQTable: {} })
    const second = await runSingleGame({ experiment, game: 2, pretrainedQTable: {} })

    expect(first.learningDiagnostics?.R?.initialQTableEntries).toBe(0)
    expect(first.learningDiagnostics?.B?.initialQTableEntries).toBe(0)
    expect(second.learningDiagnostics?.R?.initialQTableEntries).toBe(0)
    expect(second.learningDiagnostics?.B?.initialQTableEntries).toBe(0)
  })
})

describe('calculateWins', () => {
  it('counts red, blue and tied games', () => {
    expect(
      calculateWins([
        makeResult(1, 'R', 20, 10, 12),
        makeResult(2, 'B', 12, 18, 14),
        makeResult(3, 'tie', 15, 15, 16),
      ]),
    ).toEqual({ R: 1, B: 1, tie: 1 })
  })
})

describe('calculateMetricsBlock', () => {
  it('calculates averages and win rates', () => {
    const metrics = calculateMetricsBlock(
      [makeResult(1, 'R', 20, 10, 12), makeResult(2, 'R', 30, 15, 18)],
      1,
    )

    expect(metrics.games).toBe(2)
    expect(metrics.winRates).toEqual({ R: 100, B: 0, tie: 0 })
    expect(metrics.averageTerritory).toEqual({ R: 25, B: 12.5 })
    expect(metrics.averageTerritoryDiff).toBe(12.5)
    expect(metrics.averageTurns).toBe(15)
  })
})

describe('groupResultsByBlocksOf10', () => {
  it('groups results into blocks of at most 10 games', () => {
    const results = Array.from({ length: 23 }, (_, index) =>
      makeResult(index + 1, index % 2 === 0 ? 'R' : 'B', 20, 10, 10 + index),
    )

    const blocks = groupResultsByBlocksOf10(results)

    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ block: 1, fromGame: 1, toGame: 10, games: 10 })
    expect(blocks[1]).toMatchObject({ block: 2, fromGame: 11, toGame: 20, games: 10 })
    expect(blocks[2]).toMatchObject({ block: 3, fromGame: 21, toGame: 23, games: 3 })
  })
})

describe('summarizeExperiment', () => {
  it('includes required experiment summary fields', () => {
    const summary = summarizeExperiment(
      'test',
      { R: 'learning-pretrained', B: 'heuristic' },
      [makeResult(1, 'B', 10, 25, 20)],
      42,
    )

    expect(summary).toMatchObject({
      name: 'test',
      games: 1,
      players: { R: 'learning-pretrained', B: 'heuristic' },
      wins: { R: 0, B: 1, tie: 0 },
      pretrainedQTableEntries: 42,
    })
    expect(summary.blocksOf10).toHaveLength(1)
  })

  it('includes aggregated learning diagnostics', () => {
    const summary = summarizeExperiment(
      'test',
      { R: 'learning-pretrained', B: 'random' },
      [
        makeResult(1, 'R', 20, 10, 12, {
          R: makeLearningDiagnostics({
            totalDecisions: 4,
            qTableHits: 1,
            initialQTableEntries: 42,
          }),
        }),
        makeResult(2, 'B', 10, 20, 12, {
          R: makeLearningDiagnostics({
            totalDecisions: 6,
            qTableHits: 2,
            initialQTableEntries: 42,
          }),
        }),
      ],
      42,
    )

    expect(summary.learningDiagnostics).toMatchObject({
      totalDecisions: 10,
      qTableHits: 3,
      qTableHitRate: 30,
      initialQTableEntries: 42,
      qTableChangedDuringEvaluation: false,
    })
  })
})
