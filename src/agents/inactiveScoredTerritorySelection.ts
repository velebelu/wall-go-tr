import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction, Pos } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'
import { floodRegions, getPosKey, type Region } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'

export interface InactiveScoredMovementEvidence {
  action: PlayerAction
  componentSize: number
  ownStones: number
  territoryBefore: Record<Player, number>
  territoryAfter: Record<Player, number>
  territoryDelta: Record<Player, number>
  classification: 'neutral-internal' | 'harmful-internal'
}

export interface InactiveScoredSelectionResult {
  action: PlayerAction
  changed: boolean
  intervention: boolean
  removedMovements: number
  usedFallback: boolean
  evidence: InactiveScoredMovementEvidence[]
}

interface Candidate {
  action: PlayerAction
  visits: number
  value: number
  index: number
}

/**
 * A movement is excluded only when its full action remains inside an already scored, own-only
 * wall component and cannot improve territory or finish the game. Walls are monotonic, so a legal
 * wall added from inside such a component cannot open it or affect a different component.
 */
export function analyzeInactiveScoredMovement(
  state: GameSnapshot,
  action: PlayerAction,
): InactiveScoredMovementEvidence | undefined {
  if (state.phase !== 'playing' || action.type !== 'move' || !action.from) return undefined
  const player = state.turn
  const opponent = other(player)
  const component = findRegion(state, action.from)
  if (!isOwnScoredComponent(state, component, player, opponent)) return undefined
  if (!contains(component, action.pos)) return undefined
  if (!followUpRemainsInside(component, action)) return undefined

  const territoryBefore = countTerritory(state)
  const after = applyFullAction(state, action).state
  if (after.phase === 'finished' || after.result?.finished) return undefined
  const territoryAfter = countTerritory(after)

  // A territorial gain or damage to the opponent is strategic evidence and must be retained.
  if (
    territoryAfter[player] > territoryBefore[player] ||
    territoryAfter[opponent] < territoryBefore[opponent]
  )
    return undefined

  return {
    action,
    componentSize: component.cells.length,
    ownStones: component.borderingCounts[player],
    territoryBefore,
    territoryAfter,
    territoryDelta: {
      R: territoryAfter.R - territoryBefore.R,
      B: territoryAfter.B - territoryBefore.B,
    },
    classification:
      territoryAfter[player] < territoryBefore[player] ||
      territoryAfter[opponent] > territoryBefore[opponent]
        ? 'harmful-internal'
        : 'neutral-internal',
  }
}

export function chooseInactiveScoredTerritoryCandidate(params: {
  state: GameSnapshot
  selected: PlayerAction
  candidates: readonly { action: PlayerAction; visits: number; value: number }[]
}): InactiveScoredSelectionResult {
  const legal = getLegalActions(params.state)
  const unique = new Map<string, Candidate>()
  const add = (action: PlayerAction, visits: number, value: number, index: number) => {
    const key = actionKey(action)
    if (unique.has(key)) return
    unique.set(key, { action, visits, value, index })
  }
  add(params.selected, selectedVisits(params), selectedValue(params), -1)
  params.candidates.forEach((candidate, index) =>
    add(candidate.action, candidate.visits, candidate.value, index),
  )

  const rankedCandidates = [...unique.values()]
  const evidence = rankedCandidates
    .map(({ action }) => analyzeInactiveScoredMovement(params.state, action))
    .filter((item): item is InactiveScoredMovementEvidence => item !== undefined)
  const removed = new Set(evidence.map(({ action }) => actionKey(action)))
  const selectedRemoved = removed.has(actionKey(params.selected))
  if (!selectedRemoved) {
    return {
      action: params.selected,
      changed: false,
      intervention: evidence.length > 0,
      removedMovements: evidence.length,
      usedFallback: false,
      evidence,
    }
  }

  const allowed = rankedCandidates.filter(({ action }) => !removed.has(actionKey(action)))
  const usedFallback = allowed.length === 0
  const pool = usedFallback ? rankedCandidates : allowed
  const replacement = [...pool].sort((left, right) =>
    compareCandidates(params.state, left, right, usedFallback),
  )[0]
  if (!replacement) {
    // The selected action was legal when MCTS produced it; retain it rather than inventing pass.
    return {
      action: params.selected,
      changed: false,
      intervention: true,
      removedMovements: evidence.length,
      usedFallback: true,
      evidence,
    }
  }
  const action = legal.some((candidate) => sameAction(candidate, replacement.action))
    ? replacement.action
    : params.selected
  return {
    action,
    changed: actionKey(action) !== actionKey(params.selected),
    intervention: true,
    removedMovements: evidence.length,
    usedFallback,
    evidence,
  }
}

function compareCandidates(
  state: GameSnapshot,
  left: Candidate,
  right: Candidate,
  fallback: boolean,
): number {
  const leftActive = Number(actionStartsInActiveComponent(state, left.action))
  const rightActive = Number(actionStartsInActiveComponent(state, right.action))
  if (leftActive !== rightActive) return rightActive - leftActive
  if (fallback) {
    const leftPreserves = Number(preservesTerritory(state, left.action))
    const rightPreserves = Number(preservesTerritory(state, right.action))
    if (leftPreserves !== rightPreserves) return rightPreserves - leftPreserves
    const leftWall = Number(left.action.type === 'wall')
    const rightWall = Number(right.action.type === 'wall')
    if (leftWall !== rightWall) return rightWall - leftWall
  }
  return (
    right.visits - left.visits ||
    right.value - left.value ||
    actionKey(left.action).localeCompare(actionKey(right.action)) ||
    left.index - right.index
  )
}

function actionStartsInActiveComponent(state: GameSnapshot, action: PlayerAction): boolean {
  if (action.type === 'place') return true
  const position = action.from ?? action.pos
  const region = findRegion(state, position)
  const opponent = other(state.turn)
  return !isOwnScoredComponent(state, region, state.turn, opponent)
}

function preservesTerritory(state: GameSnapshot, action: PlayerAction): boolean {
  const before = countTerritory(state)
  const after = countTerritory(applyFullAction(state, action).state)
  return before.R === after.R && before.B === after.B
}

function isOwnScoredComponent(
  state: GameSnapshot,
  region: Region,
  player: Player,
  opponent: Player,
): boolean {
  if (region.borderingCounts[player] === 0 || region.borderingCounts[opponent] !== 0) return false
  const territory = getTerritoryMap(state.board)
  return region.cells.every(({ x, y }) => territory[y][x] === player)
}

function followUpRemainsInside(region: Region, action: PlayerAction): boolean {
  const wall = action.followUp
  if (!wall || wall.type !== 'wall' || !wall.dir) return false
  const neighbor = wallNeighbor(wall.pos, wall.dir)
  return contains(region, wall.pos) && contains(region, neighbor)
}

function wallNeighbor(position: Pos, direction: 'top' | 'left' | 'right' | 'bottom'): Pos {
  if (direction === 'top') return { x: position.x, y: position.y - 1 }
  if (direction === 'bottom') return { x: position.x, y: position.y + 1 }
  if (direction === 'left') return { x: position.x - 1, y: position.y }
  return { x: position.x + 1, y: position.y }
}

function findRegion(state: GameSnapshot, position: Pos): Region {
  const region = floodRegions(state.board).find((candidate) => contains(candidate, position))
  if (!region) throw new Error(`Position outside board: ${getPosKey(position)}`)
  return region
}

function contains(region: Region, position: Pos): boolean {
  return region.cells.some(({ x, y }) => x === position.x && y === position.y)
}

function countTerritory(state: GameSnapshot): Record<Player, number> {
  const totals: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board))
    for (const owner of row) if (owner) totals[owner]++
  return totals
}

function selectedVisits(params: {
  selected: PlayerAction
  candidates: readonly { action: PlayerAction; visits: number; value: number }[]
}): number {
  return (
    params.candidates.find(({ action }) => actionKey(action) === actionKey(params.selected))
      ?.visits ?? 0
  )
}

function selectedValue(params: {
  selected: PlayerAction
  candidates: readonly { action: PlayerAction; visits: number; value: number }[]
}): number {
  return (
    params.candidates.find(({ action }) => actionKey(action) === actionKey(params.selected))
      ?.value ?? -Infinity
  )
}

function actionKey(action: PlayerAction): string {
  return JSON.stringify(action)
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  if (left.type !== right.type) return false
  if (left.pos.x !== right.pos.x || left.pos.y !== right.pos.y) return false
  if ((left.from?.x ?? -1) !== (right.from?.x ?? -1)) return false
  if ((left.from?.y ?? -1) !== (right.from?.y ?? -1)) return false
  if (left.dir !== right.dir) return false
  if (left.followUp === undefined || right.followUp === undefined)
    return left.followUp === right.followUp
  return sameAction(left.followUp, right.followUp)
}

function other(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}
