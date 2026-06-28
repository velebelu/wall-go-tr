// src/agents/AIWorker.ts
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import {
  getBestHeuristicAction,
  getBestPlacement,
  getLegalActions,
  getRandomAction,
} from '@/utils/ai'
import { MinimaxAI } from '@/ai/minimax-ai'

function calculateMinimaxPlayingAction(gameState: GameSnapshot, depth = 2): PlayerAction {
  const ai = new MinimaxAI(depth)
  ai.startTime = performance.now()
  ai.timeLimit = 3000
  return ai.getBestMove(gameState)
}

// --- Funciones para LearningAgent ---
function getStateKey(gameState: GameSnapshot): string {
  const { phase, turn, stonesPlaced } = gameState
  const stoneCountR = stonesPlaced['R'] ?? 0
  const stonCountB = stonesPlaced['B'] ?? 0
  return `${phase}|${turn}|${stoneCountR}|${stonCountB}|${gameState.stepsTaken}`
}

function getActionKey(action: PlayerAction): string {
  if (action.type === 'place') {
    return `place|${action.pos.x}|${action.pos.y}`
  } else if (action.type === 'move') {
    return `move|${action.from?.x}|${action.from?.y}|${action.pos.x}|${action.pos.y}`
  } else if (action.type === 'wall') {
    return `wall|${action.pos.x}|${action.pos.y}|${action.dir}`
  }
  return 'unknown'
}

function getQValue(qTable: Array<[string, number]>, stateKey: string, actionKey: string): number {
  const key = `${stateKey}|||${actionKey}`
  const entry = qTable.find(([k]) => k === key)
  return entry ? entry[1] : 0
}

function chooseLearningAction(
  gameState: GameSnapshot,
  legalActions: PlayerAction[],
  epsilon: number,
  qTable: Array<[string, number]>,
): PlayerAction {
  if (legalActions.length === 0) {
    throw new Error('No legal actions available')
  }

  const stateKey = getStateKey(gameState)
  const explore = Math.random() < epsilon

  if (explore) {
    // Exploración: acción aleatoria
    return legalActions[Math.floor(Math.random() * legalActions.length)]!
  }

  // Explotación: acción con mayor Q
  let bestAction = legalActions[0]!
  let bestValue = getQValue(qTable, stateKey, getActionKey(bestAction))

  for (const action of legalActions) {
    const actionKey = getActionKey(action)
    const value = getQValue(qTable, stateKey, actionKey)
    if (value > bestValue) {
      bestValue = value
      bestAction = action
    }
  }

  return bestAction
}

// --- Worker message handler ---
self.onmessage = (
  event: MessageEvent<{ aiType: string; gameState: GameSnapshot; config: Record<string, unknown> }>,
) => {
  const { aiType, gameState } = event.data
  let action: PlayerAction | null = null

  try {
    const legalActions = getLegalActions(gameState)

    // Handle case where game is finished first
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

    if (gameState.phase === 'placing') {
      switch (aiType) {
        case 'heuristic':
        case 'minimax':
          action = getBestPlacement(gameState)
          break
        case 'learning': {
          const epsilon = (event.data.config?.epsilon as number) ?? 0.3
          const qTable = (event.data.config?.qTable as Array<[string, number]>) ?? []
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
          action = getBestHeuristicAction(gameState)
          break
        case 'minimax':
          action = calculateMinimaxPlayingAction(
            gameState,
            (event.data.config?.depth as number) ?? 2,
          )
          break
        case 'learning': {
          const epsilon = (event.data.config?.epsilon as number) ?? 0.3
          const qTable = (event.data.config?.qTable as Array<[string, number]>) ?? []
          action = chooseLearningAction(gameState, legalActions, epsilon, qTable)
          break
        }
        case 'random':
        default:
          action = getRandomAction(legalActions)!
          break
      }
    } else {
      // Fallback for unexpected phase, though 'finished' is handled above
      self.postMessage({ error: `Unexpected game phase: ${gameState.phase}` })
      return
    }

    if (action) {
      self.postMessage({ action })
    } else {
      // If action is null here, it implies an issue in decision logic for non-finished phases
      // or a specific AI logic failed to return an action.
      // As a robust fallback, if legal actions were available, pick a random one.
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
