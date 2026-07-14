import { describe, expect, it } from 'vitest'
import { getGameParticipantMetadata } from './gameModeMetadata'

describe('metadata de partida MCTS final', () => {
  it.each([
    ['R', 'ia_mcts_final', 'humano'],
    ['B', 'humano', 'ia_mcts_final'],
  ] as const)('registra correctamente MCTS como %s', (aiSide, rojo, azul) => {
    expect(getGameParticipantMetadata({
      gameMode: 'mcts-final', aiSide, aiLevel: 'heuristic',
      humanSide: aiSide === 'R' ? 'B' : 'R',
    })).toEqual({ tipo_partida: 'ia_mcts_final', jugador_rojo: rojo, jugador_azul: azul })
  })
})
