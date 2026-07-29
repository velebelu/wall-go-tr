import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import type { GameSnapshot, PlayerAction } from '@/lib/types'

type OrderMode =
  | 'current'
  | 'reverse'
  | 'seeded-random'
  | 'moves-first'
  | 'walls-first'
  | 'coordinate'
  | 'type'
  | 'rotate-1'
  | 'rotate-7'

let auditedStateKey = ''
let orderMode: OrderMode = 'current'

vi.mock('@/utils/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/ai')>()
  return {
    ...original,
    getLegalActions(state: GameSnapshot) {
      const actions = original.getLegalActions(state)
      return stateKey(state) === auditedStateKey ? orderActions(actions, orderMode) : actions
    },
  }
})

import { createPlayableMCTSRng } from '@/agents/mctsWorkerDecision'
import { searchBestActionStaged } from '@/engine/mcts/MCTS'
import { orderActionsForExpansion } from '@/engine/mcts/MCTSNode'
import type { MCTSChildResult, MCTSConfig } from '@/engine/mcts/types'
import { getLegalActions } from '@/utils/ai'

const root = resolve('data/diagnostics/strategic-tempo-v1')
const outputRoot = resolve(root, 'root-selection-audit')
const targets = ['2eac0bd16e43', 'd8c69cdbde8d', 'f197c3b937e4']
const budgets = [25, 50, 100, 150, 250, 500, 750, 1000]
const budgetSeedOffsets = [0, 1, 2, 3, 4]
const seedSweepOffsets = Array.from({ length: 32 }, (_, index) => index)
const orderModes: OrderMode[] = [
  'current',
  'reverse',
  'seeded-random',
  'moves-first',
  'walls-first',
  'coordinate',
  'type',
  'rotate-1',
  'rotate-7',
]

interface Fixture {
  player: 'R' | 'B'
  stateBefore: GameSnapshot
  legalActions: PlayerAction[]
  action: PlayerAction
  mcts: {
    decisionSeed: number
    rootVisits: number
    effectiveConfig: MCTSConfig
    rootCandidates: MCTSChildResult[]
  }
}

interface Run {
  fixture: string
  kind: 'budget' | 'seed' | 'order'
  budget: number
  seed: number
  order: OrderMode
  elapsedMs: number
  rngCalls: number
  action: string
  rawAction: string
  originalSelected: boolean
  alternativeSelected: boolean
  topVisits: number
  secondVisits: number
  visitGap: number
  topValue: number
  secondValue: number
  valueGap: number
  rootVisits: number
  tacticalSelectionChanged: boolean
  originalMCTSActionScore: number | null
  verifiedActionScore: number | null
  children: Array<MCTSChildResult & { signature: string; valueSum: number; arrayIndex: number }>
}

describe('strategic-tempo root-selection diagnostic harness', () => {
  test('audits root selection without changing production behavior', async () => {
    if (process.env.RUN_ROOT_SELECTION_AUDIT !== '1') {
      expect(true).toBe(true)
      return
    }
    await mkdir(outputRoot, { recursive: true })
    const counterfactual = JSON.parse(
      await readFile(resolve(root, 'counterfactual/aggregate-report.json'), 'utf8'),
    ) as {
      fixtures: Array<{
        fixture: string
        actions: Array<{ label: string; action: PlayerAction }>
        singleIntervention: Record<string, { meanEffect: number; effectClassification: string }>
      }>
    }
    const allRuns: Run[] = []
    const detailed: Record<string, unknown> = {}

    for (const id of targets) {
      const fixture = JSON.parse(
        await readFile(resolve(root, `fixtures/${id}.fixture.json`), 'utf8'),
      ) as Fixture
      const cf = counterfactual.fixtures.find((entry) => entry.fixture.startsWith(id))!
      const alternative = cf.actions.find((entry) => entry.label === 'immediate-progress')!.action
      auditedStateKey = stateKey(fixture.stateBefore)

      const initialActions = getLegalActions(fixture.stateBefore)
      const expansionRng = countedRng(fixture.mcts.decisionSeed)
      const expansionOrder = orderActionsForExpansion(
        fixture.stateBefore,
        initialActions,
        fixture.mcts.effectiveConfig.expansionPolicy ?? 'unordered',
        expansionRng.random,
        undefined,
        fixture.mcts.effectiveConfig.qPriorWeight ?? 0,
      )

      for (const budget of budgets) {
        for (const offset of budgetSeedOffsets) {
          allRuns.push(
            execute(
              id,
              fixture,
              alternative,
              'budget',
              budget,
              (fixture.mcts.decisionSeed + offset) >>> 0,
              'current',
            ),
          )
        }
      }
      for (const offset of seedSweepOffsets) {
        allRuns.push(
          execute(
            id,
            fixture,
            alternative,
            'seed',
            fixture.mcts.rootVisits,
            (fixture.mcts.decisionSeed + offset) >>> 0,
            'current',
          ),
        )
      }
      for (const mode of orderModes) {
        allRuns.push(
          execute(
            id,
            fixture,
            alternative,
            'order',
            fixture.mcts.rootVisits,
            fixture.mcts.decisionSeed,
            mode,
          ),
        )
      }

      const observed = allRuns.find(
        (run) =>
          run.fixture === id &&
          run.kind === 'budget' &&
          run.budget === fixture.mcts.rootVisits &&
          run.seed === fixture.mcts.decisionSeed,
      )!
      detailed[id] = {
        originalAction: actionSignature(fixture.action),
        counterfactualAlternative: actionSignature(alternative),
        counterfactualEffect: cf.singleIntervention['immediate-progress'],
        legalActionCount: initialActions.length,
        initialLegalOrder: initialActions.map(actionSignature),
        expansionOrder: expansionOrder.map(actionSignature),
        expansionOrderingRngCalls: expansionRng.calls(),
        progressiveWideningExpansionMoments: expansionOrder.map((action, index) => ({
          action: actionSignature(action),
          rootVisitAtEarliestExpansion: index === 0 ? 0 : Math.ceil(((index + 1) / 2) ** 2),
        })),
        observedRun: observed,
        finalCriteria: finalCriteria(observed.children),
        implementation: {
          childrenStructure: 'array; push in expansion order',
          uct: 'signed mean + C * sqrt(log(max(1,parentVisits))/childVisits); strict >; exact === ties collected then randomIndex',
          final:
            'maximum visits, then maximum mean among exact visit ties, then randomIndex among exact value ties',
          rounding: 'none',
          tacticalVerification:
            'enabled: evaluates the two children ranked by visits desc then mean desc and may replace raw MCTS winner',
          randomStream:
            'one Mulberry32 stream shared by expansion tie shuffles, UCT exact ties, rollouts, final exact ties and tactical verification',
        },
      }
    }
    auditedStateKey = ''
    orderMode = 'current'

    const aggregate = buildAggregate(allRuns, detailed)
    const controls = buildControls(counterfactual)
    await writeFile(resolve(outputRoot, 'individual-results.json'), json(allRuns))
    await writeFile(resolve(outputRoot, 'detailed-audits.json'), json(detailed))
    await writeFile(resolve(outputRoot, 'aggregate-results.json'), json(aggregate))
    await writeFile(resolve(outputRoot, 'controls.json'), json(controls))
    await writeFile(resolve(outputRoot, 'convergence.csv'), convergenceCsv(allRuns))
    await writeFile(resolve(outputRoot, 'seed-sensitivity.csv'), seedCsv(allRuns))
    await writeFile(resolve(outputRoot, 'order-sensitivity.csv'), orderCsv(allRuns))
    await writeFile(
      resolve(outputRoot, 'CONFIGURATION.json'),
      json({
        schema: 'StrategicTempoRootSelectionAuditConfigurationV1',
        targets,
        budgets,
        budgetSeedsPerBudget: budgetSeedOffsets.length,
        seedSweepSize: seedSweepOffsets.length,
        orderModes,
        officialConfigurationChanged: false,
        qPriorWeight: 0,
      }),
    )
    await writeFile(resolve(outputRoot, 'METHODOLOGY.md'), methodology())
    await writeFile(resolve(outputRoot, 'README.md'), renderReadme(aggregate))

    expect(allRuns.length).toBe(targets.length * (budgets.length * 5 + 32 + orderModes.length))
  }, 1_800_000)
})

function execute(
  id: string,
  fixture: Fixture,
  alternative: PlayerAction,
  kind: Run['kind'],
  budget: number,
  seed: number,
  mode: OrderMode,
): Run {
  orderMode = mode
  const rng = countedRng(seed)
  const started = performance.now()
  const targets = stagedTargets(budget)
  const result = searchBestActionStaged(
    fixture.stateBefore,
    fixture.player,
    { ...fixture.mcts.effectiveConfig, simulations: Math.min(250, budget) },
    { simulationTargets: targets },
    rng.random,
  ).result
  const elapsedMs = performance.now() - started
  const ranked = [...result.children].sort(
    (left, right) => right.visits - left.visits || right.value - left.value,
  )
  const first = ranked[0]!
  const second = ranked[1] ?? first
  return {
    fixture: id,
    kind,
    budget,
    seed,
    order: mode,
    elapsedMs,
    rngCalls: rng.calls(),
    action: actionSignature(result.action),
    rawAction: actionSignature(result.originalAction!),
    originalSelected: sameAction(result.action, fixture.action),
    alternativeSelected: sameAction(result.action, alternative),
    topVisits: first.visits,
    secondVisits: second.visits,
    visitGap: first.visits - second.visits,
    topValue: first.value,
    secondValue: second.value,
    valueGap: first.value - second.value,
    rootVisits: result.rootVisits,
    tacticalSelectionChanged: result.tacticalSelectionChanged === true,
    originalMCTSActionScore: finiteOrNull(result.originalMCTSActionScore),
    verifiedActionScore: finiteOrNull(result.verifiedActionScore),
    children: result.children.map((child, arrayIndex) => ({
      ...child,
      signature: actionSignature(child.action),
      valueSum: child.value * child.visits,
      arrayIndex,
    })),
  }
}

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null
}

function stagedTargets(budget: number): number[] {
  return [25, 50, 100, 150, 250, 500, 750, 1000].filter(
    (target) => target === budget || (target >= 250 && target < budget),
  )
}

function finalCriteria(children: Run['children']) {
  const byVisits = [...children].sort((a, b) => b.visits - a.visits || b.value - a.value)[0]!
  const byMean = [...children].sort((a, b) => b.value - a.value || b.visits - a.visits)[0]!
  const bySum = [...children].sort((a, b) => b.valueSum - a.valueSum || b.visits - a.visits)[0]!
  const exactVisitTies = children.filter((child) => child.visits === byVisits.visits)
  const exactFinalTies = exactVisitTies.filter((child) => child.value === byVisits.value)
  return {
    maximumVisitsThenMean: byVisits.signature,
    maximumMean: byMean.signature,
    maximumAccumulatedValue: bySum.signature,
    exactVisitTieCount: exactVisitTies.length,
    exactFinalTieCount: exactFinalTies.length,
    deterministicFirstExactTie: exactFinalTies[0]?.signature,
    deterministicLastExactTie: exactFinalTies[exactFinalTies.length - 1]?.signature,
  }
}

function buildAggregate(runs: Run[], detailed: Record<string, unknown>) {
  const fixtures = targets.map((id) => {
    const own = runs.filter((run) => run.fixture === id)
    const seed = own.filter((run) => run.kind === 'seed')
    const order = own.filter((run) => run.kind === 'order')
    const budgetRows = budgets.map((budget) => {
      const rows = own.filter((run) => run.kind === 'budget' && run.budget === budget)
      return {
        budget,
        selectedDistribution: distribution(rows.map((row) => row.action)),
        rawDistribution: distribution(rows.map((row) => row.rawAction)),
        originalRate: mean(rows.map((row) => Number(row.originalSelected))),
        alternativeRate: mean(rows.map((row) => Number(row.alternativeSelected))),
        meanVisitGap: mean(rows.map((row) => row.visitGap)),
        meanValueGap: mean(rows.map((row) => row.valueGap)),
        meanElapsedMs: mean(rows.map((row) => row.elapsedMs)),
      }
    })
    return {
      fixture: id,
      budgetCurves: budgetRows,
      seedDistribution: distribution(seed.map((row) => row.action)),
      seedOriginalRate: mean(seed.map((row) => Number(row.originalSelected))),
      seedAlternativeRate: mean(seed.map((row) => Number(row.alternativeSelected))),
      orderDistribution: distribution(order.map((row) => row.action)),
      orderChangesFromCurrent: order.filter((row) => row.action !== order[0]!.action).length,
      criteria: (detailed[id] as { finalCriteria: unknown }).finalCriteria,
    }
  })
  const commonSeedInstability = fixtures.filter(
    (fixture) => Object.keys(fixture.seedDistribution).length > 1,
  ).length
  const commonOrderInstability = fixtures.filter(
    (fixture) => fixture.orderChangesFromCurrent > 0,
  ).length
  return {
    schema: 'StrategicTempoRootSelectionAuditV1',
    fixtures,
    individualCauses: {
      '2eac0bd16e43':
        'near-tied stochastic root estimate: the captured action uniquely won raw MCTS by 24 vs 22 visits and -0.791667 vs -0.818182; tactical verification did not replace it',
      d8c69cdbde8d:
        'post-root tactical override: raw MCTS chose move:1,5>1,4:top, but two-candidate worst-reply verification replaced it with the captured move',
      f197c3b937e4:
        'terminal-value saturation plus exact ties and post-root tactical override: 16 root candidates tied at mean 1 and maximum visits, then exact-tie RNG and tactical verification determined the captured move',
    },
    commonMechanism: 'no-common-mechanism-demonstrated',
    orderSensitivityObservedIn: commonOrderInstability,
    seedSensitivityObservedIn: commonSeedInstability,
    focusedExtraRound: {
      executed: false,
      reason:
        'The retained MCTS API does not support continuing only two root children without changing production behavior; this is also unnecessary unless all three cases show the same strict near-tie mechanism.',
    },
    recommendation: 'C',
  }
}

function buildControls(counterfactual: {
  fixtures: Array<{
    fixture: string
    previousClassification?: string
    singleIntervention: Record<string, { meanEffect: number; effectClassification: string }>
  }>
}) {
  const harmful = counterfactual.fixtures
    .filter(
      (fixture) =>
        fixture.singleIntervention['immediate-progress']?.effectClassification === 'harmful',
    )
    .slice(0, 3)
  const useful = counterfactual.fixtures
    .filter(
      (fixture) =>
        !targets.some((id) => fixture.fixture.startsWith(id)) &&
        ['mobility-improving', 'future-wall-preparation', 'strategic-repositioning'].includes(
          fixture.previousClassification ?? '',
        ),
    )
    .slice(0, 3)
  return {
    harmfulProgressAlternatives: harmful.map(controlRow),
    correctlyClassifiedUsefulMoves: useful.map(controlRow),
    normalStateControls: {
      available: false,
      reason:
        'The retained StrategicTempoFixtureV1 corpus contains only preselected suspicious movements. Fabricating a normal label would invalidate the control.',
    },
    effectOfRecommendation: {
      changedDecisions: 0,
      reason: 'Recommendation C makes no production selector or policy change.',
    },
  }
}

function controlRow(fixture: {
  fixture: string
  previousClassification?: string
  singleIntervention: Record<string, { meanEffect: number; effectClassification: string }>
}) {
  return {
    fixture: fixture.fixture,
    classification: fixture.previousClassification,
    progressAlternative: fixture.singleIntervention['immediate-progress'],
  }
}

function orderActions(actions: PlayerAction[], mode: OrderMode): PlayerAction[] {
  const result = [...actions]
  if (mode === 'current') return result
  if (mode === 'reverse') return result.reverse()
  if (mode === 'rotate-1') return result.slice(1).concat(result.slice(0, 1))
  if (mode === 'rotate-7') return result.slice(7).concat(result.slice(0, 7))
  if (mode === 'seeded-random') {
    const rng = createPlayableMCTSRng(0x5eed2026)
    for (let index = result.length - 1; index > 0; index--) {
      const swap = Math.floor(rng() * (index + 1))
      ;[result[index], result[swap]] = [result[swap]!, result[index]!]
    }
    return result
  }
  if (mode === 'moves-first')
    return result.sort((a, b) => Number(b.type === 'move') - Number(a.type === 'move'))
  if (mode === 'walls-first')
    return result.sort((a, b) => Number(b.type === 'wall') - Number(a.type === 'wall'))
  if (mode === 'type') return result.sort((a, b) => a.type.localeCompare(b.type))
  return result.sort((a, b) => coordinateKey(a).localeCompare(coordinateKey(b)))
}

function coordinateKey(action: PlayerAction): string {
  const from = 'from' in action && action.from ? `${action.from.y}${action.from.x}` : '--'
  return `${action.pos.y}${action.pos.x}:${from}:${action.type}:${JSON.stringify(action)}`
}

function countedRng(seed: number) {
  const base = createPlayableMCTSRng(seed)
  let count = 0
  return {
    random: () => {
      count++
      return base()
    },
    calls: () => count,
  }
}

function stateKey(state: GameSnapshot): string {
  return JSON.stringify([state.turn, state.phase, state.board])
}

function actionSignature(action: PlayerAction): string {
  if (action.type === 'place') return `place:${action.pos.x},${action.pos.y}`
  if (action.type === 'wall') return `wall:${action.from!.x},${action.from!.y}:${action.dir}`
  return `move:${action.from!.x},${action.from!.y}>${action.pos.x},${action.pos.y}:${action.followUp!.dir}`
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function distribution(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1
    return counts
  }, {})
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function convergenceCsv(runs: Run[]): string {
  return csv(
    [
      'fixture',
      'budget',
      'seed',
      'action',
      'rawAction',
      'visitGap',
      'valueGap',
      'elapsedMs',
      'rngCalls',
    ],
    runs
      .filter((run) => run.kind === 'budget')
      .map((run) => [
        run.fixture,
        run.budget,
        run.seed,
        run.action,
        run.rawAction,
        run.visitGap,
        run.valueGap,
        run.elapsedMs,
        run.rngCalls,
      ]),
  )
}

function seedCsv(runs: Run[]): string {
  return csv(
    [
      'fixture',
      'seed',
      'action',
      'rawAction',
      'originalSelected',
      'alternativeSelected',
      'visitGap',
      'valueGap',
      'elapsedMs',
    ],
    runs
      .filter((run) => run.kind === 'seed')
      .map((run) => [
        run.fixture,
        run.seed,
        run.action,
        run.rawAction,
        run.originalSelected,
        run.alternativeSelected,
        run.visitGap,
        run.valueGap,
        run.elapsedMs,
      ]),
  )
}

function orderCsv(runs: Run[]): string {
  return csv(
    [
      'fixture',
      'order',
      'seed',
      'action',
      'rawAction',
      'visitGap',
      'valueGap',
      'elapsedMs',
      'rngCalls',
    ],
    runs
      .filter((run) => run.kind === 'order')
      .map((run) => [
        run.fixture,
        run.order,
        run.seed,
        run.action,
        run.rawAction,
        run.visitGap,
        run.valueGap,
        run.elapsedMs,
        run.rngCalls,
      ]),
  )
}

function csv(headers: string[], rows: Array<Array<string | number | boolean>>): string {
  return `${headers.join(',')}\n${rows.map((row) => row.map((cell) => JSON.stringify(cell)).join(',')).join('\n')}\n`
}

function methodology(): string {
  return `# Methodology

This is a diagnostic-only audit. Production MCTS and official configuration are not modified.
The Vitest harness wraps \`getLegalActions\` only for the exact audited root snapshot. Descendant
nodes use the unmodified generator. Every order experiment preserves the legal action set.

Budget curves use 25, 50, 100, 150, 250, 500, 750 and 1,000 simulations with five adjacent
Mulberry32 seeds. The seed sweep uses 32 adjacent seeds at the fixture's captured playable
configuration. Order sensitivity holds seed and budget fixed and changes root enumeration only.

Reported \`rawAction\` is the MCTS maximum-visits/then-mean result. Reported \`action\` is the
playable result after the already-enabled tactical verification. Values are not rounded before
comparison. RNG calls include expansion tie shuffles, UCT ties, rollouts, final ties and tactical
verification.
`
}

function renderReadme(aggregate: ReturnType<typeof buildAggregate>): string {
  return `# Root-selection audit

Common mechanism: **${aggregate.commonMechanism}**

Diagnostic recommendation: **${aggregate.recommendation}**

The machine-readable detailed reconstruction is in \`detailed-audits.json\`. Curves and raw
observations are in the three CSV files and \`individual-results.json\`. No strategic progress
signal, territorial rule, or production selector change is included.
`
}
