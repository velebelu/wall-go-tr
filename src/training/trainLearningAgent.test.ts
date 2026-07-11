import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLearningQTableKey, type QTableSnapshot } from '@/agents/learningPolicy'
import { makeInitialState } from '@/store/gameState'
import {
  evaluateCheckpoint,
  getLearningSideForGame,
  getTrainingOpponentForGame,
  loadCheckpoint,
  runLearningAgentTraining,
  updateQValue,
} from './trainLearningAgent'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-learning-'))
}

describe('trainLearningAgent', () => {
  it('updates the Q-table during training', async () => {
    const result = await runLearningAgentTraining({
      totalGames: 4,
      checkpoints: [],
      outputDir: makeTempDir(),
      progressEvery: 0,
    })

    expect(Object.keys(result.qTable).length).toBeGreaterThan(0)
    expect(Object.values(result.qTable).some((value) => value !== 0)).toBe(true)
  })

  it('saves cumulative checkpoints without restarting the Q-table', async () => {
    const outputDir = makeTempDir()

    await runLearningAgentTraining({
      totalGames: 6,
      checkpoints: [0, 3, 6],
      outputDir,
      progressEvery: 0,
    })

    const checkpoint3 = loadCheckpoint(path.join(outputDir, 'qtable_current_0003.json'))
    const checkpoint6 = loadCheckpoint(path.join(outputDir, 'qtable_current_0006.json'))

    expect(Object.keys(checkpoint3).length).toBeGreaterThan(0)
    expect(Object.keys(checkpoint6).length).toBeGreaterThanOrEqual(Object.keys(checkpoint3).length)
    expect(Object.keys(checkpoint3).every((key) => key in checkpoint6)).toBe(true)
  })

  it('uses getLearningQTableKey when updating values', () => {
    const qTable: QTableSnapshot = {}
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }

    updateQValue({
      qTable,
      state,
      action,
      reward: 1,
      nextState: undefined,
      terminal: true,
      alpha: 0.1,
      gamma: 0.9,
    })

    expect(qTable[getLearningQTableKey(state, action)]).toBe(0.1)
  })

  it('keeps colors balanced over an even number of games', () => {
    const colors = Array.from({ length: 20 }, (_, index) => getLearningSideForGame(index + 1))

    expect(colors.filter((color) => color === 'R')).toHaveLength(10)
    expect(colors.filter((color) => color === 'B')).toHaveLength(10)
  })

  it('uses the planned random-to-heuristic curriculum', () => {
    const opponents = Array.from({ length: 10 }, (_, index) =>
      getTrainingOpponentForGame(index + 1, 10),
    )

    expect(opponents.filter((opponent) => opponent === 'random')).toHaveLength(6)
    expect(opponents.filter((opponent) => opponent === 'heuristic')).toHaveLength(4)
  })

  it('decreases epsilon down toward the configured minimum', async () => {
    const result = await runLearningAgentTraining({
      totalGames: 4,
      checkpoints: [],
      outputDir: makeTempDir(),
      epsilonStart: 0.6,
      epsilonDecay: 0.5,
      epsilonMin: 0.1,
      progressEvery: 0,
    })

    expect(result.metadata.epsilonFinal).toBeLessThan(0.6)
    expect(result.metadata.epsilonFinal).toBeGreaterThanOrEqual(0.1)
  })

  it('saves checkpoint metadata and reloads the same Q-table', async () => {
    const outputDir = makeTempDir()

    await runLearningAgentTraining({
      totalGames: 2,
      checkpoints: [0, 2],
      outputDir,
      progressEvery: 0,
    })

    const qTablePath = path.join(outputDir, 'qtable_current_0002.json')
    const metadata = JSON.parse(
      readFileSync(path.join(outputDir, 'qtable_current_0002.metadata.json'), 'utf8'),
    ) as { games: number; qTableSize: number; wins: number; losses: number; ties: number }
    const loaded = loadCheckpoint(qTablePath)
    const rawLoaded = JSON.parse(readFileSync(qTablePath, 'utf8')) as QTableSnapshot

    expect(metadata.games).toBe(2)
    expect(metadata.wins + metadata.losses + metadata.ties).toBe(2)
    expect(metadata.qTableSize).toBe(Object.keys(loaded).length)
    expect(loaded).toEqual(rawLoaded)
  })

  it('evaluation loads a checkpoint without modifying it and writes metrics', async () => {
    const outputDir = makeTempDir()
    await runLearningAgentTraining({
      totalGames: 2,
      checkpoints: [2],
      outputDir,
      progressEvery: 0,
    })
    const qTablePath = path.join(outputDir, 'qtable_current_0002.json')
    const before = readFileSync(qTablePath, 'utf8')

    const evaluation = await evaluateCheckpoint({
      qTablePath,
      outputDir: path.join(outputDir, 'evaluation'),
      games: 1,
    })

    expect(readFileSync(qTablePath, 'utf8')).toBe(before)
    expect(evaluation.summary.experiments).toHaveLength(6)
    expect(evaluation.summary.experiments[0]).toHaveProperty('blocksOf10')
    expect(evaluation.summary.experiments[0]).toHaveProperty('learningDiagnostics')
  })
})
