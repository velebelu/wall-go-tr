import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import {
  chooseLearningAction,
  getLearningQTableKey,
  type QTableSnapshot,
} from '@/agents/learningPolicy'
import { getLegalActions, getRandomAction } from '@/utils/ai'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import {
  applyActionToState,
  getTerritoryCounts,
  groupResultsByBlocksOf10,
  runSingleGame,
  summarizeExperiment,
  type ExperimentDefinition,
  type GameComparisonResult,
} from './compareLearningAgents'

export const Q2_QTABLE_DIR = 'data/entrenamiento/q2/qtable'
export const Q2_EVALUATION_DIR = 'data/entrenamiento/q2/evaluaciones'

export interface Q2TrainingConfig {
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

export interface Q2TrainingMetadata {
  createdAt: string
  model: 'Q2'
  games: number
  qTableSize: number
  epsilonStart: number
  epsilonFinal: number
  alpha: number
  gamma: number
  wins: number
  losses: number
  ties: number
  winRate: number
  averageTerritory: {
    learning: number
    opponent: number
  }
  opponents: {
    random: number
    heuristic: number
  }
  colorDistribution: Record<Player, number>
  reward: {
    win: number
    loss: number
    tie: number
    finalTerritoryDiffMultiplier: number
    intermediateTerritoryDeltaMultiplier: number
    intermediateMin: number
    intermediateMax: number
  }
  qTablePath: string
}

interface Q2TrainingStats {
  games: number
  wins: number
  losses: number
  ties: number
  learningTerritoryTotal: number
  opponentTerritoryTotal: number
  opponents: {
    random: number
    heuristic: number
  }
  colorDistribution: Record<Player, number>
}

interface PendingTransition {
  state: GameSnapshot
  action: PlayerAction
}

export const Q2_REWARD_CONFIG = {
  win: 100,
  loss: -100,
  tie: 0,
  finalTerritoryDiffMultiplier: 1,
  intermediateTerritoryDeltaMultiplier: 0.01,
  intermediateMin: -0.05,
  intermediateMax: 0.05,
} as const

export const DEFAULT_Q2_TRAINING_CONFIG: Q2TrainingConfig = {
  totalGames: 500,
  checkpoints: [0, 500],
  outputDir: Q2_QTABLE_DIR,
  alpha: 0.1,
  gamma: 0.9,
  epsilonStart: 0.6,
  epsilonMin: 0.05,
  epsilonDecay: 0.9995,
  maxTurns: 250,
  progressEvery: 100,
}

export const Q2_EVALUATION_PLAN: Array<{ experiment: ExperimentDefinition; games: number }> = [
  {
    experiment: {
      name: 'q2_checkpoint_vs_random_as_red',
      players: { R: 'learning-pretrained', B: 'random' },
    },
    games: 30,
  },
  {
    experiment: {
      name: 'random_vs_q2_checkpoint_as_blue',
      players: { R: 'random', B: 'learning-pretrained' },
    },
    games: 30,
  },
  {
    experiment: {
      name: 'q2_checkpoint_vs_learning_empty_as_red',
      players: { R: 'learning-pretrained', B: 'learning-empty' },
    },
    games: 30,
  },
  {
    experiment: {
      name: 'learning_empty_vs_q2_checkpoint_as_blue',
      players: { R: 'learning-empty', B: 'learning-pretrained' },
    },
    games: 30,
  },
  {
    experiment: {
      name: 'q2_checkpoint_vs_heuristic_as_red',
      players: { R: 'learning-pretrained', B: 'heuristic' },
    },
    games: 10,
  },
  {
    experiment: {
      name: 'heuristic_vs_q2_checkpoint_as_blue',
      players: { R: 'heuristic', B: 'learning-pretrained' },
    },
    games: 10,
  },
]

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function checkpointName(games: number): string {
  return String(games).padStart(4, '0')
}

export function getQ2LearningSideForGame(gameNumber: number): Player {
  return gameNumber % 2 === 1 ? 'R' : 'B'
}

function chooseRandomOpponentAction(state: GameSnapshot): PlayerAction {
  const legalActions = getLegalActions(state)
  if (legalActions.length === 0) throw new Error(`No legal actions available for ${state.turn}`)
  return getRandomAction(legalActions)!
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function calculateIntermediateRewardQ2(
  prevState: GameSnapshot,
  nextState: GameSnapshot,
  learningSide: Player,
): number {
  const opponent = getOpponent(learningSide)
  const prevTerritory = getTerritoryCounts(prevState.board)
  const nextTerritory = getTerritoryCounts(nextState.board)
  const prevDiff = prevTerritory[learningSide] - prevTerritory[opponent]
  const nextDiff = nextTerritory[learningSide] - nextTerritory[opponent]
  return clamp(
    (nextDiff - prevDiff) * Q2_REWARD_CONFIG.intermediateTerritoryDeltaMultiplier,
    Q2_REWARD_CONFIG.intermediateMin,
    Q2_REWARD_CONFIG.intermediateMax,
  )
}

export function calculateFinalRewardQ2(
  winner: Player | 'tie',
  territory: Record<Player, number>,
  learningSide: Player,
): number {
  const opponent = getOpponent(learningSide)
  const base =
    winner === 'tie'
      ? Q2_REWARD_CONFIG.tie
      : winner === learningSide
        ? Q2_REWARD_CONFIG.win
        : Q2_REWARD_CONFIG.loss
  return (
    base +
    (territory[learningSide] - territory[opponent]) * Q2_REWARD_CONFIG.finalTerritoryDiffMultiplier
  )
}

export function getMaxQValueQ2(
  state: GameSnapshot | undefined,
  qTable: QTableSnapshot,
  terminal: boolean,
): number {
  if (terminal || !state || state.phase === 'finished') return 0
  const legalActions = getLegalActions(state)
  if (legalActions.length === 0) return 0
  return Math.max(...legalActions.map((action) => qTable[getLearningQTableKey(state, action)] ?? 0))
}

export function updateQValueQ2(params: {
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
  const nextMax = getMaxQValueQ2(params.nextState, params.qTable, params.terminal)
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

function createEmptyStats(): Q2TrainingStats {
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

function addStats(stats: Q2TrainingStats, gameStats: Omit<Q2TrainingStats, 'games'>): void {
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

async function runQ2TrainingGame(params: {
  gameNumber: number
  qTable: QTableSnapshot
  epsilon: number
  alpha: number
  gamma: number
  maxTurns: number
}): Promise<Omit<Q2TrainingStats, 'games'>> {
  let state = makeInitialState()
  const learningSide = getQ2LearningSideForGame(params.gameNumber)
  const opponentSide = getOpponent(learningSide)
  let pending: PendingTransition | undefined
  let pendingReward = 0
  let turns = 0

  while (state.phase !== 'finished' && !state.result && turns < params.maxTurns) {
    const prevState = snapshotFromState(state)
    const isLearningTurn = prevState.turn === learningSide

    if (isLearningTurn && pending) {
      updateQValueQ2({
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
      : chooseRandomOpponentAction(prevState)
    const applied = applyFullAction(state, action)
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
    updateQValueQ2({
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
    opponents: { random: 1, heuristic: 0 },
    colorDistribution: { R: learningSide === 'R' ? 1 : 0, B: learningSide === 'B' ? 1 : 0 },
  }
}

function buildMetadata(params: {
  games: number
  qTable: QTableSnapshot
  epsilonStart: number
  epsilonFinal: number
  alpha: number
  gamma: number
  stats: Q2TrainingStats
  qTablePath: string
}): Q2TrainingMetadata {
  return {
    createdAt: new Date().toISOString(),
    model: 'Q2',
    games: params.games,
    qTableSize: Object.keys(params.qTable).length,
    epsilonStart: params.epsilonStart,
    epsilonFinal: roundMetric(params.epsilonFinal),
    alpha: params.alpha,
    gamma: params.gamma,
    wins: params.stats.wins,
    losses: params.stats.losses,
    ties: params.stats.ties,
    winRate: params.stats.games ? roundMetric((params.stats.wins / params.stats.games) * 100) : 0,
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
    reward: { ...Q2_REWARD_CONFIG },
    qTablePath: params.qTablePath,
  }
}

export function saveQ2Checkpoint(params: {
  qTable: QTableSnapshot
  outputDir: string
  games: number
  metadata: Q2TrainingMetadata
}): void {
  mkdirSync(params.outputDir, { recursive: true })
  const checkpoint = checkpointName(params.games)
  writeFileSync(
    path.join(params.outputDir, `qtable_q2_${checkpoint}.json`),
    `${JSON.stringify(params.qTable, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    path.join(params.outputDir, `qtable_q2_${checkpoint}.metadata.json`),
    `${JSON.stringify(params.metadata, null, 2)}\n`,
    'utf8',
  )
}

export function loadQ2Checkpoint(qTablePath: string): QTableSnapshot {
  return JSON.parse(readFileSync(path.resolve(qTablePath), 'utf8')) as QTableSnapshot
}

export async function runLearningAgentQ2Training(
  options: Partial<Q2TrainingConfig> & { qTable?: QTableSnapshot } = {},
): Promise<{
  qTable: QTableSnapshot
  metadata: Q2TrainingMetadata
  checkpoints: Q2TrainingMetadata[]
}> {
  const config: Q2TrainingConfig = {
    ...DEFAULT_Q2_TRAINING_CONFIG,
    ...options,
    checkpoints: options.checkpoints ?? DEFAULT_Q2_TRAINING_CONFIG.checkpoints,
  }
  const qTable = options.qTable ?? {}
  const stats = createEmptyStats()
  const checkpointSet = new Set(config.checkpoints)
  const checkpoints: Q2TrainingMetadata[] = []
  let epsilon = config.epsilonStart

  if (checkpointSet.has(0)) {
    const qTablePath = path.join(config.outputDir, 'qtable_q2_0000.json')
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
    saveQ2Checkpoint({ qTable, outputDir: config.outputDir, games: 0, metadata })
    checkpoints.push(metadata)
  }

  for (let game = 1; game <= config.totalGames; game++) {
    const gameStats = await runQ2TrainingGame({
      gameNumber: game,
      qTable,
      epsilon,
      alpha: config.alpha,
      gamma: config.gamma,
      maxTurns: config.maxTurns,
    })
    epsilon = Math.max(epsilon * config.epsilonDecay, config.epsilonMin)
    addStats(stats, gameStats)

    if (config.progressEvery > 0 && game % config.progressEvery === 0) {
      console.log(
        `[trainLearningAgentQ2] ${game}/${config.totalGames} games, qTable=${Object.keys(qTable).length}, epsilon=${epsilon.toFixed(4)}`,
      )
    }

    if (checkpointSet.has(game)) {
      const checkpoint = checkpointName(game)
      const qTablePath = path.join(config.outputDir, `qtable_q2_${checkpoint}.json`)
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
      saveQ2Checkpoint({ qTable, outputDir: config.outputDir, games: game, metadata })
      checkpoints.push(metadata)
    }
  }

  const metadata = buildMetadata({
    games: stats.games,
    qTable,
    epsilonStart: config.epsilonStart,
    epsilonFinal: epsilon,
    alpha: config.alpha,
    gamma: config.gamma,
    stats,
    qTablePath: path.join(config.outputDir, `qtable_q2_${checkpointName(stats.games)}.json`),
  })

  return { qTable, metadata, checkpoints }
}

function csvEscape(value: string | number): string {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function resultsToCsv(results: GameComparisonResult[]): string {
  const headers = [
    'experiment',
    'game',
    'player_R',
    'player_B',
    'winner',
    'territory_R',
    'territory_B',
    'territory_diff_R_minus_B',
    'turns',
    'block_of_10',
  ]
  const rows = results.map((result) => [
    result.experiment,
    result.game,
    result.players.R,
    result.players.B,
    result.winner,
    result.territory.R,
    result.territory.B,
    result.territoryDiff,
    result.turns,
    Math.ceil(result.game / 10),
  ])
  return [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n')
}

export async function evaluateQ2Checkpoint(options: {
  qTablePath: string
  outputDir: string
  plan?: Array<{ experiment: ExperimentDefinition; games: number }>
}) {
  const qTable = loadQ2Checkpoint(options.qTablePath)
  const plan = options.plan ?? Q2_EVALUATION_PLAN
  const allResults: GameComparisonResult[] = []
  const experiments = []

  for (const item of plan) {
    const experimentResults: GameComparisonResult[] = []
    for (let game = 1; game <= item.games; game++) {
      const result = await runSingleGame({
        experiment: item.experiment,
        game,
        pretrainedQTable: qTable,
      })
      experimentResults.push(result)
      allResults.push(result)
    }
    experiments.push(
      summarizeExperiment(
        item.experiment.name,
        item.experiment.players,
        experimentResults,
        Object.keys(qTable).length,
      ),
    )
  }

  const summary = {
    createdAt: new Date().toISOString(),
    model: 'Q2',
    qTablePath: options.qTablePath,
    experiments,
    blocksOf10: groupResultsByBlocksOf10(allResults),
  }

  mkdirSync(options.outputDir, { recursive: true })
  writeFileSync(
    path.join(options.outputDir, 'learning_comparison_summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    path.join(options.outputDir, 'learning_comparison_results.csv'),
    `${resultsToCsv(allResults)}\n`,
    'utf8',
  )

  return { summary, results: allResults, outputDir: path.resolve(options.outputDir) }
}

async function runQ2Pilot(): Promise<void> {
  const training = await runLearningAgentQ2Training()
  const qTablePath = path.join(Q2_QTABLE_DIR, 'qtable_q2_0500.json')
  const evaluation = await evaluateQ2Checkpoint({
    qTablePath,
    outputDir: path.join(Q2_EVALUATION_DIR, 'checkpoint_0500'),
  })
  console.log(
    `[trainLearningAgentQ2] Q2-500 qTable entries: ${Object.keys(training.qTable).length}`,
  )
  console.log(`[trainLearningAgentQ2] Q2-500 evaluation output: ${evaluation.outputDir}`)
}

function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectExecution()) {
  const command = process.argv[2] ?? 'pilot'
  if (command === 'pilot') {
    await runQ2Pilot()
  } else if (command === 'train') {
    await runLearningAgentQ2Training()
  } else if (command === 'evaluate') {
    const qTablePath = process.argv[3] ?? path.join(Q2_QTABLE_DIR, 'qtable_q2_0500.json')
    await evaluateQ2Checkpoint({
      qTablePath,
      outputDir: path.join(Q2_EVALUATION_DIR, 'checkpoint_0500'),
    })
  } else {
    throw new Error(`Unknown command: ${command}`)
  }
}
