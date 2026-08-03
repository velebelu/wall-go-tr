/**
 * Statistical primitives for the MCTS self-play colour-bias experiment.
 *
 * The reusable helpers already validated by earlier evaluations (`bootstrapMeanCI95`,
 * `exactTwoSidedSignTest`, `wilson95`) are re-exported instead of duplicated. Applied to the
 * 100 pair-level values, `bootstrapMeanCI95` is exactly a cluster bootstrap over the
 * independent units of this design, because clusters have a constant size of two and the mean
 * of the pair means equals the overall mean.
 */
export { bootstrapMeanCI95, exactTwoSidedSignTest } from './confirmHumanMCTSTurn10'
export { wilson95 } from './evaluateMCTSTacticalConfirmation'

export function round4(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : 0
}

export function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0
  const average = mean(values)
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
  )
}

/** Zelen & Severo rational approximation (A&S 26.2.17); absolute error below 7.5e-8. */
export function standardNormalCdf(z: number): number {
  const coefficients = [0.31938153, -0.356563782, 1.781477937, -1.821255978, 1.330274429]
  const x = Math.abs(z)
  const t = 1 / (1 + 0.2316419 * x)
  let polynomial = 0
  for (let index = coefficients.length - 1; index >= 0; index--)
    polynomial = (polynomial + coefficients[index]!) * t
  const upperTail = 0.3989422804014327 * Math.exp(-0.5 * x * x) * polynomial
  return z >= 0 ? 1 - upperTail : upperTail
}

export function normalTwoSidedPValue(z: number): number {
  if (!Number.isFinite(z)) return 1
  return Math.min(1, 2 * (1 - standardNormalCdf(Math.abs(z))))
}

export interface OneSampleMeanTest {
  n: number
  mean: number
  standardDeviation: number
  standardError: number
  z: number
  pValue: number
}

/** Two-sided z-test on the mean of independent cluster-level values (n = 100 here). */
export function oneSampleMeanZTest(values: readonly number[], mu = 0): OneSampleMeanTest {
  const n = values.length
  const average = mean(values)
  const standardDeviation = sampleStandardDeviation(values)
  const standardError = n ? standardDeviation / Math.sqrt(n) : 0
  const z = standardError > 0 ? (average - mu) / standardError : 0
  return {
    n,
    mean: round4(average),
    standardDeviation: round4(standardDeviation),
    standardError: round4(standardError),
    z: round4(z),
    pValue: round4(normalTwoSidedPValue(z)),
  }
}

export interface WilcoxonSignedRankTest {
  n: number
  nonZero: number
  zeroDifferences: number
  wPlus: number
  wMinus: number
  z: number
  pValue: number
  rankBiserialCorrelation: number
}

/**
 * Two-sided Wilcoxon signed-rank test with average ranks for ties, the standard tie
 * correction of the variance and a continuity correction. The normal approximation is
 * appropriate for the 100 pairs of this design.
 */
export function wilcoxonSignedRankTest(values: readonly number[], mu = 0): WilcoxonSignedRankTest {
  const differences = values.map((value) => value - mu)
  const nonZeroDifferences = differences.filter((value) => value !== 0)
  const n = nonZeroDifferences.length
  const empty: WilcoxonSignedRankTest = {
    n: values.length,
    nonZero: n,
    zeroDifferences: differences.length - n,
    wPlus: 0,
    wMinus: 0,
    z: 0,
    pValue: 1,
    rankBiserialCorrelation: 0,
  }
  if (n === 0) return empty

  const ordered = nonZeroDifferences
    .map((value, index) => ({ value, index, magnitude: Math.abs(value) }))
    .sort((left, right) => left.magnitude - right.magnitude)
  const ranks = new Array<number>(n).fill(0)
  const tieGroupSizes: number[] = []
  for (let start = 0; start < n; ) {
    let end = start
    while (end + 1 < n && ordered[end + 1]!.magnitude === ordered[start]!.magnitude) end++
    const averageRank = (start + end + 2) / 2
    for (let index = start; index <= end; index++) ranks[ordered[index]!.index] = averageRank
    tieGroupSizes.push(end - start + 1)
    start = end + 1
  }

  let wPlus = 0
  let wMinus = 0
  nonZeroDifferences.forEach((value, index) => {
    if (value > 0) wPlus += ranks[index]!
    else wMinus += ranks[index]!
  })

  const expected = (n * (n + 1)) / 4
  const tieCorrection = tieGroupSizes.reduce((sum, size) => sum + (size ** 3 - size), 0)
  const variance = (n * (n + 1) * (2 * n + 1) - tieCorrection / 2) / 24
  const deviation = wPlus - expected
  const continuity = deviation === 0 ? 0 : Math.sign(deviation) * 0.5
  const z = variance > 0 ? (deviation - continuity) / Math.sqrt(variance) : 0
  return {
    n: values.length,
    nonZero: n,
    zeroDifferences: differences.length - n,
    wPlus: round4(wPlus),
    wMinus: round4(wMinus),
    z: round4(z),
    pValue: round4(normalTwoSidedPValue(z)),
    rankBiserialCorrelation: round4((wPlus - wMinus) / ((n * (n + 1)) / 2)),
  }
}

/**
 * One-way random-effects intraclass correlation for clusters of constant size. It quantifies
 * how much the two games of a pair resemble each other, which is what decides whether a
 * game-level binomial test would be anticonservative.
 */
export function intraclassCorrelation(clusters: readonly (readonly number[])[]): number {
  const usable = clusters.filter((cluster) => cluster.length > 1)
  if (usable.length < 2) return 0
  const size = usable[0]!.length
  if (usable.some((cluster) => cluster.length !== size)) throw new Error('Clusters must be equal')
  const grandMean = mean(usable.flatMap((cluster) => [...cluster]))
  const betweenSum = usable.reduce((sum, cluster) => sum + (mean(cluster) - grandMean) ** 2, 0)
  const withinSum = usable.reduce(
    (sum, cluster) =>
      sum + cluster.reduce((inner, value) => inner + (value - mean(cluster)) ** 2, 0),
    0,
  )
  const betweenMeanSquare = (size * betweenSum) / (usable.length - 1)
  const withinMeanSquare = withinSum / (usable.length * (size - 1))
  const denominator = betweenMeanSquare + (size - 1) * withinMeanSquare
  if (denominator === 0) return 0
  return round4((betweenMeanSquare - withinMeanSquare) / denominator)
}

export function designEffect(icc: number, clusterSize: number): number {
  return round4(1 + (clusterSize - 1) * icc)
}

/** Cohen's h for a proportion against a reference proportion. */
export function cohensH(proportion: number, reference = 0.5): number {
  const transform = (value: number) => 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, value))))
  return round4(transform(proportion) - transform(reference))
}

/** One-sample Cohen's d against a reference value. */
export function cohensD(values: readonly number[], mu = 0): number {
  const standardDeviation = sampleStandardDeviation(values)
  if (standardDeviation === 0) return 0
  return round4((mean(values) - mu) / standardDeviation)
}

export type EffectSizeLabel = 'negligible' | 'small' | 'medium' | 'large'

/** Conventional Cohen thresholds, used only to word the interpretation prudently. */
export function classifyEffectSize(magnitude: number): EffectSizeLabel {
  const value = Math.abs(magnitude)
  if (value < 0.2) return 'negligible'
  if (value < 0.5) return 'small'
  if (value < 0.8) return 'medium'
  return 'large'
}
