import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import { createPlayableMCTSRng } from '@/agents/mctsWorkerDecision'
import { applyFullAction } from '@/engine/gameSimulator'
import { searchBestActionStaged, verifyTacticalCandidates } from '@/engine/mcts/MCTS'
import type { MCTSChildResult, MCTSConfig } from '@/engine/mcts/types'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'

const diagnosticRoot = resolve('data/diagnostics/strategic-tempo-v1')
const outputRoot = resolve(diagnosticRoot, 'tactical-saturation-audit')
const seedsPerState = 8
const historicalIds = [
  '024456fb924d',
  '06eb43800ede',
  '2eac0bd16e43',
  '3c6e0e435838',
  '8238614515c3',
  '8a62f8f826fc',
  '94fe8f8cbf50',
  'bddb6dd1b3cb',
  'c93e45301297',
  'd8c69cdbde8d',
  'e28286aceb33',
  'ea0610abb2c1',
  'f197c3b937e4',
]
const variantNames = [
  'A-current-2',
  'B-current-2-plus-raw',
  'C-exact-cap-3',
  'C-exact-cap-4',
  'C-exact-cap-6',
  'C-exact-cap-8',
  'D-saturated-cap-3',
  'D-saturated-cap-4',
  'D-saturated-cap-6',
  'D-saturated-cap-8',
  'E-deterministic-representative',
] as const
type VariantName = (typeof variantNames)[number]

interface Fixture {
  player: 'R' | 'B'
  stateBefore: Omit<GameSnapshot, 'legal'> & { legal: string[] }
  action: PlayerAction
  mcts: {
    decisionSeed: number
    rootVisits: number
    effectiveConfig: MCTSConfig
  }
}

interface CorpusState {
  id: string
  kind: 'historical' | 'synthetic-normal'
  group: 'principal' | 'harmful-control' | 'useful-control' | 'other-historical' | 'normal'
  state: GameSnapshot
  baseSeed: number
  budget: number
  config: MCTSConfig
}

interface TacticalCandidate extends MCTSChildResult {
  signature: string
  originalIndex: number
  tacticalScore: number
  permitsImmediateTerminalLoss: boolean
}

interface VariantResult {
  variant: VariantName
  activated: boolean
  candidates: string[]
  selected: string
  selectedScore: number
  elapsedMs: number
  includesRawWinner: boolean
}

interface DecisionResult {
  state: string
  kind: CorpusState['kind']
  group: CorpusState['group']
  seed: number
  rawWinner: string
  rootCandidates: number
  topVisitTieCount: number
  exactTopTieCount: number
  saturatedCandidates: number
  rawOutsideCurrentTop2: boolean
  currentTop2: string[]
  reverseTop2: string[]
  currentTop2ChangedByOrder: boolean
  variants: VariantResult[]
  reversedVariants: VariantResult[]
}

describe('diagnostic tactical saturation audit', () => {
  test('finalizes internal-own-territory movement frequency', async () => {
    if (process.env.FINALIZE_TACTICAL_SATURATION_AUDIT !== '1') {
      expect(true).toBe(true)
      return
    }
    const corpus = await buildCorpus()
    const stateById = new Map(corpus.map((item) => [item.id, item.state]))
    const rows = JSON.parse(
      await readFile(resolve(outputRoot, 'individual-results.json'), 'utf8'),
    ) as DecisionResult[]
    const classified = rows.map((row) => {
      const state = stateById.get(row.state)!
      const selected = row.variants[0]!.selected
      const action = getLegalActions(state).find((candidate) => signature(candidate) === selected)
      return {
        state: row.state,
        group: row.group,
        selected,
        internalOwnTerritoryMovement: action ? isInternalOwnTerritoryMove(state, action) : false,
      }
    })
    const internal = classified.filter(
      ({ internalOwnTerritoryMovement }) => internalOwnTerritoryMovement,
    )
    await writeFile(
      resolve(outputRoot, 'internal-movement-frequency.json'),
      json({
        definition:
          'selected move starts and ends in cells currently classified as own pure territory',
        decisions: classified.length,
        count: internal.length,
        rate: internal.length / classified.length,
        occurrences: internal,
      }),
    )
    expect(classified).toHaveLength(rows.length)
  })

  test('measures adaptive tactical candidate variants without changing production MCTS', async () => {
    if (process.env.RUN_TACTICAL_SATURATION_AUDIT !== '1') {
      expect(true).toBe(true)
      return
    }
    await mkdir(resolve(outputRoot, 'fixtures'), { recursive: true })
    const corpus = await buildCorpus()
    const rows: DecisionResult[] = []
    for (const item of corpus) {
      for (let offset = 0; offset < seedsPerState; offset++) {
        rows.push(runDecision(item, (item.baseSeed + offset) >>> 0))
      }
    }
    const aggregate = aggregateResults(rows)
    await writeFile(resolve(outputRoot, 'individual-results.json'), json(rows))
    await writeFile(resolve(outputRoot, 'aggregate-results.json'), json(aggregate))
    await writeFile(resolve(outputRoot, 'phenomenon-frequency.json'), json(aggregate.frequency))
    await writeFile(resolve(outputRoot, 'order-sensitivity.csv'), orderCsv(rows))
    await writeFile(resolve(outputRoot, 'timing.csv'), timingCsv(rows))
    await writeFile(resolve(outputRoot, 'variant-comparison.csv'), variantCsv(rows))
    await writeFile(resolve(outputRoot, 'CONFIGURATION.json'), json(configuration(corpus)))
    await writeFile(resolve(outputRoot, 'VARIANTS.md'), variantsDocument())
    await writeFile(resolve(outputRoot, 'METHODOLOGY.md'), methodology())
    await writeFile(resolve(outputRoot, 'README.md'), report(aggregate))
    expect(rows).toHaveLength(corpus.length * seedsPerState)
  }, 1_800_000)
})

async function buildCorpus(): Promise<CorpusState[]> {
  const harmful = new Set(['06eb43800ede', '3c6e0e435838', '94fe8f8cbf50'])
  const useful = new Set(['8a62f8f826fc', 'c93e45301297', '8238614515c3'])
  const historical = await Promise.all(
    historicalIds.map(async (id): Promise<CorpusState> => {
      const fixture = JSON.parse(
        await readFile(resolve(diagnosticRoot, `fixtures/${id}.fixture.json`), 'utf8'),
      ) as Fixture
      return {
        id,
        kind: 'historical',
        group:
          id === 'f197c3b937e4'
            ? 'principal'
            : harmful.has(id)
              ? 'harmful-control'
              : useful.has(id)
                ? 'useful-control'
                : 'other-historical',
        state: { ...fixture.stateBefore, legal: new Set(fixture.stateBefore.legal) },
        baseSeed: fixture.mcts.decisionSeed,
        budget: fixture.mcts.rootVisits,
        config: { ...fixture.mcts.effectiveConfig, tacticalVerification: false },
      }
    }),
  )
  const reference = historical[0]!
  const synthetic = Array.from({ length: 6 }, (_, index): CorpusState => {
    const seed = (0x51a70000 + index * 10_007) >>> 0
    const state = generateSyntheticState(seed, 10 + index * 2)
    return {
      id: `synthetic-normal-${String(index + 1).padStart(2, '0')}`,
      kind: 'synthetic-normal',
      group: 'normal',
      state,
      baseSeed: seed,
      budget: 500,
      config: { ...reference.config, tacticalVerification: false },
    }
  })
  for (const item of synthetic) {
    await writeFile(
      resolve(outputRoot, 'fixtures', `${item.id}.fixture.json`),
      json({
        schema: 'SyntheticTacticalSaturationFixtureV1',
        provenance: 'seeded synthetic diagnostic; not human and not V3',
        seed: item.baseSeed,
        state: serializeState(item.state),
      }),
    )
  }
  return historical.concat(synthetic)
}

function generateSyntheticState(seed: number, fullActions: number): GameSnapshot {
  const rng = createPlayableMCTSRng(seed)
  let state = makeInitialState()
  let completed = 0
  while (state.phase !== 'finished' && completed < fullActions + 4) {
    const actions = getLegalActions(state)
    if (!actions.length) break
    const action = actions[Math.floor(rng() * actions.length)]!
    state = applyFullAction(state, action).state
    completed++
  }
  if (state.phase === 'finished') return generateSyntheticState((seed + 1) >>> 0, fullActions)
  return state
}

function runDecision(item: CorpusState, seed: number): DecisionResult {
  const result = searchBestActionStaged(
    item.state,
    item.state.turn,
    item.config,
    { simulationTargets: stagedTargets(item.budget) },
    createPlayableMCTSRng(seed),
  ).result
  const candidates = evaluateCandidates(item.state, item.config, result.children)
  const rawWinner = signature(result.originalAction!)
  const sorted = stableRank(candidates)
  const reversed = stableRank([...candidates].reverse())
  const currentTop2 = sorted.slice(0, 2).map(({ signature: value }) => value)
  const reverseTop2 = reversed.slice(0, 2).map(({ signature: value }) => value)
  const topVisits = sorted[0]!.visits
  const topVisitCandidates = candidates.filter(({ visits }) => visits === topVisits)
  const topValue = Math.max(...topVisitCandidates.map(({ value }) => value))
  const exactTop = topVisitCandidates.filter(({ value }) => Math.abs(value - topValue) <= 1e-12)
  const saturated = candidates.filter(({ value }) => Math.abs(value) === 1)
  return {
    state: item.id,
    kind: item.kind,
    group: item.group,
    seed,
    rawWinner,
    rootCandidates: candidates.length,
    topVisitTieCount: topVisitCandidates.length,
    exactTopTieCount: exactTop.length,
    saturatedCandidates: saturated.length,
    rawOutsideCurrentTop2: !currentTop2.includes(rawWinner),
    currentTop2,
    reverseTop2,
    currentTop2ChangedByOrder: currentTop2.join('|') !== reverseTop2.join('|'),
    variants: variantNames.map((variant) => applyVariant(variant, candidates, rawWinner)),
    reversedVariants: variantNames.map((variant) =>
      applyVariant(variant, [...candidates].reverse(), rawWinner),
    ),
  }
}

function evaluateCandidates(
  state: GameSnapshot,
  config: MCTSConfig,
  children: readonly MCTSChildResult[],
): TacticalCandidate[] {
  return children.map((child, originalIndex) => {
    const verified = verifyTacticalCandidates(
      state,
      state.turn,
      [child],
      child.action,
      1,
      () => 0,
      config,
    )
    return {
      ...child,
      signature: signature(child.action),
      originalIndex,
      tacticalScore: verified.metrics.verifiedActionScore!,
      permitsImmediateTerminalLoss:
        verified.metrics.immediateTerminalLossAvoided === false &&
        verified.metrics.verifiedActionScore === -1_000_000,
    }
  })
}

function applyVariant(
  variant: VariantName,
  candidates: TacticalCandidate[],
  rawWinner: string,
): VariantResult {
  const started = performance.now()
  const ranked = stableRank(candidates)
  const base = ranked.slice(0, 2)
  let selectedCandidates: TacticalCandidate[]
  if (variant === 'A-current-2') {
    selectedCandidates = base
  } else if (variant === 'B-current-2-plus-raw') {
    selectedCandidates = unique(base.concat(findRaw(candidates, rawWinner)))
  } else if (variant.startsWith('C-exact-cap-')) {
    const parts = variant.split('-')
    const cap = Number(parts[parts.length - 1])
    const best = ranked[0]!
    const tied = ranked.filter(
      ({ visits, value }) => visits === best.visits && Math.abs(value - best.value) <= 1e-12,
    )
    selectedCandidates = unique(tied.slice(0, cap).concat(findRaw(candidates, rawWinner))).slice(
      0,
      cap,
    )
  } else if (variant.startsWith('D-saturated-cap-')) {
    const parts = variant.split('-')
    const cap = Number(parts[parts.length - 1])
    const saturated = ranked.filter(({ value }) => Math.abs(value) === 1)
    selectedCandidates =
      saturated.length >= 3
        ? unique(saturated.slice(0, cap).concat(findRaw(candidates, rawWinner))).slice(0, cap)
        : base
  } else {
    const raw = findRaw(candidates, rawWinner)
    const bestTactical = [...candidates].sort(
      (left, right) =>
        right.tacticalScore - left.tacticalScore || left.signature.localeCompare(right.signature),
    )[0]!
    const differentType = ranked.find(
      (candidate) => actionType(candidate.action) !== actionType(raw.action),
    )
    selectedCandidates = unique([
      raw,
      ranked[0]!,
      bestTactical,
      ...(differentType ? [differentType] : []),
    ])
  }
  const bestScore = Math.max(...selectedCandidates.map(({ tacticalScore }) => tacticalScore))
  const selected = selectedCandidates
    .filter(({ tacticalScore }) => tacticalScore === bestScore)
    .sort((left, right) => left.signature.localeCompare(right.signature))[0]!
  return {
    variant,
    activated:
      variant !== 'A-current-2' &&
      selectedCandidates.map(({ signature: value }) => value).join('|') !==
        base.map(({ signature: value }) => value).join('|'),
    candidates: selectedCandidates.map(({ signature: value }) => value),
    selected: selected.signature,
    selectedScore: selected.tacticalScore,
    elapsedMs: performance.now() - started,
    includesRawWinner: selectedCandidates.some(({ signature: value }) => value === rawWinner),
  }
}

function aggregateResults(rows: DecisionResult[]) {
  const baseline = rows.map((row) => row.variants[0]!)
  const variants = variantNames.map((variant, index) => {
    const values = rows.map((row) => row.variants[index]!)
    const reverse = rows.map((row) => row.reversedVariants[index]!)
    const changed = values.filter(
      (value, rowIndex) => value.selected !== baseline[rowIndex]!.selected,
    )
    const normalIndexes = rows
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(({ row }) => row.group === 'normal')
    const usefulIndexes = rows
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(({ row }) => row.group === 'useful-control')
    return {
      variant,
      activations: values.filter(({ activated }) => activated).length,
      activationRate: rate(values.filter(({ activated }) => activated).length, rows.length),
      changedDecisions: changed.length,
      changedRate: rate(changed.length, rows.length),
      rawWinnerCoverage: rate(
        values.filter(({ includesRawWinner }) => includesRawWinner).length,
        rows.length,
      ),
      orderChangedFinal: values.filter(
        (value, rowIndex) => value.selected !== reverse[rowIndex]!.selected,
      ).length,
      meanCandidateCount: mean(values.map(({ candidates }) => candidates.length)),
      maxCandidateCount: Math.max(...values.map(({ candidates }) => candidates.length)),
      meanSelectorOverheadMs: mean(values.map(({ elapsedMs }) => elapsedMs)),
      normalChanged: normalIndexes.filter(
        ({ rowIndex }) => values[rowIndex]!.selected !== baseline[rowIndex]!.selected,
      ).length,
      usefulControlsChanged: usefulIndexes.filter(
        ({ rowIndex }) => values[rowIndex]!.selected !== baseline[rowIndex]!.selected,
      ).length,
      meanTacticalScoreDelta: mean(
        values.map((value, rowIndex) => value.selectedScore - baseline[rowIndex]!.selectedScore),
      ),
    }
  })
  const exactTies = rows.filter(({ exactTopTieCount }) => exactTopTieCount > 1)
  const saturated = rows.filter(({ saturatedCandidates }) => saturatedCandidates > 1)
  const rawExcluded = rows.filter(({ rawOutsideCurrentTop2 }) => rawOutsideCurrentTop2)
  const orderChangedSet = rows.filter(({ currentTop2ChangedByOrder }) => currentTop2ChangedByOrder)
  const frequency = {
    decisions: rows.length,
    exactMaximumTie: exactTies.length,
    exactMaximumTieRate: rate(exactTies.length, rows.length),
    multipleSaturatedValues: saturated.length,
    multipleSaturatedValuesRate: rate(saturated.length, rows.length),
    meanExactTopTieCandidates: mean(exactTies.map(({ exactTopTieCount }) => exactTopTieCount)),
    maxExactTopTieCandidates: Math.max(
      0,
      ...exactTies.map(({ exactTopTieCount }) => exactTopTieCount),
    ),
    rawWinnerOutsideTop2: rawExcluded.length,
    rawWinnerOutsideTop2Rate: rate(rawExcluded.length, rows.length),
    top2SetChangesWhenOrderReversed: orderChangedSet.length,
    top2SetChangesWhenOrderReversedRate: rate(orderChangedSet.length, rows.length),
    baselineFinalChangesWhenOrderReversed: rows.filter(
      (row) => row.variants[0]!.selected !== row.reversedVariants[0]!.selected,
    ).length,
  }
  const promising = variants.filter(
    (variant) =>
      variant.variant !== 'A-current-2' &&
      variant.rawWinnerCoverage === 1 &&
      variant.orderChangedFinal === 0 &&
      variant.normalChanged === 0 &&
      variant.usefulControlsChanged === 0 &&
      variant.meanTacticalScoreDelta >= 0,
  )
  return {
    schema: 'TacticalSaturationAuditV1',
    frequency,
    variants,
    competitiveEvaluation: {
      executed: false,
      reason: promising.length
        ? 'No league was run because tactical-score screening alone is insufficient to establish multi-state competitive benefit.'
        : 'No diagnostic variant passed the fixture/control/order preconditions.',
    },
    recommendation: promising.length
      ? 'D-evidence-insufficient-no-adoption'
      : 'C-reject-adaptive-expansion-as-general-change',
    promisingVariants: promising.map(({ variant }) => variant),
  }
}

function stableRank(candidates: TacticalCandidate[]): TacticalCandidate[] {
  return [...candidates].sort(
    (left, right) => right.visits - left.visits || right.value - left.value,
  )
}

function findRaw(candidates: TacticalCandidate[], rawWinner: string): TacticalCandidate {
  return candidates.find(({ signature: value }) => value === rawWinner)!
}

function unique(candidates: TacticalCandidate[]): TacticalCandidate[] {
  return [...new Map(candidates.map((candidate) => [candidate.signature, candidate])).values()]
}

function stagedTargets(budget: number): number[] {
  return [250, 500, 750, 1000].filter(
    (target) => target === budget || (target >= 250 && target < budget),
  )
}

function actionType(action: PlayerAction): string {
  return action.type
}

function signature(action: PlayerAction): string {
  if (action.type === 'place') return `place:${action.pos.x},${action.pos.y}`
  if (action.type === 'wall') return `wall:${action.from!.x},${action.from!.y}:${action.dir}`
  return `move:${action.from!.x},${action.from!.y}>${action.pos.x},${action.pos.y}:${action.followUp!.dir}`
}

function serializeState(state: GameSnapshot) {
  return { ...state, legal: [...state.legal] }
}

function isInternalOwnTerritoryMove(state: GameSnapshot, action: PlayerAction): boolean {
  if (action.type !== 'move' || !action.from) return false
  const territory = territoryOwners(state)
  return (
    territory[action.from.y]?.[action.from.x] === state.turn &&
    territory[action.pos.y]?.[action.pos.x] === state.turn
  )
}

function territoryOwners(state: GameSnapshot): Array<Array<'R' | 'B' | null>> {
  const size = state.board.length
  const owners = Array.from({ length: size }, () => Array<'R' | 'B' | null>(size).fill(null))
  const visited = Array.from({ length: size }, () => Array(size).fill(false))
  for (let startY = 0; startY < size; startY++) {
    for (let startX = 0; startX < size; startX++) {
      if (visited[startY]![startX]) continue
      const queue = [{ x: startX, y: startY }]
      const region: Array<{ x: number; y: number }> = []
      const stones = new Set<'R' | 'B'>()
      visited[startY]![startX] = true
      while (queue.length) {
        const current = queue.shift()!
        region.push(current)
        const stone = state.board[current.y]![current.x]!.stone
        if (stone) stones.add(stone)
        for (const next of adjacentWithoutWall(state, current.x, current.y)) {
          if (!visited[next.y]![next.x]) {
            visited[next.y]![next.x] = true
            queue.push(next)
          }
        }
      }
      if (stones.size === 1) {
        const owner = [...stones][0]!
        for (const cell of region) owners[cell.y]![cell.x] = owner
      }
    }
  }
  return owners
}

function adjacentWithoutWall(state: GameSnapshot, x: number, y: number) {
  const board = state.board
  const result: Array<{ x: number; y: number }> = []
  if (y > 0 && !board[y]![x]!.wallTop) result.push({ x, y: y - 1 })
  if (y + 1 < board.length && !board[y + 1]![x]!.wallTop) result.push({ x, y: y + 1 })
  if (x > 0 && !board[y]![x]!.wallLeft) result.push({ x: x - 1, y })
  if (x + 1 < board.length && !board[y]![x + 1]!.wallLeft) result.push({ x: x + 1, y })
  return result
}

function rate(count: number, total: number): number {
  return total ? count / total : 0
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function configuration(corpus: CorpusState[]) {
  return {
    schema: 'TacticalSaturationAuditConfigurationV1',
    historicalStates: historicalIds.length,
    syntheticNormalStates: corpus.filter(({ kind }) => kind === 'synthetic-normal').length,
    seedsPerState,
    decisions: corpus.length * seedsPerState,
    budget: 500,
    variants: variantNames,
    exactTolerance: 1e-12,
    qPriorWeight: 0,
    officialTacticalCandidateCount: 2,
    productionConfigurationChanged: false,
  }
}

function variantsDocument(): string {
  return `# Diagnostic variants

- **A**: the current stable ranking by visits descending, then mean value descending, sliced to two.
- **B**: A plus the raw root winner when absent; at most three.
- **C3/C4/C6/C8**: exact maximum-visit and value ties, tolerance \`1e-12\`, capped.
- **D3/D4/D6/D8**: expand only when at least three candidates have mean exactly \`1\` or \`-1\`, capped.
- **E**: deterministic representative set: raw winner, top-ranked candidate, best preliminary tactical score and a different action type when available.

Every candidate's tactical score is measured by the existing one-ply worst-opponent-reply
verification. No territorial, progress or tempo signal is introduced.
`
}

function methodology(): string {
  return `# Methodology

The corpus contains 13 retained strategic-tempo fixtures and six reproducible synthetic normal
states. Synthetic fixtures are explicitly marked as non-human and unrelated to V3. Eight adjacent
Mulberry32 seeds are used per state, for 152 paired root decisions at a 500-simulation staged
budget (250→500).

MCTS runs with the captured official configuration except that automatic tactical verification is
disabled so every variant receives the same root tree. The existing exported tactical verifier is
then run independently for each root child. Variants differ only in candidate-set construction.
The input array is also reversed while retaining identical visits, values and scores to isolate
storage-order sensitivity.

This screen measures candidate coverage, selected tactical score, activation, controls and timing.
It does not claim win-rate evidence. A competitive league is allowed only after a variant passes
all fixture, normal-control and order-stability conditions.
`
}

function report(aggregate: ReturnType<typeof aggregateResults>): string {
  return `# Tactical saturation audit

Decisions: ${aggregate.frequency.decisions}

Exact maximum ties: ${aggregate.frequency.exactMaximumTie}
(${(aggregate.frequency.exactMaximumTieRate * 100).toFixed(1)}%).

Multiple saturated candidates: ${aggregate.frequency.multipleSaturatedValues}
(${(aggregate.frequency.multipleSaturatedValuesRate * 100).toFixed(1)}%).

Raw winner outside current top two: ${aggregate.frequency.rawWinnerOutsideTop2}
(${(aggregate.frequency.rawWinnerOutsideTop2Rate * 100).toFixed(1)}%).

Recommendation: **${aggregate.recommendation}**.

Competitive evaluation: not executed. ${aggregate.competitiveEvaluation.reason}
`
}

function orderCsv(rows: DecisionResult[]): string {
  return csv(
    ['state', 'group', 'seed', 'top2Changed', 'baselineFinalChanged'],
    rows.map((row) => [
      row.state,
      row.group,
      row.seed,
      row.currentTop2ChangedByOrder,
      row.variants[0]!.selected !== row.reversedVariants[0]!.selected,
    ]),
  )
}

function timingCsv(rows: DecisionResult[]): string {
  return csv(
    ['state', 'seed', 'variant', 'candidateCount', 'selectorOverheadMs'],
    rows.flatMap((row) =>
      row.variants.map((variant) => [
        row.state,
        row.seed,
        variant.variant,
        variant.candidates.length,
        variant.elapsedMs,
      ]),
    ),
  )
}

function variantCsv(rows: DecisionResult[]): string {
  return csv(
    ['state', 'group', 'seed', 'variant', 'activated', 'selected', 'score', 'includesRaw'],
    rows.flatMap((row) =>
      row.variants.map((variant) => [
        row.state,
        row.group,
        row.seed,
        variant.variant,
        variant.activated,
        variant.selected,
        variant.selectedScore,
        variant.includesRawWinner,
      ]),
    ),
  )
}

function csv(headers: string[], rows: Array<Array<string | number | boolean>>): string {
  return `${headers.join(',')}\n${rows.map((row) => row.map((cell) => JSON.stringify(cell)).join(',')).join('\n')}\n`
}
