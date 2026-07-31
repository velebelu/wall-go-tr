import { describe, expect, it } from 'vitest'
import { buildInactiveInternalWallReport } from './evaluateInactiveInternalWallActions'

describe('inactive internal wall counterfactual diagnostic', () => {
  it('records root candidates and paired results without production intervention', () => {
    const report = buildInactiveInternalWallReport()
    expect(report.decision.accepted).toBe(false)
    expect(report.decision.productionModified).toBe(false)
    expect(report.observedCase.available).toBe(false)
    expect(report.fixtures).toHaveLength(2)
    expect(report.fixtures[0]!.rootCandidates.length).toBeGreaterThan(0)
    expect(report.fixtures[0]!.mcts.candidates[0]).toEqual(
      expect.objectContaining({ visits: expect.any(Number), value: expect.any(Number) }),
    )
  })

  it('is deterministic for fixed seeds and reports no illegal paired actions', () => {
    const first = JSON.stringify(buildInactiveInternalWallReport())
    const second = JSON.stringify(buildInactiveInternalWallReport())
    expect(second).toBe(first)
    const report = buildInactiveInternalWallReport()
    for (const fixture of report.fixtures) {
      for (const pair of fixture.interventions.C_pairedContinuations) {
        expect(pair.original.illegalActions).toBe(0)
        expect(pair.alternativeResult.illegalActions).toBe(0)
      }
    }
  })
})
