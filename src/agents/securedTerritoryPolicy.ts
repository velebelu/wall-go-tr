import { calculatePlayerMobilityQ3, countTerritoryQ3 } from '@/agents/learningPolicyQ3'
import { applyActionToState, applyFullAction } from '@/engine/gameSimulator'
import { immediateTerritorialClosureThreat } from '@/engine/immediateTerritorialClosureThreat'
import type { GameSnapshot, Player, PlayerAction, Pos } from '@/lib/types'
import { floodRegions } from '@/utils/region'

export interface SecuredStoneEvidence {
  position: Pos
  player: Player
  regionSize: number
  ownStoneCount: number
  opponentStoneCount: 0
  reasons: readonly [
    'wall-disconnected-component',
    'component-contains-only-own-stones',
    'opponent-cannot-enter-without-crossing-wall',
  ]
}

export interface SecuredTerritoryAnalysis {
  inactiveStones: SecuredStoneEvidence[]
  inactiveKeys: ReadonlySet<string>
  componentByPosition: ReadonlyMap<string, string>
}

export interface SecuredActionFilter {
  actions: PlayerAction[]
  removedMovements: PlayerAction[]
  usedFallback: boolean
  analysis: SecuredTerritoryAnalysis
}

export function analyzeSecuredTerritory(
  state: GameSnapshot,
  player: Player = state.turn,
): SecuredTerritoryAnalysis {
  const opponent = player === 'R' ? 'B' : 'R'
  const inactiveStones: SecuredStoneEvidence[] = []
  const componentByPosition = new Map<string, string>()
  for (const region of floodRegions(state.board)) {
    if (region.borderingCounts[player] === 0 || region.borderingCounts[opponent] !== 0) continue
    const component = region.cells.map(key).sort().join('|')
    for (const position of region.cells) {
      componentByPosition.set(key(position), component)
      if (state.board[position.y][position.x].stone !== player) continue
      inactiveStones.push({
        position: { ...position },
        player,
        regionSize: region.cells.length,
        ownStoneCount: region.borderingCounts[player],
        opponentStoneCount: 0,
        reasons: [
          'wall-disconnected-component',
          'component-contains-only-own-stones',
          'opponent-cannot-enter-without-crossing-wall',
        ],
      })
    }
  }
  return {
    inactiveStones,
    inactiveKeys: new Set(inactiveStones.map(({ position }) => key(position))),
    componentByPosition,
  }
}

export function isClearlyUselessSecuredMovement(
  state: GameSnapshot,
  action: PlayerAction,
  analysis = analyzeSecuredTerritory(state),
  bestAlternativeThreat = Infinity,
): boolean {
  if (action.type !== 'move' || !action.from) return false
  const component = analysis.componentByPosition.get(key(action.from))
  if (!component || analysis.componentByPosition.get(key(action.pos)) !== component) return false

  const player = state.turn
  const opponent: Player = player === 'R' ? 'B' : 'R'
  const beforeTerritory = countTerritoryQ3(state)
  const beforeMobility = calculatePlayerMobilityQ3(state, player)
  const beforePartition = partitionSignature(state)
  const afterMove = applyActionToState(state, { ...action, followUp: undefined })
  const after = applyFullAction(state, action).state

  // A terminal action, territorial change, new connected partition, mobility gain,
  // opponent restriction, or comparatively better immediate defence is strategic evidence.
  if (after.phase === 'finished' || after.result?.finished) return false
  const afterTerritory = countTerritoryQ3(after)
  if (
    afterTerritory[player] !== beforeTerritory[player] ||
    afterTerritory[opponent] !== beforeTerritory[opponent]
  )
    return false
  if (partitionSignature(after) !== beforePartition) return false

  const afterMobility = calculatePlayerMobilityQ3(afterMove, player)
  if (
    afterMobility.totalDestinations > beforeMobility.totalDestinations ||
    afterMobility.trapPieces < beforeMobility.trapPieces ||
    afterMobility.lowPieces < beforeMobility.lowPieces
  )
    return false
  if (
    Number.isFinite(bestAlternativeThreat) &&
    threatSeverity(after, player) < bestAlternativeThreat
  )
    return false
  return true
}

export function filterSecuredTerritoryMovements(
  state: GameSnapshot,
  actions: readonly PlayerAction[],
): SecuredActionFilter {
  const analysis = analyzeSecuredTerritory(state)
  const structurallyRedundant = actions.filter((action) =>
    isClearlyUselessSecuredMovement(state, action, analysis),
  )
  const removedMovements = structurallyRedundant
  const filtered = actions.filter((action) => !removedMovements.includes(action))
  return {
    actions: filtered.length > 0 ? filtered : [...actions],
    removedMovements,
    usedFallback: filtered.length === 0 && actions.length > 0,
    analysis,
  }
}

export function chooseSecuredTerritoryCandidate(params: {
  state: GameSnapshot
  selected: PlayerAction
  candidates: readonly { action: PlayerAction; visits: number; value: number }[]
}) {
  const all = [params.selected, ...params.candidates.map(({ action }) => action)]
  const filtered = filterSecuredTerritoryMovements(params.state, all)
  const selectedAllowed = filtered.actions.some((action) => sameAction(action, params.selected))
  if (selectedAllowed)
    return {
      action: params.selected,
      changed: false,
      intervention: filtered.removedMovements.length > 0,
      removedMovements: filtered.removedMovements.length,
      usedFallback: filtered.usedFallback,
      analysis: filtered.analysis,
    }
  const allowed = params.candidates
    .filter(({ action }) => filtered.actions.some((candidate) => sameAction(candidate, action)))
    .sort((left, right) => right.visits - left.visits || right.value - left.value)
  const action = allowed[0]?.action ?? params.selected
  return {
    action,
    changed: !sameAction(action, params.selected),
    intervention: true,
    removedMovements: filtered.removedMovements.length,
    usedFallback: allowed.length === 0,
    analysis: filtered.analysis,
  }
}

function threatSeverity(state: GameSnapshot, player: Player): number {
  return immediateTerritorialClosureThreat(state, player, {
    enabled: true,
    weight: 1,
    minimumTerritoryDrop: 1,
    minimumAccessibleDrop: 1,
  }).severity
}

function partitionSignature(state: GameSnapshot): string {
  return floodRegions(state.board)
    .map((region) => region.cells.map(key).sort().join('|'))
    .sort()
    .join('||')
}

function key(position: Pos): string {
  return `${position.x},${position.y}`
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
