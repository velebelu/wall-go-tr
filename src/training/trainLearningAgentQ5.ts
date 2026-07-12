import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import type { QTableSnapshot } from '@/agents/learningPolicy'
import { calculatePlayerMobilityQ3, getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import * as ai from '@/utils/ai'
import { applyActionToState, getTerritoryCounts } from './compareLearningAgents'
import {
  DEFAULT_Q4_TRAINING_CONFIG,
  buildBalancedQ4Schedule,
  chooseHeuristicOpponentActionQ4,
  chooseLearningActionQ4,
  chooseRandomActionWithRngQ4,
  createSeededRngQ4,
  updateQValueQ4,
  type Q4OpponentKind,
} from './trainLearningAgentQ4'

export const Q5_BASE_DIR = 'data/entrenamiento/q5'
export const Q5_PILOT_40_DIR = path.join(Q5_BASE_DIR, 'pilot_40')
export const Q5_CHECKPOINT_500_DIR = path.join(Q5_BASE_DIR, 'checkpoint_500')
export const Q5_FINAL_FINETUNING_500_DIR = path.join(Q5_BASE_DIR, 'final_finetuning/checkpoint_500')
export const Q5_INSTRUMENTED_PILOT_100_DIR = path.join(
  Q5_BASE_DIR,
  'final_finetuning/instrumented_pilot_100',
)
export const Q5_HEURISTIC_INITIAL_QTABLE_PATH = path.join(
  Q5_BASE_DIR,
  'heuristic_initial_qtable/qtable_q5_heuristic_initial.json',
)
export const Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH = path.join(
  Q5_BASE_DIR,
  'heuristic_initial_qtable/build_summary.json',
)

export type Q5OpponentKind = Q4OpponentKind

export interface Q5TrainingScheduleItem {
  game: number
  opponent: Q5OpponentKind
  learningColor: Player
}

export interface Q5TrainingConfig {
  totalGames: number
  checkpoint: 'pilot_40' | 500 | 'final_finetuning_500' | 'instrumented_pilot_100'
  seed: number
  outputDir: string
  alpha: number
  gamma: number
  epsilonStart: number
  epsilonMin: number
  epsilonDecay: number
  maxTurns: number
  progressEvery: number
  overwrite: boolean
  initialQTablePath?: string
  initialQTableBuildSummaryPath?: string
  schedule?: Q5TrainingScheduleItem[]
  instrumentedUpdates?: boolean
}

export const Q5_REWARD_CONFIG = {
  intermediate: {
    territoryMultiplier: 0.02,
    territoryMin: -0.06,
    territoryMax: 0.06,
    mobilityMultiplier: 0.003,
    mobilityMin: -0.02,
    mobilityMax: 0.02,
    trapMultiplier: -0.04,
    trapMin: -0.06,
    trapMax: 0.06,
    lowMobilityMultiplier: -0.015,
    lowMobilityMin: -0.03,
    lowMobilityMax: 0.03,
    totalMin: -0.1,
    totalMax: 0.1,
  },
  final: {
    win: 100,
    loss: -100,
    tie: -5,
    territoryDiffMultiplier: 0.5,
    territoryDiffMin: -20,
    territoryDiffMax: 20,
  },
} as const

export const DEFAULT_Q5_TRAINING_CONFIG: Q5TrainingConfig = {
  totalGames: 40,
  checkpoint: 'pilot_40',
  seed: 3,
  outputDir: Q5_PILOT_40_DIR,
  alpha: DEFAULT_Q4_TRAINING_CONFIG.alpha,
  gamma: DEFAULT_Q4_TRAINING_CONFIG.gamma,
  epsilonStart: DEFAULT_Q4_TRAINING_CONFIG.epsilonStart,
  epsilonMin: DEFAULT_Q4_TRAINING_CONFIG.epsilonMin,
  epsilonDecay: DEFAULT_Q4_TRAINING_CONFIG.epsilonDecay,
  maxTurns: DEFAULT_Q4_TRAINING_CONFIG.maxTurns,
  progressEvery: DEFAULT_Q4_TRAINING_CONFIG.progressEvery,
  overwrite: false,
}

interface PendingTransition {
  state: GameSnapshot
  action: PlayerAction
}

interface ResultStats {
  games: number
  wins: number
  losses: number
  ties: number
}

interface HitMissStats {
  qHits: number
  qMisses: number
  qHitRate: number
}

export interface Q5IntermediateRewardBreakdown {
  deltaTerritoryDiff: number
  deltaOwnMobility: number
  deltaOwnTrappedPieces: number
  deltaOwnLowMobilityPieces: number
  territorySignal: number
  mobilitySignal: number
  trapSignal: number
  lowMobilitySignal: number
  intermediateReward: number
  clamps: {
    territory: boolean
    mobility: boolean
    trap: boolean
    lowMobility: boolean
    total: boolean
  }
}

export interface Q5FinalRewardBreakdown {
  result: 'win' | 'loss' | 'tie'
  finalTerritoryDiff: number
  base: number
  territoryFinal: number
  finalReward: number
  territoryClamp: boolean
}

interface Q5RewardLog {
  game: number
  territoryReward: number
  mobilityReward: number
  trappedReward: number
  lowMobilityReward: number
  intermediateReward: number
  finalReward: number
  totalReward: number
  minIntermediateReward: number
  maxIntermediateReward: number
  territoryClampCount: number
  mobilityClampCount: number
  trapClampCount: number
  lowMobilityClampCount: number
  totalClampCount: number
  finalTerritoryClamp: boolean
  trappedPiecesCreated: number
  trappedPiecesFreed: number
}

interface Q5GameRecord {
  game: number
  opponent: Q5OpponentKind
  learningColor: Player
  opponentColor: Player
  winner: Player | 'tie'
  resultForQ5: 'win' | 'loss' | 'tie'
  territoryQ5: number
  territoryOpponent: number
  territoryDiff: number
  turns: number
  qHits: number
  qMisses: number
  epsilonInitial: number
  epsilonFinal: number
  qTableEntriesBefore: number
  qTableEntriesAfter: number
  reward: Q5RewardLog
}

type Q5ConfidenceBucket = '1 observation' | '2-5 observations' | '6-20 observations' | 'more than 20' | 'new'

interface Q5StateActionConfidence {
  observations: number
  confidence: Q5ConfidenceBucket
  alpha: number
}

interface Q5UpdateLogEntry {
  game: number
  state: string
  action: string
  stateActionKey: string
  oldQ: number
  reward: number
  maxNextQ: number
  target: number
  rawDelta: number
  appliedDelta: number
  newQ: number
  alpha: number
  inheritedFrequency: number
  confidence: Q5ConfidenceBucket
  opponent: Q5OpponentKind
  color: Player
  turn: number
  terminal: boolean
  rewardComponent: 'intermediate' | 'final'
}

interface Q5InstrumentedUpdateSummary {
  totalUpdates: number
  alphaDistribution: Record<string, number>
  clampCount: number
  maxAbsAppliedDelta: number
  invalidValueCount: number
  changesByConfidence: Record<
    Q5ConfidenceBucket,
    {
      updates: number
      meanAbsAppliedDelta: number
      maxAbsAppliedDelta: number
      clampedUpdates: number
    }
  >
}

interface RewardSummary {
  averageTotalReward: number
  averageTerritoryReward: number
  averageMobilityReward: number
  averageTrappedReward: number
  averageLowMobilityReward: number
  averageIntermediateReward: number
  averageFinalReward: number
  minTotalReward: number
  maxTotalReward: number
  minIntermediateReward: number
  maxIntermediateReward: number
  clampCounts: {
    territory: number
    mobility: number
    trap: number
    lowMobility: number
    total: number
    finalTerritory: number
  }
  trappedPiecesCreated: number
  trappedPiecesFreed: number
}

interface Q5TrainingSummary {
  gamesByOpponent: Record<Q5OpponentKind, number>
  gamesByColor: Record<Player, number>
  gamesByCombination: Record<string, number>
  results: ResultStats
  resultsByOpponent: Record<Q5OpponentKind, ResultStats>
  resultsByColor: Record<Player, ResultStats>
  resultsByCombination: Record<string, ResultStats>
  qTotal: HitMissStats
  qByOpponent: Record<Q5OpponentKind, HitMissStats>
  qByColor: Record<Player, HitMissStats>
  averageTerritory: {
    q5: number
    opponent: number
  }
  averageTerritoryDiff: number
  averageTurns: number
  epsilonInitial: number
  epsilonFinal: number
  initialQTableEntries: number
  finalQTableEntries: number
  tableGrowth: number
  uniqueQ3StatesVisited: number
  rewards: RewardSummary
}

export interface Q5TrainingMetadata {
  model: 'Q5'
  seed: number
  totalGames: number
  checkpoint: 'pilot_40' | 500 | 'final_finetuning_500' | 'instrumented_pilot_100'
  startedFromEmptyQTable: boolean
  initialization: 'empty' | 'heuristic_initial'
  sourceQTable?: {
    path: string
    entries: number
  }
  initialQTableEntries: number
  newTrainingGames?: number
  stateRepresentation: 'Q3'
  policyModel: 'Q3/Q4'
  baselineExperiment: 'Q4'
  onlyExperimentalChange: 'reward'
  rewardModel: 'Q5'
  rewardConfiguration: typeof Q5_REWARD_CONFIG
  hyperparameters: {
    alpha: number
    gamma: number
    epsilonStart: number
    epsilonMin: number
    epsilonDecay: number
    maxTurns: number
  }
  targetDistribution: {
    opponents: Record<Q5OpponentKind, number>
    colors: Record<Player, number>
    combinations: Record<string, number>
  }
  heuristicPolicy: {
    placement: 'getBestPlacement'
    playing: 'getBestHeuristicAction'
    policy: 'default'
  }
  schedule: Q5TrainingScheduleItem[]
  games: Q5GameRecord[]
  rewardLog: Q5RewardLog[]
  summary: Q5TrainingSummary
  qTableDelta?: {
    modifiedExistingValues: number
    addedStateActionPairs: number
    unchangedExistingValues: number
    inheritedAbsoluteChangeMean: number
    inheritedAbsoluteChangeMax: number
  }
  instrumentedUpdates?: {
    enabled: boolean
    deltaClamp: { min: number; max: number }
    learningRateByConfidence: Record<Q5ConfidenceBucket, number>
    updateSummary: Q5InstrumentedUpdateSummary
  }
  createdAt: string
  durationMs: number
  outputFiles: {
    qTable: string
    metadata: string
    trainingSummary: string
    rewardLog: string
    qUpdateLog?: string
  }
}

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function wasClamped(raw: number, clamped: number): boolean {
  return Math.abs(raw - clamped) > Number.EPSILON
}

export function buildBalancedQ5Schedule(
  totalGames: number,
  seed: number,
): Q5TrainingScheduleItem[] {
  return buildBalancedQ4Schedule(totalGames, seed).map((item) => ({ ...item }))
}

export function buildQ5Checkpoint500Schedule(): Q5TrainingScheduleItem[] {
  const block = [
    ['random', 'R'],
    ['heuristic', 'R'],
    ['random', 'B'],
    ['random', 'R'],
    ['random', 'B'],
    ['heuristic', 'B'],
    ['random', 'R'],
    ['random', 'B'],
    ['random', 'R'],
    ['heuristic', 'R'],
    ['random', 'B'],
    ['random', 'R'],
    ['heuristic', 'B'],
    ['random', 'B'],
    ['random', 'R'],
    ['random', 'B'],
    ['heuristic', 'R'],
    ['random', 'R'],
    ['heuristic', 'B'],
    ['random', 'B'],
  ] satisfies Array<[Q5OpponentKind, Player]>
  const schedule: Q5TrainingScheduleItem[] = []
  for (let cycle = 0; cycle < 25; cycle++) {
    for (const [opponent, learningColor] of block) {
      schedule.push({ game: schedule.length + 1, opponent, learningColor })
    }
  }
  return schedule
}

export function buildQ5FinalFineTuning500Schedule(): Q5TrainingScheduleItem[] {
  const block = [
    ['random', 'R'],
    ['heuristic', 'B'],
    ['random', 'B'],
    ['heuristic', 'R'],
  ] satisfies Array<[Q5OpponentKind, Player]>
  const schedule: Q5TrainingScheduleItem[] = []
  for (let cycle = 0; cycle < 125; cycle++) {
    for (const [opponent, learningColor] of block) {
      schedule.push({ game: schedule.length + 1, opponent, learningColor })
    }
  }
  return schedule
}

export function buildQ5InstrumentedPilot100Schedule(): Q5TrainingScheduleItem[] {
  return buildQ5FinalFineTuning500Schedule()
    .slice(0, 100)
    .map((item, index) => ({ ...item, game: index + 1 }))
}

function loadQTable(qTablePath: string): QTableSnapshot {
  return JSON.parse(readFileSync(path.resolve(qTablePath), 'utf8')) as QTableSnapshot
}

function confidenceFromObservations(observations: number): Q5ConfidenceBucket {
  if (observations <= 0) return 'new'
  if (observations === 1) return '1 observation'
  if (observations <= 5) return '2-5 observations'
  if (observations <= 20) return '6-20 observations'
  return 'more than 20'
}

export const Q5_ALPHA_BY_CONFIDENCE: Record<Q5ConfidenceBucket, number> = {
  '1 observation': 0.03,
  '2-5 observations': 0.02,
  '6-20 observations': 0.01,
  'more than 20': 0.005,
  new: 0.03,
}

function loadQ5ConfidenceMap(buildSummaryPath?: string): Map<string, Q5StateActionConfidence> {
  if (!buildSummaryPath) return new Map()
  const summary = JSON.parse(readFileSync(path.resolve(buildSummaryPath), 'utf8')) as {
    entries?: Array<{ stateActionKey: string; observations: number }>
  }
  const confidenceMap = new Map<string, Q5StateActionConfidence>()
  for (const entry of summary.entries ?? []) {
    const confidence = confidenceFromObservations(entry.observations)
    confidenceMap.set(entry.stateActionKey, {
      observations: entry.observations,
      confidence,
      alpha: Q5_ALPHA_BY_CONFIDENCE[confidence],
    })
  }
  return confidenceMap
}

function cloneQTable(qTable: QTableSnapshot): QTableSnapshot {
  return { ...qTable }
}

function buildTargetDistributionFromSchedule(
  schedule: Q5TrainingScheduleItem[],
): Q5TrainingMetadata['targetDistribution'] {
  const distribution: Q5TrainingMetadata['targetDistribution'] = {
    opponents: { random: 0, heuristic: 0 },
    colors: { R: 0, B: 0 },
    combinations: { random_R: 0, random_B: 0, heuristic_R: 0, heuristic_B: 0 },
  }
  for (const item of schedule) {
    distribution.opponents[item.opponent]++
    distribution.colors[item.learningColor]++
    distribution.combinations[combinationKey(item.opponent, item.learningColor)]++
  }
  return distribution
}

function calculateQTableDelta(initial: QTableSnapshot, final: QTableSnapshot) {
  let modifiedExistingValues = 0
  let unchangedExistingValues = 0
  let addedStateActionPairs = 0
  let inheritedAbsoluteChangeTotal = 0
  let inheritedAbsoluteChangeMax = 0
  let inheritedEntries = 0
  for (const [key, value] of Object.entries(final)) {
    if (initial[key] === undefined) addedStateActionPairs++
    else {
      inheritedEntries++
      const absoluteChange = Math.abs(value - initial[key])
      inheritedAbsoluteChangeTotal += absoluteChange
      inheritedAbsoluteChangeMax = Math.max(inheritedAbsoluteChangeMax, absoluteChange)
      if (initial[key] === value) unchangedExistingValues++
      else modifiedExistingValues++
    }
  }
  return {
    modifiedExistingValues,
    addedStateActionPairs,
    unchangedExistingValues,
    inheritedAbsoluteChangeMean: inheritedEntries
      ? roundMetric(inheritedAbsoluteChangeTotal / inheritedEntries)
      : 0,
    inheritedAbsoluteChangeMax: roundMetric(inheritedAbsoluteChangeMax),
  }
}

export function calculateIntermediateRewardQ5FromMetrics(params: {
  deltaTerritoryDiff: number
  deltaOwnMobility: number
  deltaOwnTrappedPieces: number
  deltaOwnLowMobilityPieces: number
}): Q5IntermediateRewardBreakdown {
  const config = Q5_REWARD_CONFIG.intermediate
  const rawTerritory = config.territoryMultiplier * params.deltaTerritoryDiff
  const territorySignal = clamp(rawTerritory, config.territoryMin, config.territoryMax)
  const rawMobility = config.mobilityMultiplier * params.deltaOwnMobility
  const mobilitySignal = clamp(rawMobility, config.mobilityMin, config.mobilityMax)
  const rawTrap = config.trapMultiplier * params.deltaOwnTrappedPieces
  const trapSignal = clamp(rawTrap, config.trapMin, config.trapMax)
  const rawLowMobility = config.lowMobilityMultiplier * params.deltaOwnLowMobilityPieces
  const lowMobilitySignal = clamp(rawLowMobility, config.lowMobilityMin, config.lowMobilityMax)
  const rawTotal = territorySignal + mobilitySignal + trapSignal + lowMobilitySignal
  const intermediateReward = clamp(rawTotal, config.totalMin, config.totalMax)

  return {
    ...params,
    territorySignal,
    mobilitySignal,
    trapSignal,
    lowMobilitySignal,
    intermediateReward,
    clamps: {
      territory: wasClamped(rawTerritory, territorySignal),
      mobility: wasClamped(rawMobility, mobilitySignal),
      trap: wasClamped(rawTrap, trapSignal),
      lowMobility: wasClamped(rawLowMobility, lowMobilitySignal),
      total: wasClamped(rawTotal, intermediateReward),
    },
  }
}

export function calculateIntermediateRewardQ5(
  prevState: GameSnapshot,
  nextState: GameSnapshot,
  learningSide: Player,
): Q5IntermediateRewardBreakdown {
  const opponentSide = getOpponent(learningSide)
  const prevTerritory = getTerritoryCounts(prevState.board)
  const nextTerritory = getTerritoryCounts(nextState.board)
  const prevTerritoryDiff = prevTerritory[learningSide] - prevTerritory[opponentSide]
  const nextTerritoryDiff = nextTerritory[learningSide] - nextTerritory[opponentSide]
  const prevMobility = calculatePlayerMobilityQ3(prevState, learningSide)
  const nextMobility = calculatePlayerMobilityQ3(nextState, learningSide)

  return calculateIntermediateRewardQ5FromMetrics({
    deltaTerritoryDiff: nextTerritoryDiff - prevTerritoryDiff,
    deltaOwnMobility: nextMobility.totalDestinations - prevMobility.totalDestinations,
    deltaOwnTrappedPieces: nextMobility.trapPieces - prevMobility.trapPieces,
    deltaOwnLowMobilityPieces: nextMobility.lowPieces - prevMobility.lowPieces,
  })
}

export function calculateFinalRewardQ5(
  winner: Player | 'tie',
  territory: Record<Player, number>,
  learningSide: Player,
): Q5FinalRewardBreakdown {
  const opponentSide = getOpponent(learningSide)
  const result = winner === 'tie' ? 'tie' : winner === learningSide ? 'win' : 'loss'
  const base =
    result === 'win'
      ? Q5_REWARD_CONFIG.final.win
      : result === 'loss'
        ? Q5_REWARD_CONFIG.final.loss
        : Q5_REWARD_CONFIG.final.tie
  const finalTerritoryDiff = territory[learningSide] - territory[opponentSide]
  const rawTerritoryFinal = Q5_REWARD_CONFIG.final.territoryDiffMultiplier * finalTerritoryDiff
  const territoryFinal = clamp(
    rawTerritoryFinal,
    Q5_REWARD_CONFIG.final.territoryDiffMin,
    Q5_REWARD_CONFIG.final.territoryDiffMax,
  )

  return {
    result,
    finalTerritoryDiff,
    base,
    territoryFinal,
    finalReward: base + territoryFinal,
    territoryClamp: wasClamped(rawTerritoryFinal, territoryFinal),
  }
}

function finalizeGameIfNeeded(state: GameSnapshot): GameSnapshot {
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

function applyFullActionQ5(
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

function createRewardLog(game: number): Q5RewardLog {
  return {
    game,
    territoryReward: 0,
    mobilityReward: 0,
    trappedReward: 0,
    lowMobilityReward: 0,
    intermediateReward: 0,
    finalReward: 0,
    totalReward: 0,
    minIntermediateReward: Infinity,
    maxIntermediateReward: -Infinity,
    territoryClampCount: 0,
    mobilityClampCount: 0,
    trapClampCount: 0,
    lowMobilityClampCount: 0,
    totalClampCount: 0,
    finalTerritoryClamp: false,
    trappedPiecesCreated: 0,
    trappedPiecesFreed: 0,
  }
}

function addIntermediateReward(log: Q5RewardLog, reward: Q5IntermediateRewardBreakdown): void {
  log.territoryReward += reward.territorySignal
  log.mobilityReward += reward.mobilitySignal
  log.trappedReward += reward.trapSignal
  log.lowMobilityReward += reward.lowMobilitySignal
  log.intermediateReward += reward.intermediateReward
  log.totalReward += reward.intermediateReward
  log.minIntermediateReward = Math.min(log.minIntermediateReward, reward.intermediateReward)
  log.maxIntermediateReward = Math.max(log.maxIntermediateReward, reward.intermediateReward)
  if (reward.clamps.territory) log.territoryClampCount++
  if (reward.clamps.mobility) log.mobilityClampCount++
  if (reward.clamps.trap) log.trapClampCount++
  if (reward.clamps.lowMobility) log.lowMobilityClampCount++
  if (reward.clamps.total) log.totalClampCount++
  if (reward.deltaOwnTrappedPieces > 0) log.trappedPiecesCreated += reward.deltaOwnTrappedPieces
  if (reward.deltaOwnTrappedPieces < 0) log.trappedPiecesFreed += -reward.deltaOwnTrappedPieces
}

function finalizeRewardLog(log: Q5RewardLog, finalReward: Q5FinalRewardBreakdown): Q5RewardLog {
  log.finalReward = finalReward.finalReward
  log.totalReward += finalReward.finalReward
  log.finalTerritoryClamp = finalReward.territoryClamp
  if (!Number.isFinite(log.minIntermediateReward)) log.minIntermediateReward = 0
  if (!Number.isFinite(log.maxIntermediateReward)) log.maxIntermediateReward = 0
  return {
    ...log,
    territoryReward: roundMetric(log.territoryReward),
    mobilityReward: roundMetric(log.mobilityReward),
    trappedReward: roundMetric(log.trappedReward),
    lowMobilityReward: roundMetric(log.lowMobilityReward),
    intermediateReward: roundMetric(log.intermediateReward),
    finalReward: roundMetric(log.finalReward),
    totalReward: roundMetric(log.totalReward),
    minIntermediateReward: roundMetric(log.minIntermediateReward),
    maxIntermediateReward: roundMetric(log.maxIntermediateReward),
  }
}

function getMaxQValueQ5(
  state: GameSnapshot | undefined,
  qTable: QTableSnapshot,
  terminal: boolean,
): number {
  if (terminal || !state || state.phase === 'finished') return 0
  const legalActions = ai.getLegalActions(state)
  if (legalActions.length === 0) return 0
  return Math.max(...legalActions.map((action) => qTable[getLearningQTableKeyQ3(state, action)] ?? 0))
}

function getInstrumentedConfidence(
  key: string,
  confidenceMap: Map<string, Q5StateActionConfidence>,
): Q5StateActionConfidence {
  return (
    confidenceMap.get(key) ?? {
      observations: 0,
      confidence: 'new',
      alpha: Q5_ALPHA_BY_CONFIDENCE.new,
    }
  )
}

function updateQValueQ5Instrumented(params: {
  qTable: QTableSnapshot
  state: GameSnapshot
  action: PlayerAction
  reward: number
  nextState: GameSnapshot | undefined
  terminal: boolean
  gamma: number
  confidenceMap: Map<string, Q5StateActionConfidence>
  game: number
  opponent: Q5OpponentKind
  color: Player
  turn: number
  rewardComponent: 'intermediate' | 'final'
}): Q5UpdateLogEntry {
  const key = getLearningQTableKeyQ3(params.state, params.action)
  const [stateKey, actionKey] = key.split('|||')
  const currentQ = params.qTable[key] ?? 0
  const maxNextQ = getMaxQValueQ5(params.nextState, params.qTable, params.terminal)
  const target = params.reward + params.gamma * maxNextQ
  const confidence = getInstrumentedConfidence(key, params.confidenceMap)
  const rawDelta = confidence.alpha * (target - currentQ)
  const appliedDelta = clamp(rawDelta, -1, 1)
  const newQ = currentQ + appliedDelta
  params.qTable[key] = newQ

  return {
    game: params.game,
    state: stateKey ?? key,
    action: actionKey ?? '',
    stateActionKey: key,
    oldQ: roundMetric(currentQ),
    reward: roundMetric(params.reward),
    maxNextQ: roundMetric(maxNextQ),
    target: roundMetric(target),
    rawDelta: roundMetric(rawDelta),
    appliedDelta: roundMetric(appliedDelta),
    newQ: roundMetric(newQ),
    alpha: confidence.alpha,
    inheritedFrequency: confidence.observations,
    confidence: confidence.confidence,
    opponent: params.opponent,
    color: params.color,
    turn: params.turn,
    terminal: params.terminal,
    rewardComponent: params.rewardComponent,
  }
}

function createEmptyInstrumentedBucket(): Q5InstrumentedUpdateSummary['changesByConfidence'][Q5ConfidenceBucket] {
  return {
    updates: 0,
    meanAbsAppliedDelta: 0,
    maxAbsAppliedDelta: 0,
    clampedUpdates: 0,
  }
}

function summarizeInstrumentedUpdates(logs: Q5UpdateLogEntry[]): Q5InstrumentedUpdateSummary {
  const changesByConfidence: Q5InstrumentedUpdateSummary['changesByConfidence'] = {
    '1 observation': createEmptyInstrumentedBucket(),
    '2-5 observations': createEmptyInstrumentedBucket(),
    '6-20 observations': createEmptyInstrumentedBucket(),
    'more than 20': createEmptyInstrumentedBucket(),
    new: createEmptyInstrumentedBucket(),
  }
  const absoluteTotals: Record<Q5ConfidenceBucket, number> = {
    '1 observation': 0,
    '2-5 observations': 0,
    '6-20 observations': 0,
    'more than 20': 0,
    new: 0,
  }
  const alphaDistribution: Record<string, number> = {}
  let clampCount = 0
  let maxAbsAppliedDelta = 0
  let invalidValueCount = 0

  for (const log of logs) {
    alphaDistribution[String(log.alpha)] = (alphaDistribution[String(log.alpha)] ?? 0) + 1
    const absApplied = Math.abs(log.appliedDelta)
    const bucket = changesByConfidence[log.confidence]
    bucket.updates++
    absoluteTotals[log.confidence] += absApplied
    bucket.maxAbsAppliedDelta = Math.max(bucket.maxAbsAppliedDelta, absApplied)
    maxAbsAppliedDelta = Math.max(maxAbsAppliedDelta, absApplied)
    if (Math.abs(log.rawDelta) > 1) {
      clampCount++
      bucket.clampedUpdates++
    }
    if (
      !Number.isFinite(log.oldQ) ||
      !Number.isFinite(log.reward) ||
      !Number.isFinite(log.maxNextQ) ||
      !Number.isFinite(log.target) ||
      !Number.isFinite(log.rawDelta) ||
      !Number.isFinite(log.appliedDelta) ||
      !Number.isFinite(log.newQ)
    ) {
      invalidValueCount++
    }
  }

  for (const [confidence, bucket] of Object.entries(changesByConfidence) as Array<
    [Q5ConfidenceBucket, Q5InstrumentedUpdateSummary['changesByConfidence'][Q5ConfidenceBucket]]
  >) {
    bucket.meanAbsAppliedDelta = bucket.updates
      ? roundMetric(absoluteTotals[confidence] / bucket.updates)
      : 0
    bucket.maxAbsAppliedDelta = roundMetric(bucket.maxAbsAppliedDelta)
  }

  return {
    totalUpdates: logs.length,
    alphaDistribution,
    clampCount,
    maxAbsAppliedDelta: roundMetric(maxAbsAppliedDelta),
    invalidValueCount,
    changesByConfidence,
  }
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

function createResultStats(): ResultStats {
  return { games: 0, wins: 0, losses: 0, ties: 0 }
}

function createHitMissStats(): HitMissStats {
  return { qHits: 0, qMisses: 0, qHitRate: 0 }
}

function addResult(stats: ResultStats, result: Q5GameRecord['resultForQ5']): void {
  stats.games++
  if (result === 'win') stats.wins++
  else if (result === 'loss') stats.losses++
  else stats.ties++
}

function addHitMiss(stats: HitMissStats, qHits: number, qMisses: number): void {
  stats.qHits += qHits
  stats.qMisses += qMisses
}

function finalizeHitRate(stats: HitMissStats): void {
  const total = stats.qHits + stats.qMisses
  stats.qHitRate = total ? roundMetric((stats.qHits / total) * 100) : 0
}

function combinationKey(opponent: Q5OpponentKind, color: Player): string {
  return `${opponent}_${color}`
}

function buildTargetDistribution(totalGames: number): Q5TrainingMetadata['targetDistribution'] {
  return {
    opponents: { random: totalGames / 2, heuristic: totalGames / 2 },
    colors: { R: totalGames / 2, B: totalGames / 2 },
    combinations: {
      random_R: totalGames / 4,
      random_B: totalGames / 4,
      heuristic_R: totalGames / 4,
      heuristic_B: totalGames / 4,
    },
  }
}

function summarizeRewards(games: Q5GameRecord[]): RewardSummary {
  const initial: RewardSummary = {
    averageTotalReward: 0,
    averageTerritoryReward: 0,
    averageMobilityReward: 0,
    averageTrappedReward: 0,
    averageLowMobilityReward: 0,
    averageIntermediateReward: 0,
    averageFinalReward: 0,
    minTotalReward: 0,
    maxTotalReward: 0,
    minIntermediateReward: 0,
    maxIntermediateReward: 0,
    clampCounts: {
      territory: 0,
      mobility: 0,
      trap: 0,
      lowMobility: 0,
      total: 0,
      finalTerritory: 0,
    },
    trappedPiecesCreated: 0,
    trappedPiecesFreed: 0,
  }
  if (games.length === 0) return initial

  let totalReward = 0
  let territoryReward = 0
  let mobilityReward = 0
  let trappedReward = 0
  let lowMobilityReward = 0
  let intermediateReward = 0
  let finalReward = 0
  let minTotalReward = Infinity
  let maxTotalReward = -Infinity
  let minIntermediateReward = Infinity
  let maxIntermediateReward = -Infinity

  for (const game of games) {
    const reward = game.reward
    totalReward += reward.totalReward
    territoryReward += reward.territoryReward
    mobilityReward += reward.mobilityReward
    trappedReward += reward.trappedReward
    lowMobilityReward += reward.lowMobilityReward
    intermediateReward += reward.intermediateReward
    finalReward += reward.finalReward
    minTotalReward = Math.min(minTotalReward, reward.totalReward)
    maxTotalReward = Math.max(maxTotalReward, reward.totalReward)
    minIntermediateReward = Math.min(minIntermediateReward, reward.minIntermediateReward)
    maxIntermediateReward = Math.max(maxIntermediateReward, reward.maxIntermediateReward)
    initial.clampCounts.territory += reward.territoryClampCount
    initial.clampCounts.mobility += reward.mobilityClampCount
    initial.clampCounts.trap += reward.trapClampCount
    initial.clampCounts.lowMobility += reward.lowMobilityClampCount
    initial.clampCounts.total += reward.totalClampCount
    if (reward.finalTerritoryClamp) initial.clampCounts.finalTerritory++
    initial.trappedPiecesCreated += reward.trappedPiecesCreated
    initial.trappedPiecesFreed += reward.trappedPiecesFreed
  }

  return {
    ...initial,
    averageTotalReward: roundMetric(totalReward / games.length),
    averageTerritoryReward: roundMetric(territoryReward / games.length),
    averageMobilityReward: roundMetric(mobilityReward / games.length),
    averageTrappedReward: roundMetric(trappedReward / games.length),
    averageLowMobilityReward: roundMetric(lowMobilityReward / games.length),
    averageIntermediateReward: roundMetric(intermediateReward / games.length),
    averageFinalReward: roundMetric(finalReward / games.length),
    minTotalReward: roundMetric(minTotalReward),
    maxTotalReward: roundMetric(maxTotalReward),
    minIntermediateReward: roundMetric(minIntermediateReward),
    maxIntermediateReward: roundMetric(maxIntermediateReward),
  }
}

function summarizeGames(params: {
  games: Q5GameRecord[]
  epsilonInitial: number
  epsilonFinal: number
  initialQTableEntries: number
  qTable: QTableSnapshot
}): Q5TrainingSummary {
  const summary: Q5TrainingSummary = {
    gamesByOpponent: { random: 0, heuristic: 0 },
    gamesByColor: { R: 0, B: 0 },
    gamesByCombination: {
      random_R: 0,
      random_B: 0,
      heuristic_R: 0,
      heuristic_B: 0,
    },
    results: createResultStats(),
    resultsByOpponent: { random: createResultStats(), heuristic: createResultStats() },
    resultsByColor: { R: createResultStats(), B: createResultStats() },
    resultsByCombination: {
      random_R: createResultStats(),
      random_B: createResultStats(),
      heuristic_R: createResultStats(),
      heuristic_B: createResultStats(),
    },
    qTotal: createHitMissStats(),
    qByOpponent: { random: createHitMissStats(), heuristic: createHitMissStats() },
    qByColor: { R: createHitMissStats(), B: createHitMissStats() },
    averageTerritory: {
      q5: 0,
      opponent: 0,
    },
    averageTerritoryDiff: 0,
    averageTurns: 0,
    epsilonInitial: params.epsilonInitial,
    epsilonFinal: params.epsilonFinal,
    initialQTableEntries: params.initialQTableEntries,
    finalQTableEntries: Object.keys(params.qTable).length,
    tableGrowth: Object.keys(params.qTable).length - params.initialQTableEntries,
    uniqueQ3StatesVisited: new Set(Object.keys(params.qTable).map((key) => key.split('|||')[0]))
      .size,
    rewards: summarizeRewards(params.games),
  }

  let territoryQ5Total = 0
  let territoryOpponentTotal = 0
  let territoryDiffTotal = 0
  let turnsTotal = 0

  for (const game of params.games) {
    const key = combinationKey(game.opponent, game.learningColor)
    summary.gamesByOpponent[game.opponent]++
    summary.gamesByColor[game.learningColor]++
    summary.gamesByCombination[key]++
    addResult(summary.results, game.resultForQ5)
    addResult(summary.resultsByOpponent[game.opponent], game.resultForQ5)
    addResult(summary.resultsByColor[game.learningColor], game.resultForQ5)
    addResult(summary.resultsByCombination[key], game.resultForQ5)
    addHitMiss(summary.qTotal, game.qHits, game.qMisses)
    addHitMiss(summary.qByOpponent[game.opponent], game.qHits, game.qMisses)
    addHitMiss(summary.qByColor[game.learningColor], game.qHits, game.qMisses)
    territoryQ5Total += game.territoryQ5
    territoryOpponentTotal += game.territoryOpponent
    territoryDiffTotal += game.territoryDiff
    turnsTotal += game.turns
  }

  finalizeHitRate(summary.qTotal)
  finalizeHitRate(summary.qByOpponent.random)
  finalizeHitRate(summary.qByOpponent.heuristic)
  finalizeHitRate(summary.qByColor.R)
  finalizeHitRate(summary.qByColor.B)
  summary.averageTerritory.q5 = params.games.length
    ? roundMetric(territoryQ5Total / params.games.length)
    : 0
  summary.averageTerritory.opponent = params.games.length
    ? roundMetric(territoryOpponentTotal / params.games.length)
    : 0
  summary.averageTerritoryDiff = params.games.length
    ? roundMetric(territoryDiffTotal / params.games.length)
    : 0
  summary.averageTurns = params.games.length ? roundMetric(turnsTotal / params.games.length) : 0

  return summary
}

async function runQ5TrainingGame(params: {
  scheduleItem: Q5TrainingScheduleItem
  qTable: QTableSnapshot
  epsilon: number
  alpha: number
  gamma: number
  maxTurns: number
  rng: () => number
  instrumentedUpdates: boolean
  confidenceMap: Map<string, Q5StateActionConfidence>
  updateLogs: Q5UpdateLogEntry[]
}): Promise<
  Omit<
    Q5GameRecord,
    'epsilonInitial' | 'epsilonFinal' | 'qTableEntriesBefore' | 'qTableEntriesAfter'
  >
> {
  let state = makeInitialState()
  const learningSide = params.scheduleItem.learningColor
  const opponentSide = getOpponent(learningSide)
  let pending: PendingTransition | undefined
  let pendingReward = 0
  let turns = 0
  let qHits = 0
  let qMisses = 0
  const rewardLog = createRewardLog(params.scheduleItem.game)

  while (state.phase !== 'finished' && !state.result && turns < params.maxTurns) {
    const prevState = snapshotFromState(state)
    const isLearningTurn = prevState.turn === learningSide

    if (isLearningTurn && pending) {
      if (params.instrumentedUpdates) {
        params.updateLogs.push(
          updateQValueQ5Instrumented({
            qTable: params.qTable,
            state: pending.state,
            action: pending.action,
            reward: pendingReward,
            nextState: prevState,
            terminal: false,
            gamma: params.gamma,
            confidenceMap: params.confidenceMap,
            game: params.scheduleItem.game,
            opponent: params.scheduleItem.opponent,
            color: learningSide,
            turn: turns,
            rewardComponent: 'intermediate',
          }),
        )
      } else {
        updateQValueQ4({
          qTable: params.qTable,
          state: pending.state,
          action: pending.action,
          reward: pendingReward,
          nextState: prevState,
          terminal: false,
          alpha: params.alpha,
          gamma: params.gamma,
        })
      }
      pending = undefined
      pendingReward = 0
    }

    let action: PlayerAction
    if (isLearningTurn) {
      const choice = chooseLearningActionQ4(
        prevState,
        ai.getLegalActions(prevState),
        params.epsilon,
        params.qTable,
        params.rng,
      )
      action = choice.action
      if (choice.selectedKeyExists) qHits++
      else qMisses++
    } else if (params.scheduleItem.opponent === 'random') {
      action = chooseRandomActionWithRngQ4(ai.getLegalActions(prevState), params.rng)
    } else {
      action = chooseHeuristicOpponentActionQ4(prevState, params.rng)
    }

    const applied = applyFullActionQ5(state, action)
    state = applied.state
    turns += applied.turns
    const intermediateReward = calculateIntermediateRewardQ5(prevState, state, learningSide)
    addIntermediateReward(rewardLog, intermediateReward)
    pendingReward += intermediateReward.intermediateReward

    if (isLearningTurn) {
      pending = { state: prevState, action }
    }
  }

  state = finalizeGameIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')
  const finalReward = calculateFinalRewardQ5(winner, territory, learningSide)

  if (pending) {
    if (params.instrumentedUpdates) {
      params.updateLogs.push(
        updateQValueQ5Instrumented({
          qTable: params.qTable,
          state: pending.state,
          action: pending.action,
          reward: pendingReward + finalReward.finalReward,
          nextState: undefined,
          terminal: true,
          gamma: params.gamma,
          confidenceMap: params.confidenceMap,
          game: params.scheduleItem.game,
          opponent: params.scheduleItem.opponent,
          color: learningSide,
          turn: turns,
          rewardComponent: 'final',
        }),
      )
    } else {
      updateQValueQ4({
        qTable: params.qTable,
        state: pending.state,
        action: pending.action,
        reward: pendingReward + finalReward.finalReward,
        nextState: undefined,
        terminal: true,
        alpha: params.alpha,
        gamma: params.gamma,
      })
    }
  }

  return {
    game: params.scheduleItem.game,
    opponent: params.scheduleItem.opponent,
    learningColor: learningSide,
    opponentColor: opponentSide,
    winner,
    resultForQ5: finalReward.result,
    territoryQ5: territory[learningSide],
    territoryOpponent: territory[opponentSide],
    territoryDiff: territory[learningSide] - territory[opponentSide],
    turns,
    qHits,
    qMisses,
    reward: finalizeRewardLog(rewardLog, finalReward),
  }
}

export async function runLearningAgentQ5Training(
  options: Partial<Q5TrainingConfig> = {},
): Promise<{ qTable: QTableSnapshot; metadata: Q5TrainingMetadata }> {
  const config: Q5TrainingConfig = { ...DEFAULT_Q5_TRAINING_CONFIG, ...options }
  assertOutputCanBeWritten(config.outputDir, config.overwrite)
  const startedAt = Date.now()
  const rng = createSeededRngQ4(config.seed)
  const initialQTable = config.initialQTablePath ? loadQTable(config.initialQTablePath) : {}
  const qTable: QTableSnapshot = cloneQTable(initialQTable)
  const confidenceMap = loadQ5ConfidenceMap(config.initialQTableBuildSummaryPath)
  const updateLogs: Q5UpdateLogEntry[] = []
  const initialQTableEntries = Object.keys(qTable).length
  if (!config.initialQTablePath && initialQTableEntries !== 0) {
    throw new Error('Q5 pilot must start from an empty Q-table')
  }

  const schedule = config.schedule ?? buildBalancedQ5Schedule(config.totalGames, config.seed)
  if (schedule.length !== config.totalGames) throw new Error('Q5 schedule length mismatch')
  const games: Q5GameRecord[] = []
  let epsilon = config.epsilonStart

  for (const scheduleItem of schedule) {
    const epsilonInitial = epsilon
    const qTableEntriesBefore = Object.keys(qTable).length
    const gameStats = await runQ5TrainingGame({
      scheduleItem,
      qTable,
      epsilon,
      alpha: config.alpha,
      gamma: config.gamma,
      maxTurns: config.maxTurns,
      rng,
      instrumentedUpdates: config.instrumentedUpdates ?? false,
      confidenceMap,
      updateLogs,
    })
    epsilon = Math.max(epsilon * config.epsilonDecay, config.epsilonMin)
    games.push({
      ...gameStats,
      epsilonInitial,
      epsilonFinal: epsilon,
      qTableEntriesBefore,
      qTableEntriesAfter: Object.keys(qTable).length,
    })

    if (config.progressEvery > 0 && scheduleItem.game % config.progressEvery === 0) {
      console.log(
        `[trainLearningAgentQ5] ${scheduleItem.game}/${config.totalGames} games, qTable=${Object.keys(qTable).length}, epsilon=${epsilon.toFixed(4)}`,
      )
    }
  }

  const outputFiles = {
    qTable: path.join(
      config.outputDir,
      config.checkpoint === 500
        ? 'qtable_q5_500.json'
        : config.checkpoint === 'final_finetuning_500'
          ? 'qtable_q5_final_finetuning_500.json'
          : config.checkpoint === 'instrumented_pilot_100'
            ? 'qtable_q5_instrumented_pilot_100.json'
            : 'qtable_q5_pilot_40.json',
    ),
    metadata: path.join(config.outputDir, 'metadata.json'),
    trainingSummary: path.join(config.outputDir, 'training_summary.json'),
    rewardLog: path.join(config.outputDir, 'reward_log.json'),
    qUpdateLog: config.instrumentedUpdates ? path.join(config.outputDir, 'q_update_log.jsonl') : undefined,
  }
  const instrumentedUpdateSummary = summarizeInstrumentedUpdates(updateLogs)
  const summary = summarizeGames({
    games,
    epsilonInitial: config.epsilonStart,
    epsilonFinal: roundMetric(epsilon),
    initialQTableEntries,
    qTable,
  })
  const metadata: Q5TrainingMetadata = {
    model: 'Q5',
    seed: config.seed,
    totalGames: config.totalGames,
    checkpoint: config.checkpoint,
    startedFromEmptyQTable: !config.initialQTablePath,
    initialization: config.initialQTablePath ? 'heuristic_initial' : 'empty',
    sourceQTable: config.initialQTablePath
      ? {
          path: config.initialQTablePath,
          entries: initialQTableEntries,
        }
      : undefined,
    initialQTableEntries,
    newTrainingGames: config.totalGames,
    stateRepresentation: 'Q3',
    policyModel: 'Q3/Q4',
    baselineExperiment: 'Q4',
    onlyExperimentalChange: 'reward',
    rewardModel: 'Q5',
    rewardConfiguration: Q5_REWARD_CONFIG,
    hyperparameters: {
      alpha: config.alpha,
      gamma: config.gamma,
      epsilonStart: config.epsilonStart,
      epsilonMin: config.epsilonMin,
      epsilonDecay: config.epsilonDecay,
      maxTurns: config.maxTurns,
    },
    targetDistribution: buildTargetDistributionFromSchedule(schedule),
    heuristicPolicy: {
      placement: 'getBestPlacement',
      playing: 'getBestHeuristicAction',
      policy: 'default',
    },
    schedule,
    games,
    rewardLog: games.map((game) => game.reward),
    summary,
    qTableDelta: calculateQTableDelta(initialQTable, qTable),
    instrumentedUpdates: config.instrumentedUpdates
      ? {
          enabled: true,
          deltaClamp: { min: -1, max: 1 },
          learningRateByConfidence: Q5_ALPHA_BY_CONFIDENCE,
          updateSummary: instrumentedUpdateSummary,
        }
      : undefined,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    outputFiles,
  }

  mkdirSync(config.outputDir, { recursive: true })
  writeJson(outputFiles.qTable, qTable)
  writeJson(outputFiles.metadata, metadata)
  writeJson(outputFiles.trainingSummary, summary)
  writeJson(outputFiles.rewardLog, metadata.rewardLog)
  if (outputFiles.qUpdateLog) {
    writeFileSync(
      outputFiles.qUpdateLog,
      `${updateLogs.map((log) => JSON.stringify(log)).join('\n')}\n`,
      'utf8',
    )
  }

  return { qTable, metadata }
}

export function loadQ5Metadata(metadataPath: string): Q5TrainingMetadata {
  return JSON.parse(readFileSync(path.resolve(metadataPath), 'utf8')) as Q5TrainingMetadata
}

export function validateQ5PilotMetadata(metadata: Q5TrainingMetadata): void {
  if (metadata.model !== 'Q5') throw new Error('metadata.model must be Q5')
  if (metadata.seed !== 3) throw new Error('Q5 pilot seed must be 3')
  if (metadata.totalGames !== 40) throw new Error('Q5 pilot must contain exactly 40 games')
  if (metadata.checkpoint !== 'pilot_40') throw new Error('Q5 pilot checkpoint must be pilot_40')
  if (!metadata.startedFromEmptyQTable) throw new Error('Q5 pilot must start from an empty Q-table')
  if (metadata.initialQTableEntries !== 0) throw new Error('Q5 initial table must be empty')
  if (metadata.stateRepresentation !== 'Q3') throw new Error('Q5 must keep Q3 representation')
  if (metadata.rewardModel !== 'Q5') throw new Error('Q5 must use Q5 reward')
  if (metadata.onlyExperimentalChange !== 'reward') throw new Error('Q5 only changes reward')
  if (metadata.summary.finalQTableEntries <= 0) throw new Error('Expected a non-empty Q5 table')
  if (metadata.summary.initialQTableEntries !== 0)
    throw new Error('Q5 summary initial table mismatch')
  const expected = buildTargetDistribution(40)
  if (JSON.stringify(metadata.summary.gamesByOpponent) !== JSON.stringify(expected.opponents)) {
    throw new Error('Q5 pilot opponent distribution mismatch')
  }
  if (JSON.stringify(metadata.summary.gamesByColor) !== JSON.stringify(expected.colors)) {
    throw new Error('Q5 pilot color distribution mismatch')
  }
  if (
    JSON.stringify(metadata.summary.gamesByCombination) !== JSON.stringify(expected.combinations)
  ) {
    throw new Error('Q5 pilot combination distribution mismatch')
  }
}

export function validateQ5Checkpoint500Metadata(metadata: Q5TrainingMetadata): void {
  if (metadata.model !== 'Q5') throw new Error('metadata.model must be Q5')
  if (metadata.seed !== 3) throw new Error('Q5-500 seed must be 3')
  if (metadata.checkpoint !== 500) throw new Error('Q5 checkpoint must be 500')
  if (metadata.totalGames !== 500) throw new Error('Q5-500 must contain exactly 500 games')
  if (metadata.newTrainingGames !== 500) throw new Error('Q5-500 must run exactly 500 new games')
  if (metadata.startedFromEmptyQTable) throw new Error('Q5-500 must not start empty')
  if (metadata.initialization !== 'heuristic_initial') {
    throw new Error('Q5-500 must initialize from heuristic table')
  }
  if (metadata.initialQTableEntries !== 19652) throw new Error('Q5-500 initial table mismatch')
  if (metadata.sourceQTable?.entries !== 19652) throw new Error('Q5-500 source table mismatch')
  if (metadata.stateRepresentation !== 'Q3') throw new Error('Q5-500 must keep Q3 representation')
  if (metadata.rewardModel !== 'Q5') throw new Error('Q5-500 must use Q5 reward')
  if (metadata.hyperparameters.alpha !== 0.1) throw new Error('Q5-500 alpha mismatch')
  if (metadata.hyperparameters.gamma !== 0.9) throw new Error('Q5-500 gamma mismatch')
  if (metadata.hyperparameters.epsilonStart !== 0.6) throw new Error('Q5-500 epsilon mismatch')
  if (metadata.hyperparameters.epsilonMin !== 0.05) throw new Error('Q5-500 epsilonMin mismatch')
  if (metadata.hyperparameters.epsilonDecay !== 0.9995)
    throw new Error('Q5-500 epsilonDecay mismatch')
  if (metadata.hyperparameters.maxTurns !== 250) throw new Error('Q5-500 maxTurns mismatch')
  if (metadata.summary.gamesByOpponent.random !== 350) throw new Error('Q5-500 random mismatch')
  if (metadata.summary.gamesByOpponent.heuristic !== 150)
    throw new Error('Q5-500 heuristic mismatch')
  if (metadata.summary.gamesByCombination.random_R !== 175)
    throw new Error('Q5-500 random_R mismatch')
  if (metadata.summary.gamesByCombination.random_B !== 175)
    throw new Error('Q5-500 random_B mismatch')
  if (metadata.summary.gamesByCombination.heuristic_R !== 75)
    throw new Error('Q5-500 heuristic_R mismatch')
  if (metadata.summary.gamesByCombination.heuristic_B !== 75)
    throw new Error('Q5-500 heuristic_B mismatch')
  const expectedEpsilon = Number((0.6 * 0.9995 ** 500).toFixed(4))
  if (metadata.summary.epsilonFinal !== expectedEpsilon) {
    throw new Error('Q5-500 epsilon final mismatch')
  }
  if (!metadata.qTableDelta) throw new Error('Q5-500 must record qTable delta')
}

export function validateQ5FinalFineTuning500Metadata(metadata: Q5TrainingMetadata): void {
  if (metadata.model !== 'Q5') throw new Error('metadata.model must be Q5')
  if (metadata.seed !== 3) throw new Error('Q5 fine-tuning seed must be 3')
  if (metadata.checkpoint !== 'final_finetuning_500') {
    throw new Error('Q5 fine-tuning checkpoint mismatch')
  }
  if (metadata.totalGames !== 500) throw new Error('Q5 fine-tuning must contain 500 games')
  if (metadata.newTrainingGames !== 500) throw new Error('Q5 fine-tuning must run 500 games')
  if (metadata.startedFromEmptyQTable) throw new Error('Q5 fine-tuning must not start empty')
  if (metadata.initialization !== 'heuristic_initial') {
    throw new Error('Q5 fine-tuning must initialize from heuristic table')
  }
  if (metadata.initialQTableEntries !== 19652) {
    throw new Error('Q5 fine-tuning initial table mismatch')
  }
  if (metadata.summary.gamesByOpponent.random !== 250) {
    throw new Error('Q5 fine-tuning random mismatch')
  }
  if (metadata.summary.gamesByOpponent.heuristic !== 250) {
    throw new Error('Q5 fine-tuning heuristic mismatch')
  }
  for (const key of ['random_R', 'random_B', 'heuristic_R', 'heuristic_B']) {
    if (metadata.summary.gamesByCombination[key] !== 125) {
      throw new Error(`Q5 fine-tuning ${key} mismatch`)
    }
  }
  if (metadata.hyperparameters.alpha !== 0.03) throw new Error('Q5 fine-tuning alpha mismatch')
  if (metadata.hyperparameters.gamma !== 0.9) throw new Error('Q5 fine-tuning gamma mismatch')
  if (metadata.hyperparameters.epsilonStart !== 0.15) {
    throw new Error('Q5 fine-tuning epsilonStart mismatch')
  }
  if (metadata.hyperparameters.epsilonMin !== 0.02) {
    throw new Error('Q5 fine-tuning epsilonMin mismatch')
  }
  if (metadata.hyperparameters.epsilonDecay !== 0.9995) {
    throw new Error('Q5 fine-tuning epsilonDecay mismatch')
  }
  if (metadata.hyperparameters.maxTurns !== 250) {
    throw new Error('Q5 fine-tuning maxTurns mismatch')
  }
  const expectedEpsilon = Number((0.15 * 0.9995 ** 500).toFixed(4))
  if (metadata.summary.epsilonFinal !== expectedEpsilon) {
    throw new Error('Q5 fine-tuning epsilon final mismatch')
  }
  if (!metadata.qTableDelta) throw new Error('Q5 fine-tuning must record qTable delta')
}

export function validateQ5InstrumentedPilot100Metadata(metadata: Q5TrainingMetadata): void {
  if (metadata.model !== 'Q5') throw new Error('metadata.model must be Q5')
  if (metadata.seed !== 3) throw new Error('Q5 instrumented pilot seed must be 3')
  if (metadata.checkpoint !== 'instrumented_pilot_100') {
    throw new Error('Q5 instrumented pilot checkpoint mismatch')
  }
  if (metadata.totalGames !== 100) throw new Error('Q5 instrumented pilot must contain 100 games')
  if (metadata.newTrainingGames !== 100) {
    throw new Error('Q5 instrumented pilot must run 100 games')
  }
  if (metadata.startedFromEmptyQTable) throw new Error('Q5 instrumented pilot must not start empty')
  if (metadata.initialization !== 'heuristic_initial') {
    throw new Error('Q5 instrumented pilot must initialize from heuristic table')
  }
  if (metadata.initialQTableEntries !== 19652) {
    throw new Error('Q5 instrumented pilot initial table mismatch')
  }
  if (metadata.sourceQTable?.path !== Q5_HEURISTIC_INITIAL_QTABLE_PATH) {
    throw new Error('Q5 instrumented pilot source path mismatch')
  }
  if (metadata.summary.gamesByOpponent.random !== 50) {
    throw new Error('Q5 instrumented pilot random mismatch')
  }
  if (metadata.summary.gamesByOpponent.heuristic !== 50) {
    throw new Error('Q5 instrumented pilot heuristic mismatch')
  }
  for (const key of ['random_R', 'random_B', 'heuristic_R', 'heuristic_B']) {
    if (metadata.summary.gamesByCombination[key] !== 25) {
      throw new Error(`Q5 instrumented pilot ${key} mismatch`)
    }
  }
  if (metadata.hyperparameters.gamma !== 0.9) throw new Error('Q5 instrumented pilot gamma mismatch')
  if (metadata.hyperparameters.epsilonStart !== 0.15) {
    throw new Error('Q5 instrumented pilot epsilonStart mismatch')
  }
  if (metadata.hyperparameters.epsilonMin !== 0.02) {
    throw new Error('Q5 instrumented pilot epsilonMin mismatch')
  }
  if (metadata.hyperparameters.epsilonDecay !== 0.9995) {
    throw new Error('Q5 instrumented pilot epsilonDecay mismatch')
  }
  if (metadata.hyperparameters.maxTurns !== 250) {
    throw new Error('Q5 instrumented pilot maxTurns mismatch')
  }
  const expectedEpsilon = Number((0.15 * 0.9995 ** 100).toFixed(4))
  if (metadata.summary.epsilonFinal !== expectedEpsilon) {
    throw new Error('Q5 instrumented pilot epsilon final mismatch')
  }
  if (!metadata.instrumentedUpdates?.enabled) {
    throw new Error('Q5 instrumented pilot must record instrumented updates')
  }
  if (metadata.instrumentedUpdates.updateSummary.maxAbsAppliedDelta > 1) {
    throw new Error('Q5 instrumented pilot applied delta clamp mismatch')
  }
  if (metadata.instrumentedUpdates.updateSummary.invalidValueCount !== 0) {
    throw new Error('Q5 instrumented pilot invalid update values')
  }
  if (!metadata.outputFiles.qUpdateLog) {
    throw new Error('Q5 instrumented pilot must write q_update_log.jsonl')
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'pilot-40'
  if (command === 'train-500') {
    const result = await runLearningAgentQ5Training({
      totalGames: 500,
      checkpoint: 500,
      seed: 3,
      outputDir: Q5_CHECKPOINT_500_DIR,
      initialQTablePath: Q5_HEURISTIC_INITIAL_QTABLE_PATH,
      schedule: buildQ5Checkpoint500Schedule(),
    })
    validateQ5Checkpoint500Metadata(result.metadata)
    console.log(`[trainLearningAgentQ5] Q5-500 games: ${result.metadata.totalGames}`)
    console.log(`[trainLearningAgentQ5] Q5-500 entries: ${Object.keys(result.qTable).length}`)
    console.log(`[trainLearningAgentQ5] Q5-500 output: ${result.metadata.outputFiles.metadata}`)
    return
  }
  if (command === 'final-finetune-500') {
    const result = await runLearningAgentQ5Training({
      totalGames: 500,
      checkpoint: 'final_finetuning_500',
      seed: 3,
      outputDir: Q5_FINAL_FINETUNING_500_DIR,
      initialQTablePath: Q5_HEURISTIC_INITIAL_QTABLE_PATH,
      schedule: buildQ5FinalFineTuning500Schedule(),
      alpha: 0.03,
      epsilonStart: 0.15,
      epsilonMin: 0.02,
    })
    validateQ5FinalFineTuning500Metadata(result.metadata)
    console.log(`[trainLearningAgentQ5] Q5 fine-tuning 500 games: ${result.metadata.totalGames}`)
    console.log(
      `[trainLearningAgentQ5] Q5 fine-tuning entries: ${Object.keys(result.qTable).length}`,
    )
    console.log(
      `[trainLearningAgentQ5] Q5 fine-tuning output: ${result.metadata.outputFiles.metadata}`,
    )
    return
  }
  if (command === 'instrumented-pilot-100') {
    const result = await runLearningAgentQ5Training({
      totalGames: 100,
      checkpoint: 'instrumented_pilot_100',
      seed: 3,
      outputDir: Q5_INSTRUMENTED_PILOT_100_DIR,
      initialQTablePath: Q5_HEURISTIC_INITIAL_QTABLE_PATH,
      initialQTableBuildSummaryPath: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      schedule: buildQ5InstrumentedPilot100Schedule(),
      alpha: 0.03,
      epsilonStart: 0.15,
      epsilonMin: 0.02,
      instrumentedUpdates: true,
    })
    validateQ5InstrumentedPilot100Metadata(result.metadata)
    console.log(`[trainLearningAgentQ5] Q5 instrumented pilot games: ${result.metadata.totalGames}`)
    console.log(
      `[trainLearningAgentQ5] Q5 instrumented pilot entries: ${Object.keys(result.qTable).length}`,
    )
    console.log(
      `[trainLearningAgentQ5] Q5 instrumented pilot output: ${result.metadata.outputFiles.metadata}`,
    )
    return
  }
  if (command !== 'pilot-40') throw new Error(`Unknown command: ${command}`)
  const result = await runLearningAgentQ5Training({
    totalGames: 40,
    checkpoint: 'pilot_40',
    seed: 3,
    outputDir: Q5_PILOT_40_DIR,
  })
  validateQ5PilotMetadata(result.metadata)
  console.log(`[trainLearningAgentQ5] Q5 pilot games: ${result.metadata.totalGames}`)
  console.log(`[trainLearningAgentQ5] Q5 pilot entries: ${Object.keys(result.qTable).length}`)
  console.log(`[trainLearningAgentQ5] Q5 pilot output: ${result.metadata.outputFiles.metadata}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
