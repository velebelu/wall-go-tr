import { describe, expect, it } from 'vitest'
import {
  evaluateScoredTerritoryCorpus,
  SCORED_TERRITORY_EVALUATION_LIMITS,
} from './evaluateScoredTerritoryProtection'

describe('evaluateScoredTerritoryCorpus', () => {
  it('scans a bounded natural trace without writing or changing official configuration', async () => {
    const report = await evaluateScoredTerritoryCorpus({
      write: false,
      limits: {
        ...SCORED_TERRITORY_EVALUATION_LIMITS,
        maxGames: 1,
        maxMCTSDecisions: 100,
        continuationsPerB: 0,
      },
    })
    expect(report).toMatchObject({
      diagnosticOnly: true,
      officialConfigurationChanged: false,
      gamesScanned: 1,
    })
    expect(report.mctsDecisionsInspected).toBeGreaterThan(0)
  })
})
