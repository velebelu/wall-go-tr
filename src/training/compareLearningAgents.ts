import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Cell, GameSnapshot, Player, PlayerAction, WallDir } from '@/lib/types'
import { PLAYER_LIST } from '@/lib/types'
import {
  chooseLearningAction,
  getLearningQTableKey,
  type QTableSnapshot,
} from '@/agents/learningPolicy'
import { getBestHeuristicAction, getBestPlacement, getLegalActions, getRandomAction } from '@/utils/ai'
import { checkGameEnd } from '@/utils/game'
import { isLegalMove } from '@/utils/move'
import { getTerritoryMap } from '@/utils/territory'
import { advanceTurn, placingTurnIndex } from '@/store/actions'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { calculateFinalReward } from '@/agents/LearningAgent'

export const DEFAULT_COMPARISON_GAMES = 30
export const DEFAULT_PRETRAINED_QTABLE_PATH =
  'data/entrenamiento/qtable/qtable_from_heuristics.json'
export const DEFAULT_COMPARISON_OUTPUT_DIR = 'data/entrenamiento/comparativas'

type AgentKind = 'learning-empty' | 'learning-pretrained' | 'random' | 'heuristic'
type LearningKind = Extract<AgentKind, 'learning-empty' | 'learning-pretrained'>

export interface GameComparisonResult {
  experiment: string
  game: number
  players: Record<Player, AgentKind>
  winner: Player | 'tie'
  wins: Record<Player, number>
  territory: Record<Player, number>
  territoryDiff: number
  turns: number
}

export interface MetricsBlock {
  block: number
  fromGame: number
  toGame: number
  games: number
  wins: Record<Player | 'tie', number>
  winRates: Record<Player | 'tie', number>
  averageTerritory: Record<Player, number>
  averageTerritoryDiff: number
  averageTurns: number
}

export interface ExperimentSummary {
  name: string
  games: number
  players: Record<Player, AgentKind>
  wins: Record<Player | 'tie', number>
  winRates: Record<Player | 'tie', number>
  averageTerritory: Record<Player, number>
  averageTerritoryDiff: number
  averageTurns: number
  blocksOf10: MetricsBlock[]
  pretrainedQTableEntries?: number
}

interface LearningRuntime {
  kind: LearningKind
  qTable: QTableSnapshot
  epsilon: number
  trace: Array<{ state: GameSnapshot; action: PlayerAction; reward: number }>
}

interface ExperimentDefinition {
  name: string
  players: Record<Player, AgentKind>
}

const EXPERIMENTS: ExperimentDefinition[] = [
  {
    name: 'learning_empty_vs_random',
    players: { R: 'learning-empty', B: 'random' },
  },
  {
    name: 'random_vs_learning_empty',
    players: { R: 'random', B: 'learning-empty' },
  },
  {
    name: 'learning_pretrained_vs_random',
    players: { R: 'learning-pretrained', B: 'random' },
  },
  {
    name: 'random_vs_learning_pretrained',
    players: { R: 'random', B: 'learning-pretrained' },
  },
  {
    name: 'learning_pretrained_vs_heuristic',
    players: { R: 'learning-pretrained', B: 'heuristic' },
  },
  {
    name: 'heuristic_vs_learning_pretrained',
    players: { R: 'heuristic', B: 'learning-pretrained' },
  },
  {
    name: 'learning_pretrained_vs_learning_empty',
    players: { R: 'learning-pretrained', B: 'learning-empty' },
  },
  {
    name: 'learning_empty_vs_learning_pretrained',
    players: { R: 'learning-empty', B: 'learning-pretrained' },
  },
]

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function getTerritoryCounts(board: Cell[][]): Record<Player, number> {
  const territory = getTerritoryMap(board)
  const totals: Record<Player, number> = { R: 0, B: 0 }
  for (let y = 0; y < territory.length; y++) {
    for (let x = 0; x < territory[y].length; x++) {
      const owner = territory[y][x]
      if (owner) totals[owner]++
    }
  }
  return totals
}

function calculateIntermediateReward(
  prevState: GameSnapshot,
  nextState: GameSnapshot,
  playerSide: Player,
): number {
  const opponent = getOpponent(playerSide)
  const prevTerritory = getTerritoryCounts(prevState.board)
  const nextTerritory = getTerritoryCounts(nextState.board)
  const prevDiff = prevTerritory[playerSide] - prevTerritory[opponent]
  const nextDiff = nextTerritory[playerSide] - nextTerritory[opponent]
  return Math.max(-0.1, Math.min(0.1, (nextDiff - prevDiff) * 0.05))
}

function updateLearningAfterGame(
  learning: LearningRuntime,
  playerSide: Player,
  winner: Player | 'tie',
  territory: Record<Player, number>,
): void {
  const opponent = getOpponent(playerSide)
  const result = winner === 'tie' ? 'draw' : winner === playerSide ? 'win' : 'loss'
  const finalReward = calculateFinalReward(result, territory[playerSide], territory[opponent])
  let nextValue = 0

  for (let i = learning.trace.length - 1; i >= 0; i--) {
    const { state, action, reward } = learning.trace[i]!
    if (state.turn !== playerSide) continue

    const key = getLearningQTableKey(state, action)
    const currentQ = learning.qTable[key] ?? 0
    const totalReward = reward + (i === learning.trace.length - 1 ? finalReward : 0)
    const newQ = currentQ + 0.1 * (totalReward + 0.9 * nextValue - currentQ)
    learning.qTable[key] = newQ
    nextValue = newQ
  }

  learning.epsilon = Math.max(0.05, learning.epsilon * 0.995)
  learning.trace = []
}

function buildLearningRuntime(kind: LearningKind, pretrainedQTable: QTableSnapshot): LearningRuntime {
  return {
    kind,
    qTable: kind === 'learning-pretrained' ? { ...pretrainedQTable } : {},
    epsilon: 0,
    trace: [],
  }
}

function applyActionToState(state: GameSnapshot, action: PlayerAction): GameSnapshot {
  const next = snapshotFromState(state)

  if (action.type === 'place') {
    if (next.phase !== 'placing' || next.board[action.pos.y][action.pos.x].stone) return next

    const totalPlaced = Object.values(next.stonesPlaced).reduce((sum, count) => sum + count, 0)
    const currentIdx = placingTurnIndex(totalPlaced, next.players.length)
    const currentPlayer = next.players[currentIdx]!
    next.board[action.pos.y][action.pos.x].stone = currentPlayer
    next.stonesPlaced[currentPlayer]++

    const newTotal = totalPlaced + 1
    const nextIdx = placingTurnIndex(newTotal, next.players.length)
    const allDone = Object.values(next.stonesPlaced).every((count) => count === next.stonesLimit)
    next.turn = next.players[nextIdx]!
    next.phase = allDone ? 'playing' : 'placing'
    next.selected = undefined
    next.legal = new Set<string>()
    next.stepsTaken = 0
    next.result = undefined
    next.skipReason = undefined
    return next
  }

  if (action.type === 'move') {
    if (next.phase !== 'playing' || !action.from) return next
    if (next.board[action.from.y][action.from.x].stone !== next.turn) return next
    if (!isLegalMove(action.from, action.pos, next.board)) return next

    next.board[action.from.y][action.from.x].stone = null
    next.board[action.pos.y][action.pos.x].stone = next.turn
    const distance = Math.abs(action.pos.x - action.from.x) + Math.abs(action.pos.y - action.from.y)
    next.selected = { ...action.pos }
    next.stepsTaken += distance
    next.legal = new Set<string>()
    return next
  }

  if (action.type === 'wall' && action.dir) {
    if (next.phase !== 'playing') return next
    const from = action.from ?? action.pos
    if (next.board[from.y][from.x].stone !== next.turn) return next
    next.selected = { ...from }
    placeWall(next.board, action.pos, action.dir, next.turn)

    const end = checkGameEnd(next.board, PLAYER_LIST.slice())
    if (end.finished) {
      next.phase = 'finished'
      next.result = end
      next.selected = undefined
      next.legal = new Set<string>()
      next.stepsTaken = 0
      return next
    }

    const advanced = advanceTurn(next.board, next.turn, PLAYER_LIST.slice())
    if (advanced.skipReason === 'allBlocked') {
      const blockedEnd = checkGameEnd(next.board, PLAYER_LIST.slice())
      next.phase = 'finished'
      next.result = blockedEnd.finished ? blockedEnd : { ...blockedEnd, finished: true, tie: true }
      next.selected = undefined
      next.legal = new Set<string>()
      next.stepsTaken = 0
      next.skipReason = undefined
      return next
    }

    next.turn = advanced.turn
    next.selected = undefined
    next.legal = new Set<string>()
    next.stepsTaken = 0
    next.skipReason = advanced.skipReason
  }

  return next
}

function placeWall(board: Cell[][], pos: { x: number; y: number }, dir: WallDir, player: Player): void {
  if (dir === 'top') board[pos.y][pos.x].wallTop = player
  if (dir === 'left') board[pos.y][pos.x].wallLeft = player
  if (dir === 'right') board[pos.y][pos.x + 1].wallLeft = player
  if (dir === 'bottom') board[pos.y + 1][pos.x].wallTop = player
}

async function chooseAction(
  state: GameSnapshot,
  agent: AgentKind,
  learningRuntime: LearningRuntime | undefined,
): Promise<PlayerAction> {
  const legalActions = getLegalActions(state)
  if (legalActions.length === 0) {
    throw new Error(`No legal actions available for ${state.turn}`)
  }

  if (agent === 'random') {
    return getRandomAction(legalActions)!
  }

  if (agent === 'heuristic') {
    return state.phase === 'placing'
      ? getBestPlacement(state)
      : (getBestHeuristicAction(state) ?? getRandomAction(legalActions)!)
  }

  if (!learningRuntime) {
    throw new Error(`Missing runtime for ${agent}`)
  }

  return chooseLearningAction(state, legalActions, learningRuntime.epsilon, learningRuntime.qTable)
}

async function runSingleGame(params: {
  experiment: ExperimentDefinition
  game: number
  pretrainedQTable: QTableSnapshot
}): Promise<GameComparisonResult> {
  let state = makeInitialState()
  const learningRuntimes = Object.fromEntries(
    PLAYER_LIST.filter((player) => params.experiment.players[player].startsWith('learning')).map(
      (player) => [
        player,
        buildLearningRuntime(params.experiment.players[player] as LearningKind, params.pretrainedQTable),
      ],
    ),
  ) as Partial<Record<Player, LearningRuntime>>
  let turns = 0

  while (state.phase !== 'finished' && !state.result && turns < 250) {
    const player = state.turn
    const agent = params.experiment.players[player]
    const prevState = snapshotFromState(state)
    const action = await chooseAction(prevState, agent, learningRuntimes[player])
    state = applyActionToState(state, action)
    const learningRuntime = learningRuntimes[player]
    if (learningRuntime) {
      learningRuntime.trace.push({
        state: prevState,
        action,
        reward: calculateIntermediateReward(prevState, state, player),
      })
    }
    turns++

    if (action.followUp && state.phase !== 'finished') {
      const followPrevState = snapshotFromState(state)
      state = applyActionToState(state, action.followUp)
      if (learningRuntime) {
        learningRuntime.trace.push({
          state: followPrevState,
          action: action.followUp,
          reward: calculateIntermediateReward(followPrevState, state, player),
        })
      }
      turns++
    }
  }

  if (state.phase !== 'finished' && !state.result) {
    const territory = getTerritoryCounts(state.board)
    state = {
      ...state,
      phase: 'finished',
      result:
        territory.R === territory.B
          ? { finished: true, tie: true, score: territory }
          : { finished: true, winner: territory.R > territory.B ? 'R' : 'B', score: territory },
    }
  }

  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')

  for (const player of PLAYER_LIST) {
    const learningRuntime = learningRuntimes[player]
    if (learningRuntime) {
      updateLearningAfterGame(learningRuntime, player, winner, territory)
    }
  }
// Durante la evaluación no se actualiza la tabla Q.
// Se mide el rendimiento de los modelos tal como estaban al inicio de la partida.
/*
for (const player of PLAYER_LIST) {
  const learningRuntime = learningRuntimes[player]
  if (learningRuntime) {
    updateLearningAfterGame(learningRuntime, player, winner, territory)
  }
}
*/
  return {
    experiment: params.experiment.name,
    game: params.game,
    players: params.experiment.players,
    winner,
    wins: { R: winner === 'R' ? 1 : 0, B: winner === 'B' ? 1 : 0 },
    territory,
    territoryDiff: territory.R - territory.B,
    turns,
  }
}

export function calculateWins(results: GameComparisonResult[]): Record<Player | 'tie', number> {
  return results.reduce(
    (wins, result) => {
      wins[result.winner]++
      return wins
    },
    { R: 0, B: 0, tie: 0 } as Record<Player | 'tie', number>,
  )
}

export function calculateMetricsBlock(
  results: GameComparisonResult[],
  block: number,
): MetricsBlock {
  const wins = calculateWins(results)
  const games = results.length
  return {
    block,
    fromGame: results[0]?.game ?? 0,
    toGame: results[results.length - 1]?.game ?? 0,
    games,
    wins,
    winRates: {
      R: games ? roundMetric((wins.R / games) * 100) : 0,
      B: games ? roundMetric((wins.B / games) * 100) : 0,
      tie: games ? roundMetric((wins.tie / games) * 100) : 0,
    },
    averageTerritory: {
      R: roundMetric(average(results.map((result) => result.territory.R))),
      B: roundMetric(average(results.map((result) => result.territory.B))),
    },
    averageTerritoryDiff: roundMetric(average(results.map((result) => result.territoryDiff))),
    averageTurns: roundMetric(average(results.map((result) => result.turns))),
  }
}

export function groupResultsByBlocksOf10(results: GameComparisonResult[]): MetricsBlock[] {
  const blocks: MetricsBlock[] = []
  for (let index = 0; index < results.length; index += 10) {
    blocks.push(calculateMetricsBlock(results.slice(index, index + 10), blocks.length + 1))
  }
  return blocks
}

export function summarizeExperiment(
  name: string,
  players: Record<Player, AgentKind>,
  results: GameComparisonResult[],
  pretrainedQTableEntries?: number,
): ExperimentSummary {
  const metrics = calculateMetricsBlock(results, 0)
  return {
    name,
    games: results.length,
    players,
    wins: metrics.wins,
    winRates: metrics.winRates,
    averageTerritory: metrics.averageTerritory,
    averageTerritoryDiff: metrics.averageTerritoryDiff,
    averageTurns: metrics.averageTurns,
    blocksOf10: groupResultsByBlocksOf10(results),
    ...(pretrainedQTableEntries === undefined ? {} : { pretrainedQTableEntries }),
  }
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

function loadQTable(qTablePath: string): QTableSnapshot {
  return JSON.parse(readFileSync(path.resolve(qTablePath), 'utf8')) as QTableSnapshot
}

export async function runLearningAgentComparison(options: {
  games?: number
  qTablePath?: string
  outputDir?: string
} = {}) {
  const games = options.games ?? DEFAULT_COMPARISON_GAMES
  const outputDir = options.outputDir ?? DEFAULT_COMPARISON_OUTPUT_DIR
  const qTablePath = options.qTablePath ?? DEFAULT_PRETRAINED_QTABLE_PATH
  const pretrainedQTable = loadQTable(qTablePath)
  const allResults: GameComparisonResult[] = []
  const experiments: ExperimentSummary[] = []

  for (const experiment of EXPERIMENTS) {
    const experimentResults: GameComparisonResult[] = []
    for (let game = 1; game <= games; game++) {
      const result = await runSingleGame({ experiment, game, pretrainedQTable })
      experimentResults.push(result)
      allResults.push(result)
    }
    experiments.push(
      summarizeExperiment(
        experiment.name,
        experiment.players,
        experimentResults,
        experiment.name.includes('pretrained') ? Object.keys(pretrainedQTable).length : undefined,
      ),
    )
  }

  const summary = {
    createdAt: new Date().toISOString(),
    experiments,
  }

  const absoluteOutputDir = path.resolve(outputDir)
  mkdirSync(absoluteOutputDir, { recursive: true })
  writeFileSync(
    path.join(absoluteOutputDir, 'learning_comparison_summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    path.join(absoluteOutputDir, 'learning_comparison_results.csv'),
    `${resultsToCsv(allResults)}\n`,
    'utf8',
  )

  return {
    summary,
    results: allResults,
    outputDir: absoluteOutputDir,
    pretrainedQTableEntries: Object.keys(pretrainedQTable).length,
  }
}

function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectExecution()) {
  const gamesArg = Number(process.argv[2])
  const games = Number.isFinite(gamesArg) && gamesArg > 0 ? gamesArg : DEFAULT_COMPARISON_GAMES
  const result = await runLearningAgentComparison({ games })
  console.log(`[compareLearningAgents] Experiments: ${EXPERIMENTS.length}`)
  console.log(`[compareLearningAgents] Games per experiment: ${games}`)
  console.log(`[compareLearningAgents] Pretrained Q-table entries: ${result.pretrainedQTableEntries}`)
  console.log(`[compareLearningAgents] Output: ${result.outputDir}`)
}
