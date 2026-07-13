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
  total: number
}

export function evaluatePosition(state: GameSnapshot, perspective: Player): number {
  return evaluatePositionWithBreakdown(state, perspective).total
}

export function evaluatePositionWithBreakdown(
  state: GameSnapshot,
  perspective: Player,
): PositionEvaluationBreakdown {
  const terminal = evaluateTerminal(state, perspective)
  if (terminal !== undefined) {
    return {
      territory: 0,
      mobility: 0,
      trappedPieces: 0,
      expansion: 0,
      total: terminal,
    }
  }

  const opponent = getOpponent(perspective)
  const territoryCounts = countTerritory(state.board)
  const ownMobility = calculatePlayerMobilityQ3(state, perspective)
  const opponentMobility = calculatePlayerMobilityQ3(state, opponent)
  const ownExpansion = countAccessibleCells(state.board, perspective)
  const opponentExpansion = countAccessibleCells(state.board, opponent)

  const territory =
    (territoryCounts[perspective] - territoryCounts[opponent]) * TERRITORY_WEIGHT
  const mobility =
    (ownMobility.totalDestinations - opponentMobility.totalDestinations) * MOBILITY_WEIGHT
  const trappedPieces = (opponentMobility.trapPieces - ownMobility.trapPieces) * TRAPPED_WEIGHT
  const expansion = (ownExpansion - opponentExpansion) * EXPANSION_WEIGHT

  return {
    territory,
    mobility,
    trappedPieces,
    expansion,
    total: territory + mobility + trappedPieces + expansion,
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
