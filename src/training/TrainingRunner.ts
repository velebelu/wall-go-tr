import { TurnManager } from '@/agents/TurnManager'
import { HeuristicAgent } from '@/agents/HeuristicAgent'
import { useGame } from '@/store/index'
import { snapshotFromState } from '@/store/gameState'
import { checkGameEnd } from '@/utils/game'
import { getTerritoryMap } from '@/utils/territory'
import { type PlayerAction, type Player } from '@/lib/types'
import type { TrainingResult, TrainingActionRecord } from './trainingTypes'

function csvEscape(value: string | number | '' | undefined): string {
  if (value === undefined || value === null) return ''
  const text = String(value)
  if (text.includes(',') || text.includes('\n') || text.includes('"')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

type CsvRow = Record<string, string | number | ''>

function downloadCsvFile(fileName: string, headers: string[], rows: CsvRow[]): void {
  const csv = [headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\n')
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (e) {
    console.error('[TrainingRunner] Error descargando CSV:', e)
  }
}

function countWalls(board: ReturnType<typeof snapshotFromState>['board']): number {
  let count = 0
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board.length; x++) {
      if (board[y][x].wallLeft) count++
      if (board[y][x].wallTop) count++
    }
  }
  return count
}

function getTerritoryCounts(board: ReturnType<typeof snapshotFromState>['board']): { R: number; B: number } {
  const territory = getTerritoryMap(board)
  const totals = { R: 0, B: 0 }
  for (let y = 0; y < territory.length; y++) {
    for (let x = 0; x < territory[y].length; x++) {
      const owner = territory[y][x]
      if (owner) totals[owner]++
    }
  }
  return totals
}

function buildActionRecord(
  id_partida: string,
  turno: number,
  player: Player,
  action: PlayerAction,
  territoryR: number,
  territoryB: number,
): TrainingActionRecord {
  const record: TrainingActionRecord = {
    id_partida,
    turno,
    jugador: player,
    tipo_accion: action.type,
    origen_x: '',
    origen_y: '',
    destino_x: '',
    destino_y: '',
    muro_x: '',
    muro_y: '',
    orientacion: action.dir ?? '',
    territorio_rojo: territoryR,
    territorio_azul: territoryB,
  }

  record.destino_x = action.pos.x
  record.destino_y = action.pos.y

  if (action.type === 'move' && action.from) {
    record.origen_x = action.from.x
    record.origen_y = action.from.y
  }

  if (action.type === 'wall') {
    record.muro_x = action.pos.x
    record.muro_y = action.pos.y
    if (action.from) {
      record.origen_x = action.from.x
      record.origen_y = action.from.y
    }
  }

  if (action.type === 'move' && action.followUp && action.followUp.type === 'wall') {
    record.muro_x = action.followUp.pos.x
    record.muro_y = action.followUp.pos.y
    record.orientacion = action.followUp.dir ?? record.orientacion
  }

  return record
}

export async function runHeuristicTraining(
  totalGames: number,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const summaryRows: TrainingResult[] = []
  const actionRows: TrainingActionRecord[] = []

  for (let currentGame = 1; currentGame <= totalGames; currentGame++) {
    useGame.getState().resetGame()
    const gameId = `training_${Date.now()}_${currentGame}`

    const offensive = new HeuristicAgent('offensive')
    const defensive = new HeuristicAgent('defensive')
    const agents = {
      R: offensive,
      B: defensive,
    }

    let actionCounter = 0
    const turnManager = new TurnManager({
      agents,
      getGameState: () => snapshotFromState(useGame.getState()),
      applyAction: async (action: PlayerAction) => {
        const prevState = snapshotFromState(useGame.getState())
        if (action.type === 'place') {
          useGame.getState().placeStone(action.pos)
        } else if (action.type === 'move') {
          if (action.from) useGame.getState().selectStone(action.from)
          useGame.getState().moveTo(action.pos)
        } else if (action.type === 'wall' && action.dir) {
          if (action.from) useGame.getState().selectStone(action.from)
          useGame.getState().buildWall(action.pos, action.dir)
        }

        const nextState = snapshotFromState(useGame.getState())
        const territory = getTerritoryCounts(nextState.board)
        actionCounter += 1
        actionRows.push(
          buildActionRecord(
            gameId,
            actionCounter,
            prevState.turn,
            action,
            territory.R,
            territory.B,
          ),
        )
      },
      isGameOver: (state) => state.phase === 'finished' || !!state.result || state.stepsTaken > 200,
      turnTimeLimit: 4_000,
    })

    await turnManager.startLoop()

    offensive.terminate()
    defensive.terminate()

    const finishedState = useGame.getState()
    const result = finishedState.result ?? checkGameEnd(finishedState.board, finishedState.players)
    const territoryCounts = result.score
      ? { R: result.score.R, B: result.score.B }
      : getTerritoryCounts(finishedState.board)
    const walls = countWalls(finishedState.board)

    summaryRows.push({
      id_partida: gameId,
      fecha: new Date().toISOString(),
      tipo_partida: 'entrenamiento_heuristico',
      jugador_rojo: 'heuristica_ofensiva',
      jugador_azul: 'heuristica_defensiva',
      ganador: result.tie ? 'empate' : result.winner === 'R' ? 'rojo' : 'azul',
      turnos: actionCounter,
      territorio_rojo: territoryCounts.R,
      territorio_azul: territoryCounts.B,
      muros_colocados: walls,
      comentario: 'Entrenamiento heurístico automático',
    })

    if (onProgress) {
      onProgress(currentGame, totalGames)
    }
  }

  downloadCsvFile(
    'entrenamiento_heuristico_partidas.csv',
    [
      'id_partida',
      'fecha',
      'tipo_partida',
      'jugador_rojo',
      'jugador_azul',
      'ganador',
      'turnos',
      'territorio_rojo',
      'territorio_azul',
      'muros_colocados',
      'comentario',
    ],
    summaryRows.map((row) => row as unknown as CsvRow),
  )

  downloadCsvFile(
    'entrenamiento_heuristico_acciones.csv',
    [
      'id_partida',
      'turno',
      'jugador',
      'tipo_accion',
      'origen_x',
      'origen_y',
      'destino_x',
      'destino_y',
      'muro_x',
      'muro_y',
      'orientacion',
      'territorio_rojo',
      'territorio_azul',
    ],
    actionRows.map((row) => row as unknown as CsvRow),
  )
}
