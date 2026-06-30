import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { BOARD_SIZE } from '@/lib/types'

export interface TrainingTraceActionEntry {
  turn: number
  player: Player
  stateKey: string
  actionType: PlayerAction['type']
  actionKey: string
}

export interface TrainingTraceGameRecord {
  id: string
  createdAt: string
  mode: 'heuristic_vs_heuristic'
  boardSize: number
  players: Record<Player, 'heuristic'>
  winner: Player | 'tie'
  finalScore: Record<Player, number>
  turns: number
  wallsPlaced: number
  initialStateKey: string
  finalStateKey: string
  actions: TrainingTraceActionEntry[]
}

function normalizeBoard(board: GameSnapshot['board']) {
  return board.map((row) => row.map((cell) => ({
    stone: cell.stone,
    wallTop: cell.wallTop,
    wallLeft: cell.wallLeft,
  })))
}

function normalizeStateForKey(state: GameSnapshot) {
  return {
    board: normalizeBoard(state.board),
    turn: state.turn,
    selected: state.selected ? { ...state.selected } : undefined,
    legal: Array.from(state.legal).sort(),
    stepsTaken: state.stepsTaken,
    phase: state.phase,
    players: [...state.players],
    stonesLimit: state.stonesLimit,
    stonesPlaced: { ...state.stonesPlaced },
    result: state.result ? { ...state.result } : undefined,
    skipReason: state.skipReason,
  }
}

export function getTrainingTraceStateKey(state: GameSnapshot): string {
  return JSON.stringify(normalizeStateForKey(state))
}

export function getTrainingTraceActionKey(action: PlayerAction): string {
  if (action.type === 'place') {
    return `place|${action.pos.x}|${action.pos.y}`
  }

  if (action.type === 'move') {
    return `move|${action.from?.x ?? ''}|${action.from?.y ?? ''}|${action.pos.x}|${action.pos.y}`
  }

  if (action.type === 'wall') {
    return `wall|${action.pos.x}|${action.pos.y}|${action.dir ?? ''}`
  }

  return 'unknown'
}

function countWalls(board: GameSnapshot['board']): number {
  let count = 0
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board.length; x++) {
      if (board[y][x].wallLeft) count++
      if (board[y][x].wallTop) count++
    }
  }
  return count
}

function getWinnerLabel(result: GameSnapshot['result'], score: Record<Player, number>): Player | 'tie' {
  if (!result && score.R === score.B) {
    return 'tie'
  }

  if (result?.winner) {
    return result.winner
  }

  if (score.R > score.B) return 'R'
  if (score.B > score.R) return 'B'
  return 'tie'
}

export function buildTrainingTraceGameRecord(params: {
  id: string
  createdAt: string
  initialState: GameSnapshot
  finalState: GameSnapshot
  players: Record<Player, 'heuristic'>
  finalScore: Record<Player, number>
  actions: Array<{
    turn: number
    player: Player
    state: GameSnapshot
    action: PlayerAction
  }>
}): TrainingTraceGameRecord {
  const initialStateKey = getTrainingTraceStateKey(params.initialState)
  const finalStateKey = getTrainingTraceStateKey(params.finalState)
  const wallsPlaced = countWalls(params.finalState.board)
  const winner = getWinnerLabel(params.finalState.result, params.finalScore)

  return {
    id: params.id,
    createdAt: params.createdAt,
    mode: 'heuristic_vs_heuristic',
    boardSize: BOARD_SIZE,
    players: params.players,
    winner,
    finalScore: params.finalScore,
    turns: params.actions.length,
    wallsPlaced,
    initialStateKey,
    finalStateKey,
    actions: params.actions.map(({ turn, player, state, action }) => ({
      turn,
      player,
      stateKey: getTrainingTraceStateKey(state),
      actionType: action.type,
      actionKey: getTrainingTraceActionKey(action),
    })),
  }
}

export function createTrainingTraceDirectoryName(): string {
  return 'data/entrenamiento/heuristicas'
}

export function downloadTrainingTraceFile(fileName: string, payload: TrainingTraceGameRecord): void {
  const json = JSON.stringify(payload, null, 2)
  try {
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (error) {
    console.error('[trainingTrace] Error descargando JSON:', error)
  }
}

export function getTrainingTraceStoragePath(fileName: string): string {
  return `${createTrainingTraceDirectoryName()}/${fileName}`
}

export function saveTrainingTraceToLocalStorage(fileName: string, payload: TrainingTraceGameRecord): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }

  const storageKey = `training_trace_${fileName}`
  localStorage.setItem(storageKey, JSON.stringify(payload))
}

export function createTrainingTraceFileName(index: number): string {
  return `training_game_${String(index).padStart(3, '0')}.json`
}
