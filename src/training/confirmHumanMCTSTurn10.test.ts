import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TURN_10_FINAL_ACTION,
  TURN_10_ORIGINAL_ACTION,
  aggregateActionMatches,
  bootstrapMeanCI95,
  buildPairedComparison,
  classifyTurn10,
  confirmHumanMCTSTurn10,
  confirmationCandidates,
  loadProgress,
  validateTurn10Fixture,
  type NamedConfirmationMatch,
} from './confirmHumanMCTSTurn10'
import { structuralActionKey, type CounterfactualMatch } from './evaluateHumanMCTSCounterfactual'

const FIXTURE = path.resolve(
  'data/entrenamiento/mcts/analisis_partida_humana_g_41746ecd/fixtures/3_turn_10_mcts_5.fixture.json',
)
const WRONG_FIXTURE = path.resolve(
  'data/entrenamiento/mcts/analisis_partida_humana_g_41746ecd/fixtures/1_turn_3_mcts_1.fixture.json',
)

function namedMatch(
  seed: number,
  actionName: 'final' | 'original',
  outcome: 'win' | 'loss',
  territoryDiff: number,
): NamedConfirmationMatch {
  const action = actionName === 'final' ? TURN_10_FINAL_ACTION : TURN_10_ORIGINAL_ACTION
  return {
    fixtureId: '3_turn_10_mcts_5',
    turnIndex: 10,
    candidateKey: structuralActionKey(action),
    candidateAction: action,
    pairSeed: seed,
    winner: outcome === 'win' ? 'R' : 'B',
    outcome,
    territoryCandidate: 20 + territoryDiff,
    territoryOpponent: 20,
    territoryDiff,
    turns: 20,
    reachedTurnLimit: false,
    durationMs: 100,
    actionName,
  }
}

function fakeRunner(calls: Array<{ seed: number; key: string }>) {
  return async (
    _loaded: unknown,
    candidate: { key: string; action: typeof TURN_10_FINAL_ACTION },
    seed: number,
  ): Promise<CounterfactualMatch> => {
    calls.push({ seed, key: candidate.key })
    const original = candidate.key === structuralActionKey(TURN_10_ORIGINAL_ACTION)
    const row = namedMatch(
      seed,
      original ? 'original' : 'final',
      original ? 'win' : 'loss',
      original ? 8 : -2,
    )
    const { actionName: _actionName, ...match } = row
    return match
  }
}

describe('confirmHumanMCTSTurn10', () => {
  it('acepta solo el fixture exacto y compara únicamente las dos acciones definidas', () => {
    expect(validateTurn10Fixture(FIXTURE).fixture.source.turnIndex).toBe(10)
    expect(() => validateTurn10Fixture(WRONG_FIXTURE)).toThrow('Expected')
    const candidates = confirmationCandidates()
    expect(Object.keys(candidates)).toEqual(['final', 'original'])
    expect(candidates.final.key).toBe(structuralActionKey(TURN_10_FINAL_ACTION))
    expect(candidates.original.key).toBe(structuralActionKey(TURN_10_ORIGINAL_ACTION))
  })

  it('empareja exactamente las semillas y calcula métricas e IC95', () => {
    const rows = [
      namedMatch(1, 'final', 'loss', -4),
      namedMatch(1, 'original', 'win', 8),
      namedMatch(2, 'final', 'loss', -2),
      namedMatch(2, 'original', 'win', 10),
    ]
    const paired = buildPairedComparison(rows)
    expect(paired.pairs.map((row) => row.seed)).toEqual([1, 2])
    expect(paired.summary).toMatchObject({
      originalPreferred: 2,
      finalPreferred: 0,
      originalOutcomeBetter: 2,
      finalOutcomeBetter: 0,
      equalOutcomes: 0,
      averageTerritoryDelta: 12,
    })
    const original = aggregateActionMatches(rows.filter((row) => row.actionName === 'original'))
    expect(original).toMatchObject({ wins: 2, winRate: 1 })
    expect(original.winRateCI95.low).toBeCloseTo(34.238)
    expect(bootstrapMeanCI95([10, 12], 1000, 7)).toEqual(bootstrapMeanCI95([10, 12], 1000, 7))
  })

  it('clasifica evidencia fuerte y solapamiento', () => {
    const strong = [
      namedMatch(1, 'final', 'loss', -4),
      namedMatch(1, 'original', 'win', 8),
      namedMatch(2, 'final', 'loss', -2),
      namedMatch(2, 'original', 'win', 10),
      namedMatch(3, 'final', 'loss', -5),
      namedMatch(3, 'original', 'win', 9),
      namedMatch(4, 'final', 'loss', -3),
      namedMatch(4, 'original', 'win', 11),
      namedMatch(5, 'final', 'loss', -4),
      namedMatch(5, 'original', 'win', 12),
      namedMatch(6, 'final', 'loss', -2),
      namedMatch(6, 'original', 'win', 8),
    ]
    const paired = buildPairedComparison(strong)
    expect(
      classifyTurn10(
        aggregateActionMatches(strong.filter((row) => row.actionName === 'final')),
        aggregateActionMatches(strong.filter((row) => row.actionName === 'original')),
        paired.summary,
      ),
    ).toBe('possible-tactical-regression')
    const same = strong.slice(0, 2)
    expect(
      classifyTurn10(
        aggregateActionMatches(same),
        aggregateActionMatches(same),
        buildPairedComparison(same).summary,
      ),
    ).toBe('inconclusive')

    const descriptiveOnly = paired.summary
    expect(
      classifyTurn10(
        {
          ...aggregateActionMatches(strong.filter((row) => row.actionName === 'final')),
          winRate: 0.45,
        },
        {
          ...aggregateActionMatches(strong.filter((row) => row.actionName === 'original')),
          winRate: 0.55,
        },
        {
          ...descriptiveOnly,
          originalPreferred: 11,
          finalPreferred: 9,
          averageTerritoryDelta: 2.55,
          bootstrapMeanCI95: { low: -5.15, high: 9.85, iterations: 10_000, seed: 710_010 },
          signTest: { positive: 11, negative: 9, tiesExcluded: 0, pValue: 0.8238 },
        },
      ),
    ).toBe('inconclusive')
  })

  it('persiste cada par, reanuda y no duplica partidas', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'turn10-resume-'))
    const calls: Array<{ seed: number; key: string }> = []
    await confirmHumanMCTSTurn10(FIXTURE, {
      outputDir,
      seeds: [11, 12],
      runMatch: fakeRunner(calls) as never,
      now: () => 100,
    })
    expect(calls).toHaveLength(4)
    await confirmHumanMCTSTurn10(FIXTURE, {
      outputDir,
      seeds: [11, 12],
      runMatch: fakeRunner(calls) as never,
      now: () => 100,
    })
    expect(calls).toHaveLength(4)
    const progress = loadProgress(outputDir, [11, 12])
    expect(progress.completedSeeds).toEqual([11, 12])
    expect(progress.matches).toHaveLength(4)
  })

  it('conserva progreso parcial al abortar limpiamente', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'turn10-partial-'))
    let stop = false
    const result = await confirmHumanMCTSTurn10(FIXTURE, {
      outputDir,
      seeds: [21, 22],
      runMatch: fakeRunner([]) as never,
      now: () => 100,
      shouldAbort: () => stop,
      onProgress: () => {
        stop = true
      },
    })
    expect(result.progress.complete).toBe(false)
    expect(result.progress.completedSeeds).toEqual([21])
    expect(
      JSON.parse(readFileSync(path.join(outputDir, 'progress.json'), 'utf8')).matches,
    ).toHaveLength(2)
  })
})
