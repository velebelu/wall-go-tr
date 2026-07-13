import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MCTS_ROLLOUT_CONFIGS,
  MCTS_ROLLOUT_EVALUATION_VERSION,
  evaluateMCTSRolloutPolicies,
} from './evaluateMCTSRolloutPolicy'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-mcts-rollout-'))
}

describe('evaluateMCTSRolloutPolicies', () => {
  it('defines the six requested simulation and rollout combinations', () => {
    expect(
      MCTS_ROLLOUT_CONFIGS.map((config) => ({
        name: config.name,
        simulations: config.simulations,
        rolloutPolicy: config.rolloutPolicy,
        heuristicProbability: config.heuristicProbability,
      })),
    ).toEqual([
      {
        name: 'MCTS-50-random',
        simulations: 50,
        rolloutPolicy: 'random',
        heuristicProbability: undefined,
      },
      {
        name: 'MCTS-50-mixed-80',
        simulations: 50,
        rolloutPolicy: 'mixed',
        heuristicProbability: 0.8,
      },
      {
        name: 'MCTS-50-heuristic',
        simulations: 50,
        rolloutPolicy: 'heuristic',
        heuristicProbability: undefined,
      },
      {
        name: 'MCTS-200-random',
        simulations: 200,
        rolloutPolicy: 'random',
        heuristicProbability: undefined,
      },
      {
        name: 'MCTS-200-mixed-80',
        simulations: 200,
        rolloutPolicy: 'mixed',
        heuristicProbability: 0.8,
      },
      {
        name: 'MCTS-200-heuristic',
        simulations: 200,
        rolloutPolicy: 'heuristic',
        heuristicProbability: undefined,
      },
    ])
  })

  it('writes a balanced comparison with rollout metadata without baseline files', async () => {
    const outputDir = makeTempDir()
    const result = await evaluateMCTSRolloutPolicies({
      configs: [
        {
          name: 'test-mixed',
          simulations: 1,
          explorationConstant: Math.SQRT2,
          maxDepth: 1,
          rolloutPolicy: 'mixed',
          heuristicProbability: 0.8,
        },
      ],
      gamesPerCombination: 2,
      maxTurns: 1,
      outputDir,
      progressEvery: 0,
      now: (() => {
        let value = 0
        return () => value++
      })(),
    })

    expect(result.results).toHaveLength(4)
    expect(result.results.filter((game) => game.colorMCTS === 'R')).toHaveLength(2)
    expect(result.results.filter((game) => game.colorMCTS === 'B')).toHaveLength(2)
    expect(result.summary.evaluationVersion).toBe(MCTS_ROLLOUT_EVALUATION_VERSION)
    expect(result.summary.protocol.configurations[0]).toMatchObject({
      rolloutPolicy: 'mixed',
      heuristicProbability: 0.8,
    })
    expect(existsSync(path.join(outputDir, 'mcts_rollout_summary.json'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'mcts_rollout_results.csv'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'metadata.json'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'mcts_baseline_summary.json'))).toBe(false)
    expect(readFileSync(path.join(outputDir, 'mcts_rollout_results.csv'), 'utf8')).toContain(
      'rolloutPolicy,heuristicProbability',
    )
  })
})
