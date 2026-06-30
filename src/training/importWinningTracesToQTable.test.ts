import { describe, expect, it } from 'vitest'
import {
  buildQTableFromWinningTraces,
  LARGE_VICTORY_REWARD,
  NORMAL_VICTORY_REWARD,
} from './importWinningTracesToQTable'
import type { TrainingTraceGameRecord } from '@/utils/trainingTrace'

function makeTrace(
  winner: TrainingTraceGameRecord['winner'],
  finalScore: TrainingTraceGameRecord['finalScore'],
  actions: TrainingTraceGameRecord['actions'],
): TrainingTraceGameRecord {
  return {
    id: 'test-trace',
    createdAt: '2026-06-30T00:00:00.000Z',
    mode: 'heuristic_vs_heuristic',
    boardSize: 7,
    players: { R: 'heuristic', B: 'heuristic' },
    winner,
    finalScore,
    turns: actions.length,
    wallsPlaced: 0,
    initialStateKey: 'initial',
    finalStateKey: 'final',
    actions,
  }
}

describe('buildQTableFromWinningTraces', () => {
  it('imports only winner actions', () => {
    const qTable = buildQTableFromWinningTraces([
      makeTrace('R', { R: 20, B: 12 }, [
        {
          turn: 1,
          player: 'R',
          stateKey: 'winner-state',
          actionType: 'place',
          actionKey: 'place|1|1',
        },
        {
          turn: 2,
          player: 'B',
          stateKey: 'loser-state',
          actionType: 'wall',
          actionKey: 'wall|2|2|top',
        },
      ]),
    ])

    expect(qTable).toEqual({
      'winner-state|||place|1|1': NORMAL_VICTORY_REWARD,
    })
  })

  it('uses reward 0.3 for a normal victory', () => {
    const qTable = buildQTableFromWinningTraces([
      makeTrace('B', { R: 18, B: 25 }, [
        {
          turn: 1,
          player: 'B',
          stateKey: 'normal-victory-state',
          actionType: 'move',
          actionKey: 'move|1|1|2|2',
        },
      ]),
    ])

    expect(qTable['normal-victory-state|||move|1|1|2|2']).toBe(NORMAL_VICTORY_REWARD)
  })

  it('uses reward 0.5 for a large victory', () => {
    const qTable = buildQTableFromWinningTraces([
      makeTrace('R', { R: 34, B: 15 }, [
        {
          turn: 1,
          player: 'R',
          stateKey: 'large-victory-state',
          actionType: 'wall',
          actionKey: 'wall|3|3|left',
        },
      ]),
    ])

    expect(qTable['large-victory-state|||wall|3|3|left']).toBe(LARGE_VICTORY_REWARD)
  })
})
