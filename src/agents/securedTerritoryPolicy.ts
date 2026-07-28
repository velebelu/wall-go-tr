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
    'internal-move-preserves-component',
  ]
}

export interface SecuredTerritoryAnalysis {
  inactiveStones: SecuredStoneEvidence[]
  inactiveKeys: ReadonlySet<string>
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
  for (const region of floodRegions(state.board)) {
    if (region.borderingCounts[player] === 0 || region.borderingCounts[opponent] !== 0) continue
    for (const position of region.cells) {
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
          'internal-move-preserves-component',
        ],
      })
    }
  }
  return {
    inactiveStones,
    inactiveKeys: new Set(inactiveStones.map(({ position }) => key(position))),
  }
}

export function filterSecuredTerritoryMovements(
  state: GameSnapshot,
  actions: readonly PlayerAction[],
): SecuredActionFilter {
  const analysis = analyzeSecuredTerritory(state)
  const removedMovements = actions.filter(
    (action) =>
      action.type === 'move' && action.from && analysis.inactiveKeys.has(key(action.from)),
  )
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
}): {
  action: PlayerAction
  changed: boolean
  intervention: boolean
  removedMovements: number
  usedFallback: boolean
  analysis: SecuredTerritoryAnalysis
} {
  const all = [params.selected, ...params.candidates.map(({ action }) => action)]
  const filtered = filterSecuredTerritoryMovements(params.state, all)
  const selectedAllowed = filtered.actions.some((action) => sameAction(action, params.selected))
  if (selectedAllowed) {
    return {
      action: params.selected,
      changed: false,
      intervention: filtered.removedMovements.length > 0,
      removedMovements: filtered.removedMovements.length,
      usedFallback: filtered.usedFallback,
      analysis: filtered.analysis,
    }
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

function key(position: Pos): string {
  return `${position.x},${position.y}`
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
