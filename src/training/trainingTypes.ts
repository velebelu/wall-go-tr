export interface TrainingResult {
  id_partida: string
  fecha: string
  tipo_partida: string
  jugador_rojo: string
  jugador_azul: string
  ganador: string
  turnos: number
  territorio_rojo: number
  territorio_azul: number
  muros_colocados: number
  comentario: string
}

export interface TrainingActionRecord {
  id_partida: string
  turno: number
  jugador: 'R' | 'B'
  tipo_accion: string
  origen_x: number | ''
  origen_y: number | ''
  destino_x: number | ''
  destino_y: number | ''
  muro_x: number | ''
  muro_y: number | ''
  orientacion: string
  territorio_rojo: number
  territorio_azul: number
}

export type HeuristicPolicy = 'offensive' | 'defensive'
