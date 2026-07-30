import { calculatePlayerMobilityQ3 } from './learningPolicyQ3'
import { evaluatePosition } from '@/engine/evaluatePosition'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction, Pos } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'
import { floodRegions } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'

export interface ScoredTerritoryMove {
  action: PlayerAction
  territoryBefore: number
  territoryAfter: number
  opponentTerritoryBefore: number
  opponentTerritoryAfter: number
  originComponent: Pos[]
  lostCells: Pos[]
  internalWithoutTerritoryLoss: boolean
  losesScoredTerritory: boolean
}

export interface ScoredTerritoryProtectionResult {
  action: PlayerAction
  changed: boolean
  reason: 'unchanged' | 'scored-territory-loss-blocked' | 'internal-move-tiebreak'
  selectedAnalysis?: ScoredTerritoryMove
  replacementSource?: 'expanded' | 'tactical-legal' | 'blind-legal'
  legalConservativeAlternatives?: number
}

export type ScoredTerritoryReplacementMode =
  | 'expanded-only'
  | 'tactical-conservative'
  | 'blind-conservative'

export function shouldKeepTerritoryLosingAction(params: {
  terminalWin: boolean
  legalConservativeAlternatives: number
  deltaDifferentialOriginal: number
  bestConservativeDeltaDifferential: number
}): boolean {
  return (
    params.terminalWin ||
    params.legalConservativeAlternatives === 0 ||
    params.deltaDifferentialOriginal > params.bestConservativeDeltaDifferential
  )
}

interface RankedAction {
  action: PlayerAction
  visits: number
  value: number
}

export function analyzeScoredTerritoryMove(
  state: GameSnapshot,
  action: PlayerAction,
  player: Player = state.turn,
): ScoredTerritoryMove | undefined {
  if (action.type !== 'move' || !action.from) return undefined
  const beforeMap = getTerritoryMap(state.board)
  if (beforeMap[action.from.y]?.[action.from.x] !== player) return undefined
  const component = floodRegions(state.board).find((region) =>
    region.cells.some((position) => samePosition(position, action.from!)),
  )
  if (!component || !component.cells.every(({ x, y }) => beforeMap[y][x] === player))
    return undefined

  const opponent = other(player)
  const after = applyFullAction(state, action).state
  const afterMap = getTerritoryMap(after.board)
  const beforeCounts = territoryCounts(beforeMap)
  const afterCounts = after.result?.score ?? territoryCounts(afterMap)
  const lostCells = component.cells.filter(
    ({ x, y }) => beforeMap[y][x] === player && afterMap[y][x] !== player,
  )
  return {
    action,
    territoryBefore: beforeCounts[player],
    territoryAfter: afterCounts[player],
    opponentTerritoryBefore: beforeCounts[opponent],
    opponentTerritoryAfter: afterCounts[opponent],
    originComponent: component.cells.map((position) => ({ ...position })),
    lostCells: lostCells.map((position) => ({ ...position })),
    internalWithoutTerritoryLoss:
      component.cells.some((position) => samePosition(position, action.pos)) &&
      afterCounts[player] === beforeCounts[player],
    losesScoredTerritory: afterCounts[player] < beforeCounts[player] && lostCells.length > 0,
  }
}

export function chooseWithScoredTerritoryProtection(params: {
  state: GameSnapshot
  selected: PlayerAction
  candidates: readonly RankedAction[]
  replacementMode?: ScoredTerritoryReplacementMode
}): ScoredTerritoryProtectionResult {
  const legal = getLegalActions(params.state)
  const selectedAnalysis = analyzeScoredTerritoryMove(params.state, params.selected)
  const territoryBefore = territoryCounts(getTerritoryMap(params.state.board))[params.state.turn]
  const preserving = legal.filter((action) => {
    const after = applyFullAction(params.state, action).state
    const afterCounts = after.result?.score ?? territoryCounts(getTerritoryMap(after.board))
    return afterCounts[params.state.turn] >= territoryBefore
  })

  if (
    selectedAnalysis?.losesScoredTerritory &&
    preserving.length > 0 &&
    !avoidsOtherwiseForcedImmediateDefeat(params.state, params.selected, preserving) &&
    !hasSuperiorSameTurnTerritoryGain(params.state, params.selected, preserving)
  ) {
    const replacement = bestReplacement(
      params.state,
      params.selected,
      preserving,
      params.candidates,
      params.replacementMode ?? 'expanded-only',
    )
    if (!replacement) {
      return {
        action: params.selected,
        changed: false,
        reason: 'unchanged',
        selectedAnalysis,
        legalConservativeAlternatives: preserving.length,
      }
    }
    return {
      action: replacement.action,
      changed: true,
      reason: 'scored-territory-loss-blocked',
      selectedAnalysis,
      replacementSource: replacement.source,
      legalConservativeAlternatives: preserving.length,
    }
  }

  if (selectedAnalysis?.internalWithoutTerritoryLoss) {
    const selectedRank = params.candidates.find(({ action }) => sameAction(action, params.selected))
    const tiedUseful = params.candidates
      .filter(
        (candidate) =>
          selectedRank &&
          candidate.visits === selectedRank.visits &&
          candidate.value === selectedRank.value &&
          !analyzeScoredTerritoryMove(params.state, candidate.action)
            ?.internalWithoutTerritoryLoss &&
          hasImmediateDevelopmentEvidence(params.state, candidate.action),
      )
      .sort(rankCandidates)
    if (tiedUseful[0])
      return {
        action: tiedUseful[0].action,
        changed: true,
        reason: 'internal-move-tiebreak',
        selectedAnalysis,
      }
  }

  return {
    action: params.selected,
    changed: false,
    reason: 'unchanged',
    selectedAnalysis,
  }
}

function bestReplacement(
  state: GameSnapshot,
  selected: PlayerAction,
  preserving: readonly PlayerAction[],
  candidates: readonly RankedAction[],
  mode: ScoredTerritoryReplacementMode,
):
  | {
      action: PlayerAction
      source: NonNullable<ScoredTerritoryProtectionResult['replacementSource']>
    }
  | undefined {
  const originalDifference = immediateTerritoryDifference(state, selected)
  const competitivelySafe = preserving.filter(
    (action) => immediateTerritoryDifference(state, action) >= originalDifference,
  )
  if (!competitivelySafe.length) return undefined
  const candidate = [...candidates]
    .filter(({ action }) => competitivelySafe.some((legal) => sameAction(legal, action)))
    .sort(rankCandidates)[0]
  if (candidate) return { action: candidate.action, source: 'expanded' }
  if (mode === 'expanded-only') return undefined
  if (mode === 'tactical-conservative') {
    const shortlist = [...competitivelySafe]
      .sort(
        (left, right) =>
          immediateTerritoryDifference(state, right) - immediateTerritoryDifference(state, left) ||
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
      )
      .slice(0, 8)
    const scored = shortlist.map((action) => ({
      action,
      score: tacticalScore(state, action),
    }))
    return {
      action: scored.sort(
        (left, right) =>
          right.score - left.score ||
          JSON.stringify(left.action).localeCompare(JSON.stringify(right.action)),
      )[0]!.action,
      source: 'tactical-legal',
    }
  }
  return {
    action: [...competitivelySafe].sort((left, right) => {
      const rightScore = immediateTerritoryDifference(state, right)
      const leftScore = immediateTerritoryDifference(state, left)
      return rightScore - leftScore || JSON.stringify(left).localeCompare(JSON.stringify(right))
    })[0]!,
    source: 'blind-legal',
  }
}

function tacticalScore(state: GameSnapshot, action: PlayerAction): number {
  const player = state.turn
  const after = applyFullAction(state, action).state
  if (after.result?.finished)
    return after.result.winner === player ? Infinity : after.result.tie ? 0 : -Infinity
  const replies = getLegalActions(after)
  if (!replies.length) return evaluatePosition(after, player)
  let worst = Infinity
  for (const reply of replies)
    worst = Math.min(worst, evaluatePosition(applyFullAction(after, reply).state, player))
  return worst
}

function avoidsOtherwiseForcedImmediateDefeat(
  _state: GameSnapshot,
  _selected: PlayerAction,
  _preserving: readonly PlayerAction[],
): boolean {
  // A legal move cannot cross the walls that define a scored closed component.
  // Its follow-up wall is also placed from the destination inside that component,
  // so it cannot alter an external immediate threat. The requested "must leave"
  // exception is unreachable under the current movement and territory rules.
  return false
}

function hasSuperiorSameTurnTerritoryGain(
  state: GameSnapshot,
  selected: PlayerAction,
  preserving: readonly PlayerAction[],
): boolean {
  const after = applyFullAction(state, selected).state
  const beforeDifference = currentTerritoryDifference(state)
  return shouldKeepTerritoryLosingAction({
    terminalWin: after.result?.finished === true && after.result.winner === state.turn,
    legalConservativeAlternatives: preserving.length,
    deltaDifferentialOriginal: immediateTerritoryDifference(state, selected) - beforeDifference,
    bestConservativeDeltaDifferential:
      Math.max(...preserving.map((action) => immediateTerritoryDifference(state, action))) -
      beforeDifference,
  })
}

function hasImmediateDevelopmentEvidence(state: GameSnapshot, action: PlayerAction): boolean {
  const player = state.turn
  const opponent = other(player)
  const beforeMap = getTerritoryMap(state.board)
  const after = applyFullAction(state, action).state
  const before = territoryCounts(beforeMap)
  const afterCounts = after.result?.score ?? territoryCounts(getTerritoryMap(after.board))
  if (afterCounts[player] > before[player] || afterCounts[opponent] < before[opponent]) return true
  if (action.type === 'move' && beforeMap[action.pos.y]?.[action.pos.x] === null) return true
  const ownBefore = calculatePlayerMobilityQ3(state, player)
  const ownAfter = calculatePlayerMobilityQ3(after, player)
  if (ownAfter.totalDestinations > ownBefore.totalDestinations) return true
  const opponentBefore = calculatePlayerMobilityQ3(state, opponent)
  const opponentAfter = calculatePlayerMobilityQ3(after, opponent)
  return opponentAfter.totalDestinations < opponentBefore.totalDestinations
}

function immediateTerritoryDifference(state: GameSnapshot, action: PlayerAction): number {
  const player = state.turn
  const opponent = other(player)
  const after = applyFullAction(state, action).state
  const counts = after.result?.score ?? territoryCounts(getTerritoryMap(after.board))
  return counts[player] - counts[opponent]
}

function currentTerritoryDifference(state: GameSnapshot): number {
  const player = state.turn
  const opponent = other(player)
  const counts = territoryCounts(getTerritoryMap(state.board))
  return counts[player] - counts[opponent]
}

function territoryCounts(map: (Player | null)[][]): Record<Player, number> {
  const counts: Record<Player, number> = { R: 0, B: 0 }
  for (const owner of map.flat()) if (owner) counts[owner]++
  return counts
}

function rankCandidates(left: RankedAction, right: RankedAction): number {
  return (
    right.visits - left.visits ||
    right.value - left.value ||
    JSON.stringify(left.action).localeCompare(JSON.stringify(right.action))
  )
}

function samePosition(left: Pos, right: Pos): boolean {
  return left.x === right.x && left.y === right.y
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function other(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}
