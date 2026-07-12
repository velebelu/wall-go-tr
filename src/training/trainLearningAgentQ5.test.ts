import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { makeInitialState } from '@/store/gameState'
import { DEFAULT_Q4_TRAINING_CONFIG } from './trainLearningAgentQ4'
import {
  DEFAULT_Q5_TRAINING_CONFIG,
  Q5_REWARD_CONFIG,
  buildBalancedQ5Schedule,
  calculateFinalRewardQ5,
  calculateIntermediateRewardQ5FromMetrics,
  loadQ5Metadata,
  runLearningAgentQ5Training,
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

  it('does not reference existing Q-table checkpoints or official evaluation commands', () => {
    const source = readFileSync(path.resolve('src/training/trainLearningAgentQ5.ts'), 'utf8')

    expect(source).not.toContain('qtable_q4')
    expect(source).not.toContain('qtable_q3')
    expect(source).not.toContain('qtable_q2')
    expect(source).not.toContain('qtable_q1')
    expect(source).not.toContain('checkpoint_500')
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
