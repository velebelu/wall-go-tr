import { calculatePlayerMobilityQ3 } from '@/agents/learningPolicyQ3'
import type { Cell, GameSnapshot, Player } from '@/lib/types'
import { floodRegions } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'

export const TERRITORY_WEIGHT = 10
export const MOBILITY_WEIGHT = 2
export const TRAPPED_WEIGHT = 8
export const EXPANSION_WEIGHT = 1
export const TERMINAL_SCORE = 1_000_000

export interface PositionEvaluationBreakdown {
  territory: number
  mobility: number
  trappedPieces: number
  expansion: number
  contestedRegionSupport: number
  total: number
}

export interface ContestedRegionSupportBreakdown {
  ownSupport: number
  opponentSupport: number
  differential: number
}

export interface PositionEvaluationOptions {
  contestedRegionSupport?: {
    enabled: boolean
    weight: number
  }
  onContestedRegionSupportEvaluation?: (elapsedMs: number) => void
}

export function calculateContestedRegionSupport(
  board: Cell[][],
  perspective: Player,
): ContestedRegionSupportBreakdown {
  const opponent = getOpponent(perspective)
  let ownSupport = 0
  let opponentSupport = 0
  for (const region of floodRegions(board)) {
    const ownStones = region.borderingCounts[perspective]
    const opponentStones = region.borderingCounts[opponent]
    if (ownStones === 0 || opponentStones === 0) continue
    const occupied = ownStones + opponentStones
    const emptyCells = region.cells.length - occupied
    ownSupport += emptyCells * Math.min(1, ownStones / 2)
    opponentSupport += emptyCells * Math.min(1, opponentStones / 2)
  }
  return { ownSupport, opponentSupport, differential: ownSupport - opponentSupport }
}

export function evaluatePosition(
  state: GameSnapshot,
  perspective: Player,
  options?: PositionEvaluationOptions,
): number {
  return evaluatePositionWithBreakdown(state, perspective, options).total
}

export function evaluatePositionWithBreakdown(
  state: GameSnapshot,
  perspective: Player,
  options?: PositionEvaluationOptions,
): PositionEvaluationBreakdown {
  const terminal = evaluateTerminal(state, perspective)
  if (terminal !== undefined) {
    return {
      territory: 0,
      mobility: 0,
      trappedPieces: 0,
      expansion: 0,
      contestedRegionSupport: 0,
      total: terminal,
    }
  }

  const opponent = getOpponent(perspective)
  const territoryCounts = countTerritory(state.board)
  const ownMobility = calculatePlayerMobilityQ3(state, perspective)
  const opponentMobility = calculatePlayerMobilityQ3(state, opponent)
  const ownExpansion = countAccessibleCells(state.board, perspective)
  const opponentExpansion = countAccessibleCells(state.board, opponent)

  const territory = (territoryCounts[perspective] - territoryCounts[opponent]) * TERRITORY_WEIGHT
  const mobility =
    (ownMobility.totalDestinations - opponentMobility.totalDestinations) * MOBILITY_WEIGHT
  const trappedPieces = (opponentMobility.trapPieces - ownMobility.trapPieces) * TRAPPED_WEIGHT
  const expansion = (ownExpansion - opponentExpansion) * EXPANSION_WEIGHT
  let contestedRegionSupport = 0
  const supportConfig = options?.contestedRegionSupport
  if (supportConfig?.enabled && supportConfig.weight !== 0) {
    const started = performance.now()
    contestedRegionSupport =
      calculateContestedRegionSupport(state.board, perspective).differential * supportConfig.weight
    options?.onContestedRegionSupportEvaluation?.(performance.now() - started)
  }

  return {
    territory,
    mobility,
    trappedPieces,
    expansion,
    contestedRegionSupport,
    total: territory + mobility + trappedPieces + expansion + contestedRegionSupport,
  }
}

function evaluateTerminal(state: GameSnapshot, perspective: Player): number | undefined {
  if (!state.result?.finished) return undefined
  if (state.result.tie) return 0
  if (state.result.winner === perspective) return TERMINAL_SCORE
  if (state.result.winner) return -TERMINAL_SCORE
  return 0
}

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function countTerritory(board: Cell[][]): Record<Player, number> {
  const totals: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(board)) {
    for (const owner of row) {
      if (owner) totals[owner]++
    }
  }
  return totals
}

function countAccessibleCells(board: Cell[][], player: Player): number {
  return floodRegions(board).reduce(
    (total, region) => total + (region.borderingCounts[player] > 0 ? region.cells.length : 0),
    0,
  )
}
