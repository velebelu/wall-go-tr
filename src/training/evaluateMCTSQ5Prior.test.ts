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
import { Q5_MIN_CONFIDENCE } from '@/agents/q5Policy'
import {
  MCTS_Q5_PRIOR_CONFIGS,
  MCTS_Q5_PRIOR_EVALUATION_VERSION,
  evaluateMCTSQ5Prior,
} from './evaluateMCTSQ5Prior'

function makeTempDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `wall-go-mcts-q5-prior-${label}-`))
}

function createClock(): () => number {
  let value = 0
  return () => value++
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

describe('evaluateMCTSQ5Prior', () => {
  it('defines only the four requested prior weights with a fixed baseline', () => {
    expect(
      MCTS_Q5_PRIOR_CONFIGS.map((config) => ({
        expansionPolicy: config.expansionPolicy,
        qPriorWeight: config.qPriorWeight,
        simulations: config.simulations,
        rolloutPolicy: config.rolloutPolicy,
        heuristicProbability: config.heuristicProbability,
        progressiveWidening: config.progressiveWidening,
        wideningConstant: config.wideningConstant,
        wideningExponent: config.wideningExponent,
        maxDepth: config.maxDepth,
      })),
    ).toEqual([
      {
        expansionPolicy: 'heuristic',
        qPriorWeight: 0,
        simulations: 50,
        rolloutPolicy: 'mixed',
        heuristicProbability: 0.8,
        progressiveWidening: true,
        wideningConstant: 2,
        wideningExponent: 0.5,
        maxDepth: 60,
      },
      ...[0.25, 0.5, 1].map((qPriorWeight) => ({
        expansionPolicy: 'heuristic-q5',
        qPriorWeight,
        simulations: 50,
        rolloutPolicy: 'mixed',
        heuristicProbability: 0.8,
        progressiveWidening: true,
        wideningConstant: 2,
        wideningExponent: 0.5,
        maxDepth: 60,
      })),
    ])
  })

  it('runs deterministically with frozen verified Q5 resources and serializes prior metrics', async () => {
    const checkpointPath = path.resolve(Q5_CHECKPOINT_SOURCE)
    const checkpointBefore = readFileSync(checkpointPath, 'utf8')
    const config = { ...MCTS_Q5_PRIOR_CONFIGS[1], simulations: 1, maxDepth: 1 }
    const common = {
      configs: [config],
      gamesPerCombination: 2,
      maxTurns: 1,
      seedBase: 820_000,
      progressEvery: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const first = await evaluateMCTSQ5Prior({
      ...common,
      outputDir: makeTempDir('deterministic-a'),
      now: createClock(),
    })
    const secondDir = makeTempDir('deterministic-b')
    const second = await evaluateMCTSQ5Prior({
      ...common,
      outputDir: secondDir,
      now: createClock(),
    })

    expect(first.results).toEqual(second.results)
    expect(first.summary).toEqual(second.summary)
    expect(first.results).toHaveLength(6)
    expect(first.results.every((result) => result.mctsActionsLegal)).toBe(true)
    expect(first.summary.evaluationVersion).toBe(MCTS_Q5_PRIOR_EVALUATION_VERSION)
    expect(first.summary.protocol).toMatchObject({
      q5UsedAsFrozenOpponent: true,
      q5UsedAsExpansionPrior: true,
      q5UsedInRollouts: false,
      learningEnabled: false,
    })
    expect(first.summary.q5).toMatchObject({
      sha256: Q5_CHECKPOINT_SHA256,
      minConfidence: Q5_MIN_CONFIDENCE,
      qTableEntries: Q5_CHECKPOINT_ENTRIES,
      qTableChangedDuringEvaluation: false,
      resourcesChangedDuringEvaluation: false,
    })
    expect(hashFile(checkpointPath)).toBe(Q5_CHECKPOINT_SHA256)
    expect(readFileSync(checkpointPath, 'utf8')).toBe(checkpointBefore)
    expect(first.summary.combinations[0].aggregate).toMatchObject({
      averageQPriorKnownActions: expect.any(Number),
      averageQPriorReliableActions: expect.any(Number),
      qPriorSelectedActionKnownRate: expect.any(Number),
      qPriorSelectedActionReliableRate: expect.any(Number),
      averageSelectedQPrior: expect.any(Number),
    })
    const csv = readFileSync(path.join(secondDir, 'mcts_q5_prior_results.csv'), 'utf8')
    expect(csv).toContain(
      'averageQPriorKnownActions,averageQPriorReliableActions,qPriorSelectedActionKnownRate,qPriorSelectedActionReliableRate,averageSelectedQPrior',
    )
    expect(existsSync(path.join(secondDir, 'mcts_q5_prior_summary.json'))).toBe(true)
    expect(existsSync(path.join(secondDir, 'metadata.json'))).toBe(true)
    expect(existsSync(path.join(secondDir, 'mcts_expansion_summary.json'))).toBe(false)
    expect(existsSync(path.join(secondDir, 'mcts_widening_confirmation_summary.json'))).toBe(
      false,
    )
  }, 30000)
})
