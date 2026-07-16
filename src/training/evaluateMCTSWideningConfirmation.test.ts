import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Q5_POLICY_COMPARISON_QTABLE_PATH } from './evaluateQ5PolicyComparison'
import type { MCTSGameResult } from './evaluateMCTS'
import {
  MCTS_WIDENING_CONFIRMATION_CONFIG,
  buildMCTSWideningConfirmationSchedule,
  calculateWilson95Interval,
  evaluateMCTSWideningConfirmation,
} from './evaluateMCTSWideningConfirmation'

function makeTempDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `wall-go-mcts-widening-${label}-`))
}

function createClock(): () => number {
  let value = 0
  return () => value++
}

describe('evaluateMCTSWideningConfirmation', () => {
  let sharedResults: MCTSGameResult[]
  let sharedSummary: Awaited<ReturnType<typeof evaluateMCTSWideningConfirmation>>['summary']

  beforeAll(async () => {
    const evaluation = await evaluateMCTSWideningConfirmation({
      heuristicGames: 2,
      randomGames: 2,
      maxTurns: 2,
      outputDir: makeTempDir('shared'),
      progressEvery: 0,
      now: createClock(),
    })
    sharedResults = evaluation.results
    sharedSummary = evaluation.summary
  }, 20000)

  it('builds exactly 50 red and 50 blue games against heuristic', () => {
    const schedule = buildMCTSWideningConfirmationSchedule()
    const heuristic = schedule.filter((item) => item.rival === 'heuristic')

    expect(heuristic).toHaveLength(100)
    expect(heuristic.filter((item) => item.colorMCTS === 'R')).toHaveLength(50)
    expect(heuristic.filter((item) => item.colorMCTS === 'B')).toHaveLength(50)
  })

  it('builds exactly 25 red and 25 blue games against random', () => {
    const schedule = buildMCTSWideningConfirmationSchedule()
    const random = schedule.filter((item) => item.rival === 'random')

    expect(random).toHaveLength(50)
    expect(random.filter((item) => item.colorMCTS === 'R')).toHaveLength(25)
    expect(random.filter((item) => item.colorMCTS === 'B')).toHaveLength(25)
  })

  it('keeps the requested configuration fixed', () => {
    expect(MCTS_WIDENING_CONFIRMATION_CONFIG).toEqual({
      name: 'MCTS-50-mixed80-heuristic-widening',
      simulations: 50,
      explorationConstant: Math.SQRT2,
      maxDepth: 60,
      rolloutPolicy: 'mixed',
      heuristicProbability: 0.8,
      expansionPolicy: 'heuristic',
      progressiveWidening: true,
      wideningConstant: 2,
      wideningExponent: 0.5,
    })
    expect(Object.isFrozen(MCTS_WIDENING_CONFIRMATION_CONFIG)).toBe(true)
  })

  it('is deterministic with the same seed in a small run', async () => {
    const common = {
      heuristicGames: 2,
      randomGames: 2,
      maxTurns: 2,
      seedBase: 810_000,
      progressEvery: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const first = await evaluateMCTSWideningConfirmation({
      ...common,
      outputDir: makeTempDir('deterministic-a'),
      now: createClock(),
    })
    const second = await evaluateMCTSWideningConfirmation({
      ...common,
      outputDir: makeTempDir('deterministic-b'),
      now: createClock(),
    })

    expect(first.results).toEqual(second.results)
    expect(first.summary).toEqual(second.summary)
  }, 30000)

  it('calculates metrics separately for both colors', () => {
    expect(sharedSummary.byRival.heuristic.byColor.R.games).toBe(1)
    expect(sharedSummary.byRival.heuristic.byColor.B.games).toBe(1)
    expect(sharedSummary.byRival.random.byColor.R.games).toBe(1)
    expect(sharedSummary.byRival.random.byColor.B.games).toBe(1)
    expect(sharedSummary.byRival.heuristic.byColor.R).toHaveProperty('averageTerritoryDiff')
    expect(sharedSummary.byRival.heuristic.byColor.B).toHaveProperty('winRate')
  })

  it('reports coherent expansion metrics', () => {
    const metrics = sharedSummary.byRival.heuristic.aggregate

    expect(metrics.averageRootLegalActions).toBeGreaterThan(0)
    expect(metrics.averageRootExpandedChildren).toBeGreaterThan(0)
    expect(metrics.averageRootExpandedChildren).toBeLessThanOrEqual(metrics.averageRootLegalActions)
    expect(metrics.averageRootExplorationRatio).toBeGreaterThan(0)
    expect(metrics.averageRootExplorationRatio).toBeLessThanOrEqual(1)
    expect(metrics.averageMaxDepthReached).toBeGreaterThan(0)
    expect(metrics.averageSelectedDepth).toBeGreaterThanOrEqual(0)
  })

  it('calculates the Wilson 95 percent confidence interval', () => {
    expect(calculateWilson95Interval(80, 100)).toEqual({
      confidence: 0.95,
      lower: 71.1171,
      upper: 86.6633,
    })
    expect(calculateWilson95Interval(0, 0)).toEqual({ confidence: 0.95, lower: 0, upper: 0 })
  })

  it('does not overwrite previous evaluations, Q5, or checkpoints', async () => {
    const protectedPaths = [
      path.resolve('data/entrenamiento/mcts/evaluacion_baseline/mcts_baseline_summary.json'),
      path.resolve('data/entrenamiento/mcts/evaluacion_rollout_policy/mcts_rollout_summary.json'),
      path.resolve(
        'data/entrenamiento/mcts/evaluacion_mixed80_confirmacion/mcts_mixed80_confirmation_summary.json',
      ),
      path.resolve('data/entrenamiento/mcts/evaluacion_expansion/mcts_expansion_summary.json'),
      path.resolve(Q5_POLICY_COMPARISON_QTABLE_PATH),
    ]
    const before = protectedPaths.map((filePath) => readFileSync(filePath, 'utf8'))

    await evaluateMCTSWideningConfirmation({
      heuristicGames: 2,
      randomGames: 2,
      maxTurns: 1,
      outputDir: makeTempDir('protected'),
      progressEvery: 0,
      now: createClock(),
    })

    expect(protectedPaths.map((filePath) => readFileSync(filePath, 'utf8'))).toEqual(before)
  }, 15000)

  it('records only legal MCTS actions', () => {
    expect(sharedResults.every((game) => game.mctsActionsLegal)).toBe(true)
  })
})
