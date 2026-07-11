import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import type { QTableSnapshot } from '@/agents/learningPolicy'
import {
  getLearningActionKeyQ3,
  getLearningQTableKeyQ3,
  getLearningStateKeyQ3,
} from '@/agents/learningPolicyQ3'
import { getLegalActions } from '@/utils/ai'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { applyActionToState, getTerritoryCounts } from './compareLearningAgents'
import {
  DEFAULT_Q2_TRAINING_CONFIG,
  Q2_REWARD_CONFIG,
  calculateFinalRewardQ2,
  calculateIntermediateRewardQ2,
} from './trainLearningAgentQ2'

export const Q3_BASE_DIR = 'data/entrenamiento/q3'
export const Q3_REWARD_CONFIG = Q2_REWARD_CONFIG

type ActionKindQ3 = 'place' | 'move' | 'wall' | 'move-wall'

export interface Q3TrainingConfig {
  totalGames: number
  seed?: number
  outputDir: string
  alpha: number
  gamma: number
  epsilonStart: number
  epsilonMin: number
  epsilonDecay: number
  maxTurns: number
  progressEvery: number
  finalCheckpoint: number
  overwrite: boolean
}

interface Q3TrainingStats {
  games: number
  wins: number
  losses: number
  ties: number
  learningTerritoryTotal: number
  opponentTerritoryTotal: number
  territoryDiffTotal: number
  turnsTotal: number
  colorDistribution: Record<Player, number>
  resultsByColor: Record<Player, { wins: number; losses: number; ties: number }>
}

interface Q3RepresentationStats {
  stateVisits: Record<string, number>
  actionKeysByState: Record<string, Record<string, true>>
  moveWallActionKeys: Record<string, true>
  bucketDistributions: {
    td: Record<string, number>
    mobMine: Record<string, number>
    mobOpponent: Record<string, number>
    trapMine: Record<string, number>
    trapOpponent: Record<string, number>
    walls: Record<string, number>
  }
}

export interface Q3TrainingDiagnostics {
  qHits: number
  qMisses: number
  actionDistribution: Record<ActionKindQ3, number>
  representation: ReturnType<typeof summarizeRepresentationStats>
}

export interface Q3TrainingMetadata {
  model: 'Q3'
  baseRewardModel: 'Q2'
  stateRepresentation: 'Q3'
  initialization: 'empty'
  startedFromEmptyQTable: boolean
  checkpoint0Reused?: boolean
  checkpoint0Validated?: boolean
  continuedFromCheckpoint?: number
  sourceCheckpoint?: string
  previousQTableHash?: string
  additionalTrainingGames?: number
  totalTrainingGames?: number
  epsilonContinuationInitial?: number
  previousQTableEntries?: number
  previousUniqueQ3StatesVisited?: number
  previousUniqueQ3StatesFromQTable?: number
  finalUniqueQ3StatesFromQTable?: number
  additionalTrainingStats?: {
    wins: number
    losses: number
    ties: number
    qHits: number
    qMisses: number
    qTableEntriesBefore: number
    qTableEntriesAfter: number
  }
  trainingGames: number
  seed?: number
  alpha: number
  gamma: number
  epsilonInitial: number
  epsilonFinal: number
  epsilonMin: number
  epsilonDecay: number
  rewardConfiguration: typeof Q2_REWARD_CONFIG
  opponentConfiguration: { random: number; heuristic: number }
  boardSize: number
  createdAt: string
  durationMs: number
  qTableEntries: number
  uniqueQ3StatesVisited: number
  visitedStateActionPairs: number
  qHits: number
  qMisses: number
  actionDistribution: Record<ActionKindQ3, number>
  wins: number
  losses: number
  ties: number
  winRate: number
  resultsByColor: Record<Player, { wins: number; losses: number; ties: number }>
  averageTerritory: { learning: number; opponent: number }
  averageTerritoryDiff: number
  averageTurns: number
  representationStats: ReturnType<typeof summarizeRepresentationStats>
  configurationComparisonWithQ2: {
    sameRewardConfiguration: boolean
    sameHyperparameters: boolean
    sameOpponentConfiguration: boolean
    sameMaxTurns: boolean
    differences: string[]
  }
  outputFiles: {
    qTable: string
    metadata: string
    trainingSummary: string
  }
}

interface PendingTransition {
  state: GameSnapshot
  action: PlayerAction
}

export const DEFAULT_Q3_TRAINING_CONFIG: Q3TrainingConfig = {
  totalGames: 500,
  outputDir: path.join(Q3_BASE_DIR, 'checkpoint_500'),
  alpha: DEFAULT_Q2_TRAINING_CONFIG.alpha,
  gamma: DEFAULT_Q2_TRAINING_CONFIG.gamma,
  epsilonStart: DEFAULT_Q2_TRAINING_CONFIG.epsilonStart,
  epsilonMin: DEFAULT_Q2_TRAINING_CONFIG.epsilonMin,
  epsilonDecay: DEFAULT_Q2_TRAINING_CONFIG.epsilonDecay,
  maxTurns: DEFAULT_Q2_TRAINING_CONFIG.maxTurns,
  progressEvery: DEFAULT_Q2_TRAINING_CONFIG.progressEvery,
  finalCheckpoint: 500,
  overwrite: false,
}

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function getRng(seed: number | undefined): () => number {
  return seed === undefined ? Math.random : createSeededRng(seed)
}

export function getQ3LearningSideForGame(gameNumber: number): Player {
  return gameNumber % 2 === 1 ? 'R' : 'B'
}

function getActionKindQ3(action: PlayerAction): ActionKindQ3 {
  if (action.type === 'move' && action.followUp?.type === 'wall') return 'move-wall'
  return action.type
}

function chooseRandomActionWithRng(actions: PlayerAction[], rng: () => number): PlayerAction {
  if (actions.length === 0) throw new Error('No legal actions available')
  return actions[Math.floor(rng() * actions.length)]!
}

export function chooseLearningActionQ3(
  state: GameSnapshot,
  legalActions: PlayerAction[],
  epsilon: number,
  qTable: QTableSnapshot,
  rng: () => number = Math.random,
): { action: PlayerAction; selectedKeyExists: boolean } {
  if (legalActions.length === 0) throw new Error('No legal actions available')

  if (rng() < epsilon) {
    const action = chooseRandomActionWithRng(legalActions, rng)
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

  const action = chooseRandomActionWithRng(bestActions, rng)
  return { action, selectedKeyExists: qTable[getLearningQTableKeyQ3(state, action)] !== undefined }
}

export function getMaxQValueQ3(
  state: GameSnapshot | undefined,
  qTable: QTableSnapshot,
  terminal: boolean,
): number {
  if (terminal || !state || state.phase === 'finished') return 0
  const legalActions = getLegalActions(state)
  if (legalActions.length === 0) return 0
  return Math.max(
    ...legalActions.map((action) => qTable[getLearningQTableKeyQ3(state, action)] ?? 0),
  )
}

export function updateQValueQ3(params: {
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
  const nextMax = getMaxQValueQ3(params.nextState, params.qTable, params.terminal)
  params.qTable[key] = currentQ + params.alpha * (params.reward + params.gamma * nextMax - currentQ)
}

export function applyFullActionQ3(
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

function createStats(): Q3TrainingStats {
  return {
    games: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    learningTerritoryTotal: 0,
    opponentTerritoryTotal: 0,
    territoryDiffTotal: 0,
    turnsTotal: 0,
    colorDistribution: { R: 0, B: 0 },
    resultsByColor: {
      R: { wins: 0, losses: 0, ties: 0 },
      B: { wins: 0, losses: 0, ties: 0 },
    },
  }
}

function createRepresentationStats(): Q3RepresentationStats {
  return {
    stateVisits: {},
    actionKeysByState: {},
    moveWallActionKeys: {},
    bucketDistributions: {
      td: {},
      mobMine: {},
      mobOpponent: {},
      trapMine: {},
      trapOpponent: {},
      walls: {},
    },
  }
}

function addCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function parseQ3StateParts(q3StateKey: string): Record<string, string> {
  const parts: Record<string, string> = {}
  for (const segment of q3StateKey.split('|').slice(1)) {
    const [key, value] = segment.split(':')
    if (key && value) parts[key] = value
  }
  return parts
}

function recordRepresentationVisit(
  stats: Q3RepresentationStats,
  state: GameSnapshot,
  action: PlayerAction,
): void {
  const stateKey = getLearningStateKeyQ3(state)
  const actionKey = getLearningActionKeyQ3(state, action)
  stats.stateVisits[stateKey] = (stats.stateVisits[stateKey] ?? 0) + 1
  stats.actionKeysByState[stateKey] = stats.actionKeysByState[stateKey] ?? {}
  stats.actionKeysByState[stateKey][actionKey] = true
  if (getActionKindQ3(action) === 'move-wall') stats.moveWallActionKeys[actionKey] = true

  const parts = parseQ3StateParts(stateKey)
  addCount(stats.bucketDistributions.td, parts.td ?? '')
  const [mobMine, mobOpponent] = (parts.mob ?? ',').split(',')
  addCount(stats.bucketDistributions.mobMine, mobMine ?? '')
  addCount(stats.bucketDistributions.mobOpponent, mobOpponent ?? '')
  const [trapMine, trapOpponent] = (parts.trap ?? ',').split(',')
  addCount(stats.bucketDistributions.trapMine, trapMine ?? '')
  addCount(stats.bucketDistributions.trapOpponent, trapOpponent ?? '')
  addCount(stats.bucketDistributions.walls, parts.walls ?? '')
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function summarizeRepresentationStats(stats: Q3RepresentationStats) {
  const visits = Object.values(stats.stateVisits)
  const totalVisits = visits.reduce((sum, value) => sum + value, 0)
  const actionCounts = Object.values(stats.actionKeysByState).map(
    (actions) => Object.keys(actions).length,
  )
  return {
    uniqueStateKeys: Object.keys(stats.stateVisits).length,
    visitsByState: stats.stateVisits,
    statesVisitedOnce: visits.filter((value) => value === 1).length,
    statesWithAtLeast2: visits.filter((value) => value >= 2).length,
    statesWithAtLeast5: visits.filter((value) => value >= 5).length,
    statesWithAtLeast10: visits.filter((value) => value >= 10).length,
    statesWithAtLeast20: visits.filter((value) => value >= 20).length,
    maxVisits: visits.length ? Math.max(...visits) : 0,
    meanVisits: visits.length ? roundMetric(totalVisits / visits.length) : 0,
    medianVisits: roundMetric(median(visits)),
    bucketDistributions: stats.bucketDistributions,
    actionKeysPerState: {
      max: actionCounts.length ? Math.max(...actionCounts) : 0,
      mean: actionCounts.length
        ? roundMetric(actionCounts.reduce((sum, value) => sum + value, 0) / actionCounts.length)
        : 0,
    },
    differentiatedMoveWallActions: Object.keys(stats.moveWallActionKeys).length,
  }
}

function buildConfigComparison(
  config: Q3TrainingConfig,
): Q3TrainingMetadata['configurationComparisonWithQ2'] {
  const differences: string[] = ['state/action key functions: Q3 instead of Q2']
  const sameHyperparameters =
    config.alpha === DEFAULT_Q2_TRAINING_CONFIG.alpha &&
    config.gamma === DEFAULT_Q2_TRAINING_CONFIG.gamma &&
    config.epsilonStart === DEFAULT_Q2_TRAINING_CONFIG.epsilonStart &&
    config.epsilonMin === DEFAULT_Q2_TRAINING_CONFIG.epsilonMin &&
    config.epsilonDecay === DEFAULT_Q2_TRAINING_CONFIG.epsilonDecay
  const sameMaxTurns = config.maxTurns === DEFAULT_Q2_TRAINING_CONFIG.maxTurns
  return {
    sameRewardConfiguration: JSON.stringify(Q3_REWARD_CONFIG) === JSON.stringify(Q2_REWARD_CONFIG),
    sameHyperparameters,
    sameOpponentConfiguration: true,
    sameMaxTurns,
    differences,
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

function buildOutputFiles(
  outputDir: string,
  checkpoint: number,
): Q3TrainingMetadata['outputFiles'] {
  return {
    qTable: path.join(outputDir, `qtable_q3_${checkpoint}.json`),
    metadata: path.join(outputDir, 'metadata.json'),
    trainingSummary: path.join(outputDir, 'training_summary.json'),
  }
}

export function createFixedEvaluationQTableQ3(qTable: QTableSnapshot): QTableSnapshot {
  return { ...qTable }
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

export function loadQ3Checkpoint(qTablePath: string): QTableSnapshot {
  return readJsonFile<QTableSnapshot>(path.resolve(qTablePath))
}

export function loadQ3Metadata(metadataPath: string): Q3TrainingMetadata {
  return readJsonFile<Q3TrainingMetadata>(path.resolve(metadataPath))
}

function qTableStateCount(qTable: QTableSnapshot): number {
  return new Set(Object.keys(qTable).map((key) => key.split('|||')[0] ?? key)).size
}

function qTableHash(qTablePath: string): string {
  return createHash('sha256')
    .update(readFileSync(path.resolve(qTablePath)))
    .digest('hex')
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Invalid Q3 checkpoint_0: ${message}`)
}

export function validateQ3Checkpoint0(outputDir = path.join(Q3_BASE_DIR, 'checkpoint_0')): void {
  const qTablePath = path.join(outputDir, 'qtable_q3_0.json')
  const metadataPath = path.join(outputDir, 'metadata.json')

  assertCondition(existsSync(qTablePath), 'missing qtable_q3_0.json')
  assertCondition(existsSync(metadataPath), 'missing metadata.json')

  const qTable = readJsonFile<QTableSnapshot>(qTablePath)
  const metadata = readJsonFile<Partial<Q3TrainingMetadata>>(metadataPath)

  assertCondition(
    qTable && typeof qTable === 'object' && !Array.isArray(qTable),
    'qtable_q3_0.json must contain an object',
  )
  assertCondition(Object.keys(qTable).length === 0, 'qtable_q3_0.json must be empty')
  assertCondition(metadata.model === 'Q3', 'metadata.model must be Q3')
  assertCondition(metadata.initialization === 'empty', 'metadata.initialization must be empty')
  assertCondition(metadata.startedFromEmptyQTable === true, 'startedFromEmptyQTable must be true')
  assertCondition(metadata.trainingGames === 0, 'trainingGames must be 0')
  assertCondition(metadata.stateRepresentation === 'Q3', 'stateRepresentation must be Q3')
  assertCondition(
    JSON.stringify(metadata.rewardConfiguration) === JSON.stringify(Q2_REWARD_CONFIG),
    'rewardConfiguration must match Q2',
  )
  assertCondition(metadata.alpha === DEFAULT_Q2_TRAINING_CONFIG.alpha, 'alpha must match Q2')
  assertCondition(metadata.gamma === DEFAULT_Q2_TRAINING_CONFIG.gamma, 'gamma must match Q2')
  assertCondition(
    metadata.epsilonInitial === DEFAULT_Q2_TRAINING_CONFIG.epsilonStart,
    'epsilonInitial must match Q2',
  )
  assertCondition(
    metadata.epsilonMin === DEFAULT_Q2_TRAINING_CONFIG.epsilonMin,
    'epsilonMin must match Q2',
  )
  assertCondition(
    metadata.epsilonDecay === DEFAULT_Q2_TRAINING_CONFIG.epsilonDecay,
    'epsilonDecay must match Q2',
  )
  assertCondition(
    metadata.opponentConfiguration?.random === 0 && metadata.opponentConfiguration?.heuristic === 0,
    'opponentConfiguration must be empty random training baseline',
  )
  assertCondition(
    metadata.configurationComparisonWithQ2?.sameMaxTurns === true,
    'maxTurns must match Q2',
  )
  assertCondition(metadata.qTableEntries === 0, 'qTableEntries must be 0')
  assertCondition(metadata.wins === 0, 'wins must be 0')
  assertCondition(metadata.losses === 0, 'losses must be 0')
  assertCondition(metadata.ties === 0, 'ties must be 0')
  assertCondition(metadata.qHits === 0, 'qHits must be 0')
  assertCondition(metadata.qMisses === 0, 'qMisses must be 0')
  assertCondition(
    Object.values(metadata.actionDistribution ?? {}).every((value) => value === 0),
    'actionDistribution must be empty',
  )
}

export function prepareQ3Checkpoint0(
  options: {
    outputDir?: string
    seed?: number
    overwrite?: boolean
  } = {},
): { reused: boolean; validated: boolean } {
  const outputDir = options.outputDir ?? path.join(Q3_BASE_DIR, 'checkpoint_0')
  if (!existsSync(outputDir) || readdirSync(outputDir).length === 0) {
    saveQ3Checkpoint0(options)
    return { reused: false, validated: true }
  }

  validateQ3Checkpoint0(outputDir)
  return { reused: true, validated: true }
}

function buildMetadata(params: {
  config: Q3TrainingConfig
  stats: Q3TrainingStats
  diagnostics: Omit<Q3TrainingDiagnostics, 'representation'>
  representationStats: ReturnType<typeof summarizeRepresentationStats>
  qTable: QTableSnapshot
  epsilonFinal: number
  durationMs: number
  outputFiles: Q3TrainingMetadata['outputFiles']
  checkpoint0: { reused: boolean; validated: boolean }
  continuation?: Partial<Q3TrainingMetadata>
}): Q3TrainingMetadata {
  const games = params.stats.games
  return {
    model: 'Q3',
    baseRewardModel: 'Q2',
    stateRepresentation: 'Q3',
    initialization: 'empty',
    startedFromEmptyQTable: true,
    checkpoint0Reused: params.checkpoint0.reused,
    checkpoint0Validated: params.checkpoint0.validated,
    ...params.continuation,
    trainingGames: params.config.totalGames,
    ...(params.config.seed === undefined ? {} : { seed: params.config.seed }),
    alpha: params.config.alpha,
    gamma: params.config.gamma,
    epsilonInitial: params.config.epsilonStart,
    epsilonFinal: roundMetric(params.epsilonFinal),
    epsilonMin: params.config.epsilonMin,
    epsilonDecay: params.config.epsilonDecay,
    rewardConfiguration: { ...Q3_REWARD_CONFIG },
    opponentConfiguration: { random: games, heuristic: 0 },
    boardSize: makeInitialState().board.length,
    createdAt: new Date().toISOString(),
    durationMs: params.durationMs,
    qTableEntries: Object.keys(params.qTable).length,
    uniqueQ3StatesVisited: params.representationStats.uniqueStateKeys,
    visitedStateActionPairs: Object.keys(params.qTable).length,
    qHits: params.diagnostics.qHits,
    qMisses: params.diagnostics.qMisses,
    actionDistribution: params.diagnostics.actionDistribution,
    wins: params.stats.wins,
    losses: params.stats.losses,
    ties: params.stats.ties,
    winRate: games ? roundMetric((params.stats.wins / games) * 100) : 0,
    resultsByColor: params.stats.resultsByColor,
    averageTerritory: {
      learning: games ? roundMetric(params.stats.learningTerritoryTotal / games) : 0,
      opponent: games ? roundMetric(params.stats.opponentTerritoryTotal / games) : 0,
    },
    averageTerritoryDiff: games ? roundMetric(params.stats.territoryDiffTotal / games) : 0,
    averageTurns: games ? roundMetric(params.stats.turnsTotal / games) : 0,
    representationStats: params.representationStats,
    configurationComparisonWithQ2: buildConfigComparison(params.config),
    outputFiles: params.outputFiles,
  }
}

function statsFromMetadata(metadata: Q3TrainingMetadata): Q3TrainingStats {
  return {
    games: metadata.trainingGames,
    wins: metadata.wins,
    losses: metadata.losses,
    ties: metadata.ties,
    learningTerritoryTotal: metadata.averageTerritory.learning * metadata.trainingGames,
    opponentTerritoryTotal: metadata.averageTerritory.opponent * metadata.trainingGames,
    territoryDiffTotal: metadata.averageTerritoryDiff * metadata.trainingGames,
    turnsTotal: metadata.averageTurns * metadata.trainingGames,
    colorDistribution: {
      R:
        (metadata.resultsByColor.R.wins ?? 0) +
        (metadata.resultsByColor.R.losses ?? 0) +
        (metadata.resultsByColor.R.ties ?? 0),
      B:
        (metadata.resultsByColor.B.wins ?? 0) +
        (metadata.resultsByColor.B.losses ?? 0) +
        (metadata.resultsByColor.B.ties ?? 0),
    },
    resultsByColor: {
      R: { ...metadata.resultsByColor.R },
      B: { ...metadata.resultsByColor.B },
    },
  }
}

export function saveQ3Checkpoint(params: {
  qTable: QTableSnapshot
  outputDir: string
  checkpoint: number
  metadata: Q3TrainingMetadata
  trainingSummary?: unknown
  overwrite?: boolean
}): void {
  assertOutputCanBeWritten(params.outputDir, params.overwrite ?? false)
  mkdirSync(params.outputDir, { recursive: true })
  const outputFiles = buildOutputFiles(params.outputDir, params.checkpoint)
  writeJson(outputFiles.qTable, params.qTable)
  writeJson(outputFiles.metadata, params.metadata)
  if (params.trainingSummary !== undefined)
    writeJson(outputFiles.trainingSummary, params.trainingSummary)
}

export function saveQ3Checkpoint0(
  options: {
    outputDir?: string
    seed?: number
    overwrite?: boolean
  } = {},
): Q3TrainingMetadata {
  const outputDir = options.outputDir ?? path.join(Q3_BASE_DIR, 'checkpoint_0')
  const config = {
    ...DEFAULT_Q3_TRAINING_CONFIG,
    totalGames: 0,
    outputDir,
    finalCheckpoint: 0,
    seed: options.seed,
    overwrite: options.overwrite ?? false,
  }
  const outputFiles = buildOutputFiles(outputDir, 0)
  const representationStats = summarizeRepresentationStats(createRepresentationStats())
  const metadata = buildMetadata({
    config,
    stats: createStats(),
    diagnostics: {
      qHits: 0,
      qMisses: 0,
      actionDistribution: { place: 0, move: 0, wall: 0, 'move-wall': 0 },
    },
    representationStats,
    qTable: {},
    epsilonFinal: config.epsilonStart,
    durationMs: 0,
    outputFiles,
    checkpoint0: { reused: false, validated: true },
  })
  saveQ3Checkpoint({ qTable: {}, outputDir, checkpoint: 0, metadata, overwrite: config.overwrite })
  return metadata
}

async function runQ3TrainingGame(params: {
  gameNumber: number
  qTable: QTableSnapshot
  epsilon: number
  alpha: number
  gamma: number
  maxTurns: number
  rng: () => number
  diagnostics: Omit<Q3TrainingDiagnostics, 'representation'>
  representationStats: Q3RepresentationStats
}): Promise<Omit<Q3TrainingStats, 'games'>> {
  let state = makeInitialState()
  const learningSide = getQ3LearningSideForGame(params.gameNumber)
  const opponentSide = getOpponent(learningSide)
  let pending: PendingTransition | undefined
  let pendingReward = 0
  let turns = 0

  while (state.phase !== 'finished' && !state.result && turns < params.maxTurns) {
    const prevState = snapshotFromState(state)
    const isLearningTurn = prevState.turn === learningSide

    if (isLearningTurn && pending) {
      updateQValueQ3({
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
      const choice = chooseLearningActionQ3(
        prevState,
        getLegalActions(prevState),
        params.epsilon,
        params.qTable,
        params.rng,
      )
      action = choice.action
      if (choice.selectedKeyExists) params.diagnostics.qHits++
      else params.diagnostics.qMisses++
      params.diagnostics.actionDistribution[getActionKindQ3(action)]++
      recordRepresentationVisit(params.representationStats, prevState, action)
    } else {
      action = chooseRandomActionWithRng(getLegalActions(prevState), params.rng)
    }

    const applied = applyFullActionQ3(state, action)
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
    updateQValueQ3({
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
    wins: winner === learningSide ? 1 : 0,
    losses: winner !== 'tie' && winner === opponentSide ? 1 : 0,
    ties: winner === 'tie' ? 1 : 0,
    learningTerritoryTotal: territory[learningSide],
    opponentTerritoryTotal: territory[opponentSide],
    territoryDiffTotal: territory[learningSide] - territory[opponentSide],
    turnsTotal: turns,
    colorDistribution: { R: learningSide === 'R' ? 1 : 0, B: learningSide === 'B' ? 1 : 0 },
    resultsByColor: {
      R:
        learningSide === 'R'
          ? {
              wins: winner === 'R' ? 1 : 0,
              losses: winner === 'B' ? 1 : 0,
              ties: winner === 'tie' ? 1 : 0,
            }
          : { wins: 0, losses: 0, ties: 0 },
      B:
        learningSide === 'B'
          ? {
              wins: winner === 'B' ? 1 : 0,
              losses: winner === 'R' ? 1 : 0,
              ties: winner === 'tie' ? 1 : 0,
            }
          : { wins: 0, losses: 0, ties: 0 },
    },
  }
}

function addStats(stats: Q3TrainingStats, gameStats: Omit<Q3TrainingStats, 'games'>): void {
  stats.games++
  stats.wins += gameStats.wins
  stats.losses += gameStats.losses
  stats.ties += gameStats.ties
  stats.learningTerritoryTotal += gameStats.learningTerritoryTotal
  stats.opponentTerritoryTotal += gameStats.opponentTerritoryTotal
  stats.territoryDiffTotal += gameStats.territoryDiffTotal
  stats.turnsTotal += gameStats.turnsTotal
  stats.colorDistribution.R += gameStats.colorDistribution.R
  stats.colorDistribution.B += gameStats.colorDistribution.B
  for (const color of ['R', 'B'] as const) {
    stats.resultsByColor[color].wins += gameStats.resultsByColor[color].wins
    stats.resultsByColor[color].losses += gameStats.resultsByColor[color].losses
    stats.resultsByColor[color].ties += gameStats.resultsByColor[color].ties
  }
}

export async function runLearningAgentQ3Training(
  options: Partial<Q3TrainingConfig> = {},
): Promise<{ qTable: QTableSnapshot; metadata: Q3TrainingMetadata }> {
  const config: Q3TrainingConfig = { ...DEFAULT_Q3_TRAINING_CONFIG, ...options }
  assertOutputCanBeWritten(config.outputDir, config.overwrite)
  const startedAt = Date.now()
  const rng = getRng(config.seed)
  const qTable: QTableSnapshot = {}
  const stats = createStats()
  const representationStats = createRepresentationStats()
  const diagnostics: Omit<Q3TrainingDiagnostics, 'representation'> = {
    qHits: 0,
    qMisses: 0,
    actionDistribution: { place: 0, move: 0, wall: 0, 'move-wall': 0 },
  }

  const checkpoint0 = prepareQ3Checkpoint0({
    outputDir: path.join(path.dirname(config.outputDir), 'checkpoint_0'),
    seed: config.seed,
    overwrite: config.overwrite,
  })

  let epsilon = config.epsilonStart
  for (let game = 1; game <= config.totalGames; game++) {
    const gameStats = await runQ3TrainingGame({
      gameNumber: game,
      qTable,
      epsilon,
      alpha: config.alpha,
      gamma: config.gamma,
      maxTurns: config.maxTurns,
      rng,
      diagnostics,
      representationStats,
    })
    epsilon = Math.max(epsilon * config.epsilonDecay, config.epsilonMin)
    addStats(stats, gameStats)

    if (config.progressEvery > 0 && game % config.progressEvery === 0) {
      console.log(
        `[trainLearningAgentQ3] ${game}/${config.totalGames} games, qTable=${Object.keys(qTable).length}, epsilon=${epsilon.toFixed(4)}`,
      )
    }
  }

  const outputFiles = buildOutputFiles(config.outputDir, config.finalCheckpoint)
  const representationSummary = summarizeRepresentationStats(representationStats)
  const metadata = buildMetadata({
    config,
    stats,
    diagnostics,
    representationStats: representationSummary,
    qTable,
    epsilonFinal: epsilon,
    durationMs: Date.now() - startedAt,
    outputFiles,
    checkpoint0,
  })
  const trainingSummary = {
    model: 'Q3',
    trainingGames: config.totalGames,
    seed: config.seed,
    qTableEntries: Object.keys(qTable).length,
    wins: metadata.wins,
    losses: metadata.losses,
    ties: metadata.ties,
    winRate: metadata.winRate,
    representationStats: representationSummary,
  }

  saveQ3Checkpoint({
    qTable,
    outputDir: config.outputDir,
    checkpoint: config.finalCheckpoint,
    metadata,
    trainingSummary,
    overwrite: config.overwrite,
  })

  return { qTable, metadata }
}

export async function continueLearningAgentQ3Training(options: {
  sourceQTablePath: string
  sourceMetadataPath: string
  targetGames: number
  outputDir: string
  seed: number
  progressEvery?: number
  overwrite?: boolean
}): Promise<{ qTable: QTableSnapshot; metadata: Q3TrainingMetadata }> {
  const sourceQTablePath = path.resolve(options.sourceQTablePath)
  const sourceMetadata = loadQ3Metadata(options.sourceMetadataPath)
  const qTable = loadQ3Checkpoint(sourceQTablePath)
  const previousQTableHash = qTableHash(sourceQTablePath)
  const previousQTableEntries = Object.keys(qTable).length
  const previousUniqueQ3StatesFromQTable = qTableStateCount(qTable)

  if (sourceMetadata.model !== 'Q3') throw new Error('Source metadata must be Q3')
  if (sourceMetadata.trainingGames >= options.targetGames) {
    throw new Error('targetGames must be greater than source trainingGames')
  }
  if (sourceMetadata.seed !== options.seed) {
    throw new Error(
      `Source seed ${sourceMetadata.seed} does not match requested seed ${options.seed}`,
    )
  }

  const config: Q3TrainingConfig = {
    ...DEFAULT_Q3_TRAINING_CONFIG,
    totalGames: options.targetGames,
    outputDir: options.outputDir,
    finalCheckpoint: options.targetGames,
    seed: options.seed,
    alpha: sourceMetadata.alpha,
    gamma: sourceMetadata.gamma,
    epsilonStart: sourceMetadata.epsilonFinal,
    epsilonMin: sourceMetadata.epsilonMin,
    epsilonDecay: sourceMetadata.epsilonDecay,
    progressEvery: options.progressEvery ?? DEFAULT_Q3_TRAINING_CONFIG.progressEvery,
    overwrite: options.overwrite ?? false,
  }
  assertOutputCanBeWritten(config.outputDir, config.overwrite)

  const stats = statsFromMetadata(sourceMetadata)
  const additionalStats = createStats()
  const representationStats = createRepresentationStats()
  const diagnostics: Omit<Q3TrainingDiagnostics, 'representation'> = {
    qHits: 0,
    qMisses: 0,
    actionDistribution: { place: 0, move: 0, wall: 0, 'move-wall': 0 },
  }
  const rng = getRng(config.seed)
  const startedAt = Date.now()
  let epsilon = sourceMetadata.epsilonFinal

  for (let game = sourceMetadata.trainingGames + 1; game <= options.targetGames; game++) {
    const gameStats = await runQ3TrainingGame({
      gameNumber: game,
      qTable,
      epsilon,
      alpha: config.alpha,
      gamma: config.gamma,
      maxTurns: config.maxTurns,
      rng,
      diagnostics,
      representationStats,
    })
    epsilon = Math.max(epsilon * config.epsilonDecay, config.epsilonMin)
    addStats(stats, gameStats)
    addStats(additionalStats, gameStats)

    const completed = game - sourceMetadata.trainingGames
    const totalAdditional = options.targetGames - sourceMetadata.trainingGames
    if (config.progressEvery > 0 && completed % config.progressEvery === 0) {
      console.log(
        `[trainLearningAgentQ3] continued ${completed}/${totalAdditional} games (${game}/${options.targetGames} total), qTable=${Object.keys(qTable).length}, epsilon=${epsilon.toFixed(4)}`,
      )
    }
  }

  const outputFiles = buildOutputFiles(config.outputDir, config.finalCheckpoint)
  const representationSummary = summarizeRepresentationStats(representationStats)
  const metadata = buildMetadata({
    config,
    stats,
    diagnostics: {
      qHits: (sourceMetadata.qHits ?? 0) + diagnostics.qHits,
      qMisses: (sourceMetadata.qMisses ?? 0) + diagnostics.qMisses,
      actionDistribution: {
        place:
          (sourceMetadata.actionDistribution.place ?? 0) + diagnostics.actionDistribution.place,
        move: (sourceMetadata.actionDistribution.move ?? 0) + diagnostics.actionDistribution.move,
        wall: (sourceMetadata.actionDistribution.wall ?? 0) + diagnostics.actionDistribution.wall,
        'move-wall':
          (sourceMetadata.actionDistribution['move-wall'] ?? 0) +
          diagnostics.actionDistribution['move-wall'],
      },
    },
    representationStats: representationSummary,
    qTable,
    epsilonFinal: epsilon,
    durationMs: Date.now() - startedAt,
    outputFiles,
    checkpoint0: { reused: true, validated: true },
    continuation: {
      continuedFromCheckpoint: sourceMetadata.trainingGames,
      sourceCheckpoint: sourceQTablePath,
      previousQTableHash,
      additionalTrainingGames: options.targetGames - sourceMetadata.trainingGames,
      totalTrainingGames: options.targetGames,
      epsilonContinuationInitial: sourceMetadata.epsilonFinal,
      previousQTableEntries,
      previousUniqueQ3StatesVisited: sourceMetadata.uniqueQ3StatesVisited,
      previousUniqueQ3StatesFromQTable,
      finalUniqueQ3StatesFromQTable: qTableStateCount(qTable),
      additionalTrainingStats: {
        wins: additionalStats.wins,
        losses: additionalStats.losses,
        ties: additionalStats.ties,
        qHits: diagnostics.qHits,
        qMisses: diagnostics.qMisses,
        qTableEntriesBefore: previousQTableEntries,
        qTableEntriesAfter: Object.keys(qTable).length,
      },
    },
  })
  const trainingSummary = {
    model: 'Q3',
    trainingGames: options.targetGames,
    continuedFromCheckpoint: sourceMetadata.trainingGames,
    additionalTrainingGames: options.targetGames - sourceMetadata.trainingGames,
    seed: config.seed,
    qTableEntries: Object.keys(qTable).length,
    wins: metadata.wins,
    losses: metadata.losses,
    ties: metadata.ties,
    winRate: metadata.winRate,
    additionalTrainingStats: metadata.additionalTrainingStats,
    representationStats: representationSummary,
  }

  saveQ3Checkpoint({
    qTable,
    outputDir: config.outputDir,
    checkpoint: config.finalCheckpoint,
    metadata,
    trainingSummary,
    overwrite: config.overwrite,
  })

  return { qTable, metadata }
}

async function runCli(): Promise<void> {
  const command = process.argv[2] ?? 'pilot-10'
  if (command === 'checkpoint-0') {
    const metadata = saveQ3Checkpoint0()
    console.log(`[trainLearningAgentQ3] checkpoint 0 output: ${metadata.outputFiles.metadata}`)
    return
  }
  if (command === 'pilot-10') {
    const result = await runLearningAgentQ3Training({
      totalGames: 10,
      finalCheckpoint: 10,
      outputDir: path.join(Q3_BASE_DIR, 'piloto_10'),
      progressEvery: 0,
      seed: 3,
      overwrite: process.argv.includes('--overwrite'),
    })
    console.log(`[trainLearningAgentQ3] Q3 pilot entries: ${Object.keys(result.qTable).length}`)
    console.log(`[trainLearningAgentQ3] Q3 pilot output: ${result.metadata.outputFiles.metadata}`)
    return
  }
  if (command === 'train-500') {
    const result = await runLearningAgentQ3Training({
      totalGames: 500,
      finalCheckpoint: 500,
      outputDir: path.join(Q3_BASE_DIR, 'checkpoint_500'),
      seed: 3,
      overwrite: process.argv.includes('--overwrite'),
    })
    console.log(`[trainLearningAgentQ3] Q3-500 entries: ${Object.keys(result.qTable).length}`)
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectExecution()) {
  await runCli()
}
