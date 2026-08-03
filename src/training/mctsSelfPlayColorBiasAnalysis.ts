import {
  SELF_PLAY_EXPERIMENT_ID,
  SELF_PLAY_GAME_COUNT,
  SELF_PLAY_PAIR_COUNT,
  SELF_PLAY_SEED_RULE,
  type SelfPlayGameResult,
  type SelfPlayTerminationReason,
} from '@/experiments/mctsSelfPlayColorBias'
import {
  bootstrapMeanCI95,
  classifyEffectSize,
  cohensD,
  cohensH,
  designEffect,
  exactTwoSidedSignTest,
  intraclassCorrelation,
  mean,
  median,
  oneSampleMeanZTest,
  round4,
  sampleStandardDeviation,
  wilcoxonSignedRankTest,
  wilson95,
} from './mctsSelfPlayStatistics'

export const SELF_PLAY_SUMMARY_SCHEMA = 'MCTSSelfPlayColorBiasSummaryV1'
export const SELF_PLAY_BOOTSTRAP_ITERATIONS = 10_000
export const SELF_PLAY_BOOTSTRAP_SEED = 2_026_080_301
export const SELF_PLAY_ALPHA = 0.05

export interface SelfPlayPairRow {
  pairNumber: number
  directGameId: string
  swappedGameId: string
  alphaSeedBase: number
  betaSeedBase: number
  directWinner: string
  swappedWinner: string
  pairRedScore: number
  pairAlphaScore: number
  directTerritoryDiff: number
  swappedTerritoryDiff: number
  pairTerritoryDiff: number
  colourWinnerAgreement: 'same-colour-twice' | 'split-between-colours' | 'involves-tie'
  streamWinnerAgreement: 'same-stream-twice' | 'split-between-streams' | 'involves-tie'
  directDecisions: number
  swappedDecisions: number
}

export function buildSelfPlayPairRows(results: readonly SelfPlayGameResult[]): SelfPlayPairRow[] {
  // Array.from, not iterator spread: see the note in mctsSelfPlayColorBias.ts.
  const pairNumbers = Array.from(new Set(results.map((row) => row.pairNumber))).sort(
    (a, b) => a - b,
  )
  return pairNumbers.map((pairNumber) => {
    const direct = results.find(
      (row) => row.pairNumber === pairNumber && row.orientation === 'direct',
    )
    const swapped = results.find(
      (row) => row.pairNumber === pairNumber && row.orientation === 'swapped',
    )
    if (!direct || !swapped) throw new Error(`Incomplete pair ${pairNumber}`)
    // The alpha stream plays red in the direct game and blue in the swapped game.
    const alphaScores = [direct.redScore, 1 - swapped.redScore]
    const involvesTie = direct.tie || swapped.tie
    return {
      pairNumber,
      directGameId: direct.gameId,
      swappedGameId: swapped.gameId,
      alphaSeedBase: direct.alphaSeedBase,
      betaSeedBase: direct.betaSeedBase,
      directWinner: direct.winner,
      swappedWinner: swapped.winner,
      pairRedScore: round4((direct.redScore + swapped.redScore) / 2),
      pairAlphaScore: round4(mean(alphaScores)),
      directTerritoryDiff: direct.territoryDiff,
      swappedTerritoryDiff: swapped.territoryDiff,
      pairTerritoryDiff: round4((direct.territoryDiff + swapped.territoryDiff) / 2),
      colourWinnerAgreement: involvesTie
        ? 'involves-tie'
        : direct.winner === swapped.winner
          ? 'same-colour-twice'
          : 'split-between-colours',
      streamWinnerAgreement: involvesTie
        ? 'involves-tie'
        : // Alpha wins the direct game as red and the swapped game as blue.
          (direct.winner === 'R') === (swapped.winner === 'B')
          ? 'same-stream-twice'
          : 'split-between-streams',
      directDecisions: direct.totalDecisions,
      swappedDecisions: swapped.totalDecisions,
    }
  })
}

function countBy<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(
    keys.map((key) => [key, values.filter((value) => value === key).length]),
  ) as Record<T, number>
}

function describe(values: readonly number[]) {
  return {
    n: values.length,
    mean: round4(mean(values)),
    median: round4(median(values)),
    standardDeviation: round4(sampleStandardDeviation(values)),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
  }
}

function excludesNull(interval: { low: number; high: number }, nullValue: number): boolean {
  return nullValue < interval.low || nullValue > interval.high
}

export interface SelfPlaySummaryOptions {
  generatedAt?: string
  expectedGames?: number
  expectedPairs?: number
}

export function summarizeSelfPlayColorBias(
  results: readonly SelfPlayGameResult[],
  options: SelfPlaySummaryOptions = {},
) {
  if (!results.length) throw new Error('Cannot summarize an empty result set')
  const ordered = [...results].sort((left, right) => left.gameNumber - right.gameNumber)
  const pairs = buildSelfPlayPairRows(ordered)

  const redWins = ordered.filter((row) => row.winner === 'R').length
  const blueWins = ordered.filter((row) => row.winner === 'B').length
  const ties = ordered.filter((row) => row.tie).length
  const decisive = redWins + blueWins
  const territoryDiffs = ordered.map((row) => row.territoryDiff)

  const pairRedScores = pairs.map((row) => row.pairRedScore)
  const pairAlphaScores = pairs.map((row) => row.pairAlphaScore)
  const pairTerritoryDiffs = pairs.map((row) => row.pairTerritoryDiff)

  const redScoreCI = bootstrapMeanCI95(
    pairRedScores,
    SELF_PLAY_BOOTSTRAP_ITERATIONS,
    SELF_PLAY_BOOTSTRAP_SEED,
  )
  const territoryCI = bootstrapMeanCI95(
    pairTerritoryDiffs,
    SELF_PLAY_BOOTSTRAP_ITERATIONS,
    SELF_PLAY_BOOTSTRAP_SEED + 1,
  )
  const alphaScoreCI = bootstrapMeanCI95(
    pairAlphaScores,
    SELF_PLAY_BOOTSTRAP_ITERATIONS,
    SELF_PLAY_BOOTSTRAP_SEED + 2,
  )

  const redScoreWilcoxon = wilcoxonSignedRankTest(pairRedScores, 0.5)
  const redScoreZ = oneSampleMeanZTest(pairRedScores, 0.5)
  const territoryWilcoxon = wilcoxonSignedRankTest(pairTerritoryDiffs, 0)
  const territoryZ = oneSampleMeanZTest(pairTerritoryDiffs, 0)
  const signTest = exactTwoSidedSignTest(redWins, blueWins)

  const icc = intraclassCorrelation(
    pairs.map((row) => {
      const direct = ordered.find((game) => game.gameId === row.directGameId)!
      const swapped = ordered.find((game) => game.gameId === row.swappedGameId)!
      return [direct.redScore, swapped.redScore]
    }),
  )

  const colourEffectDetected =
    excludesNull(redScoreCI, 0.5) ||
    redScoreWilcoxon.pValue < SELF_PLAY_ALPHA ||
    signTest.pValue < SELF_PLAY_ALPHA
  const territoryEffectDetected =
    excludesNull(territoryCI, 0) || territoryWilcoxon.pValue < SELF_PLAY_ALPHA
  const streamEffectDetected = excludesNull(alphaScoreCI, 0.5)

  const colourEffectSize = cohensD(pairRedScores, 0.5)
  const territoryEffectSize = cohensD(pairTerritoryDiffs, 0)

  const meanOf = (selector: (row: SelfPlayGameResult) => number) =>
    round4(mean(ordered.map(selector)))

  return {
    schema: SELF_PLAY_SUMMARY_SCHEMA,
    experimentId: SELF_PLAY_EXPERIMENT_ID,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    implementationCommit: ordered[0]!.implementationCommit,
    configSha256: ordered[0]!.configSha256,
    complete:
      ordered.length === (options.expectedGames ?? SELF_PLAY_GAME_COUNT) &&
      pairs.length === (options.expectedPairs ?? SELF_PLAY_PAIR_COUNT),
    design: {
      games: ordered.length,
      pairs: pairs.length,
      analysisUnit: 'pair',
      pairingRule:
        'Each pair plays the same two seed streams twice with the colours of the streams swapped.',
      seedRule: SELF_PLAY_SEED_RULE,
      firstActionColor: ordered[0]!.firstActionColor,
      colourAndFirstMoveConfounded: ordered.every((row) => row.firstActionColor === 'R'),
    },
    outcomes: {
      games: ordered.length,
      redWins,
      blueWins,
      ties,
      decisiveGames: decisive,
      redWinPercentage: round4((100 * redWins) / ordered.length),
      blueWinPercentage: round4((100 * blueWins) / ordered.length),
      tiePercentage: round4((100 * ties) / ordered.length),
      redWinPercentageAmongDecisive: decisive ? round4((100 * redWins) / decisive) : 0,
      meanRedScore: round4(mean(ordered.map((row) => row.redScore))),
    },
    territory: {
      meanRed: meanOf((row) => row.territoryRed),
      meanBlue: meanOf((row) => row.territoryBlue),
      diff: describe(territoryDiffs),
    },
    turns: {
      meanTotalDecisions: meanOf((row) => row.totalDecisions),
      medianTotalDecisions: round4(median(ordered.map((row) => row.totalDecisions))),
      meanRedDecisions: meanOf((row) => row.redDecisions),
      meanBlueDecisions: meanOf((row) => row.blueDecisions),
    },
    actions: {
      meanRedMoves: meanOf((row) => row.redActions.moves),
      meanBlueMoves: meanOf((row) => row.blueActions.moves),
      meanRedWalls: meanOf((row) => row.redActions.walls),
      meanBlueWalls: meanOf((row) => row.blueActions.walls),
      meanRedPlacements: meanOf((row) => row.redActions.placements),
      meanBluePlacements: meanOf((row) => row.blueActions.placements),
    },
    duration: {
      meanMs: meanOf((row) => row.durationMs),
      medianMs: round4(median(ordered.map((row) => row.durationMs))),
      totalMs: round4(ordered.reduce((sum, row) => sum + row.durationMs, 0)),
    },
    termination: countBy(
      ordered.map((row) => row.terminationReason),
      [
        'all-territory-closed',
        'all-players-blocked',
        'no-legal-actions',
        'safety-limit',
      ] as SelfPlayTerminationReason[],
    ),
    searchDiagnostics: {
      decisions: ordered.reduce((sum, row) => sum + row.totalDecisions, 0),
      stoppedByTimeLimit: ordered.reduce((sum, row) => sum + row.diagnostics.stoppedByTimeLimit, 0),
      expandedTo500: ordered.reduce((sum, row) => sum + row.diagnostics.expandedTo500, 0),
      tacticalChanged: ordered.reduce((sum, row) => sum + row.diagnostics.tacticalChanged, 0),
      meanSimulationsPerDecision: round4(
        ordered.reduce((sum, row) => sum + row.diagnostics.totalSimulations, 0) /
          Math.max(
            1,
            ordered.reduce((sum, row) => sum + row.totalDecisions, 0),
          ),
      ),
    },
    pairAnalysis: {
      pairs: pairs.length,
      redScore: describe(pairRedScores),
      alphaStreamScore: describe(pairAlphaScores),
      territoryDiff: describe(pairTerritoryDiffs),
      colourWinnerAgreement: countBy(
        pairs.map((row) => row.colourWinnerAgreement),
        ['same-colour-twice', 'split-between-colours', 'involves-tie'] as const,
      ),
      streamWinnerAgreement: countBy(
        pairs.map((row) => row.streamWinnerAgreement),
        ['same-stream-twice', 'split-between-streams', 'involves-tie'] as const,
      ),
    },
    inference: {
      analysisUnit: 'pair',
      alpha: SELF_PLAY_ALPHA,
      rationale:
        'The two games of a pair share their seed streams, so they are not guaranteed to be ' +
        'independent. The 100 pairs are the independent units, and every primary test is run ' +
        'on pair-level values. The game-level binomial test is reported only as a sensitivity ' +
        'analysis, together with the measured intra-pair correlation that justifies it.',
      primaryColourTest: {
        name: 'Cluster (pair) bootstrap of the mean pair red score against 0.5',
        iterations: redScoreCI.iterations,
        seed: redScoreCI.seed,
        mean: round4(mean(pairRedScores)),
        ci95: { low: redScoreCI.low, high: redScoreCI.high },
        excludesNull: excludesNull(redScoreCI, 0.5),
      },
      colourWilcoxon: redScoreWilcoxon,
      colourZTest: redScoreZ,
      primaryTerritoryTest: {
        name: 'Cluster (pair) bootstrap of the mean pair territory difference against 0',
        iterations: territoryCI.iterations,
        seed: territoryCI.seed,
        mean: round4(mean(pairTerritoryDiffs)),
        ci95: { low: territoryCI.low, high: territoryCI.high },
        excludesNull: excludesNull(territoryCI, 0),
      },
      territoryWilcoxon,
      territoryZTest: territoryZ,
      seedStreamControl: {
        name: 'Cluster (pair) bootstrap of the mean alpha-stream score against 0.5',
        purpose:
          'Negative control. The colour contrast and the stream contrast are orthogonal in ' +
          'this design, so a stream effect would point at seed luck instead of colour.',
        mean: round4(mean(pairAlphaScores)),
        ci95: { low: alphaScoreCI.low, high: alphaScoreCI.high },
        excludesNull: streamEffectDetected,
      },
      sensitivityGameLevel: {
        name: 'Exact two-sided sign (binomial) test on decisive games, assumes independence',
        redWins,
        blueWins,
        tiesExcluded: ties,
        pValue: signTest.pValue,
        wilson95RedWinPercentage: wilson95(redWins, ordered.length),
      },
      dependence: {
        intraPairCorrelation: icc,
        clusterSize: 2,
        designEffect: designEffect(icc, 2),
        note:
          'A design effect near 1 means the pair structure barely changes the effective sample ' +
          'size, so the game-level test and the pair-level tests should agree.',
      },
    },
    effectSizes: {
      colourCohensH: cohensH(redWins / ordered.length, 0.5),
      colourCohensHAmongDecisive: decisive ? cohensH(redWins / decisive, 0.5) : 0,
      colourCohensD: colourEffectSize,
      colourCohensDLabel: classifyEffectSize(colourEffectSize),
      territoryCohensD: territoryEffectSize,
      territoryCohensDLabel: classifyEffectSize(territoryEffectSize),
      colourRankBiserial: redScoreWilcoxon.rankBiserialCorrelation,
      territoryRankBiserial: territoryWilcoxon.rankBiserialCorrelation,
    },
    findings: {
      colourEffectDetected,
      territoryEffectDetected,
      seedStreamEffectDetected: streamEffectDetected,
      direction: colourEffectDetected
        ? mean(pairRedScores) > 0.5
          ? 'favours-red'
          : 'favours-blue'
        : 'none',
    },
  }
}

export type SelfPlayColorBiasSummary = ReturnType<typeof summarizeSelfPlayColorBias>
