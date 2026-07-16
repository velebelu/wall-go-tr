import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MCTS_BASELINE_MAX_TURNS,
  evaluateMCTS,
  type EvaluateMCTSOptions,
  type NamedMCTSConfig,
} from './evaluateMCTS'

export const MCTS_Q5_PRIOR_EVALUATION_VERSION = 'mcts-q5-prior-v1'
export const MCTS_Q5_PRIOR_OUTPUT_DIR = path.join('data/entrenamiento/mcts/evaluacion_q5_prior')
export const MCTS_Q5_PRIOR_SEED = 618_000

const FIXED_BASELINE = {
  simulations: 50,
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
  rolloutPolicy: 'mixed' as const,
  heuristicProbability: 0.8,
  progressiveWidening: true,
  wideningConstant: 2,
  wideningExponent: 0.5,
}

export const MCTS_Q5_PRIOR_CONFIGS: NamedMCTSConfig[] = [
  {
    name: 'MCTS-50-widening-baseline',
    ...FIXED_BASELINE,
    expansionPolicy: 'heuristic',
    qPriorWeight: 0,
  },
  {
    name: 'MCTS-50-widening-q5-weak',
    ...FIXED_BASELINE,
    expansionPolicy: 'heuristic-q5',
    qPriorWeight: 0.25,
  },
  {
    name: 'MCTS-50-widening-q5-medium',
    ...FIXED_BASELINE,
    expansionPolicy: 'heuristic-q5',
    qPriorWeight: 0.5,
  },
  {
    name: 'MCTS-50-widening-q5-strong',
    ...FIXED_BASELINE,
    expansionPolicy: 'heuristic-q5',
    qPriorWeight: 1,
  },
]

export interface EvaluateMCTSQ5PriorOptions extends Omit<
  EvaluateMCTSOptions,
  'configs' | 'rivals' | 'gamesPerCombination' | 'seedBase' | 'maxTurns'
> {
  configs?: readonly NamedMCTSConfig[]
  gamesPerCombination?: number
  seedBase?: number
  maxTurns?: number
}

export async function evaluateMCTSQ5Prior(options: EvaluateMCTSQ5PriorOptions = {}) {
  return evaluateMCTS({
    ...options,
    configs: options.configs ?? MCTS_Q5_PRIOR_CONFIGS,
    rivals: ['heuristic', 'random', 'q5-final'],
    gamesPerCombination: options.gamesPerCombination ?? 10,
    seedBase: options.seedBase ?? MCTS_Q5_PRIOR_SEED,
    maxTurns: options.maxTurns ?? MCTS_BASELINE_MAX_TURNS,
    outputDir: options.outputDir ?? MCTS_Q5_PRIOR_OUTPUT_DIR,
    outputFilePrefix: 'mcts_q5_prior',
    evaluationVersion: MCTS_Q5_PRIOR_EVALUATION_VERSION,
  })
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'pilot'
  if (command !== 'smoke' && command !== 'pilot') throw new Error(`Unknown command: ${command}`)
  const smoke = command === 'smoke'
  const outputDir = smoke
    ? mkdtempSync(path.join(os.tmpdir(), 'wall-go-mcts-q5-prior-smoke-'))
    : MCTS_Q5_PRIOR_OUTPUT_DIR
  const result = await evaluateMCTSQ5Prior({
    gamesPerCombination: smoke ? 2 : 10,
    outputDir,
  })
  console.log(`[evaluateMCTSQ5Prior] mode: ${command}`)
  console.log(`[evaluateMCTSQ5Prior] games: ${result.results.length}`)
  console.log(`[evaluateMCTSQ5Prior] output: ${smoke ? 'system temp directory' : outputDir}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
