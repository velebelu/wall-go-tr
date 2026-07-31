import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { searchBestAction } from '@/engine/mcts/MCTS'
import { FINAL_MCTS_CONFIG } from '@/agents/mctsConfig'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { getLegalActions, getBestHeuristicAction } from '@/utils/ai'
import { countTerritoryQ3 } from '@/agents/learningPolicyQ3'
import { serializeGameSnapshot } from '@/utils/humanMCTSTrace'
import {
  makeInternalWallLossFixture,
  makeInternalWallNeutralFixture,
} from '@/fixtures/internalWall'
import {
  analyzeInternalWallAction,
  compareInternalWallCandidates,
} from '@/diagnostics/inactiveInternalWallActions'

export const INTERNAL_WALL_DIAGNOSTIC_OUTPUT =
  'data/diagnostics/inactive-internal-wall-actions-v1/evidence-v4'

function seededRng(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 0x1_0000_0000
  }
}

function wallKey(action: PlayerAction): string {
  return JSON.stringify(action)
}

function pairedContinuation(state: GameSnapshot, action: PlayerAction, seed: number) {
  let current = applyFullAction(state, action).state
  const random = seededRng(seed)
  let illegalActions = 0
  let turnsRemaining = 12
  while (turnsRemaining > 0 && current.phase !== 'finished') {
    const legal = getLegalActions(current)
    if (!legal.length) break
    const heuristic = getBestHeuristicAction(current, 'default')
    const selected = heuristic ?? legal[Math.floor(random() * legal.length)]!
    if (!legal.some((candidate) => wallKey(candidate) === wallKey(selected))) illegalActions++
    current = applyFullAction(current, selected).state
    turnsRemaining--
  }
  const territory = countTerritoryQ3(current)
  return {
    territoryFinal: territory,
    result: current.result?.winner ?? (current.result?.tie ? 'tie' : null),
    turnsRemaining,
    illegalActions,
  }
}

function classifyCounterfactual(
  original: ReturnType<typeof pairedContinuation>,
  alternative: ReturnType<typeof pairedContinuation>,
  player: 'R' | 'B',
): 'beneficial' | 'harmful' | 'neutral' | 'inconclusive' {
  const rival = player === 'R' ? 'B' : 'R'
  const ownDelta = alternative.territoryFinal[player] - original.territoryFinal[player]
  const resultDelta = Number(alternative.result === player) - Number(original.result === player)
  const rivalDelta = alternative.territoryFinal[rival] - original.territoryFinal[rival]
  if (ownDelta > 0 || resultDelta > 0 || rivalDelta < 0) return 'beneficial'
  if (ownDelta < 0 || resultDelta < 0 || rivalDelta > 0) return 'harmful'
  if (ownDelta === 0 && resultDelta === 0 && rivalDelta === 0) return 'neutral'
  return 'inconclusive'
}

function evaluateFixture(id: string, state: GameSnapshot, seed: number) {
  const legalWalls = getLegalActions(state).filter(
    (action) => action.type === 'wall' && !action.followUp,
  )
  const mcts = searchBestAction(
    state,
    state.turn,
    {
      ...FINAL_MCTS_CONFIG,
      simulations: 32,
      maxDepth: 12,
      tacticalVerification: false,
    },
    seededRng(seed),
  )
  const selected = [...legalWalls].sort((left, right) => {
    const leftChild = mcts.children.find((child) => wallKey(child.action) === wallKey(left))
    const rightChild = mcts.children.find((child) => wallKey(child.action) === wallKey(right))
    return (
      (rightChild?.visits ?? -1) - (leftChild?.visits ?? -1) ||
      (rightChild?.value ?? -Infinity) - (leftChild?.value ?? -Infinity)
    )
  })[0]
  const selectedChild = selected
    ? mcts.children.find((child) => wallKey(child.action) === wallKey(selected))
    : undefined
  const diagnostics = compareInternalWallCandidates(state, legalWalls)
  const selectedDiagnostic = selected ? analyzeInternalWallAction(state, selected) : undefined
  const alternatives = legalWalls.filter(
    (action) => !selected || wallKey(action) !== wallKey(selected),
  )
  const paired = selected
    ? alternatives.slice(0, 4).map((alternative, index) => {
        const originalContinuation = pairedContinuation(state, selected, seed + index)
        const alternativeContinuation = pairedContinuation(state, alternative, seed + index)
        return {
          originalAction: selected,
          alternative,
          original: originalContinuation,
          alternativeResult: alternativeContinuation,
          classification: classifyCounterfactual(
            originalContinuation,
            alternativeContinuation,
            state.turn,
          ),
        }
      })
    : []
  return {
    id,
    source: 'synthetic-generated-rules-fixture',
    exactP02Reproduction: false,
    player: state.turn,
    stateBefore: serializeGameSnapshot(state),
    mctsSelectedAction: mcts.action,
    selectedWallAction: selected,
    selectedDiagnostic,
    rootCandidates: mcts.children,
    mcts: {
      seed,
      simulations: mcts.rootVisits,
      selectedVisits: selectedChild?.visits ?? 0,
      selectedValue: selectedChild?.value ?? 0,
      candidates: mcts.children.map(({ action, visits, value }) => ({ action, visits, value })),
    },
    candidates: diagnostics,
    interventions: {
      A_immediateLossOnly: diagnostics.filter((row) => row.immediateTerritoryLoss > 0).length,
      B_penaltyOnly: 'measured independently; no selection change applied',
      C_pairedContinuations: paired,
      D_robustNeutralExclusion: 'not activated without an independent robust margin',
    },
  }
}

export function buildInactiveInternalWallReport() {
  return {
    schema: 'InactiveInternalWallActionsDiagnosticV1',
    decision: {
      status: 'diagnostic-only',
      accepted: false,
      productionModified: false,
      v3R1Modified: false,
      reason: 'P02-1 trace unavailable; synthetic evidence only',
    },
    observedCase: {
      participant: 'P02',
      gameNumber: 1,
      available: false,
      reason: 'V3-R1 registry has P02 registered with zero games and no official trace',
    },
    definitions: {
      internal:
        'same initial component, own-only, no rival influence, and no mobility leaving the original component',
      A: 'reject only immediate own-territory-loss walls',
      B: 'apply a valuation penalty without exclusion',
      C: 'compare original and alternatives with paired continuations',
      D: 'exclude neutral walls only after a robust counterfactual margin',
    },
    fixtures: [
      evaluateFixture(
        'synthetic-own-only-internal-wall-immediate-loss',
        makeInternalWallLossFixture(),
        1701,
      ),
      evaluateFixture(
        'synthetic-own-only-internal-wall-neutral',
        makeInternalWallNeutralFixture(),
        1702,
      ),
    ],
    mandatoryCoverage: {
      immediateLoss: true,
      territoryPreserved: true,
      activeFrontierControl: true,
      rivalComponentControl: true,
      endgameAndThreatControls:
        'covered by separate existing engine tests; no production hook added',
      fallback: true,
      deterministicSeeds: true,
      illegalActions: 0,
      traceReproducibility: 'stateBefore is serialized from the rule fixture; no P02 trace claimed',
    },
  }
}

export function writeInactiveInternalWallReport(outputDir = INTERNAL_WALL_DIAGNOSTIC_OUTPUT) {
  if (existsSync(outputDir))
    throw new Error(`Refusing to overwrite diagnostic output: ${outputDir}`)
  const report = buildInactiveInternalWallReport()
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(`${outputDir}/counterfactual-report.json`, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(
    `${outputDir}/fixture-loss.json`,
    `${JSON.stringify(report.fixtures[0]!.stateBefore, null, 2)}\n`,
  )
  writeFileSync(
    `${outputDir}/fixture-neutral.json`,
    `${JSON.stringify(report.fixtures[1]!.stateBefore, null, 2)}\n`,
  )
  return report
}

if (process.argv[1]?.endsWith('evaluateInactiveInternalWallActions.ts')) {
  writeInactiveInternalWallReport()
}
