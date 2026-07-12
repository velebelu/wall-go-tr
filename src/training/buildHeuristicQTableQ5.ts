import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import type { QTableSnapshot } from '@/agents/learningPolicy'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { getBestHeuristicAction, getBestPlacement, getLegalActions } from '@/utils/ai'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { applyActionToState, getTerritoryCounts } from './compareLearningAgents'
import type { Q5HeuristicExperienceRecord } from './generateHeuristicExperienceQ5'

export const Q5_HEURISTIC_EXPERIENCE_JSONL_PATH =
  'data/entrenamiento/q5/heuristic_experience/dataset_2000/experiences.jsonl'
export const Q5_HEURISTIC_INITIAL_QTABLE_DIR = 'data/entrenamiento/q5/heuristic_initial_qtable'
export const Q5_HEURISTIC_INITIAL_QTABLE_PATH = path.join(
  Q5_HEURISTIC_INITIAL_QTABLE_DIR,
  'qtable_q5_heuristic_initial.json',
)
export const Q5_HEURISTIC_INITIAL_EVAL_DIR =
  'data/entrenamiento/q5/evaluaciones/heuristic_initial_eval200'
export const Q5_CHECKPOINT_500_QTABLE_PATH =
  'data/entrenamiento/q5/checkpoint_500/qtable_q5_500.json'
export const Q5_CHECKPOINT_500_EVAL_DIR =
  'data/entrenamiento/q5/evaluaciones/checkpoint_500_eval200'
export const Q5_FINAL_FINETUNING_500_QTABLE_PATH =
  'data/entrenamiento/q5/final_finetuning/checkpoint_500/qtable_q5_final_finetuning_500.json'
export const Q5_FINAL_FINETUNING_500_EVAL_DIR =
  'data/entrenamiento/q5/evaluaciones/final_finetuning_500_eval200'
export const Q5_INSTRUMENTED_PILOT_100_QTABLE_PATH =
  'data/entrenamiento/q5/final_finetuning/instrumented_pilot_100/qtable_q5_instrumented_pilot_100.json'
export const Q5_INSTRUMENTED_PILOT_100_EVAL_DIR =
  'data/entrenamiento/q5/evaluaciones/instrumented_pilot_100_eval200'
export const Q5_HEURISTIC_INITIAL_EVALUATION_SEED = 502000
export const Q5_HEURISTIC_INITIAL_EVALUATION_GAMES_PER_COLOR = 100
export const Q5_HEURISTIC_INITIAL_EVALUATION_MAX_TURNS = 250

type RivalKind = 'random' | 'heuristic'
type ResultKind = 'win' | 'loss' | 'tie'

interface AggregateEntry {
  stateActionKey: string
  stateKey: string
  actionKey: string
  observations: number
  sum: number
  sumSquares: number
  min: number
  max: number
  value: number
  standardDeviation: number
  lowConfidence: boolean
  clampHits: number
  opponents: Record<RivalKind, number>
  colors: Record<Player, number>
}

interface BuildSummary {
  totalExperiencesProcessed: number
  uniqueStates: number
  uniqueStateActionPairs: number
  qValueDistribution: {
    min: number
    max: number
    mean: number
    median: number
  }
  positivePairs: number
  negativePairs: number
  zeroPairs: number
  frequencyBuckets: {
    one: number
    twoToFive: number
    sixToTwenty: number
    moreThanTwenty: number
  }
  coverageByOpponent: Record<RivalKind, number>
  coverageByColor: Record<Player, number>
  colorBias: {
    averageValueR: number
    averageValueB: number
    difference: number
  }
  clampPairPercentage: number
  illegalActionExperiences: number
  nonQ3Experiences: number
  lowConfidencePairs: number
  entries: AggregateEntry[]
}

interface BuildMetadata {
  createdAt: string
  model: 'Q5'
  artifact: 'heuristic_initial_qtable'
  sourceExperiencePath: string
  qLearningTrainingExecuted: false
  qTableCreatedFromExperiences: true
  stateRepresentation: 'Q3'
  rewardFormula: typeof Q5_HEURISTIC_INITIAL_VALUE_CONFIG
  outputFiles: {
    qTable: string
    metadata: string
    buildSummary: string
  }
  summary: Omit<BuildSummary, 'entries'>
}

interface ChoiceDiagnostics {
  selectedKeyExists: boolean
  selectedValue: number
  knownLegalActionKeys: string[]
  consultedKeys: string[]
}

interface RuntimeDiagnostics {
  decisions: number
  qHits: number
  qMisses: number
  consultedKnownQTableEntries: Set<string>
}

interface EvaluationGameResult {
  rival: RivalKind
  seed: number
  game: number
  colorQ5: Player
  winner: Player | 'tie'
  q5Won: boolean
  tie: boolean
  territoryQ5: number
  territoryRival: number
  territorialDiff: number
  turns: number
  endedByTurnLimit: boolean
  qHits: number
  qMisses: number
  qTableChangedDuringEvaluation: boolean
}

interface EvaluationRivalSummary {
  rival: RivalKind
  games: number
  wins: number
  losses: number
  ties: number
  winRate: number
  byColor: Record<
    Player,
    { games: number; wins: number; losses: number; ties: number; winRate: number }
  >
  averageTerritoryQ5: number
  averageTerritoryRival: number
  averageTerritorialDiff: number
  averageTurns: number
  endedByTurnLimit: number
  qHits: number
  qMisses: number
  qHitRate: number
  qTableUsagePercentage: number
  qTableChangedDuringEvaluation: boolean
  hashBefore: string
  hashAfter: string
}

interface EvaluationSummary {
  createdAt: string
  model: 'Q5'
  checkpoint:
    | 'heuristic_initial'
    | 'Q5-500'
    | 'Q5-final-finetuning-500'
    | 'Q5-instrumented-pilot-100'
  qTablePath: string
  qTableEntries: number
  qTableHashBefore: string
  qTableHashAfter: string
  qTableChangedDuringEvaluation: boolean
  seeds: {
    baseSeed: number
    gamesPerColor: number
    maxTurns: number
  }
  evaluationProtocol: {
    epsilon: 0
    learnsDuringEvaluation: false
    qTableFrozen: true
    alphaUpdates: false
    representation: 'Q3'
    rivals: RivalKind[]
  }
  experiments: EvaluationRivalSummary[]
}

export const Q5_HEURISTIC_INITIAL_VALUE_CONFIG = {
  resultSignal: { win: 1, loss: -1, tie: 0 },
  territorySignal: { multiplier: 0.05, min: -0.5, max: 0.5 },
  mobilitySignal: { multiplier: 0.02, min: -0.2, max: 0.2 },
  trapSignal: { newTrappedMultiplier: -0.5, releasedTrappedMultiplier: 0.3 },
  experienceValue: { min: -2, max: 2 },
} as const

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function qTableFingerprint(qTable: QTableSnapshot): string {
  return JSON.stringify(qTable)
}

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function assertOutputCanBeWritten(outputDir: string, overwrite: boolean): void {
  if (!existsSync(outputDir)) return
  if (overwrite) return
  if (readdirSync(outputDir).length > 0) {
    throw new Error(`Output directory already exists and is not empty: ${outputDir}`)
  }
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function parseExperienceJsonl(filePath: string): Q5HeuristicExperienceRecord[] {
  const content = readFileSync(path.resolve(filePath), 'utf8').trim()
  if (!content) return []
  return content.split(/\r?\n/).map((line) => JSON.parse(line) as Q5HeuristicExperienceRecord)
}

export function calculateHeuristicInitialExperienceValue(experience: {
  winner: Player | 'tie'
  heuristicColor: Player
  previousTerritoryDiff: number
  nextTerritoryDiff: number
  previousOwnMobility: number
  nextOwnMobility: number
  previousOwnTrappedPieces: number
  nextOwnTrappedPieces: number
}): { value: number; clamped: boolean } {
  const result: ResultKind =
    experience.winner === 'tie'
      ? 'tie'
      : experience.winner === experience.heuristicColor
        ? 'win'
        : 'loss'
  const resultSignal = Q5_HEURISTIC_INITIAL_VALUE_CONFIG.resultSignal[result]
  const territorySignal = clamp(
    Q5_HEURISTIC_INITIAL_VALUE_CONFIG.territorySignal.multiplier *
      (experience.nextTerritoryDiff - experience.previousTerritoryDiff),
    Q5_HEURISTIC_INITIAL_VALUE_CONFIG.territorySignal.min,
    Q5_HEURISTIC_INITIAL_VALUE_CONFIG.territorySignal.max,
  )
  const mobilitySignal = clamp(
    Q5_HEURISTIC_INITIAL_VALUE_CONFIG.mobilitySignal.multiplier *
      (experience.nextOwnMobility - experience.previousOwnMobility),
    Q5_HEURISTIC_INITIAL_VALUE_CONFIG.mobilitySignal.min,
    Q5_HEURISTIC_INITIAL_VALUE_CONFIG.mobilitySignal.max,
  )
  const newTrappedPieces = Math.max(
    0,
    experience.nextOwnTrappedPieces - experience.previousOwnTrappedPieces,
  )
  const releasedTrappedPieces = Math.max(
    0,
    experience.previousOwnTrappedPieces - experience.nextOwnTrappedPieces,
  )
  const trapSignal =
    Q5_HEURISTIC_INITIAL_VALUE_CONFIG.trapSignal.newTrappedMultiplier * newTrappedPieces +
    Q5_HEURISTIC_INITIAL_VALUE_CONFIG.trapSignal.releasedTrappedMultiplier * releasedTrappedPieces
  const raw = resultSignal + territorySignal + mobilitySignal + trapSignal
  const value = clamp(
    raw,
    Q5_HEURISTIC_INITIAL_VALUE_CONFIG.experienceValue.min,
    Q5_HEURISTIC_INITIAL_VALUE_CONFIG.experienceValue.max,
  )
  return { value, clamped: Math.abs(raw - value) > Number.EPSILON }
}

function createAggregateEntry(
  key: string,
  experience: Q5HeuristicExperienceRecord,
): AggregateEntry {
  return {
    stateActionKey: key,
    stateKey: experience.previousQ3State,
    actionKey: experience.heuristicActionQ3Key,
    observations: 0,
    sum: 0,
    sumSquares: 0,
    min: Infinity,
    max: -Infinity,
    value: 0,
    standardDeviation: 0,
    lowConfidence: true,
    clampHits: 0,
    opponents: { random: 0, heuristic: 0 },
    colors: { R: 0, B: 0 },
  }
}

function finalizeAggregateEntry(entry: AggregateEntry): AggregateEntry {
  const mean = entry.observations ? entry.sum / entry.observations : 0
  const variance = entry.observations
    ? Math.max(0, entry.sumSquares / entry.observations - mean * mean)
    : 0
  return {
    ...entry,
    value: roundMetric(mean),
    min: roundMetric(entry.min),
    max: roundMetric(entry.max),
    standardDeviation: roundMetric(Math.sqrt(variance)),
    lowConfidence: entry.observations === 1,
  }
}

function buildSummaryFromEntries(params: {
  experiences: Q5HeuristicExperienceRecord[]
  entries: AggregateEntry[]
}): BuildSummary {
  const qValues = params.entries.map((entry) => entry.value)
  const states = new Set(params.entries.map((entry) => entry.stateKey))
  const colorSums: Record<Player, { sum: number; count: number }> = {
    R: { sum: 0, count: 0 },
    B: { sum: 0, count: 0 },
  }
  for (const entry of params.entries) {
    colorSums.R.sum += entry.value * entry.colors.R
    colorSums.R.count += entry.colors.R
    colorSums.B.sum += entry.value * entry.colors.B
    colorSums.B.count += entry.colors.B
  }
  const averageR = colorSums.R.count ? colorSums.R.sum / colorSums.R.count : 0
  const averageB = colorSums.B.count ? colorSums.B.sum / colorSums.B.count : 0
  const clampPairs = params.entries.filter((entry) => entry.clampHits > 0).length

  return {
    totalExperiencesProcessed: params.experiences.length,
    uniqueStates: states.size,
    uniqueStateActionPairs: params.entries.length,
    qValueDistribution: {
      min: qValues.length ? roundMetric(Math.min(...qValues)) : 0,
      max: qValues.length ? roundMetric(Math.max(...qValues)) : 0,
      mean: qValues.length
        ? roundMetric(qValues.reduce((sum, value) => sum + value, 0) / qValues.length)
        : 0,
      median: roundMetric(median(qValues)),
    },
    positivePairs: qValues.filter((value) => value > 0).length,
    negativePairs: qValues.filter((value) => value < 0).length,
    zeroPairs: qValues.filter((value) => value === 0).length,
    frequencyBuckets: {
      one: params.entries.filter((entry) => entry.observations === 1).length,
      twoToFive: params.entries.filter(
        (entry) => entry.observations >= 2 && entry.observations <= 5,
      ).length,
      sixToTwenty: params.entries.filter(
        (entry) => entry.observations >= 6 && entry.observations <= 20,
      ).length,
      moreThanTwenty: params.entries.filter((entry) => entry.observations > 20).length,
    },
    coverageByOpponent: {
      random: params.experiences.filter((experience) => experience.opponent === 'random').length,
      heuristic: params.experiences.filter((experience) => experience.opponent === 'heuristic')
        .length,
    },
    coverageByColor: {
      R: params.experiences.filter((experience) => experience.heuristicColor === 'R').length,
      B: params.experiences.filter((experience) => experience.heuristicColor === 'B').length,
    },
    colorBias: {
      averageValueR: roundMetric(averageR),
      averageValueB: roundMetric(averageB),
      difference: roundMetric(averageR - averageB),
    },
    clampPairPercentage: params.entries.length
      ? roundMetric((clampPairs / params.entries.length) * 100)
      : 0,
    illegalActionExperiences: params.experiences.filter((experience) => !experience.actionWasLegal)
      .length,
    nonQ3Experiences: params.experiences.filter(
      (experience) =>
        !experience.previousQ3State.startsWith('q3|') || !experience.nextQ3State.startsWith('q3|'),
    ).length,
    lowConfidencePairs: params.entries.filter((entry) => entry.lowConfidence).length,
    entries: params.entries,
  }
}

export async function buildHeuristicInitialQTableQ5(
  options: {
    experiencePath?: string
    outputDir?: string
    overwrite?: boolean
  } = {},
): Promise<{ qTable: QTableSnapshot; metadata: BuildMetadata; summary: BuildSummary }> {
  const experiencePath = path.resolve(options.experiencePath ?? Q5_HEURISTIC_EXPERIENCE_JSONL_PATH)
  const outputDir = path.resolve(options.outputDir ?? Q5_HEURISTIC_INITIAL_QTABLE_DIR)
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)

  const experiences = parseExperienceJsonl(experiencePath)
  const aggregates: Record<string, AggregateEntry> = {}
  for (const experience of experiences) {
    if (!experience.actionWasLegal) continue
    if (!experience.previousQ3State.startsWith('q3|')) continue
    const key = `${experience.previousQ3State}|||${experience.heuristicActionQ3Key}`
    const aggregate = aggregates[key] ?? createAggregateEntry(key, experience)
    const result = calculateHeuristicInitialExperienceValue(experience)
    aggregate.observations++
    aggregate.sum += result.value
    aggregate.sumSquares += result.value * result.value
    aggregate.min = Math.min(aggregate.min, result.value)
    aggregate.max = Math.max(aggregate.max, result.value)
    if (result.clamped) aggregate.clampHits++
    aggregate.opponents[experience.opponent]++
    aggregate.colors[experience.heuristicColor]++
    aggregates[key] = aggregate
  }

  const entries = Object.values(aggregates)
    .map(finalizeAggregateEntry)
    .sort((left, right) => left.stateActionKey.localeCompare(right.stateActionKey))
  const qTable: QTableSnapshot = Object.fromEntries(
    entries.map((entry) => [entry.stateActionKey, entry.value]),
  )
  const summary = buildSummaryFromEntries({ experiences, entries })
  const { entries: _entries, ...metadataSummary } = summary
  const outputFiles = {
    qTable: path.join(outputDir, 'qtable_q5_heuristic_initial.json'),
    metadata: path.join(outputDir, 'metadata.json'),
    buildSummary: path.join(outputDir, 'build_summary.json'),
  }
  const metadata: BuildMetadata = {
    createdAt: new Date().toISOString(),
    model: 'Q5',
    artifact: 'heuristic_initial_qtable',
    sourceExperiencePath: experiencePath,
    qLearningTrainingExecuted: false,
    qTableCreatedFromExperiences: true,
    stateRepresentation: 'Q3',
    rewardFormula: Q5_HEURISTIC_INITIAL_VALUE_CONFIG,
    outputFiles,
    summary: metadataSummary,
  }

  mkdirSync(outputDir, { recursive: true })
  writeJson(outputFiles.qTable, qTable)
  writeJson(outputFiles.metadata, metadata)
  writeJson(outputFiles.buildSummary, summary)
  return { qTable, metadata, summary }
}

function loadQTable(qTablePath: string): QTableSnapshot {
  return JSON.parse(readFileSync(path.resolve(qTablePath), 'utf8')) as QTableSnapshot
}

function createDiagnostics(): RuntimeDiagnostics {
  return {
    decisions: 0,
    qHits: 0,
    qMisses: 0,
    consultedKnownQTableEntries: new Set<string>(),
  }
}

function mergeDiagnostics(target: RuntimeDiagnostics, source: RuntimeDiagnostics): void {
  target.decisions += source.decisions
  target.qHits += source.qHits
  target.qMisses += source.qMisses
  source.consultedKnownQTableEntries.forEach((key) => target.consultedKnownQTableEntries.add(key))
}

function withSeededMathRandom<T>(rng: () => number, fn: () => T): T {
  const previous = Math.random
  Math.random = rng
  try {
    return fn()
  } finally {
    Math.random = previous
  }
}

function chooseRandomAction(state: GameSnapshot, rng: () => number): PlayerAction {
  const legalActions = getLegalActions(state)
  if (legalActions.length === 0) throw new Error(`No legal actions for ${state.turn}`)
  return legalActions[Math.floor(rng() * legalActions.length)]!
}

function chooseHeuristicAction(state: GameSnapshot, rng: () => number): PlayerAction {
  return withSeededMathRandom(rng, () => {
    if (state.phase === 'placing') return getBestPlacement(state)
    return getBestHeuristicAction(state) ?? chooseRandomAction(state, rng)
  })
}

function inspectActionChoice(
  state: GameSnapshot,
  legalActions: PlayerAction[],
  qTable: QTableSnapshot,
  rng: () => number,
): { action: PlayerAction; diagnostics: ChoiceDiagnostics } {
  let bestValue = -Infinity
  const bestActions: PlayerAction[] = []
  const consultedKeys: string[] = []
  const knownLegalActionKeys: string[] = []
  for (const action of legalActions) {
    const key = getLearningQTableKeyQ3(state, action)
    consultedKeys.push(key)
    if (qTable[key] !== undefined) knownLegalActionKeys.push(key)
    const value = qTable[key] ?? 0
    if (value > bestValue) {
      bestValue = value
      bestActions.length = 0
      bestActions.push(action)
    } else if (value === bestValue) {
      bestActions.push(action)
    }
  }
  const action = bestActions[Math.floor(rng() * bestActions.length)]!
  const selectedKey = getLearningQTableKeyQ3(state, action)
  return {
    action,
    diagnostics: {
      selectedKeyExists: qTable[selectedKey] !== undefined,
      selectedValue: qTable[selectedKey] ?? 0,
      knownLegalActionKeys,
      consultedKeys,
    },
  }
}

function recordChoiceDiagnostics(
  diagnostics: RuntimeDiagnostics,
  choice: ChoiceDiagnostics,
  qTable: QTableSnapshot,
): void {
  diagnostics.decisions++
  if (choice.selectedKeyExists) diagnostics.qHits++
  else diagnostics.qMisses++
  for (const key of choice.consultedKeys) {
    if (qTable[key] !== undefined) diagnostics.consultedKnownQTableEntries.add(key)
  }
}

function applyFullAction(
  state: GameSnapshot,
  action: PlayerAction,
): { state: GameSnapshot; turns: number } {
  let nextState = applyActionToState(state, action)
  let turns = 1
  if (action.followUp && nextState.phase !== 'finished') {
    nextState = applyActionToState(nextState, action.followUp)
    turns += 1
  }
  return { state: nextState, turns }
}

function finalizeIfNeeded(state: GameSnapshot): GameSnapshot {
  if (state.phase === 'finished' || state.result) return state
  const territory = getTerritoryCounts(state.board)
  return {
    ...state,
    phase: 'finished',
    result:
      territory.R === territory.B
        ? { finished: true, tie: true, score: territory }
        : { finished: true, winner: territory.R > territory.B ? 'R' : 'B', score: territory },
  }
}

async function runSingleEvaluationGame(params: {
  rival: RivalKind
  game: number
  seed: number
  q5Color: Player
  qTable: QTableSnapshot
  qTablePath: string
  initialFileHash: string
  initialFingerprint: string
  maxTurns: number
}): Promise<{ result: EvaluationGameResult; diagnostics: RuntimeDiagnostics }> {
  const rng = createSeededRng(params.seed)
  const diagnostics = createDiagnostics()
  let state = makeInitialState()
  let turns = 0

  while (state.phase !== 'finished' && !state.result && turns < params.maxTurns) {
    const previousState = snapshotFromState(state)
    let action: PlayerAction
    if (previousState.turn === params.q5Color) {
      const choice = inspectActionChoice(
        previousState,
        getLegalActions(previousState),
        params.qTable,
        rng,
      )
      action = choice.action
      recordChoiceDiagnostics(diagnostics, choice.diagnostics, params.qTable)
    } else if (params.rival === 'random') {
      action = chooseRandomAction(previousState, rng)
    } else {
      action = chooseHeuristicAction(previousState, rng)
    }
    const applied = applyFullAction(state, action)
    state = applied.state
    turns += applied.turns
  }

  const endedByTurnLimit = state.phase !== 'finished' && !state.result
  state = finalizeIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')
  const rivalColor = getOpponent(params.q5Color)
  const qTableChangedDuringEvaluation =
    hashFile(params.qTablePath) !== params.initialFileHash ||
    qTableFingerprint(params.qTable) !== params.initialFingerprint

  return {
    result: {
      rival: params.rival,
      seed: params.seed,
      game: params.game,
      colorQ5: params.q5Color,
      winner,
      q5Won: winner === params.q5Color,
      tie: winner === 'tie',
      territoryQ5: territory[params.q5Color],
      territoryRival: territory[rivalColor],
      territorialDiff: territory[params.q5Color] - territory[rivalColor],
      turns,
      endedByTurnLimit,
      qHits: diagnostics.qHits,
      qMisses: diagnostics.qMisses,
      qTableChangedDuringEvaluation,
    },
    diagnostics,
  }
}

function summarizeEvaluationRival(
  rival: RivalKind,
  results: EvaluationGameResult[],
  diagnostics: RuntimeDiagnostics,
  qTableEntries: number,
  hashBefore: string,
  hashAfter: string,
): EvaluationRivalSummary {
  const wins = results.filter((result) => result.q5Won).length
  const ties = results.filter((result) => result.tie).length
  const losses = results.length - wins - ties
  const byColor = Object.fromEntries(
    (['R', 'B'] as const).map((color) => {
      const colorResults = results.filter((result) => result.colorQ5 === color)
      const colorWins = colorResults.filter((result) => result.q5Won).length
      const colorTies = colorResults.filter((result) => result.tie).length
      const colorLosses = colorResults.length - colorWins - colorTies
      return [
        color,
        {
          games: colorResults.length,
          wins: colorWins,
          losses: colorLosses,
          ties: colorTies,
          winRate: colorResults.length ? roundMetric((colorWins / colorResults.length) * 100) : 0,
        },
      ]
    }),
  ) as EvaluationRivalSummary['byColor']
  const qTotal = diagnostics.qHits + diagnostics.qMisses
  return {
    rival,
    games: results.length,
    wins,
    losses,
    ties,
    winRate: roundMetric((wins / results.length) * 100),
    byColor,
    averageTerritoryQ5: roundMetric(
      results.reduce((sum, result) => sum + result.territoryQ5, 0) / results.length,
    ),
    averageTerritoryRival: roundMetric(
      results.reduce((sum, result) => sum + result.territoryRival, 0) / results.length,
    ),
    averageTerritorialDiff: roundMetric(
      results.reduce((sum, result) => sum + result.territorialDiff, 0) / results.length,
    ),
    averageTurns: roundMetric(
      results.reduce((sum, result) => sum + result.turns, 0) / results.length,
    ),
    endedByTurnLimit: results.filter((result) => result.endedByTurnLimit).length,
    qHits: diagnostics.qHits,
    qMisses: diagnostics.qMisses,
    qHitRate: qTotal ? roundMetric((diagnostics.qHits / qTotal) * 100) : 0,
    qTableUsagePercentage: qTableEntries
      ? roundMetric((diagnostics.consultedKnownQTableEntries.size / qTableEntries) * 100)
      : 0,
    qTableChangedDuringEvaluation:
      results.some((result) => result.qTableChangedDuringEvaluation) || hashBefore !== hashAfter,
    hashBefore,
    hashAfter,
  }
}

function csvEscape(value: string | number | boolean): string {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function evaluationResultsToCsv(results: EvaluationGameResult[]): string {
  const headers = [
    'rival',
    'seed',
    'game',
    'colorQ5',
    'winner',
    'territoryQ5',
    'territoryRival',
    'territorialDiff',
    'turns',
    'qHits',
    'qMisses',
    'qTableChangedDuringEvaluation',
  ]
  const rows = results.map((result) => [
    result.rival,
    result.seed,
    result.game,
    result.colorQ5,
    result.winner,
    result.territoryQ5,
    result.territoryRival,
    result.territorialDiff,
    result.turns,
    result.qHits,
    result.qMisses,
    result.qTableChangedDuringEvaluation,
  ])
  return [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n')
}

export async function evaluateHeuristicInitialQTableQ5(
  options: {
    qTablePath?: string
    outputDir?: string
    checkpoint?:
      | 'heuristic_initial'
      | 'Q5-500'
      | 'Q5-final-finetuning-500'
      | 'Q5-instrumented-pilot-100'
    seed?: number
    gamesPerColor?: number
    maxTurns?: number
    overwrite?: boolean
  } = {},
): Promise<{ summary: EvaluationSummary; results: EvaluationGameResult[]; outputDir: string }> {
  const qTablePath = path.resolve(options.qTablePath ?? Q5_HEURISTIC_INITIAL_QTABLE_PATH)
  const outputDir = path.resolve(options.outputDir ?? Q5_HEURISTIC_INITIAL_EVAL_DIR)
  const seed = options.seed ?? Q5_HEURISTIC_INITIAL_EVALUATION_SEED
  const gamesPerColor = options.gamesPerColor ?? Q5_HEURISTIC_INITIAL_EVALUATION_GAMES_PER_COLOR
  const maxTurns = options.maxTurns ?? Q5_HEURISTIC_INITIAL_EVALUATION_MAX_TURNS
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)

  const qTable = Object.freeze({ ...loadQTable(qTablePath) }) as QTableSnapshot
  const qTableEntries = Object.keys(qTable).length
  const hashBefore = hashFile(qTablePath)
  const fingerprintBefore = qTableFingerprint(qTable)
  const allResults: EvaluationGameResult[] = []
  const experiments: EvaluationRivalSummary[] = []
  let globalGame = 0

  for (const rival of ['random', 'heuristic'] as const) {
    const rivalDiagnostics = createDiagnostics()
    const rivalResults: EvaluationGameResult[] = []
    const rivalHashBefore = hashFile(qTablePath)
    for (const colorQ5 of ['R', 'B'] as const) {
      for (let game = 1; game <= gamesPerColor; game++) {
        globalGame++
        const result = await runSingleEvaluationGame({
          rival,
          game,
          seed: seed + globalGame,
          q5Color: colorQ5,
          qTable,
          qTablePath,
          initialFileHash: hashBefore,
          initialFingerprint: fingerprintBefore,
          maxTurns,
        })
        mergeDiagnostics(rivalDiagnostics, result.diagnostics)
        rivalResults.push(result.result)
        allResults.push(result.result)
        if (result.result.qTableChangedDuringEvaluation) {
          throw new Error('Q5 heuristic initial qTable changed during evaluation')
        }
      }
    }
    const rivalHashAfter = hashFile(qTablePath)
    experiments.push(
      summarizeEvaluationRival(
        rival,
        rivalResults,
        rivalDiagnostics,
        qTableEntries,
        rivalHashBefore,
        rivalHashAfter,
      ),
    )
  }

  const hashAfter = hashFile(qTablePath)
  const summary: EvaluationSummary = {
    createdAt: new Date().toISOString(),
    model: 'Q5',
    checkpoint: options.checkpoint ?? 'heuristic_initial',
    qTablePath,
    qTableEntries,
    qTableHashBefore: hashBefore,
    qTableHashAfter: hashAfter,
    qTableChangedDuringEvaluation:
      hashBefore !== hashAfter || qTableFingerprint(qTable) !== fingerprintBefore,
    seeds: { baseSeed: seed, gamesPerColor, maxTurns },
    evaluationProtocol: {
      epsilon: 0,
      learnsDuringEvaluation: false,
      qTableFrozen: true,
      alphaUpdates: false,
      representation: 'Q3',
      rivals: ['random', 'heuristic'],
    },
    experiments,
  }
  if (summary.qTableChangedDuringEvaluation) {
    throw new Error('Q5 qTable changed during evaluation')
  }

  mkdirSync(outputDir, { recursive: true })
  writeJson(path.join(outputDir, 'learning_comparison_summary.json'), summary)
  writeFileSync(
    path.join(outputDir, 'learning_comparison_results.csv'),
    `${evaluationResultsToCsv(allResults)}\n`,
    'utf8',
  )
  writeJson(path.join(outputDir, 'evaluation_metadata.json'), {
    createdAt: summary.createdAt,
    qTablePath,
    qTableEntries,
    hashBefore,
    hashAfter,
    outputDir,
    protocol: {
      rivals: ['random', 'heuristic'],
      gamesPerRival: gamesPerColor * 2,
      gamesPerColor,
      totalGames: allResults.length,
      epsilon: 0,
      learnsDuringEvaluation: false,
      alphaUpdates: false,
      qTableFrozen: true,
    },
  })
  return { summary, results: allResults, outputDir }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'build'
  if (command === 'build') {
    const result = await buildHeuristicInitialQTableQ5({ overwrite: true })
    console.log(`[buildHeuristicQTableQ5] experiences: ${result.summary.totalExperiencesProcessed}`)
    console.log(`[buildHeuristicQTableQ5] entries: ${Object.keys(result.qTable).length}`)
    console.log(`[buildHeuristicQTableQ5] output: ${result.metadata.outputFiles.qTable}`)
    return
  }
  if (command === 'evaluate-initial') {
    const result = await evaluateHeuristicInitialQTableQ5()
    console.log(`[buildHeuristicQTableQ5] evaluation games: ${result.results.length}`)
    console.log(
      `[buildHeuristicQTableQ5] qTable changed: ${result.summary.qTableChangedDuringEvaluation}`,
    )
    console.log(`[buildHeuristicQTableQ5] output: ${result.outputDir}`)
    return
  }
  if (command === 'evaluate-500') {
    const result = await evaluateHeuristicInitialQTableQ5({
      qTablePath: Q5_CHECKPOINT_500_QTABLE_PATH,
      outputDir: Q5_CHECKPOINT_500_EVAL_DIR,
      checkpoint: 'Q5-500',
    })
    console.log(`[buildHeuristicQTableQ5] evaluation games: ${result.results.length}`)
    console.log(
      `[buildHeuristicQTableQ5] qTable changed: ${result.summary.qTableChangedDuringEvaluation}`,
    )
    console.log(`[buildHeuristicQTableQ5] output: ${result.outputDir}`)
    return
  }
  if (command === 'evaluate-final-finetuning-500') {
    const result = await evaluateHeuristicInitialQTableQ5({
      qTablePath: Q5_FINAL_FINETUNING_500_QTABLE_PATH,
      outputDir: Q5_FINAL_FINETUNING_500_EVAL_DIR,
      checkpoint: 'Q5-final-finetuning-500',
    })
    console.log(`[buildHeuristicQTableQ5] evaluation games: ${result.results.length}`)
    console.log(
      `[buildHeuristicQTableQ5] qTable changed: ${result.summary.qTableChangedDuringEvaluation}`,
    )
    console.log(`[buildHeuristicQTableQ5] output: ${result.outputDir}`)
    return
  }
  if (command === 'evaluate-instrumented-pilot-100') {
    const result = await evaluateHeuristicInitialQTableQ5({
      qTablePath: Q5_INSTRUMENTED_PILOT_100_QTABLE_PATH,
      outputDir: Q5_INSTRUMENTED_PILOT_100_EVAL_DIR,
      checkpoint: 'Q5-instrumented-pilot-100',
    })
    console.log(`[buildHeuristicQTableQ5] evaluation games: ${result.results.length}`)
    console.log(
      `[buildHeuristicQTableQ5] qTable changed: ${result.summary.qTableChangedDuringEvaluation}`,
    )
    console.log(`[buildHeuristicQTableQ5] output: ${result.outputDir}`)
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
