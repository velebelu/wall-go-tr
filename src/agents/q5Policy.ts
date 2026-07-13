import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { getLearningQTableKeyQ3 } from './learningPolicyQ3'
import { getBestHeuristicAction, getBestPlacement, getLegalActions } from '@/utils/ai'

export const Q5_MIN_CONFIDENCE = 10 as const
export const Q5_Q_MARGIN = 0.5 as const
export const Q5_EPSILON = 0 as const

export type FrozenQ5Table = Readonly<Record<string, number>>
export type FrozenQ5Confidence = ReadonlyMap<string, number>

export interface FrozenQ5Choice {
  action: PlayerAction
  mechanism: 'heuristicMatch' | 'qOverrideAccepted' | 'qOverrideRejected'
  qConfidence: number
  margin: number
}

function withSeededMathRandom<T>(rng: () => number, fn: () => T): T {
  const previous = Math.random
  Math.random = rng
  try {
    return fn()
  } finally {
    Math.random = previous
  }
}

function chooseHeuristicAction(state: GameSnapshot, rng: () => number): PlayerAction {
  return withSeededMathRandom(rng, () => {
    const action =
      state.phase === 'placing' ? getBestPlacement(state) : getBestHeuristicAction(state)
    if (!action) throw new Error('La política heurística Q5 no encontró una acción legal.')
    return action
  })
}

function actionSignature(action: PlayerAction): string {
  return JSON.stringify(action)
}

/** Política de inferencia idéntica a la variante E del evaluador Q5 congelado. */
export function chooseFrozenQ5Action(params: {
  state: GameSnapshot
  legalActions?: PlayerAction[]
  qTable: FrozenQ5Table
  confidence: FrozenQ5Confidence
  rng?: () => number
}): FrozenQ5Choice {
  const rng = params.rng ?? Math.random
  const legalActions = params.legalActions ?? getLegalActions(params.state)
  if (legalActions.length === 0) throw new Error('Q5 no dispone de acciones legales.')

  const heuristicAction = chooseHeuristicAction(params.state, rng)
  const heuristicKey = getLearningQTableKeyQ3(params.state, heuristicAction)
  let bestQ = -Infinity
  const bestActions: PlayerAction[] = []

  for (const action of legalActions) {
    const value = params.qTable[getLearningQTableKeyQ3(params.state, action)] ?? 0
    if (value > bestQ) {
      bestQ = value
      bestActions.length = 0
      bestActions.push(action)
    } else if (value === bestQ) {
      bestActions.push(action)
    }
  }

  const qAction = bestActions[Math.floor(rng() * bestActions.length)]!
  const qKey = getLearningQTableKeyQ3(params.state, qAction)
  const heuristicQ = params.qTable[heuristicKey] ?? 0
  const qConfidence = params.confidence.get(qKey) ?? 0
  const margin = bestQ - heuristicQ

  if (actionSignature(heuristicAction) === actionSignature(qAction)) {
    return {
      action: heuristicAction,
      mechanism: 'heuristicMatch',
      qConfidence,
      margin,
    }
  }

  const accepted = qConfidence >= Q5_MIN_CONFIDENCE && margin >= Q5_Q_MARGIN
  return {
    action: accepted ? qAction : heuristicAction,
    mechanism: accepted ? 'qOverrideAccepted' : 'qOverrideRejected',
    qConfidence,
    margin,
  }
}
