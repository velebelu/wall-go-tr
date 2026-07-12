import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { makeInitialState } from '@/store/gameState'
import {
  DEFAULT_Q4_2000_QTABLE_PATH,
  DEFAULT_Q4_EVALUATION_SEED,
  Q4_EVALUATION_GAMES_PER_COLOR,
  Q4_EVALUATION_MAX_TURNS,
  hashQ4FileForTest,
  inspectQ4ActionChoice,
  runLearningAgentQ4Evaluation,
} from './evaluateLearningAgentQ4'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q4-eval-'))
}

function writeQTable(dir: string, qTable: Record<string, number>): string {
  const filePath = path.join(dir, 'qtable_q4_test.json')
  writeFileSync(filePath, `${JSON.stringify(qTable, null, 2)}\n`, 'utf8')
  return filePath
}

describe('evaluateLearningAgentQ4 action inspection', () => {
  it('uses Q3 keys and complete move-wall action encoding', () => {
    const state = makeInitialState()
    state.phase = 'playing'
    state.turn = 'R'
    state.stonesPlaced = { R: 4, B: 4 }
    const top = {
      type: 'move' as const,
      from: { x: 1, y: 1 },
      pos: { x: 2, y: 2 },
      followUp: { type: 'wall' as const, pos: { x: 2, y: 2 }, dir: 'top' as const },
    }
    const left = {
      ...top,
      followUp: { type: 'wall' as const, pos: { x: 2, y: 2 }, dir: 'left' as const },
    }
    const qTable = { [getLearningQTableKeyQ3(state, left)]: 10 }

    const choice = inspectQ4ActionChoice(state, [top, left], qTable, () => 0)

    expect(choice.action).toEqual(left)
    expect(choice.diagnostics.selectedKey).toContain('|||move-wall|')
    expect(choice.diagnostics.selectedKey.split('|||')[1]?.split('|')).toHaveLength(8)
    expect(choice.diagnostics.q2KeyCount).toBe(0)
    expect(choice.diagnostics.invalidKeyCount).toBe(0)
  })
})

describe('evaluateLearningAgentQ4 workflow', () => {
  it('uses the Q3-2000 evaluation protocol shape for Q4-2000', () => {
    expect(DEFAULT_Q4_2000_QTABLE_PATH).toBe(
      'data/entrenamiento/q4/checkpoint_2000/qtable_q4_2000.json',
    )
    expect(DEFAULT_Q4_EVALUATION_SEED).toBe(302000)
    expect(Q4_EVALUATION_GAMES_PER_COLOR).toBe(100)
    expect(Q4_EVALUATION_MAX_TURNS).toBe(250)
  })

  it('loads a Q4 table, keeps it fixed, and writes outputs', async () => {
    const tempDir = makeTempDir()
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const qTablePath = writeQTable(tempDir, { [getLearningQTableKeyQ3(state, action)]: 5 })
    const before = readFileSync(qTablePath, 'utf8')
    const hashBefore = hashQ4FileForTest(qTablePath)

    const result = await runLearningAgentQ4Evaluation({
      qTablePath,
      outputDir: path.join(tempDir, 'evaluation'),
      gamesPerColor: 1,
      maxTurns: 8,
      seed: 12,
    })

    expect(readFileSync(qTablePath, 'utf8')).toBe(before)
    expect(result.summary.qTableHashBefore).toBe(hashBefore)
    expect(result.summary.qTableHashAfter).toBe(hashBefore)
    expect(result.summary.qTableChangedDuringEvaluation).toBe(false)
    expect(result.summary.evaluationProtocol.epsilon).toBe(0)
    expect(result.summary.evaluationProtocol.learnsDuringEvaluation).toBe(false)
    expect(result.summary.evaluationProtocol.alphaUpdates).toBe(false)
    expect(result.summary.evaluationProtocol.qTableFrozen).toBe(true)
    expect(result.summary.experiments.map((item) => item.rival)).toEqual(['random', 'heuristic'])
    expect(result.summary.experiments.every((item) => item.games === 2)).toBe(true)
    expect(existsSync(path.join(tempDir, 'evaluation', 'learning_comparison_summary.json'))).toBe(
      true,
    )
    expect(existsSync(path.join(tempDir, 'evaluation', 'learning_comparison_results.csv'))).toBe(
      true,
    )
    expect(existsSync(path.join(tempDir, 'evaluation', 'evaluation_metadata.json'))).toBe(true)
  })

  it('keeps color balance per rival', async () => {
    const tempDir = makeTempDir()
    const qTablePath = writeQTable(tempDir, {})

    const result = await runLearningAgentQ4Evaluation({
      qTablePath,
      outputDir: path.join(tempDir, 'evaluation'),
      gamesPerColor: 2,
      maxTurns: 4,
      seed: 15,
    })

    for (const experiment of result.summary.experiments) {
      expect(experiment.byColor.R.games).toBe(2)
      expect(experiment.byColor.B.games).toBe(2)
      expect(experiment.games).toBe(4)
    }
  })

  it('is deterministic with the same seed', async () => {
    const tempDir = makeTempDir()
    const qTablePath = writeQTable(tempDir, {})

    const first = await runLearningAgentQ4Evaluation({
      qTablePath,
      outputDir: path.join(tempDir, 'evaluation-a'),
      gamesPerColor: 1,
      maxTurns: 4,
      seed: 21,
    })
    const second = await runLearningAgentQ4Evaluation({
      qTablePath,
      outputDir: path.join(tempDir, 'evaluation-b'),
      gamesPerColor: 1,
      maxTurns: 4,
      seed: 21,
    })

    expect(second.results).toEqual(first.results)
  })

  it('does not overwrite existing outputs', async () => {
    const tempDir = makeTempDir()
    const qTablePath = writeQTable(tempDir, {})
    const outputDir = path.join(tempDir, 'evaluation')
    await runLearningAgentQ4Evaluation({ qTablePath, outputDir, gamesPerColor: 1, maxTurns: 4 })

    await expect(
      runLearningAgentQ4Evaluation({ qTablePath, outputDir, gamesPerColor: 1, maxTurns: 4 }),
    ).rejects.toThrow('already exists')
  })

  it('does not contain learning updates or training checkpoint writes', () => {
    const source = readFileSync(path.resolve('src/training/evaluateLearningAgentQ4.ts'), 'utf8')

    expect(source).not.toContain('updateQValue')
    expect(source).not.toContain('calculateIntermediateRewardQ2')
    expect(source).not.toContain('calculateFinalRewardQ2')
    expect(source).not.toContain('qtable_q4_2000.json`, qTable')
    expect(source).toContain('epsilon: 0')
    expect(source).toContain('Object.freeze')
  })
})
