import { describe, expect, it, vi } from 'vitest'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import type { choosePlayableMCTSAction } from '@/agents/mctsWorkerDecision'
import { makeInitialState } from '@/store/gameState'
import {
  chooseAdaptiveBudgetMCTSAction,
  getAdaptiveMCTSConfig,
  selectAdaptiveMCTSSimulations,
} from './adaptiveMCTSBudget'

describe('adaptive-budget-v1', () => {
  it.each([
    [0, 50],
    [30, 50],
    [31, 100],
    [70, 100],
    [71, 150],
    [110, 150],
    [111, 200],
    [500, 200],
  ])('assigns %i legal actions a budget of %i simulations', (legal, expected) => {
    expect(selectAdaptiveMCTSSimulations(legal)).toBe(expected)
  })

  it('rejects invalid legal-action counts', () => {
    expect(() => selectAdaptiveMCTSSimulations(-1)).toThrow()
    expect(() => selectAdaptiveMCTSSimulations(1.5)).toThrow()
  })

  it('changes only simulations relative to FINAL_MCTS_CONFIG', () => {
    expect(getAdaptiveMCTSConfig(111)).toEqual({
      ...FINAL_MCTS_CONFIG,
      simulations: 200,
    })
    expect(FINAL_MCTS_CONFIG.simulations).toBe(50)
  })

  it('records legal actions, assigned simulations and elapsed time', () => {
    const state = makeInitialState()
    const chooseMCTS = vi.fn((_request: Parameters<typeof choosePlayableMCTSAction>[0]) => ({
      type: 'place' as const,
      pos: { x: 0, y: 0 },
    }))
    const times = [10, 25]
    const decision = chooseAdaptiveBudgetMCTSAction({
      gameState: state,
      seed: 123,
      now: () => times.shift()!,
      chooseMCTS,
    })
    expect(decision).toMatchObject({
      legalActionCount: 45,
      simulations: 100,
      elapsedMs: 15,
    })
    expect(chooseMCTS.mock.calls[0]?.[0]).toMatchObject({
      seed: 123,
      config: { ...FINAL_MCTS_CONFIG, simulations: 100 },
    })
  })
})
