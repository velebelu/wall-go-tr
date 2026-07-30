// Exporta el resultado y las trazas de una partida para el Trabajo de Recerca.
export interface SaveGamePayload {
  id_partida: string
  fecha: string
  tipo_partida?: string
  jugador_rojo: string
  jugador_azul: string
  ganador: string
  turnos: number
  territorio_rojo: number
  territorio_azul: number
  muros_colocados: number
  observaciones?: string
}

export interface MCTSGameTurnTrace {
  decisionNumber: number
  phase: string
  activePlayer: string
  aiColor: string
  actorType: 'mcts' | 'human'
  actionType: string
  hasWall: boolean
  fromX?: number
  fromY?: number
  toX: number
  toY: number
  wallX?: number
  wallY?: number
  wallDirection?: string
  territoryRedBefore: number
  territoryBlueBefore: number
  territoryRedAfter: number
  territoryBlueAfter: number
  legalActionCount: number
  decisionMs: number
  baseSeed?: number
  decisionIndex?: number
  decisionSeed?: number
}

export type MCTSGameTraceSaveResult =
  | { status: 'empty'; fileName: string; rowCount: 0 }
  | { status: 'download_requested'; fileName: string; rowCount: number }
  | { status: 'failed'; fileName: string; rowCount: number; error: string }

function csvEscape(v: string | number | boolean | undefined) {
  if (v === undefined || v === null) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('\n') || s.includes('"')) return `"${s.replace(/"/g, '""')}"`
  return s
}

const GAME_RESULT_COLUMNS = [
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
  'observaciones',
] as const

export function buildGameResultCsv(payload: SaveGamePayload): string {
  const cols = [
    payload.id_partida,
    payload.fecha,
    payload.tipo_partida ?? '',
    payload.jugador_rojo,
    payload.jugador_azul,
    payload.ganador,
    payload.turnos,
    payload.territorio_rojo,
    payload.territorio_azul,
    payload.muros_colocados,
    payload.observaciones ?? '',
  ]
  return `${GAME_RESULT_COLUMNS.join(',')}\n${cols.map(csvEscape).join(',')}\n`
}

function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function buildMCTSGameTraceCsv(trace: readonly MCTSGameTurnTrace[]): string {
  const columns: Array<keyof MCTSGameTurnTrace> = [
    'decisionNumber',
    'phase',
    'activePlayer',
    'aiColor',
    'actorType',
    'actionType',
    'hasWall',
    'fromX',
    'fromY',
    'toX',
    'toY',
    'wallX',
    'wallY',
    'wallDirection',
    'territoryRedBefore',
    'territoryBlueBefore',
    'territoryRedAfter',
    'territoryBlueAfter',
    'legalActionCount',
    'decisionMs',
    'baseSeed',
    'decisionIndex',
    'decisionSeed',
  ]
  return [
    columns.join(','),
    ...trace.map((entry) => columns.map((column) => csvEscape(entry[column])).join(',')),
  ].join('\n')
}

export function validateCompleteMCTSGameTrace(
  trace: readonly MCTSGameTurnTrace[],
  expectedTurns: number,
): void {
  if (trace.length !== expectedTurns) {
    throw new Error(`Traza incompleta: ${trace.length} filas para ${expectedTurns} turnos.`)
  }

  const aiRows = trace.filter((row) => row.actorType === 'mcts')
  const baseSeeds = new Set(aiRows.map((row) => row.baseSeed))
  if (baseSeeds.size !== 1 || baseSeeds.has(undefined)) {
    throw new Error('La traza debe contener una única semilla base válida para la IA MCTS.')
  }

  trace.forEach((row, index) => {
    if (row.decisionNumber !== index) {
      throw new Error(
        `Decisión duplicada o no consecutiva: se esperaba ${index} y se encontró ${row.decisionNumber}.`,
      )
    }
    if (row.actorType === 'human') {
      if (
        row.baseSeed !== undefined ||
        row.decisionIndex !== undefined ||
        row.decisionSeed !== undefined
      ) {
        throw new Error('Una fila humana no puede contener diagnóstico de decisión MCTS.')
      }
      return
    }
    if (row.activePlayer !== row.aiColor) {
      throw new Error('Una fila MCTS debe pertenecer al color de la IA.')
    }
  })

  aiRows.forEach((row, index) => {
    if (row.decisionIndex !== index) {
      throw new Error(
        `decisionIndex no consecutivo: se esperaba ${index} y se encontró ${String(row.decisionIndex)}.`,
      )
    }
  })
}

export function saveMCTSGameTrace(
  gameId: string,
  trace: readonly MCTSGameTurnTrace[],
): MCTSGameTraceSaveResult {
  const fileName = `traza_partida_mcts_${gameId}.csv`
  if (trace.length === 0) {
    console.warn(`[MCTS trace] No se descarga ${fileName}: la traza está vacía.`)
    return { status: 'empty', fileName, rowCount: 0 }
  }

  try {
    downloadCsv(fileName, `${buildMCTSGameTraceCsv(trace)}\n`)
    console.info(
      `[MCTS trace] Descarga solicitada: ${fileName} (${trace.length} filas). ` +
        'Si el archivo no aparece, el navegador ha bloqueado la descarga automática adicional.',
    )
    return { status: 'download_requested', fileName, rowCount: trace.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[MCTS trace] No se pudo solicitar ${fileName}: ${message}`)
    return { status: 'failed', fileName, rowCount: trace.length, error: message }
  }
}

export function saveGameResult(payload: SaveGamePayload) {
  const key = `saved_game_${payload.id_partida}`
  if (typeof window !== 'undefined' && window.localStorage) {
    if (localStorage.getItem(key)) {
      // Esta partida ya se guardó.
      return { saved: false, reason: 'already_saved' }
    }
  }

  const csv = buildGameResultCsv(payload)

  // Descarga un CSV autónomo con cabecera.
  try {
    downloadCsv(`partida_${payload.id_partida}.csv`, csv)
    // Copia también el CSV completo al portapapeles.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        navigator.clipboard.writeText(csv)
      } catch {
        // El guardado no debe fallar si el portapapeles no está disponible.
      }
    }
  } catch {
    // El juego puede finalizar aunque el navegador bloquee la descarga.
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.setItem(key, new Date().toISOString())
  }
  return { saved: true }
}

export function saveFinishedGameArtifacts(
  payload: SaveGamePayload,
  gameMode: string | null,
  trace: readonly MCTSGameTurnTrace[],
  exporters: {
    saveResult: typeof saveGameResult
    saveTrace: typeof saveMCTSGameTrace
  } = {
    saveResult: saveGameResult,
    saveTrace: saveMCTSGameTrace,
  },
) {
  const gameResult = exporters.saveResult(payload)
  const traceResult =
    gameMode === 'mcts-final'
      ? (() => {
          try {
            validateCompleteMCTSGameTrace(trace, payload.turnos)
            return exporters.saveTrace(payload.id_partida, trace)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[MCTS trace] Validación fallida: ${message}`)
            return {
              status: 'failed',
              fileName: `traza_partida_mcts_${payload.id_partida}.csv`,
              rowCount: trace.length,
              error: message,
            } as const
          }
        })()
      : ({ status: 'not_applicable' } as const)
  return { gameResult, traceResult }
}
