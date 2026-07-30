import { calculatePlayerMobilityQ3 } from '@/agents/learningPolicyQ3'
import { applyFullAction } from '@/engine/gameSimulator'
import type { Cell, GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'
import { floodRegions } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'

export interface ImmediateTerritorialClosureThreatConfig {
  enabled: boolean
  weight: number
  minimumTerritoryDrop: number
  minimumAccessibleDrop: number
}

export interface ImmediateTerritorialClosureThreatDiagnostic {
  detected: boolean
  legalRepliesChecked: number
  threateningReplies: number
  worstReply?: PlayerAction
  territoryBefore: number
  territoryAfterWorstReply: number
  territoryDrop: number
  accessibleBefore: number
  accessibleAfterWorstReply: number
  accessibleDrop: number
  trappedPiecesIncrease: number
  terminalLoss: boolean
  severity: number
  penalty: number
}

const disabledDiagnostic = (
  territory: number,
  accessible: number,
): ImmediateTerritorialClosureThreatDiagnostic => ({
  detected: false,
  legalRepliesChecked: 0,
  threateningReplies: 0,
  territoryBefore: territory,
  territoryAfterWorstReply: territory,
  territoryDrop: 0,
  accessibleBefore: accessible,
  accessibleAfterWorstReply: accessible,
  accessibleDrop: 0,
  trappedPiecesIncrease: 0,
  terminalLoss: false,
  severity: 0,
  penalty: 0,
})

/**
 * One-ply experimental signal. It only examines the legal actions of the side to
 * move, and therefore applies when the evaluated position leaves the opponent
 * on turn.
 *
 * severity = territoryDrop + 0.25 * accessibleDrop
 *            + 2 * trappedPiecesIncrease + 100 * terminalLoss
 * penalty = weight * max(severity among threatening legal replies)
 */
export function immediateTerritorialClosureThreat(
  state: GameSnapshot,
  perspective: Player,
  config: ImmediateTerritorialClosureThreatConfig,
): ImmediateTerritorialClosureThreatDiagnostic {
  const territoryBefore = territoryCount(state.board, perspective)
  const accessibleBefore = accessibleCount(state.board, perspective)
  const initial = disabledDiagnostic(territoryBefore, accessibleBefore)
  if (!config.enabled || state.phase !== 'playing' || state.turn === perspective) return initial

  const trappedBefore = calculatePlayerMobilityQ3(state, perspective).trapPieces
  const replies = getLegalActions(state)
  let worst = initial
  let threateningReplies = 0

  for (const reply of replies) {
    const after = applyFullAction(state, reply).state
    const territoryAfter = territoryCount(after.board, perspective)
    const accessibleAfter = accessibleCount(after.board, perspective)
    const territoryDrop = Math.max(0, territoryBefore - territoryAfter)
    const accessibleDrop = Math.max(0, accessibleBefore - accessibleAfter)
    const trappedIncrease = Math.max(
      0,
      calculatePlayerMobilityQ3(after, perspective).trapPieces - trappedBefore,
    )
    const terminalLoss =
      after.result?.finished === true &&
      !after.result.tie &&
      after.result.winner !== undefined &&
      after.result.winner !== perspective
    const detected =
      terminalLoss ||
      trappedIncrease > 0 ||
      territoryDrop >= config.minimumTerritoryDrop ||
      accessibleDrop >= config.minimumAccessibleDrop
    if (!detected) continue
    threateningReplies++
    const severity =
      territoryDrop + 0.25 * accessibleDrop + 2 * trappedIncrease + (terminalLoss ? 100 : 0)
    if (!worst.detected || severity > worst.severity) {
      worst = {
        detected: true,
        legalRepliesChecked: replies.length,
        threateningReplies,
        worstReply: reply,
        territoryBefore,
        territoryAfterWorstReply: territoryAfter,
        territoryDrop,
        accessibleBefore,
        accessibleAfterWorstReply: accessibleAfter,
        accessibleDrop,
        trappedPiecesIncrease: trappedIncrease,
        terminalLoss,
        severity,
        penalty: config.weight * severity,
      }
    }
  }

  return {
    ...worst,
    legalRepliesChecked: replies.length,
    threateningReplies,
  }
}

function territoryCount(board: Cell[][], player: Player): number {
  let count = 0
  for (const row of getTerritoryMap(board)) {
    for (const owner of row) if (owner === player) count++
  }
  return count
}

function accessibleCount(board: Cell[][], player: Player): number {
  return floodRegions(board).reduce(
    (total, region) => total + (region.borderingCounts[player] > 0 ? region.cells.length : 0),
    0,
  )
}
