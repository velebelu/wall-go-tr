import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { makeInitialState } from '@/store/gameState'
import {
  DEFAULT_Q3_500_QTABLE_PATH,
  Q3_EVALUATION_GAMES_PER_COLOR,
  hashFileForTest,
  inspectQ3ActionChoice,
  runLearningAgentQ3Evaluation,
} from './evaluateLearningAgentQ3'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q3-eval-'))
}

function writeQTable(dir: string, qTable: Record<string, number>): string {
  const filePath = path.join(dir, 'qtable_q3_test.json')
  writeFileSync(filePath, `${JSON.stringify(qTable, null, 2)}\n`, 'utf8')
  return filePath
}

describe('evaluateLearningAgentQ3 action inspection', () => {
  it('uses complete Q3 move-wall keys and distinguishes different walls', () => {
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

    const choice = inspectQ3ActionChoice(state, [top, left], qTable, () => 0)

    expect(choice.action).toEqual(left)
    expect(choice.diagnostics.selectedKey).toContain('|||move-wall|')
    expect(choice.diagnostics.selectedKey.split('|||')[1]?.split('|')).toHaveLength(8)
    expect(getLearningQTableKeyQ3(state, top)).not.toBe(getLearningQTableKeyQ3(state, left))
    expect(choice.diagnostics.q2KeyCount).toBe(0)
    expect(choice.diagnostics.invalidKeyCount).toBe(0)
  })
})

describe('evaluateLearningAgentQ3 workflow', () => {
  it('loads the requested Q3 table, keeps it fixed, and writes outputs', async () => {
    const tempDir = makeTempDir()
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const qTablePath = writeQTable(tempDir, { [getLearningQTableKeyQ3(state, action)]: 5 })
    const before = readFileSync(qTablePath, 'utf8')
    const hashBefore = hashFileForTest(qTablePath)

    const result = await runLearningAgentQ3Evaluation({
      qTablePath,
      outputDir: path.join(tempDir, 'evaluation'),
      gamesPerColor: 1,
      maxTurns: 8,
      seed: 9,
    })

    expect(readFileSync(qTablePath, 'utf8')).toBe(before)
    expect(result.summary.qTableHashBefore).toBe(hashBefore)
    expect(result.summary.qTableHashAfter).toBe(hashBefore)
    expect(result.summary.qTableChangedDuringEvaluation).toBe(false)
    expect(existsSync(path.join(tempDir, 'evaluation', 'learning_comparison_summary.json'))).toBe(
      true,
    )
  })

  it('uses learning-empty-Q3 as a separate empty-table rival', async () => {
    const tempDir = makeTempDir()
    const qTablePath = writeQTable(tempDir, {})

    const result = await runLearningAgentQ3Evaluation({
      qTablePath,
      outputDir: path.join(tempDir, 'evaluation'),
      gamesPerColor: 1,
      maxTurns: 4,
      seed: 10,
    })

    expect(result.summary.learningEmptyDefinition.name).toBe('learning-empty-Q3')
    expect(result.summary.learningEmptyDefinition.representation).toBe('Q3')
    expect(result.summary.learningEmptyDefinition.sharesQ3Table).toBe(false)
    expect(
      result.summary.experiments.find((item) => item.rival === 'learning-empty-Q3')?.games,
    ).toBe(2)
  })

  it('keeps the required 100 red and 100 blue games per rival by default', () => {
    expect(Q3_EVALUATION_GAMES_PER_COLOR).toBe(100)
  })

  it('produces deterministic results with the same seeds', async () => {
    const tempDir = makeTempDir()
    const qTablePath = writeQTable(tempDir, {})

    const first = await runLearningAgentQ3Evaluation({
      qTablePath,
      outputDir: path.join(tempDir, 'evaluation-a'),
      gamesPerColor: 1,
      maxTurns: 4,
      seed: 12,
    })
    const second = await runLearningAgentQ3Evaluation({
      qTablePath,
      outputDir: path.join(tempDir, 'evaluation-b'),
      gamesPerColor: 1,
      maxTurns: 4,
      seed: 12,
    })

    expect(second.results).toEqual(first.results)
  })

  it('does not overwrite existing outputs', async () => {
    const tempDir = makeTempDir()
    const qTablePath = writeQTable(tempDir, {})
    const outputDir = path.join(tempDir, 'evaluation')
    await runLearningAgentQ3Evaluation({ qTablePath, outputDir, gamesPerColor: 1, maxTurns: 4 })

    await expect(
      runLearningAgentQ3Evaluation({ qTablePath, outputDir, gamesPerColor: 1, maxTurns: 4 }),
    ).rejects.toThrow('already exists')
  })

  it('does not reference Q2 key helpers or heuristic qtable loading', () => {
    const source = readFileSync(path.resolve('src/training/evaluateLearningAgentQ3.ts'), 'utf8')

    expect(source).not.toContain('getLearningQTableKey(')
    expect(source).not.toContain('getLearningStateKey(')
    expect(source).not.toContain('getLearningActionKey(')
    expect(source).not.toContain('qtable_from_heuristics')
  })

  it('points at qtable_q3_500.json by default', () => {
    expect(DEFAULT_Q3_500_QTABLE_PATH).toBe(
      'data/entrenamiento/q3/checkpoint_500/qtable_q3_500.json',
    )
  })
})
