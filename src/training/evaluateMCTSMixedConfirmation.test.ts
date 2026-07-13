import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Q5_POLICY_COMPARISON_QTABLE_PATH } from './evaluateQ5PolicyComparison'
import {
  buildMCTSMixedConfirmationSchedule,
  calculateWilson95Interval,
  evaluateMCTSMixedConfirmation,
} from './evaluateMCTSMixedConfirmation'

function makeTempDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `wall-go-mcts-confirmation-${label}-`))
}

function createClock(): () => number {
  let value = 0
  return () => value++
}

describe('evaluateMCTSMixedConfirmation', () => {
  it('builds exactly 50 red and 50 blue games against heuristic', () => {
    const schedule = buildMCTSMixedConfirmationSchedule()
    const heuristic = schedule.filter((item) => item.rival === 'heuristic')

    expect(heuristic).toHaveLength(100)
    expect(heuristic.filter((item) => item.colorMCTS === 'R')).toHaveLength(50)
    expect(heuristic.filter((item) => item.colorMCTS === 'B')).toHaveLength(50)
  })

  it('builds exactly 25 red and 25 blue games against random', () => {
    const schedule = buildMCTSMixedConfirmationSchedule()
    const random = schedule.filter((item) => item.rival === 'random')

    expect(random).toHaveLength(50)
    expect(random.filter((item) => item.colorMCTS === 'R')).toHaveLength(25)
    expect(random.filter((item) => item.colorMCTS === 'B')).toHaveLength(25)
  })

  it('is deterministic with the same seed in a small run', async () => {
    const common = {
      heuristicGames: 2,
      randomGames: 2,
      maxTurns: 2,
      seedBase: 700_000,
      progressEvery: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const first = await evaluateMCTSMixedConfirmation({
      ...common,
      outputDir: makeTempDir('deterministic-a'),
      now: createClock(),
    })
    const second = await evaluateMCTSMixedConfirmation({
      ...common,
      outputDir: makeTempDir('deterministic-b'),
      now: createClock(),
    })

    expect(first.results).toEqual(second.results)
    expect(first.summary).toEqual(second.summary)
  }, 40000)

  it('calculates metrics separately for red and blue', async () => {
    const result = await evaluateMCTSMixedConfirmation({
      heuristicGames: 2,
      randomGames: 2,
      maxTurns: 1,
      outputDir: makeTempDir('colors'),
      progressEvery: 0,
      now: createClock(),
    })

    expect(result.summary.byRival.heuristic.byColor.R.games).toBe(1)
    expect(result.summary.byRival.heuristic.byColor.B.games).toBe(1)
    expect(result.summary.byRival.random.byColor.R.games).toBe(1)
    expect(result.summary.byRival.random.byColor.B.games).toBe(1)
    expect(result.summary.byRival.heuristic.byColor.R).toHaveProperty('averageTerritoryDiff')
    expect(result.summary.byRival.heuristic.byColor.B).toHaveProperty('winRate')
  }, 15000)

  it('calculates the Wilson 95 percent confidence interval', () => {
    expect(calculateWilson95Interval(50, 100)).toEqual({
      confidence: 0.95,
      lower: 40.3832,
      upper: 59.6168,
    })
    expect(calculateWilson95Interval(0, 0)).toEqual({ confidence: 0.95, lower: 0, upper: 0 })
  })

  it('does not overwrite baseline, rollout policy, Q5, or checkpoints', async () => {
    const protectedPaths = [
      path.resolve('data/entrenamiento/mcts/evaluacion_baseline/mcts_baseline_summary.json'),
      path.resolve(
        'data/entrenamiento/mcts/evaluacion_rollout_policy/mcts_rollout_summary.json',
      ),
      path.resolve(Q5_POLICY_COMPARISON_QTABLE_PATH),
    ]
    const before = protectedPaths.map((filePath) => readFileSync(filePath, 'utf8'))

    await evaluateMCTSMixedConfirmation({
      heuristicGames: 2,
      randomGames: 2,
      maxTurns: 1,
      outputDir: makeTempDir('protected'),
      progressEvery: 0,
      now: createClock(),
    })

    expect(protectedPaths.map((filePath) => readFileSync(filePath, 'utf8'))).toEqual(before)
  }, 15000)

  it('records only legal actions from MCTS', async () => {
    const result = await evaluateMCTSMixedConfirmation({
      heuristicGames: 2,
      randomGames: 2,
      maxTurns: 3,
      outputDir: makeTempDir('legal'),
      progressEvery: 0,
      now: createClock(),
    })

    expect(result.results.every((game) => game.mctsActionsLegal)).toBe(true)
  }, 30000)
})
