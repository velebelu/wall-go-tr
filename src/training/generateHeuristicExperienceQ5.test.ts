import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Q5_HEURISTIC_EXPERIENCE_MAX_TURNS,
  buildBalancedQ5HeuristicExperienceSchedule,
  generateHeuristicExperienceQ5,
  loadQ5HeuristicExperienceMetadata,
  validateQ5HeuristicExperiencePilotMetadata,
  type Q5HeuristicExperienceMetadata,
  type Q5HeuristicExperienceScheduleItem,
} from './generateHeuristicExperienceQ5'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q5-exp-'))
}

function countSchedule(schedule: Q5HeuristicExperienceScheduleItem[]) {
  return {
    random: schedule.filter((item) => item.opponent === 'random').length,
    heuristic: schedule.filter((item) => item.opponent === 'heuristic').length,
    R: schedule.filter((item) => item.heuristicColor === 'R').length,
    B: schedule.filter((item) => item.heuristicColor === 'B').length,
    random_R: schedule.filter((item) => item.opponent === 'random' && item.heuristicColor === 'R')
      .length,
    random_B: schedule.filter((item) => item.opponent === 'random' && item.heuristicColor === 'B')
      .length,
    heuristic_R: schedule.filter(
      (item) => item.opponent === 'heuristic' && item.heuristicColor === 'R',
    ).length,
    heuristic_B: schedule.filter(
      (item) => item.opponent === 'heuristic' && item.heuristicColor === 'B',
    ).length,
  }
}

function expectMetadataConsistency(metadata: Q5HeuristicExperienceMetadata): void {
  const games = metadata.games
  expect(metadata.summary.totalGames).toBe(games.length)
  expect(metadata.summary.totalExperiences).toBe(
    games.reduce((sum, game) => sum + game.experiences, 0),
  )

  for (const opponent of ['random', 'heuristic'] as const) {
    const opponentGames = games.filter((game) => game.opponent === opponent)
    expect(metadata.summary.gamesByOpponent[opponent]).toBe(opponentGames.length)
    expect(metadata.summary.resultsByOpponent[opponent].games).toBe(opponentGames.length)
  }

  for (const color of ['R', 'B'] as const) {
    const colorGames = games.filter((game) => game.heuristicColor === color)
    expect(metadata.summary.gamesByColor[color]).toBe(colorGames.length)
    expect(metadata.summary.resultsByColor[color].games).toBe(colorGames.length)
  }
}

describe('generateHeuristicExperienceQ5 schedule', () => {
  it('builds the exact 40-game balanced pilot distribution', () => {
    const schedule = buildBalancedQ5HeuristicExperienceSchedule(40, 3)

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
    expect(schedule[0]).toMatchObject({ gameId: 1, seed: 3001 })
    expect(schedule[39]).toMatchObject({ gameId: 40, seed: 3040 })
  })

  it('keeps every block of four balanced', () => {
    const schedule = buildBalancedQ5HeuristicExperienceSchedule(40, 3)

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
})

describe('generateHeuristicExperienceQ5 workflow', () => {
  it('records one experience for every focal heuristic action', async () => {
    const result = await generateHeuristicExperienceQ5({
      totalGames: 4,
      seedBase: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4'),
      maxTurns: 12,
    })

    expect(result.experiences.length).toBeGreaterThan(0)
    for (const game of result.metadata.games) {
      expect(
        result.experiences.filter((experience) => experience.gameId === game.gameId),
      ).toHaveLength(game.experiences)
    }
    expectMetadataConsistency(result.metadata)
  })

  it('stores Q3 states, legal heuristic actions and post-action metrics', async () => {
    const result = await generateHeuristicExperienceQ5({
      totalGames: 4,
      seedBase: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4_q3'),
      maxTurns: 12,
    })

    for (const experience of result.experiences) {
      expect(experience.previousQ3State.startsWith('q3|')).toBe(true)
      expect(experience.nextQ3State.startsWith('q3|')).toBe(true)
      expect(experience.heuristicActionQ3Key.length).toBeGreaterThan(0)
      expect(experience.legalActionsAvailable).toBeGreaterThan(0)
      expect(experience.legalActionQ3Keys).toContain(experience.heuristicActionQ3Key)
      expect(experience.actionWasLegal).toBe(true)
      expect(experience.totalTurns).toBeGreaterThanOrEqual(experience.turnNumber)
    }
  })

  it('writes metadata, summary and JSONL without creating a Q-table', async () => {
    const outputDir = path.join(makeTempDir(), 'pilot_4_files')
    const result = await generateHeuristicExperienceQ5({
      totalGames: 4,
      seedBase: 3,
      outputDir,
      maxTurns: 12,
    })
    const metadata = loadQ5HeuristicExperienceMetadata(path.join(outputDir, 'metadata.json'))
    const jsonl = readFileSync(path.join(outputDir, 'experiences.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

    expect(metadata.qTableCreated).toBe(false)
    expect(metadata.qLearningTrainingExecuted).toBe(false)
    expect(metadata.stateRepresentation).toBe('Q3')
    expect(metadata.heuristicPolicy.policy).toBe('default')
    expect(existsSync(path.join(outputDir, 'experience_summary.json'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'qtable_q5_initial.json'))).toBe(false)
    expect(jsonl).toHaveLength(result.experiences.length)
  })

  it('validates pilot metadata shape without running the full pilot', () => {
    const schedule = buildBalancedQ5HeuristicExperienceSchedule(40, 3)
    const metadata = {
      model: 'Q5',
      artifact: 'heuristic_experience',
      seedBase: 3,
      totalGames: 40,
      maxTurns: Q5_HEURISTIC_EXPERIENCE_MAX_TURNS,
      stateRepresentation: 'Q3',
      qTableCreated: false,
      qLearningTrainingExecuted: false,
      heuristicPolicy: {
        placement: 'getBestPlacement',
        playing: 'getBestHeuristicAction',
        policy: 'default',
      },
      targetDistribution: {
        opponents: { random: 20, heuristic: 20 },
        colors: { R: 20, B: 20 },
        combinations: {
          random_R: 10,
          random_B: 10,
          heuristic_R: 10,
          heuristic_B: 10,
        },
      },
      schedule,
      games: [],
      summary: {
        totalGames: 40,
        totalExperiences: 1,
        gamesByOpponent: { random: 20, heuristic: 20 },
        gamesByColor: { R: 20, B: 20 },
        gamesByCombination: {
          random_R: 10,
          random_B: 10,
          heuristic_R: 10,
          heuristic_B: 10,
        },
        experiencesByOpponent: { random: 1, heuristic: 0 },
        experiencesByColor: { R: 1, B: 0 },
        results: { games: 40, wins: 0, losses: 0, ties: 0 },
        resultsByOpponent: {
          random: { games: 20, wins: 0, losses: 0, ties: 0 },
          heuristic: { games: 20, wins: 0, losses: 0, ties: 0 },
        },
        resultsByColor: {
          R: { games: 20, wins: 0, losses: 0, ties: 0 },
          B: { games: 20, wins: 0, losses: 0, ties: 0 },
        },
        averageTerritory: { heuristic: 0, opponent: 0 },
        averageTerritoryDiff: 0,
        averagePreviousOwnMobility: 0,
        averageNextOwnMobility: 0,
        averagePreviousOwnTrappedPieces: 0,
        averageNextOwnTrappedPieces: 0,
        averageTurns: 0,
      },
      createdAt: '2026-07-12T00:00:00.000Z',
      durationMs: 0,
      outputFiles: {
        metadata: 'metadata.json',
        experienceSummary: 'experience_summary.json',
        experiencesJsonl: 'experiences.jsonl',
      },
    } satisfies Q5HeuristicExperienceMetadata

    expect(() => validateQ5HeuristicExperiencePilotMetadata(metadata)).not.toThrow()
  })

  it('does not modify Q1, Q2, Q3, Q4 or the Q5 reward pilot while generating', async () => {
    const trackedPaths = [
      'src/training/trainLearningAgent.ts',
      'src/training/trainLearningAgentQ2.ts',
      'src/training/trainLearningAgentQ3.ts',
      'src/training/trainLearningAgentQ4.ts',
      'src/training/trainLearningAgentQ5.ts',
      'src/training/trainLearningAgentQ5.test.ts',
      'data/entrenamiento/q5/pilot_40/metadata.json',
      'data/entrenamiento/q5/pilot_40/training_summary.json',
      'data/entrenamiento/q5/pilot_40/qtable_q5_pilot_40.json',
    ].filter((file) => existsSync(path.resolve(file)))
    const before = Object.fromEntries(
      trackedPaths.map((file) => [file, readFileSync(path.resolve(file), 'utf8')]),
    )

    await generateHeuristicExperienceQ5({
      totalGames: 4,
      seedBase: 3,
      outputDir: path.join(makeTempDir(), 'pilot_4_integrity'),
      maxTurns: 12,
    })

    for (const file of trackedPaths) {
      expect(readFileSync(path.resolve(file), 'utf8')).toBe(before[file])
    }
  })
})
