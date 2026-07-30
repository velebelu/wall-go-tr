import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import type { QTableSnapshot } from '@/agents/learningPolicy'
import { applyFullAction } from '@/engine/gameSimulator'
import {
  getLearningActionKeyQ3,
  getLearningQTableKeyQ3,
  getLearningStateKeyQ3,
} from '@/agents/learningPolicyQ3'
import * as ai from '@/utils/ai'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { getTerritoryCounts } from './compareLearningAgents'
import {
  DEFAULT_Q2_TRAINING_CONFIG,
  Q2_REWARD_CONFIG,
  calculateFinalRewardQ2,
  calculateIntermediateRewardQ2,
} from './trainLearningAgentQ2'

export const Q4_BASE_DIR = 'data/entrenamiento/q4'
export const Q4_PILOT_40_DIR = path.join(Q4_BASE_DIR, 'pilotos/seed_3/pilot_40')
export const Q4_CHECKPOINT_500_DIR = path.join(Q4_BASE_DIR, 'checkpoint_500')
export const Q4_CHECKPOINT_1000_DIR = path.join(Q4_BASE_DIR, 'checkpoint_1000')
export const Q4_CHECKPOINT_1500_DIR = path.join(Q4_BASE_DIR, 'checkpoint_1500')
export const Q4_CHECKPOINT_2000_DIR = path.join(Q4_BASE_DIR, 'checkpoint_2000')
export const Q4_REWARD_CONFIG = Q2_REWARD_CONFIG

export type Q4OpponentKind = 'random' | 'heuristic'
export type ActionKindQ4 = 'place' | 'move' | 'wall' | 'move-wall'

export interface Q4TrainingScheduleItem {
  game: number
  opponent: Q4OpponentKind
  learningColor: Player
}

export interface Q4TrainingConfig {
  totalGames: number
  checkpoint: number
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

interface PendingTransition {
  state: GameSnapshot
  action: PlayerAction
}

interface Q4GameRecord {
  game: number
  opponent: Q4OpponentKind
  learningColor: Player
  opponentColor: Player
  winner: Player | 'tie'
  resultForQ4: 'win' | 'loss' | 'tie'
  territoryQ4: number
  territoryOpponent: number
  territoryDiff: number
  turns: number
  qHits: number
  qMisses: number
  epsilonInitial: number
  epsilonFinal: number
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

interface Q4TrainingSummary {
  gamesByOpponent: Record<Q4OpponentKind, number>
  gamesByColor: Record<Player, number>
  gamesByCombination: Record<string, number>
  results: ResultStats
  resultsByOpponent: Record<Q4OpponentKind, ResultStats>
  resultsByColor: Record<Player, ResultStats>
  resultsByCombination: Record<string, ResultStats>
  qTotal: HitMissStats
  qByOpponent: Record<Q4OpponentKind, HitMissStats>
  qByColor: Record<Player, HitMissStats>
  averageTerritory: {
    q4: number
    opponent: number
  }
  averageTerritoryDiff: number
  averageTurns: number
  epsilonInitial: number
  epsilonFinal: number
  finalQTableEntries: number
  uniqueQ3StatesVisited: number
}

export interface Q4TrainingMetadata {
  model: 'Q4'
  seed: number
  totalGames: number
  checkpoint: number
  startedFromEmptyQTable: boolean
  initialization: 'empty' | 'checkpoint'
  initialQTableEntries: number
  sourceCheckpoint?: {
    checkpoint: number
    qTablePath: string
    metadataPath: string
    qTableEntries: number
    trainingGames: number
    epsilonFinal: number
  }
  newTrainingGames?: number
  totalTrainingGames?: number
  epsilonContinuationInitial?: number
  checkpointTrace?: Array<{
    checkpoint: number
    qTableEntries: number
    trainingGames: number
    epsilonFinal: number
  }>
  stateRepresentation: 'Q3'
  rewardModel: 'Q2'
  rewardConfiguration: typeof Q2_REWARD_CONFIG
  hyperparameters: {
    alpha: number
    gamma: number
    epsilonStart: number
    epsilonMin: number
    epsilonDecay: number
    maxTurns: number
  }
  targetDistribution: {
    opponents: Record<Q4OpponentKind, number>
    colors: Record<Player, number>
    combinations: Record<string, number>
  }
  heuristicPolicy: {
    placement: 'getBestPlacement'
    playing: 'getBestHeuristicAction'
    policy: 'default'
  }
  schedule: Q4TrainingScheduleItem[]
  games: Q4GameRecord[]
  summary: Q4TrainingSummary
  createdAt: string
  durationMs: number
  outputFiles: {
    qTable: string
    metadata: string
    trainingSummary: string
  }
}

export const DEFAULT_Q4_TRAINING_CONFIG: Q4TrainingConfig = {
  totalGames: 40,
  checkpoint: 40,
  seed: 3,
  outputDir: Q4_PILOT_40_DIR,
  alpha: DEFAULT_Q2_TRAINING_CONFIG.alpha,
  gamma: DEFAULT_Q2_TRAINING_CONFIG.gamma,
  epsilonStart: DEFAULT_Q2_TRAINING_CONFIG.epsilonStart,
  epsilonMin: DEFAULT_Q2_TRAINING_CONFIG.epsilonMin,
  epsilonDecay: DEFAULT_Q2_TRAINING_CONFIG.epsilonDecay,
  maxTurns: DEFAULT_Q2_TRAINING_CONFIG.maxTurns,
  progressEvery: DEFAULT_Q2_TRAINING_CONFIG.progressEvery,
  overwrite: false,
}

export interface Q4ContinuationOptions {
  sourceQTablePath: string
  sourceMetadataPath: string
  targetGames: number
  checkpoint: number
  seed: number
  outputDir: string
  progressEvery?: number
  overwrite?: boolean
}

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

export function createSeededRngQ4(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function shuffleWithRng<T>(items: T[], rng: () => number): T[] {
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1))
    const current = shuffled[index]!
    shuffled[index] = shuffled[swapIndex]!
    shuffled[swapIndex] = current
  }
  return shuffled
}

export function buildBalancedQ4Schedule(
  totalGames: number,
  seed: number,
): Q4TrainingScheduleItem[] {
  if (totalGames % 4 !== 0) throw new Error('Q4 totalGames must be divisible by 4')
  const rng = createSeededRngQ4(seed)
  const block = [
    { opponent: 'random', learningColor: 'R' },
    { opponent: 'random', learningColor: 'B' },
    { opponent: 'heuristic', learningColor: 'R' },
    { opponent: 'heuristic', learningColor: 'B' },
  ] satisfies Array<Omit<Q4TrainingScheduleItem, 'game'>>

  const schedule: Q4TrainingScheduleItem[] = []
  for (let offset = 0; offset < totalGames; offset += block.length) {
    for (const item of shuffleWithRng(block, rng)) {
      schedule.push({ ...item, game: schedule.length + 1 })
    }
  }
  return schedule
}

function combinationKey(opponent: Q4OpponentKind, color: Player): string {
  return `${opponent}_${color}`
}

function getActionKindQ4(action: PlayerAction): ActionKindQ4 {
  if (action.type === 'move' && action.followUp?.type === 'wall') return 'move-wall'
  return action.type
}

export function chooseRandomActionWithRngQ4(
  actions: PlayerAction[],
  rng: () => number,
): PlayerAction {
  if (actions.length === 0) throw new Error('No legal actions available')
  return actions[Math.floor(rng() * actions.length)]!
}

function withSeededMathRandomQ4<T>(rng: () => number, fn: () => T): T {
  const previous = Math.random
  Math.random = rng
  try {
    return fn()
  } finally {
    Math.random = previous
  }
}

export function chooseHeuristicOpponentActionQ4(
  state: GameSnapshot,
  rng: () => number,
): PlayerAction {
  return withSeededMathRandomQ4(rng, () => {
    if (state.phase === 'placing') return ai.getBestPlacement(state)
    return (
      ai.getBestHeuristicAction(state) ??
      chooseRandomActionWithRngQ4(ai.getLegalActions(state), rng)
    )
  })
}

export function chooseLearningActionQ4(
  state: GameSnapshot,
  legalActions: PlayerAction[],
  epsilon: number,
  qTable: QTableSnapshot,
  rng: () => number,
): { action: PlayerAction; selectedKeyExists: boolean } {
  if (legalActions.length === 0) throw new Error('No legal actions available')

  if (rng() < epsilon) {
    const action = chooseRandomActionWithRngQ4(legalActions, rng)
    return {
      action,
      selectedKeyExists: qTable[getLearningQTableKeyQ3(state, action)] !== undefined,
    }
  }

  let bestValue = -Infinity
  const bestActions: PlayerAction[] = []
  for (const action of legalActions) {
    const value = qTable[getLearningQTableKeyQ3(state, action)] ?? 0
    if (value > bestValue) {
      bestValue = value
      bestActions.length = 0
      bestActions.push(action)
    } else if (value === bestValue) {
      bestActions.push(action)
    }
  }

  const action = chooseRandomActionWithRngQ4(bestActions, rng)
  return { action, selectedKeyExists: qTable[getLearningQTableKeyQ3(state, action)] !== undefined }
}

export function getMaxQValueQ4(
  state: GameSnapshot | undefined,
  qTable: QTableSnapshot,
  terminal: boolean,
): number {
  if (terminal || !state || state.phase === 'finished') return 0
  const legalActions = ai.getLegalActions(state)
  if (legalActions.length === 0) return 0
  return Math.max(
    ...legalActions.map((action) => qTable[getLearningQTableKeyQ3(state, action)] ?? 0),
  )
}

export function updateQValueQ4(params: {
  qTable: QTableSnapshot
  state: GameSnapshot
  action: PlayerAction
  reward: number
  nextState: GameSnapshot | undefined
  terminal: boolean
  alpha: number
  gamma: number
}): void {
  const key = getLearningQTableKeyQ3(params.state, params.action)
  const currentQ = params.qTable[key] ?? 0
  const nextMax = getMaxQValueQ4(params.nextState, params.qTable, params.terminal)
  params.qTable[key] = currentQ + params.alpha * (params.reward + params.gamma * nextMax - currentQ)
}

export function applyFullActionQ4(
  state: GameSnapshot,
  action: PlayerAction,
): { state: GameSnapshot; turns: number } {
  const applied = applyFullAction(state, action)
  return { state: applied.state, turns: applied.atomicActions }
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

function addResult(stats: ResultStats, result: Q4GameRecord['resultForQ4']): void {
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

function summarizeGames(params: {
  games: Q4GameRecord[]
  epsilonInitial: number
  epsilonFinal: number
  qTable: QTableSnapshot
}): Q4TrainingSummary {
  const summary: Q4TrainingSummary = {
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
      q4: 0,
      opponent: 0,
    },
    averageTerritoryDiff: 0,
    averageTurns: 0,
    epsilonInitial: params.epsilonInitial,
    epsilonFinal: params.epsilonFinal,
    finalQTableEntries: Object.keys(params.qTable).length,
    uniqueQ3StatesVisited: new Set(Object.keys(params.qTable).map((key) => key.split('|||')[0]))
      .size,
  }

  let territoryQ4Total = 0
  let territoryOpponentTotal = 0
  let territoryDiffTotal = 0
  let turnsTotal = 0

  for (const game of params.games) {
    const key = combinationKey(game.opponent, game.learningColor)
    summary.gamesByOpponent[game.opponent]++
    summary.gamesByColor[game.learningColor]++
    summary.gamesByCombination[key]++
    addResult(summary.results, game.resultForQ4)
    addResult(summary.resultsByOpponent[game.opponent], game.resultForQ4)
    addResult(summary.resultsByColor[game.learningColor], game.resultForQ4)
    addResult(summary.resultsByCombination[key], game.resultForQ4)
    addHitMiss(summary.qTotal, game.qHits, game.qMisses)
    addHitMiss(summary.qByOpponent[game.opponent], game.qHits, game.qMisses)
    addHitMiss(summary.qByColor[game.learningColor], game.qHits, game.qMisses)
    territoryQ4Total += game.territoryQ4
    territoryOpponentTotal += game.territoryOpponent
    territoryDiffTotal += game.territoryDiff
    turnsTotal += game.turns
  }

  finalizeHitRate(summary.qTotal)
  finalizeHitRate(summary.qByOpponent.random)
  finalizeHitRate(summary.qByOpponent.heuristic)
  finalizeHitRate(summary.qByColor.R)
  finalizeHitRate(summary.qByColor.B)
  summary.averageTerritory.q4 = params.games.length
    ? roundMetric(territoryQ4Total / params.games.length)
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

function combineQ4GameRecords(previousGames: Q4GameRecord[], newGames: Q4GameRecord[]) {
  return [...previousGames, ...newGames]
}

function buildContinuationTrace(
  sourceMetadata: Q4TrainingMetadata,
): NonNullable<Q4TrainingMetadata['checkpointTrace']> {
  const trace = [...(sourceMetadata.checkpointTrace ?? [])]
  if (sourceMetadata.sourceCheckpoint && trace.length === 0) {
    trace.push({
      checkpoint: sourceMetadata.sourceCheckpoint.checkpoint,
      qTableEntries: sourceMetadata.sourceCheckpoint.qTableEntries,
      trainingGames: sourceMetadata.sourceCheckpoint.trainingGames,
      epsilonFinal: sourceMetadata.sourceCheckpoint.epsilonFinal,
    })
  }
  trace.push({
    checkpoint: sourceMetadata.checkpoint,
    qTableEntries: sourceMetadata.summary.finalQTableEntries,
    trainingGames: sourceMetadata.totalGames,
    epsilonFinal: sourceMetadata.summary.epsilonFinal,
  })
  return trace
}

function buildTargetDistribution(totalGames: number): Q4TrainingMetadata['targetDistribution'] {
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

async function runQ4TrainingGame(params: {
  scheduleItem: Q4TrainingScheduleItem
  qTable: QTableSnapshot
  epsilon: number
  alpha: number
  gamma: number
  maxTurns: number
  rng: () => number
}): Promise<Omit<Q4GameRecord, 'epsilonInitial' | 'epsilonFinal'>> {
  let state = makeInitialState()
  const learningSide = params.scheduleItem.learningColor
  const opponentSide = getOpponent(learningSide)
  let pending: PendingTransition | undefined
  let pendingReward = 0
  let turns = 0
  let qHits = 0
  let qMisses = 0

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
      getLearningStateKeyQ3(prevState)
      getLearningActionKeyQ3(prevState, action)
      getActionKindQ4(action)
    } else if (params.scheduleItem.opponent === 'random') {
      action = chooseRandomActionWithRngQ4(ai.getLegalActions(prevState), params.rng)
    } else {
      action = chooseHeuristicOpponentActionQ4(prevState, params.rng)
    }

    const applied = applyFullActionQ4(state, action)
    state = applied.state
    turns += applied.turns
    pendingReward += calculateIntermediateRewardQ2(prevState, state, learningSide)

    if (isLearningTurn) {
      pending = { state: prevState, action }
    }
  }

  state = finalizeGameIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')

  if (pending) {
    updateQValueQ4({
      qTable: params.qTable,
      state: pending.state,
      action: pending.action,
      reward: pendingReward + calculateFinalRewardQ2(winner, territory, learningSide),
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
    resultForQ4: winner === 'tie' ? 'tie' : winner === learningSide ? 'win' : 'loss',
    territoryQ4: territory[learningSide],
    territoryOpponent: territory[opponentSide],
    territoryDiff: territory[learningSide] - territory[opponentSide],
    turns,
    qHits,
    qMisses,
  }
}

export async function runLearningAgentQ4Training(
  options: Partial<Q4TrainingConfig> = {},
): Promise<{ qTable: QTableSnapshot; metadata: Q4TrainingMetadata }> {
  const config: Q4TrainingConfig = { ...DEFAULT_Q4_TRAINING_CONFIG, ...options }
  assertOutputCanBeWritten(config.outputDir, config.overwrite)
  const startedAt = Date.now()
  const rng = createSeededRngQ4(config.seed)
  const qTable: QTableSnapshot = {}
  const initialQTableEntries = Object.keys(qTable).length
  if (initialQTableEntries !== 0) throw new Error('Q4 must start from an empty Q-table')

  const schedule = buildBalancedQ4Schedule(config.totalGames, config.seed)
  const games: Q4GameRecord[] = []
  let epsilon = config.epsilonStart

  for (const scheduleItem of schedule) {
    const epsilonInitial = epsilon
    const gameStats = await runQ4TrainingGame({
      scheduleItem,
      qTable,
      epsilon,
      alpha: config.alpha,
      gamma: config.gamma,
      maxTurns: config.maxTurns,
      rng,
    })
    epsilon = Math.max(epsilon * config.epsilonDecay, config.epsilonMin)
    games.push({ ...gameStats, epsilonInitial, epsilonFinal: epsilon })

    if (config.progressEvery > 0 && scheduleItem.game % config.progressEvery === 0) {
      console.log(
        `[trainLearningAgentQ4] ${scheduleItem.game}/${config.totalGames} games, qTable=${Object.keys(qTable).length}, epsilon=${epsilon.toFixed(4)}`,
      )
    }
  }

  const outputFiles = {
    qTable: path.join(config.outputDir, `qtable_q4_${config.checkpoint}.json`),
    metadata: path.join(config.outputDir, 'metadata.json'),
    trainingSummary: path.join(config.outputDir, 'training_summary.json'),
  }
  const summary = summarizeGames({
    games,
    epsilonInitial: config.epsilonStart,
    epsilonFinal: roundMetric(epsilon),
    qTable,
  })
  const metadata: Q4TrainingMetadata = {
    model: 'Q4',
    seed: config.seed,
    totalGames: config.totalGames,
    checkpoint: config.checkpoint,
    startedFromEmptyQTable: true,
    initialization: 'empty',
    initialQTableEntries: 0,
    stateRepresentation: 'Q3',
    rewardModel: 'Q2',
    rewardConfiguration: { ...Q4_REWARD_CONFIG },
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
    summary,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    outputFiles,
  }

  mkdirSync(config.outputDir, { recursive: true })
  writeJson(outputFiles.qTable, qTable)
  writeJson(outputFiles.metadata, metadata)
  writeJson(outputFiles.trainingSummary, {
    model: 'Q4',
    seed: config.seed,
    totalGames: config.totalGames,
    summary,
  })

  return { qTable, metadata }
}

export async function continueLearningAgentQ4Training(
  options: Q4ContinuationOptions,
): Promise<{ qTable: QTableSnapshot; metadata: Q4TrainingMetadata }> {
  const sourceQTablePath = path.resolve(options.sourceQTablePath)
  const sourceMetadataPath = path.resolve(options.sourceMetadataPath)
  const sourceMetadata = loadQ4Metadata(sourceMetadataPath)
  const qTable = loadQ4QTable(sourceQTablePath)
  const initialQTableEntries = Object.keys(qTable).length
  const sourceGames = sourceMetadata.totalGames
  const newTrainingGames = options.targetGames - sourceGames

  if (sourceMetadata.model !== 'Q4') throw new Error('Source metadata must be Q4')
  if (sourceMetadata.seed !== options.seed) throw new Error('Source seed must match target seed')
  if (sourceMetadata.checkpoint >= options.checkpoint) {
    throw new Error('Target checkpoint must be greater than source checkpoint')
  }
  if (newTrainingGames <= 0) throw new Error('targetGames must exceed source games')
  if (newTrainingGames % 4 !== 0) throw new Error('new training games must be divisible by 4')
  if (initialQTableEntries !== sourceMetadata.summary.finalQTableEntries) {
    throw new Error('Source Q-table entry count does not match source metadata')
  }

  const config: Q4TrainingConfig = {
    ...DEFAULT_Q4_TRAINING_CONFIG,
    totalGames: newTrainingGames,
    checkpoint: options.checkpoint,
    seed: options.seed,
    outputDir: options.outputDir,
    alpha: sourceMetadata.hyperparameters.alpha,
    gamma: sourceMetadata.hyperparameters.gamma,
    epsilonStart: sourceMetadata.summary.epsilonFinal,
    epsilonMin: sourceMetadata.hyperparameters.epsilonMin,
    epsilonDecay: sourceMetadata.hyperparameters.epsilonDecay,
    maxTurns: sourceMetadata.hyperparameters.maxTurns,
    progressEvery: options.progressEvery ?? DEFAULT_Q4_TRAINING_CONFIG.progressEvery,
    overwrite: options.overwrite ?? false,
  }
  assertOutputCanBeWritten(config.outputDir, config.overwrite)

  const startedAt = Date.now()
  const rng = createSeededRngQ4(options.seed + sourceGames)
  const schedule = buildBalancedQ4Schedule(options.targetGames, options.seed).slice(sourceGames)
  const newGames: Q4GameRecord[] = []
  let epsilon = sourceMetadata.summary.epsilonFinal

  for (const scheduleItem of schedule) {
    const epsilonInitial = epsilon
    const gameStats = await runQ4TrainingGame({
      scheduleItem,
      qTable,
      epsilon,
      alpha: config.alpha,
      gamma: config.gamma,
      maxTurns: config.maxTurns,
      rng,
    })
    epsilon = Math.max(epsilon * config.epsilonDecay, config.epsilonMin)
    newGames.push({ ...gameStats, epsilonInitial, epsilonFinal: epsilon })

    if (config.progressEvery > 0 && newGames.length % config.progressEvery === 0) {
      console.log(
        `[trainLearningAgentQ4] continued ${newGames.length}/${newTrainingGames} games (${scheduleItem.game}/${options.targetGames} total), qTable=${Object.keys(qTable).length}, epsilon=${epsilon.toFixed(4)}`,
      )
    }
  }

  const games = combineQ4GameRecords(sourceMetadata.games, newGames)
  const outputFiles = {
    qTable: path.join(config.outputDir, `qtable_q4_${config.checkpoint}.json`),
    metadata: path.join(config.outputDir, 'metadata.json'),
    trainingSummary: path.join(config.outputDir, 'training_summary.json'),
  }
  const summary = summarizeGames({
    games,
    epsilonInitial: sourceMetadata.summary.epsilonInitial,
    epsilonFinal: roundMetric(epsilon),
    qTable,
  })
  const metadata: Q4TrainingMetadata = {
    model: 'Q4',
    seed: options.seed,
    totalGames: options.targetGames,
    checkpoint: options.checkpoint,
    startedFromEmptyQTable: false,
    initialization: 'checkpoint',
    initialQTableEntries,
    sourceCheckpoint: {
      checkpoint: sourceMetadata.checkpoint,
      qTablePath: sourceQTablePath,
      metadataPath: sourceMetadataPath,
      qTableEntries: initialQTableEntries,
      trainingGames: sourceGames,
      epsilonFinal: sourceMetadata.summary.epsilonFinal,
    },
    newTrainingGames,
    totalTrainingGames: options.targetGames,
    epsilonContinuationInitial: sourceMetadata.summary.epsilonFinal,
    checkpointTrace: buildContinuationTrace(sourceMetadata),
    stateRepresentation: 'Q3',
    rewardModel: 'Q2',
    rewardConfiguration: { ...Q4_REWARD_CONFIG },
    hyperparameters: {
      alpha: config.alpha,
      gamma: config.gamma,
      epsilonStart: sourceMetadata.hyperparameters.epsilonStart,
      epsilonMin: config.epsilonMin,
      epsilonDecay: config.epsilonDecay,
      maxTurns: config.maxTurns,
    },
    targetDistribution: buildTargetDistribution(options.targetGames),
    heuristicPolicy: {
      placement: 'getBestPlacement',
      playing: 'getBestHeuristicAction',
      policy: 'default',
    },
    schedule: buildBalancedQ4Schedule(options.targetGames, options.seed),
    games,
    summary,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    outputFiles,
  }

  mkdirSync(config.outputDir, { recursive: true })
  writeJson(outputFiles.qTable, qTable)
  writeJson(outputFiles.metadata, metadata)
  writeJson(outputFiles.trainingSummary, {
    model: 'Q4',
    seed: options.seed,
    totalGames: options.targetGames,
    checkpoint: options.checkpoint,
    sourceCheckpoint: metadata.sourceCheckpoint,
    newTrainingGames,
    summary,
  })

  return { qTable, metadata }
}

export function loadQ4Metadata(metadataPath: string): Q4TrainingMetadata {
  return JSON.parse(readFileSync(path.resolve(metadataPath), 'utf8')) as Q4TrainingMetadata
}

export function loadQ4QTable(qTablePath: string): QTableSnapshot {
  return JSON.parse(readFileSync(path.resolve(qTablePath), 'utf8')) as QTableSnapshot
}

export function validateQ4PilotMetadata(metadata: Q4TrainingMetadata): void {
  if (metadata.model !== 'Q4') throw new Error('metadata.model must be Q4')
  if (metadata.totalGames !== 40) throw new Error('Q4 pilot must contain exactly 40 games')
  if (!metadata.startedFromEmptyQTable || metadata.initialQTableEntries !== 0) {
    throw new Error('Q4 pilot must start from an empty Q-table')
  }
  if (metadata.summary.gamesByOpponent.random !== 20) throw new Error('Expected 20 random games')
  if (metadata.summary.gamesByOpponent.heuristic !== 20) {
    throw new Error('Expected 20 heuristic games')
  }
  if (metadata.summary.gamesByColor.R !== 20) throw new Error('Expected 20 games as R')
  if (metadata.summary.gamesByColor.B !== 20) throw new Error('Expected 20 games as B')
  for (const value of Object.values(metadata.summary.gamesByCombination)) {
    if (value !== 10) throw new Error('Expected 10 games for every opponent-color combination')
  }
  if (metadata.summary.finalQTableEntries <= 0) throw new Error('Expected a non-empty Q4 table')
  if (metadata.games.length !== 40) throw new Error('Expected 40 game records')
  if (
    metadata.summary.qByOpponent.heuristic.qHits + metadata.summary.qByOpponent.heuristic.qMisses <=
    0
  ) {
    throw new Error('Expected Q decisions against heuristic')
  }
}

export function validateQ4Checkpoint500Metadata(metadata: Q4TrainingMetadata): void {
  if (metadata.model !== 'Q4') throw new Error('metadata.model must be Q4')
  if (metadata.seed !== 3) throw new Error('Q4 checkpoint 500 seed must be 3')
  if (metadata.checkpoint !== 500) throw new Error('Q4 checkpoint must be 500')
  if (metadata.totalGames !== 500) throw new Error('Q4-500 must contain exactly 500 games')
  if (!metadata.startedFromEmptyQTable || metadata.initialQTableEntries !== 0) {
    throw new Error('Q4-500 must start from an empty Q-table')
  }
  if (metadata.summary.gamesByOpponent.random !== 250) throw new Error('Expected 250 random games')
  if (metadata.summary.gamesByOpponent.heuristic !== 250) {
    throw new Error('Expected 250 heuristic games')
  }
  if (metadata.summary.gamesByColor.R !== 250) throw new Error('Expected 250 games as R')
  if (metadata.summary.gamesByColor.B !== 250) throw new Error('Expected 250 games as B')
  for (const value of Object.values(metadata.summary.gamesByCombination)) {
    if (value !== 125) throw new Error('Expected 125 games for every opponent-color combination')
  }
  if (metadata.summary.finalQTableEntries <= 0) throw new Error('Expected a non-empty Q4 table')
  if (metadata.games.length !== 500) throw new Error('Expected 500 game records')
  if (metadata.summary.epsilonInitial !== 0.6) throw new Error('Expected epsilonInitial 0.6')
  const expectedEpsilon = roundMetric(
    Math.max(
      metadata.hyperparameters.epsilonStart *
        metadata.hyperparameters.epsilonDecay ** metadata.totalGames,
      metadata.hyperparameters.epsilonMin,
    ),
  )
  if (metadata.summary.epsilonFinal !== expectedEpsilon) {
    throw new Error(`Expected epsilonFinal ${expectedEpsilon}`)
  }
  const qTotal = metadata.games.reduce((total, game) => total + game.qHits + game.qMisses, 0)
  if (metadata.summary.qTotal.qHits + metadata.summary.qTotal.qMisses !== qTotal) {
    throw new Error('Q hit/miss total does not match game records')
  }
}

export function validateQ4Checkpoint1000Metadata(metadata: Q4TrainingMetadata): void {
  if (metadata.model !== 'Q4') throw new Error('metadata.model must be Q4')
  if (metadata.seed !== 3) throw new Error('Q4 checkpoint 1000 seed must be 3')
  if (metadata.checkpoint !== 1000) throw new Error('Q4 checkpoint must be 1000')
  if (metadata.totalGames !== 1000) throw new Error('Q4-1000 must contain exactly 1000 games')
  if (metadata.initialization !== 'checkpoint') throw new Error('Q4-1000 must continue checkpoint')
  if (metadata.initialQTableEntries !== 6339) throw new Error('Expected 6339 initial entries')
  if (metadata.sourceCheckpoint?.checkpoint !== 500)
    throw new Error('Expected source checkpoint 500')
  if (metadata.newTrainingGames !== 500) throw new Error('Expected 500 new games')
  if (metadata.summary.gamesByOpponent.random !== 500) throw new Error('Expected 500 random games')
  if (metadata.summary.gamesByOpponent.heuristic !== 500) {
    throw new Error('Expected 500 heuristic games')
  }
  if (metadata.summary.gamesByColor.R !== 500) throw new Error('Expected 500 games as R')
  if (metadata.summary.gamesByColor.B !== 500) throw new Error('Expected 500 games as B')
  for (const value of Object.values(metadata.summary.gamesByCombination)) {
    if (value !== 250) throw new Error('Expected 250 games for every opponent-color combination')
  }
  if (metadata.games.length !== 1000) throw new Error('Expected 1000 game records')
  if (metadata.summary.finalQTableEntries <= metadata.initialQTableEntries) {
    throw new Error('Expected Q-table to grow after continuation')
  }
  if (metadata.epsilonContinuationInitial !== metadata.sourceCheckpoint.epsilonFinal) {
    throw new Error('Continuation epsilon must match source final epsilon')
  }
  const expectedEpsilon = roundMetric(
    Math.max(
      metadata.epsilonContinuationInitial *
        metadata.hyperparameters.epsilonDecay ** (metadata.newTrainingGames ?? 0),
      metadata.hyperparameters.epsilonMin,
    ),
  )
  if (metadata.summary.epsilonFinal !== expectedEpsilon) {
    throw new Error(`Expected epsilonFinal ${expectedEpsilon}`)
  }
  const qTotal = metadata.games.reduce((total, game) => total + game.qHits + game.qMisses, 0)
  if (metadata.summary.qTotal.qHits + metadata.summary.qTotal.qMisses !== qTotal) {
    throw new Error('Q hit/miss total does not match game records')
  }
}

export function validateQ4Checkpoint1500Metadata(metadata: Q4TrainingMetadata): void {
  if (metadata.model !== 'Q4') throw new Error('metadata.model must be Q4')
  if (metadata.seed !== 3) throw new Error('Q4 checkpoint 1500 seed must be 3')
  if (metadata.checkpoint !== 1500) throw new Error('Q4 checkpoint must be 1500')
  if (metadata.totalGames !== 1500) throw new Error('Q4-1500 must contain exactly 1500 games')
  if (metadata.initialization !== 'checkpoint') throw new Error('Q4-1500 must continue checkpoint')
  if (metadata.initialQTableEntries !== 10733) throw new Error('Expected 10733 initial entries')
  if (metadata.sourceCheckpoint?.checkpoint !== 1000)
    throw new Error('Expected source checkpoint 1000')
  if (metadata.sourceCheckpoint.qTableEntries !== 10733) {
    throw new Error('Expected source checkpoint to have 10733 entries')
  }
  if (metadata.newTrainingGames !== 500) throw new Error('Expected 500 new games')
  if (metadata.summary.gamesByOpponent.random !== 750) throw new Error('Expected 750 random games')
  if (metadata.summary.gamesByOpponent.heuristic !== 750) {
    throw new Error('Expected 750 heuristic games')
  }
  if (metadata.summary.gamesByColor.R !== 750) throw new Error('Expected 750 games as R')
  if (metadata.summary.gamesByColor.B !== 750) throw new Error('Expected 750 games as B')
  for (const value of Object.values(metadata.summary.gamesByCombination)) {
    if (value !== 375) throw new Error('Expected 375 games for every opponent-color combination')
  }
  if (metadata.games.length !== 1500) throw new Error('Expected 1500 game records')
  if (metadata.summary.finalQTableEntries <= metadata.initialQTableEntries) {
    throw new Error('Expected Q-table to grow after continuation')
  }
  if (metadata.epsilonContinuationInitial !== 0.3639) {
    throw new Error('Expected continuation epsilon 0.3639')
  }
  if (metadata.epsilonContinuationInitial !== metadata.sourceCheckpoint.epsilonFinal) {
    throw new Error('Continuation epsilon must match source final epsilon')
  }
  if (!metadata.checkpointTrace?.some((item) => item.checkpoint === 500)) {
    throw new Error('Expected checkpoint trace to include Q4-500')
  }
  if (!metadata.checkpointTrace?.some((item) => item.checkpoint === 1000)) {
    throw new Error('Expected checkpoint trace to include Q4-1000')
  }
  const expectedEpsilon = roundMetric(
    Math.max(
      metadata.epsilonContinuationInitial *
        metadata.hyperparameters.epsilonDecay ** (metadata.newTrainingGames ?? 0),
      metadata.hyperparameters.epsilonMin,
    ),
  )
  if (metadata.summary.epsilonFinal !== expectedEpsilon) {
    throw new Error(`Expected epsilonFinal ${expectedEpsilon}`)
  }
  const qTotal = metadata.games.reduce((total, game) => total + game.qHits + game.qMisses, 0)
  if (metadata.summary.qTotal.qHits + metadata.summary.qTotal.qMisses !== qTotal) {
    throw new Error('Q hit/miss total does not match game records')
  }
}

export function validateQ4Checkpoint2000Metadata(metadata: Q4TrainingMetadata): void {
  if (metadata.model !== 'Q4') throw new Error('metadata.model must be Q4')
  if (metadata.seed !== 3) throw new Error('Q4 checkpoint 2000 seed must be 3')
  if (metadata.checkpoint !== 2000) throw new Error('Q4 checkpoint must be 2000')
  if (metadata.totalGames !== 2000) throw new Error('Q4-2000 must contain exactly 2000 games')
  if (metadata.initialization !== 'checkpoint') throw new Error('Q4-2000 must continue checkpoint')
  if (metadata.initialQTableEntries !== 14282) throw new Error('Expected 14282 initial entries')
  if (metadata.sourceCheckpoint?.checkpoint !== 1500)
    throw new Error('Expected source checkpoint 1500')
  if (metadata.sourceCheckpoint.qTableEntries !== 14282) {
    throw new Error('Expected source checkpoint to have 14282 entries')
  }
  if (metadata.newTrainingGames !== 500) throw new Error('Expected 500 new games')
  if (metadata.summary.gamesByOpponent.random !== 1000)
    throw new Error('Expected 1000 random games')
  if (metadata.summary.gamesByOpponent.heuristic !== 1000) {
    throw new Error('Expected 1000 heuristic games')
  }
  if (metadata.summary.gamesByColor.R !== 1000) throw new Error('Expected 1000 games as R')
  if (metadata.summary.gamesByColor.B !== 1000) throw new Error('Expected 1000 games as B')
  for (const value of Object.values(metadata.summary.gamesByCombination)) {
    if (value !== 500) throw new Error('Expected 500 games for every opponent-color combination')
  }
  if (metadata.games.length !== 2000) throw new Error('Expected 2000 game records')
  if (metadata.summary.finalQTableEntries <= metadata.initialQTableEntries) {
    throw new Error('Expected Q-table to grow after continuation')
  }
  if (metadata.epsilonContinuationInitial !== 0.2834) {
    throw new Error('Expected continuation epsilon 0.2834')
  }
  if (metadata.epsilonContinuationInitial !== metadata.sourceCheckpoint.epsilonFinal) {
    throw new Error('Continuation epsilon must match source final epsilon')
  }
  for (const checkpoint of [500, 1000, 1500]) {
    if (!metadata.checkpointTrace?.some((item) => item.checkpoint === checkpoint)) {
      throw new Error(`Expected checkpoint trace to include Q4-${checkpoint}`)
    }
  }
  const expectedEpsilon = roundMetric(
    Math.max(
      metadata.epsilonContinuationInitial *
        metadata.hyperparameters.epsilonDecay ** (metadata.newTrainingGames ?? 0),
      metadata.hyperparameters.epsilonMin,
    ),
  )
  if (metadata.summary.epsilonFinal !== expectedEpsilon) {
    throw new Error(`Expected epsilonFinal ${expectedEpsilon}`)
  }
  const qTotal = metadata.games.reduce((total, game) => total + game.qHits + game.qMisses, 0)
  if (metadata.summary.qTotal.qHits + metadata.summary.qTotal.qMisses !== qTotal) {
    throw new Error('Q hit/miss total does not match game records')
  }
}

async function runCli(): Promise<void> {
  const command = process.argv[2] ?? 'pilot-40'
  if (command === 'train-2000') {
    const result = await continueLearningAgentQ4Training({
      sourceQTablePath: path.join(Q4_CHECKPOINT_1500_DIR, 'qtable_q4_1500.json'),
      sourceMetadataPath: path.join(Q4_CHECKPOINT_1500_DIR, 'metadata.json'),
      targetGames: 2000,
      checkpoint: 2000,
      seed: 3,
      outputDir: Q4_CHECKPOINT_2000_DIR,
      overwrite: process.argv.includes('--overwrite'),
    })
    validateQ4Checkpoint2000Metadata(result.metadata)
    console.log(`[trainLearningAgentQ4] Q4-2000 games: ${result.metadata.totalGames}`)
    console.log(`[trainLearningAgentQ4] Q4-2000 new games: ${result.metadata.newTrainingGames}`)
    console.log(`[trainLearningAgentQ4] Q4-2000 entries: ${Object.keys(result.qTable).length}`)
    console.log(`[trainLearningAgentQ4] Q4-2000 output: ${result.metadata.outputFiles.metadata}`)
    return
  }
  if (command === 'train-1500') {
    const result = await continueLearningAgentQ4Training({
      sourceQTablePath: path.join(Q4_CHECKPOINT_1000_DIR, 'qtable_q4_1000.json'),
      sourceMetadataPath: path.join(Q4_CHECKPOINT_1000_DIR, 'metadata.json'),
      targetGames: 1500,
      checkpoint: 1500,
      seed: 3,
      outputDir: Q4_CHECKPOINT_1500_DIR,
      overwrite: process.argv.includes('--overwrite'),
    })
    validateQ4Checkpoint1500Metadata(result.metadata)
    console.log(`[trainLearningAgentQ4] Q4-1500 games: ${result.metadata.totalGames}`)
    console.log(`[trainLearningAgentQ4] Q4-1500 new games: ${result.metadata.newTrainingGames}`)
    console.log(`[trainLearningAgentQ4] Q4-1500 entries: ${Object.keys(result.qTable).length}`)
    console.log(`[trainLearningAgentQ4] Q4-1500 output: ${result.metadata.outputFiles.metadata}`)
    return
  }
  if (command === 'train-1000') {
    const result = await continueLearningAgentQ4Training({
      sourceQTablePath: path.join(Q4_CHECKPOINT_500_DIR, 'qtable_q4_500.json'),
      sourceMetadataPath: path.join(Q4_CHECKPOINT_500_DIR, 'metadata.json'),
      targetGames: 1000,
      checkpoint: 1000,
      seed: 3,
      outputDir: Q4_CHECKPOINT_1000_DIR,
      overwrite: process.argv.includes('--overwrite'),
    })
    validateQ4Checkpoint1000Metadata(result.metadata)
    console.log(`[trainLearningAgentQ4] Q4-1000 games: ${result.metadata.totalGames}`)
    console.log(`[trainLearningAgentQ4] Q4-1000 new games: ${result.metadata.newTrainingGames}`)
    console.log(`[trainLearningAgentQ4] Q4-1000 entries: ${Object.keys(result.qTable).length}`)
    console.log(`[trainLearningAgentQ4] Q4-1000 output: ${result.metadata.outputFiles.metadata}`)
    return
  }
  if (command === 'train-500') {
    const result = await runLearningAgentQ4Training({
      totalGames: 500,
      checkpoint: 500,
      seed: 3,
      outputDir: Q4_CHECKPOINT_500_DIR,
      overwrite: process.argv.includes('--overwrite'),
    })
    validateQ4Checkpoint500Metadata(result.metadata)
    console.log(`[trainLearningAgentQ4] Q4-500 games: ${result.metadata.totalGames}`)
    console.log(`[trainLearningAgentQ4] Q4-500 entries: ${Object.keys(result.qTable).length}`)
    console.log(`[trainLearningAgentQ4] Q4-500 output: ${result.metadata.outputFiles.metadata}`)
    return
  }
  if (command !== 'pilot-40') throw new Error(`Unknown command: ${command}`)
  const result = await runLearningAgentQ4Training({
    totalGames: 40,
    checkpoint: 40,
    seed: 3,
    outputDir: Q4_PILOT_40_DIR,
    progressEvery: 0,
    overwrite: process.argv.includes('--overwrite'),
  })
  validateQ4PilotMetadata(result.metadata)
  console.log(`[trainLearningAgentQ4] Q4 pilot games: ${result.metadata.totalGames}`)
  console.log(`[trainLearningAgentQ4] Q4 pilot entries: ${Object.keys(result.qTable).length}`)
  console.log(`[trainLearningAgentQ4] Q4 pilot output: ${result.metadata.outputFiles.metadata}`)
}

function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectExecution()) {
  await runCli()
}
