import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import { choosePlayableMCTSAction } from '@/agents/mctsWorkerDecision'
import type { MCTSConfig } from '@/engine/mcts/types'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'

export const ADAPTIVE_BUDGET_VERSION = 'adaptive-budget-v1'

export function selectAdaptiveMCTSSimulations(legalActionCount: number): number {
  if (!Number.isInteger(legalActionCount) || legalActionCount < 0) {
    throw new Error('legalActionCount must be a non-negative integer')
  }
  if (legalActionCount <= 30) return 50
  if (legalActionCount <= 70) return 100
  if (legalActionCount <= 110) return 150
  return 200
}

export function getAdaptiveMCTSConfig(legalActionCount: number): Readonly<MCTSConfig> {
  return Object.freeze({
    ...FINAL_MCTS_CONFIG,
    simulations: selectAdaptiveMCTSSimulations(legalActionCount),
  })
}

export interface AdaptiveMCTSDecision {
  action: PlayerAction
  legalActionCount: number
  simulations: number
  elapsedMs: number
}

export function chooseAdaptiveBudgetMCTSAction(params: {
  gameState: GameSnapshot
  seed: number
  now?: () => number
  chooseMCTS?: typeof choosePlayableMCTSAction
}): AdaptiveMCTSDecision {
  const legalActionCount = getLegalActions(params.gameState).length
  const config = getAdaptiveMCTSConfig(legalActionCount)
  const now = params.now ?? (() => performance.now())
  const startedAt = now()
  const action = (params.chooseMCTS ?? choosePlayableMCTSAction)({
    gameState: params.gameState,
    config,
    seed: params.seed,
  })
  return {
    action,
    legalActionCount,
    simulations: config.simulations,
    elapsedMs: now() - startedAt,
  }
}
