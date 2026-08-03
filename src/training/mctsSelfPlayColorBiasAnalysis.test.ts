import { describe, expect, it } from 'vitest'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import {
  buildSelfPlayPlan,
  scoreForRed,
  type SelfPlayGameResult,
  type SelfPlayWinner,
} from '@/experiments/mctsSelfPlayColorBias'
import { buildSelfPlayPairRows, summarizeSelfPlayColorBias } from './mctsSelfPlayColorBiasAnalysis'

const COMMIT = 'f'.repeat(40)

/** Builds a synthetic but structurally valid result set from a list of winners. */
function syntheticResults(
  winners: readonly SelfPlayWinner[],
  territoryDiffs?: readonly number[],
): SelfPlayGameResult[] {
  const plan = buildSelfPlayPlan(winners.length / 2)
  return plan.map((planned, index) => {
    const winner = winners[index]!
    const diff = territoryDiffs?.[index] ?? (winner === 'R' ? 6 : winner === 'B' ? -6 : 0)
    const territoryRed = 20 + Math.max(0, diff)
    const territoryBlue = territoryRed - diff
    return {
      ...planned,
      schema: 'MCTSSelfPlayColorBiasV1',
      experimentId: 'WGTR-MCTS-SELFPLAY-COLOR-BIAS-2026-V1',
      implementationCommit: COMMIT,
      configSha256: 'hash',
      redConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
      blueConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
      configsIdentical: true,
      firstActionColor: 'R',
      winner,
      tie: winner === 'tie',
      territoryRed,
      territoryBlue,
      territoryDiff: diff,
      redScore: scoreForRed(winner),
      totalDecisions: 50,
      redDecisions: 25,
      blueDecisions: 25,
      redSeedCount: 25,
      blueSeedCount: 25,
      redActions: { placements: 2, moves: 20, walls: 23 },
      blueActions: { placements: 2, moves: 19, walls: 23 },
      terminationReason: 'all-territory-closed',
      terminal: true,
      durationMs: 1_000,
      diagnostics: {
        expandedTo500: 3,
        stoppedByTimeLimit: 0,
        tacticalChanged: 1,
        totalSimulations: 50 * 250,
      },
      actions: [],
      actionSequenceSha256: `actions-${planned.gameId}`,
      outcomeSha256: `outcome-${planned.gameId}`,
      reproducible: true,
      virtualClock: true,
      latencyGuardDisabled: true,
      startedAt: '2026-08-03T00:00:00.000Z',
      finishedAt: '2026-08-03T00:01:00.000Z',
    } satisfies SelfPlayGameResult
  })
}

function alternating(pairs: number, pattern: readonly SelfPlayWinner[]): SelfPlayWinner[] {
  return Array.from({ length: pairs }, (_, index) => [
    pattern[(index * 2) % pattern.length]!,
    pattern[(index * 2 + 1) % pattern.length]!,
  ]).flat()
}

describe('construcción de las parejas', () => {
  it('empareja cada partida directa con su intercambiada', () => {
    const rows = buildSelfPlayPairRows(syntheticResults(['R', 'B', 'R', 'R']))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      pairNumber: 1,
      directWinner: 'R',
      swappedWinner: 'B',
      pairRedScore: 0.5,
      colourWinnerAgreement: 'split-between-colours',
      streamWinnerAgreement: 'same-stream-twice',
    })
    expect(rows[1]).toMatchObject({
      pairNumber: 2,
      pairRedScore: 1,
      colourWinnerAgreement: 'same-colour-twice',
      streamWinnerAgreement: 'split-between-streams',
    })
  })

  it('separa el contraste de color del contraste de flujo de semillas', () => {
    // Rojo gana las dos partidas: el color puntúa 1 y los flujos quedan empatados a 0,5.
    const [pair] = buildSelfPlayPairRows(syntheticResults(['R', 'R']))
    expect(pair!.pairRedScore).toBe(1)
    expect(pair!.pairAlphaScore).toBe(0.5)
    // El flujo alfa gana las dos: el color queda a 0,5 y el flujo puntúa 1.
    const [streamPair] = buildSelfPlayPairRows(syntheticResults(['R', 'B']))
    expect(streamPair!.pairRedScore).toBe(0.5)
    expect(streamPair!.pairAlphaScore).toBe(1)
  })

  it('marca las parejas con empate', () => {
    const [pair] = buildSelfPlayPairRows(syntheticResults(['tie', 'R']))
    expect(pair!.colourWinnerAgreement).toBe('involves-tie')
    expect(pair!.streamWinnerAgreement).toBe('involves-tie')
    expect(pair!.pairRedScore).toBe(0.75)
  })

  it('rechaza una pareja incompleta', () => {
    expect(() => buildSelfPlayPairRows(syntheticResults(['R', 'B']).slice(0, 1))).toThrow(
      /Incomplete pair/,
    )
  })
})

describe('agregación de resultados', () => {
  it('cuenta victorias, empates y porcentajes', () => {
    const winners = alternating(50, ['R', 'B', 'R', 'tie'])
    const summary = summarizeSelfPlayColorBias(syntheticResults(winners), {
      generatedAt: '2026-08-03T00:00:00.000Z',
      expectedGames: 100,
      expectedPairs: 50,
    })
    expect(summary.outcomes.games).toBe(100)
    expect(summary.outcomes.redWins).toBe(50)
    expect(summary.outcomes.blueWins).toBe(25)
    expect(summary.outcomes.ties).toBe(25)
    expect(summary.outcomes.redWinPercentage).toBe(50)
    expect(summary.outcomes.tiePercentage).toBe(25)
    expect(summary.outcomes.decisiveGames).toBe(75)
    expect(summary.pairAnalysis.pairs).toBe(50)
    expect(summary.complete).toBe(true)
  })

  it('promedia territorio, turnos, acciones y duración', () => {
    const summary = summarizeSelfPlayColorBias(
      syntheticResults(['R', 'B', 'R', 'B'], [10, -6, 4, -8]),
      { generatedAt: '2026-08-03T00:00:00.000Z', expectedGames: 4, expectedPairs: 2 },
    )
    expect(summary.territory.diff.mean).toBe(0)
    expect(summary.territory.diff.median).toBe(-1)
    expect(summary.territory.diff.min).toBe(-8)
    expect(summary.territory.diff.max).toBe(10)
    expect(summary.turns.meanTotalDecisions).toBe(50)
    expect(summary.actions.meanRedWalls).toBe(23)
    expect(summary.actions.meanBlueMoves).toBe(19)
    expect(summary.duration.meanMs).toBe(1_000)
    expect(summary.termination['all-territory-closed']).toBe(4)
    expect(summary.searchDiagnostics.stoppedByTimeLimit).toBe(0)
  })

  it('no detecta sesgo cuando el reparto es perfectamente equilibrado', () => {
    const summary = summarizeSelfPlayColorBias(syntheticResults(alternating(50, ['R', 'B'])), {
      generatedAt: '2026-08-03T00:00:00.000Z',
      expectedGames: 100,
      expectedPairs: 50,
    })
    expect(summary.outcomes.redWins).toBe(50)
    expect(summary.outcomes.blueWins).toBe(50)
    expect(summary.inference.primaryColourTest.mean).toBe(0.5)
    expect(summary.inference.primaryColourTest.excludesNull).toBe(false)
    expect(summary.inference.sensitivityGameLevel.pValue).toBe(1)
    expect(summary.findings.colourEffectDetected).toBe(false)
    expect(summary.findings.direction).toBe('none')
    expect(summary.effectSizes.colourCohensH).toBe(0)
  })

  it('detecta un sesgo fuerte a favor de rojo', () => {
    const summary = summarizeSelfPlayColorBias(
      syntheticResults(Array.from({ length: 100 }, () => 'R' as const)),
      { generatedAt: '2026-08-03T00:00:00.000Z', expectedGames: 100, expectedPairs: 50 },
    )
    expect(summary.outcomes.redWins).toBe(100)
    expect(summary.inference.primaryColourTest.excludesNull).toBe(true)
    expect(summary.inference.sensitivityGameLevel.pValue).toBeLessThan(0.001)
    expect(summary.findings.colourEffectDetected).toBe(true)
    expect(summary.findings.direction).toBe('favours-red')
    expect(summary.findings.territoryEffectDetected).toBe(true)
    // Con el color totalmente sesgado, el control de flujos sigue equilibrado.
    expect(summary.inference.seedStreamControl.mean).toBe(0.5)
    expect(summary.findings.seedStreamEffectDetected).toBe(false)
  })

  it('detecta un efecto de flujo de semillas sin efecto de color', () => {
    const summary = summarizeSelfPlayColorBias(syntheticResults(alternating(50, ['R', 'B'])), {
      generatedAt: '2026-08-03T00:00:00.000Z',
      expectedGames: 100,
      expectedPairs: 50,
    })
    // En cada pareja el flujo alfa gana como rojo y como azul.
    expect(summary.inference.seedStreamControl.mean).toBe(1)
    expect(summary.findings.seedStreamEffectDetected).toBe(true)
    expect(summary.findings.colourEffectDetected).toBe(false)
  })

  it('mide la dependencia dentro de las parejas', () => {
    const concordant = summarizeSelfPlayColorBias(
      syntheticResults(alternating(50, ['R', 'R', 'B', 'B'])),
      { generatedAt: '2026-08-03T00:00:00.000Z', expectedGames: 100, expectedPairs: 50 },
    )
    expect(concordant.inference.dependence.intraPairCorrelation).toBeCloseTo(1, 3)
    expect(concordant.inference.dependence.designEffect).toBeCloseTo(2, 3)
    expect(concordant.pairAnalysis.colourWinnerAgreement['same-colour-twice']).toBe(50)
  })

  it('rechaza un conjunto vacío', () => {
    expect(() => summarizeSelfPlayColorBias([])).toThrow(/empty/)
  })
})
