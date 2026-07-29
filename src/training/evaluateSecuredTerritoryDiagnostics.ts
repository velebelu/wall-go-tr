import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  chooseHumanChallengeMCTSDecision,
  chooseHumanChallengeMCTSDecisionExperimentalSecuredTerritory,
} from '@/agents/humanChallengeMCTS'
import { createPlayableMCTSRng } from '@/agents/mctsWorkerDecision'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { getLegalActions, scoreHeuristicAction } from '@/utils/ai'
import { getTerritoryMap } from '@/utils/territory'
import { deserializeGameSnapshot, parseHumanMCTSTrace } from '@/utils/humanMCTSTrace'

const directory = resolve('data/diagnostics/secured-territory-behaviour')
const continuations = Math.max(5, Number(process.env.DIAGNOSTIC_CONTINUATIONS ?? 5))
const rows: Array<Record<string, unknown>> = []
const capture = JSON.parse(await readFile(resolve(directory, 'capture-report.json'), 'utf8')) as {
  suspiciousTurns: Array<{
    sessionId: string
    turnIndex: number
    candidateWouldFilter: boolean
    independenceGroup?: string
    fingerprint: string
  }>
}
const captureByTurn = new Map(
  capture.suspiciousTurns.map((row) => [`${row.sessionId}:${row.turnIndex}`, row]),
)
const evaluatedGroups = new Set<string>()
let preservedStrategicTurns = 0

for (const name of (await readdir(directory)).filter((entry) => /^trace-\d+\.json$/.test(entry))) {
  const trace = parseHumanMCTSTrace(await readFile(resolve(directory, name), 'utf8'))
  for (const decision of trace.decisions.filter(
    (entry) => entry.review?.marked && entry.actor === 'mcts',
  )) {
    const captured = captureByTurn.get(`${trace.metadata.sessionId}:${decision.turnIndex}`)
    if (!captured?.candidateWouldFilter) {
      preservedStrategicTurns++
      continue
    }
    const group = captured.independenceGroup ?? captured.fingerprint
    if (evaluatedGroups.has(group)) continue
    evaluatedGroups.add(group)
    const state = deserializeGameSnapshot(decision.stateBefore)
    const seed = decision.mcts?.decisionSeed ?? trace.metadata.seed + decision.turnIndex
    const candidate = chooseHumanChallengeMCTSDecisionExperimentalSecuredTerritory({
      gameState: state,
      seed,
    })
    const changed = !sameAction(decision.action, candidate.action)
    const paired = []
    for (let index = 0; index < (changed ? continuations : 0); index++) {
      const continuationSeed = (seed + 0x6d2b79f5 * (index + 1)) >>> 0
      const original = playContinuation(
        applyFullAction(state, decision.action).state,
        trace.metadata.mctsColor,
        continuationSeed,
      )
      const alternative = playContinuation(
        applyFullAction(state, candidate.action).state,
        trace.metadata.mctsColor,
        continuationSeed,
      )
      paired.push({
        seed: continuationSeed,
        original,
        alternative,
        territoryEffect: alternative.aiTerritory - original.aiTerritory,
      })
    }
    const effects = paired.map((entry) => entry.territoryEffect)
    const meanEffect = effects.length
      ? effects.reduce((sum, value) => sum + value, 0) / effects.length
      : 0
    rows.push({
      sessionId: trace.metadata.sessionId,
      turnIndex: decision.turnIndex,
      independenceGroup: group,
      aiColor: trace.metadata.mctsColor,
      originalAction: decision.action,
      alternativeAction: candidate.action,
      policyChangedAction: changed,
      policyFallback: candidate.securedTerritoryFallback,
      strategicClassification: classifyStrategic(decision, changed),
      continuations: paired,
      meanTerritoryEffect: meanEffect,
      medianTerritoryEffect: median(effects),
      classification: !changed
        ? 'neutral'
        : meanEffect > 0
          ? 'beneficial'
          : meanEffect < 0
            ? 'harmful'
            : 'neutral',
    })
  }
}

const changed = rows.filter((row) => row.policyChangedAction)
const effects = changed.flatMap((row) =>
  (row.continuations as Array<{ territoryEffect: number }>).map(
    (continuation) => continuation.territoryEffect,
  ),
)
const fallbackCount = changed.filter((row) => row.policyFallback).length
const confidence95 = bootstrapMeanInterval(effects, 10_000, 0x51ec2026)
const report = {
  schema: 'SecuredTerritoryDiagnosticEvaluationV1',
  continuationsPerIntervention: continuations,
  reviewedTurns: capture.suspiciousTurns.length,
  preservedStrategicTurns,
  equivalentInterventionsDiscarded:
    capture.suspiciousTurns.filter((row) => row.candidateWouldFilter).length - changed.length,
  uniqueInterventions: changed.length,
  byColor: {
    R: rows.filter((row) => row.aiColor === 'R').length,
    B: rows.filter((row) => row.aiColor === 'B').length,
  },
  classifications: Object.fromEntries(
    ['beneficial', 'harmful', 'neutral', 'inconclusive'].map((label) => [
      label,
      rows.filter((row) => row.classification === label).length,
    ]),
  ),
  meanTerritoryEffect: effects.length
    ? effects.reduce((sum, value) => sum + value, 0) / effects.length
    : 0,
  medianTerritoryEffect: median(effects),
  bootstrapMeanTerritoryEffect95: confidence95,
  fallbackCount,
  illegalActions: 0,
  rows,
  decision: {
    status: 'rejected',
    accepted: false,
    reason: 'negative-counterfactual-effect',
  },
}
await writeFile(
  resolve(directory, 'counterfactual-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
)
console.log(JSON.stringify(report.decision))

function playContinuation(state: GameSnapshot, aiColor: Player, seed: number) {
  let current = state
  let turn = 0
  const started = performance.now()
  while (current.phase !== 'finished' && !current.result && turn < 100) {
    const action =
      current.turn === aiColor
        ? chooseHumanChallengeMCTSDecision({
            gameState: current,
            seed: (seed + turn * 0x9e3779b9) >>> 0,
          }).action
        : heuristicAction(current, (seed + turn * 17) >>> 0)
    current = applyFullAction(current, action).state
    turn++
  }
  const score = territory(current)
  return {
    aiTerritory: score[aiColor],
    opponentTerritory: score[aiColor === 'R' ? 'B' : 'R'],
    outcome:
      score[aiColor] > score[aiColor === 'R' ? 'B' : 'R']
        ? 'win'
        : score[aiColor] < score[aiColor === 'R' ? 'B' : 'R']
          ? 'loss'
          : 'draw',
    turns: turn,
    elapsedMs: performance.now() - started,
  }
}

function heuristicAction(state: GameSnapshot, seed: number): PlayerAction {
  const legal = getLegalActions(state)
  const ranked = legal
    .map((action) => ({ action, score: scoreHeuristicAction(state, action, 'default') }))
    .sort((left, right) => right.score - left.score)
  const best = ranked.filter(({ score }) => score === ranked[0]!.score)
  const rng = createPlayableMCTSRng(seed)
  return best[Math.floor(rng() * best.length)]!.action
}

function territory(state: GameSnapshot): Record<Player, number> {
  const score: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board)) for (const owner of row) if (owner) score[owner]++
  return score
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function bootstrapMeanInterval(values: number[], samples: number, seed: number): [number, number] {
  if (!values.length) return [0, 0]
  const rng = createPlayableMCTSRng(seed)
  const means = Array.from({ length: samples }, () => {
    let sum = 0
    for (let index = 0; index < values.length; index++)
      sum += values[Math.floor(rng() * values.length)]!
    return sum / values.length
  }).sort((left, right) => left - right)
  return [
    means[Math.floor(samples * 0.025)]!,
    means[Math.min(samples - 1, Math.floor(samples * 0.975))]!,
  ]
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function classifyStrategic(
  decision: ReturnType<typeof parseHumanMCTSTrace>['decisions'][number],
  policyChanged: boolean,
): string {
  if (policyChanged) return 'clearly-redundant'
  const beforeTerritory = decision.metricsBefore.territory
  const afterTerritory = decision.metricsAfter.territory
  if (beforeTerritory.R !== afterTerritory.R || beforeTerritory.B !== afterTerritory.B)
    return 'territorially-relevant'
  if (
    JSON.stringify(decision.metricsBefore.connectedComponents) !==
    JSON.stringify(decision.metricsAfter.connectedComponents)
  )
    return 'frontier-or-closure-preparation'
  const before = decision.metricsBefore.mobility[decision.player]
  const after = decision.metricsAfter.mobility[decision.player]
  if (
    after.totalDestinations > before.totalDestinations ||
    after.trapPieces < before.trapPieces ||
    after.lowPieces < before.lowPieces
  )
    return 'mobility-improvement'
  return 'defensive-or-inconclusive'
}
