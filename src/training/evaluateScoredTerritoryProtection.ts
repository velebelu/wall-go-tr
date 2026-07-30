import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeScoredTerritoryMove,
  chooseWithScoredTerritoryProtection,
  type ScoredTerritoryProtectionResult,
} from '@/agents/scoredTerritoryProtection'
import { calculatePlayerMobilityQ3 } from '@/agents/learningPolicyQ3'
import { applyFullAction } from '@/engine/gameSimulator'
import { searchBestAction } from '@/engine/mcts/MCTS'
import type { MCTSConfig, MCTSResult } from '@/engine/mcts/types'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { getLegalActions, scoreHeuristicAction } from '@/utils/ai'
import { getTerritoryMap } from '@/utils/territory'
import {
  deserializeGameSnapshot,
  parseHumanMCTSTrace,
  type HumanMCTSTraceDecisionV1,
} from '@/utils/humanMCTSTrace'
import { createPlayableMCTSRng } from '@/agents/mctsWorkerDecision'

export const SCORED_TERRITORY_EVALUATION_LIMITS = {
  maxGames: 24,
  maxMCTSDecisions: 1_200,
  maxElapsedMs: 10 * 60_000,
  targetIndependentB: 20,
  continuationsPerB: 2,
} as const

export interface ScoredTerritoryEvaluationLimits {
  maxGames: number
  maxMCTSDecisions: number
  maxElapsedMs: number
  targetIndependentB: number
  continuationsPerB: number
}

const CONTINUATION_MCTS: MCTSConfig = {
  simulations: 20,
  explorationConstant: Math.SQRT2,
  maxDepth: 30,
  rolloutPolicy: 'mixed',
  heuristicProbability: 0.8,
  tacticalVerification: true,
  tacticalCandidateCount: 2,
}

interface NaturalActivation {
  stateId: string
  gameId: string
  seed: number
  turn: number
  color: Player
  phase: GameSnapshot['phase']
  scoredComponentCells: { x: number; y: number }[]
  territoryBefore: number
  territoryAfterOriginal: number
  territoryAfterReplacement: number
  opponentTerritoryBefore: number
  opponentTerritoryAfterOriginal: number
  opponentTerritoryAfterReplacement: number
  deltaDifferentialOriginal: number
  deltaDifferentialReplacement: number
  lostCells: { x: number; y: number }[]
  originalAction: PlayerAction
  replacementAction: PlayerAction
  originalVisits: number
  replacementVisits: number
  originalMeanValue: number
  replacementMeanValue: number
  legalConservativeAlternatives: number
  activationType: 'A' | 'B'
  replacementVariant: 'expanded' | 'tactical-legal' | 'none'
  protectionChanged: boolean
  continuations: CounterfactualPair[]
}

interface ContinuationMetrics {
  territory: number
  opponentTerritory: number
  differential: number
  outcome: 'win' | 'draw' | 'loss'
  mobility: number
  blockedPieces: number
  legalActions: number
  turnsRemaining: number
}

interface CounterfactualPair {
  seed: number
  original: ContinuationMetrics
  replacement: ContinuationMetrics
  differentialEffect: number
  classification: 'beneficial' | 'harmful' | 'neutral' | 'inconclusive'
}

export async function evaluateScoredTerritoryCorpus(
  params: {
    corpusDirectory?: string
    outputDirectory?: string
    limits?: ScoredTerritoryEvaluationLimits
    write?: boolean
  } = {},
) {
  const corpusDirectory = resolve(
    params.corpusDirectory ?? 'data/diagnostics/secured-territory-behaviour',
  )
  const outputDirectory = resolve(
    params.outputDirectory ?? 'data/evaluations/scored-territory-protection-v2',
  )
  const limits = params.limits ?? SCORED_TERRITORY_EVALUATION_LIMITS
  const started = performance.now()
  const names = (await readdir(corpusDirectory))
    .filter((name) => /^trace-\d+\.json$/.test(name))
    .sort((left, right) => traceNumber(left) - traceNumber(right))
    .slice(0, limits.maxGames)
  const seen = new Set<string>()
  const activations: NaturalActivation[] = []
  let decisions = 0
  let gamesScanned = 0
  let duplicateActivations = 0
  let stoppedBy: 'games' | 'decisions' | 'time' | 'target' = 'games'

  outer: for (const name of names) {
    const trace = parseHumanMCTSTrace(await readFile(resolve(corpusDirectory, name), 'utf8'))
    gamesScanned++
    for (const decision of trace.decisions) {
      if (decision.actor !== 'mcts') continue
      if (decisions >= limits.maxMCTSDecisions) {
        stoppedBy = 'decisions'
        break outer
      }
      if (performance.now() - started >= limits.maxElapsedMs) {
        stoppedBy = 'time'
        break outer
      }
      decisions++
      const state = deserializeGameSnapshot(decision.stateBefore)
      const analysis = analyzeScoredTerritoryMove(state, decision.action)
      if (!analysis) continue
      const type = analysis.losesScoredTerritory
        ? 'B'
        : analysis.internalWithoutTerritoryLoss
          ? 'A'
          : undefined
      if (!type) continue
      const stateId = fingerprint(state, decision.action)
      if (seen.has(stateId)) {
        duplicateActivations++
        continue
      }
      seen.add(stateId)
      const candidates = decision.mcts?.rootCandidates ?? []
      const expanded = chooseWithScoredTerritoryProtection({
        state,
        selected: decision.action,
        candidates,
        replacementMode: 'expanded-only',
      })
      const tactical = expanded.changed
        ? expanded
        : chooseWithScoredTerritoryProtection({
            state,
            selected: decision.action,
            candidates,
            replacementMode: 'tactical-conservative',
          })
      const replacement = tactical.changed ? tactical : expanded
      const continuations =
        type === 'B' && replacement.changed
          ? await pairedContinuations(
              state,
              decision.action,
              replacement.action,
              trace.metadata.mctsColor,
              decision.mcts?.decisionSeed ?? trace.metadata.seed + decision.turnIndex,
              limits.continuationsPerB,
            )
          : []
      activations.push(
        activationRow(
          trace.metadata.gameId,
          trace.metadata.seed,
          decision,
          analysis,
          replacement,
          continuations,
        ),
      )
      if (
        activations.filter((entry) => entry.activationType === 'B').length >=
        limits.targetIndependentB
      ) {
        stoppedBy = 'target'
        break outer
      }
    }
  }

  const b = activations.filter((entry) => entry.activationType === 'B')
  const affectedGames = new Set(b.map((entry) => entry.gameId)).size
  const pairs = b.flatMap((entry) => entry.continuations)
  const report = {
    schema: 'ScoredTerritoryProtectionEvaluationV1',
    generatedAt: new Date().toISOString(),
    diagnosticOnly: true,
    officialConfigurationChanged: false,
    limits,
    stoppedBy,
    gamesScanned,
    mctsDecisionsInspected: decisions,
    elapsedMs: performance.now() - started,
    naturalFrequencyPer100MCTSDecisions: decisions ? (b.length / decisions) * 100 : 0,
    affectedGames,
    independentActivations: {
      A: activations.filter((entry) => entry.activationType === 'A').length,
      B: b.length,
    },
    duplicateActivations,
    replacementSources: {
      expanded: b.filter((entry) => entry.replacementVariant === 'expanded').length,
      tacticalLegal: b.filter((entry) => entry.replacementVariant === 'tactical-legal').length,
      none: b.filter((entry) => entry.replacementVariant === 'none').length,
    },
    counterfactualClassifications: Object.fromEntries(
      ['beneficial', 'harmful', 'neutral', 'inconclusive'].map((label) => [
        label,
        pairs.filter((pair) => pair.classification === label).length,
      ]),
    ),
    meanDifferentialEffect: pairs.length
      ? pairs.reduce((sum, pair) => sum + pair.differentialEffect, 0) / pairs.length
      : 0,
    activations,
  }
  if (params.write !== false) {
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(
      resolve(outputDirectory, 'evaluation-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
  }
  return report
}

function activationRow(
  gameId: string,
  seed: number,
  decision: HumanMCTSTraceDecisionV1,
  analysis: NonNullable<ReturnType<typeof analyzeScoredTerritoryMove>>,
  replacement: ScoredTerritoryProtectionResult,
  continuations: CounterfactualPair[],
): NaturalActivation {
  const candidates = decision.mcts?.rootCandidates ?? []
  const original = candidate(candidates, decision.action)
  const replacementCandidate = candidate(candidates, replacement.action)
  const state = deserializeGameSnapshot(decision.stateBefore)
  const replacementTerritory = territoryPairAfter(state, replacement.action)
  const differentialBefore = analysis.territoryBefore - analysis.opponentTerritoryBefore
  return {
    stateId: fingerprint(state, decision.action),
    gameId,
    seed,
    turn: decision.turnIndex,
    color: decision.player,
    phase: decision.phase,
    scoredComponentCells: analysis.originComponent,
    territoryBefore: analysis.territoryBefore,
    territoryAfterOriginal: analysis.territoryAfter,
    territoryAfterReplacement: replacementTerritory.own,
    opponentTerritoryBefore: analysis.opponentTerritoryBefore,
    opponentTerritoryAfterOriginal: analysis.opponentTerritoryAfter,
    opponentTerritoryAfterReplacement: replacementTerritory.opponent,
    deltaDifferentialOriginal:
      analysis.territoryAfter - analysis.opponentTerritoryAfter - differentialBefore,
    deltaDifferentialReplacement:
      replacementTerritory.own - replacementTerritory.opponent - differentialBefore,
    lostCells: analysis.lostCells,
    originalAction: decision.action,
    replacementAction: replacement.action,
    originalVisits: original?.visits ?? 0,
    replacementVisits: replacementCandidate?.visits ?? 0,
    originalMeanValue: original?.value ?? 0,
    replacementMeanValue: replacementCandidate?.value ?? 0,
    legalConservativeAlternatives: replacement.legalConservativeAlternatives ?? 0,
    activationType: analysis.losesScoredTerritory ? 'B' : 'A',
    replacementVariant: replacement.changed
      ? replacement.replacementSource === 'expanded'
        ? 'expanded'
        : 'tactical-legal'
      : 'none',
    protectionChanged: replacement.changed,
    continuations,
  }
}

async function pairedContinuations(
  state: GameSnapshot,
  originalAction: PlayerAction,
  replacementAction: PlayerAction,
  aiColor: Player,
  seed: number,
  count: number,
): Promise<CounterfactualPair[]> {
  const pairs: CounterfactualPair[] = []
  for (let index = 0; index < count; index++) {
    const continuationSeed = (seed + (index + 1) * 0x6d2b79f5) >>> 0
    const original = playContinuation(
      applyFullAction(state, originalAction).state,
      aiColor,
      continuationSeed,
    )
    const replacement = playContinuation(
      applyFullAction(state, replacementAction).state,
      aiColor,
      continuationSeed,
    )
    const differentialEffect = replacement.differential - original.differential
    pairs.push({
      seed: continuationSeed,
      original,
      replacement,
      differentialEffect,
      classification:
        differentialEffect > 0
          ? 'beneficial'
          : differentialEffect < 0
            ? 'harmful'
            : replacement.outcome === original.outcome
              ? 'neutral'
              : 'inconclusive',
    })
  }
  return pairs
}

function playContinuation(state: GameSnapshot, aiColor: Player, seed: number): ContinuationMetrics {
  let current = state
  let turns = 0
  while (current.phase !== 'finished' && !current.result && turns < 80) {
    const action =
      current.turn === aiColor
        ? searchBestAction(
            current,
            aiColor,
            CONTINUATION_MCTS,
            createPlayableMCTSRng((seed + turns * 0x9e3779b9) >>> 0),
          ).action
        : heuristicAction(current, (seed + turns * 17) >>> 0)
    current = applyFullAction(current, action).state
    turns++
  }
  return continuationMetrics(current, aiColor, turns)
}

function continuationMetrics(
  state: GameSnapshot,
  player: Player,
  turnsRemaining: number,
): ContinuationMetrics {
  const opponent = player === 'R' ? 'B' : 'R'
  const score = state.result?.score ?? territoryCounts(state)
  const mobility = calculatePlayerMobilityQ3(state, player)
  return {
    territory: score[player],
    opponentTerritory: score[opponent],
    differential: score[player] - score[opponent],
    outcome:
      score[player] > score[opponent] ? 'win' : score[player] < score[opponent] ? 'loss' : 'draw',
    mobility: mobility.totalDestinations,
    blockedPieces: mobility.trapPieces,
    legalActions: state.phase === 'finished' || state.result ? 0 : getLegalActions(state).length,
    turnsRemaining,
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

function territoryPairAfter(
  state: GameSnapshot,
  action: PlayerAction,
): { own: number; opponent: number } {
  const after = applyFullAction(state, action).state
  const score = after.result?.score ?? territoryCounts(after)
  return { own: score[state.turn], opponent: score[state.turn === 'R' ? 'B' : 'R'] }
}

function territoryCounts(state: GameSnapshot): Record<Player, number> {
  const counts: Record<Player, number> = { R: 0, B: 0 }
  for (const owner of getTerritoryMap(state.board).flat()) if (owner) counts[owner]++
  return counts
}

function candidate(
  candidates: Readonly<NonNullable<MCTSResult['children']>>,
  action: PlayerAction,
) {
  return candidates.find((entry) => sameAction(entry.action, action))
}

function fingerprint(state: GameSnapshot, action: PlayerAction): string {
  return createHash('sha256')
    .update(JSON.stringify({ board: state.board, turn: state.turn, phase: state.phase, action }))
    .digest('hex')
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function traceNumber(name: string): number {
  return Number(name.match(/\d+/)?.[0] ?? 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = await evaluateScoredTerritoryCorpus()
  console.log(
    JSON.stringify({
      gamesScanned: report.gamesScanned,
      mctsDecisionsInspected: report.mctsDecisionsInspected,
      independentActivations: report.independentActivations,
      meanDifferentialEffect: report.meanDifferentialEffect,
    }),
  )
}
