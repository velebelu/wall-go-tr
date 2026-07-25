import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { deserializeGameSnapshot, type HumanMCTSDecisionFixtureV1 } from '@/utils/humanMCTSTrace'
import type { MCTSChildResult } from './types'
import {
  analyzeClosureCandidate,
  EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
  verifyClosureThreatCandidates,
} from './closureThreatVerification'

function fixture(turn: 34 | 36 | 38): HumanMCTSDecisionFixtureV1 {
  return JSON.parse(
    readFileSync(
      `data/entrenamiento/mcts/analisis_derrota_humana_g_e09743f2/turn_${turn}.fixture.json`,
      'utf8',
    ),
  ) as HumanMCTSDecisionFixtureV1
}

function children(value: HumanMCTSDecisionFixtureV1): MCTSChildResult[] {
  return value.mcts!.rootCandidates
}

describe('closureThreatVerification experimental', () => {
  it('detecta aumento territorial, caída de accesibilidad y pérdida de última ficha', () => {
    const value = fixture(38)
    const state = deserializeGameSnapshot(value.stateBefore)
    const candidate = children(value).find(
      (row) => JSON.stringify(row.action) === JSON.stringify(value.action),
    )!
    const diagnostic = analyzeClosureCandidate(
      state,
      value.player,
      candidate,
      EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
    )
    expect(diagnostic.severe).toBe(true)
    expect(diagnostic.maximumOpponentTerritoryGain).toBeGreaterThanOrEqual(12)
    expect(diagnostic.maximumOwnAccessibleDrop).toBeGreaterThanOrEqual(12)
    expect(diagnostic.lostLastOwnStoneInLargeComponent).toBe(true)
  })

  it('evita la candidata peligrosa 12-34 del turno 34', () => {
    const value = fixture(34)
    const state = deserializeGameSnapshot(value.stateBefore)
    const dangerous = children(value).find(
      ({ action }) =>
        action.type === 'move' &&
        action.pos.x === 5 &&
        action.pos.y === 0 &&
        action.followUp?.dir === 'left',
    )!
    const result = verifyClosureThreatCandidates({
      rootState: state,
      perspective: value.player,
      children: children(value),
      originalAction: dangerous.action,
    })
    expect(result.changed).toBe(true)
    expect(result.reason).toBe('safer-candidate-preferred')
    expect(result.candidates.find((row) => row.action === dangerous.action)?.severe).toBe(true)
  })

  it('mantiene fallback cuando todas las candidatas principales colapsan en turno 38', () => {
    const value = fixture(38)
    const result = verifyClosureThreatCandidates({
      rootState: deserializeGameSnapshot(value.stateBefore),
      perspective: value.player,
      children: children(value),
      originalAction: value.action,
      config: {
        ...EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
        candidateCount: children(value).length,
      },
    })
    expect(result.reason).toBe('all-candidates-collapse-fallback')
    expect(result.changed).toBe(false)
    expect(result.action).toEqual(value.action)
  })

  it('no cambia una decisión normal sin región amenazada', () => {
    const state = makeInitialState()
    const legal = getLegalActions(state).slice(0, 4)
    const candidates = legal.map((action, index) => ({
      action,
      visits: 10 - index,
      value: 0,
    }))
    const result = verifyClosureThreatCandidates({
      rootState: state,
      perspective: state.turn,
      children: candidates,
      originalAction: candidates[0]!.action,
    })
    expect(result.changed).toBe(false)
    expect(result.threatsDetected).toBe(0)
    expect(getLegalActions(state)).toContainEqual(result.action)
  })

  it('respeta el límite temporal y conserva una acción legal reproducible', () => {
    const value = fixture(36)
    const state = deserializeGameSnapshot(value.stateBefore)
    let clock = 0
    const run = () =>
      verifyClosureThreatCandidates({
        rootState: state,
        perspective: value.player,
        children: children(value),
        originalAction: value.action,
        config: {
          ...EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG,
          maxTimeMsPerCandidate: 2,
        },
        now: () => clock++,
      })
    const first = run()
    clock = 0
    const second = run()
    expect(first.candidates.some((candidate) => candidate.stoppedByTimeLimit)).toBe(true)
    expect(first.action).toEqual(second.action)
    expect(getLegalActions(state)).toContainEqual(first.action)
  })
})
