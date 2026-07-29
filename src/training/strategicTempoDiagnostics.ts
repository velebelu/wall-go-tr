import { calculatePlayerMobilityQ3, countTerritoryQ3 } from '@/agents/learningPolicyQ3'
import { analyzeSecuredTerritory } from '@/agents/securedTerritoryPolicy'
import { applyActionToState, applyFullAction } from '@/engine/gameSimulator'
import { immediateTerritorialClosureThreat } from '@/engine/immediateTerritorialClosureThreat'
import type { GameSnapshot, Player, PlayerAction, Pos } from '@/lib/types'
import type { HumanMCTSDecisionDiagnosticsV1 } from '@/utils/humanMCTSTrace'
import { floodRegions } from '@/utils/region'

export type StrategicTempoClassification =
  | 'productive'
  | 'strategic-repositioning'
  | 'defensive'
  | 'mobility-improving'
  | 'future-wall-preparation'
  | 'redundant'
  | 'ambiguous'

export type StrategicProgressTiebreakVariant =
  | 'exact-value'
  | 'value-0.01'
  | 'value-0.025'
  | 'value-0.05'
  | 'value-0.025-visits-0.15'
  | 'saturated-equal'

export interface StrategicProgressSignal {
  immediateConfirmed: {
    ownTerritoryGain: number
    opponentTerritoryReduction: number
    connectedComponentChange: number
    closureCreated: boolean
  }
  mobility: {
    ownDestinationsGain: number
    opponentDestinationsReduction: number
    ownBlockedPiecesReleased: number
    opponentBlockedPiecesAdded: number
  }
  potential: {
    disputedFrontierApproach: number
    legalWallPrepared: boolean
    immediateThreatReduction: number
  }
  orderingKey: [number, number, number, number]
}

export interface StrategicTempoDecision {
  stateBefore: GameSnapshot
  stateAfter: GameSnapshot
  legalActions: PlayerAction[]
  action: PlayerAction
  endedGame: boolean
  mcts?: HumanMCTSDecisionDiagnosticsV1
}

export interface StrategicTempoAnalysis {
  suspicious: boolean
  classification?: StrategicTempoClassification
  reasons: string[]
  territoryBefore: Record<Player, number>
  territoryAfter: Record<Player, number>
  ownMobilityDelta: number
  opponentMobilityDelta: number
  ownTrapPiecesDelta: number
  componentCountDelta: number
  relevantFrontierDistanceDelta: number
  threatDelta: number
  wallCreatesImmediateBenefit: boolean
  futureStrategicBenefit: boolean | null
  bestAlternativeImmediateAdvantage: number
  selectedVisits?: number
  selectedValue?: number
  visitGap?: number
  valueGap?: number
  statisticallyNearTied?: boolean
  maxDepthReached: null
  rolloutOutcomes: null
}

export function analyzeStrategicTempoDecision(
  decision: StrategicTempoDecision,
  futureStates: readonly GameSnapshot[] = [],
): StrategicTempoAnalysis {
  const before = decision.stateBefore
  const player = before.turn
  const opponent = other(player)
  const territoryBefore = countTerritoryQ3(before)
  const territoryAfter = countTerritoryQ3(decision.stateAfter)
  const base = {
    territoryBefore,
    territoryAfter,
    maxDepthReached: null,
    rolloutOutcomes: null,
  } as const
  if (decision.action.type !== 'move' || !decision.action.from)
    return {
      ...base,
      suspicious: false,
      reasons: ['not-a-movement'],
      ownMobilityDelta: 0,
      opponentMobilityDelta: 0,
      ownTrapPiecesDelta: 0,
      componentCountDelta: 0,
      relevantFrontierDistanceDelta: 0,
      threatDelta: 0,
      wallCreatesImmediateBenefit: false,
      futureStrategicBenefit: null,
      bestAlternativeImmediateAdvantage: 0,
    }

  const secured = analyzeSecuredTerritory(before, player)
  const fromComponent = secured.componentByPosition.get(key(decision.action.from))
  const sameComponent =
    fromComponent !== undefined &&
    secured.componentByPosition.get(key(decision.action.pos)) === fromComponent
  const territoryChanged =
    territoryAfter[player] !== territoryBefore[player] ||
    territoryAfter[opponent] !== territoryBefore[opponent]
  const suspicious =
    sameComponent &&
    !territoryChanged &&
    !decision.endedGame &&
    decision.legalActions.some((candidate) => !sameAction(candidate, decision.action))

  const afterMove = applyActionToState(before, { ...decision.action, followUp: undefined })
  const beforeOwnMobility = calculatePlayerMobilityQ3(before, player)
  const afterOwnMobility = calculatePlayerMobilityQ3(afterMove, player)
  const beforeOpponentMobility = calculatePlayerMobilityQ3(before, opponent)
  const afterOpponentMobility = calculatePlayerMobilityQ3(decision.stateAfter, opponent)
  const ownMobilityDelta = afterOwnMobility.totalDestinations - beforeOwnMobility.totalDestinations
  const opponentMobilityDelta =
    afterOpponentMobility.totalDestinations - beforeOpponentMobility.totalDestinations
  const ownTrapPiecesDelta = afterOwnMobility.trapPieces - beforeOwnMobility.trapPieces
  const componentCountDelta =
    floodRegions(decision.stateAfter.board).length - floodRegions(before.board).length
  const relevantFrontierDistanceDelta =
    distanceToRelevantFrontier(decision.stateAfter, decision.action.pos, player) -
    distanceToRelevantFrontier(before, decision.action.from, player)
  const threatBefore = threat(before, player)
  const threatAfter = threat(decision.stateAfter, player)
  const threatDelta = threatAfter - threatBefore
  const afterMoveTerritory = countTerritoryQ3(afterMove)
  const afterMoveOpponentMobility = calculatePlayerMobilityQ3(afterMove, opponent)
  const wallCreatesImmediateBenefit =
    territoryAfter[player] > afterMoveTerritory[player] ||
    territoryAfter[opponent] < afterMoveTerritory[opponent] ||
    afterOpponentMobility.totalDestinations < afterMoveOpponentMobility.totalDestinations ||
    floodRegions(decision.stateAfter.board).length !== floodRegions(afterMove.board).length
  const futureStrategicBenefit =
    futureStates.length === 0
      ? null
      : futureStates.some((state) => {
          const territory = countTerritoryQ3(state)
          const ownMobility = calculatePlayerMobilityQ3(state, player)
          const opponentMobility = calculatePlayerMobilityQ3(state, opponent)
          return (
            territory[player] > territoryAfter[player] ||
            territory[opponent] < territoryAfter[opponent] ||
            ownMobility.totalDestinations > afterOwnMobility.totalDestinations ||
            opponentMobility.totalDestinations < afterOpponentMobility.totalDestinations ||
            threat(state, player) < threatAfter
          )
        })
  const selectedImmediateScore = immediateProgressScore(before, decision.action)
  const evaluatedAlternatives =
    decision.mcts?.rootCandidates.map(({ action }) => action) ?? decision.legalActions
  const bestAlternativeImmediateScore = Math.max(
    ...evaluatedAlternatives
      .filter((candidate) => !sameAction(candidate, decision.action))
      .map((candidate) => immediateProgressScore(before, candidate)),
  )
  const bestAlternativeImmediateAdvantage = bestAlternativeImmediateScore - selectedImmediateScore
  const confidence = mctsConfidence(decision.mcts)

  const reasons: string[] = []
  let classification: StrategicTempoClassification = 'ambiguous'
  if (territoryChanged) {
    classification = 'productive'
    reasons.push('immediate-territory-change')
  } else if (wallCreatesImmediateBenefit) {
    classification = 'future-wall-preparation'
    reasons.push('move-enabled-wall-has-structural-value')
  } else if (componentCountDelta !== 0) {
    classification = 'productive'
    reasons.push('immediate-component-change')
  } else if (threatDelta < 0) {
    classification = 'defensive'
    reasons.push('reduced-immediate-closure-threat')
  } else if (ownMobilityDelta > 0 || ownTrapPiecesDelta < 0 || opponentMobilityDelta < 0) {
    classification = 'mobility-improving'
    reasons.push('improved-relative-mobility')
  } else if (relevantFrontierDistanceDelta < 0) {
    classification = 'strategic-repositioning'
    reasons.push('closer-to-relevant-frontier')
  } else if (
    suspicious &&
    ownMobilityDelta <= 0 &&
    opponentMobilityDelta >= 0 &&
    ownTrapPiecesDelta >= 0 &&
    componentCountDelta === 0 &&
    relevantFrontierDistanceDelta >= 0 &&
    threatDelta >= 0 &&
    futureStrategicBenefit === false &&
    bestAlternativeImmediateAdvantage > 0
  ) {
    classification = 'redundant'
    reasons.push('strict-redundancy-criteria-and-better-alternative')
  } else {
    reasons.push(
      futureStrategicBenefit === null
        ? 'insufficient-future-window'
        : futureStrategicBenefit
          ? 'later-progress-observed-but-not-causally-attributable'
          : 'no-strict-redundancy-evidence',
    )
  }
  if (confidence.statisticallyNearTied) reasons.push('mcts-candidates-near-tied')

  return {
    ...base,
    suspicious,
    classification,
    reasons,
    ownMobilityDelta,
    opponentMobilityDelta,
    ownTrapPiecesDelta,
    componentCountDelta,
    relevantFrontierDistanceDelta,
    threatDelta,
    wallCreatesImmediateBenefit,
    futureStrategicBenefit,
    bestAlternativeImmediateAdvantage,
    ...confidence,
  }
}

export function strategicProgressSignal(
  state: GameSnapshot,
  action: PlayerAction,
): StrategicProgressSignal {
  const player = state.turn
  const opponent = other(player)
  const beforeTerritory = countTerritoryQ3(state)
  const beforeOwnMobility = calculatePlayerMobilityQ3(state, player)
  const beforeOpponentMobility = calculatePlayerMobilityQ3(state, opponent)
  const beforeComponents = floodRegions(state.board).length
  const beforeThreat = threat(state, player)
  const after = applyFullAction(state, action).state
  const afterTerritory = countTerritoryQ3(after)
  const afterOwnMobility = calculatePlayerMobilityQ3(after, player)
  const afterOpponentMobility = calculatePlayerMobilityQ3(after, opponent)
  const componentChange = floodRegions(after.board).length - beforeComponents
  const from = action.from ?? action.pos
  const frontierApproach =
    distanceToRelevantFrontier(state, from, player) -
    distanceToRelevantFrontier(after, action.pos, player)
  const ownTerritoryGain = afterTerritory[player] - beforeTerritory[player]
  const opponentTerritoryReduction = beforeTerritory[opponent] - afterTerritory[opponent]
  const ownDestinationsGain =
    afterOwnMobility.totalDestinations - beforeOwnMobility.totalDestinations
  const opponentDestinationsReduction =
    beforeOpponentMobility.totalDestinations - afterOpponentMobility.totalDestinations
  const ownBlockedPiecesReleased = beforeOwnMobility.trapPieces - afterOwnMobility.trapPieces
  const opponentBlockedPiecesAdded =
    afterOpponentMobility.trapPieces - beforeOpponentMobility.trapPieces
  const immediateThreatReduction = beforeThreat - threat(after, player)
  const legalWallPrepared = action.type === 'move' && action.followUp?.type === 'wall'
  return {
    immediateConfirmed: {
      ownTerritoryGain,
      opponentTerritoryReduction,
      connectedComponentChange: componentChange,
      closureCreated: ownTerritoryGain > 0 || opponentTerritoryReduction > 0,
    },
    mobility: {
      ownDestinationsGain,
      opponentDestinationsReduction,
      ownBlockedPiecesReleased,
      opponentBlockedPiecesAdded,
    },
    potential: {
      disputedFrontierApproach: frontierApproach,
      legalWallPrepared,
      immediateThreatReduction,
    },
    orderingKey: [
      ownTerritoryGain + opponentTerritoryReduction,
      Number(componentChange !== 0) + Number(immediateThreatReduction > 0),
      ownDestinationsGain +
        opponentDestinationsReduction +
        ownBlockedPiecesReleased +
        opponentBlockedPiecesAdded,
      frontierApproach + Number(legalWallPrepared),
    ],
  }
}

export function chooseStrategicProgressTiebreak(params: {
  state: GameSnapshot
  original: PlayerAction
  candidates: readonly { action: PlayerAction; visits: number; value: number }[]
  variant: StrategicProgressTiebreakVariant
}) {
  const originalCandidate = params.candidates.find(({ action }) =>
    sameAction(action, params.original),
  )
  if (!originalCandidate)
    return { action: params.original, changed: false, eligible: 0, reason: 'original-not-at-root' }
  const eligible = params.candidates.filter((candidate) =>
    tieEligible(originalCandidate, candidate, params.variant),
  )
  const ranked = eligible
    .map((candidate) => ({
      ...candidate,
      progress: strategicProgressSignal(params.state, candidate.action),
    }))
    .sort((left, right) =>
      compareOrderingKey(right.progress.orderingKey, left.progress.orderingKey),
    )
  const action = ranked[0]?.action ?? params.original
  return {
    action,
    changed: !sameAction(action, params.original),
    eligible: eligible.length,
    reason: eligible.length > 1 ? params.variant : 'no-near-tied-alternative',
    originalProgress: strategicProgressSignal(params.state, params.original),
    selectedProgress: ranked[0]?.progress,
  }
}

function tieEligible(
  original: { visits: number; value: number },
  candidate: { visits: number; value: number },
  variant: StrategicProgressTiebreakVariant,
): boolean {
  const valueGap = Math.abs(candidate.value - original.value)
  const relativeVisitGap =
    Math.abs(candidate.visits - original.visits) / Math.max(1, original.visits)
  if (variant === 'exact-value') return valueGap === 0
  if (variant === 'value-0.01') return valueGap <= 0.01
  if (variant === 'value-0.025') return valueGap <= 0.025
  if (variant === 'value-0.05') return valueGap <= 0.05
  if (variant === 'value-0.025-visits-0.15') return valueGap <= 0.025 && relativeVisitGap <= 0.15
  return valueGap === 0 && Math.abs(original.value) === 1 && Math.abs(candidate.value) === 1
}

function compareOrderingKey(
  left: StrategicProgressSignal['orderingKey'],
  right: StrategicProgressSignal['orderingKey'],
): number {
  for (let index = 0; index < left.length; index++) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function mctsConfidence(mcts?: HumanMCTSDecisionDiagnosticsV1) {
  if (!mcts) return {}
  const ranked = [...mcts.rootCandidates].sort(
    (left, right) => right.visits - left.visits || right.value - left.value,
  )
  const first = ranked[0]
  const second = ranked[1]
  const visitGap = first && second ? first.visits - second.visits : undefined
  const valueGap = first && second ? Math.abs(first.value - second.value) : undefined
  return {
    selectedVisits: mcts.selectedVisits,
    selectedValue: mcts.selectedValue,
    visitGap,
    valueGap,
    statisticallyNearTied:
      visitGap !== undefined && valueGap !== undefined && visitGap <= 3 && valueGap <= 0.04,
  }
}

function immediateProgressScore(state: GameSnapshot, action: PlayerAction): number {
  const player = state.turn
  const opponent = other(player)
  const beforeTerritory = countTerritoryQ3(state)
  const beforeOwnMobility = calculatePlayerMobilityQ3(state, player)
  const beforeOpponentMobility = calculatePlayerMobilityQ3(state, opponent)
  const beforeComponents = floodRegions(state.board).length
  const after = applyFullAction(state, action).state
  const territory = countTerritoryQ3(after)
  const ownMobility = calculatePlayerMobilityQ3(after, player)
  const opponentMobility = calculatePlayerMobilityQ3(after, opponent)
  return (
    (territory[player] - beforeTerritory[player]) * 10 -
    (territory[opponent] - beforeTerritory[opponent]) * 10 +
    (ownMobility.totalDestinations - beforeOwnMobility.totalDestinations) -
    (opponentMobility.totalDestinations - beforeOpponentMobility.totalDestinations) +
    (floodRegions(after.board).length - beforeComponents)
  )
}

function distanceToRelevantFrontier(state: GameSnapshot, position: Pos, player: Player): number {
  const opponent = other(player)
  const relevant = floodRegions(state.board)
    .filter(
      (region) =>
        region.borderingCounts[opponent] > 0 ||
        (region.borderingCounts[player] > 0 && region.borderingCounts[opponent] > 0),
    )
    .flatMap((region) => region.cells)
  if (relevant.length === 0) return state.board.length * 2
  return Math.min(
    ...relevant.map((cell) => Math.abs(cell.x - position.x) + Math.abs(cell.y - position.y)),
  )
}

function threat(state: GameSnapshot, player: Player): number {
  return immediateTerritorialClosureThreat(state, player, {
    enabled: true,
    weight: 1,
    minimumTerritoryDrop: 1,
    minimumAccessibleDrop: 1,
  }).severity
}

function other(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function key(position: Pos): string {
  return `${position.x},${position.y}`
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
