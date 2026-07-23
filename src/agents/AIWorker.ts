// src/agents/AIWorker.ts
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import {
  getBestHeuristicAction,
  getBestPlacement,
  getLegalActions,
  getRandomAction,
} from '@/utils/ai'
import { MinimaxAI } from '@/ai/minimax-ai'
import { chooseLearningAction, type QTableEntries } from './learningPolicy'
import type { MCTSConfig } from '@/engine/mcts/types'
import { choosePlayableMCTSAction } from './mctsWorkerDecision'

function calculateMinimaxPlayingAction(gameState: GameSnapshot, depth = 2): PlayerAction {
  const ai = new MinimaxAI(depth)
  ai.startTime = performance.now()
  ai.timeLimit = 3000
  return ai.getBestMove(gameState)
}

self.onmessage = (
  event: MessageEvent<{ aiType: string; gameState: GameSnapshot; config: Record<string, unknown> }>,
) => {
  const { aiType, gameState } = event.data
  let action: PlayerAction | null = null

  try {
    if (Array.isArray(gameState.legal)) {
      gameState.legal = new Set(gameState.legal)
    }
    const legalActions = getLegalActions(gameState)

    if (gameState.phase === 'finished') {
      self.postMessage({
        action: null,
        info: 'Game finished, no action taken.',
      })
      return
    }

    if (legalActions.length === 0) {
      self.postMessage({
        error: 'No legal actions available but game is not finished.',
      })
      return
    }

    const heuristicMode =
      (event.data.config?.policy as 'default' | 'offensive' | 'defensive') ?? 'default'
    if (aiType === 'mcts-final') {
      const config = event.data.config?.mcts as MCTSConfig
      const seed = (event.data.config?.seed as number) >>> 0
      action = choosePlayableMCTSAction({ gameState, config, seed })
      self.postMessage({ action })
      return
    }
    if (gameState.phase === 'placing') {
      switch (aiType) {
        case 'heuristic':
        case 'minimax':
          action = getBestPlacement(gameState)
          break
        case 'learning': {
          const epsilon = (event.data.config?.epsilon as number) ?? 0.3
          const qTable = (event.data.config?.qTable as QTableEntries) ?? []
          action = chooseLearningAction(gameState, legalActions, epsilon, qTable)
          break
        }
        case 'random':
        default:
          action = getRandomAction(legalActions)!
          break
      }
    } else if (gameState.phase === 'playing') {
      switch (aiType) {
        case 'heuristic':
          action = getBestHeuristicAction(gameState, heuristicMode)
          break
        case 'minimax':
          action = calculateMinimaxPlayingAction(
            gameState,
            (event.data.config?.depth as number) ?? 2,
          )
          break
        case 'learning': {
          const epsilon = (event.data.config?.epsilon as number) ?? 0.3
          const qTable = (event.data.config?.qTable as QTableEntries) ?? []
          action = chooseLearningAction(gameState, legalActions, epsilon, qTable)
          break
        }
        case 'random':
        default:
          action = getRandomAction(legalActions)!
          break
      }
    } else {
      self.postMessage({ error: `Unexpected game phase: ${gameState.phase}` })
      return
    }

    if (action) {
      self.postMessage({ action })
    } else {
      self.postMessage({
        action: getRandomAction(legalActions)!,
        info: 'Fell back to random action.',
      })
    }
  } catch (e) {
    self.postMessage({
      error: (e as Error).message,
      stack: (e as Error).stack,
    })
  }
}
