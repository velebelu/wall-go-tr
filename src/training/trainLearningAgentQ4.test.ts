import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { makeInitialState } from '@/store/gameState'
import { getBestHeuristicAction, getBestPlacement, getLegalActions } from '@/utils/ai'
import { DEFAULT_Q3_TRAINING_CONFIG, Q3_REWARD_CONFIG } from './trainLearningAgentQ3'
import {
  DEFAULT_Q2_TRAINING_CONFIG,
  Q2_REWARD_CONFIG,
  calculateFinalRewardQ2,
  calculateIntermediateRewardQ2,
} from './trainLearningAgentQ2'
import {
  DEFAULT_Q4_TRAINING_CONFIG,
  Q4_REWARD_CONFIG,
  buildBalancedQ4Schedule,
  chooseLearningActionQ4,
  chooseRandomActionWithRngQ4,
  chooseHeuristicOpponentActionQ4,
  createSeededRngQ4,
  loadQ4Metadata,
  runLearningAgentQ4Training,
  validateQ4PilotMetadata,
  type Q4TrainingMetadata,
  type Q4TrainingScheduleItem,
} from './trainLearningAgentQ4'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q4-'))
}

function countSchedule(schedule: Q4TrainingScheduleItem[]) {
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

function expectMetadataConsistency(metadata: Q4TrainingMetadata): void {
  const games = metadata.games
  expect(games).toHaveLength(metadata.totalGames)
  expect(metadata.summary.results.games).toBe(games.length)

  for (const opponent of ['random', 'heuristic'] as const) {
    const opponentGames = games.filter((game) => game.opponent === opponent)
    expect(metadata.summary.gamesByOpponent[opponent]).toBe(opponentGames.length)
    expect(metadata.summary.resultsByOpponent[opponent].games).toBe(opponentGames.length)
    expect(metadata.summary.qByOpponent[opponent].qHits).toBe(
      opponentGames.reduce((sum, game) => sum + game.qHits, 0),
    )
    expect(metadata.summary.qByOpponent[opponent].qMisses).toBe(
      opponentGames.reduce((sum, game) => sum + game.qMisses, 0),
    )
  }

  for (const color of ['R', 'B'] as const) {
    const colorGames = games.filter((game) => game.learningColor === color)
    expect(metadata.summary.gamesByColor[color]).toBe(colorGames.length)
    expect(metadata.summary.resultsByColor[color].games).toBe(colorGames.length)
  }

  for (const key of ['random_R', 'random_B', 'heuristic_R', 'heuristic_B']) {
    const [opponent, color] = key.split('_') as ['random' | 'heuristic', 'R' | 'B']
    const combinationGames = games.filter(
      (game) => game.opponent === opponent && game.learningColor === color,
    )
    expect(metadata.summary.gamesByCombination[key]).toBe(combinationGames.length)
    expect(metadata.summary.resultsByCombination[key].games).toBe(combinationGames.length)
  }
}

describe('trainLearningAgentQ4 configuration', () => {
  it('keeps Q3 hyperparameters and Q2 reward configuration', () => {
    expect(DEFAULT_Q4_TRAINING_CONFIG.alpha).toBe(DEFAULT_Q3_TRAINING_CONFIG.alpha)
    expect(DEFAULT_Q4_TRAINING_CONFIG.gamma).toBe(DEFAULT_Q3_TRAINING_CONFIG.gamma)
    expect(DEFAULT_Q4_TRAINING_CONFIG.epsilonStart).toBe(DEFAULT_Q3_TRAINING_CONFIG.epsilonStart)
    expect(DEFAULT_Q4_TRAINING_CONFIG.epsilonMin).toBe(DEFAULT_Q3_TRAINING_CONFIG.epsilonMin)
    expect(DEFAULT_Q4_TRAINING_CONFIG.epsilonDecay).toBe(DEFAULT_Q3_TRAINING_CONFIG.epsilonDecay)
    expect(DEFAULT_Q4_TRAINING_CONFIG.maxTurns).toBe(DEFAULT_Q3_TRAINING_CONFIG.maxTurns)
    expect(DEFAULT_Q4_TRAINING_CONFIG.alpha).toBe(DEFAULT_Q2_TRAINING_CONFIG.alpha)
    expect(Q4_REWARD_CONFIG).toEqual(Q3_REWARD_CONFIG)
    expect(Q4_REWARD_CONFIG).toEqual(Q2_REWARD_CONFIG)
  })

  it('uses Q3 representation keys and Q2 reward functions', () => {
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const qTable = { [getLearningQTableKeyQ3(state, action)]: 7 }
    const choice = chooseLearningActionQ4(state, [action], 0, qTable, () => 0)

    expect(choice.action).toEqual(action)
    expect(choice.selectedKeyExists).toBe(true)
    expect(calculateFinalRewardQ2('R', { R: 30, B: 10 }, 'R')).toBe(120)
    expect(calculateIntermediateRewardQ2(makeInitialState(), makeInitialState(), 'R')).toBe(0)
  })

  it('starts from an empty table and does not accept a previous table input', async () => {
    const result = await runLearningAgentQ4Training({
      totalGames: 4,
      seed: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4'),
      progressEvery: 0,
      maxTurns: 8,
    })

    expect(result.metadata.startedFromEmptyQTable).toBe(true)
    expect(result.metadata.initialQTableEntries).toBe(0)
    expect(Object.keys(result.qTable).length).toBeGreaterThan(0)
    expect('qTable' in DEFAULT_Q4_TRAINING_CONFIG).toBe(false)
  })

  it('does not reference heuristic traces or previous Q-tables', () => {
    const source = readFileSync(path.resolve('src/training/trainLearningAgentQ4.ts'), 'utf8')

    expect(source).not.toContain('qtable_from_heuristics')
    expect(source).not.toContain('training_game_')
    expect(source).not.toContain('loadQ3Checkpoint')
    expect(source).not.toContain('loadQ2Checkpoint')
    expect(source).not.toContain('runLearningAgentQ3Training')
  })
})

describe('trainLearningAgentQ4 balanced schedule', () => {
  it('builds the exact 40-game pilot distribution', () => {
    const schedule = buildBalancedQ4Schedule(40, 3)

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
    const schedule = buildBalancedQ4Schedule(40, 3)

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

  it('is reproducible with the same seed and usually different with another seed', () => {
    const first = buildBalancedQ4Schedule(40, 3)
    const second = buildBalancedQ4Schedule(40, 3)
    const third = buildBalancedQ4Schedule(40, 13)

    expect(second).toEqual(first)
    expect(third).not.toEqual(first)
  })

  it('does not use ambient Math.random for schedule or random decisions', () => {
    const previous = Math.random
    Math.random = () => {
      throw new Error('ambient Math.random should not be used')
    }

    try {
      const schedule = buildBalancedQ4Schedule(40, 3)
      const action = chooseRandomActionWithRngQ4(
        [
          { type: 'place', pos: { x: 0, y: 0 } },
          { type: 'place', pos: { x: 1, y: 0 } },
        ],
        createSeededRngQ4(3),
      )

      expect(schedule).toHaveLength(40)
      expect(action.type).toBe('place')
    } finally {
      Math.random = previous
    }
  })
})

describe('trainLearningAgentQ4 heuristic opponent', () => {
  it('uses the exact shared heuristic helpers with default policy', () => {
    const source = readFileSync(path.resolve('src/training/trainLearningAgentQ4.ts'), 'utf8')

    expect(getBestPlacement).toBeTypeOf('function')
    expect(getBestHeuristicAction).toBeTypeOf('function')
    expect(source).toContain('ai.getBestPlacement(state)')
    expect(source).toContain('ai.getBestHeuristicAction(state)')
    expect(source).not.toContain("getBestHeuristicAction(state, 'offensive')")
    expect(source).not.toContain("getBestHeuristicAction(state, 'defensive')")
  })

  it('can select heuristic actions as R and B', () => {
    const stateR = makeInitialState()
    const stateB = makeInitialState()
    stateB.turn = 'B'

    expect(chooseHeuristicOpponentActionQ4(stateR, createSeededRngQ4(3)).type).toBe('place')
    expect(chooseHeuristicOpponentActionQ4(stateB, createSeededRngQ4(3)).type).toBe('place')
  })
})

describe('trainLearningAgentQ4 pilot metadata', () => {
  it('can play all four opponent-color conditions and writes consistent metadata', async () => {
    const result = await runLearningAgentQ4Training({
      totalGames: 4,
      seed: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4'),
      progressEvery: 0,
      maxTurns: 20,
    })

    expect(countSchedule(result.metadata.schedule)).toMatchObject({
      random: 2,
      heuristic: 2,
      R: 2,
      B: 2,
      random_R: 1,
      random_B: 1,
      heuristic_R: 1,
      heuristic_B: 1,
    })
    expectMetadataConsistency(result.metadata)
    expect(result.metadata.heuristicPolicy.policy).toBe('default')
  })

  it(
    'writes and reloads a valid 40-game pilot metadata file',
    async () => {
      const outputDir = path.join(makeTempDir(), 'pilot_40')
      const result = await runLearningAgentQ4Training({
        totalGames: 40,
        seed: 3,
        outputDir,
        progressEvery: 0,
        maxTurns: 8,
      })
      const metadata = loadQ4Metadata(path.join(outputDir, 'metadata.json'))

      expect(metadata.totalGames).toBe(40)
      expect(metadata.summary.finalQTableEntries).toBe(Object.keys(result.qTable).length)
      expect(metadata.summary.finalQTableEntries).toBeGreaterThan(0)
      expectMetadataConsistency(metadata)
      validateQ4PilotMetadata(metadata)
    },
    15000,
  )

  it('is reproducible in schedule and configuration with the same seed', async () => {
    const first = await runLearningAgentQ4Training({
      totalGames: 4,
      seed: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4_a'),
      progressEvery: 0,
      maxTurns: 8,
    })
    const second = await runLearningAgentQ4Training({
      totalGames: 4,
      seed: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4_b'),
      progressEvery: 0,
      maxTurns: 8,
    })

    expect(second.metadata.schedule).toEqual(first.metadata.schedule)
    expect(second.metadata.hyperparameters).toEqual(first.metadata.hyperparameters)
    expect(second.metadata.targetDistribution).toEqual(first.metadata.targetDistribution)
  })

  it('does not modify Q1, Q2 or Q3 files while running Q4', async () => {
    const trackedSources = [
      'src/training/trainLearningAgent.ts',
      'src/training/trainLearningAgentQ2.ts',
      'src/training/trainLearningAgentQ3.ts',
      'src/training/evaluateLearningAgentQ3.ts',
    ]
    const before = Object.fromEntries(
      trackedSources.map((file) => [file, readFileSync(path.resolve(file), 'utf8')]),
    )

    await runLearningAgentQ4Training({
      totalGames: 4,
      seed: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4'),
      progressEvery: 0,
      maxTurns: 8,
    })

    for (const file of trackedSources) {
      expect(readFileSync(path.resolve(file), 'utf8')).toBe(before[file])
    }
  })

  it('records Q hits and misses separated by rival', async () => {
    const result = await runLearningAgentQ4Training({
      totalGames: 8,
      seed: 3,
      outputDir: path.join(makeTempDir(), 'pilot_8'),
      progressEvery: 0,
      maxTurns: 30,
    })

    expect(result.metadata.summary.qByOpponent.random.qHits).toBeGreaterThanOrEqual(0)
    expect(result.metadata.summary.qByOpponent.random.qMisses).toBeGreaterThan(0)
    expect(result.metadata.summary.qByOpponent.heuristic.qHits).toBeGreaterThanOrEqual(0)
    expect(result.metadata.summary.qByOpponent.heuristic.qMisses).toBeGreaterThan(0)
    expect(
      result.metadata.summary.qByOpponent.random.qHits +
        result.metadata.summary.qByOpponent.random.qMisses +
        result.metadata.summary.qByOpponent.heuristic.qHits +
        result.metadata.summary.qByOpponent.heuristic.qMisses,
    ).toBeGreaterThan(0)
  })

  it('keeps complete move-wall Q3 action encoding available', () => {
    const state = makeInitialState()
    state.phase = 'playing'
    state.turn = 'R'
    state.stonesPlaced = { R: 4, B: 4 }
    const action = getLegalActions(state).find(
      (candidate) => candidate.type === 'move' && candidate.followUp,
    )

    expect(action).toBeTruthy()
    expect(getLearningQTableKeyQ3(state, action!)).toContain('|||move-wall|')
    expect(getLearningQTableKeyQ3(state, action!).split('|||')[1]?.split('|')).toHaveLength(8)
  })
})
