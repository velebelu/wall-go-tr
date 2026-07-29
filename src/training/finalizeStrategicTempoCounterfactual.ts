import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createPlayableMCTSRng } from '@/agents/mctsWorkerDecision'

const root = resolve('data/diagnostics/strategic-tempo-v1')
const counterfactualRoot = resolve(root, 'counterfactual')
const report = JSON.parse(
  await readFile(resolve(counterfactualRoot, 'aggregate-report.json'), 'utf8'),
)
const individual = JSON.parse(
  await readFile(resolve(counterfactualRoot, 'individual-results.json'), 'utf8'),
) as Array<{ experiment: string; turns: number }>
const thresholds = JSON.parse(
  await readFile(resolve(counterfactualRoot, 'threshold-activation.json'), 'utf8'),
) as {
  rows: Array<{
    fixture: string
    variant: string
    selectedAction: unknown
  }>
}
const diagnostic = JSON.parse(await readFile(resolve(root, 'diagnostic-report.json'), 'utf8')) as {
  cases: Array<{ id: string; analysis: { classification: string } }>
}

const fixtureReports = report.fixtures as Array<{
  fixture: string
  originalAction: unknown
  actions: Array<{ label: string; action: unknown }>
  singleIntervention: Record<string, unknown>
}>
const fixtureValues = await Promise.all(
  fixtureReports.map(async (fixtureReport) => ({
    fixtureReport,
    fixture: JSON.parse(
      await readFile(resolve(root, 'fixtures', fixtureReport.fixture), 'utf8'),
    ) as {
      mcts: { rootCandidates: Array<{ action: unknown; visits: number; value: number }> }
    },
  })),
)
for (const { fixtureReport, fixture } of fixtureValues) {
  const conservativeAction = thresholds.rows.find(
    (row) => row.fixture === fixtureReport.fixture && row.variant === 'value-0.025-visits-0.15',
  )!.selectedAction
  const ranked = [...fixture.mcts.rootCandidates].sort(
    (left, right) => right.visits - left.visits || right.value - left.value,
  )
  const visitControl =
    ranked.find((candidate) => !sameAction(candidate.action, fixtureReport.originalAction))
      ?.action ?? fixtureReport.originalAction
  for (const [label, action] of [
    ['conservative-tiebreak', conservativeAction],
    ['visit-control', visitControl],
  ] as const) {
    const canonical = fixtureReport.actions.find((entry) => sameAction(entry.action, action))
    if (canonical && fixtureReport.singleIntervention[canonical.label])
      fixtureReport.singleIntervention[label] = fixtureReport.singleIntervention[canonical.label]
    if (!fixtureReport.actions.some((entry) => entry.label === label))
      fixtureReport.actions.push({ label, action })
  }
}

const persistentEffects = report.fixtures.flatMap(
  (fixture: { persistentPolicy: { pairedEffects: number[] } }) =>
    fixture.persistentPolicy.pairedEffects,
)
const persistentActivations = report.fixtures.reduce(
  (sum: number, fixture: { persistentPolicy: { tiebreakActivations: number } }) =>
    sum + fixture.persistentPolicy.tiebreakActivations,
  0,
)
const persistentAiDecisions = individual
  .filter((row) => row.experiment === 'persistent-policy')
  .reduce((sum, row) => sum + Math.floor(row.turns / 2), 0)
report.persistentAggregate = {
  meanEffect: mean(persistentEffects),
  medianEffect: median(persistentEffects),
  bootstrap95: bootstrapMeanInterval(persistentEffects, 10_000, 0x20260730),
  activations: persistentActivations,
  aiDecisions: persistentAiDecisions,
  interventionFrequency: persistentAiDecisions ? persistentActivations / persistentAiDecisions : 0,
}
report.recommendation =
  report.persistentAggregate.meanEffect < 0 &&
  report.persistentAggregate.interventionFrequency > 0.2
    ? 'reject-tested-tiebreak-family'
    : report.aggregate.bootstrap95[0] > 0
      ? 'prepare-preliminary-competitive-validation'
      : 'expand-counterfactual-sample'
report.competitiveEvaluationExecuted = false

const evaluated = new Map(
  report.fixtures.map((fixture: { fixture: string }) => [
    fixture.fixture.replace('.fixture.json', ''),
    fixture,
  ]),
)
const reclassification = diagnostic.cases.map((entry) => {
  const fixture = evaluated.get(entry.id) as
    | {
        singleIntervention: Record<
          string,
          { effectClassification: string; meanEffect: number; bootstrap95: [number, number] }
        >
      }
    | undefined
  const alternative = fixture?.singleIntervention['immediate-progress']
  return {
    id: entry.id,
    evaluated: fixture !== undefined,
    previous: entry.analysis.classification,
    revised: !alternative
      ? entry.analysis.classification
      : alternative.effectClassification === 'beneficial'
        ? 'redundant'
        : alternative.effectClassification === 'harmful'
          ? entry.analysis.classification
          : 'ambiguous',
    evidence: alternative?.effectClassification ?? 'not-counterfactually-evaluated',
    meanEffect: alternative?.meanEffect,
    bootstrap95: alternative?.bootstrap95,
  }
})

await writeFile(
  resolve(counterfactualRoot, 'aggregate-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
)
await writeFile(
  resolve(counterfactualRoot, 'reclassification.json'),
  `${JSON.stringify(reclassification, null, 2)}\n`,
)
console.log(
  JSON.stringify(
    {
      recommendation: report.recommendation,
      persistentAggregate: report.persistentAggregate,
      reclassifiedCases: reclassification.length,
    },
    null,
    2,
  ),
)

function bootstrapMeanInterval(values: number[], samples: number, seed: number): [number, number] {
  if (!values.length) return [0, 0]
  const rng = createPlayableMCTSRng(seed)
  const means = Array.from({ length: samples }, () => {
    let sum = 0
    for (let index = 0; index < values.length; index++)
      sum += values[Math.floor(rng() * values.length)]!
    return sum / values.length
  }).sort((left, right) => left - right)
  return [
    means[Math.floor(samples * 0.025)]!,
    means[Math.min(samples - 1, Math.floor(samples * 0.975))]!,
  ]
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function sameAction(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
