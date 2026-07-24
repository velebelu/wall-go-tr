import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chooseHumanChallengeMCTSDecision } from '@/agents/humanChallengeMCTS'
import { choosePlayableMCTSDecision } from '@/agents/mctsWorkerDecision'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import { applyFullAction } from '@/engine/gameSimulator'
import type { Player, PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { getTerritoryCounts } from './compareLearningAgents'
import { bootstrapMeanCI95, exactTwoSidedSignTest } from './confirmHumanMCTSTurn10'
import { wilson95 } from './evaluateMCTSTacticalConfirmation'
import { chooseHeuristicOpponentActionQ4, createSeededRngQ4 } from './trainLearningAgentQ4'

export const FINAL_CONFIRMATION_OUTPUT =
  'data/entrenamiento/mcts/confirmacion_final_human_challenge'
export const FINAL_CONFIRMATION_VERSION = 'human-challenge-final-confirmation-v1'
export const FINAL_CONFIRMATION_MAX_DECISIONS = 250
export const HEURISTIC_GAMES = 100
export const BASELINE_GAMES = 50
export const TOTAL_GAMES = HEURISTIC_GAMES + BASELINE_GAMES

export type FinalRival = 'heuristic' | 'baseline'
export type AdoptionClassification =
  | 'adopt'
  | 'adopt-with-documented-latency'
  | 'retain-current-baseline'
  | 'inconclusive'

export interface ConfirmationPlanRow {
  id: string
  rival: FinalRival
  seed: number
  pairSeed: number
  candidateColor: Player
}

export interface DecisionTiming {
  gameId: string
  rival: FinalRival
  seed: number
  candidateColor: Player
  decisionIndex: number
  elapsedMs: number
  simulations: number
  finishedAt250: boolean
  expandedTo500: boolean
  stoppedByTimeLimit: boolean
  tacticalChanged: boolean
}

export interface ConfirmationMatch {
  id: string
  rival: FinalRival
  seed: number
  pairSeed: number
  candidateColor: Player
  outcome: 'win' | 'loss' | 'tie'
  winner: Player | 'tie'
  territoryCandidate: number
  territoryRival: number
  territoryDiff: number
  decisions: number
  terminal: boolean
  reachedSafetyLimit: boolean
  durationMs: number
}

export interface FinalConfirmationProgress {
  schema: 'HumanChallengeFinalProgressV1'
  evaluatorVersion: typeof FINAL_CONFIRMATION_VERSION
  plan: ConfirmationPlanRow[]
  matches: ConfirmationMatch[]
  timings: DecisionTiming[]
  startedAt: string
  updatedAt: string
  durationMsAccumulated: number
  complete: boolean
}

export interface FinalConfirmationOptions {
  outputDir?: string
  plan?: readonly ConfirmationPlanRow[]
  maxDecisions?: number
  now?: () => number
  runGame?: (
    planned: ConfirmationPlanRow,
    options: { maxDecisions: number; now: () => number },
  ) =>
    | { match: ConfirmationMatch; timings: DecisionTiming[] }
    | Promise<{ match: ConfirmationMatch; timings: DecisionTiming[] }>
  shouldAbort?: () => boolean
  onProgress?: (message: string) => void
}

function round(value: number): number {
  return Number(value.toFixed(4))
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0
  const average = mean(values)
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
  )
}

export function percentile(values: readonly number[], probability: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)]!
}

function opponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

export function buildFinalConfirmationPlan(): ConfirmationPlanRow[] {
  const heuristic = Array.from({ length: HEURISTIC_GAMES }, (_, index) => {
    const seed = 2_026_072_500 + index
    const candidateColor: Player = index % 2 === 0 ? 'R' : 'B'
    return {
      id: `heuristic-${index + 1}-${candidateColor}`,
      rival: 'heuristic' as const,
      seed,
      pairSeed: seed,
      candidateColor,
    }
  })
  const baseline = Array.from({ length: BASELINE_GAMES / 2 }, (_, pairIndex) => {
    const seed = 2_026_073_000 + pairIndex
    return (['R', 'B'] as const).map((candidateColor) => ({
      id: `baseline-${pairIndex + 1}-${candidateColor}`,
      rival: 'baseline' as const,
      seed,
      pairSeed: seed,
      candidateColor,
    }))
  }).flat()
  return [...heuristic, ...baseline]
}

export function validateFinalConfirmationPlan(plan: readonly ConfirmationPlanRow[]): void {
  if (plan.length !== TOTAL_GAMES)
    throw new Error(`The final plan must contain ${TOTAL_GAMES} games`)
  if (new Set(plan.map((row) => row.id)).size !== plan.length)
    throw new Error('The final plan contains duplicate game ids')
  const heuristic = plan.filter((row) => row.rival === 'heuristic')
  const baseline = plan.filter((row) => row.rival === 'baseline')
  if (
    heuristic.length !== HEURISTIC_GAMES ||
    heuristic.filter((row) => row.candidateColor === 'R').length !== 50 ||
    heuristic.filter((row) => row.candidateColor === 'B').length !== 50
  )
    throw new Error('Heuristic games must be balanced 50/50 by color')
  if (
    baseline.length !== BASELINE_GAMES ||
    baseline.filter((row) => row.candidateColor === 'R').length !== 25 ||
    baseline.filter((row) => row.candidateColor === 'B').length !== 25
  )
    throw new Error('Baseline games must be balanced 25/25 by color')
  for (const seed of new Set(baseline.map((row) => row.pairSeed))) {
    const pair = baseline.filter((row) => row.pairSeed === seed)
    if (
      pair.length !== 2 ||
      !pair.some((row) => row.candidateColor === 'R') ||
      !pair.some((row) => row.candidateColor === 'B')
    )
      throw new Error(`Baseline seed ${seed} does not contain an exact color pair`)
  }
}

export function runConfirmationGame(
  planned: ConfirmationPlanRow,
  options: { maxDecisions: number; now: () => number },
): { match: ConfirmationMatch; timings: DecisionTiming[] } {
  const startedAt = options.now()
  const timings: DecisionTiming[] = []
  const heuristicRng = createSeededRngQ4(planned.seed + 91_337)
  let state = makeInitialState()
  let decisions = 0
  let candidateDecision = 0
  let rivalDecision = 0
  while (state.phase !== 'finished' && !state.result && decisions < options.maxDecisions) {
    const legal = getLegalActions(state)
    if (!legal.length) break
    let action: PlayerAction
    if (state.turn === planned.candidateColor) {
      const before = options.now()
      const decision = chooseHumanChallengeMCTSDecision({
        gameState: state,
        seed: planned.seed + candidateDecision++,
        endgameEnabled: false,
      })
      const elapsedMs = options.now() - before
      action = decision.action
      if (!legal.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action)))
        throw new Error(`Candidate produced an illegal action in ${planned.id}`)
      timings.push({
        gameId: planned.id,
        rival: planned.rival,
        seed: planned.seed,
        candidateColor: planned.candidateColor,
        decisionIndex: timings.length,
        elapsedMs: round(elapsedMs),
        simulations: decision.simulations,
        finishedAt250: decision.simulations <= 250 && !decision.stoppedByTimeLimit,
        expandedTo500: decision.expandedTo500,
        stoppedByTimeLimit: decision.stoppedByTimeLimit,
        tacticalChanged: decision.tacticalChanged,
      })
    } else if (planned.rival === 'baseline') {
      action = choosePlayableMCTSDecision({
        gameState: state,
        config: FINAL_MCTS_CONFIG,
        seed: planned.seed + 500_000 + rivalDecision++,
      }).action
    } else {
      action = chooseHeuristicOpponentActionQ4(state, heuristicRng)
    }
    if (!legal.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action)))
      throw new Error(`Rival produced an illegal action in ${planned.id}`)
    state = applyFullAction(state, action).state
    decisions++
  }
  const terminal = state.phase === 'finished' || state.result !== undefined
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner =
    state.result?.winner ??
    (territory.R === territory.B ? 'tie' : territory.R > territory.B ? 'R' : 'B')
  return {
    match: {
      ...planned,
      outcome: winner === 'tie' ? 'tie' : winner === planned.candidateColor ? 'win' : 'loss',
      winner,
      territoryCandidate: territory[planned.candidateColor],
      territoryRival: territory[opponent(planned.candidateColor)],
      territoryDiff:
        territory[planned.candidateColor] - territory[opponent(planned.candidateColor)],
      decisions,
      terminal,
      reachedSafetyLimit: decisions >= options.maxDecisions,
      durationMs: round(options.now() - startedAt),
    },
    timings,
  }
}

function emptyProgress(plan: readonly ConfirmationPlanRow[]): FinalConfirmationProgress {
  const timestamp = new Date().toISOString()
  return {
    schema: 'HumanChallengeFinalProgressV1',
    evaluatorVersion: FINAL_CONFIRMATION_VERSION,
    plan: [...plan],
    matches: [],
    timings: [],
    startedAt: timestamp,
    updatedAt: timestamp,
    durationMsAccumulated: 0,
    complete: false,
  }
}

export function loadFinalProgress(
  outputDir: string,
  plan: readonly ConfirmationPlanRow[],
): FinalConfirmationProgress {
  const filePath = path.join(outputDir, 'progress.json')
  if (!existsSync(filePath)) return emptyProgress(plan)
  const progress = JSON.parse(readFileSync(filePath, 'utf8')) as FinalConfirmationProgress
  if (
    progress.schema !== 'HumanChallengeFinalProgressV1' ||
    JSON.stringify(progress.plan) !== JSON.stringify(plan)
  )
    throw new Error('Existing progress is incompatible with the final confirmation plan')
  if (new Set(progress.matches.map((row) => row.id)).size !== progress.matches.length)
    throw new Error('Existing progress contains duplicate matches')
  if (progress.matches.some((row) => !plan.some((planned) => planned.id === row.id)))
    throw new Error('Existing progress contains an unknown match')
  return progress
}

function csvEscape(value: unknown): string {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return `"${text.split('"').join('""')}"`
}

function writeCsv<T extends object>(filePath: string, rows: readonly T[]): void {
  if (!rows.length) return writeFileSync(filePath, '', 'utf8')
  const headers = Object.keys(rows[0] as object)
  writeFileSync(
    filePath,
    `${headers.join(',')}\n${rows
      .map((row) =>
        headers.map((header) => csvEscape((row as Record<string, unknown>)[header])).join(','),
      )
      .join('\n')}\n`,
    'utf8',
  )
}

export function aggregateMatches(rows: readonly ConfirmationMatch[]) {
  const wins = rows.filter((row) => row.outcome === 'win').length
  const losses = rows.filter((row) => row.outcome === 'loss').length
  const ties = rows.length - wins - losses
  const territoryOwn = rows.map((row) => row.territoryCandidate)
  const territoryRival = rows.map((row) => row.territoryRival)
  const territoryDiff = rows.map((row) => row.territoryDiff)
  const byColor = (color: Player) => {
    const selected = rows.filter((row) => row.candidateColor === color)
    return {
      games: selected.length,
      wins: selected.filter((row) => row.outcome === 'win').length,
      losses: selected.filter((row) => row.outcome === 'loss').length,
      ties: selected.filter((row) => row.outcome === 'tie').length,
    }
  }
  return {
    games: rows.length,
    wins,
    losses,
    ties,
    winRate: round(wins / Math.max(1, rows.length)),
    winRateCI95: wilson95(wins, rows.length),
    averageOwnTerritory: round(mean(territoryOwn)),
    averageRivalTerritory: round(mean(territoryRival)),
    averageTerritoryDiff: round(mean(territoryDiff)),
    medianTerritoryDiff: round(median(territoryDiff)),
    territoryDiffStandardDeviation: round(standardDeviation(territoryDiff)),
    byColor: { R: byColor('R'), B: byColor('B') },
  }
}

function outcomeScore(outcome: ConfirmationMatch['outcome']): number {
  return outcome === 'win' ? 1 : outcome === 'tie' ? 0.5 : 0
}

export function buildBaselinePairs(rows: readonly ConfirmationMatch[]) {
  const pairs = Array.from(new Set(rows.map((row) => row.pairSeed)))
    .sort((left, right) => left - right)
    .map((seed) => {
      const red = rows.find((row) => row.pairSeed === seed && row.candidateColor === 'R')
      const blue = rows.find((row) => row.pairSeed === seed && row.candidateColor === 'B')
      if (!red || !blue) throw new Error(`Incomplete baseline color pair for seed ${seed}`)
      return {
        seed,
        redOutcome: red.outcome,
        blueOutcome: blue.outcome,
        meanOutcome: round((outcomeScore(red.outcome) + outcomeScore(blue.outcome)) / 2),
        redTerritoryDiff: red.territoryDiff,
        blueTerritoryDiff: blue.territoryDiff,
        meanTerritoryDiff: round((red.territoryDiff + blue.territoryDiff) / 2),
      }
    })
  const differences = pairs.map((row) => row.meanTerritoryDiff)
  const positive = differences.filter((value) => value > 0).length
  const negative = differences.filter((value) => value < 0).length
  return {
    pairs,
    summary: {
      pairs: pairs.length,
      averageTerritoryDiff: round(mean(differences)),
      medianTerritoryDiff: round(median(differences)),
      bootstrapMeanCI95: bootstrapMeanCI95(differences, 10_000, 2_026_073_999),
      signTest: exactTwoSidedSignTest(positive, negative),
    },
  }
}

function completedBaselinePairRows(rows: readonly ConfirmationMatch[]): ConfirmationMatch[] {
  return Array.from(new Set(rows.map((row) => row.pairSeed))).flatMap((seed) => {
    const pair = rows.filter((row) => row.pairSeed === seed)
    return pair.some((row) => row.candidateColor === 'R') &&
      pair.some((row) => row.candidateColor === 'B')
      ? pair
      : []
  })
}

export function aggregateTimings(rows: readonly DecisionTiming[]) {
  const times = rows.map((row) => row.elapsedMs)
  return {
    decisions: rows.length,
    averageMs: round(mean(times)),
    medianMs: round(median(times)),
    p90Ms: round(percentile(times, 0.9)),
    p95Ms: round(percentile(times, 0.95)),
    p99Ms: round(percentile(times, 0.99)),
    maxMs: round(Math.max(0, ...times)),
    averageSimulations: round(mean(rows.map((row) => row.simulations))),
    finishedAt250: rows.filter((row) => row.finishedAt250).length,
    expandedTo500: rows.filter((row) => row.expandedTo500).length,
    timeLimitStops: rows.filter((row) => row.stoppedByTimeLimit).length,
    timeLimitStopRate: round(
      rows.filter((row) => row.stoppedByTimeLimit).length / Math.max(1, rows.length),
    ),
    totalMs: round(times.reduce((sum, value) => sum + value, 0)),
  }
}

export function classifyFinalCandidate(params: {
  heuristic: ReturnType<typeof aggregateMatches>
  baseline: ReturnType<typeof aggregateMatches>
  timings: ReturnType<typeof aggregateTimings>
  complete: boolean
  technicalValid: boolean
}): AdoptionClassification {
  if (!params.complete || !params.technicalValid) return 'inconclusive'
  const competitive =
    params.heuristic.winRate >= 0.7 &&
    params.heuristic.averageTerritoryDiff > 0 &&
    params.baseline.winRate >= 0.5 &&
    params.baseline.averageTerritoryDiff >= 0
  if (!competitive) return 'retain-current-baseline'
  const averageOk = params.timings.averageMs <= 2_700
  const p95Ok = params.timings.p95Ms <= 5_300
  const cutsOk = params.timings.timeLimitStopRate <= 0.2
  if (averageOk && p95Ok && cutsOk) return 'adopt'
  if (averageOk && cutsOk && params.timings.p95Ms <= 5_500) return 'adopt-with-documented-latency'
  return 'retain-current-baseline'
}

function persistProgress(outputDir: string, progress: FinalConfirmationProgress): void {
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(path.join(outputDir, 'progress.json'), `${JSON.stringify(progress, null, 2)}\n`)
  writeCsv(
    path.join(outputDir, 'heuristic_matches.csv'),
    progress.matches.filter((row) => row.rival === 'heuristic'),
  )
  writeCsv(
    path.join(outputDir, 'baseline_matches.csv'),
    progress.matches.filter((row) => row.rival === 'baseline'),
  )
  writeCsv(path.join(outputDir, 'decision_timings.csv'), progress.timings)
}

export function writeFinalConfirmationArtifacts(
  outputDir: string,
  progress: FinalConfirmationProgress,
) {
  const heuristic = aggregateMatches(progress.matches.filter((row) => row.rival === 'heuristic'))
  const baselineRows = progress.matches.filter((row) => row.rival === 'baseline')
  const baseline = aggregateMatches(baselineRows)
  const completedPairRows = completedBaselinePairRows(baselineRows)
  const paired = completedPairRows.length ? buildBaselinePairs(completedPairRows) : undefined
  const timings = aggregateTimings(progress.timings)
  const technicalValid =
    progress.matches.every((row) => row.terminal && !row.reachedSafetyLimit) &&
    progress.matches.length <= TOTAL_GAMES
  const classification = classifyFinalCandidate({
    heuristic,
    baseline,
    timings,
    complete: progress.complete,
    technicalValid,
  })
  const summary = {
    schema: 'HumanChallengeFinalConfirmationSummaryV1',
    complete: progress.complete,
    classification,
    durationMsAccumulated: progress.durationMsAccumulated,
    heuristic,
    baseline,
    pairedBaseline: paired?.summary,
    timings,
    criteria: {
      heuristicWinRate: heuristic.winRate >= 0.7,
      heuristicTerritory: heuristic.averageTerritoryDiff > 0,
      baselineWinRate: baseline.winRate >= 0.5,
      baselineTerritory: baseline.averageTerritoryDiff >= 0,
      averageTime: timings.averageMs <= 2_700,
      p95Time: timings.p95Ms <= 5_300,
      timeLimitStops: timings.timeLimitStopRate <= 0.2,
      technicalValid,
    },
  }
  writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeCsv(path.join(outputDir, 'paired_baseline_results.csv'), paired?.pairs ?? [])
  writeFileSync(
    path.join(outputDir, 'metadata.json'),
    `${JSON.stringify(
      {
        schema: 'HumanChallengeFinalConfirmationMetadataV1',
        evaluatorVersion: FINAL_CONFIRMATION_VERSION,
        totalPlannedGames: TOTAL_GAMES,
        maximumDecisionsSafetyLimit: FINAL_CONFIRMATION_MAX_DECISIONS,
        candidateSolverEnabled: false,
        qPriorWeight: 0,
        baselineConfig: FINAL_MCTS_CONFIG,
        reproducibility: 'Fixed plan, deterministic seeds, persisted after every game.',
        startedAt: progress.startedAt,
        updatedAt: progress.updatedAt,
      },
      null,
      2,
    )}\n`,
  )
  const report = [
    '# Confirmación final — MCTS adaptativo para experimento humano',
    '',
    `- Completa: ${progress.complete ? 'sí' : 'no'}`,
    `- Partidas: ${progress.matches.length}/${TOTAL_GAMES}`,
    `- Clasificación: **${classification}**`,
    `- Duración acumulada: ${progress.durationMsAccumulated} ms`,
    '',
    '## Contra heurística',
    '',
    `- V-D-E: ${heuristic.wins}-${heuristic.losses}-${heuristic.ties}`,
    `- Tasa de victoria: ${heuristic.winRate}`,
    `- Diferencia territorial media: ${heuristic.averageTerritoryDiff}`,
    '',
    '## Contra baseline',
    '',
    `- V-D-E: ${baseline.wins}-${baseline.losses}-${baseline.ties}`,
    `- Tasa de victoria: ${baseline.winRate}`,
    `- Diferencia territorial media: ${baseline.averageTerritoryDiff}`,
    '',
    '## Rendimiento temporal',
    '',
    `- Media: ${timings.averageMs} ms`,
    `- P95: ${timings.p95Ms} ms`,
    `- Cortes temporales: ${timings.timeLimitStops}/${timings.decisions}`,
    '',
    'La candidata no está conectada a la interfaz y el solucionador final permaneció desactivado.',
    '',
  ].join('\n')
  writeFileSync(path.join(outputDir, 'report.md'), report, 'utf8')
  return summary
}

export async function confirmFinalHumanChallengeMCTS(options: FinalConfirmationOptions = {}) {
  const plan = options.plan ?? buildFinalConfirmationPlan()
  validateFinalConfirmationPlan(plan)
  const outputDir = path.resolve(options.outputDir ?? FINAL_CONFIRMATION_OUTPUT)
  const progress = loadFinalProgress(outputDir, plan)
  const now = options.now ?? (() => performance.now())
  const runGame = options.runGame ?? runConfirmationGame
  for (const planned of plan) {
    if (progress.matches.some((row) => row.id === planned.id)) {
      options.onProgress?.(`${planned.id}: ya completada, se omite`)
      continue
    }
    if (options.shouldAbort?.()) break
    const startedAt = now()
    const result = await runGame(planned, {
      maxDecisions: options.maxDecisions ?? FINAL_CONFIRMATION_MAX_DECISIONS,
      now,
    })
    if (!result.match.terminal || result.match.reachedSafetyLimit)
      throw new Error(`Game ${planned.id} did not finish terminally`)
    progress.matches.push(result.match)
    progress.timings.push(...result.timings)
    progress.durationMsAccumulated = round(progress.durationMsAccumulated + (now() - startedAt))
    progress.updatedAt = new Date().toISOString()
    progress.complete = progress.matches.length === plan.length
    persistProgress(outputDir, progress)
    writeFinalConfirmationArtifacts(outputDir, progress)
    options.onProgress?.(
      `${progress.matches.length}/${plan.length} ${planned.id}; ` +
        `${round(progress.durationMsAccumulated / 60_000)} min acumulados`,
    )
  }
  progress.complete = progress.matches.length === plan.length
  persistProgress(outputDir, progress)
  return { progress, summary: writeFinalConfirmationArtifacts(outputDir, progress) }
}

async function main(): Promise<void> {
  let abortRequested = false
  const requestAbort = () => {
    abortRequested = true
    console.log('Interrupción solicitada; se conservará la última partida completa.')
  }
  process.once('SIGINT', requestAbort)
  process.once('SIGTERM', requestAbort)
  const result = await confirmFinalHumanChallengeMCTS({
    shouldAbort: () => abortRequested,
    onProgress: console.log,
  })
  console.log(JSON.stringify(result.summary, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
