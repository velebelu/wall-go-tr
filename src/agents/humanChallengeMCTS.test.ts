import { describe, expect, it } from 'vitest'
import { FINAL_MCTS_CONFIG } from './MCTSAgent'
import {
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
  detectSmallEndgame,
  measureHumanChallengeConfidence,
  solveSmallEndgame,
} from './humanChallengeMCTS'
import { searchBestActionStaged } from '@/engine/mcts/MCTS'
import { createPlayableMCTSRng } from './mctsWorkerDecision'
import { makeInitialState } from '@/store/gameState'
import type { MCTSResult } from '@/engine/mcts/types'
import { readFileSync } from 'node:fs'
import { deserializeGameSnapshot, type HumanMCTSDecisionFixtureV1 } from '@/utils/humanMCTSTrace'

function result(visits: number, first: number, second: number, valueGap: number): MCTSResult {
  const a = { type: 'place' as const, pos: { x: 0, y: 0 } }
  const b = { type: 'place' as const, pos: { x: 1, y: 0 } }
  return {
    action: a,
    visits,
    value: 0.2,
    rootVisits: visits,
    children: [
      { action: a, visits: first, value: 0.2 },
      { action: b, visits: second, value: 0.2 - valueGap },
    ],
    rootLegalActions: 2,
    rootExpandedChildren: 2,
    maxDepthReached: 1,
    averageSelectedDepth: 1,
  }
}

describe('FINAL_HUMAN_CHALLENGE_MCTS_CONFIG', () => {
  it('mantiene todas las propiedades del MCTS final y Q5 desactivado', () => {
    expect(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts).toMatchObject({
      ...FINAL_MCTS_CONFIG,
      simulations: 250,
      progressiveWidening: true,
      expansionPolicy: 'heuristic',
      tacticalVerification: true,
      tacticalCandidateCount: 2,
      qPriorWeight: 0,
    })
    expect(FINAL_MCTS_CONFIG.simulations).toBe(50)
  })

  it('define baja confianza y alta incertidumbre con umbrales explícitos', () => {
    expect(measureHumanChallengeConfidence(result(250, 30, 29, 0.01))).toMatchObject({
      lowConfidence: true,
      highUncertainty: true,
    })
    expect(measureHumanChallengeConfidence(result(250, 50, 48, 0.03))).toMatchObject({
      lowConfidence: true,
      highUncertainty: false,
    })
  })

  it('reutiliza un único árbol al ampliar 250→500 sin etapa de 750', () => {
    const state = makeInitialState()
    const staged = searchBestActionStaged(
      state,
      state.turn,
      { ...FINAL_MCTS_CONFIG, simulations: 250 },
      {
        simulationTargets: [10, 20],
        shouldContinue: () => ({ continueSearch: true, reason: 'test' }),
      },
      createPlayableMCTSRng(123),
    )
    expect(staged.completedTargets).toEqual([10, 20])
    expect(staged.result.rootVisits).toBe(20)
    expect(staged.result.children.reduce((sum, child) => sum + child.visits, 0)).toBe(20)
  })

  it('respeta el límite temporal conservando una acción legal', () => {
    const state = makeInitialState()
    let clock = 0
    const staged = searchBestActionStaged(
      state,
      state.turn,
      { ...FINAL_MCTS_CONFIG, simulations: 250 },
      {
        simulationTargets: [10, 20],
        timeLimitMs: 3,
        now: () => clock++,
      },
      createPlayableMCTSRng(12),
    )
    expect(staged.stoppedByTimeLimit).toBe(true)
    expect(staged.result.rootVisits).toBeGreaterThan(0)
  })

  it('no activa el solucionador en la posición inicial', () => {
    expect(detectSmallEndgame(makeInitialState()).active).toBe(false)
    expect(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.endgame.enabled).toBe(false)
    expect(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.budget.enable750).toBe(false)
    expect(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.budget.highUncertainty).toBe(500)
  })

  it('abandona limpiamente el solucionador al alcanzar su límite', () => {
    const state = makeInitialState()
    const solved = solveSmallEndgame(
      state,
      state.turn,
      { ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.endgame, maxTimeMs: 0 },
      () => 1,
    )
    expect(solved).toMatchObject({ completed: false, action: undefined })
    expect(solved.nodes).toBeGreaterThan(0)
  })

  it('evalúa el fixture final real con criterios alternativos sin adoptarlos', () => {
    const fixture = JSON.parse(
      readFileSync('data/entrenamiento/mcts/human_challenge_endgame_turn_32.fixture.json', 'utf8'),
    ) as HumanMCTSDecisionFixtureV1
    const state = deserializeGameSnapshot(fixture.stateBefore)
    const alternative = detectSmallEndgame(state, {
      ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.endgame,
      maxLegalActions: 12,
      maxConnectedRegions: 4,
      maxMobilePieces: 3,
    })
    expect(alternative.legalActions).toBe(15)
    expect(alternative.active).toBe(false)
    const limited = solveSmallEndgame(state, state.turn, {
      ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.endgame,
      maxNodes: 1,
    })
    expect(limited.completed).toBe(false)
    expect(fixture.legalActions).toContainEqual(fixture.action)
  })
})
