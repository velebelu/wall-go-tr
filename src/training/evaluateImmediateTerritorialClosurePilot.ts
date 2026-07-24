import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import type { MCTSConfig } from '@/engine/mcts/types'
import { evaluateMCTS, type MCTSGameResult, type NamedMCTSConfig } from './evaluateMCTS'

export const CLOSURE_PILOT_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_amenaza_cierre_inmediato_v1_pilot',
)
export const CLOSURE_PILOT_SEED = 1_247_000
export const CLOSURE_THREAT_CONFIG = Object.freeze({
  enabled: true,
  weight: 10,
  minimumTerritoryDrop: 5,
  minimumAccessibleDrop: 5,
})

export const CLOSURE_BASELINE_CONFIG: NamedMCTSConfig = {
  name: 'baseline-final',
  ...FINAL_MCTS_CONFIG,
}
export const CLOSURE_EXPERIMENTAL_CONFIG: NamedMCTSConfig = {
  name: 'closure-threat-v1',
  ...FINAL_MCTS_CONFIG,
  immediateTerritorialClosureThreat: CLOSURE_THREAT_CONFIG,
}

function opponentConfig(subject: NamedMCTSConfig): MCTSConfig {
  return subject.name === CLOSURE_BASELINE_CONFIG.name
    ? CLOSURE_EXPERIMENTAL_CONFIG
    : CLOSURE_BASELINE_CONFIG
}

function stableActionChanges(results: readonly MCTSGameResult[]) {
  const rows = new Map<string, MCTSGameResult>()
  for (const result of results) {
    rows.set(`${result.config.name}|${result.rival}|${result.colorMCTS}|${result.game}`, result)
  }
  let comparableDecisions = 0
  let changedDecisions = 0
  for (const baseline of results.filter(
    (result) => result.config.name === CLOSURE_BASELINE_CONFIG.name,
  )) {
    const experimental = rows.get(
      `${CLOSURE_EXPERIMENTAL_CONFIG.name}|${baseline.rival}|${baseline.colorMCTS}|${baseline.game}`,
    )
    if (!experimental) continue
    const count = Math.min(
      baseline.mctsActionSignatures?.length ?? 0,
      experimental.mctsActionSignatures?.length ?? 0,
    )
    comparableDecisions += count
    for (let index = 0; index < count; index++) {
      if (baseline.mctsActionSignatures![index] !== experimental.mctsActionSignatures![index]) {
        changedDecisions++
      }
    }
  }
  return {
    comparableDecisions,
    changedDecisions,
    changeRate: comparableDecisions ? changedDecisions / comparableDecisions : 0,
  }
}

function experimentalDiagnostics(results: readonly MCTSGameResult[]) {
  const experimental = results.filter(
    (result) => result.config.name === CLOSURE_EXPERIMENTAL_CONFIG.name,
  )
  const decisions = experimental.reduce((sum, result) => sum + result.mctsDecisions, 0)
  return {
    decisions,
    threatsDetected: experimental.reduce(
      (sum, result) => sum + (result.closureThreatsDetected ?? 0),
      0,
    ),
    averagePenaltyPerDecision: decisions
      ? experimental.reduce(
          (sum, result) => sum + (result.averageClosureThreatPenalty ?? 0) * result.mctsDecisions,
          0,
        ) / decisions
      : 0,
  }
}

export async function evaluateImmediateTerritorialClosurePilot(options?: {
  outputDir?: string
  gamesPerCombination?: number
  maxTurns?: number
  overwrite?: boolean
}) {
  const outputDir = path.resolve(options?.outputDir ?? CLOSURE_PILOT_OUTPUT_DIR)
  const gamesPerCombination = options?.gamesPerCombination ?? 2
  const common = {
    configs: [CLOSURE_BASELINE_CONFIG, CLOSURE_EXPERIMENTAL_CONFIG],
    gamesPerCombination,
    maxTurns: options?.maxTurns ?? 80,
    overwrite: options?.overwrite ?? false,
    progressEvery: 1,
    evaluationVersion: 'immediate-territorial-closure-threat-v1-pilot',
  } as const
  mkdirSync(outputDir, { recursive: true })

  const direct = await evaluateMCTS({
    ...common,
    rivals: ['baseline-mcts'],
    seedBase: CLOSURE_PILOT_SEED,
    outputDir: path.join(outputDir, 'directo'),
    outputFilePrefix: 'closure_threat_direct',
    mctsOpponentConfig: (pairing) => opponentConfig(pairing.config),
  })
  const controls = await evaluateMCTS({
    ...common,
    rivals: ['heuristic', 'baseline-mcts'],
    seedBase: CLOSURE_PILOT_SEED + 10_000,
    outputDir: path.join(outputDir, 'controles'),
    outputFilePrefix: 'closure_threat_controls',
    mctsOpponentConfig: FINAL_MCTS_CONFIG,
  })
  const all = [...direct.results, ...controls.results]
  const summary = {
    createdAt: new Date().toISOString(),
    experiment: 'immediate-territorial-closure-threat-v1',
    provisional: true,
    games: all.length,
    configuration: CLOSURE_THREAT_CONFIG,
    direct: direct.summary,
    controls: controls.summary,
    diagnostics: experimentalDiagnostics(all),
    pairedDecisionChanges: {
      direct: stableActionChanges(direct.results),
      controls: stableActionChanges(controls.results),
    },
    historicalFixtures: {
      decisions: [36, 40, 42],
      status: 'not_reconstructible',
      missing:
        'Full board snapshots or a complete action sequence from initial placement; legacy CSV traces are not present and their schema does not store boards.',
    },
  }
  writeFileSync(
    path.join(outputDir, 'closure_threat_pilot_summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  )
  return { summary, results: all, outputDir }
}

if (process.argv[1]?.endsWith('evaluateImmediateTerritorialClosurePilot.ts')) {
  const result = await evaluateImmediateTerritorialClosurePilot()
  console.log(`[closure-threat-pilot] games: ${result.results.length}`)
  console.log(`[closure-threat-pilot] output: ${result.outputDir}`)
}
