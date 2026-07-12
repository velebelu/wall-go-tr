import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { DEFAULT_Q4_TRAINING_CONFIG } from './trainLearningAgentQ4'
import {
  DEFAULT_Q5_TRAINING_CONFIG,
  Q5_ALPHA_BY_CONFIDENCE,
  Q5_HEURISTIC_INITIAL_QTABLE_PATH,
  Q5_REWARD_CONFIG,
  buildBalancedQ5Schedule,
  buildQ5Checkpoint500Schedule,
  buildQ5FinalFineTuning500Schedule,
  buildQ5HybridPilot100Schedule,
  buildQ5InstrumentedPilot100Schedule,
  calculateFinalRewardQ5,
  calculateIntermediateRewardQ5FromMetrics,
  chooseHybridQ5Action,
  chooseThresholdHybridQ5Action,
  loadQ5Metadata,
  runLearningAgentQ5Training,
  validateQ5FinalFineTuning500Metadata,
  validateQ5HybridPilot100Metadata,
  validateQ5InstrumentedPilot100Metadata,
  validateQ5PilotMetadata,
  type Q5TrainingMetadata,
  type Q5TrainingScheduleItem,
} from './trainLearningAgentQ5'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q5-'))
}

function countSchedule(schedule: Q5TrainingScheduleItem[]) {
  return {
    random: schedule.filter((item) => item.opponent === 'random').length,
    heuristic: schedule.filter((item) => item.opponent === 'heuristic').length,
    R: schedule.filter((item) => item.learningColor === 'R').length,
    B: schedule.filter((item) => item.learningColor === 'B').length,
    random_R: schedule.filter((item) => item.opponent === 'random' && item.learningColor === 'R')
      .length,
    random_B: schedule.filter((item) => item.opponent === 'random' && item.learningColor === 'B')
      .length,
    heuristic_R: schedule.filter(
      (item) => item.opponent === 'heuristic' && item.learningColor === 'R',
    ).length,
    heuristic_B: schedule.filter(
      (item) => item.opponent === 'heuristic' && item.learningColor === 'B',
    ).length,
  }
}

function expectMetadataConsistency(metadata: Q5TrainingMetadata): void {
  expect(metadata.games).toHaveLength(metadata.totalGames)
  expect(metadata.rewardLog).toHaveLength(metadata.totalGames)
  expect(metadata.summary.results.games).toBe(metadata.games.length)

  for (const opponent of ['random', 'heuristic'] as const) {
    const games = metadata.games.filter((game) => game.opponent === opponent)
    expect(metadata.summary.gamesByOpponent[opponent]).toBe(games.length)
    expect(metadata.summary.resultsByOpponent[opponent].games).toBe(games.length)
    expect(metadata.summary.qByOpponent[opponent].qHits).toBe(
      games.reduce((sum, game) => sum + game.qHits, 0),
    )
    expect(metadata.summary.qByOpponent[opponent].qMisses).toBe(
      games.reduce((sum, game) => sum + game.qMisses, 0),
    )
  }

  for (const color of ['R', 'B'] as const) {
    const games = metadata.games.filter((game) => game.learningColor === color)
    expect(metadata.summary.gamesByColor[color]).toBe(games.length)
    expect(metadata.summary.resultsByColor[color].games).toBe(games.length)
  }

  for (const key of ['random_R', 'random_B', 'heuristic_R', 'heuristic_B']) {
    const [opponent, color] = key.split('_') as ['random' | 'heuristic', 'R' | 'B']
    const games = metadata.games.filter(
      (game) => game.opponent === opponent && game.learningColor === color,
    )
    expect(metadata.summary.gamesByCombination[key]).toBe(games.length)
    expect(metadata.summary.resultsByCombination[key].games).toBe(games.length)
  }
}

describe('trainLearningAgentQ5 configuration', () => {
  it('keeps Q4 hyperparameters exactly', () => {
    expect(DEFAULT_Q5_TRAINING_CONFIG.alpha).toBe(DEFAULT_Q4_TRAINING_CONFIG.alpha)
    expect(DEFAULT_Q5_TRAINING_CONFIG.gamma).toBe(DEFAULT_Q4_TRAINING_CONFIG.gamma)
    expect(DEFAULT_Q5_TRAINING_CONFIG.epsilonStart).toBe(DEFAULT_Q4_TRAINING_CONFIG.epsilonStart)
    expect(DEFAULT_Q5_TRAINING_CONFIG.epsilonMin).toBe(DEFAULT_Q4_TRAINING_CONFIG.epsilonMin)
    expect(DEFAULT_Q5_TRAINING_CONFIG.epsilonDecay).toBe(DEFAULT_Q4_TRAINING_CONFIG.epsilonDecay)
    expect(DEFAULT_Q5_TRAINING_CONFIG.maxTurns).toBe(DEFAULT_Q4_TRAINING_CONFIG.maxTurns)
  })

  it('keeps the Q3 representation for Q-table keys', async () => {
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    expect(getLearningQTableKeyQ3(makeInitialState(), action)).toContain('q3|')

    const result = await runLearningAgentQ5Training({
      totalGames: 4,
      seed: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4'),
      progressEvery: 0,
      maxTurns: 8,
    })

    expect(Object.keys(result.qTable).every((key) => key.startsWith('q3|'))).toBe(true)
    expect(result.metadata.stateRepresentation).toBe('Q3')
    expect(result.metadata.onlyExperimentalChange).toBe('reward')
  })

  it('starts the pilot from an empty table and does not accept checkpoint inputs', async () => {
    const result = await runLearningAgentQ5Training({
      totalGames: 4,
      seed: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4_empty'),
      progressEvery: 0,
      maxTurns: 8,
    })

    expect(result.metadata.startedFromEmptyQTable).toBe(true)
    expect(result.metadata.initialQTableEntries).toBe(0)
    expect(result.metadata.summary.initialQTableEntries).toBe(0)
    expect(result.metadata.summary.finalQTableEntries).toBeGreaterThan(0)
    expect('qTable' in DEFAULT_Q5_TRAINING_CONFIG).toBe(false)
  })

  it('can initialize official training from a heuristic Q-table', async () => {
    const state = snapshotFromState(makeInitialState())
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const qTablePath = path.join(makeTempDir(), 'initial.json')
    const initialTable = { [getLearningQTableKeyQ3(state, action)]: 0.5 }
    await import('node:fs').then(({ writeFileSync }) =>
      writeFileSync(qTablePath, `${JSON.stringify(initialTable, null, 2)}\n`, 'utf8'),
    )

    const result = await runLearningAgentQ5Training({
      totalGames: 4,
      checkpoint: 500,
      seed: 3,
      outputDir: path.join(makeTempDir(), 'checkpoint_seeded'),
      initialQTablePath: qTablePath,
      schedule: buildBalancedQ5Schedule(4, 3),
      progressEvery: 0,
      maxTurns: 8,
    })

    expect(result.metadata.startedFromEmptyQTable).toBe(false)
    expect(result.metadata.initialization).toBe('heuristic_initial')
    expect(result.metadata.initialQTableEntries).toBe(1)
    expect(result.metadata.sourceQTable?.entries).toBe(1)
    expect(result.metadata.newTrainingGames).toBe(4)
    expect(result.metadata.qTableDelta).toBeDefined()
    expect(Object.keys(result.qTable).length).toBeGreaterThanOrEqual(1)
  })

  it('does not reference existing Q-table checkpoints or official evaluation commands', () => {
    const source = readFileSync(path.resolve('src/training/trainLearningAgentQ5.ts'), 'utf8')

    expect(source).not.toContain('qtable_q4')
    expect(source).not.toContain('qtable_q3')
    expect(source).not.toContain('qtable_q2')
    expect(source).not.toContain('qtable_q1')
    expect(source).not.toContain('checkpoint_1000')
    expect(source).not.toContain('checkpoint_1500')
    expect(source).not.toContain('checkpoint_2000')
    expect(source).not.toContain('evaluateLearningAgent')
    expect(source).not.toContain('seed: 13')
    expect(source).not.toContain('seed: 23')
  })
})

describe('trainLearningAgentQ5 reward', () => {
  it('limits intermediate reward to [-0.10, 0.10]', () => {
    const high = calculateIntermediateRewardQ5FromMetrics({
      deltaTerritoryDiff: 100,
      deltaOwnMobility: 100,
      deltaOwnTrappedPieces: -100,
      deltaOwnLowMobilityPieces: -100,
    })
    const low = calculateIntermediateRewardQ5FromMetrics({
      deltaTerritoryDiff: -100,
      deltaOwnMobility: -100,
      deltaOwnTrappedPieces: 100,
      deltaOwnLowMobilityPieces: 100,
    })

    expect(high.intermediateReward).toBe(Q5_REWARD_CONFIG.intermediate.totalMax)
    expect(low.intermediateReward).toBe(Q5_REWARD_CONFIG.intermediate.totalMin)
    expect(high.clamps.total).toBe(true)
    expect(low.clamps.total).toBe(true)
  })

  it('rewards better territory and penalizes worse territory', () => {
    expect(
      calculateIntermediateRewardQ5FromMetrics({
        deltaTerritoryDiff: 2,
        deltaOwnMobility: 0,
        deltaOwnTrappedPieces: 0,
        deltaOwnLowMobilityPieces: 0,
      }).territorySignal,
    ).toBeGreaterThan(0)
    expect(
      calculateIntermediateRewardQ5FromMetrics({
        deltaTerritoryDiff: -2,
        deltaOwnMobility: 0,
        deltaOwnTrappedPieces: 0,
        deltaOwnLowMobilityPieces: 0,
      }).territorySignal,
    ).toBeLessThan(0)
  })

  it('rewards own mobility gains and penalizes own mobility losses slightly', () => {
    const gain = calculateIntermediateRewardQ5FromMetrics({
      deltaTerritoryDiff: 0,
      deltaOwnMobility: 3,
      deltaOwnTrappedPieces: 0,
      deltaOwnLowMobilityPieces: 0,
    })
    const loss = calculateIntermediateRewardQ5FromMetrics({
      deltaTerritoryDiff: 0,
      deltaOwnMobility: -3,
      deltaOwnTrappedPieces: 0,
      deltaOwnLowMobilityPieces: 0,
    })

    expect(gain.mobilitySignal).toBeCloseTo(0.009, 6)
    expect(loss.mobilitySignal).toBeCloseTo(-0.009, 6)
    expect(Math.abs(gain.mobilitySignal)).toBeLessThan(0.02)
  })

  it('penalizes newly trapped pieces and rewards freed trapped pieces', () => {
    const trapped = calculateIntermediateRewardQ5FromMetrics({
      deltaTerritoryDiff: 0,
      deltaOwnMobility: 0,
      deltaOwnTrappedPieces: 1,
      deltaOwnLowMobilityPieces: 0,
    })
    const freed = calculateIntermediateRewardQ5FromMetrics({
      deltaTerritoryDiff: 0,
      deltaOwnMobility: 0,
      deltaOwnTrappedPieces: -1,
      deltaOwnLowMobilityPieces: 0,
    })

    expect(trapped.trapSignal).toBeCloseTo(-0.04, 6)
    expect(freed.trapSignal).toBeCloseTo(0.04, 6)
  })

  it('penalizes more low-mobility pieces and rewards reducing them', () => {
    const moreLow = calculateIntermediateRewardQ5FromMetrics({
      deltaTerritoryDiff: 0,
      deltaOwnMobility: 0,
      deltaOwnTrappedPieces: 0,
      deltaOwnLowMobilityPieces: 1,
    })
    const fewerLow = calculateIntermediateRewardQ5FromMetrics({
      deltaTerritoryDiff: 0,
      deltaOwnMobility: 0,
      deltaOwnTrappedPieces: 0,
      deltaOwnLowMobilityPieces: -1,
    })

    expect(moreLow.lowMobilitySignal).toBeCloseTo(-0.015, 6)
    expect(fewerLow.lowMobilitySignal).toBeCloseTo(0.015, 6)
  })

  it('limits final territory contribution to [-20, 20]', () => {
    const high = calculateFinalRewardQ5('R', { R: 100, B: 0 }, 'R')
    const low = calculateFinalRewardQ5('B', { R: 0, B: 100 }, 'R')

    expect(high.territoryFinal).toBe(20)
    expect(low.territoryFinal).toBe(-20)
    expect(high.territoryClamp).toBe(true)
    expect(low.territoryClamp).toBe(true)
  })

  it('keeps wins positive, losses negative, and neutral ties at -5', () => {
    expect(calculateFinalRewardQ5('R', { R: 0, B: 100 }, 'R').finalReward).toBeGreaterThan(0)
    expect(calculateFinalRewardQ5('B', { R: 100, B: 0 }, 'R').finalReward).toBeLessThan(0)
    expect(calculateFinalRewardQ5('tie', { R: 20, B: 20 }, 'R').finalReward).toBe(-5)
  })
})

describe('trainLearningAgentQ5 pilot metadata', () => {
  it('builds the exact 40-game pilot distribution', () => {
    const schedule = buildBalancedQ5Schedule(40, 3)

    expect(countSchedule(schedule)).toEqual({
      random: 20,
      heuristic: 20,
      R: 20,
      B: 20,
      random_R: 10,
      random_B: 10,
      heuristic_R: 10,
      heuristic_B: 10,
    })
  })

  it('keeps every consecutive block of four perfectly balanced', () => {
    const schedule = buildBalancedQ5Schedule(40, 3)

    for (let index = 0; index < schedule.length; index += 4) {
      expect(countSchedule(schedule.slice(index, index + 4))).toMatchObject({
        random: 2,
        heuristic: 2,
        R: 2,
        B: 2,
        random_R: 1,
        random_B: 1,
        heuristic_R: 1,
        heuristic_B: 1,
      })
    }
  })

  it('builds the exact Q5-500 official mixed schedule', () => {
    const schedule = buildQ5Checkpoint500Schedule()

    expect(countSchedule(schedule)).toEqual({
      random: 350,
      heuristic: 150,
      R: 250,
      B: 250,
      random_R: 175,
      random_B: 175,
      heuristic_R: 75,
      heuristic_B: 75,
    })
    for (let index = 0; index < schedule.length; index += 20) {
      expect(countSchedule(schedule.slice(index, index + 20))).toEqual({
        random: 14,
        heuristic: 6,
        R: 10,
        B: 10,
        random_R: 7,
        random_B: 7,
        heuristic_R: 3,
        heuristic_B: 3,
      })
    }
  })

  it('builds the exact final fine-tuning 500 balanced schedule', () => {
    const schedule = buildQ5FinalFineTuning500Schedule()

    expect(countSchedule(schedule)).toEqual({
      random: 250,
      heuristic: 250,
      R: 250,
      B: 250,
      random_R: 125,
      random_B: 125,
      heuristic_R: 125,
      heuristic_B: 125,
    })
    for (let index = 0; index < schedule.length; index += 4) {
      expect(countSchedule(schedule.slice(index, index + 4))).toEqual({
        random: 2,
        heuristic: 2,
        R: 2,
        B: 2,
        random_R: 1,
        random_B: 1,
        heuristic_R: 1,
        heuristic_B: 1,
      })
    }
  })

  it('builds the exact instrumented pilot 100 balanced schedule', () => {
    const schedule = buildQ5InstrumentedPilot100Schedule()

    expect(countSchedule(schedule)).toEqual({
      random: 50,
      heuristic: 50,
      R: 50,
      B: 50,
      random_R: 25,
      random_B: 25,
      heuristic_R: 25,
      heuristic_B: 25,
    })
    for (let index = 0; index < schedule.length; index += 4) {
      expect(countSchedule(schedule.slice(index, index + 4))).toEqual({
        random: 2,
        heuristic: 2,
        R: 2,
        B: 2,
        random_R: 1,
        random_B: 1,
        heuristic_R: 1,
        heuristic_B: 1,
      })
    }
  })

  it('defines conservative alpha by inherited confidence for instrumented fine-tuning', () => {
    expect(Q5_ALPHA_BY_CONFIDENCE).toEqual({
      '1 observation': 0.03,
      '2-5 observations': 0.02,
      '6-20 observations': 0.01,
      'more than 20': 0.005,
      new: 0.03,
    })
  })

  it('uses reliable Q actions and falls back to heuristic when confidence is insufficient', () => {
    const state = snapshotFromState(makeInitialState())
    const legalActions = getLegalActions(state).slice(0, 2)
    const reliableKey = getLearningQTableKeyQ3(state, legalActions[0])
    const lowConfidenceKey = getLearningQTableKeyQ3(state, legalActions[1])

    const qChoice = chooseHybridQ5Action({
      state,
      legalActions: [...legalActions],
      qTable: { [reliableKey]: 0.5, [lowConfidenceKey]: 1.5 },
      confidenceMap: new Map([
        [reliableKey, { observations: 3, confidence: '2-5 observations', alpha: 0.02 }],
        [lowConfidenceKey, { observations: 1, confidence: '1 observation', alpha: 0.03 }],
      ]),
      qLearningUpdateCounts: new Map(),
      confidenceThreshold: 3,
      epsilon: 0,
      rng: () => 0,
    })
    expect(qChoice.mechanism).toBe('qReliable')
    expect(qChoice.action).toEqual(legalActions[0])

    const fallbackChoice = chooseHybridQ5Action({
      state,
      legalActions: [...legalActions],
      qTable: { [lowConfidenceKey]: 1.5 },
      confidenceMap: new Map([[lowConfidenceKey, { observations: 1, confidence: '1 observation', alpha: 0.03 }]]),
      qLearningUpdateCounts: new Map(),
      confidenceThreshold: 3,
      epsilon: 0,
      rng: () => 0,
    })
    expect(fallbackChoice.mechanism).toBe('heuristicFallback')
  })

  it('records random exploration before applying hybrid confidence rules', () => {
    const state = snapshotFromState(makeInitialState())
    const legalActions = getLegalActions(state).slice(0, 2)
    const key = getLearningQTableKeyQ3(state, legalActions[0])
    const choice = chooseHybridQ5Action({
      state,
      legalActions: [...legalActions],
      qTable: { [key]: 0.5 },
      confidenceMap: new Map([[key, { observations: 3, confidence: '2-5 observations', alpha: 0.02 }]]),
      qLearningUpdateCounts: new Map(),
      confidenceThreshold: 3,
      epsilon: 1,
      rng: () => 0,
    })

    expect(choice.mechanism).toBe('randomExploration')
  })

  it('only lets Q override heuristic when confidence and margin are sufficient', () => {
    const state = snapshotFromState(makeInitialState())
    const legalActions = getLegalActions(state)
    const heuristicProbe = chooseThresholdHybridQ5Action({
      state,
      legalActions,
      qTable: {},
      confidenceMap: new Map(),
      qLearningUpdateCounts: new Map(),
      variant: { id: 'A', minConfidence: 3, minMargin: 0 },
      rng: () => 0,
    })
    const qAction = legalActions.find(
      (action) => getLearningQTableKeyQ3(state, action) !== heuristicProbe.heuristicKey,
    )!
    const qKey = getLearningQTableKeyQ3(state, qAction)
    const qTable = { [heuristicProbe.heuristicKey]: 0.5, [qKey]: 1 }

    const accepted = chooseThresholdHybridQ5Action({
      state,
      legalActions,
      qTable,
      confidenceMap: new Map([[qKey, { observations: 3, confidence: '2-5 observations', alpha: 0.02 }]]),
      qLearningUpdateCounts: new Map(),
      variant: { id: 'B', minConfidence: 3, minMargin: 0.25 },
      rng: () => 0,
    })
    expect(accepted.mechanism).toBe('qOverrideAccepted')

    const rejectedByMargin = chooseThresholdHybridQ5Action({
      state,
      legalActions,
      qTable,
      confidenceMap: new Map([[qKey, { observations: 3, confidence: '2-5 observations', alpha: 0.02 }]]),
      qLearningUpdateCounts: new Map(),
      variant: { id: 'D', minConfidence: 3, minMargin: 0.75 },
      rng: () => 0,
    })
    expect(rejectedByMargin.mechanism).toBe('qOverrideRejected')

    const rejectedByConfidence = chooseThresholdHybridQ5Action({
      state,
      legalActions,
      qTable,
      confidenceMap: new Map([[qKey, { observations: 2, confidence: '2-5 observations', alpha: 0.02 }]]),
      qLearningUpdateCounts: new Map(),
      variant: { id: 'C', minConfidence: 3, minMargin: 0.25 },
      rng: () => 0,
    })
    expect(rejectedByConfidence.mechanism).toBe('qOverrideRejected')
  })

  it('validates final fine-tuning metadata shape without running 500 games', () => {
    const result = {
      model: 'Q5',
      seed: 3,
      totalGames: 500,
      checkpoint: 'final_finetuning_500',
      startedFromEmptyQTable: false,
      initialization: 'heuristic_initial',
      sourceQTable: { path: 'qtable_q5_heuristic_initial.json', entries: 19652 },
      initialQTableEntries: 19652,
      newTrainingGames: 500,
      stateRepresentation: 'Q3',
      policyModel: 'Q3/Q4',
      baselineExperiment: 'Q4',
      onlyExperimentalChange: 'reward',
      rewardModel: 'Q5',
      rewardConfiguration: Q5_REWARD_CONFIG,
      hyperparameters: {
        alpha: 0.03,
        gamma: 0.9,
        epsilonStart: 0.15,
        epsilonMin: 0.02,
        epsilonDecay: 0.9995,
        maxTurns: 250,
      },
      targetDistribution: {
        opponents: { random: 250, heuristic: 250 },
        colors: { R: 250, B: 250 },
        combinations: {
          random_R: 125,
          random_B: 125,
          heuristic_R: 125,
          heuristic_B: 125,
        },
      },
      heuristicPolicy: {
        placement: 'getBestPlacement',
        playing: 'getBestHeuristicAction',
        policy: 'default',
      },
      schedule: buildQ5FinalFineTuning500Schedule(),
      games: [],
      rewardLog: [],
      summary: {
        gamesByOpponent: { random: 250, heuristic: 250 },
        gamesByColor: { R: 250, B: 250 },
        gamesByCombination: {
          random_R: 125,
          random_B: 125,
          heuristic_R: 125,
          heuristic_B: 125,
        },
        results: { games: 500, wins: 0, losses: 0, ties: 0 },
        resultsByOpponent: {
          random: { games: 250, wins: 0, losses: 0, ties: 0 },
          heuristic: { games: 250, wins: 0, losses: 0, ties: 0 },
        },
        resultsByColor: {
          R: { games: 250, wins: 0, losses: 0, ties: 0 },
          B: { games: 250, wins: 0, losses: 0, ties: 0 },
        },
        resultsByCombination: {
          random_R: { games: 125, wins: 0, losses: 0, ties: 0 },
          random_B: { games: 125, wins: 0, losses: 0, ties: 0 },
          heuristic_R: { games: 125, wins: 0, losses: 0, ties: 0 },
          heuristic_B: { games: 125, wins: 0, losses: 0, ties: 0 },
        },
        qTotal: { qHits: 0, qMisses: 0, qHitRate: 0 },
        qByOpponent: {
          random: { qHits: 0, qMisses: 0, qHitRate: 0 },
          heuristic: { qHits: 0, qMisses: 0, qHitRate: 0 },
        },
        qByColor: {
          R: { qHits: 0, qMisses: 0, qHitRate: 0 },
          B: { qHits: 0, qMisses: 0, qHitRate: 0 },
        },
        averageTerritory: { q5: 0, opponent: 0 },
        averageTerritoryDiff: 0,
        averageTurns: 0,
        epsilonInitial: 0.15,
        epsilonFinal: Number((0.15 * 0.9995 ** 500).toFixed(4)),
        initialQTableEntries: 19652,
        finalQTableEntries: 19652,
        tableGrowth: 0,
        uniqueQ3StatesVisited: 0,
        rewards: {
          averageTotalReward: 0,
          averageTerritoryReward: 0,
          averageMobilityReward: 0,
          averageTrappedReward: 0,
          averageLowMobilityReward: 0,
          averageIntermediateReward: 0,
          averageFinalReward: 0,
          minTotalReward: 0,
          maxTotalReward: 0,
          minIntermediateReward: 0,
          maxIntermediateReward: 0,
          clampCounts: {
            territory: 0,
            mobility: 0,
            trap: 0,
            lowMobility: 0,
            total: 0,
            finalTerritory: 0,
          },
          trappedPiecesCreated: 0,
          trappedPiecesFreed: 0,
        },
      },
      qTableDelta: {
        modifiedExistingValues: 1,
        addedStateActionPairs: 0,
        unchangedExistingValues: 19651,
        inheritedAbsoluteChangeMean: 0.001,
        inheritedAbsoluteChangeMax: 0.1,
      },
      createdAt: '2026-07-12T00:00:00.000Z',
      durationMs: 0,
      outputFiles: {
        qTable: 'qtable.json',
        metadata: 'metadata.json',
        trainingSummary: 'training_summary.json',
        rewardLog: 'reward_log.json',
      },
    } satisfies Q5TrainingMetadata

    expect(() => validateQ5FinalFineTuning500Metadata(result)).not.toThrow()
  })

  it('validates instrumented pilot metadata shape without running 100 games', () => {
    const result = {
      model: 'Q5',
      seed: 3,
      totalGames: 100,
      checkpoint: 'instrumented_pilot_100',
      startedFromEmptyQTable: false,
      initialization: 'heuristic_initial',
      sourceQTable: { path: Q5_HEURISTIC_INITIAL_QTABLE_PATH, entries: 19652 },
      initialQTableEntries: 19652,
      newTrainingGames: 100,
      stateRepresentation: 'Q3',
      policyModel: 'Q3/Q4',
      baselineExperiment: 'Q4',
      onlyExperimentalChange: 'reward',
      rewardModel: 'Q5',
      rewardConfiguration: Q5_REWARD_CONFIG,
      hyperparameters: {
        alpha: 0.03,
        gamma: 0.9,
        epsilonStart: 0.15,
        epsilonMin: 0.02,
        epsilonDecay: 0.9995,
        maxTurns: 250,
      },
      targetDistribution: {
        opponents: { random: 50, heuristic: 50 },
        colors: { R: 50, B: 50 },
        combinations: {
          random_R: 25,
          random_B: 25,
          heuristic_R: 25,
          heuristic_B: 25,
        },
      },
      heuristicPolicy: {
        placement: 'getBestPlacement',
        playing: 'getBestHeuristicAction',
        policy: 'default',
      },
      schedule: buildQ5InstrumentedPilot100Schedule(),
      games: [],
      rewardLog: [],
      summary: {
        gamesByOpponent: { random: 50, heuristic: 50 },
        gamesByColor: { R: 50, B: 50 },
        gamesByCombination: {
          random_R: 25,
          random_B: 25,
          heuristic_R: 25,
          heuristic_B: 25,
        },
        results: { games: 100, wins: 0, losses: 0, ties: 0 },
        resultsByOpponent: {
          random: { games: 50, wins: 0, losses: 0, ties: 0 },
          heuristic: { games: 50, wins: 0, losses: 0, ties: 0 },
        },
        resultsByColor: {
          R: { games: 50, wins: 0, losses: 0, ties: 0 },
          B: { games: 50, wins: 0, losses: 0, ties: 0 },
        },
        resultsByCombination: {
          random_R: { games: 25, wins: 0, losses: 0, ties: 0 },
          random_B: { games: 25, wins: 0, losses: 0, ties: 0 },
          heuristic_R: { games: 25, wins: 0, losses: 0, ties: 0 },
          heuristic_B: { games: 25, wins: 0, losses: 0, ties: 0 },
        },
        qTotal: { qHits: 0, qMisses: 0, qHitRate: 0 },
        qByOpponent: {
          random: { qHits: 0, qMisses: 0, qHitRate: 0 },
          heuristic: { qHits: 0, qMisses: 0, qHitRate: 0 },
        },
        qByColor: {
          R: { qHits: 0, qMisses: 0, qHitRate: 0 },
          B: { qHits: 0, qMisses: 0, qHitRate: 0 },
        },
        averageTerritory: { q5: 0, opponent: 0 },
        averageTerritoryDiff: 0,
        averageTurns: 0,
        epsilonInitial: 0.15,
        epsilonFinal: Number((0.15 * 0.9995 ** 100).toFixed(4)),
        initialQTableEntries: 19652,
        finalQTableEntries: 19652,
        tableGrowth: 0,
        uniqueQ3StatesVisited: 0,
        rewards: {
          averageTotalReward: 0,
          averageTerritoryReward: 0,
          averageMobilityReward: 0,
          averageTrappedReward: 0,
          averageLowMobilityReward: 0,
          averageIntermediateReward: 0,
          averageFinalReward: 0,
          minTotalReward: 0,
          maxTotalReward: 0,
          minIntermediateReward: 0,
          maxIntermediateReward: 0,
          clampCounts: {
            territory: 0,
            mobility: 0,
            trap: 0,
            lowMobility: 0,
            total: 0,
            finalTerritory: 0,
          },
          trappedPiecesCreated: 0,
          trappedPiecesFreed: 0,
        },
      },
      qTableDelta: {
        modifiedExistingValues: 1,
        addedStateActionPairs: 0,
        unchangedExistingValues: 19651,
        inheritedAbsoluteChangeMean: 0.001,
        inheritedAbsoluteChangeMax: 0.1,
      },
      instrumentedUpdates: {
        enabled: true,
        deltaClamp: { min: -1, max: 1 },
        learningRateByConfidence: Q5_ALPHA_BY_CONFIDENCE,
        updateSummary: {
          totalUpdates: 1,
          alphaDistribution: { '0.03': 1 },
          clampCount: 0,
          maxAbsAppliedDelta: 0.1,
          invalidValueCount: 0,
          changesByConfidence: {
            '1 observation': {
              updates: 1,
              meanAbsAppliedDelta: 0.1,
              maxAbsAppliedDelta: 0.1,
              clampedUpdates: 0,
            },
            '2-5 observations': {
              updates: 0,
              meanAbsAppliedDelta: 0,
              maxAbsAppliedDelta: 0,
              clampedUpdates: 0,
            },
            '6-20 observations': {
              updates: 0,
              meanAbsAppliedDelta: 0,
              maxAbsAppliedDelta: 0,
              clampedUpdates: 0,
            },
            'more than 20': {
              updates: 0,
              meanAbsAppliedDelta: 0,
              maxAbsAppliedDelta: 0,
              clampedUpdates: 0,
            },
            new: {
              updates: 0,
              meanAbsAppliedDelta: 0,
              maxAbsAppliedDelta: 0,
              clampedUpdates: 0,
            },
          },
        },
      },
      createdAt: '2026-07-12T00:00:00.000Z',
      durationMs: 0,
      outputFiles: {
        qTable: 'qtable.json',
        metadata: 'metadata.json',
        trainingSummary: 'training_summary.json',
        rewardLog: 'reward_log.json',
        qUpdateLog: 'q_update_log.jsonl',
      },
    } satisfies Q5TrainingMetadata

    expect(() => validateQ5InstrumentedPilot100Metadata(result)).not.toThrow()
  })

  it('validates hybrid pilot metadata shape without running 100 games', () => {
    const instrumentedUpdateSummary = {
      totalUpdates: 1,
      alphaDistribution: { '0.03': 1 },
      clampCount: 0,
      maxAbsAppliedDelta: 0.1,
      invalidValueCount: 0,
      changesByConfidence: {
        '1 observation': {
          updates: 1,
          meanAbsAppliedDelta: 0.1,
          maxAbsAppliedDelta: 0.1,
          clampedUpdates: 0,
        },
        '2-5 observations': { updates: 0, meanAbsAppliedDelta: 0, maxAbsAppliedDelta: 0, clampedUpdates: 0 },
        '6-20 observations': { updates: 0, meanAbsAppliedDelta: 0, maxAbsAppliedDelta: 0, clampedUpdates: 0 },
        'more than 20': { updates: 0, meanAbsAppliedDelta: 0, maxAbsAppliedDelta: 0, clampedUpdates: 0 },
        new: { updates: 0, meanAbsAppliedDelta: 0, maxAbsAppliedDelta: 0, clampedUpdates: 0 },
      },
    }
    const result = {
      model: 'Q5',
      seed: 3,
      totalGames: 100,
      checkpoint: 'hybrid_pilot_100',
      startedFromEmptyQTable: false,
      initialization: 'heuristic_initial',
      sourceQTable: { path: Q5_HEURISTIC_INITIAL_QTABLE_PATH, entries: 19652 },
      initialQTableEntries: 19652,
      newTrainingGames: 100,
      stateRepresentation: 'Q3',
      policyModel: 'Q3/Q4',
      baselineExperiment: 'Q4',
      onlyExperimentalChange: 'reward',
      rewardModel: 'Q5',
      rewardConfiguration: Q5_REWARD_CONFIG,
      hyperparameters: {
        alpha: 0.03,
        gamma: 0.9,
        epsilonStart: 0.1,
        epsilonMin: 0.02,
        epsilonDecay: 0.9995,
        maxTurns: 250,
      },
      targetDistribution: {
        opponents: { random: 50, heuristic: 50 },
        colors: { R: 50, B: 50 },
        combinations: {
          random_R: 25,
          random_B: 25,
          heuristic_R: 25,
          heuristic_B: 25,
        },
      },
      heuristicPolicy: {
        placement: 'getBestPlacement',
        playing: 'getBestHeuristicAction',
        policy: 'default',
      },
      schedule: buildQ5HybridPilot100Schedule(),
      games: [],
      rewardLog: [],
      summary: {
        gamesByOpponent: { random: 50, heuristic: 50 },
        gamesByColor: { R: 50, B: 50 },
        gamesByCombination: {
          random_R: 25,
          random_B: 25,
          heuristic_R: 25,
          heuristic_B: 25,
        },
        results: { games: 100, wins: 0, losses: 0, ties: 0 },
        resultsByOpponent: {
          random: { games: 50, wins: 0, losses: 0, ties: 0 },
          heuristic: { games: 50, wins: 0, losses: 0, ties: 0 },
        },
        resultsByColor: {
          R: { games: 50, wins: 0, losses: 0, ties: 0 },
          B: { games: 50, wins: 0, losses: 0, ties: 0 },
        },
        resultsByCombination: {
          random_R: { games: 25, wins: 0, losses: 0, ties: 0 },
          random_B: { games: 25, wins: 0, losses: 0, ties: 0 },
          heuristic_R: { games: 25, wins: 0, losses: 0, ties: 0 },
          heuristic_B: { games: 25, wins: 0, losses: 0, ties: 0 },
        },
        qTotal: { qHits: 0, qMisses: 0, qHitRate: 0 },
        qByOpponent: {
          random: { qHits: 0, qMisses: 0, qHitRate: 0 },
          heuristic: { qHits: 0, qMisses: 0, qHitRate: 0 },
        },
        qByColor: {
          R: { qHits: 0, qMisses: 0, qHitRate: 0 },
          B: { qHits: 0, qMisses: 0, qHitRate: 0 },
        },
        averageTerritory: { q5: 0, opponent: 0 },
        averageTerritoryDiff: 0,
        averageTurns: 0,
        epsilonInitial: 0.1,
        epsilonFinal: Number((0.1 * 0.9995 ** 100).toFixed(4)),
        initialQTableEntries: 19652,
        finalQTableEntries: 19652,
        tableGrowth: 0,
        uniqueQ3StatesVisited: 0,
        rewards: {
          averageTotalReward: 0,
          averageTerritoryReward: 0,
          averageMobilityReward: 0,
          averageTrappedReward: 0,
          averageLowMobilityReward: 0,
          averageIntermediateReward: 0,
          averageFinalReward: 0,
          minTotalReward: 0,
          maxTotalReward: 0,
          minIntermediateReward: 0,
          maxIntermediateReward: 0,
          clampCounts: {
            territory: 0,
            mobility: 0,
            trap: 0,
            lowMobility: 0,
            total: 0,
            finalTerritory: 0,
          },
          trappedPiecesCreated: 0,
          trappedPiecesFreed: 0,
        },
        hybridPolicy: {
          confidenceThreshold: 3,
          decisions: { qReliable: 1, heuristicFallback: 0, randomExploration: 0 },
          decisionPercentages: { qReliable: 100, heuristicFallback: 0, randomExploration: 0 },
          resultsByPrimaryDecisionMechanism: {
            qReliable: { games: 0, wins: 0, losses: 0, ties: 0 },
            heuristicFallback: { games: 0, wins: 0, losses: 0, ties: 0 },
            randomExploration: { games: 0, wins: 0, losses: 0, ties: 0 },
          },
        },
      },
      qTableDelta: {
        modifiedExistingValues: 1,
        addedStateActionPairs: 0,
        unchangedExistingValues: 19651,
        inheritedAbsoluteChangeMean: 0.001,
        inheritedAbsoluteChangeMax: 0.1,
      },
      instrumentedUpdates: {
        enabled: true,
        deltaClamp: { min: -1, max: 1 },
        learningRateByConfidence: Q5_ALPHA_BY_CONFIDENCE,
        updateSummary: instrumentedUpdateSummary,
      },
      hybridPolicy: {
        enabled: true,
        confidenceThreshold: 3,
        fallback: 'heuristic',
        explorationDuringTraining: true,
      },
      createdAt: '2026-07-12T00:00:00.000Z',
      durationMs: 0,
      outputFiles: {
        qTable: 'qtable.json',
        metadata: 'metadata.json',
        trainingSummary: 'training_summary.json',
        rewardLog: 'reward_log.json',
        qUpdateLog: 'q_update_log.jsonl',
      },
    } satisfies Q5TrainingMetadata

    expect(() => validateQ5HybridPilot100Metadata(result)).not.toThrow()
  })

  it('writes an instrumented update log and clamps every individual Q delta', async () => {
    const outputDir = path.join(makeTempDir(), 'instrumented_pilot_4')
    const result = await runLearningAgentQ5Training({
      totalGames: 4,
      checkpoint: 'instrumented_pilot_100',
      seed: 3,
      outputDir,
      progressEvery: 0,
      maxTurns: 8,
      schedule: buildQ5InstrumentedPilot100Schedule().slice(0, 4),
      instrumentedUpdates: true,
      epsilonStart: 0.15,
      epsilonMin: 0.02,
    })
    const metadata = loadQ5Metadata(path.join(outputDir, 'metadata.json'))
    const logPath = metadata.outputFiles.qUpdateLog

    expect(logPath).toBeDefined()
    const lines = readFileSync(path.resolve(logPath!), 'utf8').trim().split('\n')
    expect(lines.length).toBe(result.metadata.instrumentedUpdates?.updateSummary.totalUpdates)
    for (const line of lines) {
      const update = JSON.parse(line) as { appliedDelta: number; rawDelta: number; newQ: number }
      expect(Number.isFinite(update.newQ)).toBe(true)
      expect(Math.abs(update.appliedDelta)).toBeLessThanOrEqual(1)
      expect(Number.isFinite(update.rawDelta)).toBe(true)
    }
  }, 15000)

  it('writes and reloads a valid Q5 pilot with reward logs', async () => {
    const outputDir = path.join(makeTempDir(), 'pilot_40')
    const result = await runLearningAgentQ5Training({
      totalGames: 40,
      seed: 3,
      outputDir,
      progressEvery: 0,
      maxTurns: 8,
    })
    const metadata = loadQ5Metadata(path.join(outputDir, 'metadata.json'))

    expect(metadata.totalGames).toBe(40)
    expect(metadata.summary.finalQTableEntries).toBe(Object.keys(result.qTable).length)
    expect(metadata.summary.finalQTableEntries).toBeGreaterThan(0)
    expect(metadata.summary.qTotal.qHits + metadata.summary.qTotal.qMisses).toBe(
      metadata.games.reduce((sum, game) => sum + game.qHits + game.qMisses, 0),
    )
    expect(metadata.summary.rewards.minIntermediateReward).toBeGreaterThanOrEqual(-0.1)
    expect(metadata.summary.rewards.maxIntermediateReward).toBeLessThanOrEqual(0.1)
    expect(metadata.summary.rewards.averageTotalReward).toBeTypeOf('number')
    expect(metadata.rewardLog.every((log) => Number.isFinite(log.totalReward))).toBe(true)
    expectMetadataConsistency(metadata)
    validateQ5PilotMetadata(metadata)
  }, 15000)

  it('does not modify Q1, Q2, Q3 or Q4 files while running Q5', async () => {
    const trackedSources = [
      'src/training/trainLearningAgent.ts',
      'src/training/trainLearningAgentQ2.ts',
      'src/training/trainLearningAgentQ3.ts',
      'src/training/trainLearningAgentQ4.ts',
      'src/agents/learningPolicyQ3.ts',
    ]
    const before = Object.fromEntries(
      trackedSources.map((file) => [file, readFileSync(path.resolve(file), 'utf8')]),
    )

    await runLearningAgentQ5Training({
      totalGames: 4,
      seed: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4_integrity'),
      progressEvery: 0,
      maxTurns: 8,
    })

    for (const file of trackedSources) {
      expect(readFileSync(path.resolve(file), 'utf8')).toBe(before[file])
    }
  })
})
