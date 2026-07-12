import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import type { QTableSnapshot } from '@/agents/learningPolicy'
import { calculatePlayerMobilityQ3 } from '@/agents/learningPolicyQ3'
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

export type Q5OpponentKind = Q4OpponentKind

export interface Q5TrainingScheduleItem {
  game: number
  opponent: Q5OpponentKind
  learningColor: Player
}

export interface Q5TrainingConfig {
  totalGames: number
  checkpoint: 'pilot_40'
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
  checkpoint: 'pilot_40'
  startedFromEmptyQTable: boolean
  initialization: 'empty'
  initialQTableEntries: number
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
  createdAt: string
  durationMs: number
  outputFiles: {
    qTable: string
    metadata: string
    trainingSummary: string
    rewardLog: string
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
  const qTable: QTableSnapshot = {}
  const initialQTableEntries = Object.keys(qTable).length
  if (initialQTableEntries !== 0) throw new Error('Q5 pilot must start from an empty Q-table')

  const schedule = buildBalancedQ5Schedule(config.totalGames, config.seed)
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
    qTable: path.join(config.outputDir, 'qtable_q5_pilot_40.json'),
    metadata: path.join(config.outputDir, 'metadata.json'),
    trainingSummary: path.join(config.outputDir, 'training_summary.json'),
    rewardLog: path.join(config.outputDir, 'reward_log.json'),
  }
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
    startedFromEmptyQTable: true,
    initialization: 'empty',
    initialQTableEntries,
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
    targetDistribution: buildTargetDistribution(config.totalGames),
    heuristicPolicy: {
      placement: 'getBestPlacement',
      playing: 'getBestHeuristicAction',
      policy: 'default',
    },
    schedule,
    games,
    rewardLog: games.map((game) => game.reward),
    summary,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    outputFiles,
  }

  mkdirSync(config.outputDir, { recursive: true })
  writeJson(outputFiles.qTable, qTable)
  writeJson(outputFiles.metadata, metadata)
  writeJson(outputFiles.trainingSummary, summary)
  writeJson(outputFiles.rewardLog, metadata.rewardLog)

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

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'pilot-40'
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
