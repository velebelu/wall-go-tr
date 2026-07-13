import { createHash } from 'node:crypto'
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
export const Q5_HYBRID_INITIAL_EVAL_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/evaluacion_inicial_eval200',
)
export const Q5_HYBRID_PILOT_100_DIR = path.join(Q5_BASE_DIR, 'hybrid/pilot_100')
export const Q5_HYBRID_PILOT_100_EVAL_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/evaluacion_pilot_100_eval200',
)
export const Q5_HYBRID_THRESHOLD_SEARCH_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/threshold_search',
)
export const Q5_HYBRID_THRESHOLD_VALIDATION_EXTENDED_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/threshold_validation_extended',
)
export const Q5_HYBRID_FINAL_CHECKPOINT_500_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/final_checkpoint_500',
)
export const Q5_HYBRID_FINAL_CHECKPOINT_500_EVAL_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/evaluacion_final_checkpoint_500_eval200',
)
export const Q5_HYBRID_FINAL_CHECKPOINT_500_EXTENDED_VALIDATION_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/validacion_extendida_final_checkpoint_500',
)
export const Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/final_checkpoint_1000',
)
export const Q5_HYBRID_FINAL_CHECKPOINT_1000_EVAL_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/evaluacion_final_checkpoint_1000_eval200',
)
export const Q5_HYBRID_FINAL_CHECKPOINT_1500_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/final_checkpoint_1500',
)
export const Q5_HYBRID_FINAL_CHECKPOINT_1500_CONSERVATIVE_ALPHA_DIR = path.join(
  Q5_BASE_DIR,
  'hybrid/final_checkpoint_1500_conservative_alpha',
)

export type Q5OpponentKind = Q4OpponentKind

export interface Q5TrainingScheduleItem {
  game: number
  opponent: Q5OpponentKind
  learningColor: Player
  localGameIndex?: number
  cumulativeGameNumber?: number
}

export interface Q5LocalEpsilonRange {
  from: number
  to: number
  epsilon: number
}

export interface Q5TrainingConfig {
  totalGames: number
  checkpoint:
    | 'pilot_40'
    | 500
    | 'final_finetuning_500'
    | 'instrumented_pilot_100'
    | 'hybrid_pilot_100'
    | 'hybrid_final_500'
    | 'hybrid_final_1000'
    | 'hybrid_final_1500'
    | 'hybrid_final_1500_conservative_alpha'
  seed: number
  outputDir: string
  alpha: number
  gamma: number
  epsilonStart: number
  epsilonMin: number
  epsilonDecay: number
  epsilonSchedule?: (scheduleItem: Q5TrainingScheduleItem) => number
  maxTurns: number
  progressEvery: number
  overwrite: boolean
  initialQTablePath?: string
  initializationLabel?: 'heuristic_initial' | 'hybrid_final_500' | 'hybrid_final_1000'
  initialQTableBuildSummaryPath?: string
  previousQUpdateLogPath?: string | string[]
  qVsHeuristicDecisionLogPath?: string
  accumulatedTotalGames?: number
  schedule?: Q5TrainingScheduleItem[]
  instrumentedUpdates?: boolean
  hybridPolicy?: boolean
  confidenceThreshold?: number
  thresholdPolicy?: Q5ThresholdPolicyVariant
  inheritedAlphaMultiplier?: number
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
  hybridDecisions?: Q5HybridDecisionStats
  thresholdDecisions?: Q5ThresholdDecisionStats
}

export type Q5ConfidenceBucket =
  | '1 observation'
  | '2-5 observations'
  | '6-20 observations'
  | 'more than 20'
  | 'new'
export type Q5HybridDecisionMechanism = 'qReliable' | 'heuristicFallback' | 'randomExploration'

export interface Q5StateActionConfidence {
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
  delta: number
  newQ: number
  alpha: number
  baseAlpha: number
  inheritedFrequency: number
  confidence: Q5ConfidenceBucket
  entryOrigin: 'inherited' | 'new'
  inheritedFromInitialCheckpoint: boolean
  opponent: Q5OpponentKind
  color: Player
  turn: number
  terminal: boolean
  rewardComponent: 'intermediate' | 'final'
  finalResultForQ5?: 'win' | 'loss' | 'tie'
  finalTerritoryDiff?: number
}

export interface Q5HybridDecisionStats {
  qReliable: number
  heuristicFallback: number
  randomExploration: number
}

export interface Q5HybridChoice {
  action: PlayerAction
  mechanism: Q5HybridDecisionMechanism
  selectedKeyExists: boolean
  selectedKeyReliable: boolean
  knownLegalActions: number
  reliableLegalActions: number
}

export interface Q5ThresholdPolicyVariant {
  id: 'A' | 'B' | 'C' | 'D' | 'E'
  minConfidence: number
  minMargin: number
}

interface Q5ThresholdChoice {
  action: PlayerAction
  heuristicAction: PlayerAction
  qAction: PlayerAction
  mechanism: 'heuristicMatch' | 'qOverrideAccepted' | 'qOverrideRejected'
  heuristicKey: string
  qKey: string
  heuristicQ: number
  bestQ: number
  qConfidence: number
  margin: number
}

interface Q5VsHeuristicDecisionLogEntry {
  game: number
  opponent: Q5OpponentKind
  color: Player
  turn: number
  state: string
  heuristicAction: PlayerAction
  qAction: PlayerAction
  executedAction: PlayerAction
  heuristicKey: string
  qKey: string
  heuristicQ: number
  qValue: number
  qConfidence: number
  margin: number
  territoryBefore: Record<Player, number>
  territoryDiffBefore: number
  territoryDiffAfter1Turn?: number
  territoryDiffAfter3Turns?: number
  territoryDiffAfter5Turns?: number
  finalWinner?: Player | 'tie'
  finalResultForQ5?: 'win' | 'loss' | 'tie'
  finalTerritoryDiff?: number
}

interface Q5ThresholdDecisionStats {
  matches: number
  qOverridesAccepted: number
  qOverridesRejected: number
  randomExploration: number
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

interface Q5InheritedVsNewUpdateSummaryBucket {
  updates: number
  positiveUpdates: number
  negativeUpdates: number
  zeroUpdates: number
  alphaDistribution: Record<string, number>
  meanAbsDelta: number
  maxAbsDelta: number
  meanReward: number
  finalRewardUpdates: number
  intermediateRewardUpdates: number
  wins: number
  losses: number
  ties: number
}

interface Q5InheritedVsNewUpdateSummary {
  inheritedAlphaMultiplier: number
  inherited: Q5InheritedVsNewUpdateSummaryBucket
  new: Q5InheritedVsNewUpdateSummaryBucket
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
  hybridPolicy?: {
    confidenceThreshold: number
    decisions: Q5HybridDecisionStats
    decisionPercentages: Q5HybridDecisionStats
    resultsByPrimaryDecisionMechanism: Record<Q5HybridDecisionMechanism, ResultStats>
  }
  thresholdPolicy?: {
    variant: Q5ThresholdPolicyVariant
    decisions: Q5ThresholdDecisionStats
    decisionPercentages: {
      matches: number
      qOverridesAccepted: number
      qOverridesRejected: number
      randomExploration: number
      qExecuted: number
      heuristicExecuted: number
    }
    resultsByPrimaryDecisionMechanism: Record<
      'heuristicMatch' | 'qOverrideAccepted' | 'qOverrideRejected' | 'randomExploration',
      ResultStats
    >
  }
}

export interface Q5TrainingMetadata {
  model: 'Q5'
  seed: number
  totalGames: number
  checkpoint:
    | 'pilot_40'
    | 500
    | 'final_finetuning_500'
    | 'instrumented_pilot_100'
    | 'hybrid_pilot_100'
    | 'hybrid_final_500'
    | 'hybrid_final_1000'
    | 'hybrid_final_1500'
    | 'hybrid_final_1500_conservative_alpha'
  startedFromEmptyQTable: boolean
  initialization: 'empty' | 'heuristic_initial' | 'hybrid_final_500' | 'hybrid_final_1000'
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
    inheritedAlphaMultiplier?: number
    updateSummary: Q5InstrumentedUpdateSummary
    inheritedVsNewUpdateSummary?: Q5InheritedVsNewUpdateSummary
  }
  hybridPolicy?: {
    enabled: boolean
    confidenceThreshold: number
    fallback: 'heuristic'
    explorationDuringTraining: boolean
  }
  thresholdPolicy?: {
    enabled: boolean
    variant: Q5ThresholdPolicyVariant
    fallback: 'heuristic'
    explorationDuringTraining: boolean
  }
  continuation?: {
    previousQUpdateLogPath: string | string[]
    qLearningUpdateCountsLoadedBeforeTraining: number
    accumulatedTotalGames: number
  }
  createdAt: string
  durationMs: number
  outputFiles: {
    qTable: string
    metadata: string
    trainingSummary: string
    rewardLog: string
    qUpdateLog?: string
    qVsHeuristicDecisionLog?: string
    inheritedVsNewUpdateSummary?: string
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

export const buildQ5HybridPilot100Schedule = buildQ5InstrumentedPilot100Schedule

export function buildQ5HybridFinal1000ContinuationSchedule(): Q5TrainingScheduleItem[] {
  return buildQ5FinalFineTuning500Schedule().map((item) => ({
    ...item,
    game: item.game + 500,
    localGameIndex: item.game,
    cumulativeGameNumber: item.game + 500,
  }))
}

export function buildQ5HybridFinal1500ContinuationSchedule(): Q5TrainingScheduleItem[] {
  return buildQ5FinalFineTuning500Schedule().map((item) => ({
    ...item,
    game: item.game + 1000,
    localGameIndex: item.game,
    cumulativeGameNumber: item.game + 1000,
  }))
}

export function getQ5EpsilonByLocalGameIndex(
  scheduleItem: Q5TrainingScheduleItem,
  ranges: Q5LocalEpsilonRange[],
  label = 'Q5 local epsilon schedule',
): number {
  const localGameIndex = scheduleItem.localGameIndex ?? scheduleItem.game
  const range = ranges.find((candidate) => localGameIndex >= candidate.from && localGameIndex <= candidate.to)
  if (!range) throw new Error(`${label} out of range: local=${localGameIndex}`)
  return range.epsilon
}

export function getQ5HybridFinal1500Epsilon(scheduleItem: Q5TrainingScheduleItem): number {
  return getQ5EpsilonByLocalGameIndex(
    scheduleItem,
    [
      { from: 1, to: 100, epsilon: 0.1 },
      { from: 101, to: 300, epsilon: 0.07 },
      { from: 301, to: 500, epsilon: 0.03 },
    ],
    'Q5 hybrid final 1500 epsilon schedule',
  )
}

export function loadQTable(qTablePath: string): QTableSnapshot {
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

export function loadQ5ConfidenceMap(buildSummaryPath?: string): Map<string, Q5StateActionConfidence> {
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

export function finalizeGameIfNeeded(state: GameSnapshot): GameSnapshot {
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

export function applyFullActionQ5(
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

function createHybridDecisionStats(): Q5HybridDecisionStats {
  return { qReliable: 0, heuristicFallback: 0, randomExploration: 0 }
}

function addHybridDecision(stats: Q5HybridDecisionStats, mechanism: Q5HybridDecisionMechanism): void {
  stats[mechanism]++
}

function isReliableQ5Action(params: {
  key: string
  confidenceMap: Map<string, Q5StateActionConfidence>
  qLearningUpdateCounts: Map<string, number>
  confidenceThreshold: number
}): boolean {
  const inherited = params.confidenceMap.get(params.key)?.observations ?? 0
  const learned = params.qLearningUpdateCounts.get(params.key) ?? 0
  return inherited >= params.confidenceThreshold || learned >= params.confidenceThreshold
}

export function chooseHybridQ5Action(params: {
  state: GameSnapshot
  legalActions: PlayerAction[]
  qTable: QTableSnapshot
  confidenceMap: Map<string, Q5StateActionConfidence>
  qLearningUpdateCounts: Map<string, number>
  confidenceThreshold: number
  epsilon: number
  rng: () => number
}): Q5HybridChoice {
  if (params.legalActions.length === 0) throw new Error(`No legal actions for ${params.state.turn}`)
  if (params.epsilon > 0 && params.rng() < params.epsilon) {
    const action = chooseRandomActionWithRngQ4(params.legalActions, params.rng)
    const key = getLearningQTableKeyQ3(params.state, action)
    return {
      action,
      mechanism: 'randomExploration',
      selectedKeyExists: params.qTable[key] !== undefined,
      selectedKeyReliable: isReliableQ5Action({ ...params, key }),
      knownLegalActions: params.legalActions.filter(
        (legalAction) => params.qTable[getLearningQTableKeyQ3(params.state, legalAction)] !== undefined,
      ).length,
      reliableLegalActions: params.legalActions.filter((legalAction) =>
        isReliableQ5Action({ ...params, key: getLearningQTableKeyQ3(params.state, legalAction) }),
      ).length,
    }
  }

  const reliableActions = params.legalActions.filter((action) =>
    isReliableQ5Action({ ...params, key: getLearningQTableKeyQ3(params.state, action) }),
  )
  if (reliableActions.length > 0) {
    let bestValue = -Infinity
    const bestActions: PlayerAction[] = []
    for (const action of reliableActions) {
      const value = params.qTable[getLearningQTableKeyQ3(params.state, action)] ?? 0
      if (value > bestValue) {
        bestValue = value
        bestActions.length = 0
        bestActions.push(action)
      } else if (value === bestValue) {
        bestActions.push(action)
      }
    }
    const action = bestActions[Math.floor(params.rng() * bestActions.length)]!
    const key = getLearningQTableKeyQ3(params.state, action)
    return {
      action,
      mechanism: 'qReliable',
      selectedKeyExists: params.qTable[key] !== undefined,
      selectedKeyReliable: true,
      knownLegalActions: params.legalActions.filter(
        (legalAction) => params.qTable[getLearningQTableKeyQ3(params.state, legalAction)] !== undefined,
      ).length,
      reliableLegalActions: reliableActions.length,
    }
  }

  const action = chooseHeuristicOpponentActionQ4(params.state, params.rng)
  const key = getLearningQTableKeyQ3(params.state, action)
  return {
    action,
    mechanism: 'heuristicFallback',
    selectedKeyExists: params.qTable[key] !== undefined,
    selectedKeyReliable: false,
    knownLegalActions: params.legalActions.filter(
      (legalAction) => params.qTable[getLearningQTableKeyQ3(params.state, legalAction)] !== undefined,
    ).length,
    reliableLegalActions: 0,
  }
}

export const Q5_THRESHOLD_POLICY_VARIANTS: Q5ThresholdPolicyVariant[] = [
  { id: 'A', minConfidence: 3, minMargin: 0 },
  { id: 'B', minConfidence: 3, minMargin: 0.25 },
  { id: 'C', minConfidence: 5, minMargin: 0.25 },
  { id: 'D', minConfidence: 5, minMargin: 0.5 },
  { id: 'E', minConfidence: 10, minMargin: 0.5 },
]

function getQ5CombinedConfidence(
  key: string,
  confidenceMap: Map<string, Q5StateActionConfidence>,
  qLearningUpdateCounts: Map<string, number>,
): number {
  return Math.max(confidenceMap.get(key)?.observations ?? 0, qLearningUpdateCounts.get(key) ?? 0)
}

function actionSignature(action: PlayerAction): string {
  return JSON.stringify(action)
}

export function chooseThresholdHybridQ5Action(params: {
  state: GameSnapshot
  legalActions: PlayerAction[]
  qTable: QTableSnapshot
  confidenceMap: Map<string, Q5StateActionConfidence>
  qLearningUpdateCounts: Map<string, number>
  variant: Q5ThresholdPolicyVariant
  rng: () => number
}): Q5ThresholdChoice {
  const heuristicAction = chooseHeuristicOpponentActionQ4(params.state, params.rng)
  const heuristicKey = getLearningQTableKeyQ3(params.state, heuristicAction)
  let bestQ = -Infinity
  const bestActions: PlayerAction[] = []
  for (const action of params.legalActions) {
    const value = params.qTable[getLearningQTableKeyQ3(params.state, action)] ?? 0
    if (value > bestQ) {
      bestQ = value
      bestActions.length = 0
      bestActions.push(action)
    } else if (value === bestQ) {
      bestActions.push(action)
    }
  }
  const qAction = bestActions[Math.floor(params.rng() * bestActions.length)]!
  const qKey = getLearningQTableKeyQ3(params.state, qAction)
  const heuristicQ = params.qTable[heuristicKey] ?? 0
  const qConfidence = getQ5CombinedConfidence(qKey, params.confidenceMap, params.qLearningUpdateCounts)
  const margin = bestQ - heuristicQ
  const heuristicMatchesQ = actionSignature(heuristicAction) === actionSignature(qAction)

  if (heuristicMatchesQ) {
    return {
      action: heuristicAction,
      heuristicAction,
      qAction,
      mechanism: 'heuristicMatch',
      heuristicKey,
      qKey,
      heuristicQ,
      bestQ,
      qConfidence,
      margin,
    }
  }

  const accepted =
    qConfidence >= params.variant.minConfidence && margin >= params.variant.minMargin
  return {
    action: accepted ? qAction : heuristicAction,
    heuristicAction,
    qAction,
    mechanism: accepted ? 'qOverrideAccepted' : 'qOverrideRejected',
    heuristicKey,
    qKey,
    heuristicQ,
    bestQ,
    qConfidence,
    margin,
  }
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
  qLearningUpdateCounts?: Map<string, number>
  game: number
  opponent: Q5OpponentKind
  color: Player
  turn: number
  rewardComponent: 'intermediate' | 'final'
  initialQTableKeys?: ReadonlySet<string>
  inheritedAlphaMultiplier?: number
}): Q5UpdateLogEntry {
  const key = getLearningQTableKeyQ3(params.state, params.action)
  const [stateKey, actionKey] = key.split('|||')
  const currentQ = params.qTable[key] ?? 0
  const maxNextQ = getMaxQValueQ5(params.nextState, params.qTable, params.terminal)
  const target = params.reward + params.gamma * maxNextQ
  const confidence = getInstrumentedConfidence(key, params.confidenceMap)
  const inheritedFromInitialCheckpoint = params.initialQTableKeys?.has(key) ?? false
  const alpha =
    inheritedFromInitialCheckpoint && params.inheritedAlphaMultiplier !== undefined
      ? confidence.alpha * params.inheritedAlphaMultiplier
      : confidence.alpha
  const rawDelta = alpha * (target - currentQ)
  const appliedDelta = clamp(rawDelta, -1, 1)
  const newQ = currentQ + appliedDelta
  params.qTable[key] = newQ
  params.qLearningUpdateCounts?.set(key, (params.qLearningUpdateCounts.get(key) ?? 0) + 1)

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
    delta: roundMetric(appliedDelta),
    newQ: roundMetric(newQ),
    alpha,
    baseAlpha: confidence.alpha,
    inheritedFrequency: confidence.observations,
    confidence: confidence.confidence,
    entryOrigin: inheritedFromInitialCheckpoint ? 'inherited' : 'new',
    inheritedFromInitialCheckpoint,
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

function createInheritedVsNewBucket(): Q5InheritedVsNewUpdateSummaryBucket & {
  absDeltaTotal: number
  rewardTotal: number
} {
  return {
    updates: 0,
    positiveUpdates: 0,
    negativeUpdates: 0,
    zeroUpdates: 0,
    alphaDistribution: {},
    meanAbsDelta: 0,
    maxAbsDelta: 0,
    meanReward: 0,
    finalRewardUpdates: 0,
    intermediateRewardUpdates: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    absDeltaTotal: 0,
    rewardTotal: 0,
  }
}

function summarizeInheritedVsNewUpdates(
  logs: Q5UpdateLogEntry[],
  inheritedAlphaMultiplier: number,
): Q5InheritedVsNewUpdateSummary {
  const inherited = createInheritedVsNewBucket()
  const fresh = createInheritedVsNewBucket()

  for (const log of logs) {
    const bucket = log.entryOrigin === 'inherited' ? inherited : fresh
    bucket.updates++
    if (log.delta > 0) bucket.positiveUpdates++
    else if (log.delta < 0) bucket.negativeUpdates++
    else bucket.zeroUpdates++
    bucket.alphaDistribution[String(log.alpha)] = (bucket.alphaDistribution[String(log.alpha)] ?? 0) + 1
    const absDelta = Math.abs(log.delta)
    bucket.absDeltaTotal += absDelta
    bucket.maxAbsDelta = Math.max(bucket.maxAbsDelta, absDelta)
    bucket.rewardTotal += log.reward
    if (log.rewardComponent === 'final') bucket.finalRewardUpdates++
    else bucket.intermediateRewardUpdates++
    if (log.finalResultForQ5 === 'win') bucket.wins++
    else if (log.finalResultForQ5 === 'loss') bucket.losses++
    else if (log.finalResultForQ5 === 'tie') bucket.ties++
  }

  const finalize = (
    bucket: Q5InheritedVsNewUpdateSummaryBucket & { absDeltaTotal: number; rewardTotal: number },
  ): Q5InheritedVsNewUpdateSummaryBucket => ({
    updates: bucket.updates,
    positiveUpdates: bucket.positiveUpdates,
    negativeUpdates: bucket.negativeUpdates,
    zeroUpdates: bucket.zeroUpdates,
    alphaDistribution: bucket.alphaDistribution,
    meanAbsDelta: bucket.updates ? roundMetric(bucket.absDeltaTotal / bucket.updates) : 0,
    maxAbsDelta: roundMetric(bucket.maxAbsDelta),
    meanReward: bucket.updates ? roundMetric(bucket.rewardTotal / bucket.updates) : 0,
    finalRewardUpdates: bucket.finalRewardUpdates,
    intermediateRewardUpdates: bucket.intermediateRewardUpdates,
    wins: bucket.wins,
    losses: bucket.losses,
    ties: bucket.ties,
  })

  return {
    inheritedAlphaMultiplier,
    inherited: finalize(inherited),
    new: finalize(fresh),
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

export function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(path.resolve(filePath))).digest('hex')
}

export function qTableFingerprint(qTable: QTableSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.fromEntries(Object.entries(qTable).sort(([left], [right]) => left.localeCompare(right))),
      ),
    )
    .digest('hex')
}

export function loadQUpdateCountsFromJsonl(logPath: string | string[] | undefined): Map<string, number> {
  const counts = new Map<string, number>()
  const logPaths = Array.isArray(logPath) ? logPath : logPath ? [logPath] : []
  for (const currentPath of logPaths) {
    if (!existsSync(path.resolve(currentPath))) continue
    const text = readFileSync(path.resolve(currentPath), 'utf8').trim()
    if (!text) continue
    for (const line of text.split('\n')) {
      const entry = JSON.parse(line) as { stateActionKey?: string }
      if (entry.stateActionKey) counts.set(entry.stateActionKey, (counts.get(entry.stateActionKey) ?? 0) + 1)
    }
  }
  return counts
}

function csvEscape(value: string | number | boolean): string {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
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

function primaryHybridMechanism(stats: Q5HybridDecisionStats | undefined): Q5HybridDecisionMechanism {
  if (!stats) return 'qReliable'
  const entries = Object.entries(stats) as Array<[Q5HybridDecisionMechanism, number]>
  return entries.sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'qReliable'
}

function summarizeHybridPolicy(
  games: Q5GameRecord[],
  confidenceThreshold: number,
): Q5TrainingSummary['hybridPolicy'] {
  const decisions = createHybridDecisionStats()
  const resultsByPrimaryDecisionMechanism: Record<Q5HybridDecisionMechanism, ResultStats> = {
    qReliable: createResultStats(),
    heuristicFallback: createResultStats(),
    randomExploration: createResultStats(),
  }
  for (const game of games) {
    if (!game.hybridDecisions) continue
    decisions.qReliable += game.hybridDecisions.qReliable
    decisions.heuristicFallback += game.hybridDecisions.heuristicFallback
    decisions.randomExploration += game.hybridDecisions.randomExploration
    addResult(resultsByPrimaryDecisionMechanism[primaryHybridMechanism(game.hybridDecisions)], game.resultForQ5)
  }
  const total = decisions.qReliable + decisions.heuristicFallback + decisions.randomExploration
  return {
    confidenceThreshold,
    decisions,
    decisionPercentages: {
      qReliable: total ? roundMetric((decisions.qReliable / total) * 100) : 0,
      heuristicFallback: total ? roundMetric((decisions.heuristicFallback / total) * 100) : 0,
      randomExploration: total ? roundMetric((decisions.randomExploration / total) * 100) : 0,
    },
    resultsByPrimaryDecisionMechanism,
  }
}

export function primaryThresholdMechanism(
  stats: Q5ThresholdDecisionStats | undefined,
): 'heuristicMatch' | 'qOverrideAccepted' | 'qOverrideRejected' | 'randomExploration' {
  if (!stats) return 'heuristicMatch'
  if (stats.randomExploration > 0) return 'randomExploration'
  if (stats.qOverridesAccepted > 0) return 'qOverrideAccepted'
  if (stats.matches > 0) return 'heuristicMatch'
  if (stats.qOverridesRejected > 0) return 'qOverrideRejected'
  return 'heuristicMatch'
}

function summarizeThresholdPolicy(
  games: Q5GameRecord[],
  variant: Q5ThresholdPolicyVariant,
): Q5TrainingSummary['thresholdPolicy'] {
  const decisions = createThresholdDecisionStats()
  const resultsByPrimaryDecisionMechanism = {
    heuristicMatch: createResultStats(),
    qOverrideAccepted: createResultStats(),
    qOverrideRejected: createResultStats(),
    randomExploration: createResultStats(),
  }
  for (const game of games) {
    if (!game.thresholdDecisions) continue
    decisions.matches += game.thresholdDecisions.matches
    decisions.qOverridesAccepted += game.thresholdDecisions.qOverridesAccepted
    decisions.qOverridesRejected += game.thresholdDecisions.qOverridesRejected
    decisions.randomExploration += game.thresholdDecisions.randomExploration
    addResult(
      resultsByPrimaryDecisionMechanism[primaryThresholdMechanism(game.thresholdDecisions)],
      game.resultForQ5,
    )
  }
  const total =
    decisions.matches +
    decisions.qOverridesAccepted +
    decisions.qOverridesRejected +
    decisions.randomExploration
  const qExecuted = decisions.matches + decisions.qOverridesAccepted
  const heuristicExecuted = decisions.matches + decisions.qOverridesRejected
  return {
    variant,
    decisions,
    decisionPercentages: {
      matches: total ? roundMetric((decisions.matches / total) * 100) : 0,
      qOverridesAccepted: total ? roundMetric((decisions.qOverridesAccepted / total) * 100) : 0,
      qOverridesRejected: total ? roundMetric((decisions.qOverridesRejected / total) * 100) : 0,
      randomExploration: total ? roundMetric((decisions.randomExploration / total) * 100) : 0,
      qExecuted: total ? roundMetric((qExecuted / total) * 100) : 0,
      heuristicExecuted: total ? roundMetric((heuristicExecuted / total) * 100) : 0,
    },
    resultsByPrimaryDecisionMechanism,
  }
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
  hybridPolicy: boolean
  confidenceThreshold: number
  thresholdPolicy?: Q5ThresholdPolicyVariant
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
    ...(params.hybridPolicy
      ? { hybridPolicy: summarizeHybridPolicy(params.games, params.confidenceThreshold) }
      : {}),
    ...(params.thresholdPolicy
      ? { thresholdPolicy: summarizeThresholdPolicy(params.games, params.thresholdPolicy) }
      : {}),
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

interface Q5HybridEvaluationGameResult {
  rival: Q5OpponentKind
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
  qHits: number
  qMisses: number
  hybridDecisions: Q5HybridDecisionStats
  qTableChangedDuringEvaluation: boolean
}

interface Q5HybridEvaluationRivalSummary {
  rival: Q5OpponentKind
  games: number
  wins: number
  losses: number
  ties: number
  winRate: number
  byColor: Record<Player, { games: number; wins: number; losses: number; ties: number; winRate: number }>
  averageTerritoryQ5: number
  averageTerritoryRival: number
  averageTerritorialDiff: number
  averageTurns: number
  qHits: number
  qMisses: number
  qHitRate: number
  hybridDecisions: Q5HybridDecisionStats
  hybridDecisionPercentages: Q5HybridDecisionStats
  qTableChangedDuringEvaluation: boolean
  hashBefore: string
  hashAfter: string
}

async function runSingleHybridEvaluationGame(params: {
  rival: Q5OpponentKind
  game: number
  seed: number
  q5Color: Player
  qTable: QTableSnapshot
  qTablePath: string
  initialFileHash: string
  initialFingerprint: string
  maxTurns: number
  confidenceMap: Map<string, Q5StateActionConfidence>
  qLearningUpdateCounts: Map<string, number>
  confidenceThreshold: number
}): Promise<Q5HybridEvaluationGameResult> {
  const rng = createSeededRngQ4(params.seed)
  let state = makeInitialState()
  let turns = 0
  let qHits = 0
  let qMisses = 0
  const hybridDecisions = createHybridDecisionStats()

  while (state.phase !== 'finished' && !state.result && turns < params.maxTurns) {
    const previousState = snapshotFromState(state)
    let action: PlayerAction
    if (previousState.turn === params.q5Color) {
      const choice = chooseHybridQ5Action({
        state: previousState,
        legalActions: ai.getLegalActions(previousState),
        qTable: params.qTable,
        confidenceMap: params.confidenceMap,
        qLearningUpdateCounts: params.qLearningUpdateCounts,
        confidenceThreshold: params.confidenceThreshold,
        epsilon: 0,
        rng,
      })
      action = choice.action
      addHybridDecision(hybridDecisions, choice.mechanism)
      if (choice.selectedKeyExists) qHits++
      else qMisses++
    } else if (params.rival === 'random') {
      action = chooseRandomActionWithRngQ4(ai.getLegalActions(previousState), rng)
    } else {
      action = chooseHeuristicOpponentActionQ4(previousState, rng)
    }
    const applied = applyFullActionQ5(state, action)
    state = applied.state
    turns += applied.turns
  }

  state = finalizeGameIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')
  const rivalColor = getOpponent(params.q5Color)
  return {
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
    qHits,
    qMisses,
    hybridDecisions,
    qTableChangedDuringEvaluation:
      hashFile(params.qTablePath) !== params.initialFileHash ||
      qTableFingerprint(params.qTable) !== params.initialFingerprint,
  }
}

function summarizeHybridEvaluationRival(
  rival: Q5OpponentKind,
  results: Q5HybridEvaluationGameResult[],
  hashBefore: string,
  hashAfter: string,
): Q5HybridEvaluationRivalSummary {
  const wins = results.filter((result) => result.q5Won).length
  const ties = results.filter((result) => result.tie).length
  const losses = results.length - wins - ties
  const qHits = results.reduce((sum, result) => sum + result.qHits, 0)
  const qMisses = results.reduce((sum, result) => sum + result.qMisses, 0)
  const hybridDecisions = createHybridDecisionStats()
  for (const result of results) {
    hybridDecisions.qReliable += result.hybridDecisions.qReliable
    hybridDecisions.heuristicFallback += result.hybridDecisions.heuristicFallback
    hybridDecisions.randomExploration += result.hybridDecisions.randomExploration
  }
  const decisionTotal =
    hybridDecisions.qReliable + hybridDecisions.heuristicFallback + hybridDecisions.randomExploration
  return {
    rival,
    games: results.length,
    wins,
    losses,
    ties,
    winRate: roundMetric((wins / results.length) * 100),
    byColor: Object.fromEntries(
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
    ) as Q5HybridEvaluationRivalSummary['byColor'],
    averageTerritoryQ5: roundMetric(
      results.reduce((sum, result) => sum + result.territoryQ5, 0) / results.length,
    ),
    averageTerritoryRival: roundMetric(
      results.reduce((sum, result) => sum + result.territoryRival, 0) / results.length,
    ),
    averageTerritorialDiff: roundMetric(
      results.reduce((sum, result) => sum + result.territorialDiff, 0) / results.length,
    ),
    averageTurns: roundMetric(results.reduce((sum, result) => sum + result.turns, 0) / results.length),
    qHits,
    qMisses,
    qHitRate: qHits + qMisses ? roundMetric((qHits / (qHits + qMisses)) * 100) : 0,
    hybridDecisions,
    hybridDecisionPercentages: {
      qReliable: decisionTotal ? roundMetric((hybridDecisions.qReliable / decisionTotal) * 100) : 0,
      heuristicFallback: decisionTotal
        ? roundMetric((hybridDecisions.heuristicFallback / decisionTotal) * 100)
        : 0,
      randomExploration: decisionTotal
        ? roundMetric((hybridDecisions.randomExploration / decisionTotal) * 100)
        : 0,
    },
    qTableChangedDuringEvaluation:
      results.some((result) => result.qTableChangedDuringEvaluation) || hashBefore !== hashAfter,
    hashBefore,
    hashAfter,
  }
}

function hybridEvaluationResultsToCsv(results: Q5HybridEvaluationGameResult[]): string {
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
    'qReliableDecisions',
    'heuristicFallbackDecisions',
    'randomExplorationDecisions',
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
    result.hybridDecisions.qReliable,
    result.hybridDecisions.heuristicFallback,
    result.hybridDecisions.randomExploration,
    result.qTableChangedDuringEvaluation,
  ])
  return [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n')
}

export async function evaluateHybridQ5Policy(options: {
  qTablePath: string
  outputDir: string
  checkpoint: 'Q5-hybrid-initial' | 'Q5-hybrid-pilot-100'
  qUpdateLogPath?: string
  overwrite?: boolean
  confidenceThreshold?: number
}): Promise<{ summary: unknown; results: Q5HybridEvaluationGameResult[] }> {
  assertOutputCanBeWritten(options.outputDir, options.overwrite ?? false)
  const qTablePath = path.resolve(options.qTablePath)
  const outputDir = path.resolve(options.outputDir)
  const confidenceThreshold = options.confidenceThreshold ?? 3
  const qTable = Object.freeze({ ...loadQTable(qTablePath) }) as QTableSnapshot
  const qTableEntries = Object.keys(qTable).length
  const hashBefore = hashFile(qTablePath)
  const fingerprintBefore = qTableFingerprint(qTable)
  const confidenceMap = loadQ5ConfidenceMap(Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH)
  const qLearningUpdateCounts = loadQUpdateCountsFromJsonl(options.qUpdateLogPath)
  const allResults: Q5HybridEvaluationGameResult[] = []
  const experiments: Q5HybridEvaluationRivalSummary[] = []
  let globalGame = 0

  for (const rival of ['random', 'heuristic'] as const) {
    const rivalResults: Q5HybridEvaluationGameResult[] = []
    const rivalHashBefore = hashFile(qTablePath)
    for (const colorQ5 of ['R', 'B'] as const) {
      for (let game = 1; game <= 100; game++) {
        globalGame++
        const result = await runSingleHybridEvaluationGame({
          rival,
          game,
          seed: 502000 + globalGame,
          q5Color: colorQ5,
          qTable,
          qTablePath,
          initialFileHash: hashBefore,
          initialFingerprint: fingerprintBefore,
          maxTurns: 250,
          confidenceMap,
          qLearningUpdateCounts,
          confidenceThreshold,
        })
        if (result.qTableChangedDuringEvaluation) throw new Error('Q5 hybrid qTable changed during evaluation')
        rivalResults.push(result)
        allResults.push(result)
      }
    }
    experiments.push(summarizeHybridEvaluationRival(rival, rivalResults, rivalHashBefore, hashFile(qTablePath)))
  }

  const hashAfter = hashFile(qTablePath)
  const summary = {
    createdAt: new Date().toISOString(),
    model: 'Q5',
    checkpoint: options.checkpoint,
    qTablePath,
    qTableEntries,
    qTableHashBefore: hashBefore,
    qTableHashAfter: hashAfter,
    qTableChangedDuringEvaluation: hashBefore !== hashAfter || qTableFingerprint(qTable) !== fingerprintBefore,
    hybridPolicy: {
      enabled: true,
      confidenceThreshold,
      fallback: 'heuristic',
      epsilon: 0,
      qLearningUpdateCountsLoaded: qLearningUpdateCounts.size,
    },
    evaluationProtocol: {
      epsilon: 0,
      learnsDuringEvaluation: false,
      qTableFrozen: true,
      alphaUpdates: false,
      representation: 'Q3',
      rivals: ['random', 'heuristic'],
      gamesPerRival: 200,
      gamesPerColor: 100,
      maxTurns: 250,
    },
    experiments,
  }
  if (summary.qTableChangedDuringEvaluation) throw new Error('Q5 hybrid qTable changed during evaluation')

  mkdirSync(outputDir, { recursive: true })
  writeJson(path.join(outputDir, 'learning_comparison_summary.json'), summary)
  writeFileSync(
    path.join(outputDir, 'learning_comparison_results.csv'),
    `${hybridEvaluationResultsToCsv(allResults)}\n`,
    'utf8',
  )
  writeJson(path.join(outputDir, 'evaluation_metadata.json'), {
    createdAt: summary.createdAt,
    qTablePath,
    qTableEntries,
    hashBefore,
    hashAfter,
    outputDir,
    protocol: summary.evaluationProtocol,
    hybridPolicy: summary.hybridPolicy,
  })
  return { summary, results: allResults }
}

interface Q5ThresholdEvaluationGameResult {
  variant: Q5ThresholdPolicyVariant['id'] | 'heuristic'
  rival: Q5OpponentKind
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
  qHits: number
  qMisses: number
  decisions: Q5ThresholdDecisionStats
  qTableChangedDuringEvaluation: boolean
}

function createThresholdDecisionStats(): Q5ThresholdDecisionStats {
  return { matches: 0, qOverridesAccepted: 0, qOverridesRejected: 0, randomExploration: 0 }
}

function addThresholdDecision(
  stats: Q5ThresholdDecisionStats,
  mechanism: Q5ThresholdChoice['mechanism'] | 'randomExploration',
): void {
  if (mechanism === 'heuristicMatch') stats.matches++
  else if (mechanism === 'qOverrideAccepted') stats.qOverridesAccepted++
  else if (mechanism === 'qOverrideRejected') stats.qOverridesRejected++
  else stats.randomExploration++
}

function getTerritoryDiffForPlayer(state: GameSnapshot, player: Player): number {
  const territory = getTerritoryCounts(state.board)
  return territory[player] - territory[getOpponent(player)]
}

function updateQVsHeuristicDecisionHorizons(
  entries: Array<Q5VsHeuristicDecisionLogEntry & { startTurn: number }>,
  state: GameSnapshot,
  turns: number,
  learningSide: Player,
): void {
  for (const entry of entries) {
    const elapsed = turns - entry.startTurn
    const diff = getTerritoryDiffForPlayer(state, learningSide)
    if (elapsed >= 1 && entry.territoryDiffAfter1Turn === undefined) entry.territoryDiffAfter1Turn = diff
    if (elapsed >= 3 && entry.territoryDiffAfter3Turns === undefined) entry.territoryDiffAfter3Turns = diff
    if (elapsed >= 5 && entry.territoryDiffAfter5Turns === undefined) entry.territoryDiffAfter5Turns = diff
  }
}

async function runSingleThresholdEvaluationGame(params: {
  variant: Q5ThresholdPolicyVariant
  rival: Q5OpponentKind
  game: number
  seed: number
  q5Color: Player
  qTable: QTableSnapshot
  qTablePath: string
  initialFileHash: string
  initialFingerprint: string
  confidenceMap: Map<string, Q5StateActionConfidence>
  qLearningUpdateCounts: Map<string, number>
}): Promise<Q5ThresholdEvaluationGameResult> {
  const rng = createSeededRngQ4(params.seed)
  let state = makeInitialState()
  let turns = 0
  let qHits = 0
  let qMisses = 0
  const decisions = createThresholdDecisionStats()

  while (state.phase !== 'finished' && !state.result && turns < 250) {
    const previousState = snapshotFromState(state)
    let action: PlayerAction
    if (previousState.turn === params.q5Color) {
      const choice = chooseThresholdHybridQ5Action({
        state: previousState,
        legalActions: ai.getLegalActions(previousState),
        qTable: params.qTable,
        confidenceMap: params.confidenceMap,
        qLearningUpdateCounts: params.qLearningUpdateCounts,
        variant: params.variant,
        rng,
      })
      action = choice.action
      addThresholdDecision(decisions, choice.mechanism)
      if (params.qTable[getLearningQTableKeyQ3(previousState, action)] !== undefined) qHits++
      else qMisses++
    } else if (params.rival === 'random') {
      action = chooseRandomActionWithRngQ4(ai.getLegalActions(previousState), rng)
    } else {
      action = chooseHeuristicOpponentActionQ4(previousState, rng)
    }
    const applied = applyFullActionQ5(state, action)
    state = applied.state
    turns += applied.turns
  }

  state = finalizeGameIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')
  const rivalColor = getOpponent(params.q5Color)
  return {
    variant: params.variant.id,
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
    qHits,
    qMisses,
    decisions,
    qTableChangedDuringEvaluation:
      hashFile(params.qTablePath) !== params.initialFileHash ||
      qTableFingerprint(params.qTable) !== params.initialFingerprint,
  }
}

function summarizeThresholdResults(
  variant: Q5ThresholdPolicyVariant,
  results: Q5ThresholdEvaluationGameResult[],
  hashBefore: string,
  hashAfter: string,
) {
  const summarizeGroup = (groupResults: Q5ThresholdEvaluationGameResult[]) => {
    const wins = groupResults.filter((result) => result.q5Won).length
    const ties = groupResults.filter((result) => result.tie).length
    const losses = groupResults.length - wins - ties
    const decisions = createThresholdDecisionStats()
    const qHits = groupResults.reduce((sum, result) => sum + result.qHits, 0)
    const qMisses = groupResults.reduce((sum, result) => sum + result.qMisses, 0)
    for (const result of groupResults) {
      decisions.matches += result.decisions.matches
      decisions.qOverridesAccepted += result.decisions.qOverridesAccepted
      decisions.qOverridesRejected += result.decisions.qOverridesRejected
    }
    const totalDecisions =
      decisions.matches +
      decisions.qOverridesAccepted +
      decisions.qOverridesRejected +
      decisions.randomExploration
    const overrideGames = groupResults.filter((result) => result.decisions.qOverridesAccepted > 0)
    const overrideWins = overrideGames.filter((result) => result.q5Won).length
    const overrideTies = overrideGames.filter((result) => result.tie).length
    return {
      games: groupResults.length,
      wins,
      losses,
      ties,
      winRate: groupResults.length ? roundMetric((wins / groupResults.length) * 100) : 0,
      averageTerritoryQ5: groupResults.length
        ? roundMetric(groupResults.reduce((sum, result) => sum + result.territoryQ5, 0) / groupResults.length)
        : 0,
      averageTerritoryRival: groupResults.length
        ? roundMetric(groupResults.reduce((sum, result) => sum + result.territoryRival, 0) / groupResults.length)
        : 0,
      averageTerritorialDiff: groupResults.length
        ? roundMetric(groupResults.reduce((sum, result) => sum + result.territorialDiff, 0) / groupResults.length)
        : 0,
      averageTurns: groupResults.length
        ? roundMetric(groupResults.reduce((sum, result) => sum + result.turns, 0) / groupResults.length)
        : 0,
      qHits,
      qMisses,
      qHitRate: qHits + qMisses ? roundMetric((qHits / (qHits + qMisses)) * 100) : 0,
      decisions,
      decisionPercentages: {
        matches: totalDecisions ? roundMetric((decisions.matches / totalDecisions) * 100) : 0,
        qOverridesAccepted: totalDecisions
          ? roundMetric((decisions.qOverridesAccepted / totalDecisions) * 100)
          : 0,
        qOverridesRejected: totalDecisions
          ? roundMetric((decisions.qOverridesRejected / totalDecisions) * 100)
          : 0,
        randomExploration: totalDecisions
          ? roundMetric((decisions.randomExploration / totalDecisions) * 100)
          : 0,
      },
      overrideGames: {
        games: overrideGames.length,
        wins: overrideWins,
        losses: overrideGames.length - overrideWins - overrideTies,
        ties: overrideTies,
        winRate: overrideGames.length ? roundMetric((overrideWins / overrideGames.length) * 100) : 0,
      },
    }
  }

  return {
    variant,
    aggregate: summarizeGroup(results),
    byRival: {
      random: summarizeGroup(results.filter((result) => result.rival === 'random')),
      heuristic: summarizeGroup(results.filter((result) => result.rival === 'heuristic')),
    },
    byColor: {
      R: summarizeGroup(results.filter((result) => result.colorQ5 === 'R')),
      B: summarizeGroup(results.filter((result) => result.colorQ5 === 'B')),
    },
    qTableChangedDuringEvaluation:
      results.some((result) => result.qTableChangedDuringEvaluation) || hashBefore !== hashAfter,
    hashBefore,
    hashAfter,
  }
}

function thresholdResultsToCsv(results: Q5ThresholdEvaluationGameResult[]): string {
  const headers = [
    'variant',
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
    'matches',
    'qOverridesAccepted',
    'qOverridesRejected',
    'randomExploration',
    'qTableChangedDuringEvaluation',
  ]
  const rows = results.map((result) => [
    result.variant,
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
    result.decisions.matches,
    result.decisions.qOverridesAccepted,
    result.decisions.qOverridesRejected,
    result.decisions.randomExploration,
    result.qTableChangedDuringEvaluation,
  ])
  return [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n')
}

export async function evaluateQ5ThresholdSearch(options: {
  outputDir?: string
  overwrite?: boolean
} = {}): Promise<{ summary: unknown; results: Q5ThresholdEvaluationGameResult[] }> {
  const outputDir = path.resolve(options.outputDir ?? Q5_HYBRID_THRESHOLD_SEARCH_DIR)
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)
  const qTablePath = path.resolve(Q5_HEURISTIC_INITIAL_QTABLE_PATH)
  const qTable = Object.freeze({ ...loadQTable(qTablePath) }) as QTableSnapshot
  const hashBefore = hashFile(qTablePath)
  const fingerprintBefore = qTableFingerprint(qTable)
  const confidenceMap = loadQ5ConfidenceMap(Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH)
  const qLearningUpdateCounts = new Map<string, number>()
  const allResults: Q5ThresholdEvaluationGameResult[] = []
  const variantSummaries = []
  let globalGame = 0

  for (const variant of Q5_THRESHOLD_POLICY_VARIANTS) {
    const variantResults: Q5ThresholdEvaluationGameResult[] = []
    const variantHashBefore = hashFile(qTablePath)
    for (const rival of ['random', 'heuristic'] as const) {
      for (const colorQ5 of ['R', 'B'] as const) {
        for (let game = 1; game <= 100; game++) {
          globalGame++
          const result = await runSingleThresholdEvaluationGame({
            variant,
            rival,
            game,
            seed: 502000 + globalGame,
            q5Color: colorQ5,
            qTable,
            qTablePath,
            initialFileHash: hashBefore,
            initialFingerprint: fingerprintBefore,
            confidenceMap,
            qLearningUpdateCounts,
          })
          if (result.qTableChangedDuringEvaluation) {
            throw new Error('Q5 threshold search qTable changed during evaluation')
          }
          variantResults.push(result)
          allResults.push(result)
        }
      }
    }
    variantSummaries.push(summarizeThresholdResults(variant, variantResults, variantHashBefore, hashFile(qTablePath)))
  }

  const hashAfter = hashFile(qTablePath)
  const summary = {
    createdAt: new Date().toISOString(),
    model: 'Q5',
    experiment: 'hybrid_threshold_search',
    qTablePath,
    qTableEntries: Object.keys(qTable).length,
    qTableHashBefore: hashBefore,
    qTableHashAfter: hashAfter,
    qTableChangedDuringEvaluation: hashBefore !== hashAfter || qTableFingerprint(qTable) !== fingerprintBefore,
    confidenceDefinition: {
      value: 'max(originalDatasetObservations, qLearningUpdatesAfterInitialization)',
      originalDatasetObservations: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      qLearningUpdatesAfterInitialization: 'none loaded for this frozen initial-table search',
    },
    protocol: {
      epsilon: 0,
      learnsDuringEvaluation: false,
      qTableFrozen: true,
      alphaUpdates: false,
      representation: 'Q3',
      seedBase: 502000,
      gamesPerVariant: 400,
      gamesPerRival: 200,
      gamesPerColor: 100,
      maxTurns: 250,
    },
    variants: variantSummaries,
  }
  if (summary.qTableChangedDuringEvaluation) {
    throw new Error('Q5 threshold search qTable changed during evaluation')
  }

  mkdirSync(outputDir, { recursive: true })
  writeJson(path.join(outputDir, 'threshold_search_summary.json'), summary)
  writeFileSync(path.join(outputDir, 'threshold_search_results.csv'), `${thresholdResultsToCsv(allResults)}\n`, 'utf8')
  writeJson(path.join(outputDir, 'metadata.json'), {
    createdAt: summary.createdAt,
    qTablePath,
    outputDir,
    confidenceDefinition: summary.confidenceDefinition,
    protocol: summary.protocol,
  })
  return { summary, results: allResults }
}

function summarizeExtendedThresholdGroup(groupResults: Q5ThresholdEvaluationGameResult[]) {
  const wins = groupResults.filter((result) => result.q5Won).length
  const ties = groupResults.filter((result) => result.tie).length
  const losses = groupResults.length - wins - ties
  const decisions = createThresholdDecisionStats()
  for (const result of groupResults) {
    decisions.matches += result.decisions.matches
    decisions.qOverridesAccepted += result.decisions.qOverridesAccepted
    decisions.qOverridesRejected += result.decisions.qOverridesRejected
  }
  const totalDecisions =
    decisions.matches +
    decisions.qOverridesAccepted +
    decisions.qOverridesRejected +
    decisions.randomExploration
  const qExecutedDecisions = decisions.matches + decisions.qOverridesAccepted
  const overrideGames = groupResults.filter((result) => result.decisions.qOverridesAccepted > 0)
  const overrideWins = overrideGames.filter((result) => result.q5Won).length
  const overrideTies = overrideGames.filter((result) => result.tie).length
  return {
    games: groupResults.length,
    wins,
    losses,
    ties,
    winRate: groupResults.length ? roundMetric((wins / groupResults.length) * 100) : 0,
    averageTerritoryQ5: groupResults.length
      ? roundMetric(groupResults.reduce((sum, result) => sum + result.territoryQ5, 0) / groupResults.length)
      : 0,
    averageTerritoryRival: groupResults.length
      ? roundMetric(groupResults.reduce((sum, result) => sum + result.territoryRival, 0) / groupResults.length)
      : 0,
    averageTerritorialDiff: groupResults.length
      ? roundMetric(groupResults.reduce((sum, result) => sum + result.territorialDiff, 0) / groupResults.length)
      : 0,
    averageTurns: groupResults.length
      ? roundMetric(groupResults.reduce((sum, result) => sum + result.turns, 0) / groupResults.length)
      : 0,
    decisions,
    qExecutedDecisions,
    decisionPercentages: {
      matches: totalDecisions ? roundMetric((decisions.matches / totalDecisions) * 100) : 0,
      qOverridesAccepted: totalDecisions
        ? roundMetric((decisions.qOverridesAccepted / totalDecisions) * 100)
        : 0,
      qOverridesRejected: totalDecisions
        ? roundMetric((decisions.qOverridesRejected / totalDecisions) * 100)
        : 0,
      randomExploration: totalDecisions
        ? roundMetric((decisions.randomExploration / totalDecisions) * 100)
        : 0,
      qExecuted: totalDecisions ? roundMetric((qExecutedDecisions / totalDecisions) * 100) : 0,
    },
    overrideGames: {
      games: overrideGames.length,
      wins: overrideWins,
      losses: overrideGames.length - overrideWins - overrideTies,
      ties: overrideTies,
      winRate: overrideGames.length ? roundMetric((overrideWins / overrideGames.length) * 100) : 0,
    },
  }
}

function summarizeBlockVariability(values: number[]) {
  if (values.length === 0) return { mean: 0, min: 0, max: 0, standardDeviation: 0 }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return {
    mean: roundMetric(mean),
    min: roundMetric(Math.min(...values)),
    max: roundMetric(Math.max(...values)),
    standardDeviation: roundMetric(Math.sqrt(variance)),
  }
}

function summarizeExtendedThresholdVariant(
  variant: Q5ThresholdPolicyVariant | { id: 'heuristic'; minConfidence: null; minMargin: null },
  results: Q5ThresholdEvaluationGameResult[],
  seedBase = 702000,
) {
  const blockSummaries = [1, 2, 3, 4, 5].map((block) => {
    const blockResults = results.filter(
      (result) => Math.floor((result.seed - seedBase - 1) / 400) + 1 === block,
    )
    return {
      block,
      seedStart: seedBase + (block - 1) * 400 + 1,
      seedEnd: seedBase + block * 400,
      aggregate: summarizeExtendedThresholdGroup(blockResults),
      byRival: {
        random: summarizeExtendedThresholdGroup(blockResults.filter((result) => result.rival === 'random')),
        heuristic: summarizeExtendedThresholdGroup(
          blockResults.filter((result) => result.rival === 'heuristic'),
        ),
      },
      byColor: {
        R: summarizeExtendedThresholdGroup(blockResults.filter((result) => result.colorQ5 === 'R')),
        B: summarizeExtendedThresholdGroup(blockResults.filter((result) => result.colorQ5 === 'B')),
      },
    }
  })
  return {
    variant,
    aggregate: summarizeExtendedThresholdGroup(results),
    byRival: {
      random: summarizeExtendedThresholdGroup(results.filter((result) => result.rival === 'random')),
      heuristic: summarizeExtendedThresholdGroup(results.filter((result) => result.rival === 'heuristic')),
    },
    byColor: {
      R: summarizeExtendedThresholdGroup(results.filter((result) => result.colorQ5 === 'R')),
      B: summarizeExtendedThresholdGroup(results.filter((result) => result.colorQ5 === 'B')),
    },
    blocks: blockSummaries,
    variability: {
      randomWinRate: summarizeBlockVariability(
        blockSummaries.map((block) => block.byRival.random.winRate),
      ),
      heuristicWinRate: summarizeBlockVariability(
        blockSummaries.map((block) => block.byRival.heuristic.winRate),
      ),
      heuristicTerritorialDiff: summarizeBlockVariability(
        blockSummaries.map((block) => block.byRival.heuristic.averageTerritorialDiff),
      ),
    },
  }
}

async function runSingleHeuristicControlEvaluationGame(params: {
  seed: number
  rival: Q5OpponentKind
  game: number
  q5Color: Player
}): Promise<Q5ThresholdEvaluationGameResult> {
  const rng = createSeededRngQ4(params.seed)
  let state = makeInitialState()
  let turns = 0
  while (state.phase !== 'finished' && !state.result && turns < 250) {
    const previousState = snapshotFromState(state)
    const action =
      previousState.turn === params.q5Color
        ? chooseHeuristicOpponentActionQ4(previousState, rng)
        : params.rival === 'random'
          ? chooseRandomActionWithRngQ4(ai.getLegalActions(previousState), rng)
          : chooseHeuristicOpponentActionQ4(previousState, rng)
    const applied = applyFullActionQ5(state, action)
    state = applied.state
    turns += applied.turns
  }

  state = finalizeGameIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')
  const rivalColor = getOpponent(params.q5Color)
  return {
    variant: 'heuristic',
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
    qHits: 0,
    qMisses: 0,
    decisions: createThresholdDecisionStats(),
    qTableChangedDuringEvaluation: false,
  }
}

export async function evaluateQ5ThresholdValidationExtended(options: {
  outputDir?: string
  overwrite?: boolean
} = {}): Promise<{ summary: unknown; results: Q5ThresholdEvaluationGameResult[] }> {
  const outputDir = path.resolve(options.outputDir ?? Q5_HYBRID_THRESHOLD_VALIDATION_EXTENDED_DIR)
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)
  const qTablePath = path.resolve(Q5_HEURISTIC_INITIAL_QTABLE_PATH)
  const qTable = Object.freeze({ ...loadQTable(qTablePath) }) as QTableSnapshot
  const hashBefore = hashFile(qTablePath)
  const fingerprintBefore = qTableFingerprint(qTable)
  const confidenceMap = loadQ5ConfidenceMap(Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH)
  const qLearningUpdateCounts = new Map<string, number>()
  const selectedVariants = Q5_THRESHOLD_POLICY_VARIANTS.filter((variant) =>
    ['A', 'D', 'E'].includes(variant.id),
  )
  const allResults: Q5ThresholdEvaluationGameResult[] = []
  const variantSummaries = []

  for (const variant of selectedVariants) {
    const variantResults: Q5ThresholdEvaluationGameResult[] = []
    for (let block = 1; block <= 5; block++) {
      let gameInBlock = 0
      for (const rival of ['random', 'heuristic'] as const) {
        for (const colorQ5 of ['R', 'B'] as const) {
          for (let game = 1; game <= 100; game++) {
            gameInBlock++
            const seed = 702000 + (block - 1) * 400 + gameInBlock
            const result = await runSingleThresholdEvaluationGame({
              variant,
              rival,
              game,
              seed,
              q5Color: colorQ5,
              qTable,
              qTablePath,
              initialFileHash: hashBefore,
              initialFingerprint: fingerprintBefore,
              confidenceMap,
              qLearningUpdateCounts,
            })
            if (result.qTableChangedDuringEvaluation) {
              throw new Error('Q5 extended threshold validation qTable changed during evaluation')
            }
            variantResults.push(result)
            allResults.push(result)
          }
        }
      }
    }
    variantSummaries.push(summarizeExtendedThresholdVariant(variant, variantResults))
  }

  const heuristicResults: Q5ThresholdEvaluationGameResult[] = []
  for (let block = 1; block <= 5; block++) {
    let gameInBlock = 0
    for (const rival of ['random', 'heuristic'] as const) {
      for (const colorQ5 of ['R', 'B'] as const) {
        for (let game = 1; game <= 100; game++) {
          gameInBlock++
          const result = await runSingleHeuristicControlEvaluationGame({
            rival,
            game,
            seed: 702000 + (block - 1) * 400 + gameInBlock,
            q5Color: colorQ5,
          })
          heuristicResults.push(result)
          allResults.push(result)
        }
      }
    }
  }
  variantSummaries.push(
    summarizeExtendedThresholdVariant(
      { id: 'heuristic', minConfidence: null, minMargin: null },
      heuristicResults,
    ),
  )

  const hashAfter = hashFile(qTablePath)
  const summary = {
    createdAt: new Date().toISOString(),
    model: 'Q5',
    experiment: 'hybrid_threshold_validation_extended',
    qTablePath,
    qTableEntries: Object.keys(qTable).length,
    qTableHashBefore: hashBefore,
    qTableHashAfter: hashAfter,
    qTableChangedDuringEvaluation: hashBefore !== hashAfter || qTableFingerprint(qTable) !== fingerprintBefore,
    confidenceDefinition: {
      value: 'max(originalDatasetObservations, qLearningUpdatesAfterInitialization)',
      originalDatasetObservations: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      qLearningUpdatesAfterInitialization: 'none loaded for this frozen initial-table validation',
    },
    protocol: {
      epsilon: 0,
      learnsDuringEvaluation: false,
      qTableFrozen: true,
      alphaUpdates: false,
      representation: 'Q3',
      seedBase: 702000,
      blocks: 5,
      gamesPerBlock: 400,
      gamesPerVariant: 2000,
      gamesPerRival: 1000,
      gamesPerColorPerRival: 500,
      maxTurns: 250,
      variants: selectedVariants,
      controls: ['heuristic'],
    },
    variants: variantSummaries,
  }
  if (summary.qTableChangedDuringEvaluation) {
    throw new Error('Q5 extended threshold validation qTable changed during evaluation')
  }

  mkdirSync(outputDir, { recursive: true })
  writeJson(path.join(outputDir, 'threshold_validation_extended_summary.json'), summary)
  writeFileSync(
    path.join(outputDir, 'threshold_validation_extended_results.csv'),
    `${thresholdResultsToCsv(allResults)}\n`,
    'utf8',
  )
  writeJson(path.join(outputDir, 'metadata.json'), {
    createdAt: summary.createdAt,
    qTablePath,
    outputDir,
    confidenceDefinition: summary.confidenceDefinition,
    protocol: summary.protocol,
  })
  return { summary, results: allResults }
}

export async function evaluateQ5HybridFinalCheckpoint500(options: {
  qTablePath?: string
  qUpdateLogPath?: string | string[]
  outputDir?: string
  overwrite?: boolean
  checkpoint?: 'Q5-hybrid-final-500' | 'Q5-hybrid-final-1000'
} = {}): Promise<{ summary: unknown; results: Q5ThresholdEvaluationGameResult[] }> {
  const outputDir = path.resolve(options.outputDir ?? Q5_HYBRID_FINAL_CHECKPOINT_500_EVAL_DIR)
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)
  const qTablePath = path.resolve(
    options.qTablePath ?? path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'qtable_q5_hybrid_final_500.json'),
  )
  const qTable = Object.freeze({ ...loadQTable(qTablePath) }) as QTableSnapshot
  const hashBefore = hashFile(qTablePath)
  const fingerprintBefore = qTableFingerprint(qTable)
  const confidenceMap = loadQ5ConfidenceMap(Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH)
  const qLearningUpdateCounts = loadQUpdateCountsFromJsonl(
    options.qUpdateLogPath ?? path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'q_update_log.jsonl'),
  )
  const variant: Q5ThresholdPolicyVariant = { id: 'E', minConfidence: 10, minMargin: 0.5 }
  const allResults: Q5ThresholdEvaluationGameResult[] = []
  let globalGame = 0

  for (const rival of ['random', 'heuristic'] as const) {
    for (const colorQ5 of ['R', 'B'] as const) {
      for (let game = 1; game <= 100; game++) {
        globalGame++
        const result = await runSingleThresholdEvaluationGame({
          variant,
          rival,
          game,
          seed: 502000 + globalGame,
          q5Color: colorQ5,
          qTable,
          qTablePath,
          initialFileHash: hashBefore,
          initialFingerprint: fingerprintBefore,
          confidenceMap,
          qLearningUpdateCounts,
        })
        if (result.qTableChangedDuringEvaluation) {
          throw new Error('Q5 hybrid final qTable changed during evaluation')
        }
        allResults.push(result)
      }
    }
  }

  const hashAfter = hashFile(qTablePath)
  const variantSummary = summarizeThresholdResults(variant, allResults, hashBefore, hashAfter)
  const summary = {
    createdAt: new Date().toISOString(),
    model: 'Q5',
    checkpoint: options.checkpoint ?? 'Q5-hybrid-final-500',
    qTablePath,
    qTableEntries: Object.keys(qTable).length,
    qTableHashBefore: hashBefore,
    qTableHashAfter: hashAfter,
    qTableChangedDuringEvaluation: hashBefore !== hashAfter || qTableFingerprint(qTable) !== fingerprintBefore,
    confidenceDefinition: {
      value: 'max(originalDatasetObservations, qLearningUpdatesAfterInitialization)',
      originalDatasetObservations: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      qLearningUpdatesAfterInitialization:
        options.qUpdateLogPath ?? path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'q_update_log.jsonl'),
      qLearningUpdateCountsLoaded: qLearningUpdateCounts.size,
    },
    evaluationProtocol: {
      epsilon: 0,
      learnsDuringEvaluation: false,
      qTableFrozen: true,
      alphaUpdates: false,
      representation: 'Q3',
      rivals: ['random', 'heuristic'],
      gamesPerRival: 200,
      gamesPerColor: 100,
      maxTurns: 250,
      variant,
    },
    experiments: [
      { rival: 'random', ...variantSummary.byRival.random },
      { rival: 'heuristic', ...variantSummary.byRival.heuristic },
    ],
    aggregate: variantSummary.aggregate,
    byColor: variantSummary.byColor,
  }
  if (summary.qTableChangedDuringEvaluation) {
    throw new Error('Q5 hybrid final qTable changed during evaluation')
  }

  mkdirSync(outputDir, { recursive: true })
  writeJson(path.join(outputDir, 'learning_comparison_summary.json'), summary)
  writeFileSync(
    path.join(outputDir, 'learning_comparison_results.csv'),
    `${thresholdResultsToCsv(allResults)}\n`,
    'utf8',
  )
  writeJson(path.join(outputDir, 'evaluation_metadata.json'), {
    createdAt: summary.createdAt,
    qTablePath,
    qTableEntries: Object.keys(qTable).length,
    hashBefore,
    hashAfter,
    outputDir,
    protocol: summary.evaluationProtocol,
    confidenceDefinition: summary.confidenceDefinition,
  })
  return { summary, results: allResults }
}

function extendedPairKey(result: Q5ThresholdEvaluationGameResult): string {
  return `${result.seed}|${result.rival}|${result.colorQ5}|${result.game}`
}

function pairedComparisonToCsv(rows: Array<{
  seed: number
  block: number
  rival: Q5OpponentKind
  game: number
  colorQ5: Player
  q5Winner: Player | 'tie'
  heuristicWinner: Player | 'tie'
  q5Won: boolean
  heuristicWon: boolean
  q5TerritorialDiff: number
  heuristicTerritorialDiff: number
  diffDelta: number
  q5AcceptedOverrides: number
  q5RejectedOverrides: number
}>): string {
  const headers = [
    'seed',
    'block',
    'rival',
    'game',
    'colorQ5',
    'q5Winner',
    'heuristicWinner',
    'q5Won',
    'heuristicWon',
    'q5TerritorialDiff',
    'heuristicTerritorialDiff',
    'diffDelta',
    'q5AcceptedOverrides',
    'q5RejectedOverrides',
  ]
  return [
    headers.join(','),
    ...rows.map((row) =>
      [
        row.seed,
        row.block,
        row.rival,
        row.game,
        row.colorQ5,
        row.q5Winner,
        row.heuristicWinner,
        row.q5Won,
        row.heuristicWon,
        row.q5TerritorialDiff,
        row.heuristicTerritorialDiff,
        row.diffDelta,
        row.q5AcceptedOverrides,
        row.q5RejectedOverrides,
      ]
        .map(csvEscape)
        .join(','),
    ),
  ].join('\n')
}

export async function evaluateQ5HybridFinalCheckpoint500Extended(options: {
  qTablePath?: string
  qUpdateLogPath?: string
  outputDir?: string
  overwrite?: boolean
} = {}): Promise<{ summary: unknown; results: Q5ThresholdEvaluationGameResult[] }> {
  const outputDir = path.resolve(
    options.outputDir ?? Q5_HYBRID_FINAL_CHECKPOINT_500_EXTENDED_VALIDATION_DIR,
  )
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)
  const qTablePath = path.resolve(
    options.qTablePath ?? path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'qtable_q5_hybrid_final_500.json'),
  )
  const qTable = Object.freeze({ ...loadQTable(qTablePath) }) as QTableSnapshot
  const hashBefore = hashFile(qTablePath)
  const fingerprintBefore = qTableFingerprint(qTable)
  const confidenceMap = loadQ5ConfidenceMap(Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH)
  const qUpdateLogPath =
    options.qUpdateLogPath ?? path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'q_update_log.jsonl')
  const qLearningUpdateCounts = loadQUpdateCountsFromJsonl(qUpdateLogPath)
  const variant: Q5ThresholdPolicyVariant = { id: 'E', minConfidence: 10, minMargin: 0.5 }
  const q5Results: Q5ThresholdEvaluationGameResult[] = []
  const heuristicResults: Q5ThresholdEvaluationGameResult[] = []

  for (let block = 1; block <= 5; block++) {
    let gameInBlock = 0
    for (const rival of ['random', 'heuristic'] as const) {
      for (const colorQ5 of ['R', 'B'] as const) {
        for (let game = 1; game <= 100; game++) {
          gameInBlock++
          const seed = 802000 + (block - 1) * 400 + gameInBlock
          const q5Result = await runSingleThresholdEvaluationGame({
            variant,
            rival,
            game,
            seed,
            q5Color: colorQ5,
            qTable,
            qTablePath,
            initialFileHash: hashBefore,
            initialFingerprint: fingerprintBefore,
            confidenceMap,
            qLearningUpdateCounts,
          })
          if (q5Result.qTableChangedDuringEvaluation) {
            throw new Error('Q5 hybrid final extended validation qTable changed during evaluation')
          }
          q5Results.push(q5Result)
          heuristicResults.push(
            await runSingleHeuristicControlEvaluationGame({
              rival,
              game,
              seed,
              q5Color: colorQ5,
            }),
          )
        }
      }
    }
  }

  const pairedRows = q5Results.map((q5Result) => {
    const heuristicResult = heuristicResults.find(
      (result) => extendedPairKey(result) === extendedPairKey(q5Result),
    )
    if (!heuristicResult) throw new Error('Missing paired heuristic result')
    return {
      seed: q5Result.seed,
      block: Math.floor((q5Result.seed - 802001) / 400) + 1,
      rival: q5Result.rival,
      game: q5Result.game,
      colorQ5: q5Result.colorQ5,
      q5Winner: q5Result.winner,
      heuristicWinner: heuristicResult.winner,
      q5Won: q5Result.q5Won,
      heuristicWon: heuristicResult.q5Won,
      q5TerritorialDiff: q5Result.territorialDiff,
      heuristicTerritorialDiff: heuristicResult.territorialDiff,
      diffDelta: q5Result.territorialDiff - heuristicResult.territorialDiff,
      q5AcceptedOverrides: q5Result.decisions.qOverridesAccepted,
      q5RejectedOverrides: q5Result.decisions.qOverridesRejected,
    }
  })

  const q5Summary = summarizeExtendedThresholdVariant(variant, q5Results, 802000)
  const heuristicSummary = summarizeExtendedThresholdVariant(
    { id: 'heuristic', minConfidence: null, minMargin: null },
    heuristicResults,
    802000,
  )
  const pairedByRival = Object.fromEntries(
    (['random', 'heuristic'] as const).map((rival) => {
      const rows = pairedRows.filter((row) => row.rival === rival)
      const q5Better = rows.filter(
        (row) =>
          (row.q5Won && !row.heuristicWon) ||
          (row.q5Won === row.heuristicWon && row.diffDelta > 0),
      ).length
      const heuristicBetter = rows.filter(
        (row) =>
          (!row.q5Won && row.heuristicWon) ||
          (row.q5Won === row.heuristicWon && row.diffDelta < 0),
      ).length
      const sameOutcomeAndDiff = rows.length - q5Better - heuristicBetter
      return [
        rival,
        {
          games: rows.length,
          q5Better,
          heuristicBetter,
          sameOutcomeAndDiff,
          q5BetterRate: roundMetric((q5Better / rows.length) * 100),
          heuristicBetterRate: roundMetric((heuristicBetter / rows.length) * 100),
          averageTerritorialDiffDelta: roundMetric(
            rows.reduce((sum, row) => sum + row.diffDelta, 0) / rows.length,
          ),
          gamesWithAcceptedOverrides: rows.filter((row) => row.q5AcceptedOverrides > 0).length,
          acceptedOverrides: rows.reduce((sum, row) => sum + row.q5AcceptedOverrides, 0),
        },
      ]
    }),
  )
  const hashAfter = hashFile(qTablePath)
  const summary = {
    createdAt: new Date().toISOString(),
    model: 'Q5',
    experiment: 'hybrid_final_checkpoint_500_extended_validation',
    qTablePath,
    qTableEntries: Object.keys(qTable).length,
    qTableHashBefore: hashBefore,
    qTableHashAfter: hashAfter,
    qTableChangedDuringEvaluation: hashBefore !== hashAfter || qTableFingerprint(qTable) !== fingerprintBefore,
    confidenceDefinition: {
      value: 'max(originalDatasetObservations, qLearningUpdatesAfterInitialization)',
      originalDatasetObservations: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      qLearningUpdatesAfterInitialization: qUpdateLogPath,
      qLearningUpdateCountsLoaded: qLearningUpdateCounts.size,
    },
    protocol: {
      epsilon: 0,
      learnsDuringEvaluation: false,
      qTableFrozen: true,
      alphaUpdates: false,
      representation: 'Q3',
      seedBase: 802000,
      blocks: 5,
      gamesPerBlock: 400,
      gamesPerModel: 2000,
      gamesPerRival: 1000,
      gamesPerColorPerRival: 500,
      maxTurns: 250,
      variant,
      models: ['Q5-hybrid-final-500', 'heuristic-original'],
    },
    models: {
      q5HybridFinal500: q5Summary,
      heuristicOriginal: heuristicSummary,
    },
    pairedComparison: pairedByRival,
  }
  if (summary.qTableChangedDuringEvaluation) {
    throw new Error('Q5 hybrid final extended validation qTable changed during evaluation')
  }

  mkdirSync(outputDir, { recursive: true })
  writeJson(path.join(outputDir, 'extended_validation_summary.json'), summary)
  writeFileSync(
    path.join(outputDir, 'extended_validation_results.csv'),
    `${thresholdResultsToCsv([...q5Results, ...heuristicResults])}\n`,
    'utf8',
  )
  writeFileSync(path.join(outputDir, 'paired_comparison.csv'), `${pairedComparisonToCsv(pairedRows)}\n`, 'utf8')
  writeJson(path.join(outputDir, 'metadata.json'), {
    createdAt: summary.createdAt,
    qTablePath,
    outputDir,
    confidenceDefinition: summary.confidenceDefinition,
    protocol: summary.protocol,
  })
  return { summary, results: [...q5Results, ...heuristicResults] }
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
  hybridPolicy: boolean
  confidenceThreshold: number
  thresholdPolicy?: Q5ThresholdPolicyVariant
  confidenceMap: Map<string, Q5StateActionConfidence>
  qLearningUpdateCounts: Map<string, number>
  updateLogs: Q5UpdateLogEntry[]
  qVsHeuristicDecisionLogs?: Q5VsHeuristicDecisionLogEntry[]
  initialQTableKeys?: ReadonlySet<string>
  inheritedAlphaMultiplier?: number
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
  const hybridDecisions = createHybridDecisionStats()
  const thresholdDecisions = createThresholdDecisionStats()
  const gameQVsHeuristicDecisionLogs: Array<Q5VsHeuristicDecisionLogEntry & { startTurn: number }> = []
  const gameUpdateLogStartIndex = params.updateLogs.length

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
            qLearningUpdateCounts: params.qLearningUpdateCounts,
            game: params.scheduleItem.game,
            opponent: params.scheduleItem.opponent,
            color: learningSide,
            turn: turns,
            rewardComponent: 'intermediate',
            initialQTableKeys: params.initialQTableKeys,
            inheritedAlphaMultiplier: params.inheritedAlphaMultiplier,
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
      if (params.thresholdPolicy) {
        const legalActions = ai.getLegalActions(prevState)
        if (params.epsilon > 0 && params.rng() < params.epsilon) {
          action = chooseRandomActionWithRngQ4(legalActions, params.rng)
          addThresholdDecision(thresholdDecisions, 'randomExploration')
        } else {
          const choice = chooseThresholdHybridQ5Action({
            state: prevState,
            legalActions,
            qTable: params.qTable,
            confidenceMap: params.confidenceMap,
            qLearningUpdateCounts: params.qLearningUpdateCounts,
            variant: params.thresholdPolicy,
            rng: params.rng,
          })
          action = choice.action
          addThresholdDecision(thresholdDecisions, choice.mechanism)
          if (choice.mechanism === 'qOverrideAccepted') {
            const territoryBefore = getTerritoryCounts(prevState.board)
            gameQVsHeuristicDecisionLogs.push({
              game: params.scheduleItem.game,
              opponent: params.scheduleItem.opponent,
              color: learningSide,
              turn: turns,
              state: getLearningQTableKeyQ3(prevState, choice.qAction).split('|||')[0] ?? '',
              heuristicAction: choice.heuristicAction,
              qAction: choice.qAction,
              executedAction: choice.action,
              heuristicKey: choice.heuristicKey,
              qKey: choice.qKey,
              heuristicQ: choice.heuristicQ,
              qValue: choice.bestQ,
              qConfidence: choice.qConfidence,
              margin: choice.margin,
              territoryBefore,
              territoryDiffBefore: territoryBefore[learningSide] - territoryBefore[opponentSide],
              startTurn: turns,
            })
          }
        }
        if (params.qTable[getLearningQTableKeyQ3(prevState, action)] !== undefined) qHits++
        else qMisses++
      } else if (params.hybridPolicy) {
        const choice = chooseHybridQ5Action({
          state: prevState,
          legalActions: ai.getLegalActions(prevState),
          qTable: params.qTable,
          confidenceMap: params.confidenceMap,
          qLearningUpdateCounts: params.qLearningUpdateCounts,
          confidenceThreshold: params.confidenceThreshold,
          epsilon: params.epsilon,
          rng: params.rng,
        })
        action = choice.action
        addHybridDecision(hybridDecisions, choice.mechanism)
        if (choice.selectedKeyExists) qHits++
        else qMisses++
      } else {
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
      }
    } else if (params.scheduleItem.opponent === 'random') {
      action = chooseRandomActionWithRngQ4(ai.getLegalActions(prevState), params.rng)
    } else {
      action = chooseHeuristicOpponentActionQ4(prevState, params.rng)
    }

    const applied = applyFullActionQ5(state, action)
    state = applied.state
    turns += applied.turns
    updateQVsHeuristicDecisionHorizons(gameQVsHeuristicDecisionLogs, state, turns, learningSide)
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
  const finalTerritoryDiff = territory[learningSide] - territory[opponentSide]
  for (const entry of gameQVsHeuristicDecisionLogs) {
    entry.territoryDiffAfter1Turn ??= finalTerritoryDiff
    entry.territoryDiffAfter3Turns ??= finalTerritoryDiff
    entry.territoryDiffAfter5Turns ??= finalTerritoryDiff
    entry.finalWinner = winner
    entry.finalResultForQ5 = finalReward.result
    entry.finalTerritoryDiff = finalTerritoryDiff
    const { startTurn: _startTurn, ...logEntry } = entry
    params.qVsHeuristicDecisionLogs?.push(logEntry)
  }

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
          qLearningUpdateCounts: params.qLearningUpdateCounts,
          game: params.scheduleItem.game,
          opponent: params.scheduleItem.opponent,
          color: learningSide,
          turn: turns,
          rewardComponent: 'final',
          initialQTableKeys: params.initialQTableKeys,
          inheritedAlphaMultiplier: params.inheritedAlphaMultiplier,
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

  for (const updateLog of params.updateLogs.slice(gameUpdateLogStartIndex)) {
    updateLog.finalResultForQ5 = finalReward.result
    updateLog.finalTerritoryDiff = finalTerritoryDiff
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
    territoryDiff: finalTerritoryDiff,
    turns,
    qHits,
    qMisses,
    reward: finalizeRewardLog(rewardLog, finalReward),
    ...(params.hybridPolicy ? { hybridDecisions } : {}),
    ...(params.thresholdPolicy ? { thresholdDecisions } : {}),
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
  const qLearningUpdateCounts = loadQUpdateCountsFromJsonl(config.previousQUpdateLogPath)
  const previousQLearningUpdateCountsLoaded = qLearningUpdateCounts.size
  const updateLogs: Q5UpdateLogEntry[] = []
  const qVsHeuristicDecisionLogs: Q5VsHeuristicDecisionLogEntry[] = []
  const initialQTableEntries = Object.keys(qTable).length
  const initialQTableKeys = new Set(Object.keys(initialQTable))
  if (!config.initialQTablePath && initialQTableEntries !== 0) {
    throw new Error('Q5 pilot must start from an empty Q-table')
  }

  const schedule = config.schedule ?? buildBalancedQ5Schedule(config.totalGames, config.seed)
  if (schedule.length !== config.totalGames) throw new Error('Q5 schedule length mismatch')
  const games: Q5GameRecord[] = []
  let epsilon = config.epsilonStart

  for (let index = 0; index < schedule.length; index++) {
    const originalScheduleItem = schedule[index]
    if (!originalScheduleItem) throw new Error(`Q5 schedule missing local game ${index + 1}`)
    const localGameIndex = originalScheduleItem.localGameIndex ?? index + 1
    const cumulativeGameNumber = originalScheduleItem.cumulativeGameNumber ?? originalScheduleItem.game
    const scheduleItem: Q5TrainingScheduleItem = {
      ...originalScheduleItem,
      game: cumulativeGameNumber,
      localGameIndex,
      cumulativeGameNumber,
    }
    if (localGameIndex !== index + 1) {
      throw new Error(`Q5 local game index mismatch: expected ${index + 1}, got ${localGameIndex}`)
    }
    if (config.epsilonSchedule) epsilon = config.epsilonSchedule(scheduleItem)
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
      hybridPolicy: config.hybridPolicy ?? false,
      confidenceThreshold: config.confidenceThreshold ?? 3,
      thresholdPolicy: config.thresholdPolicy,
      confidenceMap,
      qLearningUpdateCounts,
      updateLogs,
      qVsHeuristicDecisionLogs,
      initialQTableKeys,
      inheritedAlphaMultiplier: config.inheritedAlphaMultiplier,
    })
    epsilon = config.epsilonSchedule
      ? config.epsilonSchedule(scheduleItem)
      : Math.max(epsilon * config.epsilonDecay, config.epsilonMin)
    games.push({
      ...gameStats,
      epsilonInitial,
      epsilonFinal: epsilon,
      qTableEntriesBefore,
      qTableEntriesAfter: Object.keys(qTable).length,
    })

    if (config.progressEvery > 0 && localGameIndex % config.progressEvery === 0) {
      console.log(
        `[trainLearningAgentQ5] ${localGameIndex}/${config.totalGames} games, cumulative=${cumulativeGameNumber}, qTable=${Object.keys(qTable).length}, epsilon=${epsilon.toFixed(4)}`,
      )
    }
  }

  if (games.length !== config.totalGames) {
    throw new Error(`Q5 training incomplete: expected ${config.totalGames} games, got ${games.length}`)
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
            : config.checkpoint === 'hybrid_pilot_100'
              ? 'qtable_q5_hybrid_pilot_100.json'
              : config.checkpoint === 'hybrid_final_500'
                ? 'qtable_q5_hybrid_final_500.json'
                : config.checkpoint === 'hybrid_final_1000'
                  ? 'qtable_q5_hybrid_final_1000.json'
                  : config.checkpoint === 'hybrid_final_1500'
                    ? 'qtable_q5_hybrid_final_1500.json'
                    : config.checkpoint === 'hybrid_final_1500_conservative_alpha'
                      ? 'qtable_q5_hybrid_final_1500_conservative_alpha.json'
                  : 'qtable_q5_pilot_40.json',
    ),
    metadata: path.join(config.outputDir, 'metadata.json'),
    trainingSummary: path.join(config.outputDir, 'training_summary.json'),
    rewardLog: path.join(config.outputDir, 'reward_log.json'),
    qUpdateLog: config.instrumentedUpdates ? path.join(config.outputDir, 'q_update_log.jsonl') : undefined,
    qVsHeuristicDecisionLog: config.qVsHeuristicDecisionLogPath,
    inheritedVsNewUpdateSummary:
      config.inheritedAlphaMultiplier !== undefined
        ? path.join(config.outputDir, 'inherited_vs_new_update_summary.json')
        : undefined,
  }
  const instrumentedUpdateSummary = summarizeInstrumentedUpdates(updateLogs)
  const inheritedVsNewUpdateSummary =
    config.inheritedAlphaMultiplier !== undefined
      ? summarizeInheritedVsNewUpdates(updateLogs, config.inheritedAlphaMultiplier)
      : undefined
  const summary = summarizeGames({
    games,
    epsilonInitial: config.epsilonStart,
    epsilonFinal: roundMetric(epsilon),
    initialQTableEntries,
    qTable,
    hybridPolicy: config.hybridPolicy ?? false,
    confidenceThreshold: config.confidenceThreshold ?? 3,
    thresholdPolicy: config.thresholdPolicy,
  })
  const metadata: Q5TrainingMetadata = {
    model: 'Q5',
    seed: config.seed,
    totalGames: config.accumulatedTotalGames ?? config.totalGames,
    checkpoint: config.checkpoint,
    startedFromEmptyQTable: !config.initialQTablePath,
    initialization: config.initialQTablePath ? (config.initializationLabel ?? 'heuristic_initial') : 'empty',
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
    hybridPolicy: config.hybridPolicy
      ? {
          enabled: true,
          confidenceThreshold: config.confidenceThreshold ?? 3,
          fallback: 'heuristic',
          explorationDuringTraining: config.epsilonStart > 0,
        }
      : undefined,
    thresholdPolicy: config.thresholdPolicy
      ? {
          enabled: true,
          variant: config.thresholdPolicy,
          fallback: 'heuristic',
          explorationDuringTraining: config.epsilonStart > 0,
        }
      : undefined,
    ...(config.previousQUpdateLogPath
      ? {
          continuation: {
            previousQUpdateLogPath: config.previousQUpdateLogPath,
            qLearningUpdateCountsLoadedBeforeTraining: previousQLearningUpdateCountsLoaded,
            accumulatedTotalGames: config.accumulatedTotalGames ?? config.totalGames,
          },
        }
      : {}),
    instrumentedUpdates: config.instrumentedUpdates
      ? {
          enabled: true,
          deltaClamp: { min: -1, max: 1 },
          learningRateByConfidence: Q5_ALPHA_BY_CONFIDENCE,
          inheritedAlphaMultiplier: config.inheritedAlphaMultiplier,
          updateSummary: instrumentedUpdateSummary,
          inheritedVsNewUpdateSummary,
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
  if (outputFiles.inheritedVsNewUpdateSummary && inheritedVsNewUpdateSummary) {
    writeJson(outputFiles.inheritedVsNewUpdateSummary, inheritedVsNewUpdateSummary)
  }
  if (outputFiles.qUpdateLog) {
    writeFileSync(
      outputFiles.qUpdateLog,
      `${updateLogs.map((log) => JSON.stringify(log)).join('\n')}\n`,
      'utf8',
    )
  }
  if (outputFiles.qVsHeuristicDecisionLog) {
    writeFileSync(
      outputFiles.qVsHeuristicDecisionLog,
      qVsHeuristicDecisionLogs.length
        ? `${qVsHeuristicDecisionLogs.map((log) => JSON.stringify(log)).join('\n')}\n`
        : '',
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

export function validateQ5HybridPilot100Metadata(metadata: Q5TrainingMetadata): void {
  if (metadata.model !== 'Q5') throw new Error('metadata.model must be Q5')
  if (metadata.seed !== 3) throw new Error('Q5 hybrid pilot seed must be 3')
  if (metadata.checkpoint !== 'hybrid_pilot_100') throw new Error('Q5 hybrid pilot checkpoint mismatch')
  if (metadata.totalGames !== 100) throw new Error('Q5 hybrid pilot must contain 100 games')
  if (metadata.newTrainingGames !== 100) throw new Error('Q5 hybrid pilot must run 100 games')
  if (metadata.startedFromEmptyQTable) throw new Error('Q5 hybrid pilot must not start empty')
  if (metadata.initialization !== 'heuristic_initial') {
    throw new Error('Q5 hybrid pilot must initialize from heuristic table')
  }
  if (metadata.initialQTableEntries !== 19652) throw new Error('Q5 hybrid pilot initial table mismatch')
  if (metadata.sourceQTable?.path !== Q5_HEURISTIC_INITIAL_QTABLE_PATH) {
    throw new Error('Q5 hybrid pilot source path mismatch')
  }
  if (!metadata.hybridPolicy?.enabled) throw new Error('Q5 hybrid pilot must enable hybrid policy')
  if (metadata.hybridPolicy.confidenceThreshold !== 3) {
    throw new Error('Q5 hybrid pilot confidence threshold mismatch')
  }
  if (!metadata.instrumentedUpdates?.enabled) {
    throw new Error('Q5 hybrid pilot must record instrumented updates')
  }
  if (metadata.instrumentedUpdates.updateSummary.maxAbsAppliedDelta > 1) {
    throw new Error('Q5 hybrid pilot applied delta clamp mismatch')
  }
  if (metadata.summary.gamesByOpponent.random !== 50) throw new Error('Q5 hybrid pilot random mismatch')
  if (metadata.summary.gamesByOpponent.heuristic !== 50) {
    throw new Error('Q5 hybrid pilot heuristic mismatch')
  }
  for (const key of ['random_R', 'random_B', 'heuristic_R', 'heuristic_B']) {
    if (metadata.summary.gamesByCombination[key] !== 25) {
      throw new Error(`Q5 hybrid pilot ${key} mismatch`)
    }
  }
  if (metadata.hyperparameters.gamma !== 0.9) throw new Error('Q5 hybrid pilot gamma mismatch')
  if (metadata.hyperparameters.epsilonStart !== 0.1) {
    throw new Error('Q5 hybrid pilot epsilonStart mismatch')
  }
  if (metadata.hyperparameters.epsilonMin !== 0.02) {
    throw new Error('Q5 hybrid pilot epsilonMin mismatch')
  }
  if (metadata.hyperparameters.epsilonDecay !== 0.9995) {
    throw new Error('Q5 hybrid pilot epsilonDecay mismatch')
  }
  const expectedEpsilon = Number((0.1 * 0.9995 ** 100).toFixed(4))
  if (metadata.summary.epsilonFinal !== expectedEpsilon) {
    throw new Error('Q5 hybrid pilot epsilon final mismatch')
  }
  if (!metadata.summary.hybridPolicy) throw new Error('Q5 hybrid pilot must summarize decisions')
}

export function validateQ5HybridFinal500Metadata(metadata: Q5TrainingMetadata): void {
  if (metadata.model !== 'Q5') throw new Error('metadata.model must be Q5')
  if (metadata.seed !== 3) throw new Error('Q5 hybrid final seed must be 3')
  if (metadata.checkpoint !== 'hybrid_final_500') throw new Error('Q5 hybrid final checkpoint mismatch')
  if (metadata.totalGames !== 500) throw new Error('Q5 hybrid final must contain 500 games')
  if (metadata.newTrainingGames !== 500) throw new Error('Q5 hybrid final must run 500 games')
  if (metadata.startedFromEmptyQTable) throw new Error('Q5 hybrid final must not start empty')
  if (metadata.initialization !== 'heuristic_initial') {
    throw new Error('Q5 hybrid final must initialize from heuristic table')
  }
  if (metadata.initialQTableEntries !== 19652) throw new Error('Q5 hybrid final initial table mismatch')
  if (metadata.sourceQTable?.path !== Q5_HEURISTIC_INITIAL_QTABLE_PATH) {
    throw new Error('Q5 hybrid final source path mismatch')
  }
  if (!metadata.thresholdPolicy?.enabled) throw new Error('Q5 hybrid final must enable threshold policy')
  if (metadata.thresholdPolicy.variant.id !== 'E') throw new Error('Q5 hybrid final variant mismatch')
  if (metadata.thresholdPolicy.variant.minConfidence !== 10) {
    throw new Error('Q5 hybrid final confidence mismatch')
  }
  if (metadata.thresholdPolicy.variant.minMargin !== 0.5) {
    throw new Error('Q5 hybrid final margin mismatch')
  }
  if (!metadata.instrumentedUpdates?.enabled) {
    throw new Error('Q5 hybrid final must record instrumented updates')
  }
  if (metadata.instrumentedUpdates.updateSummary.maxAbsAppliedDelta > 1) {
    throw new Error('Q5 hybrid final applied delta clamp mismatch')
  }
  if (metadata.summary.gamesByOpponent.random !== 250) throw new Error('Q5 hybrid final random mismatch')
  if (metadata.summary.gamesByOpponent.heuristic !== 250) {
    throw new Error('Q5 hybrid final heuristic mismatch')
  }
  for (const key of ['random_R', 'random_B', 'heuristic_R', 'heuristic_B']) {
    if (metadata.summary.gamesByCombination[key] !== 125) {
      throw new Error(`Q5 hybrid final ${key} mismatch`)
    }
  }
  if (metadata.hyperparameters.gamma !== 0.9) throw new Error('Q5 hybrid final gamma mismatch')
  if (metadata.hyperparameters.epsilonStart !== 0.1) {
    throw new Error('Q5 hybrid final epsilonStart mismatch')
  }
  if (metadata.hyperparameters.epsilonMin !== 0.02) {
    throw new Error('Q5 hybrid final epsilonMin mismatch')
  }
  if (metadata.hyperparameters.epsilonDecay !== 0.9995) {
    throw new Error('Q5 hybrid final epsilonDecay mismatch')
  }
  const expectedEpsilon = Number((0.1 * 0.9995 ** 500).toFixed(4))
  if (metadata.summary.epsilonFinal !== expectedEpsilon) {
    throw new Error('Q5 hybrid final epsilon final mismatch')
  }
  if (!metadata.summary.thresholdPolicy) throw new Error('Q5 hybrid final must summarize threshold decisions')
}

export function validateQ5HybridFinal1000Metadata(metadata: Q5TrainingMetadata): void {
  if (metadata.model !== 'Q5') throw new Error('metadata.model must be Q5')
  if (metadata.seed !== 3) throw new Error('Q5 hybrid final 1000 seed must be 3')
  if (metadata.checkpoint !== 'hybrid_final_1000') {
    throw new Error('Q5 hybrid final 1000 checkpoint mismatch')
  }
  if (metadata.totalGames !== 1000) throw new Error('Q5 hybrid final 1000 must accumulate 1000 games')
  if (metadata.newTrainingGames !== 500) throw new Error('Q5 hybrid final 1000 must run 500 new games')
  if (metadata.startedFromEmptyQTable) throw new Error('Q5 hybrid final 1000 must not start empty')
  if (metadata.initialization !== 'hybrid_final_500') {
    throw new Error('Q5 hybrid final 1000 must continue from hybrid final 500')
  }
  if (metadata.initialQTableEntries !== 23924) {
    throw new Error('Q5 hybrid final 1000 initial table mismatch')
  }
  if (
    metadata.sourceQTable?.path !==
    path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'qtable_q5_hybrid_final_500.json')
  ) {
    throw new Error('Q5 hybrid final 1000 source path mismatch')
  }
  if (!metadata.continuation) throw new Error('Q5 hybrid final 1000 must record continuation metadata')
  if (metadata.continuation.accumulatedTotalGames !== 1000) {
    throw new Error('Q5 hybrid final 1000 accumulated total mismatch')
  }
  if (metadata.continuation.qLearningUpdateCountsLoadedBeforeTraining <= 0) {
    throw new Error('Q5 hybrid final 1000 must load previous Q-learning update counts')
  }
  if (!metadata.thresholdPolicy?.enabled) {
    throw new Error('Q5 hybrid final 1000 must enable threshold policy')
  }
  if (metadata.thresholdPolicy.variant.id !== 'E') throw new Error('Q5 hybrid final 1000 variant mismatch')
  if (metadata.thresholdPolicy.variant.minConfidence !== 10) {
    throw new Error('Q5 hybrid final 1000 confidence mismatch')
  }
  if (metadata.thresholdPolicy.variant.minMargin !== 0.5) {
    throw new Error('Q5 hybrid final 1000 margin mismatch')
  }
  if (!metadata.instrumentedUpdates?.enabled) {
    throw new Error('Q5 hybrid final 1000 must record instrumented updates')
  }
  if (metadata.instrumentedUpdates.updateSummary.maxAbsAppliedDelta > 1) {
    throw new Error('Q5 hybrid final 1000 applied delta clamp mismatch')
  }
  if (metadata.instrumentedUpdates.updateSummary.invalidValueCount !== 0) {
    throw new Error('Q5 hybrid final 1000 invalid update values')
  }
  if (metadata.summary.gamesByOpponent.random !== 250) {
    throw new Error('Q5 hybrid final 1000 random mismatch')
  }
  if (metadata.summary.gamesByOpponent.heuristic !== 250) {
    throw new Error('Q5 hybrid final 1000 heuristic mismatch')
  }
  for (const key of ['random_R', 'random_B', 'heuristic_R', 'heuristic_B']) {
    if (metadata.summary.gamesByCombination[key] !== 125) {
      throw new Error(`Q5 hybrid final 1000 ${key} mismatch`)
    }
  }
  if (metadata.hyperparameters.gamma !== 0.9) throw new Error('Q5 hybrid final 1000 gamma mismatch')
  if (metadata.hyperparameters.epsilonStart < 0.0778 || metadata.hyperparameters.epsilonStart > 0.078) {
    throw new Error('Q5 hybrid final 1000 epsilonStart mismatch')
  }
  if (metadata.hyperparameters.epsilonMin !== 0.02) {
    throw new Error('Q5 hybrid final 1000 epsilonMin mismatch')
  }
  if (metadata.hyperparameters.epsilonDecay !== 0.9995) {
    throw new Error('Q5 hybrid final 1000 epsilonDecay mismatch')
  }
  const expectedEpsilon = Number((metadata.hyperparameters.epsilonStart * 0.9995 ** 500).toFixed(4))
  if (metadata.summary.epsilonFinal !== expectedEpsilon) {
    throw new Error('Q5 hybrid final 1000 epsilon final mismatch')
  }
  if (!metadata.summary.thresholdPolicy) {
    throw new Error('Q5 hybrid final 1000 must summarize threshold decisions')
  }
}

export function validateQ5HybridFinal1500Metadata(metadata: Q5TrainingMetadata): void {
  if (metadata.model !== 'Q5') throw new Error('metadata.model must be Q5')
  if (metadata.seed !== 3) throw new Error('Q5 hybrid final 1500 seed must be 3')
  if (metadata.checkpoint !== 'hybrid_final_1500') {
    throw new Error('Q5 hybrid final 1500 checkpoint mismatch')
  }
  if (metadata.totalGames !== 1500) throw new Error('Q5 hybrid final 1500 must accumulate 1500 games')
  if (metadata.newTrainingGames !== 500) throw new Error('Q5 hybrid final 1500 must run 500 new games')
  if (metadata.startedFromEmptyQTable) throw new Error('Q5 hybrid final 1500 must not start empty')
  if (metadata.initialization !== 'hybrid_final_1000') {
    throw new Error('Q5 hybrid final 1500 must continue from hybrid final 1000')
  }
  if (metadata.initialQTableEntries !== 27815) {
    throw new Error('Q5 hybrid final 1500 initial table mismatch')
  }
  if (
    metadata.sourceQTable?.path !==
    path.join(Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR, 'qtable_q5_hybrid_final_1000.json')
  ) {
    throw new Error('Q5 hybrid final 1500 source path mismatch')
  }
  if (!metadata.continuation) throw new Error('Q5 hybrid final 1500 must record continuation metadata')
  if (metadata.continuation.accumulatedTotalGames !== 1500) {
    throw new Error('Q5 hybrid final 1500 accumulated total mismatch')
  }
  if (!metadata.thresholdPolicy?.enabled) {
    throw new Error('Q5 hybrid final 1500 must enable threshold policy')
  }
  if (metadata.thresholdPolicy.variant.id !== 'C') throw new Error('Q5 hybrid final 1500 variant mismatch')
  if (metadata.thresholdPolicy.variant.minConfidence !== 5) {
    throw new Error('Q5 hybrid final 1500 confidence mismatch')
  }
  if (metadata.thresholdPolicy.variant.minMargin !== 0.25) {
    throw new Error('Q5 hybrid final 1500 margin mismatch')
  }
  if (!metadata.instrumentedUpdates?.enabled) {
    throw new Error('Q5 hybrid final 1500 must record instrumented updates')
  }
  if (metadata.instrumentedUpdates.updateSummary.maxAbsAppliedDelta > 1) {
    throw new Error('Q5 hybrid final 1500 applied delta clamp mismatch')
  }
  if (metadata.summary.gamesByOpponent.random !== 250) {
    throw new Error('Q5 hybrid final 1500 random mismatch')
  }
  if (metadata.summary.gamesByOpponent.heuristic !== 250) {
    throw new Error('Q5 hybrid final 1500 heuristic mismatch')
  }
  for (const key of ['random_R', 'random_B', 'heuristic_R', 'heuristic_B']) {
    if (metadata.summary.gamesByCombination[key] !== 125) {
      throw new Error(`Q5 hybrid final 1500 ${key} mismatch`)
    }
  }
  if (metadata.hyperparameters.gamma !== 0.9) throw new Error('Q5 hybrid final 1500 gamma mismatch')
  if (metadata.hyperparameters.epsilonStart !== 0.1) {
    throw new Error('Q5 hybrid final 1500 epsilonStart mismatch')
  }
  if (!metadata.outputFiles.qUpdateLog) {
    throw new Error('Q5 hybrid final 1500 must write q_update_log.jsonl')
  }
  if (!metadata.outputFiles.qVsHeuristicDecisionLog) {
    throw new Error('Q5 hybrid final 1500 must write q_vs_heuristic_decision_log.jsonl')
  }
  if (!metadata.summary.thresholdPolicy) {
    throw new Error('Q5 hybrid final 1500 must summarize threshold decisions')
  }
}

export function validateQ5HybridFinal1500ConservativeAlphaMetadata(metadata: Q5TrainingMetadata): void {
  validateQ5HybridFinal1500Metadata({
    ...metadata,
    checkpoint: 'hybrid_final_1500',
  })
  if (metadata.checkpoint !== 'hybrid_final_1500_conservative_alpha') {
    throw new Error('Q5 conservative alpha checkpoint mismatch')
  }
  if (metadata.instrumentedUpdates?.inheritedAlphaMultiplier !== 0.3) {
    throw new Error('Q5 conservative alpha multiplier mismatch')
  }
  if (!metadata.instrumentedUpdates.inheritedVsNewUpdateSummary) {
    throw new Error('Q5 conservative alpha must summarize inherited and new updates')
  }
  if (!metadata.outputFiles.inheritedVsNewUpdateSummary) {
    throw new Error('Q5 conservative alpha must write inherited_vs_new_update_summary.json')
  }
  const inheritedAlphas = Object.keys(
    metadata.instrumentedUpdates.inheritedVsNewUpdateSummary.inherited.alphaDistribution,
  ).map(Number)
  for (const alpha of inheritedAlphas) {
    if (![0.009, 0.006, 0.003, 0.0015].includes(alpha)) {
      throw new Error(`Q5 conservative alpha unexpected inherited alpha: ${alpha}`)
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'pilot-40'
  if (command === 'hybrid-evaluate-initial') {
    const result = await evaluateHybridQ5Policy({
      qTablePath: Q5_HEURISTIC_INITIAL_QTABLE_PATH,
      outputDir: Q5_HYBRID_INITIAL_EVAL_DIR,
      checkpoint: 'Q5-hybrid-initial',
    })
    console.log(`[trainLearningAgentQ5] Q5 hybrid initial evaluation games: ${result.results.length}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid initial output: ${Q5_HYBRID_INITIAL_EVAL_DIR}`)
    return
  }
  if (command === 'hybrid-evaluate-pilot-100') {
    const result = await evaluateHybridQ5Policy({
      qTablePath: path.join(Q5_HYBRID_PILOT_100_DIR, 'qtable_q5_hybrid_pilot_100.json'),
      outputDir: Q5_HYBRID_PILOT_100_EVAL_DIR,
      checkpoint: 'Q5-hybrid-pilot-100',
      qUpdateLogPath: path.join(Q5_HYBRID_PILOT_100_DIR, 'q_update_log.jsonl'),
    })
    console.log(`[trainLearningAgentQ5] Q5 hybrid pilot evaluation games: ${result.results.length}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid pilot evaluation output: ${Q5_HYBRID_PILOT_100_EVAL_DIR}`)
    return
  }
  if (command === 'hybrid-threshold-search') {
    const result = await evaluateQ5ThresholdSearch()
    console.log(`[trainLearningAgentQ5] Q5 threshold search games: ${result.results.length}`)
    console.log(`[trainLearningAgentQ5] Q5 threshold search output: ${Q5_HYBRID_THRESHOLD_SEARCH_DIR}`)
    return
  }
  if (command === 'hybrid-threshold-validation-extended') {
    const result = await evaluateQ5ThresholdValidationExtended()
    console.log(`[trainLearningAgentQ5] Q5 extended threshold validation games: ${result.results.length}`)
    console.log(
      `[trainLearningAgentQ5] Q5 extended threshold validation output: ${Q5_HYBRID_THRESHOLD_VALIDATION_EXTENDED_DIR}`,
    )
    return
  }
  if (command === 'hybrid-final-500') {
    const result = await runLearningAgentQ5Training({
      totalGames: 500,
      checkpoint: 'hybrid_final_500',
      seed: 3,
      outputDir: Q5_HYBRID_FINAL_CHECKPOINT_500_DIR,
      initialQTablePath: Q5_HEURISTIC_INITIAL_QTABLE_PATH,
      initialQTableBuildSummaryPath: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      schedule: buildQ5FinalFineTuning500Schedule(),
      alpha: 0.03,
      epsilonStart: 0.1,
      epsilonMin: 0.02,
      instrumentedUpdates: true,
      thresholdPolicy: { id: 'E', minConfidence: 10, minMargin: 0.5 },
    })
    validateQ5HybridFinal500Metadata(result.metadata)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 500 games: ${result.metadata.totalGames}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 500 entries: ${Object.keys(result.qTable).length}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 500 output: ${result.metadata.outputFiles.metadata}`)
    return
  }
  if (command === 'hybrid-evaluate-final-500') {
    const result = await evaluateQ5HybridFinalCheckpoint500()
    console.log(`[trainLearningAgentQ5] Q5 hybrid final evaluation games: ${result.results.length}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final evaluation output: ${Q5_HYBRID_FINAL_CHECKPOINT_500_EVAL_DIR}`)
    return
  }
  if (command === 'hybrid-final-1000') {
    const sourceQTablePath = path.join(
      Q5_HYBRID_FINAL_CHECKPOINT_500_DIR,
      'qtable_q5_hybrid_final_500.json',
    )
    const previousMetadata = loadQ5Metadata(path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'metadata.json'))
    const lastPreviousGame = previousMetadata.games[previousMetadata.games.length - 1]
    const continuedEpsilon = lastPreviousGame?.epsilonFinal ?? previousMetadata.summary.epsilonFinal
    const result = await runLearningAgentQ5Training({
      totalGames: 500,
      accumulatedTotalGames: 1000,
      checkpoint: 'hybrid_final_1000',
      seed: 3,
      outputDir: Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR,
      initialQTablePath: sourceQTablePath,
      initializationLabel: 'hybrid_final_500',
      initialQTableBuildSummaryPath: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      previousQUpdateLogPath: path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'q_update_log.jsonl'),
      schedule: buildQ5HybridFinal1000ContinuationSchedule(),
      alpha: 0.03,
      epsilonStart: continuedEpsilon,
      epsilonMin: 0.02,
      instrumentedUpdates: true,
      thresholdPolicy: { id: 'E', minConfidence: 10, minMargin: 0.5 },
    })
    validateQ5HybridFinal1000Metadata(result.metadata)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 1000 accumulated games: ${result.metadata.totalGames}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 1000 new games: ${result.metadata.newTrainingGames}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 1000 entries: ${Object.keys(result.qTable).length}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 1000 output: ${result.metadata.outputFiles.metadata}`)
    return
  }
  if (command === 'hybrid-evaluate-final-1000') {
    const result = await evaluateQ5HybridFinalCheckpoint500({
      qTablePath: path.join(Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR, 'qtable_q5_hybrid_final_1000.json'),
      qUpdateLogPath: [
        path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'q_update_log.jsonl'),
        path.join(Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR, 'q_update_log.jsonl'),
      ],
      outputDir: Q5_HYBRID_FINAL_CHECKPOINT_1000_EVAL_DIR,
      checkpoint: 'Q5-hybrid-final-1000',
    })
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 1000 evaluation games: ${result.results.length}`)
    console.log(
      `[trainLearningAgentQ5] Q5 hybrid final 1000 evaluation output: ${Q5_HYBRID_FINAL_CHECKPOINT_1000_EVAL_DIR}`,
    )
    return
  }
  if (command === 'hybrid-final-1500') {
    const sourceQTablePath = path.join(
      Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR,
      'qtable_q5_hybrid_final_1000.json',
    )
    const result = await runLearningAgentQ5Training({
      totalGames: 500,
      accumulatedTotalGames: 1500,
      checkpoint: 'hybrid_final_1500',
      seed: 3,
      outputDir: Q5_HYBRID_FINAL_CHECKPOINT_1500_DIR,
      initialQTablePath: sourceQTablePath,
      initializationLabel: 'hybrid_final_1000',
      initialQTableBuildSummaryPath: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      previousQUpdateLogPath: [
        path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'q_update_log.jsonl'),
        path.join(Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR, 'q_update_log.jsonl'),
      ],
      schedule: buildQ5HybridFinal1500ContinuationSchedule(),
      alpha: 0.03,
      epsilonStart: 0.1,
      epsilonMin: 0.02,
      epsilonSchedule: getQ5HybridFinal1500Epsilon,
      instrumentedUpdates: true,
      thresholdPolicy: { id: 'C', minConfidence: 5, minMargin: 0.25 },
      qVsHeuristicDecisionLogPath: path.join(
        Q5_HYBRID_FINAL_CHECKPOINT_1500_DIR,
        'q_vs_heuristic_decision_log.jsonl',
      ),
    })
    validateQ5HybridFinal1500Metadata(result.metadata)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 1500 accumulated games: ${result.metadata.totalGames}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 1500 new games: ${result.metadata.newTrainingGames}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 1500 entries: ${Object.keys(result.qTable).length}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid final 1500 output: ${result.metadata.outputFiles.metadata}`)
    return
  }
  if (command === 'hybrid-final-1500-conservative-alpha') {
    const sourceQTablePath = path.join(
      Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR,
      'qtable_q5_hybrid_final_1000.json',
    )
    const result = await runLearningAgentQ5Training({
      totalGames: 500,
      accumulatedTotalGames: 1500,
      checkpoint: 'hybrid_final_1500_conservative_alpha',
      seed: 3,
      outputDir: Q5_HYBRID_FINAL_CHECKPOINT_1500_CONSERVATIVE_ALPHA_DIR,
      initialQTablePath: sourceQTablePath,
      initializationLabel: 'hybrid_final_1000',
      initialQTableBuildSummaryPath: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      previousQUpdateLogPath: [
        path.join(Q5_HYBRID_FINAL_CHECKPOINT_500_DIR, 'q_update_log.jsonl'),
        path.join(Q5_HYBRID_FINAL_CHECKPOINT_1000_DIR, 'q_update_log.jsonl'),
      ],
      schedule: buildQ5HybridFinal1500ContinuationSchedule(),
      alpha: 0.03,
      inheritedAlphaMultiplier: 0.3,
      epsilonStart: 0.1,
      epsilonMin: 0.02,
      epsilonSchedule: getQ5HybridFinal1500Epsilon,
      instrumentedUpdates: true,
      thresholdPolicy: { id: 'C', minConfidence: 5, minMargin: 0.25 },
      qVsHeuristicDecisionLogPath: path.join(
        Q5_HYBRID_FINAL_CHECKPOINT_1500_CONSERVATIVE_ALPHA_DIR,
        'q_vs_heuristic_decision_log.jsonl',
      ),
    })
    validateQ5HybridFinal1500ConservativeAlphaMetadata(result.metadata)
    console.log(
      `[trainLearningAgentQ5] Q5 hybrid final 1500 conservative alpha output: ${result.metadata.outputFiles.metadata}`,
    )
    return
  }
  if (command === 'hybrid-validate-final-500-extended') {
    const result = await evaluateQ5HybridFinalCheckpoint500Extended()
    console.log(`[trainLearningAgentQ5] Q5 hybrid final extended validation games: ${result.results.length}`)
    console.log(
      `[trainLearningAgentQ5] Q5 hybrid final extended validation output: ${Q5_HYBRID_FINAL_CHECKPOINT_500_EXTENDED_VALIDATION_DIR}`,
    )
    return
  }
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
  if (command === 'hybrid-pilot-100') {
    const result = await runLearningAgentQ5Training({
      totalGames: 100,
      checkpoint: 'hybrid_pilot_100',
      seed: 3,
      outputDir: Q5_HYBRID_PILOT_100_DIR,
      initialQTablePath: Q5_HEURISTIC_INITIAL_QTABLE_PATH,
      initialQTableBuildSummaryPath: Q5_HEURISTIC_INITIAL_BUILD_SUMMARY_PATH,
      schedule: buildQ5HybridPilot100Schedule(),
      alpha: 0.03,
      epsilonStart: 0.1,
      epsilonMin: 0.02,
      instrumentedUpdates: true,
      hybridPolicy: true,
      confidenceThreshold: 3,
    })
    validateQ5HybridPilot100Metadata(result.metadata)
    console.log(`[trainLearningAgentQ5] Q5 hybrid pilot games: ${result.metadata.totalGames}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid pilot entries: ${Object.keys(result.qTable).length}`)
    console.log(`[trainLearningAgentQ5] Q5 hybrid pilot output: ${result.metadata.outputFiles.metadata}`)
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
