import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { getTrainingTraceStateKey } from '@/utils/trainingTrace'

export type QTableSnapshot = Record<string, number>
export type QTableEntries = Array<[string, number]>

export interface LearningActionDiagnostics {
  decisions: number
  qTableHits: number
  totalMaxTiedActions: number
  tiedBestActionDecisions: number
  consultedKeys: Set<string>
}

export interface LearningActionChoiceInfo {
  action: PlayerAction
  bestValue: number
  bestActions: PlayerAction[]
  selectedKey: string
  selectedKeyExists: boolean
  consultedKeys: string[]
}

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

function getLegacyTrainingTraceQTableKey(state: GameSnapshot, action: PlayerAction): string {
  return `${getTrainingTraceStateKey(state)}|||${getLearningActionKey(action)}`
}

function getQTableEntry(qTable: QTableSnapshot | QTableEntries, key: string): number | undefined {
  if (Array.isArray(qTable)) {
    return qTable.find(([entryKey]) => entryKey === key)?.[1]
  }
  return qTable[key]
}

export function getLearningQTableKeys(state: GameSnapshot, action: PlayerAction): string[] {
  const compactKey = getLearningQTableKey(state, action)
  const legacyKey = getLegacyTrainingTraceQTableKey(state, action)
  return compactKey === legacyKey ? [compactKey] : [compactKey, legacyKey]
}

export function getQValueForStateAction(
  qTable: QTableSnapshot | QTableEntries,
  state: GameSnapshot,
  action: PlayerAction,
): { value: number; key: string; exists: boolean; consultedKeys: string[] } {
  const keys = getLearningQTableKeys(state, action)
  for (const key of keys) {
    const value = getQTableEntry(qTable, key)
    if (value !== undefined) {
      return { value, key, exists: true, consultedKeys: keys }
    }
  }
  return { value: 0, key: keys[0]!, exists: false, consultedKeys: keys }
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

export function inspectLearningActionChoice(
  gameState: GameSnapshot,
  legalActions: PlayerAction[],
  epsilon: number,
  qTable: QTableSnapshot | QTableEntries,
  rng: () => number = Math.random,
): LearningActionChoiceInfo {
  if (legalActions.length === 0) {
    throw new Error('No legal actions available')
  }

  const consultedKeys: string[] = []

  if (rng() < epsilon) {
    const action = legalActions[Math.floor(rng() * legalActions.length)]!
    const qValue = getQValueForStateAction(qTable, gameState, action)
    consultedKeys.push(...qValue.consultedKeys)
    return {
      action,
      bestValue: qValue.value,
      bestActions: [action],
      selectedKey: qValue.key,
      selectedKeyExists: qValue.exists,
      consultedKeys,
    }
  }

  let bestValue = -Infinity
  const bestActions: PlayerAction[] = []

  for (const action of legalActions) {
    const qValue = getQValueForStateAction(qTable, gameState, action)
    const value = qValue.value
    consultedKeys.push(...qValue.consultedKeys)
    if (value > bestValue) {
      bestValue = value
      bestActions.length = 0
      bestActions.push(action)
    } else if (value === bestValue) {
      bestActions.push(action)
    }
  }

  const action = bestActions[Math.floor(rng() * bestActions.length)]!
  const selectedQValue = getQValueForStateAction(qTable, gameState, action)
  return {
    action,
    bestValue,
    bestActions,
    selectedKey: selectedQValue.key,
    selectedKeyExists: selectedQValue.exists,
    consultedKeys,
  }
}

export function chooseLearningAction(
  gameState: GameSnapshot,
  legalActions: PlayerAction[],
  epsilon: number,
  qTable: QTableSnapshot | QTableEntries,
  diagnostics?: LearningActionDiagnostics,
  rng: () => number = Math.random,
): PlayerAction {
  const choice = inspectLearningActionChoice(gameState, legalActions, epsilon, qTable, rng)

  if (diagnostics) {
    diagnostics.decisions++
    if (choice.selectedKeyExists) diagnostics.qTableHits++
    diagnostics.totalMaxTiedActions += choice.bestActions.length
    if (choice.bestActions.length > 1) diagnostics.tiedBestActionDecisions++
    choice.consultedKeys.forEach((key) => diagnostics.consultedKeys.add(key))
  }

  return choice.action
}
