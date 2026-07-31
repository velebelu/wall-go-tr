import {
  calculatePlayerMobilityQ3,
  getLegalDestinationsForPlayerStoneQ3,
} from '@/agents/learningPolicyQ3'
import { evaluatePosition } from '@/engine/evaluatePosition'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction, Pos, WallDir } from '@/lib/types'
import { floodRegions, getPosKey } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'

export interface InternalWallComponentSummary {
  size: number
  redStones: number
  blueStones: number
  owner: Player | null
  containsWallEndpoint: boolean
}

export interface InternalWallPositionMetrics {
  territory: Record<Player, number>
  accessible: Record<Player, number>
  mobility: Record<Player, ReturnType<typeof calculatePlayerMobilityQ3>>
  components: InternalWallComponentSummary[]
  evaluation: number
}

export interface InternalWallDiagnostic {
  action: PlayerAction
  wall: { pos: Pos; dir: WallDir; endpoints: [Pos, Pos] }
  strictlyInternal: boolean
  immediateTerritoryLoss: number
  immediateTerritoryGain: number
  territoryPreserved: boolean
  componentSplit: boolean
  emptySubregionCreated: boolean
  affectsEndOfGame: boolean
  endedByAction: boolean
  externalMobilityChanged: boolean
  opponentInfluenceChanged: boolean
  reasons: string[]
  before: InternalWallPositionMetrics
  after: InternalWallPositionMetrics
}

function opponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function territoryCounts(state: GameSnapshot): Record<Player, number> {
  const totals: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board)) {
    for (const owner of row) if (owner) totals[owner]++
  }
  return totals
}

function accessibleCounts(state: GameSnapshot): Record<Player, number> {
  const totals: Record<Player, number> = { R: 0, B: 0 }
  for (const region of floodRegions(state.board)) {
    for (const player of ['R', 'B'] as const) {
      if (region.borderingCounts[player] > 0) totals[player] += region.cells.length
    }
  }
  return totals
}

function components(
  state: GameSnapshot,
  endpoints: readonly Pos[],
): InternalWallComponentSummary[] {
  return floodRegions(state.board).map((region) => ({
    size: region.cells.length,
    redStones: region.borderingCounts.R,
    blueStones: region.borderingCounts.B,
    owner:
      region.borderingCounts.R > 0 && region.borderingCounts.B === 0
        ? 'R'
        : region.borderingCounts.B > 0 && region.borderingCounts.R === 0
          ? 'B'
          : null,
    containsWallEndpoint: endpoints.some((endpoint) =>
      region.cells.some((cell) => getPosKey(cell) === getPosKey(endpoint)),
    ),
  }))
}

function metrics(state: GameSnapshot, perspective: Player, endpoints: readonly Pos[]) {
  return {
    territory: territoryCounts(state),
    accessible: accessibleCounts(state),
    mobility: {
      R: calculatePlayerMobilityQ3(state, 'R'),
      B: calculatePlayerMobilityQ3(state, 'B'),
    },
    components: components(state, endpoints),
    evaluation: evaluatePosition(state, perspective),
  }
}

function externalMobility(
  state: GameSnapshot,
  player: Player,
  originalComponent: ReadonlySet<string>,
): number {
  let destinations = 0
  for (let y = 0; y < state.board.length; y++) {
    for (let x = 0; x < state.board[y]!.length; x++) {
      if (state.board[y]![x]!.stone !== player) continue
      destinations += getLegalDestinationsForPlayerStoneQ3(state, { x, y }).filter(
        (destination) => !originalComponent.has(getPosKey(destination)),
      ).length
    }
  }
  return destinations
}

function wallEndpoints(action: PlayerAction): [Pos, Pos] | undefined {
  if (action.type !== 'wall' || !action.dir) return undefined
  const { x, y } = action.pos
  if (action.dir === 'left')
    return [
      { x, y },
      { x: x - 1, y },
    ]
  if (action.dir === 'right')
    return [
      { x, y },
      { x: x + 1, y },
    ]
  if (action.dir === 'top')
    return [
      { x, y },
      { x, y: y - 1 },
    ]
  return [
    { x, y },
    { x, y: y + 1 },
  ]
}

function sameAction(a: PlayerAction, b: PlayerAction): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function analyzeInternalWallAction(
  state: GameSnapshot,
  action: PlayerAction,
  perspective: Player = state.turn,
): InternalWallDiagnostic {
  const endpoints = wallEndpoints(action)
  if (!endpoints) throw new Error('Expected a standalone wall action')
  const beforeRegions = floodRegions(state.board)
  const endpointKeys = endpoints.map(getPosKey)
  const beforeRegion = beforeRegions.find((region) =>
    endpointKeys.every((key) => region.cells.some((cell) => getPosKey(cell) === key)),
  )
  const next = applyFullAction(state, action).state
  const before = metrics(state, perspective, endpoints)
  const after = metrics(next, perspective, endpoints)
  const ownOpponent = opponent(perspective)
  const sameComponent = beforeRegion !== undefined
  const ownOnly = sameComponent && beforeRegion!.borderingCounts[ownOpponent] === 0
  const hasOwnStone = sameComponent && beforeRegion!.borderingCounts[perspective] > 0
  const componentSplit =
    after.components.filter((component) => component.containsWallEndpoint).length > 1
  const emptySubregionCreated = after.components.some(
    (component) =>
      component.containsWallEndpoint && component.redStones + component.blueStones === 0,
  )
  const affectsEndOfGame = next.phase === 'finished' || next.result?.finished === true
  const endedByAction = state.phase !== 'finished' && next.phase === 'finished'
  const originalComponent = new Set(beforeRegion?.cells.map(getPosKey) ?? [])
  const externalMobilityChanged =
    externalMobility(state, perspective, originalComponent) !==
      externalMobility(next, perspective, originalComponent) ||
    externalMobility(state, ownOpponent, originalComponent) !==
      externalMobility(next, ownOpponent, originalComponent)
  const opponentInfluenceChanged =
    before.territory[ownOpponent] !== after.territory[ownOpponent] ||
    before.accessible[ownOpponent] !== after.accessible[ownOpponent]
  const immediateTerritoryLoss = Math.max(
    0,
    before.territory[perspective] - after.territory[perspective],
  )
  const immediateTerritoryGain = Math.max(
    0,
    after.territory[perspective] - before.territory[perspective],
  )
  const territoryPreserved = immediateTerritoryLoss === 0 && immediateTerritoryGain === 0
  const reasons: string[] = []
  if (!sameComponent) reasons.push('endpoints-start-in-different-components')
  if (!ownOnly) reasons.push('component-is-not-own-only')
  if (!hasOwnStone) reasons.push('component-has-no-own-stone')
  if (componentSplit) reasons.push('wall-splits-component')
  if (emptySubregionCreated) reasons.push('creates-empty-subregion')
  if (affectsEndOfGame) reasons.push('affects-end-of-game')
  if (externalMobilityChanged) reasons.push('changes-mobility')
  if (opponentInfluenceChanged) reasons.push('changes-opponent-influence')
  if (territoryPreserved) reasons.push('territory-preserved')
  if (immediateTerritoryLoss > 0) reasons.push('immediate-own-territory-loss')
  return {
    action,
    wall: { pos: { ...action.pos }, dir: action.dir!, endpoints },
    strictlyInternal:
      sameComponent &&
      ownOnly &&
      hasOwnStone &&
      !opponentInfluenceChanged &&
      !externalMobilityChanged,
    immediateTerritoryLoss,
    immediateTerritoryGain,
    territoryPreserved,
    componentSplit,
    emptySubregionCreated,
    affectsEndOfGame,
    endedByAction,
    externalMobilityChanged,
    opponentInfluenceChanged,
    reasons,
    before,
    after,
  }
}

export function chooseImmediateLossSafeWall(
  state: GameSnapshot,
  candidates: readonly PlayerAction[],
): { action: PlayerAction; fallback: boolean } {
  const diagnostics = candidates
    .filter((candidate) => candidate.type === 'wall' && !candidate.followUp)
    .map((candidate) => analyzeInternalWallAction(state, candidate))
  const safe = diagnostics.find((diagnostic) => diagnostic.immediateTerritoryLoss === 0)
  return { action: safe?.action ?? candidates[0]!, fallback: safe === undefined }
}

export function compareInternalWallCandidates(
  state: GameSnapshot,
  candidates: readonly PlayerAction[],
): InternalWallDiagnostic[] {
  return candidates
    .filter((candidate) => candidate.type === 'wall' && !candidate.followUp)
    .map((candidate) => analyzeInternalWallAction(state, candidate))
    .sort((left, right) =>
      sameAction(left.action, right.action)
        ? 0
        : left.immediateTerritoryLoss - right.immediateTerritoryLoss,
    )
}
