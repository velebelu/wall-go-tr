import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MCTS_EXPANSION_CONFIGS,
  MCTS_EXPANSION_EVALUATION_VERSION,
  evaluateMCTSExpansion,
} from './evaluateMCTSExpansion'

function makeTempDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `wall-go-mcts-expansion-${label}-`))
}

function createClock(): () => number {
  let value = 0
  return () => value++
}

describe('evaluateMCTSExpansion', () => {
  it('defines the four requested expansion configurations', () => {
    expect(MCTS_EXPANSION_CONFIGS).toMatchObject([
      {
        simulations: 50,
        expansionPolicy: 'unordered',
        progressiveWidening: false,
      },
      {
        simulations: 50,
        expansionPolicy: 'heuristic',
        progressiveWidening: false,
      },
      {
        simulations: 50,
        expansionPolicy: 'heuristic',
        progressiveWidening: true,
        wideningConstant: 2,
        wideningExponent: 0.5,
      },
      {
        simulations: 100,
        expansionPolicy: 'heuristic',
        progressiveWidening: true,
        wideningConstant: 2,
        wideningExponent: 0.5,
      },
    ])
    expect(MCTS_EXPANSION_CONFIGS.every((config) => config.rolloutPolicy === 'mixed')).toBe(true)
    expect(MCTS_EXPANSION_CONFIGS.every((config) => config.heuristicProbability === 0.8)).toBe(true)
  })

  it('runs a balanced deterministic pilot and serializes expansion metrics', async () => {
    const config = { ...MCTS_EXPANSION_CONFIGS[2], simulations: 2, maxDepth: 2 }
    const common = {
      configs: [config],
      gamesPerCombination: 2,
      maxTurns: 2,
      seedBase: 800_000,
      progressEvery: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const first = await evaluateMCTSExpansion({
      ...common,
      outputDir: makeTempDir('deterministic-a'),
      now: createClock(),
    })
    const secondDir = makeTempDir('deterministic-b')
    const second = await evaluateMCTSExpansion({
      ...common,
      outputDir: secondDir,
      now: createClock(),
    })

    expect(first.results).toEqual(second.results)
    expect(first.summary).toEqual(second.summary)
    expect(first.results).toHaveLength(4)
    expect(first.results.filter((result) => result.colorMCTS === 'R')).toHaveLength(2)
    expect(first.results.filter((result) => result.colorMCTS === 'B')).toHaveLength(2)
    expect(first.results.every((result) => result.mctsActionsLegal)).toBe(true)
    expect(first.summary.evaluationVersion).toBe(MCTS_EXPANSION_EVALUATION_VERSION)
    expect(first.summary.combinations[0].aggregate).toMatchObject({
      averageRootLegalActions: expect.any(Number),
      averageRootExpandedChildren: expect.any(Number),
      averageMaxDepthReached: expect.any(Number),
      averageSelectedDepth: expect.any(Number),
      averageRootExplorationRatio: expect.any(Number),
    })
    const csv = readFileSync(path.join(secondDir, 'mcts_expansion_results.csv'), 'utf8')
    expect(csv).toContain(
      'averageRootExpandedChildren,averageMaxDepthReached,averageSelectedDepth,averageRootExplorationRatio',
    )
    expect(existsSync(path.join(secondDir, 'mcts_expansion_summary.json'))).toBe(true)
    expect(existsSync(path.join(secondDir, 'metadata.json'))).toBe(true)
    expect(existsSync(path.join(secondDir, 'mcts_baseline_summary.json'))).toBe(false)
    expect(existsSync(path.join(secondDir, 'mcts_rollout_summary.json'))).toBe(false)
  })
})
