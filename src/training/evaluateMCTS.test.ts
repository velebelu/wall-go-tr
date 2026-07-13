import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Player } from '@/lib/types'
import { Q5_POLICY_COMPARISON_QTABLE_PATH } from './evaluateQ5PolicyComparison'
import {
  buildMCTSEvaluationSchedule,
  evaluateMCTS,
  summarizeMCTSResults,
  type MCTSGameResult,
  type NamedMCTSConfig,
} from './evaluateMCTS'

const TEST_CONFIG: NamedMCTSConfig = {
  name: 'MCTS-test',
  simulations: 1,
  explorationConstant: Math.SQRT2,
  maxDepth: 1,
  rolloutPolicy: 'random',
}

function makeTempDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `wall-go-mcts-${label}-`))
}

function createClock(): () => number {
  let current = 0
  return () => current++
}

function syntheticResult(params: {
  colorMCTS: Player
  winner: Player | 'tie'
  territoryMCTS: number
  territoryRival: number
  turns: number
  durationMs: number
}): MCTSGameResult {
  return {
    config: TEST_CONFIG,
    rival: 'random',
    colorMCTS: params.colorMCTS,
    game: 1,
    seed: 1,
    winner: params.winner,
    mctsWon: params.winner === params.colorMCTS,
    tie: params.winner === 'tie',
    territoryMCTS: params.territoryMCTS,
    territoryRival: params.territoryRival,
    territoryDiff: params.territoryMCTS - params.territoryRival,
    turns: params.turns,
    durationMs: params.durationMs,
    mctsDecisionTimeMs: 4,
    mctsDecisions: 2,
    averageDecisionMs: 2,
    averageRootLegalActions: 10,
    mctsActionsLegal: true,
  }
}

describe('evaluateMCTS', () => {
  it('builds a color-balanced schedule for every configuration and rival', () => {
    const configs = [TEST_CONFIG, { ...TEST_CONFIG, name: 'MCTS-test-2', simulations: 2 }]
    const schedule = buildMCTSEvaluationSchedule(configs, ['random', 'heuristic'], 4, 1000)

    expect(schedule).toHaveLength(16)
    for (const config of configs) {
      for (const rival of ['random', 'heuristic'] as const) {
        const group = schedule.filter(
          (item) => item.config.name === config.name && item.rival === rival,
        )
        expect(group.filter((item) => item.colorMCTS === 'R')).toHaveLength(2)
        expect(group.filter((item) => item.colorMCTS === 'B')).toHaveLength(2)
      }
    }
  })

  it('produces deterministic gameplay results with the same seed', async () => {
    const common = {
      configs: [TEST_CONFIG],
      rivals: ['random'] as const,
      gamesPerCombination: 2,
      seedBase: 2000,
      maxTurns: 2,
      progressEvery: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const first = await evaluateMCTS({
      ...common,
      outputDir: makeTempDir('deterministic-a'),
      now: createClock(),
    })
    const second = await evaluateMCTS({
      ...common,
      outputDir: makeTempDir('deterministic-b'),
      now: createClock(),
    })

    expect(first.results).toEqual(second.results)
    expect(first.summary).toEqual(second.summary)
  })

  it('runs the exact requested number of games', async () => {
    const result = await evaluateMCTS({
      configs: [TEST_CONFIG],
      rivals: ['random', 'heuristic'],
      gamesPerCombination: 2,
      maxTurns: 1,
      outputDir: makeTempDir('count'),
      progressEvery: 0,
      now: createClock(),
    })

    expect(result.results).toHaveLength(4)
    expect(result.summary.protocol.totalGames).toBe(4)
  })

  it('calculates wins, losses, ties, win rate and averages correctly', () => {
    const results = [
      syntheticResult({
        colorMCTS: 'R',
        winner: 'R',
        territoryMCTS: 30,
        territoryRival: 19,
        turns: 10,
        durationMs: 20,
      }),
      syntheticResult({
        colorMCTS: 'B',
        winner: 'R',
        territoryMCTS: 20,
        territoryRival: 29,
        turns: 14,
        durationMs: 30,
      }),
      syntheticResult({
        colorMCTS: 'R',
        winner: 'tie',
        territoryMCTS: 24,
        territoryRival: 24,
        turns: 12,
        durationMs: 25,
      }),
    ]

    expect(summarizeMCTSResults(results, 50)).toEqual({
      games: 3,
      wins: 1,
      losses: 1,
      ties: 1,
      winRate: 33.3333,
      averageTerritoryMCTS: 24.6667,
      averageTerritoryRival: 24,
      averageTerritoryDiff: 0.6667,
      averageTurns: 12,
      totalTimeMs: 75,
      averageGameTimeMs: 25,
      averageDecisionMs: 2,
      averageRootLegalActions: 10,
      simulations: 50,
    })
  })

  it('keeps the approved Q5 checkpoint and in-memory table unchanged', async () => {
    const checkpointPath = path.resolve(Q5_POLICY_COMPARISON_QTABLE_PATH)
    const before = readFileSync(checkpointPath, 'utf8')
    const result = await evaluateMCTS({
      configs: [TEST_CONFIG],
      rivals: ['q5-final'],
      gamesPerCombination: 2,
      maxTurns: 1,
      outputDir: makeTempDir('q5-frozen'),
      progressEvery: 0,
      now: createClock(),
    })

    expect(readFileSync(checkpointPath, 'utf8')).toBe(before)
    expect(result.summary.q5).toMatchObject({
      epsilon: 0,
      minConfidence: 10,
      qMargin: 0.5,
      qTableChangedDuringEvaluation: false,
      resourcesChangedDuringEvaluation: false,
    })
  }, 30000)

  it('records that every MCTS decision was a legal root action', async () => {
    const result = await evaluateMCTS({
      configs: [TEST_CONFIG],
      rivals: ['random'],
      gamesPerCombination: 2,
      maxTurns: 3,
      outputDir: makeTempDir('legal'),
      progressEvery: 0,
      now: createClock(),
    })

    expect(result.results.every((game) => game.mctsActionsLegal)).toBe(true)
  })

  it('serializes every required aggregate metric', async () => {
    const outputDir = makeTempDir('serialization')
    await evaluateMCTS({
      configs: [TEST_CONFIG],
      rivals: ['random'],
      gamesPerCombination: 2,
      maxTurns: 1,
      outputDir,
      progressEvery: 0,
      now: createClock(),
    })
    const summary = JSON.parse(
      readFileSync(path.join(outputDir, 'mcts_baseline_summary.json'), 'utf8'),
    ) as { combinations: Array<{ aggregate: Record<string, unknown> }> }
    const metrics = summary.combinations[0]!.aggregate

    expect(metrics).toEqual(
      expect.objectContaining({
        games: 2,
        wins: expect.any(Number),
        losses: expect.any(Number),
        ties: expect.any(Number),
        winRate: expect.any(Number),
        averageTerritoryMCTS: expect.any(Number),
        averageTerritoryRival: expect.any(Number),
        averageTerritoryDiff: expect.any(Number),
        averageTurns: expect.any(Number),
        totalTimeMs: expect.any(Number),
        averageGameTimeMs: expect.any(Number),
        averageDecisionMs: expect.any(Number),
        averageRootLegalActions: expect.any(Number),
        simulations: 1,
      }),
    )
    expect(existsSync(path.join(outputDir, 'mcts_baseline_results.csv'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'metadata.json'))).toBe(true)
  })

  it('runs a small pilot outside the data tree without modifying existing checkpoints', async () => {
    const checkpointPath = path.resolve(Q5_POLICY_COMPARISON_QTABLE_PATH)
    const before = readFileSync(checkpointPath, 'utf8')
    const outputDir = makeTempDir('pilot')

    const result = await evaluateMCTS({
      configs: [TEST_CONFIG],
      rivals: ['random', 'heuristic'],
      gamesPerCombination: 2,
      maxTurns: 2,
      outputDir,
      progressEvery: 0,
      now: createClock(),
    })

    expect(result.results).toHaveLength(4)
    expect(readFileSync(checkpointPath, 'utf8')).toBe(before)
    expect(path.resolve(outputDir).startsWith(path.resolve('data'))).toBe(false)
  })
})
