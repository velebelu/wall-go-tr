import { describe, expect, it } from 'vitest'
import {
  aggregateAdaptivePilot,
  buildAdaptivePilotSchedule,
  compareAdaptivePairs,
  type AdaptiveDecisionLog,
  type AdaptivePilotGameResult,
} from './evaluateAdaptiveBudgetMCTS'

describe('adaptive budget paired pilot', () => {
  it('pairs variants with identical colors and seeds', () => {
    expect(buildAdaptivePilotSchedule()).toHaveLength(80)
    const schedule = buildAdaptivePilotSchedule(1)
    expect(schedule).toHaveLength(8)
    for (let index = 0; index < schedule.length; index += 2) {
      const baseline = schedule[index]!
      const adaptive = schedule[index + 1]!
      expect([baseline.variant, adaptive.variant]).toEqual([
        'playable-baseline',
        'adaptive-budget-v1',
      ])
      expect(adaptive.pairId).toBe(baseline.pairId)
      expect(adaptive.subjectColor).toBe(baseline.subjectColor)
      expect(adaptive.scenarioSeed).toBe(baseline.scenarioSeed)
      expect(adaptive.subjectBaseSeed).toBe(baseline.subjectBaseSeed)
      expect(adaptive.opponentBaseSeed).toBe(baseline.opponentBaseSeed)
    }
  })

  it('compares paired outcomes and territory differences', () => {
    const [baselineItem, adaptiveItem] = buildAdaptivePilotSchedule(1)
    const result = (
      item: typeof baselineItem,
      outcome: AdaptivePilotGameResult['outcome'],
      territoryDiff: number,
    ): AdaptivePilotGameResult => ({
      ...item!,
      winner: outcome === 'tie' ? 'tie' : outcome === 'win' ? item!.subjectColor : 'B',
      outcome,
      territorySubject: 20,
      territoryOpponent: 20 - territoryDiff,
      territoryDiff,
      decisions: 10,
      subjectDecisions: 5,
      averageDecisionMs: 1,
      p50DecisionMs: 1,
      p95DecisionMs: 1,
      allSubjectActionsLegal: true,
    })
    expect(
      compareAdaptivePairs([result(baselineItem, 'loss', -5), result(adaptiveItem, 'win', 3)]),
    ).toEqual({
      pairs: 1,
      adaptiveBetterOutcome: 1,
      baselineBetterOutcome: 0,
      equalOutcome: 0,
      averageTerritoryDiffDelta: 8,
    })
  })

  it('aggregates outcomes, territory, Wilson and decision percentiles', () => {
    const template = buildAdaptivePilotSchedule(1)[0]!
    const results = [
      {
        ...template,
        winner: template.subjectColor,
        outcome: 'win',
        territorySubject: 30,
        territoryOpponent: 10,
        territoryDiff: 20,
        decisions: 10,
        subjectDecisions: 2,
        averageDecisionMs: 15,
        p50DecisionMs: 10,
        p95DecisionMs: 20,
        allSubjectActionsLegal: true,
      },
      {
        ...template,
        gameId: `${template.gameId}-loss`,
        winner: template.subjectColor === 'R' ? 'B' : 'R',
        outcome: 'loss',
        territorySubject: 10,
        territoryOpponent: 30,
        territoryDiff: -20,
        decisions: 10,
        subjectDecisions: 2,
        averageDecisionMs: 35,
        p50DecisionMs: 30,
        p95DecisionMs: 40,
        allSubjectActionsLegal: true,
      },
    ] satisfies AdaptivePilotGameResult[]
    const logs = [10, 20, 30, 40].map(
      (decisionMs, decisionIndex) =>
        ({
          ...template,
          decisionIndex,
          decisionSeed: template.subjectBaseSeed + decisionIndex,
          legalActionCount: 50,
          simulations: 100,
          decisionMs,
          action: '{}',
        }) satisfies AdaptiveDecisionLog,
    )
    expect(aggregateAdaptivePilot(results, logs)).toMatchObject({
      games: 2,
      wins: 1,
      losses: 1,
      ties: 0,
      winRate: 50,
      averageTerritoryDiff: 0,
      averageDecisionMs: 25,
      p50DecisionMs: 20,
      p95DecisionMs: 40,
      subjectDecisions: 4,
    })
  })
})
