import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLearningQTableKey, type QTableSnapshot } from '@/agents/learningPolicy'
import { makeInitialState } from '@/store/gameState'
import {
  Q2_QTABLE_DIR,
  calculateFinalRewardQ2,
  calculateIntermediateRewardQ2,
  evaluateQ2Checkpoint,
  getMaxQValueQ2,
  getQ2LearningSideForGame,
  loadQ2Checkpoint,
  runLearningAgentQ2Training,
  saveQ2Checkpoint,
  updateQValueQ2,
  type Q2TrainingMetadata,
} from './trainLearningAgentQ2'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q2-'))
}

function makeMetadata(games: number, qTableSize: number, qTablePath: string): Q2TrainingMetadata {
  return {
    createdAt: '2026-07-11T00:00:00.000Z',
    model: 'Q2',
    games,
    qTableSize,
    epsilonStart: 0.6,
    epsilonFinal: 0.5,
    alpha: 0.1,
    gamma: 0.9,
    wins: 0,
    losses: 0,
    ties: 0,
    winRate: 0,
    averageTerritory: { learning: 0, opponent: 0 },
    opponents: { random: 0, heuristic: 0 },
    colorDistribution: { R: 0, B: 0 },
    reward: {
      win: 100,
      loss: -100,
      tie: 0,
      finalTerritoryDiffMultiplier: 1,
      intermediateTerritoryDeltaMultiplier: 0.01,
      intermediateMin: -0.05,
      intermediateMax: 0.05,
    },
    qTablePath,
  }
}

describe('trainLearningAgentQ2 rewards', () => {
  it('rewards victories strongly and includes territory difference', () => {
    expect(calculateFinalRewardQ2('R', { R: 30, B: 10 }, 'R')).toBe(120)
  })

  it('penalizes losses strongly and includes territory difference', () => {
    expect(calculateFinalRewardQ2('B', { R: 10, B: 30 }, 'R')).toBe(-120)
  })

  it('uses final territory difference for ties', () => {
    expect(calculateFinalRewardQ2('tie', { R: 21, B: 18 }, 'R')).toBe(3)
  })

  it('limits intermediate rewards to the configured range', () => {
    const prev = makeInitialState()
    const next = makeInitialState()
    next.board[0][0].stone = 'R'
    next.board[0][1].stone = 'R'
    next.board[0][2].stone = 'R'
    next.board[0][3].stone = 'R'
    next.board[0][4].stone = 'R'
    next.board[0][5].stone = 'R'

    expect(calculateIntermediateRewardQ2(prev, next, 'R')).toBeLessThanOrEqual(0.05)
    expect(calculateIntermediateRewardQ2(next, prev, 'R')).toBeGreaterThanOrEqual(-0.05)
  })
})

describe('trainLearningAgentQ2 Q update', () => {
  it('uses non-terminal maxQ from the next state', () => {
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const qTable: QTableSnapshot = { [getLearningQTableKey(state, action)]: 7 }

    expect(getMaxQValueQ2(state, qTable, false)).toBe(7)
  })

  it('uses maxQ 0 for terminal updates', () => {
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const qTable: QTableSnapshot = { [getLearningQTableKey(state, action)]: 7 }

    expect(getMaxQValueQ2(state, qTable, true)).toBe(0)
  })

  it('applies the Q-learning formula exactly', () => {
    const state = makeInitialState()
    const nextState = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const nextAction = { type: 'place' as const, pos: { x: 4, y: 3 } }
    const qTable: QTableSnapshot = {
      [getLearningQTableKey(state, action)]: 10,
      [getLearningQTableKey(nextState, nextAction)]: 20,
    }

    updateQValueQ2({
      qTable,
      state,
      action,
      reward: 5,
      nextState,
      terminal: false,
      alpha: 0.1,
      gamma: 0.9,
    })

    expect(qTable[getLearningQTableKey(state, action)]).toBe(11.3)
  })
})

describe('trainLearningAgentQ2 workflow', () => {
  it('keeps the Q-table cumulative during training', async () => {
    const result = await runLearningAgentQ2Training({
      totalGames: 4,
      checkpoints: [],
      outputDir: makeTempDir(),
      progressEvery: 0,
    })

    expect(Object.keys(result.qTable).length).toBeGreaterThan(0)
    expect(Object.values(result.qTable).some((value) => value !== 0)).toBe(true)
  })

  it('keeps evaluation fixed and writes Q2 metrics', async () => {
    const outputDir = makeTempDir()
    await runLearningAgentQ2Training({
      totalGames: 2,
      checkpoints: [2],
      outputDir,
      progressEvery: 0,
    })
    const qTablePath = path.join(outputDir, 'qtable_q2_0002.json')
    const before = readFileSync(qTablePath, 'utf8')

    const evaluation = await evaluateQ2Checkpoint({
      qTablePath,
      outputDir: path.join(outputDir, 'evaluation'),
      plan: [
        {
          experiment: {
            name: 'q2_test_vs_random',
            players: { R: 'learning-pretrained', B: 'random' },
          },
          games: 1,
        },
      ],
    })

    expect(readFileSync(qTablePath, 'utf8')).toBe(before)
    expect(evaluation.summary.model).toBe('Q2')
    expect(
      evaluation.summary.experiments[0].learningDiagnostics?.qTableChangedDuringEvaluation,
    ).toBe(false)
  })

  it('uses separate Q2 paths instead of Q1 paths', () => {
    expect(Q2_QTABLE_DIR).toBe('data/entrenamiento/q2/qtable')
  })

  it('keeps colors balanced', () => {
    const colors = Array.from({ length: 20 }, (_, index) => getQ2LearningSideForGame(index + 1))
    expect(colors.filter((color) => color === 'R')).toHaveLength(10)
    expect(colors.filter((color) => color === 'B')).toHaveLength(10)
  })

  it('saves and loads a Q2 checkpoint', () => {
    const outputDir = makeTempDir()
    const qTable = { example: 12 }
    const qTablePath = path.join(outputDir, 'qtable_q2_0002.json')
    saveQ2Checkpoint({
      qTable,
      outputDir,
      games: 2,
      metadata: makeMetadata(2, 1, qTablePath),
    })

    expect(loadQ2Checkpoint(qTablePath)).toEqual(qTable)
  })
})
