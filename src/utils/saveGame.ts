// Helper to export a single game result as a CSV line and trigger a download/clipboard copy.
// This is intentionally simple: it helps collect experimental data for the Trabajo de Recerca (TR).
// It avoids duplicating the same save by checking `localStorage` for the `saved_game_<id>` key.
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

function csvEscape(v: string | number | undefined) {
  if (v === undefined || v === null) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('\n') || s.includes('"')) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function saveGameResult(payload: SaveGamePayload) {
  const key = `saved_game_${payload.id_partida}`
  if (typeof window !== 'undefined' && window.localStorage) {
    if (localStorage.getItem(key)) {
      // Already saved this exact game -- avoid duplicates
      return { saved: false, reason: 'already_saved' }
    }
  }

  // Build CSV row matching data/partidas.csv header
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

  const row = cols.map(csvEscape).join(',') + '\n'

  // Trigger a small download containing just the row so user can append it to data/partidas.csv
  try {
    const blob = new Blob([row], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `partida_${payload.id_partida}.csv`
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    // Also copy the single CSV line to clipboard for convenience
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        navigator.clipboard.writeText(row)
      } catch {
        // ignore clipboard errors
      }
    }
  } catch {
    // ignore download errors
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.setItem(key, new Date().toISOString())
  }
  return { saved: true }
}
