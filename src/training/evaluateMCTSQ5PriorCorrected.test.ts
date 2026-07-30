import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Q5_CHECKPOINT_ENTRIES,
  Q5_CHECKPOINT_SHA256,
  Q5_CHECKPOINT_SOURCE,
} from '@/agents/Q5LearningAgent'
import {
  EXPECTED_Q5_CONFIDENCE_STATS,
  assertQ5ConfidenceStats,
  loadFrozenQ5EvaluationResources,
} from './evaluateMCTS'
import { MCTS_Q5_PRIOR_CONFIGS } from './evaluateMCTSQ5Prior'
import {
  MCTS_Q5_PRIOR_CORRECTED_VERSION,
  evaluateMCTSQ5PriorCorrected,
} from './evaluateMCTSQ5PriorCorrected'

function tempDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `wall-go-q5-prior-corrected-${label}-`))
}

function clock(): () => number {
  let value = 0
  return () => value++
}

describe('evaluateMCTSQ5PriorCorrected', () => {
  it('carga exactamente los mapas aprobados y conserva Q5', () => {
    const checkpoint = path.resolve(Q5_CHECKPOINT_SOURCE)
    const before = readFileSync(checkpoint)
    const resources = loadFrozenQ5EvaluationResources()
    expect(resources.confidenceStats).toEqual(EXPECTED_Q5_CONFIDENCE_STATS)
    expect(resources.model.confidence.size).toBe(27_815)
    expect(Math.max(...Array.from(resources.model.confidence.values()))).toBe(778)
    expect(
      Array.from(resources.model.confidence.values()).filter((value) => value >= 10),
    ).toHaveLength(404)
    expect(Object.keys(resources.model.qTable)).toHaveLength(Q5_CHECKPOINT_ENTRIES)
    expect(createHash('sha256').update(readFileSync(checkpoint)).digest('hex')).toBe(
      Q5_CHECKPOINT_SHA256,
    )
    expect(readFileSync(checkpoint).equals(before)).toBe(true)
  })

  it('aborta claramente si los mapas quedan vacios', () => {
    expect(() =>
      assertQ5ConfidenceStats({
        confidenceMapEntries: 0,
        qLearningUpdateCountsEntries: 0,
        effectiveConfidenceEntries: 0,
        maxEffectiveConfidence: 0,
        effectiveEntriesAtLeast10: 0,
      }),
    ).toThrow(/confidenceMapEntries expected 19652, received 0.*games were not started/i)
  })

  it('es determinista y escribe solo los nombres corregidos', async () => {
    const config = { ...MCTS_Q5_PRIOR_CONFIGS[1], simulations: 1, maxDepth: 1 }
    const common = {
      configs: [config],
      gamesPerCombination: 2,
      maxTurns: 1,
      seedBase: 618_000,
      progressEvery: 0,
      createdAt: '2026-07-14T00:00:00.000Z',
    }
    const first = await evaluateMCTSQ5PriorCorrected({
      ...common,
      outputDir: tempDir('a'),
      now: clock(),
    })
    const secondDir = tempDir('b')
    const second = await evaluateMCTSQ5PriorCorrected({
      ...common,
      outputDir: secondDir,
      now: clock(),
    })
    expect(first.results).toEqual(second.results)
    expect(first.summary).toEqual(second.summary)
    expect(first.summary.evaluationVersion).toBe(MCTS_Q5_PRIOR_CORRECTED_VERSION)
    expect(first.summary.correction).toMatchObject({
      previousEvaluationInvalidated: true,
      correctedRepetition: true,
      parametersIdenticalToInvalidatedEvaluation: true,
    })
    expect(first.summary.q5?.confidenceStats).toEqual(EXPECTED_Q5_CONFIDENCE_STATS)
    expect(existsSync(path.join(secondDir, 'mcts_q5_prior_corrected_summary.json'))).toBe(true)
    expect(existsSync(path.join(secondDir, 'mcts_q5_prior_corrected_results.csv'))).toBe(true)
    expect(existsSync(path.join(secondDir, 'metadata.json'))).toBe(true)
    expect(existsSync(path.join(secondDir, 'mcts_q5_prior_summary.json'))).toBe(false)
  }, 30_000)
})
