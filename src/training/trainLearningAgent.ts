import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { applyActionToState } from '@/engine/gameSimulator'
import {
  chooseLearningAction,
  getLearningQTableKey,
  type QTableSnapshot,
} from '@/agents/learningPolicy'
import {
  getBestHeuristicAction,
  getBestPlacement,
  getLegalActions,
  getRandomAction,
} from '@/utils/ai'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import {
  getTerritoryCounts,
  runLearningAgentComparison,
  type AgentKind,
  type ExperimentDefinition,
} from './compareLearningAgents'

export const DEFAULT_TRAINING_OUTPUT_DIR = 'data/entrenamiento/qtable'
export const DEFAULT_EVALUATION_OUTPUT_ROOT = 'data/entrenamiento/evaluaciones'
export const DEFAULT_CHECKPOINTS = [0, 500, 2000, 5000] as const

export interface TrainingConfig {
  totalGames: number
  checkpoints: number[]
  outputDir: string
  alpha: number
  gamma: number
  epsilonStart: number
  epsilonMin: number
  epsilonDecay: number
  maxTurns: number
  progressEvery: number
}

export interface TrainingMetadata {
  createdAt: string
  games: number
  qTableSize: number
  epsilonStart: number
  epsilonFinal: number
  alpha: number
  gamma: number
  wins: number
  losses: number
  ties: number
  averageTerritory: {
    learning: number
    opponent: number
  }
  opponents: Record<Exclude<AgentKind, 'learning-empty' | 'learning-pretrained'>, number>
  colorDistribution: Record<Player, number>
  qTablePath: string
}

export interface TrainingRunResult {
  qTable: QTableSnapshot
  metadata: TrainingMetadata
  checkpoints: TrainingMetadata[]
}

interface PendingLearningTransition {
  state: GameSnapshot
  action: PlayerAction
}

interface TrainingStats {
  games: number
  wins: number
  losses: number
  ties: number
  learningTerritoryTotal: number
  opponentTerritoryTotal: number
  opponents: Record<'random' | 'heuristic', number>
  colorDistribution: Record<Player, number>
}

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  totalGames: 5000,
  checkpoints: [...DEFAULT_CHECKPOINTS],
  outputDir: DEFAULT_TRAINING_OUTPUT_DIR,
  alpha: 0.1,
  gamma: 0.9,
  epsilonStart: 0.6,
  epsilonMin: 0.05,
  epsilonDecay: 0.9995,
  maxTurns: 250,
  progressEvery: 100,
}

export const CHECKPOINT_EVALUATION_EXPERIMENTS: ExperimentDefinition[] = [
  {
    name: 'checkpoint_vs_random_as_red',
    players: { R: 'learning-pretrained', B: 'random' },
  },
  {
    name: 'random_vs_checkpoint_as_blue',
    players: { R: 'random', B: 'learning-pretrained' },
  },
  {
    name: 'checkpoint_vs_heuristic_as_red',
    players: { R: 'learning-pretrained', B: 'heuristic' },
  },
  {
    name: 'heuristic_vs_checkpoint_as_blue',
    players: { R: 'heuristic', B: 'learning-pretrained' },
  },
  {
    name: 'checkpoint_vs_learning_empty_as_red',
    players: { R: 'learning-pretrained', B: 'learning-empty' },
  },
  {
    name: 'learning_empty_vs_checkpoint_as_blue',
    players: { R: 'learning-empty', B: 'learning-pretrained' },
  },
]

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

export function getLearningSideForGame(gameNumber: number): Player {
  return gameNumber % 2 === 1 ? 'R' : 'B'
}

export function getTrainingOpponentForGame(
  gameNumber: number,
  totalGames: number,
): 'random' | 'heuristic' {
  const randomGames = Math.ceil(totalGames * 0.6)
  return gameNumber <= randomGames ? 'random' : 'heuristic'
}

function chooseOpponentAction(state: GameSnapshot, opponent: 'random' | 'heuristic'): PlayerAction {
  const legalActions = getLegalActions(state)
  if (legalActions.length === 0) {
    throw new Error(`No legal actions available for ${state.turn}`)
  }

  if (opponent === 'random') return getRandomAction(legalActions)!

  return state.phase === 'placing'
    ? getBestPlacement(state)
    : (getBestHeuristicAction(state) ?? getRandomAction(legalActions)!)
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

function calculateIntermediateReward(
  prevState: GameSnapshot,
  nextState: GameSnapshot,
  learningSide: Player,
): number {
  const opponent = getOpponent(learningSide)
  const prevTerritory = getTerritoryCounts(prevState.board)
  const nextTerritory = getTerritoryCounts(nextState.board)
  const prevDiff = prevTerritory[learningSide] - prevTerritory[opponent]
  const nextDiff = nextTerritory[learningSide] - nextTerritory[opponent]
  return Math.max(-0.1, Math.min(0.1, (nextDiff - prevDiff) * 0.05))
}

function calculateFinalReward(
  winner: Player | 'tie',
  territory: Record<Player, number>,
  learningSide: Player,
): number {
  const opponent = getOpponent(learningSide)
  const baseReward = winner === 'tie' ? 0.3 : winner === learningSide ? 1 : -1
  const normalizedDiff = (territory[learningSide] - territory[opponent]) / 49
  return Math.max(-1.5, Math.min(1.5, baseReward + normalizedDiff))
}

function getMaxQValue(state: GameSnapshot, qTable: QTableSnapshot): number {
  if (state.phase === 'finished') return 0
  const legalActions = getLegalActions(state)
  if (legalActions.length === 0) return 0
  return Math.max(...legalActions.map((action) => qTable[getLearningQTableKey(state, action)] ?? 0))
}

export function updateQValue(params: {
  qTable: QTableSnapshot
  state: GameSnapshot
  action: PlayerAction
  reward: number
  nextState: GameSnapshot | undefined
  terminal: boolean
  alpha: number
  gamma: number
}): void {
  const key = getLearningQTableKey(params.state, params.action)
  const currentQ = params.qTable[key] ?? 0
  const nextMax =
    params.terminal || !params.nextState ? 0 : getMaxQValue(params.nextState, params.qTable)
  params.qTable[key] = currentQ + params.alpha * (params.reward + params.gamma * nextMax - currentQ)
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

async function runTrainingGame(params: {
  gameNumber: number
  totalGames: number
  qTable: QTableSnapshot
  epsilon: number
  alpha: number
  gamma: number
  maxTurns: number
}): Promise<{ epsilon: number; stats: Omit<TrainingStats, 'games'>; qTableChanged: boolean }> {
  let state = makeInitialState()
  const learningSide = getLearningSideForGame(params.gameNumber)
  const opponentSide = getOpponent(learningSide)
  const opponent = getTrainingOpponentForGame(params.gameNumber, params.totalGames)
  let pending: PendingLearningTransition | undefined
  let pendingReward = 0
  let turns = 0
  const qTableSizeBefore = Object.keys(params.qTable).length

  while (state.phase !== 'finished' && !state.result && turns < params.maxTurns) {
    const prevState = snapshotFromState(state)
    const isLearningTurn = prevState.turn === learningSide

    if (isLearningTurn && pending) {
      updateQValue({
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

    const action = isLearningTurn
      ? chooseLearningAction(prevState, getLegalActions(prevState), params.epsilon, params.qTable)
      : chooseOpponentAction(prevState, opponent)
    const applied = applyFullAction(state, action)
    state = applied.state
    turns += applied.turns
    pendingReward += calculateIntermediateReward(prevState, state, learningSide)

    if (isLearningTurn) {
      pending = { state: prevState, action }
    }
  }

  state = finalizeGameIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')

  if (pending) {
    updateQValue({
      qTable: params.qTable,
      state: pending.state,
      action: pending.action,
      reward: pendingReward + calculateFinalReward(winner, territory, learningSide),
      nextState: undefined,
      terminal: true,
      alpha: params.alpha,
      gamma: params.gamma,
    })
  }

  return {
    epsilon: params.epsilon,
    stats: {
      wins: winner === learningSide ? 1 : 0,
      losses: winner !== 'tie' && winner === opponentSide ? 1 : 0,
      ties: winner === 'tie' ? 1 : 0,
      learningTerritoryTotal: territory[learningSide],
      opponentTerritoryTotal: territory[opponentSide],
      opponents: {
        random: opponent === 'random' ? 1 : 0,
        heuristic: opponent === 'heuristic' ? 1 : 0,
      },
      colorDistribution: { R: learningSide === 'R' ? 1 : 0, B: learningSide === 'B' ? 1 : 0 },
    },
    qTableChanged: Object.keys(params.qTable).length !== qTableSizeBefore,
  }
}

function createEmptyStats(): TrainingStats {
  return {
    games: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    learningTerritoryTotal: 0,
    opponentTerritoryTotal: 0,
    opponents: { random: 0, heuristic: 0 },
    colorDistribution: { R: 0, B: 0 },
  }
}

function addStats(stats: TrainingStats, gameStats: Omit<TrainingStats, 'games'>): void {
  stats.games += 1
  stats.wins += gameStats.wins
  stats.losses += gameStats.losses
  stats.ties += gameStats.ties
  stats.learningTerritoryTotal += gameStats.learningTerritoryTotal
  stats.opponentTerritoryTotal += gameStats.opponentTerritoryTotal
  stats.opponents.random += gameStats.opponents.random
  stats.opponents.heuristic += gameStats.opponents.heuristic
  stats.colorDistribution.R += gameStats.colorDistribution.R
  stats.colorDistribution.B += gameStats.colorDistribution.B
}

function checkpointName(games: number): string {
  return String(games).padStart(4, '0')
}

function buildMetadata(params: {
  games: number
  qTable: QTableSnapshot
  epsilonStart: number
  epsilonFinal: number
  alpha: number
  gamma: number
  stats: TrainingStats
  qTablePath: string
}): TrainingMetadata {
  return {
    createdAt: new Date().toISOString(),
    games: params.games,
    qTableSize: Object.keys(params.qTable).length,
    epsilonStart: params.epsilonStart,
    epsilonFinal: roundMetric(params.epsilonFinal),
    alpha: params.alpha,
    gamma: params.gamma,
    wins: params.stats.wins,
    losses: params.stats.losses,
    ties: params.stats.ties,
    averageTerritory: {
      learning: params.stats.games
        ? roundMetric(params.stats.learningTerritoryTotal / params.stats.games)
        : 0,
      opponent: params.stats.games
        ? roundMetric(params.stats.opponentTerritoryTotal / params.stats.games)
        : 0,
    },
    opponents: params.stats.opponents,
    colorDistribution: params.stats.colorDistribution,
    qTablePath: params.qTablePath,
  }
}

export function saveCheckpoint(params: {
  qTable: QTableSnapshot
  outputDir: string
  games: number
  metadata: TrainingMetadata
}): void {
  mkdirSync(params.outputDir, { recursive: true })
  const name = checkpointName(params.games)
  const qTablePath = path.join(params.outputDir, `qtable_current_${name}.json`)
  const metadataPath = path.join(params.outputDir, `qtable_current_${name}.metadata.json`)
  writeFileSync(qTablePath, `${JSON.stringify(params.qTable, null, 2)}\n`, 'utf8')
  writeFileSync(metadataPath, `${JSON.stringify(params.metadata, null, 2)}\n`, 'utf8')
}

export function loadCheckpoint(qTablePath: string): QTableSnapshot {
  return JSON.parse(readFileSync(path.resolve(qTablePath), 'utf8')) as QTableSnapshot
}

export async function runLearningAgentTraining(
  options: Partial<TrainingConfig> & { qTable?: QTableSnapshot } = {},
): Promise<TrainingRunResult> {
  const config: TrainingConfig = {
    ...DEFAULT_TRAINING_CONFIG,
    ...options,
    checkpoints: options.checkpoints ?? DEFAULT_TRAINING_CONFIG.checkpoints,
  }
  const qTable = options.qTable ?? {}
  const stats = createEmptyStats()
  const checkpointSet = new Set(config.checkpoints)
  const checkpoints: TrainingMetadata[] = []
  let epsilon = config.epsilonStart

  if (checkpointSet.has(0)) {
    const qTablePath = path.join(config.outputDir, 'qtable_current_0000.json')
    const metadata = buildMetadata({
      games: 0,
      qTable,
      epsilonStart: config.epsilonStart,
      epsilonFinal: epsilon,
      alpha: config.alpha,
      gamma: config.gamma,
      stats,
      qTablePath,
    })
    saveCheckpoint({ qTable, outputDir: config.outputDir, games: 0, metadata })
    checkpoints.push(metadata)
  }

  for (let game = 1; game <= config.totalGames; game++) {
    const result = await runTrainingGame({
      gameNumber: game,
      totalGames: config.totalGames,
      qTable,
      epsilon,
      alpha: config.alpha,
      gamma: config.gamma,
      maxTurns: config.maxTurns,
    })
    epsilon = Math.max(result.epsilon * config.epsilonDecay, config.epsilonMin)
    addStats(stats, result.stats)

    if (config.progressEvery > 0 && game % config.progressEvery === 0) {
      console.log(
        `[trainLearningAgent] ${game}/${config.totalGames} games, qTable=${Object.keys(qTable).length}, epsilon=${epsilon.toFixed(4)}`,
      )
    }

    if (checkpointSet.has(game)) {
      const name = checkpointName(game)
      const qTablePath = path.join(config.outputDir, `qtable_current_${name}.json`)
      const metadata = buildMetadata({
        games: game,
        qTable,
        epsilonStart: config.epsilonStart,
        epsilonFinal: epsilon,
        alpha: config.alpha,
        gamma: config.gamma,
        stats,
        qTablePath,
      })
      saveCheckpoint({ qTable, outputDir: config.outputDir, games: game, metadata })
      checkpoints.push(metadata)
    }
  }

  const finalMetadata = buildMetadata({
    games: stats.games,
    qTable,
    epsilonStart: config.epsilonStart,
    epsilonFinal: epsilon,
    alpha: config.alpha,
    gamma: config.gamma,
    stats,
    qTablePath: path.join(config.outputDir, `qtable_current_${checkpointName(stats.games)}.json`),
  })

  return { qTable, metadata: finalMetadata, checkpoints }
}

export async function evaluateCheckpoint(options: {
  qTablePath: string
  outputDir: string
  games?: number
}) {
  return runLearningAgentComparison({
    qTablePath: options.qTablePath,
    outputDir: options.outputDir,
    games: options.games ?? 30,
    experiments: CHECKPOINT_EVALUATION_EXPERIMENTS,
  })
}

async function runPilot(): Promise<void> {
  const training = await runLearningAgentTraining({
    totalGames: 20,
    checkpoints: [0, 20],
    outputDir: path.join(DEFAULT_TRAINING_OUTPUT_DIR, 'tmp_small'),
    progressEvery: 10,
  })
  const qTablePath = path.join(DEFAULT_TRAINING_OUTPUT_DIR, 'tmp_small', 'qtable_current_0020.json')
  const evaluation = await evaluateCheckpoint({
    qTablePath,
    outputDir: path.join(DEFAULT_EVALUATION_OUTPUT_ROOT, 'tmp_small_checkpoint_0020'),
    games: 5,
  })
  console.log(`[trainLearningAgent] Pilot qTable entries: ${Object.keys(training.qTable).length}`)
  console.log(`[trainLearningAgent] Pilot evaluation output: ${evaluation.outputDir}`)
}

function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectExecution()) {
  const command = process.argv[2] ?? 'pilot'
  if (command === 'pilot') {
    await runPilot()
  } else if (command === 'train') {
    const totalGames = Number(process.argv[3] ?? DEFAULT_TRAINING_CONFIG.totalGames)
    await runLearningAgentTraining({ totalGames, checkpoints: DEFAULT_TRAINING_CONFIG.checkpoints })
  } else if (command === 'evaluate') {
    const qTablePath = process.argv[3]
    if (!qTablePath) throw new Error('Missing qTablePath for evaluate command')
    const games = Number(process.argv[4] ?? 30)
    const checkpoint = path.basename(qTablePath).replace('qtable_current_', '').replace('.json', '')
    await evaluateCheckpoint({
      qTablePath,
      games,
      outputDir: path.join(DEFAULT_EVALUATION_OUTPUT_ROOT, `checkpoint_${checkpoint}`),
    })
  } else {
    throw new Error(`Unknown command: ${command}`)
  }
}
