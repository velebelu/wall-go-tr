import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NamedMCTSConfig, MCTSGameResult, MCTSOpponent } from './evaluateMCTS'
import { evaluateMCTS, summarizeMCTSResults } from './evaluateMCTS'

export const MCTS_TACTICAL_VERIFICATION_VERSION = 'mcts-tactical-verification-v1'
export const MCTS_TACTICAL_VERIFICATION_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_verificacion_tactica',
)
export const MCTS_TACTICAL_VERIFICATION_SEED = 824_000
export const MCTS_TACTICAL_VERIFICATION_MAX_TURNS = 250

const FIXED_FINAL_CONFIG = {
  simulations: 50,
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
  rolloutPolicy: 'mixed' as const,
  heuristicProbability: 0.8,
  expansionPolicy: 'heuristic' as const,
  progressiveWidening: true,
  wideningConstant: 2,
  wideningExponent: 0.5,
  qPriorWeight: 0,
}

export const MCTS_TACTICAL_VERIFICATION_CONFIGS: readonly NamedMCTSConfig[] = [
  { name: 'baseline-final', ...FIXED_FINAL_CONFIG, tacticalVerification: false },
  { name: 'tactical-top-2', ...FIXED_FINAL_CONFIG, tacticalVerification: true, tacticalCandidateCount: 2 },
  { name: 'tactical-top-3', ...FIXED_FINAL_CONFIG, tacticalVerification: true, tacticalCandidateCount: 3 },
]

export const MCTS_TACTICAL_VERIFICATION_RIVALS: readonly MCTSOpponent[] = [
  'heuristic', 'q5-final', 'baseline-mcts',
]

function round(value: number): number {
  return Number(value.toFixed(4))
}

export function summarizeTacticalVerification(results: readonly MCTSGameResult[]) {
  return MCTS_TACTICAL_VERIFICATION_CONFIGS.flatMap((config) =>
    MCTS_TACTICAL_VERIFICATION_RIVALS.map((rival) => {
      const rows = results.filter((row) => row.config.name === config.name && row.rival === rival)
      const decisions = rows.reduce((sum, row) => sum + row.mctsDecisions, 0)
      const changes = rows.reduce((sum, row) => sum + (row.tacticalSelectionChanges ?? 0), 0)
      const changedGames = rows.filter((row) => (row.tacticalSelectionChanges ?? 0) > 0)
      const verificationMs = rows.reduce(
        (sum, row) => sum + (row.averageVerificationTimeMs ?? 0) * row.mctsDecisions,
        0,
      )
      return {
        config: config.name,
        rival,
        results: summarizeMCTSResults([...rows], config.simulations),
        byColor: Object.fromEntries((['R', 'B'] as const).map((color) => [
          color,
          summarizeMCTSResults(rows.filter((row) => row.colorMCTS === color), config.simulations),
        ])),
        tactical: {
          decisions,
          candidatesChecked: rows.reduce((sum, row) => sum + (row.tacticalCandidatesChecked ?? 0), 0),
          selectionChanges: changes,
          selectionChangeRate: decisions ? round((changes / decisions) * 100) : 0,
          averageVerificationTimeMs: decisions ? round(verificationMs / decisions) : 0,
          immediateTerminalLossesAvoided: rows.reduce(
            (sum, row) => sum + (row.immediateTerminalLossesAvoided ?? 0),
            0,
          ),
          gamesWithChanges: changedGames.length,
          winsWhenChanged: changedGames.filter((row) => row.mctsWon).length,
          tiesWhenChanged: changedGames.filter((row) => row.tie).length,
          lossesWhenChanged: changedGames.filter((row) => !row.mctsWon && !row.tie).length,
          averageTerritoryDiffWhenChanged: changedGames.length
            ? round(changedGames.reduce((sum, row) => sum + row.territoryDiff, 0) / changedGames.length)
            : 0,
        },
      }
    }),
  )
}

export async function evaluateMCTSTacticalVerification(options: {
  gamesPerCombination?: number
  outputDir?: string
  overwrite?: boolean
  maxTurns?: number
  now?: () => number
  createdAt?: string
  progressEvery?: number
  configs?: readonly NamedMCTSConfig[]
  rivals?: readonly MCTSOpponent[]
} = {}) {
  const outputDir = options.outputDir ?? MCTS_TACTICAL_VERIFICATION_OUTPUT_DIR
  const evaluation = await evaluateMCTS({
    configs: options.configs ?? MCTS_TACTICAL_VERIFICATION_CONFIGS,
    rivals: options.rivals ?? MCTS_TACTICAL_VERIFICATION_RIVALS,
    gamesPerCombination: options.gamesPerCombination ?? 10,
    seedBase: MCTS_TACTICAL_VERIFICATION_SEED,
    maxTurns: options.maxTurns ?? MCTS_TACTICAL_VERIFICATION_MAX_TURNS,
    outputDir,
    overwrite: options.overwrite,
    now: options.now,
    createdAt: options.createdAt,
    progressEvery: options.progressEvery,
    outputFilePrefix: 'mcts_tactical_verification',
    evaluationVersion: MCTS_TACTICAL_VERIFICATION_VERSION,
  })
  const tacticalAnalysis = summarizeTacticalVerification(evaluation.results)
  const summary = {
    ...evaluation.summary,
    experiment: {
      purpose: 'Post-search tactical verification only; tree and backpropagation unchanged',
      playableFinalConfigurationReplaced: false,
    },
    tacticalAnalysis,
  }
  writeFileSync(
    path.join(path.resolve(outputDir), 'mcts_tactical_verification_summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  )
  return { ...evaluation, summary, tacticalAnalysis }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'full'
  if (!['smoke', 'full'].includes(command)) throw new Error(`Unknown command: ${command}`)
  const started = performance.now()
  const result = await evaluateMCTSTacticalVerification(command === 'smoke'
    ? { gamesPerCombination: 2, maxTurns: 40, outputDir: `${MCTS_TACTICAL_VERIFICATION_OUTPUT_DIR}_smoke`, progressEvery: 1 }
    : { progressEvery: 5 })
  console.log(`[evaluateMCTSTacticalVerification] ${result.results.length} games in ${round(performance.now() - started)} ms`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
