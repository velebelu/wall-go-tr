import type { AiLevel, GameMode, Player } from '@/lib/types'

const AI_GAME_TYPES: Record<AiLevel, string> = {
  practice: 'humano_vs_ia_aleatoria',
  heuristic: 'humano_vs_ia_heuristica',
  easy: 'humano_vs_ia_facil',
  middle: 'humano_vs_ia_media',
  hard: 'humano_vs_ia_dificil',
}

const AI_PLAYERS: Record<AiLevel, string> = {
  practice: 'ia_aleatoria', heuristic: 'ia_heuristica', easy: 'ia_facil', middle: 'ia_media', hard: 'ia_dificil',
}

export function getGameParticipantMetadata(params: {
  gameMode: GameMode
  aiSide: Player
  aiLevel: AiLevel
  humanSide: Player | null
}) {
  const { gameMode, aiSide, aiLevel, humanSide } = params
  let tipo_partida = 'pvp'
  if (gameMode === 'ai') tipo_partida = AI_GAME_TYPES[aiLevel]
  if (gameMode === 'q5-learning') tipo_partida = 'humano_vs_ia_aprendiz_q5_1000'
  if (gameMode === 'mcts-final') tipo_partida = 'ia_mcts_final'
  if (gameMode === 'ai-vs-ai') tipo_partida = 'ia_vs_ia_automatico'
  if (gameMode === 'random-vs-heuristic') tipo_partida = 'ia_aleatoria_vs_ia_heuristica'
  if (gameMode === 'learning-vs-random') tipo_partida = 'ia_aprendiz_vs_ia_aleatoria'
  if (gameMode === 'learning-vs-heuristic') tipo_partida = 'ia_aprendiz_vs_ia_heuristica'

  const playerLabel = (side: Player) => {
    if (gameMode === 'ai-vs-ai' || gameMode === 'random-vs-heuristic') return side === 'R' ? 'ia_aleatoria' : 'ia_heuristica'
    if (gameMode === 'learning-vs-random') return side === 'R' ? 'ia_aprendiz' : 'ia_aleatoria'
    if (gameMode === 'learning-vs-heuristic') return side === 'R' ? 'ia_aprendiz' : 'ia_heuristica'
    if (gameMode === 'q5-learning') return side === aiSide ? 'ia_aprendiz_q5_1000' : 'humano'
    if (gameMode === 'mcts-final') return side === aiSide ? 'ia_mcts_final' : 'humano'
    if (gameMode !== 'ai' || !humanSide || humanSide === side) return 'humano'
    return AI_PLAYERS[aiLevel]
  }
  return { tipo_partida, jugador_rojo: playerLabel('R'), jugador_azul: playerLabel('B') }
}
