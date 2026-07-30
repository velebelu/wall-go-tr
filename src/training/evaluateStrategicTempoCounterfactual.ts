import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseHumanChallengeMCTSDecision } from '@/agents/humanChallengeMCTS'
import { createPlayableMCTSRng } from '@/agents/mctsWorkerDecision'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { getLegalActions, scoreHeuristicAction } from '@/utils/ai'
import {
  deserializeGameSnapshot,
  type HumanMCTSDecisionDiagnosticsV1,
  type SerializableGameSnapshot,
} from '@/utils/humanMCTSTrace'
import { getTerritoryMap } from '@/utils/territory'
import {
  analyzeStrategicTempoDecision,
  chooseStrategicProgressTiebreak,
  strategicProgressSignal,
  type StrategicProgressTiebreakVariant,
  type StrategicTempoClassification,
} from './strategicTempoDiagnostics'

const root = resolve('data/diagnostics/strategic-tempo-v1')
const counterfactualRoot = resolve(root, 'counterfactual')
const repetitions = Math.max(3, Number(process.env.STRATEGIC_TEMPO_REPETITIONS ?? 3))
const variants: StrategicProgressTiebreakVariant[] = [
  'exact-value',
  'value-0.01',
  'value-0.025',
  'value-0.05',
  'value-0.025-visits-0.15',
  'saturated-equal',
]
const persistentVariant: StrategicProgressTiebreakVariant = 'value-0.025-visits-0.15'

interface Fixture {
  source: { gameId: string; turnIndex: number }
  player: Player
  stateBefore: SerializableGameSnapshot
  legalActions: PlayerAction[]
  action: PlayerAction
  mcts: {
    decisionSeed: number
    rootCandidates: HumanMCTSDecisionDiagnosticsV1['rootCandidates']
    effectiveConfig: HumanMCTSDecisionDiagnosticsV1['effectiveConfig']
  }
  analysis: { classification: StrategicTempoClassification }
}

interface ContinuationResult {
  outcome: 'win' | 'loss' | 'draw'
  ownTerritory: number
  opponentTerritory: number
  territoryDifference: number
  turns: number
  aiDecisions: number
  suspiciousInternalMoves: number
  tiebreakActivations: number
  illegalActions: number
  fallbacks: number
  meanDecisionMs: number
  maxDecisionMs: number
}

interface FixtureReport {
  fixture: string
  gameId: string
  turnIndex: number
  player: Player
  previousClassification: StrategicTempoClassification
  originalAction: PlayerAction
  actions: Array<{ label: string; action: PlayerAction }>
  conservativeChanged: boolean
  singleIntervention: Record<string, ReturnType<typeof summarize>>
  persistentPolicy: ReturnType<typeof summarize>
}

const fixtureNames = (await readdir(resolve(root, 'fixtures')))
  .filter((name) => name.endsWith('.fixture.json'))
  .sort()
const fixtures = await Promise.all(
  fixtureNames.map(async (name) => ({
    name,
    value: JSON.parse(await readFile(resolve(root, 'fixtures', name), 'utf8')) as Fixture,
  })),
)
if (fixtures.length < 13)
  throw new Error(`Expected at least 13 independent fixtures, got ${fixtures.length}`)

const thresholdRows = fixtures.flatMap(({ name, value }) =>
  variants.map((variant) => {
    const selected = chooseStrategicProgressTiebreak({
      state: deserializeGameSnapshot(value.stateBefore),
      original: value.action,
      candidates: value.mcts.rootCandidates,
      variant,
    })
    return {
      fixture: name,
      variant,
      changed: selected.changed,
      eligibleCandidates: selected.eligible,
      reason: selected.reason,
      selectedAction: selected.action,
    }
  }),
)
const thresholdSummary = Object.fromEntries(
  variants.map((variant) => {
    const rows = thresholdRows.filter((row) => row.variant === variant)
    return [
      variant,
      {
        fixtures: rows.length,
        eligibleIn: rows.filter((row) => row.eligibleCandidates > 1).length,
        interventions: rows.filter((row) => row.changed).length,
        interventionFrequency: rows.filter((row) => row.changed).length / rows.length,
      },
    ]
  }),
)
await writeFile(
  resolve(counterfactualRoot, 'threshold-activation.json'),
  `${JSON.stringify({ variants, rows: thresholdRows, summary: thresholdSummary }, null, 2)}\n`,
)

const individualRows: Array<Record<string, unknown>> = []
const fixtureReports: FixtureReport[] = []
for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex++) {
  const { name, value } = fixtures[fixtureIndex]!
  const state = deserializeGameSnapshot(value.stateBefore)
  const rankedByVisits = [...value.mcts.rootCandidates].sort(
    (left, right) => right.visits - left.visits || right.value - left.value,
  )
  const progressRanked = value.mcts.rootCandidates
    .map((candidate) => ({
      action: candidate.action,
      progress: strategicProgressSignal(state, candidate.action),
    }))
    .sort((left, right) => compareKey(right.progress.orderingKey, left.progress.orderingKey))
  const conservative = chooseStrategicProgressTiebreak({
    state,
    original: value.action,
    candidates: value.mcts.rootCandidates,
    variant: persistentVariant,
  })
  const requestedActions = [
    { label: 'original', action: value.action },
    { label: 'immediate-progress', action: progressRanked[0]!.action },
    { label: 'conservative-tiebreak', action: conservative.action },
    {
      label: 'visit-control',
      action:
        rankedByVisits.find((candidate) => !sameAction(candidate.action, value.action))?.action ??
        value.action,
    },
  ]
  const actions = requestedActions.filter(
    (entry, index, all) =>
      all.findIndex((candidate) => sameAction(candidate.action, entry.action)) === index,
  )
  const byAction: Record<string, ContinuationResult[]> = {}
  for (const entry of actions) byAction[entry.label] = []
  const persistent: ContinuationResult[] = []
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const seed = (value.mcts.decisionSeed + Math.imul(repetition + 1, 0x6d2b79f5)) >>> 0
    for (const entry of actions) {
      const result = playContinuation(
        applyFullAction(state, entry.action).state,
        value.player,
        seed,
        false,
      )
      byAction[entry.label]!.push(result)
      individualRows.push({
        fixture: name,
        experiment: 'single-intervention',
        action: entry.label,
        seed,
        ...result,
      })
    }
    const persistentResult = playContinuation(
      applyFullAction(state, conservative.action).state,
      value.player,
      seed,
      true,
    )
    persistent.push(persistentResult)
    individualRows.push({
      fixture: name,
      experiment: 'persistent-policy',
      action: persistentVariant,
      seed,
      ...persistentResult,
    })
  }
  const original = byAction.original!
  const actionReports = Object.fromEntries(
    requestedActions.map((requested) => {
      const canonical = actions.find((entry) => sameAction(entry.action, requested.action))!
      return [
        requested.label,
        summarize(
          byAction[canonical.label]!,
          requested.label === 'original' ? undefined : original,
        ),
      ]
    }),
  )
  fixtureReports.push({
    fixture: name,
    gameId: value.source.gameId,
    turnIndex: value.source.turnIndex,
    player: value.player,
    previousClassification: value.analysis.classification,
    originalAction: value.action,
    actions: requestedActions,
    conservativeChanged: conservative.changed,
    singleIntervention: actionReports,
    persistentPolicy: summarize(persistent, original),
  })
  console.log(`${fixtureIndex + 1}/${fixtures.length} ${name}`)
}

const diagnosticReport = JSON.parse(
  await readFile(resolve(root, 'diagnostic-report.json'), 'utf8'),
) as {
  cases: Array<{ id: string; analysis: { classification: StrategicTempoClassification } }>
}
const evaluatedById = new Map(
  fixtureReports.map((fixture) => [fixture.fixture.replace('.fixture.json', ''), fixture]),
)
const reclassification = diagnosticReport.cases.map((diagnostic) => {
  const fixture = evaluatedById.get(diagnostic.id)
  const alternative = fixture?.singleIntervention['immediate-progress']
  const revised = !alternative
    ? diagnostic.analysis.classification
    : alternative.effectClassification === 'beneficial'
      ? 'redundant'
      : alternative.effectClassification === 'harmful'
        ? diagnostic.analysis.classification
        : 'ambiguous'
  return {
    id: diagnostic.id,
    evaluated: fixture !== undefined,
    previous: diagnostic.analysis.classification,
    revised,
    evidence: alternative?.effectClassification ?? 'not-counterfactually-evaluated',
    meanEffect: alternative?.meanEffect,
    bootstrap95: alternative?.bootstrap95,
  }
})
const aggregateEffects = fixtureReports.flatMap((fixture) => {
  const report = fixture.singleIntervention['immediate-progress']
  return report?.pairedEffects ?? []
})
const aggregate = {
  fixtures: fixtureReports.length,
  repetitions,
  meanEffect: mean(aggregateEffects),
  medianEffect: median(aggregateEffects),
  bootstrap95: bootstrapMeanInterval(aggregateEffects, 10_000, 0x20260729),
  classifications: Object.fromEntries(
    ['beneficial', 'harmful', 'neutral', 'inconclusive'].map((classification) => [
      classification,
      fixtureReports.filter(
        (fixture) =>
          fixture.singleIntervention['immediate-progress']?.effectClassification === classification,
      ).length,
    ]),
  ),
}
const persistentEffects = fixtureReports.flatMap(
  (fixture) => fixture.persistentPolicy.pairedEffects,
)
const persistentDecisions = fixtureReports.reduce(
  (sum, fixture) => sum + fixture.persistentPolicy.aiDecisions,
  0,
)
const persistentAggregate = {
  meanEffect: mean(persistentEffects),
  medianEffect: median(persistentEffects),
  bootstrap95: bootstrapMeanInterval(persistentEffects, 10_000, 0x20260730),
  activations: fixtureReports.reduce(
    (sum, fixture) => sum + fixture.persistentPolicy.tiebreakActivations,
    0,
  ),
  aiDecisions: persistentDecisions,
  interventionFrequency: persistentDecisions
    ? fixtureReports.reduce(
        (sum, fixture) => sum + fixture.persistentPolicy.tiebreakActivations,
        0,
      ) / persistentDecisions
    : 0,
}
const recommendation =
  persistentAggregate.meanEffect < 0 && persistentAggregate.interventionFrequency > 0.2
    ? 'reject-tested-tiebreak-family'
    : aggregate.bootstrap95[0] > 0
      ? 'prepare-preliminary-competitive-validation'
      : 'expand-counterfactual-sample'
await writeFile(
  resolve(counterfactualRoot, 'individual-results.json'),
  `${JSON.stringify(individualRows, null, 2)}\n`,
)
await writeFile(
  resolve(counterfactualRoot, 'aggregate-report.json'),
  `${JSON.stringify(
    {
      schema: 'StrategicTempoCounterfactualPilotV1',
      repetitions,
      fixtures: fixtureReports,
      thresholdSummary,
      aggregate,
      persistentAggregate,
      recommendation,
      competitiveEvaluationExecuted: false,
    },
    null,
    2,
  )}\n`,
)
await writeFile(
  resolve(counterfactualRoot, 'reclassification.json'),
  `${JSON.stringify(reclassification, null, 2)}\n`,
)
console.log(JSON.stringify({ aggregate, recommendation }, null, 2))

function playContinuation(
  initial: GameSnapshot,
  aiColor: Player,
  seed: number,
  persistent: boolean,
): ContinuationResult {
  let state = initial
  let turns = 0
  let suspiciousInternalMoves = 0
  let tiebreakActivations = 0
  let illegalActions = 0
  let aiDecisions = 0
  const decisionTimes: number[] = []
  while (state.phase !== 'finished' && !state.result && turns < 100) {
    let action: PlayerAction
    if (state.turn === aiColor) {
      aiDecisions++
      const started = performance.now()
      const decision = chooseHumanChallengeMCTSDecision({
        gameState: state,
        seed: (seed + Math.imul(turns + 1, 0x9e3779b9)) >>> 0,
      })
      action = decision.action
      if (persistent) {
        const tied = chooseStrategicProgressTiebreak({
          state,
          original: action,
          candidates: decision.mcts.children,
          variant: persistentVariant,
        })
        action = tied.action
        if (tied.changed) tiebreakActivations++
      }
      decisionTimes.push(performance.now() - started)
      const after = applyFullAction(state, action).state
      if (
        analyzeStrategicTempoDecision({
          stateBefore: state,
          stateAfter: after,
          legalActions: getLegalActions(state),
          action,
          endedGame: after.phase === 'finished',
        }).suspicious
      )
        suspiciousInternalMoves++
    } else {
      action = heuristicAction(state, (seed + turns * 17) >>> 0)
    }
    const legal = getLegalActions(state)
    if (!legal.some((candidate) => sameAction(candidate, action))) {
      illegalActions++
      break
    }
    state = applyFullAction(state, action).state
    turns++
  }
  const score = territory(state)
  const opponent = aiColor === 'R' ? 'B' : 'R'
  const difference = score[aiColor] - score[opponent]
  return {
    outcome: difference > 0 ? 'win' : difference < 0 ? 'loss' : 'draw',
    ownTerritory: score[aiColor],
    opponentTerritory: score[opponent],
    territoryDifference: difference,
    turns,
    aiDecisions,
    suspiciousInternalMoves,
    tiebreakActivations,
    illegalActions,
    fallbacks: 0,
    meanDecisionMs: mean(decisionTimes),
    maxDecisionMs: decisionTimes.length ? Math.max(...decisionTimes) : 0,
  }
}

function summarize(results: ContinuationResult[], original?: ContinuationResult[]) {
  const effects = original
    ? results.map(
        (result, index) => result.territoryDifference - original[index]!.territoryDifference,
      )
    : []
  const bootstrap95 = bootstrapMeanInterval(effects, 10_000, 0x51ec2026)
  return {
    games: results.length,
    wins: results.filter(({ outcome }) => outcome === 'win').length,
    losses: results.filter(({ outcome }) => outcome === 'loss').length,
    draws: results.filter(({ outcome }) => outcome === 'draw').length,
    winRate: results.length
      ? results.filter(({ outcome }) => outcome === 'win').length / results.length
      : 0,
    ownTerritoryMean: mean(results.map(({ ownTerritory }) => ownTerritory)),
    opponentTerritoryMean: mean(results.map(({ opponentTerritory }) => opponentTerritory)),
    territoryDifferenceMean: mean(results.map(({ territoryDifference }) => territoryDifference)),
    territoryDifferenceMedian: median(
      results.map(({ territoryDifference }) => territoryDifference),
    ),
    turnsMean: mean(results.map(({ turns }) => turns)),
    aiDecisions: results.reduce((sum, result) => sum + result.aiDecisions, 0),
    suspiciousInternalMoves: results.reduce(
      (sum, result) => sum + result.suspiciousInternalMoves,
      0,
    ),
    tiebreakActivations: results.reduce((sum, result) => sum + result.tiebreakActivations, 0),
    illegalActions: results.reduce((sum, result) => sum + result.illegalActions, 0),
    fallbacks: results.reduce((sum, result) => sum + result.fallbacks, 0),
    meanDecisionMs: mean(results.map(({ meanDecisionMs }) => meanDecisionMs)),
    maxDecisionMs: results.length
      ? Math.max(...results.map(({ maxDecisionMs }) => maxDecisionMs))
      : 0,
    pairedEffects: effects,
    meanEffect: mean(effects),
    bootstrap95,
    effectClassification: classifyEffect(effects, bootstrap95),
  }
}

function classifyEffect(effects: number[], interval: [number, number]) {
  if (!effects.length || effects.every((effect) => effect === 0)) return 'neutral'
  const average = mean(effects)
  const positive = effects.filter((effect) => effect > 0).length
  const negative = effects.filter((effect) => effect < 0).length
  if (interval[0] > 0 || (average >= 1 && positive >= 2 && Math.min(...effects) >= -1))
    return 'beneficial'
  if (interval[1] < 0 || (average <= -1 && negative >= 2 && Math.max(...effects) <= 1))
    return 'harmful'
  return 'inconclusive'
}

function heuristicAction(state: GameSnapshot, seed: number): PlayerAction {
  const legal = getLegalActions(state)
  const ranked = legal
    .map((action) => ({ action, score: scoreHeuristicAction(state, action, 'default') }))
    .sort((left, right) => right.score - left.score)
  const best = ranked.filter(({ score }) => score === ranked[0]!.score)
  const rng = createPlayableMCTSRng(seed)
  return best[Math.floor(rng() * best.length)]!.action
}

function territory(state: GameSnapshot): Record<Player, number> {
  const score: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board)) for (const owner of row) if (owner) score[owner]++
  return score
}

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

function compareKey(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index++) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return 0
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

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
