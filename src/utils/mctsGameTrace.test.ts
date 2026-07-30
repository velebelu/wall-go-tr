import { describe, expect, it } from 'vitest'
import { makeInitialState } from '@/store/gameState'
import type { TurnDecisionTrace } from '@/agents/TurnManager'
import type { MCTSGameTurnTrace } from './saveGame'
import { appendMCTSGameTurnTrace } from './mctsGameTrace'

function makeDecision(turnNumber: number): TurnDecisionTrace {
  const state = makeInitialState()
  return {
    turnNumber,
    player: 'R',
    stateBefore: structuredClone(state),
    stateAfter: structuredClone(state),
    action: { type: 'place', pos: { x: turnNumber, y: 0 } },
    legalActionCount: 12,
    decisionMs: 10,
    agentDiagnostics: {
      baseSeed: 100,
      decisionIndex: turnNumber,
      decisionSeed: 100 + turnNumber,
    },
  }
}

describe('MCTS game trace accumulation', () => {
  it('adds one row for one MCTS decision', () => {
    const trace: MCTSGameTurnTrace[] = []
    appendMCTSGameTurnTrace(trace, makeDecision(0), 'R')
    expect(trace).toHaveLength(1)
    expect(trace[0]).toMatchObject({
      decisionNumber: 0,
      phase: 'placing',
      activePlayer: 'R',
      aiColor: 'R',
      actorType: 'mcts',
      decisionIndex: 0,
      decisionSeed: 100,
    })
  })

  it('accumulates multiple decisions without resetting previous rows', () => {
    const trace: MCTSGameTurnTrace[] = []
    appendMCTSGameTurnTrace(trace, makeDecision(0), 'R')
    appendMCTSGameTurnTrace(trace, makeDecision(1), 'R')
    appendMCTSGameTurnTrace(trace, makeDecision(2), 'R')
    expect(trace.map((row) => row.decisionNumber)).toEqual([0, 1, 2])
  })

  it('uses the same complete-decision unit for alternating MCTS and human moves', () => {
    const trace: MCTSGameTurnTrace[] = []
    const mcts = makeDecision(0)
    mcts.stateBefore.phase = 'playing'
    mcts.stateAfter.phase = 'playing'
    mcts.action = {
      type: 'move',
      from: { x: 0, y: 0 },
      pos: { x: 1, y: 0 },
      followUp: { type: 'wall', pos: { x: 1, y: 0 }, dir: 'bottom' },
    }
    const human = {
      ...makeDecision(1),
      player: 'B' as const,
      action: {
        type: 'move' as const,
        from: { x: 1, y: 1 },
        pos: { x: 2, y: 1 },
        followUp: {
          type: 'wall' as const,
          pos: { x: 2, y: 1 },
          dir: 'bottom' as const,
        },
      },
      agentDiagnostics: undefined,
    }
    human.stateBefore.phase = 'playing'
    human.stateAfter.phase = 'playing'

    appendMCTSGameTurnTrace(trace, mcts, 'R')
    appendMCTSGameTurnTrace(trace, human, 'R')

    expect(trace).toHaveLength(2)
    expect(trace.map((row) => row.actorType)).toEqual(['mcts', 'human'])
    expect(trace.map((row) => row.hasWall)).toEqual([true, true])
    expect(trace.map((row) => row.actionType)).toEqual(['move', 'move'])
    expect(trace.map((row) => row.decisionNumber)).toEqual([0, 1])
  })
})
