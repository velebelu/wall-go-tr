import type { GameSnapshot, PlayerAction } from '@/lib/types'

export type QTableSnapshot = Record<string, number>
export type QTableEntries = Array<[string, number]>

export function getLearningStateKey(gameState: GameSnapshot): string {
  const { phase, turn, stonesPlaced } = gameState
  const stoneCountR = stonesPlaced.R ?? 0
  const stoneCountB = stonesPlaced.B ?? 0
  return `${phase}|${turn}|${stoneCountR}|${stoneCountB}|${gameState.stepsTaken}`
}

export function getLearningActionKey(action: PlayerAction): string {
  if (action.type === 'place') {
    return `place|${action.pos.x}|${action.pos.y}`
  }

  if (action.type === 'move') {
    return `move|${action.from?.x}|${action.from?.y}|${action.pos.x}|${action.pos.y}`
  }

  if (action.type === 'wall') {
    return `wall|${action.pos.x}|${action.pos.y}|${action.dir}`
  }

  return 'unknown'
}

export function getLearningQTableKey(state: GameSnapshot, action: PlayerAction): string {
  return `${getLearningStateKey(state)}|||${getLearningActionKey(action)}`
}

export function getQValue(
  qTable: QTableSnapshot | QTableEntries,
  stateKey: string,
  actionKey: string,
): number {
  const key = `${stateKey}|||${actionKey}`
  if (Array.isArray(qTable)) {
    return qTable.find(([entryKey]) => entryKey === key)?.[1] ?? 0
  }
  return qTable[key] ?? 0
}

export function chooseLearningAction(
  gameState: GameSnapshot,
  legalActions: PlayerAction[],
  epsilon: number,
  qTable: QTableSnapshot | QTableEntries,
): PlayerAction {
  if (legalActions.length === 0) {
    throw new Error('No legal actions available')
  }

  if (Math.random() < epsilon) {
    return legalActions[Math.floor(Math.random() * legalActions.length)]!
  }

  const stateKey = getLearningStateKey(gameState)
  let bestAction = legalActions[0]!
  let bestValue = getQValue(qTable, stateKey, getLearningActionKey(bestAction))

  for (const action of legalActions) {
    const value = getQValue(qTable, stateKey, getLearningActionKey(action))
    if (value > bestValue) {
      bestValue = value
      bestAction = action
    }
  }

  return bestAction
}
