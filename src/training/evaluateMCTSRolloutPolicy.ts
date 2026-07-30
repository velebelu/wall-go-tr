import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  MCTS_BASELINE_MAX_TURNS,
  evaluateMCTS,
  type EvaluateMCTSOptions,
  type NamedMCTSConfig,
} from './evaluateMCTS'

export const MCTS_ROLLOUT_EVALUATION_VERSION = 'mcts-rollout-policy-v1'
export const MCTS_ROLLOUT_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_rollout_policy',
)
export const MCTS_ROLLOUT_SEED = 614_000

function rolloutConfig(
  simulations: 50 | 200,
  rolloutPolicy: NamedMCTSConfig['rolloutPolicy'],
  heuristicProbability?: number,
): NamedMCTSConfig {
  const suffix =
    rolloutPolicy === 'mixed'
      ? `mixed-${Math.round((heuristicProbability ?? 0.8) * 100)}`
      : rolloutPolicy
  return {
    name: `MCTS-${simulations}-${suffix}`,
    simulations,
    explorationConstant: Math.SQRT2,
    maxDepth: 60,
    rolloutPolicy,
    heuristicProbability,
  }
}

export const MCTS_ROLLOUT_CONFIGS: NamedMCTSConfig[] = [
  rolloutConfig(50, 'random'),
  rolloutConfig(50, 'mixed', 0.8),
  rolloutConfig(50, 'heuristic'),
  rolloutConfig(200, 'random'),
  rolloutConfig(200, 'mixed', 0.8),
  rolloutConfig(200, 'heuristic'),
]

export interface EvaluateMCTSRolloutPolicyOptions
  extends Omit<
    EvaluateMCTSOptions,
    'configs' | 'rivals' | 'gamesPerCombination' | 'seedBase' | 'maxTurns'
  > {
  configs?: readonly NamedMCTSConfig[]
  gamesPerCombination?: number
  seedBase?: number
  maxTurns?: number
}

export async function evaluateMCTSRolloutPolicies(options: EvaluateMCTSRolloutPolicyOptions = {}) {
  return evaluateMCTS({
    ...options,
    configs: options.configs ?? MCTS_ROLLOUT_CONFIGS,
    rivals: ['random', 'heuristic'],
    gamesPerCombination: options.gamesPerCombination ?? 6,
    seedBase: options.seedBase ?? MCTS_ROLLOUT_SEED,
    maxTurns: options.maxTurns ?? MCTS_BASELINE_MAX_TURNS,
    outputDir: options.outputDir ?? MCTS_ROLLOUT_OUTPUT_DIR,
    outputFilePrefix: 'mcts_rollout',
    evaluationVersion: MCTS_ROLLOUT_EVALUATION_VERSION,
  })
}

async function main(): Promise<void> {
  const result = await evaluateMCTSRolloutPolicies()
  console.log(`[evaluateMCTSRolloutPolicies] games: ${result.results.length}`)
  console.log(`[evaluateMCTSRolloutPolicies] output: ${MCTS_ROLLOUT_OUTPUT_DIR}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
