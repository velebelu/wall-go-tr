import type { Player } from '@/lib/types'
import { PLAYER_LIST } from '@/lib/types'
import type { TurnDecisionTrace } from '@/agents/TurnManager'
import { checkGameEnd } from './game'
import type { MCTSGameTurnTrace } from './saveGame'

export function appendMCTSGameTurnTrace(
  target: MCTSGameTurnTrace[],
  trace: TurnDecisionTrace,
  aiColor: Player,
): void {
  const wall = trace.action.type === 'wall' ? trace.action : trace.action.followUp
  const territoryBefore = checkGameEnd(trace.stateBefore.board, [...PLAYER_LIST]).score
  const territoryAfter = checkGameEnd(trace.stateAfter.board, [...PLAYER_LIST]).score
  const origin = trace.action.from ?? trace.stateBefore.selected

  target.push({
    decisionNumber: trace.turnNumber,
    phase: trace.stateBefore.phase,
    activePlayer: trace.player,
    aiColor,
    actorType: trace.player === aiColor ? 'mcts' : 'human',
    actionType: trace.action.type,
    hasWall: wall?.type === 'wall',
    fromX: origin?.x,
    fromY: origin?.y,
    toX: trace.action.pos.x,
    toY: trace.action.pos.y,
    wallX: wall?.type === 'wall' ? wall.pos.x : undefined,
    wallY: wall?.type === 'wall' ? wall.pos.y : undefined,
    wallDirection: wall?.type === 'wall' ? wall.dir : undefined,
    territoryRedBefore: territoryBefore?.R ?? 0,
    territoryBlueBefore: territoryBefore?.B ?? 0,
    territoryRedAfter: territoryAfter?.R ?? 0,
    territoryBlueAfter: territoryAfter?.B ?? 0,
    legalActionCount: trace.legalActionCount,
    decisionMs: Number(trace.decisionMs.toFixed(4)),
    baseSeed: trace.agentDiagnostics?.baseSeed,
    decisionIndex: trace.agentDiagnostics?.decisionIndex,
    decisionSeed: trace.agentDiagnostics?.decisionSeed,
  })
}
