import type { MCTSConfig } from '@/engine/mcts/types'

// Perfil jugable previo, conservado como modo rápido y base arquitectónica.
export const FINAL_MCTS_CONFIG = Object.freeze({
  simulations: 50,
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
  rolloutPolicy: 'mixed',
  heuristicProbability: 0.8,
  expansionPolicy: 'heuristic',
  progressiveWidening: true,
  wideningConstant: 2,
  wideningExponent: 0.5,
  qPriorWeight: 0,
  tacticalVerification: true,
  tacticalCandidateCount: 2,
} satisfies MCTSConfig)
