import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { makeInitialState } from '@/store/gameState'
import type { Q5HeuristicExperienceRecord } from './generateHeuristicExperienceQ5'
import {
  Q5_HEURISTIC_INITIAL_EVALUATION_GAMES_PER_COLOR,
  Q5_HEURISTIC_INITIAL_EVALUATION_MAX_TURNS,
  buildHeuristicInitialQTableQ5,
  calculateHeuristicInitialExperienceValue,
  evaluateHeuristicInitialQTableQ5,
} from './buildHeuristicQTableQ5'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q5-build-'))
}

function writeExperiences(filePath: string, experiences: Q5HeuristicExperienceRecord[]): void {
  writeFileSync(filePath, `${experiences.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
}

function makeExperience(
  overrides: Partial<Q5HeuristicExperienceRecord> = {},
): Q5HeuristicExperienceRecord {
  const state = makeInitialState()
  const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
  const [stateKey, actionKey] = getLearningQTableKeyQ3(state, action).split('|||') as [
    string,
    string,
  ]
  return {
    experienceId: '1:1',
    gameId: 1,
    seed: 3001,
    opponent: 'random',
    heuristicColor: 'R',
    turnNumber: 1,
    previousQ3State: stateKey,
    heuristicAction: action,
    heuristicActionQ3Key: actionKey,
    nextQ3State: stateKey,
    previousTerritoryDiff: 0,
    nextTerritoryDiff: 2,
    previousOwnMobility: 4,
    nextOwnMobility: 7,
    previousOwnTrappedPieces: 1,
    nextOwnTrappedPieces: 0,
    legalActionsAvailable: 49,
    legalActionQ3Keys: [actionKey],
    actionWasLegal: true,
    winner: 'R',
    finalTerritoryDiff: 10,
    totalTurns: 20,
    ...overrides,
  }
}

describe('buildHeuristicQTableQ5 value formula', () => {
  it('combines result, territory, mobility and trapped-piece signals', () => {
    const value = calculateHeuristicInitialExperienceValue(makeExperience())

    expect(value.value).toBeCloseTo(1 + 0.1 + 0.06 + 0.3, 6)
    expect(value.clamped).toBe(false)
  })

  it('clamps individual experience values to [-2, 2]', () => {
    const value = calculateHeuristicInitialExperienceValue(
      makeExperience({
        previousTerritoryDiff: -100,
        nextTerritoryDiff: 100,
        previousOwnMobility: 0,
        nextOwnMobility: 100,
        previousOwnTrappedPieces: 10,
        nextOwnTrappedPieces: 0,
      }),
    )

    expect(value.value).toBe(2)
    expect(value.clamped).toBe(true)
  })
})

describe('buildHeuristicQTableQ5 workflow', () => {
  it('builds one averaged Q value per state-action pair with observation stats', async () => {
    const tempDir = makeTempDir()
    const experiencePath = path.join(tempDir, 'experiences.jsonl')
    const first = makeExperience({ experienceId: '1:1', nextTerritoryDiff: 2 })
    const second = makeExperience({ experienceId: '2:1', nextTerritoryDiff: 4 })
    const third = makeExperience({
      experienceId: '3:1',
      heuristicActionQ3Key: 'place|0|0',
      opponent: 'heuristic',
      heuristicColor: 'B',
      winner: 'R',
      nextTerritoryDiff: -4,
      previousOwnMobility: 4,
      nextOwnMobility: 2,
      previousOwnTrappedPieces: 0,
      nextOwnTrappedPieces: 1,
    })
    writeExperiences(experiencePath, [first, second, third])

    const result = await buildHeuristicInitialQTableQ5({
      experiencePath,
      outputDir: path.join(tempDir, 'qtable'),
    })

    expect(result.summary.totalExperiencesProcessed).toBe(3)
    expect(result.summary.uniqueStateActionPairs).toBe(2)
    expect(Object.keys(result.qTable)).toHaveLength(2)
    expect(new Set(Object.keys(result.qTable)).size).toBe(Object.keys(result.qTable).length)
    const repeated = result.summary.entries.find((entry) => entry.observations === 2)
    const low = result.summary.entries.find((entry) => entry.observations === 1)
    expect(repeated?.lowConfidence).toBe(false)
    expect(low?.lowConfidence).toBe(true)
    expect(repeated?.standardDeviation).toBeGreaterThanOrEqual(0)
    expect(result.summary.frequencyBuckets.one).toBe(1)
    expect(result.summary.frequencyBuckets.twoToFive).toBe(1)
    expect(result.summary.illegalActionExperiences).toBe(0)
    expect(result.summary.nonQ3Experiences).toBe(0)
    expect(existsSync(path.join(tempDir, 'qtable', 'qtable_q5_heuristic_initial.json'))).toBe(true)
    expect(existsSync(path.join(tempDir, 'qtable', 'metadata.json'))).toBe(true)
    expect(existsSync(path.join(tempDir, 'qtable', 'build_summary.json'))).toBe(true)
  })

  it('ignores illegal or non-Q3 experiences while reporting them', async () => {
    const tempDir = makeTempDir()
    const experiencePath = path.join(tempDir, 'experiences.jsonl')
    writeExperiences(experiencePath, [
      makeExperience(),
      makeExperience({ experienceId: 'bad-action', actionWasLegal: false }),
      makeExperience({ experienceId: 'bad-state', previousQ3State: 'q2|legacy' }),
    ])

    const result = await buildHeuristicInitialQTableQ5({
      experiencePath,
      outputDir: path.join(tempDir, 'qtable'),
    })

    expect(result.summary.totalExperiencesProcessed).toBe(3)
    expect(result.summary.illegalActionExperiences).toBe(1)
    expect(result.summary.nonQ3Experiences).toBe(1)
    expect(Object.keys(result.qTable)).toHaveLength(1)
  })

  it('evaluates a frozen table with the Q3/Q4 evaluation protocol shape', async () => {
    const tempDir = makeTempDir()
    const qTablePath = path.join(tempDir, 'qtable.json')
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    writeFileSync(
      qTablePath,
      `${JSON.stringify({ [getLearningQTableKeyQ3(state, action)]: 1 }, null, 2)}\n`,
      'utf8',
    )
    const before = readFileSync(qTablePath, 'utf8')

    const result = await evaluateHeuristicInitialQTableQ5({
      qTablePath,
      outputDir: path.join(tempDir, 'eval'),
      gamesPerColor: 1,
      maxTurns: 8,
      seed: 77,
    })

    expect(readFileSync(qTablePath, 'utf8')).toBe(before)
    expect(result.summary.qTableChangedDuringEvaluation).toBe(false)
    expect(result.summary.qTableHashBefore).toBe(result.summary.qTableHashAfter)
    expect(result.summary.checkpoint).toBe('heuristic_initial')
    expect(result.summary.evaluationProtocol.epsilon).toBe(0)
    expect(result.summary.evaluationProtocol.learnsDuringEvaluation).toBe(false)
    expect(result.summary.evaluationProtocol.alphaUpdates).toBe(false)
    expect(result.summary.evaluationProtocol.qTableFrozen).toBe(true)
    expect(result.summary.evaluationProtocol.representation).toBe('Q3')
    expect(result.results).toHaveLength(4)
    expect(result.summary.experiments.every((experiment) => experiment.games === 2)).toBe(true)
    expect(existsSync(path.join(tempDir, 'eval', 'learning_comparison_summary.json'))).toBe(true)
    expect(existsSync(path.join(tempDir, 'eval', 'learning_comparison_results.csv'))).toBe(true)
    expect(existsSync(path.join(tempDir, 'eval', 'evaluation_metadata.json'))).toBe(true)
  })

  it('can label the frozen evaluation as Q5-500', async () => {
    const tempDir = makeTempDir()
    const qTablePath = path.join(tempDir, 'qtable.json')
    writeFileSync(qTablePath, '{}\n', 'utf8')

    const result = await evaluateHeuristicInitialQTableQ5({
      qTablePath,
      outputDir: path.join(tempDir, 'eval-500'),
      checkpoint: 'Q5-500',
      gamesPerColor: 1,
      maxTurns: 4,
      seed: 88,
    })

    expect(result.summary.checkpoint).toBe('Q5-500')
    expect(result.summary.qTableChangedDuringEvaluation).toBe(false)
  })

  it('keeps the official evaluation protocol constants', () => {
    expect(Q5_HEURISTIC_INITIAL_EVALUATION_GAMES_PER_COLOR).toBe(100)
    expect(Q5_HEURISTIC_INITIAL_EVALUATION_MAX_TURNS).toBe(250)
  })

  it('does not contain Q-learning updates or checkpoint training commands', () => {
    const source = readFileSync(path.resolve('src/training/buildHeuristicQTableQ5.ts'), 'utf8')

    expect(source).not.toContain('updateQValue')
    expect(source).not.toContain('calculateIntermediateRewardQ5')
    expect(source).not.toContain('train-500')
    expect(source).not.toContain('train-1000')
    expect(source).not.toContain('train-1500')
    expect(source).not.toContain('train-2000')
  })
})
