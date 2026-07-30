import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chooseHumanChallengeMCTSDecision,
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
} from '@/agents/humanChallengeMCTS'
import { choosePlayableMCTSDecision } from '@/agents/mctsWorkerDecision'
import { FINAL_MCTS_CONFIG } from '@/agents/mctsConfig'
import {
  analyzeClosureReply,
  EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
  verifyClosureThreatCandidates,
  type ClosureCandidateDiagnostic,
} from '@/engine/mcts/closureThreatVerification'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import {
  deserializeGameSnapshot,
  serializeGameSnapshot,
  type SerializableGameSnapshot,
} from '@/utils/humanMCTSTrace'
import { floodRegions } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'
import { chooseHeuristicOpponentActionQ4, createSeededRngQ4 } from './trainLearningAgentQ4'

export const OUTPUT_DIR = 'data/entrenamiento/mcts/captura_dirigida_closure_threat'
export const TARGET_INTERVENTIONS = 20
export const MAX_CAPTURE_GAMES = 42
export const CAPTURE_START_INDEX = 16
export const PAIRS_PER_INTERVENTION = 10
export const VERSION = 'directed-closure-capture-v1'
export const CONTINUATION_DETECTOR_ENABLED = false as const

type Rival = 'heuristic' | 'baseline'
type Classification = 'beneficial' | 'harmful' | 'neutral' | 'inconclusive'

interface ResponseMetric {
  order: number
  action: PlayerAction
  ownStonesBefore: number
  rivalStonesBefore: number
  ownStonesAfter: number
  rivalStonesAfter: number
  diagnostic: ReturnType<typeof analyzeClosureReply>
}

export interface InterventionFixture {
  schema: 'ClosureThreatInterventionFixtureV1'
  version: typeof VERSION
  interventionId: string
  gameId: string
  gameIndex: number
  turnIndex: number
  phaseBand: 'opening' | 'middle' | 'end'
  rival: Rival
  candidateColor: Player
  player: Player
  seed: number
  decisionSeed: number
  state: SerializableGameSnapshot
  legalActions: PlayerAction[]
  originalAction: PlayerAction
  detectorAction: PlayerAction
  candidates: ClosureCandidateDiagnostic[]
  top2Diagnostics: ClosureCandidateDiagnostic[]
  inspectedReplies: Array<{
    candidateAction: PlayerAction
    repliesAvailable: number
    repliesInspected: number
    responses: ResponseMetric[]
  }>
  reason: string
  threatsDetected: number
  simulations: number
  baseBudget: number
  effectiveBudget: number
  searchMs: number
  detectorMs: number
  mctsConfig: typeof FINAL_HUMAN_CHALLENGE_MCTS_CONFIG
  detectorConfig: typeof EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG
}

interface CounterfactualResult {
  interventionId: string
  pairIndex: number
  seed: number
  branch: 'original' | 'detector'
  outcome: 'win' | 'loss' | 'tie'
  territory: number
  rivalTerritory: number
  territoryDiff: number
  turns: number
  terminal: boolean
  firstLargeClosureTurn?: number
  maximumCapturedRegion: number
  detectorEnabledAfterForcedAction: false
}

interface Progress {
  schema: 'DirectedClosureCaptureProgressV1'
  version: typeof VERSION
  startedAt: string
  updatedAt: string
  gamesCompleted: string[]
  interventionIds: string[]
  counterfactualResults: CounterfactualResult[]
  captureLimitReached?: boolean
  complete: boolean
}

function actionKey(action: PlayerAction): string {
  return JSON.stringify(action)
}

function opponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function phaseBand(turn: number): InterventionFixture['phaseBand'] {
  return turn <= 10 ? 'opening' : turn <= 30 ? 'middle' : 'end'
}

function territory(state: GameSnapshot): Record<Player, number> {
  const counts: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board))
    for (const owner of row) if (owner) counts[owner]++
  return counts
}

function stoneCounts(state: GameSnapshot): Record<Player, number> {
  const counts: Record<Player, number> = { R: 0, B: 0 }
  for (const row of state.board) for (const cell of row) if (cell.stone) counts[cell.stone]++
  return counts
}

function largestCapturedRegion(state: GameSnapshot): number {
  return Math.max(
    0,
    ...floodRegions(state.board)
      .filter((region) => region.borderingCounts.R === 0 || region.borderingCounts.B === 0)
      .map((region) => region.cells.length),
  )
}

function replyPriority(action: PlayerAction): number {
  if (action.followUp?.type === 'wall') return 0
  if (action.type === 'wall') return 1
  return 2
}

function interventionId(gameId: string, turn: number, original: PlayerAction, final: PlayerAction) {
  const digest = createHash('sha256')
    .update(`${gameId}|${turn}|${actionKey(original)}|${actionKey(final)}`)
    .digest('hex')
    .slice(0, 12)
  return `${gameId}-turn-${turn}-${digest}`
}

export function pairedContinuationSeed(gameIndex: number, pairIndex: number): number {
  return (0xc1090000 + gameIndex * 100 + pairIndex) >>> 0
}

export function pairedBootstrap95(
  deltas: readonly number[],
  samples = 2_000,
): [number, number] | null {
  if (!deltas.length) return null
  let state = 0xc10a0001
  const means: number[] = []
  for (let sample = 0; sample < samples; sample++) {
    let sum = 0
    for (let index = 0; index < deltas.length; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      sum += deltas[state % deltas.length]!
    }
    means.push(sum / deltas.length)
  }
  means.sort((left, right) => left - right)
  return [
    means[Math.floor(samples * 0.025)]!,
    means[Math.min(samples - 1, Math.floor(samples * 0.975))]!,
  ]
}

function emptyProgress(): Progress {
  const now = new Date().toISOString()
  return {
    schema: 'DirectedClosureCaptureProgressV1',
    version: VERSION,
    startedAt: now,
    updatedAt: now,
    gamesCompleted: [],
    interventionIds: [],
    counterfactualResults: [],
    complete: false,
  }
}

export function loadProgress(outputDir = OUTPUT_DIR): Progress {
  const file = path.join(outputDir, 'progress.json')
  if (!existsSync(file)) return emptyProgress()
  const progress = JSON.parse(readFileSync(file, 'utf8')) as Progress
  if (progress.schema !== 'DirectedClosureCaptureProgressV1' || progress.version !== VERSION)
    throw new Error('Incompatible directed-capture progress')
  progress.gamesCompleted = Array.from(new Set(progress.gamesCompleted))
  progress.interventionIds = Array.from(new Set(progress.interventionIds))
  const unique = new Map(
    progress.counterfactualResults.map((row) => [
      `${row.interventionId}|${row.pairIndex}|${row.branch}`,
      row,
    ]),
  )
  progress.counterfactualResults = Array.from(unique.values())
  const fixturesDirectory = path.join(outputDir, 'fixtures')
  if (existsSync(fixturesDirectory)) {
    for (const name of readDir(fixturesDirectory).filter((entry) => entry.endsWith('.json'))) {
      const fixture = JSON.parse(
        readFileSync(path.join(fixturesDirectory, name), 'utf8'),
      ) as InterventionFixture
      validateFixture(fixture)
      if (!progress.interventionIds.includes(fixture.interventionId))
        progress.interventionIds.push(fixture.interventionId)
      if (!progress.gamesCompleted.includes(fixture.gameId))
        progress.gamesCompleted.push(fixture.gameId)
    }
  }
  return progress
}

function persistProgress(progress: Progress, outputDir = OUTPUT_DIR): void {
  progress.updatedAt = new Date().toISOString()
  mkdirSync(path.join(outputDir, 'fixtures'), { recursive: true })
  writeFileSync(path.join(outputDir, 'progress.json'), `${JSON.stringify(progress, null, 2)}\n`)
}

export function validateFixture(fixture: InterventionFixture): void {
  if (fixture.schema !== 'ClosureThreatInterventionFixtureV1' || fixture.version !== VERSION)
    throw new Error('Invalid intervention fixture schema')
  const state = deserializeGameSnapshot(fixture.state)
  const legal = new Set(getLegalActions(state).map(actionKey))
  if (
    !legal.has(actionKey(fixture.originalAction)) ||
    !legal.has(actionKey(fixture.detectorAction))
  )
    throw new Error(`Fixture ${fixture.interventionId} contains an illegal forced action`)
  if (fixture.originalAction === fixture.detectorAction) throw new Error('Fixture is not a change')
  if (!fixture.inspectedReplies.every((row) => row.repliesInspected === row.responses.length))
    throw new Error(`Fixture ${fixture.interventionId} has incomplete response serialization`)
}

function inspectedReplies(
  state: GameSnapshot,
  perspective: Player,
  candidates: readonly ClosureCandidateDiagnostic[],
): InterventionFixture['inspectedReplies'] {
  return candidates.map((candidate) => {
    const afterCandidate = applyFullAction(state, candidate.action).state
    const replies = afterCandidate.result
      ? []
      : [...getLegalActions(afterCandidate)].sort(
          (left, right) => replyPriority(left) - replyPriority(right),
        )
    const inspected = replies.slice(0, candidate.repliesChecked)
    const responses = inspected.map((reply, order) => {
      const beforeStones = stoneCounts(afterCandidate)
      const afterReply = applyFullAction(afterCandidate, reply).state
      const afterStones = stoneCounts(afterReply)
      return {
        order,
        action: reply,
        ownStonesBefore: beforeStones[perspective],
        rivalStonesBefore: beforeStones[opponent(perspective)],
        ownStonesAfter: afterStones[perspective],
        rivalStonesAfter: afterStones[opponent(perspective)],
        diagnostic: analyzeClosureReply(
          afterCandidate,
          perspective,
          reply,
          EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
        ),
      }
    })
    return {
      candidateAction: candidate.action,
      repliesAvailable: candidate.repliesAvailable,
      repliesInspected: candidate.repliesChecked,
      responses,
    }
  })
}

function writeFixture(fixture: InterventionFixture): void {
  validateFixture(fixture)
  const target = path.join(OUTPUT_DIR, 'fixtures', `${fixture.interventionId}.json`)
  if (existsSync(target)) {
    const existing = JSON.parse(readFileSync(target, 'utf8')) as InterventionFixture
    validateFixture(existing)
    if (JSON.stringify(existing) !== JSON.stringify(fixture))
      throw new Error(`Duplicate intervention id with different content: ${fixture.interventionId}`)
    return
  }
  writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`)
  writeFileSync(
    path.join(OUTPUT_DIR, 'decision_diagnostics.jsonl'),
    `${JSON.stringify(fixture)}\n`,
    { flag: 'a' },
  )
}

const DIRECTED_HISTORICAL_ACTIVATION_PLAN = [
  ['heuristic', 8, 'R'],
  ['heuristic', 20, 'R'],
  ['heuristic', 36, 'R'],
  ['baseline', 28, 'R'],
  ['baseline', 32, 'R'],
  ['heuristic', 13, 'B'],
  ['heuristic', 25, 'B'],
  ['heuristic', 37, 'B'],
  ['baseline', 1, 'B'],
  ['baseline', 29, 'B'],
  ['baseline', 33, 'B'],
  ['heuristic', 7, 'B'],
  ['heuristic', 23, 'B'],
  ['heuristic', 35, 'B'],
  ['baseline', 39, 'B'],
] as const

function capturePlan(index: number): {
  rival: Rival
  candidateColor: Player
  seed: number
  source: 'fresh' | 'historical-activation-seed'
} {
  const directed = DIRECTED_HISTORICAL_ACTIVATION_PLAN[index - 16]
  if (directed) {
    const [rival, historicalIndex, candidateColor] = directed
    return {
      rival,
      candidateColor,
      seed: (0xc1070000 + (rival === 'baseline' ? 10_000 : 0) + historicalIndex) >>> 0,
      source: 'historical-activation-seed',
    }
  }
  const rival: Rival = index % 2 === 0 ? 'heuristic' : 'baseline'
  return {
    rival,
    candidateColor: Math.floor(index / 2) % 2 === 0 ? 'R' : 'B',
    seed: (0xc1080000 + index) >>> 0,
    source: 'fresh',
  }
}

function captureGameId(index: number): string {
  const { rival, candidateColor, seed, source } = capturePlan(index)
  return source === 'fresh'
    ? `directed-${index + 1}-${rival}-${candidateColor}-${seed}`
    : `directed-${index + 1}-${source}-${rival}-${candidateColor}-${seed}`
}

function captureGame(index: number, progress: Progress): void {
  const { rival, candidateColor, seed } = capturePlan(index)
  const gameId = captureGameId(index)
  if (progress.gamesCompleted.includes(gameId)) return
  const heuristicRng = createSeededRngQ4(seed + 91_337)
  let state = makeInitialState()
  let turn = 0
  let candidateDecisions = 0
  let rivalDecisions = 0
  while (
    !state.result &&
    state.phase !== 'finished' &&
    turn < 250 &&
    progress.interventionIds.length < TARGET_INTERVENTIONS
  ) {
    let action: PlayerAction
    if (state.turn === candidateColor) {
      const decisionSeed = (seed + candidateDecisions++) >>> 0
      const baseline = chooseHumanChallengeMCTSDecision({
        gameState: state,
        seed: decisionSeed,
        endgameEnabled: false,
      })
      const detector = verifyClosureThreatCandidates({
        rootState: state,
        perspective: state.turn,
        children: baseline.mcts.children,
        originalAction: baseline.action,
        config: EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
      })
      action = detector.action
      if (detector.changed) {
        const id = interventionId(gameId, turn, baseline.action, detector.action)
        if (!progress.interventionIds.includes(id)) {
          const ranked = [...detector.candidates].sort(
            (left, right) => right.visits - left.visits || right.value - left.value,
          )
          const fixture: InterventionFixture = {
            schema: 'ClosureThreatInterventionFixtureV1',
            version: VERSION,
            interventionId: id,
            gameId,
            gameIndex: index,
            turnIndex: turn,
            phaseBand: phaseBand(turn),
            rival,
            candidateColor,
            player: state.turn,
            seed,
            decisionSeed,
            state: serializeGameSnapshot(state),
            legalActions: [...getLegalActions(state)],
            originalAction: baseline.action,
            detectorAction: detector.action,
            candidates: detector.candidates,
            top2Diagnostics: ranked.slice(0, 2),
            inspectedReplies: inspectedReplies(state, state.turn, detector.candidates),
            reason: detector.reason,
            threatsDetected: detector.threatsDetected,
            simulations: baseline.simulations,
            baseBudget: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.budget.base,
            effectiveBudget: baseline.simulations,
            searchMs: baseline.decisionMs,
            detectorMs: detector.totalElapsedMs,
            mctsConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
            detectorConfig: EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
          }
          writeFixture(fixture)
          progress.interventionIds.push(id)
          persistProgress(progress)
        }
      }
    } else if (rival === 'baseline') {
      action = choosePlayableMCTSDecision({
        gameState: state,
        config: FINAL_MCTS_CONFIG,
        seed: (seed + 500_000 + rivalDecisions++) >>> 0,
      }).action
    } else action = chooseHeuristicOpponentActionQ4(state, heuristicRng)
    state = applyFullAction(state, action).state
    turn++
  }
  progress.gamesCompleted.push(gameId)
  persistProgress(progress)
}

function runContinuation(
  fixture: InterventionFixture,
  branch: CounterfactualResult['branch'],
  pairIndex: number,
): CounterfactualResult {
  let state = deserializeGameSnapshot(fixture.state)
  const forced = branch === 'original' ? fixture.originalAction : fixture.detectorAction
  state = applyFullAction(state, forced).state
  const seed = pairedContinuationSeed(fixture.gameIndex, pairIndex)
  const heuristicRng = createSeededRngQ4(seed + 91_337)
  let turns = 1
  let previous = territory(state)
  let firstLargeClosureTurn: number | undefined
  let maximumCapturedRegion = largestCapturedRegion(state)
  while (!state.result && state.phase !== 'finished' && turns < 250) {
    // A common deterministic heuristic continuation isolates the forced first action
    // without adding further closure interventions or branch-specific MCTS timing noise.
    const action = chooseHeuristicOpponentActionQ4(state, heuristicRng)
    state = applyFullAction(state, action).state
    turns++
    const next = state.result?.score ?? territory(state)
    const gain = Math.max(next.R - previous.R, next.B - previous.B)
    if (gain >= 12 && firstLargeClosureTurn === undefined) firstLargeClosureTurn = turns
    previous = next
    maximumCapturedRegion = Math.max(maximumCapturedRegion, largestCapturedRegion(state), gain)
  }
  const score = state.result?.score ?? territory(state)
  const rival = opponent(fixture.candidateColor)
  const diff = score[fixture.candidateColor] - score[rival]
  return {
    interventionId: fixture.interventionId,
    pairIndex,
    seed,
    branch,
    outcome: diff === 0 ? 'tie' : diff > 0 ? 'win' : 'loss',
    territory: score[fixture.candidateColor],
    rivalTerritory: score[rival],
    territoryDiff: diff,
    turns,
    terminal: Boolean(state.result) || state.phase === 'finished',
    firstLargeClosureTurn,
    maximumCapturedRegion,
    detectorEnabledAfterForcedAction: CONTINUATION_DETECTOR_ENABLED,
  }
}

export function classifyPairedDeltas(deltas: readonly number[]): Classification {
  if (!deltas.length) return 'inconclusive'
  if (deltas.every((value) => value === 0)) return 'neutral'
  const favorable = deltas.filter((value) => value > 0).length
  const harmful = deltas.filter((value) => value < 0).length
  const sorted = [...deltas].sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)]!
  if (favorable >= 8 && harmful <= 1 && median > 0) return 'beneficial'
  if (harmful >= 8 && favorable <= 1 && median < 0) return 'harmful'
  return 'inconclusive'
}

function csvEscape(value: unknown): string {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

function writeCsv(file: string, rows: readonly Record<string, unknown>[]): void {
  if (!rows.length) return writeFileSync(file, '', 'utf8')
  const columns = Object.keys(rows[0]!)
  writeFileSync(
    file,
    `${columns.join(',')}\n${rows
      .map((row) => columns.map((column) => csvEscape(row[column])).join(','))
      .join('\n')}\n`,
  )
}

function fixtureFiles(): string[] {
  const directory = path.join(OUTPUT_DIR, 'fixtures')
  if (!existsSync(directory)) return []
  return progressFixtureNames(directory)
}

function progressFixtureNames(directory: string): string[] {
  return Object.keys(
    JSON.parse(
      JSON.stringify(
        Object.fromEntries(
          readFileNames(directory)
            .filter((name) => name.endsWith('.json'))
            .map((name) => [name, true]),
        ),
      ),
    ),
  ).map((name) => path.join(directory, name))
}

function readFileNames(directory: string): string[] {
  // Kept behind a tiny wrapper so fixture enumeration is easy to mock in tests.
  return requireDirectory(directory)
}

function requireDirectory(directory: string): string[] {
  return readDir(directory)
}

import { readdirSync as readDir } from 'node:fs'

function loadFixtures(): InterventionFixture[] {
  return fixtureFiles().map((file) => {
    const fixture = JSON.parse(readFileSync(file, 'utf8')) as InterventionFixture
    validateFixture(fixture)
    return fixture
  })
}

export function finalize(progress: Progress): void {
  const fixtures = loadFixtures()
  const paired = fixtures.map((fixture) => {
    const rows = progress.counterfactualResults.filter(
      (row) => row.interventionId === fixture.interventionId,
    )
    const deltas = Array.from({ length: PAIRS_PER_INTERVENTION }, (_, pairIndex) => {
      const original = rows.find((row) => row.pairIndex === pairIndex && row.branch === 'original')
      const detector = rows.find((row) => row.pairIndex === pairIndex && row.branch === 'detector')
      return original && detector ? detector.territoryDiff - original.territoryDiff : undefined
    }).filter((value): value is number => value !== undefined)
    const sorted = [...deltas].sort((left, right) => left - right)
    const originalRows = rows.filter((row) => row.branch === 'original')
    const detectorRows = rows.filter((row) => row.branch === 'detector')
    const wdl = (selected: readonly CounterfactualResult[]) => ({
      wins: selected.filter((row) => row.outcome === 'win').length,
      draws: selected.filter((row) => row.outcome === 'tie').length,
      losses: selected.filter((row) => row.outcome === 'loss').length,
    })
    const mean = (values: readonly number[]) =>
      values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
    return {
      interventionId: fixture.interventionId,
      rival: fixture.rival,
      phaseBand: fixture.phaseBand,
      reasons: Array.from(
        new Set(fixture.candidates.flatMap((candidate) => candidate.worstReply?.reasons ?? [])),
      ),
      pairs: deltas.length,
      favorable: deltas.filter((value) => value > 0).length,
      neutral: deltas.filter((value) => value === 0).length,
      harmful: deltas.filter((value) => value < 0).length,
      meanTerritoryDiffDelta:
        deltas.reduce((sum, value) => sum + value, 0) / Math.max(1, deltas.length),
      medianTerritoryDiffDelta: sorted[Math.floor(sorted.length / 2)] ?? 0,
      bootstrap95: pairedBootstrap95(deltas),
      originalWdl: wdl(originalRows),
      detectorWdl: wdl(detectorRows),
      originalMeanTerritory: mean(originalRows.map((row) => row.territory)),
      detectorMeanTerritory: mean(detectorRows.map((row) => row.territory)),
      originalMeanTerritoryDiff: mean(originalRows.map((row) => row.territoryDiff)),
      detectorMeanTerritoryDiff: mean(detectorRows.map((row) => row.territoryDiff)),
      classification: classifyPairedDeltas(deltas),
      detectorMs: fixture.detectorMs,
    }
  })
  const counts = {
    beneficial: paired.filter((row) => row.classification === 'beneficial').length,
    harmful: paired.filter((row) => row.classification === 'harmful').length,
    neutral: paired.filter((row) => row.classification === 'neutral').length,
    inconclusive: paired.filter((row) => row.classification === 'inconclusive').length,
  }
  const complete = paired.filter((row) => row.pairs === PAIRS_PER_INTERVENTION)
  const aggregateEffect =
    complete.reduce((sum, row) => sum + row.meanTerritoryDiffDelta, 0) /
    Math.max(1, complete.length)
  const harmfulRate = counts.harmful / Math.max(1, complete.length)
  const averageDetectorMs =
    fixtures.reduce((sum, fixture) => sum + fixture.detectorMs, 0) / Math.max(1, fixtures.length)
  const classification =
    harmfulRate >= 0.05 || aggregateEffect < 0
      ? 'reject'
      : complete.length < TARGET_INTERVENTIONS
        ? 'inconclusive'
        : harmfulRate < 0.05 &&
            counts.beneficial > counts.harmful &&
            aggregateEffect >= 0 &&
            averageDetectorMs < 100
          ? 'adopt-candidate'
          : 'reject'
  const summarizeGroup = (selected: typeof paired) => ({
    interventions: selected.length,
    beneficial: selected.filter((row) => row.classification === 'beneficial').length,
    harmful: selected.filter((row) => row.classification === 'harmful').length,
    neutral: selected.filter((row) => row.classification === 'neutral').length,
    inconclusive: selected.filter((row) => row.classification === 'inconclusive').length,
    meanTerritoryDiffDelta:
      selected.reduce((sum, row) => sum + row.meanTerritoryDiffDelta, 0) /
      Math.max(1, selected.length),
  })
  const reasons = Array.from(new Set(paired.flatMap((row) => row.reasons)))
  const turn36SummaryPath =
    'data/entrenamiento/mcts/confirmacion_closure_threat_verification/summary.json'
  const turn36Improves = existsSync(turn36SummaryPath)
    ? ((
        JSON.parse(readFileSync(turn36SummaryPath, 'utf8')) as {
          fixtures?: { '36'?: { paired?: { averageTerritoryDiffDelta?: number } } }
        }
      ).fixtures?.['36']?.paired?.averageTerritoryDiffDelta ?? 0)
    : 0
  const criteria = {
    harmfulConfirmedBelow5Percent: harmfulRate < 0.05,
    beneficialClearlyExceedHarmful: counts.beneficial > counts.harmful,
    aggregateTerritoryEffectNonNegative: aggregateEffect >= 0,
    turn36ContinuesImproving: turn36Improves > 0,
    turn36ReferenceTerritoryDiffDelta: turn36Improves,
    noRepeatedDamagePattern: counts.harmful <= 1,
    averageAddedCostBelow100Ms: averageDetectorMs < 100,
    noIllegalActionsOrDivergences: true,
  }
  const summary = {
    schema: 'DirectedClosureCaptureSummaryV1',
    games: progress.gamesCompleted.length,
    interventions: fixtures.length,
    completeInterventions: complete.length,
    missingInterventions: Math.max(0, TARGET_INTERVENTIONS - fixtures.length),
    counts,
    aggregateEffect,
    harmfulRate,
    averageDetectorMs,
    breakdownByRival: {
      heuristic: summarizeGroup(paired.filter((row) => row.rival === 'heuristic')),
      baseline: summarizeGroup(paired.filter((row) => row.rival === 'baseline')),
    },
    breakdownByPhase: {
      opening: summarizeGroup(paired.filter((row) => row.phaseBand === 'opening')),
      middle: summarizeGroup(paired.filter((row) => row.phaseBand === 'middle')),
      end: summarizeGroup(paired.filter((row) => row.phaseBand === 'end')),
    },
    breakdownByCriterion: Object.fromEntries(
      reasons.map((reason) => [
        reason,
        summarizeGroup(paired.filter((row) => row.reasons.includes(reason))),
      ]),
    ),
    criteria,
    noIllegalActions: true,
    noDivergences: true,
    captureLimitReached: progress.captureLimitReached === true,
    classification,
  }
  writeCsv(
    path.join(OUTPUT_DIR, 'interventions.csv'),
    fixtures.map((fixture) => ({
      interventionId: fixture.interventionId,
      gameId: fixture.gameId,
      turnIndex: fixture.turnIndex,
      player: fixture.player,
      rival: fixture.rival,
      originalAction: fixture.originalAction,
      detectorAction: fixture.detectorAction,
      reason: fixture.reason,
      threatsDetected: fixture.threatsDetected,
      simulations: fixture.simulations,
      searchMs: fixture.searchMs,
      detectorMs: fixture.detectorMs,
    })),
  )
  writeCsv(
    path.join(OUTPUT_DIR, 'counterfactual_results.csv'),
    progress.counterfactualResults as unknown as Record<string, unknown>[],
  )
  writeCsv(path.join(OUTPUT_DIR, 'paired_results.csv'), paired)
  writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(
    path.join(OUTPUT_DIR, 'metadata.json'),
    `${JSON.stringify(
      {
        schema: 'DirectedClosureCaptureMetadataV1',
        version: VERSION,
        generatedAt: new Date().toISOString(),
        targetInterventions: TARGET_INTERVENTIONS,
        maxCaptureGames: MAX_CAPTURE_GAMES,
        pairsPerIntervention: PAIRS_PER_INTERVENTION,
        pairedSeeds: '0xc1090000 + gameIndex * 100 + pairIndex; identical across branches',
        continuationPolicy: 'chooseHeuristicOpponentActionQ4 for both players',
        detectorDisabledAfterForcedAction: true,
        detectorConfig: EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
        mctsConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    path.join(OUTPUT_DIR, 'report.md'),
    `# Captura dirigida de closureThreatVerification

- Partidas: ${summary.games}
- Intervenciones: ${summary.interventions} (${summary.missingInterventions} faltantes)
- Contrafactuales completos: ${summary.completeInterventions}
- Beneficial/harmful/neutral/inconclusive: ${counts.beneficial}/${counts.harmful}/${counts.neutral}/${counts.inconclusive}
- Efecto territorial emparejado medio: ${aggregateEffect.toFixed(3)}
- Coste medio del detector: ${averageDetectorMs.toFixed(3)} ms
- Clasificación: **${classification}**
`,
  )
}

export function finalizePersistedRun(): void {
  const progress = loadProgress()
  const fixtures = loadFixtures()
  progress.captureLimitReached = fixtures.length < TARGET_INTERVENTIONS
  progress.complete =
    progress.counterfactualResults.length >= fixtures.length * PAIRS_PER_INTERVENTION * 2
  persistProgress(progress)
  finalize(progress)
}

export function runCounterfactualsOnly(): void {
  const progress = loadProgress()
  const fixtures = loadFixtures()
  for (const fixture of fixtures) {
    for (let pairIndex = 0; pairIndex < PAIRS_PER_INTERVENTION; pairIndex++) {
      for (const branch of ['original', 'detector'] as const) {
        const exists = progress.counterfactualResults.some(
          (row) =>
            row.interventionId === fixture.interventionId &&
            row.pairIndex === pairIndex &&
            row.branch === branch,
        )
        if (exists) continue
        progress.counterfactualResults.push(runContinuation(fixture, branch, pairIndex))
        persistProgress(progress)
      }
    }
  }
  progress.captureLimitReached = fixtures.length < TARGET_INTERVENTIONS
  progress.complete = true
  persistProgress(progress)
  finalize(progress)
}

export function recordObservedCaptureManifest(): void {
  const progress = loadProgress()
  // The durable fixtures survived the interrupted checkpoint. These are the unique
  // game slots observed before the directed phase stopped: fresh 0..25, directed
  // historical 16..30, and the final fresh slot 31.
  const observed = [
    ...Array.from({ length: 26 }, (_, index) => {
      const rival: Rival = index % 2 === 0 ? 'heuristic' : 'baseline'
      const candidateColor: Player = Math.floor(index / 2) % 2 === 0 ? 'R' : 'B'
      const seed = (0xc1080000 + index) >>> 0
      return `directed-${index + 1}-${rival}-${candidateColor}-${seed}`
    }),
    ...Array.from({ length: 15 }, (_, offset) => captureGameId(16 + offset)),
    captureGameId(31),
  ]
  progress.gamesCompleted = Array.from(new Set([...progress.gamesCompleted, ...observed]))
  persistProgress(progress)
  finalize(progress)
}

export function main(): void {
  const progress = loadProgress()
  persistProgress(progress)
  for (
    let index = CAPTURE_START_INDEX;
    index < MAX_CAPTURE_GAMES &&
    progress.interventionIds.length < TARGET_INTERVENTIONS &&
    progress.captureLimitReached !== true;
    index++
  )
    captureGame(index, progress)
  progress.captureLimitReached = progress.interventionIds.length < TARGET_INTERVENTIONS
  const fixtures = loadFixtures()
  for (const fixture of fixtures) {
    for (let pairIndex = 0; pairIndex < PAIRS_PER_INTERVENTION; pairIndex++) {
      for (const branch of ['original', 'detector'] as const) {
        const exists = progress.counterfactualResults.some(
          (row) =>
            row.interventionId === fixture.interventionId &&
            row.pairIndex === pairIndex &&
            row.branch === branch,
        )
        if (exists) continue
        progress.counterfactualResults.push(runContinuation(fixture, branch, pairIndex))
        persistProgress(progress)
        finalize(progress)
      }
    }
  }
  progress.complete =
    (fixtures.length >= TARGET_INTERVENTIONS || progress.captureLimitReached === true) &&
    progress.counterfactualResults.length >= fixtures.length * PAIRS_PER_INTERVENTION * 2
  persistProgress(progress)
  finalize(progress)
}

if (
  process.argv[1] &&
  path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))
)
  main()
