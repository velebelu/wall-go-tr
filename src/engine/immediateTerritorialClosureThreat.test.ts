import { describe, expect, it } from 'vitest'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import { evaluatePosition } from '@/engine/evaluatePosition'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { createEmptyBoard, makeInitialState, snapshotFromState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { immediateTerritorialClosureThreat } from './immediateTerritorialClosureThreat'

const CONFIG = Object.freeze({
  enabled: true,
  weight: 10,
  minimumTerritoryDrop: 5,
  minimumAccessibleDrop: 5,
})

const CLOSING_ACTION: PlayerAction = {
  type: 'wall',
  from: { x: 3, y: 3 },
  pos: { x: 3, y: 3 },
  dir: 'right',
}

function closureFixture(): GameSnapshot {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = 'B'
  state.stonesPlaced = { R: 4, B: 4 }
  state.board[2][5].stone = 'R'
  state.board[4][5].stone = 'R'
  state.board[3][3].stone = 'B'
  state.board[1][1].stone = 'B'
  for (let y = 0; y < state.board.length; y++) {
    if (y !== 3) state.board[y][4].wallLeft = 'B'
  }
  return state
}

describe('immediateTerritorialClosureThreat', () => {
  it('reconstruye un cierre de un turno, valida su legalidad y devuelve diagnóstico', () => {
    const state = closureFixture()
    const before = snapshotFromState(state)
    expect(getLegalActions(state)).toContainEqual(CLOSING_ACTION)

    const signal = immediateTerritorialClosureThreat(state, 'R', CONFIG)

    expect(signal.detected).toBe(true)
    expect(signal.worstReply).toEqual(CLOSING_ACTION)
    expect(signal.legalRepliesChecked).toBeGreaterThan(0)
    expect(signal.accessibleDrop).toBeGreaterThanOrEqual(CONFIG.minimumAccessibleDrop)
    expect(signal.penalty).toBe(CONFIG.weight * signal.severity)
    expect(state).toEqual(before)
  })

  it('reduce la evaluación vulnerable y deja de tratarla como claramente favorable', () => {
    const state = closureFixture()
    const original = evaluatePosition(state, 'R')
    const signal = immediateTerritorialClosureThreat(state, 'R', CONFIG)
    const experimental = original - signal.penalty
    const closed = applyFullAction(state, CLOSING_ACTION).state

    expect(signal.detected).toBe(true)
    expect(experimental).toBeLessThan(original)
    expect(experimental).toBeLessThanOrEqual(0)
    expect(closed.result).toMatchObject({ finished: true, winner: 'B' })
  })

  it('desactivada reproduce exactamente la evaluación anterior', () => {
    const state = closureFixture()
    const signal = immediateTerritorialClosureThreat(state, 'R', {
      ...CONFIG,
      enabled: false,
    })
    expect(signal.penalty).toBe(0)
    expect(evaluatePosition(state, 'R') - signal.penalty).toBe(evaluatePosition(state, 'R'))
  })

  it('no modifica FINAL_MCTS_CONFIG ni activa la señal jugable', () => {
    expect(FINAL_MCTS_CONFIG).toEqual({
      simulations: 50,
      explorationConstant: Math.SQRT2,
      maxDepth: 60,
      rolloutPolicy: 'mixed',
      heuristicProbability: 0.8,
      expansionPolicy: 'heuristic',
      progressiveWidening: true,
      wideningConstant: 2,
      wideningExponent: 0.5,
      qPriorWeight: 0,
      tacticalVerification: true,
      tacticalCandidateCount: 2,
    })
    expect('immediateTerritorialClosureThreat' in FINAL_MCTS_CONFIG).toBe(false)
  })
})
