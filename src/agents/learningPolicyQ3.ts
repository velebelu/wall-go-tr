import type { Cell, GameSnapshot, Player, PlayerAction, Pos, WallDir } from '@/lib/types'
import { getTerritoryMap } from '@/utils/territory'
import { isLegalMove } from '@/utils/move'

export const TERRITORY_DIFF_BUCKETS = {
  L3_MAX: -16,
  L2_MIN: -15,
  L2_MAX: -8,
  L1_MIN: -7,
  L1_MAX: -3,
  E_MIN: -2,
  E_MAX: 2,
  W1_MIN: 3,
  W1_MAX: 7,
  W2_MIN: 8,
  W2_MAX: 15,
  W3_MIN: 16,
} as const

export const MOBILITY_BUCKET_LIMITS = {
  ZERO: 0,
  LOW_MAX: 5,
  MEDIUM_MAX: 15,
  HIGH_MAX: 35,
} as const

export const WALL_BUCKET_LIMITS = {
  ZERO: 0,
  LOW_MAX: 8,
  MEDIUM_MAX: 20,
  HIGH_MAX: 36,
} as const

export interface PlayerMobilityQ3 {
  totalDestinations: number
  trapPieces: number
  lowPieces: number
}

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

export function bucketTerritoryDiffQ3(diff: number): string {
  if (diff <= TERRITORY_DIFF_BUCKETS.L3_MAX) return 'L3'
  if (diff <= TERRITORY_DIFF_BUCKETS.L2_MAX) return 'L2'
  if (diff <= TERRITORY_DIFF_BUCKETS.L1_MAX) return 'L1'
  if (diff <= TERRITORY_DIFF_BUCKETS.E_MAX) return 'E'
  if (diff <= TERRITORY_DIFF_BUCKETS.W1_MAX) return 'W1'
  if (diff <= TERRITORY_DIFF_BUCKETS.W2_MAX) return 'W2'
  return 'W3'
}

export function bucketMobilityQ3(value: number): string {
  if (value === MOBILITY_BUCKET_LIMITS.ZERO) return '0'
  if (value <= MOBILITY_BUCKET_LIMITS.LOW_MAX) return '1-5'
  if (value <= MOBILITY_BUCKET_LIMITS.MEDIUM_MAX) return '6-15'
  if (value <= MOBILITY_BUCKET_LIMITS.HIGH_MAX) return '16-35'
  return '36+'
}

export function bucketWallsQ3(value: number): string {
  if (value === WALL_BUCKET_LIMITS.ZERO) return '0'
  if (value <= WALL_BUCKET_LIMITS.LOW_MAX) return '1-8'
  if (value <= WALL_BUCKET_LIMITS.MEDIUM_MAX) return '9-20'
  if (value <= WALL_BUCKET_LIMITS.HIGH_MAX) return '21-36'
  return '37+'
}

export function countTerritoryQ3(state: GameSnapshot): Record<Player, number> {
  const territoryMap = getTerritoryMap(state.board)
  const totals: Record<Player, number> = { R: 0, B: 0 }

  // getTerritoryMap marks only pure regions. Neutral cells are null and are intentionally ignored.
  // During placing, territory may be sparse or strategically immature, but the same pure-region
  // counting is used so the key remains deterministic and comparable across phases.
  for (let y = 0; y < territoryMap.length; y++) {
    for (let x = 0; x < territoryMap[y].length; x++) {
      const owner = territoryMap[y][x]
      if (owner) totals[owner]++
    }
  }

  return totals
}

function getPlayerStones(board: Cell[][], player: Player): Pos[] {
  const stones: Pos[] = []
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board[y].length; x++) {
      if (board[y][x].stone === player) stones.push({ x, y })
    }
  }
  return stones
}

export function getLegalDestinationsForPlayerStoneQ3(state: GameSnapshot, from: Pos): Pos[] {
  const destinations: Pos[] = []
  for (let y = 0; y < state.board.length; y++) {
    for (let x = 0; x < state.board[y].length; x++) {
      if (isLegalMove(from, { x, y }, state.board)) destinations.push({ x, y })
    }
  }
  return destinations
}

export function calculatePlayerMobilityQ3(state: GameSnapshot, player: Player): PlayerMobilityQ3 {
  let totalDestinations = 0
  let trapPieces = 0
  let lowPieces = 0

  for (const stone of getPlayerStones(state.board, player)) {
    const destinations = getLegalDestinationsForPlayerStoneQ3(state, stone)
    totalDestinations += destinations.length
    if (destinations.length === 0) trapPieces++
    else if (destinations.length === 1) lowPieces++
  }

  return { totalDestinations, trapPieces, lowPieces }
}

export function countWallsQ3(board: Cell[][]): number {
  let walls = 0
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board[y].length; x++) {
      if (board[y][x].wallTop) walls++
      if (board[y][x].wallLeft) walls++
    }
  }
  return walls
}

function normalizePosForPlayerQ3(state: GameSnapshot, pos: Pos): Pos {
  if (state.turn === 'R') return { ...pos }
  return { x: pos.x, y: state.board.length - 1 - pos.y }
}

function normalizeDirectionForPlayerQ3(state: GameSnapshot, dir: WallDir): WallDir {
  if (state.turn === 'R') return dir
  if (dir === 'top') return 'bottom'
  if (dir === 'bottom') return 'top'
  return dir
}

function assertKnownPhase(phase: GameSnapshot['phase']): void {
  if (phase !== 'placing' && phase !== 'playing' && phase !== 'finished' && phase !== 'selecting') {
    throw new Error(`Unsupported Q3 phase: ${String(phase)}`)
  }
}

export function getLearningStateKeyQ3(state: GameSnapshot): string {
  assertKnownPhase(state.phase)
  const mine = state.turn
  const opponent = getOpponent(mine)
  const territory = countTerritoryQ3(state)
  const territoryDiff = territory[mine] - territory[opponent]
  const mineMobility = calculatePlayerMobilityQ3(state, mine)
  const opponentMobility = calculatePlayerMobilityQ3(state, opponent)
  const mineStones = state.stonesPlaced[mine] ?? 0
  const opponentStones = state.stonesPlaced[opponent] ?? 0

  return [
    'q3',
    `phase:${state.phase}`,
    `step:${state.stepsTaken}`,
    `sp:${mineStones},${opponentStones}`,
    `td:${bucketTerritoryDiffQ3(territoryDiff)}`,
    `mob:${bucketMobilityQ3(mineMobility.totalDestinations)},${bucketMobilityQ3(
      opponentMobility.totalDestinations,
    )}`,
    `trap:${mineMobility.trapPieces},${opponentMobility.trapPieces}`,
    `low:${mineMobility.lowPieces},${opponentMobility.lowPieces}`,
    `walls:${bucketWallsQ3(countWallsQ3(state.board))}`,
  ].join('|')
}

export function getLearningActionKeyQ3(state: GameSnapshot, action: PlayerAction): string {
  if (action.type === 'place') {
    const pos = normalizePosForPlayerQ3(state, action.pos)
    return `place|${pos.x}|${pos.y}`
  }

  if (action.type === 'move') {
    if (!action.from) throw new Error('Q3 move action requires from')
    const from = normalizePosForPlayerQ3(state, action.from)
    const to = normalizePosForPlayerQ3(state, action.pos)
    if (action.followUp) {
      if (action.followUp.type !== 'wall' || !action.followUp.dir) {
        throw new Error('Q3 move followUp must be a wall action')
      }
      const wallPos = normalizePosForPlayerQ3(state, action.followUp.pos)
      const wallDir = normalizeDirectionForPlayerQ3(state, action.followUp.dir)
      return `move-wall|${from.x}|${from.y}|${to.x}|${to.y}|${wallPos.x}|${wallPos.y}|${wallDir}`
    }
    return `move|${from.x}|${from.y}|${to.x}|${to.y}`
  }

  if (action.type === 'wall') {
    if (!action.dir) throw new Error('Q3 wall action requires dir')
    const wallPos = normalizePosForPlayerQ3(state, action.pos)
    const wallDir = normalizeDirectionForPlayerQ3(state, action.dir)
    return `wall|${wallPos.x}|${wallPos.y}|${wallDir}`
  }

  throw new Error(`Unsupported Q3 action type: ${(action as PlayerAction).type}`)
}

export function getLearningQTableKeyQ3(state: GameSnapshot, action: PlayerAction): string {
  return `${getLearningStateKeyQ3(state)}|||${getLearningActionKeyQ3(state, action)}`
}
