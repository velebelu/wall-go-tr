import { searchBestAction } from '@/engine/mcts/MCTS'
import type { MCTSConfig, MCTSResult } from '@/engine/mcts/types'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'

export type MCTSWorkerGameState = Omit<GameSnapshot, 'legal'> & {
  legal: GameSnapshot['legal'] | string[]
}

// This is the playable MCTS RNG protocol. evaluateMCTS.ts intentionally uses a
// different historical evaluation protocol, so this helper does not imply parity with it.
export function createPlayableMCTSRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function choosePlayableMCTSAction(params: {
  gameState: MCTSWorkerGameState
  config: MCTSConfig
  seed: number
}): PlayerAction {
  return choosePlayableMCTSDecision(params).action
}

export function choosePlayableMCTSDecision(params: {
  gameState: MCTSWorkerGameState
  config: MCTSConfig
  seed: number
}): MCTSResult {
  const gameState: GameSnapshot = {
    ...params.gameState,
    legal: new Set(params.gameState.legal),
  }
  const legalActions = getLegalActions(gameState)

  if (gameState.phase === 'finished') {
    throw new Error('Game finished, no action taken.')
  }
  if (legalActions.length === 0) {
    throw new Error('No legal actions available but game is not finished.')
  }

  const result = searchBestAction(
    gameState,
    gameState.turn,
    params.config,
    createPlayableMCTSRng(params.seed),
    undefined,
  )
  const action = result.action
  if (!legalActions.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action))) {
    throw new Error('MCTS devolvió una acción que no pertenece al conjunto legal.')
  }
  return result
}
