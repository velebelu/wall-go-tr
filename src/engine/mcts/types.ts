import type { PlayerAction } from '@/lib/types'

export interface MCTSConfig {
  simulations: number
  explorationConstant: number
  maxDepth: number
  rolloutPolicy: 'random' | 'mixed' | 'heuristic'
  heuristicProbability?: number
  expansionPolicy?: 'unordered' | 'heuristic' | 'heuristic-q5'
  qPriorWeight?: number
  progressiveWidening?: boolean
  wideningConstant?: number
  wideningExponent?: number
  tacticalVerification?: boolean
  tacticalCandidateCount?: number
  immediateTerritorialClosureThreat?: {
    enabled: boolean
    weight: number
    minimumTerritoryDrop: number
    minimumAccessibleDrop: number
  }
}

export interface MCTSChildResult {
  action: PlayerAction
  visits: number
  value: number
}

export interface MCTSResult {
  action: PlayerAction
  originalAction?: PlayerAction
  visits: number
  value: number
  rootVisits: number
  children: MCTSChildResult[]
  rootLegalActions: number
  rootExpandedChildren: number
  maxDepthReached: number
  averageSelectedDepth: number
  qPriorKnownActions?: number
  qPriorReliableActions?: number
  qPriorSelectedActionKnown?: boolean
  qPriorSelectedActionReliable?: boolean
  averageSelectedQPrior?: number
  tacticalCandidatesChecked?: number
  tacticalSelectionChanged?: boolean
  originalMCTSActionScore?: number
  verifiedActionScore?: number
  worstOpponentReplyScore?: number
  verificationTimeMs?: number
  immediateTerminalLossAvoided?: boolean
  closureThreatsDetected?: number
  closureThreatPenalty?: number
  closureThreatWorstReply?: PlayerAction
}

export interface MCTSQPriorSource {
  qTable: Readonly<Record<string, number>>
  confidence: ReadonlyMap<string, number>
  minConfidence: number
}

export const DEFAULT_WIDENING_CONSTANT = 2
export const DEFAULT_WIDENING_EXPONENT = 0.5

export const DEFAULT_MCTS_CONFIG: Readonly<MCTSConfig> = {
  simulations: 200,
  explorationConstant: Math.SQRT2,
  maxDepth: 60,
  rolloutPolicy: 'random',
  expansionPolicy: 'unordered',
  qPriorWeight: 0,
  progressiveWidening: false,
  tacticalVerification: false,
  tacticalCandidateCount: 3,
}
