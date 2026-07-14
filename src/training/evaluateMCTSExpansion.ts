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

export const MCTS_EXPANSION_EVALUATION_VERSION = 'mcts-expansion-v1'
export const MCTS_EXPANSION_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_expansion',
)
export const MCTS_EXPANSION_SEED = 616_000

const MIXED_80 = {
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
  rolloutPolicy: 'mixed' as const,
  heuristicProbability: 0.8,
}

export const MCTS_EXPANSION_CONFIGS: NamedMCTSConfig[] = [
  {
    name: 'MCTS-50-mixed80-unordered',
    simulations: 50,
    ...MIXED_80,
    expansionPolicy: 'unordered',
    progressiveWidening: false,
  },
  {
    name: 'MCTS-50-mixed80-heuristic-order',
    simulations: 50,
    ...MIXED_80,
    expansionPolicy: 'heuristic',
    progressiveWidening: false,
  },
  {
    name: 'MCTS-50-mixed80-heuristic-widening',
    simulations: 50,
    ...MIXED_80,
    expansionPolicy: 'heuristic',
    progressiveWidening: true,
    wideningConstant: 2,
    wideningExponent: 0.5,
  },
  {
    name: 'MCTS-100-mixed80-heuristic-widening',
    simulations: 100,
    ...MIXED_80,
    expansionPolicy: 'heuristic',
    progressiveWidening: true,
    wideningConstant: 2,
    wideningExponent: 0.5,
  },
]

export interface EvaluateMCTSExpansionOptions
  extends Omit<
    EvaluateMCTSOptions,
    'configs' | 'rivals' | 'gamesPerCombination' | 'seedBase' | 'maxTurns'
  > {
  configs?: readonly NamedMCTSConfig[]
  gamesPerCombination?: number
  seedBase?: number
  maxTurns?: number
}

export async function evaluateMCTSExpansion(options: EvaluateMCTSExpansionOptions = {}) {
  return evaluateMCTS({
    ...options,
    configs: options.configs ?? MCTS_EXPANSION_CONFIGS,
    rivals: ['heuristic', 'random'],
    gamesPerCombination: options.gamesPerCombination ?? 10,
    seedBase: options.seedBase ?? MCTS_EXPANSION_SEED,
    maxTurns: options.maxTurns ?? MCTS_BASELINE_MAX_TURNS,
    outputDir: options.outputDir ?? MCTS_EXPANSION_OUTPUT_DIR,
    outputFilePrefix: 'mcts_expansion',
    evaluationVersion: MCTS_EXPANSION_EVALUATION_VERSION,
  })
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'pilot'
  if (command !== 'smoke' && command !== 'pilot') throw new Error(`Unknown command: ${command}`)
  const smoke = command === 'smoke'
  const outputDir = smoke
    ? mkdtempSync(path.join(os.tmpdir(), 'wall-go-mcts-expansion-smoke-'))
    : MCTS_EXPANSION_OUTPUT_DIR
  const result = await evaluateMCTSExpansion({
    gamesPerCombination: smoke ? 2 : 10,
    outputDir,
  })
  console.log(`[evaluateMCTSExpansion] mode: ${command}`)
  console.log(`[evaluateMCTSExpansion] games: ${result.results.length}`)
  console.log(`[evaluateMCTSExpansion] output: ${smoke ? 'system temp directory' : outputDir}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
