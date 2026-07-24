import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { choosePlayableMCTSDecision } from '@/agents/mctsWorkerDecision'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import { applyFullAction } from '@/engine/gameSimulator'
import type { MCTSConfig } from '@/engine/mcts/types'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'
import { deserializeGameSnapshot, type HumanMCTSDecisionFixtureV1 } from '@/utils/humanMCTSTrace'
import { getTerritoryCounts } from './compareLearningAgents'
import { wilson95 } from './evaluateMCTSTacticalConfirmation'

export const COUNTERFACTUAL_VERSION = 'human-mcts-counterfactual-pilot-v1'
export const DEFAULT_BUDGETS = Object.freeze([50, 100, 250, 500, 1000])
export const DEFAULT_SELECTION_SEEDS = Object.freeze(
  Array.from({ length: 20 }, (_, index) => 417_460 + index),
)
export const DEFAULT_MATCH_SEEDS = Object.freeze([517_460, 517_461])
export const DEFAULT_REFERENCE_SIMULATIONS = 250
export const DEFAULT_MAX_TURNS = 250
export const DEFAULT_OUTPUT_DIR = path.join(
  'data',
  'entrenamiento',
  'mcts',
  'evaluacion_contrafactual_humano_g_41746ecd',
)

export type DecisionClassification =
  | 'stable'
  | 'budget-sensitive'
  | 'seed-sensitive'
  | 'tactical-improvement-supported'
  | 'possible-suboptimal-action'
  | 'inconclusive'

export interface LoadedCounterfactualFixture {
  id: string
  filePath: string
  fixture: HumanMCTSDecisionFixtureV1
}

export interface SelectionObservation {
  fixtureId: string
  turnIndex: number
  budget: number
  seed: number
  actionKey: string
  action: PlayerAction
  visits: number
  value: number
  rootVisits: number
  elapsedMs: number
}

export interface CandidateAction {
  key: string
  action: PlayerAction
  sources: string[]
}

export interface CounterfactualMatch {
  fixtureId: string
  turnIndex: number
  candidateKey: string
  candidateAction: PlayerAction
  pairSeed: number
  winner: Player | 'tie'
  outcome: 'win' | 'loss' | 'tie'
  territoryCandidate: number
  territoryOpponent: number
  territoryDiff: number
  turns: number
  reachedTurnLimit: boolean
  durationMs: number
}

export interface CounterfactualOptions {
  budgets?: readonly number[]
  selectionSeeds?: readonly number[]
  matchSeeds?: readonly number[]
  referenceSimulations?: number
  maxTurns?: number
  outputDir?: string
  writeResults?: boolean
  now?: () => number
  chooseDecision?: typeof choosePlayableMCTSDecision
}

function round(value: number): number {
  return Number(value.toFixed(4))
}

function opponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function normalizeAction(action: PlayerAction): PlayerAction {
  const copy = JSON.parse(JSON.stringify(action)) as PlayerAction
  const visit = (current: PlayerAction): void => {
    if (
      current.type === 'wall' &&
      current.from?.x === current.pos.x &&
      current.from.y === current.pos.y
    )
      delete current.from
    if (current.followUp) visit(current.followUp)
  }
  visit(copy)
  return copy
}

export function structuralActionKey(action: PlayerAction): string {
  return JSON.stringify(normalizeAction(action))
}

export function deduplicateCandidateActions(
  entries: readonly { action: PlayerAction | undefined; source: string }[],
): CandidateAction[] {
  const candidates = new Map<string, CandidateAction>()
  for (const entry of entries) {
    if (!entry.action) continue
    const action = normalizeAction(entry.action)
    const key = structuralActionKey(action)
    const existing = candidates.get(key)
    if (existing) {
      if (!existing.sources.includes(entry.source)) existing.sources.push(entry.source)
    } else {
      candidates.set(key, { key, action, sources: [entry.source] })
    }
  }
  return Array.from(candidates.values())
}

export function loadCounterfactualFixture(filePath: string): LoadedCounterfactualFixture {
  const resolved = path.resolve(filePath)
  const fixture = JSON.parse(readFileSync(resolved, 'utf8')) as HumanMCTSDecisionFixtureV1
  if (fixture.schema !== 'HumanMCTSDecisionFixtureV1')
    throw new Error(`Invalid fixture schema: ${resolved}`)
  if (fixture.actor !== 'mcts' || !fixture.mcts)
    throw new Error(`Counterfactual evaluation only accepts MCTS fixtures: ${resolved}`)
  if (fixture.player !== fixture.stateBefore.turn)
    throw new Error(`Fixture player does not match state turn: ${resolved}`)
  const legal = fixture.legalActions.map(structuralActionKey)
  if (!legal.includes(structuralActionKey(fixture.action)))
    throw new Error(`Fixture action is not legal: ${resolved}`)
  return {
    id: `${path.basename(resolved, '.fixture.json')}`,
    filePath: resolved,
    fixture,
  }
}

export function selectionSeed(baseSeed: number, budget: number): number {
  return (baseSeed ^ Math.imul(budget, 0x45d9f3b)) >>> 0
}

export function buildCandidates(
  fixture: HumanMCTSDecisionFixtureV1,
  observations: readonly SelectionObservation[],
  highBudgets: readonly number[],
): CandidateAction[] {
  const ranked = [...(fixture.mcts?.rootCandidates ?? [])].sort(
    (left, right) => right.visits - left.visits || right.value - left.value,
  )
  const highWinners = highBudgets.map((budget) => {
    const rows = observations.filter((row) => row.budget === budget)
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.actionKey, (counts.get(row.actionKey) ?? 0) + 1)
    const key = Array.from(counts.entries()).sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0]
    return {
      action: rows.find((row) => row.actionKey === key)?.action,
      source: `high-budget-modal-${budget}`,
    }
  })
  return deduplicateCandidateActions([
    { action: fixture.action, source: 'final-played' },
    { action: fixture.mcts?.originalAction, source: 'original-pre-tactical' },
    { action: ranked[0]?.action, source: 'recorded-root-1' },
    { action: ranked[1]?.action, source: 'recorded-root-2' },
    ...highWinners,
  ])
}

export async function collectSelectionObservations(
  loaded: LoadedCounterfactualFixture,
  options: CounterfactualOptions = {},
): Promise<SelectionObservation[]> {
  const budgets = options.budgets ?? DEFAULT_BUDGETS
  const seeds = options.selectionSeeds ?? DEFAULT_SELECTION_SEEDS
  const choose = options.chooseDecision ?? choosePlayableMCTSDecision
  const now = options.now ?? (() => performance.now())
  const state = deserializeGameSnapshot(loaded.fixture.stateBefore)
  const rows: SelectionObservation[] = []
  for (const budget of budgets) {
    const config: MCTSConfig = { ...FINAL_MCTS_CONFIG, simulations: budget }
    for (const baseSeed of seeds) {
      const startedAt = now()
      const result = choose({ gameState: state, config, seed: selectionSeed(baseSeed, budget) })
      const elapsedMs = now() - startedAt
      const child = result.children.find(
        (candidate) => structuralActionKey(candidate.action) === structuralActionKey(result.action),
      )
      rows.push({
        fixtureId: loaded.id,
        turnIndex: loaded.fixture.source.turnIndex,
        budget,
        seed: selectionSeed(baseSeed, budget),
        actionKey: structuralActionKey(result.action),
        action: normalizeAction(result.action),
        visits: child?.visits ?? result.visits,
        value: child?.value ?? result.value,
        rootVisits: result.rootVisits,
        elapsedMs: round(elapsedMs),
      })
    }
  }
  return rows
}

function isLegal(action: PlayerAction, state: GameSnapshot): boolean {
  const key = structuralActionKey(action)
  return getLegalActions(state).some((candidate) => structuralActionKey(candidate) === key)
}

export async function runCounterfactualMatch(
  loaded: LoadedCounterfactualFixture,
  candidate: CandidateAction,
  pairSeed: number,
  options: CounterfactualOptions = {},
): Promise<CounterfactualMatch> {
  const choose = options.chooseDecision ?? choosePlayableMCTSDecision
  const now = options.now ?? (() => performance.now())
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const referenceSimulations = options.referenceSimulations ?? DEFAULT_REFERENCE_SIMULATIONS
  const config: MCTSConfig = { ...FINAL_MCTS_CONFIG, simulations: referenceSimulations }
  const candidatePlayer = loaded.fixture.player
  let state = deserializeGameSnapshot(loaded.fixture.stateBefore)
  if (!isLegal(candidate.action, state)) throw new Error(`Candidate is illegal: ${candidate.key}`)
  const startedAt = now()
  let turns = 0
  state = applyFullAction(state, candidate.action).state
  turns++
  const counters: Record<Player, number> = { R: 0, B: 0 }
  while (state.phase !== 'finished' && !state.result && turns < maxTurns) {
    const player = state.turn
    const colorSalt = player === 'R' ? 0x243f6a88 : 0x9e3779b9
    const seed = (pairSeed + colorSalt + Math.imul(counters[player]++, 0x6d2b79f5)) >>> 0
    const result = choose({ gameState: state, config, seed })
    if (!isLegal(result.action, state)) throw new Error('Reference MCTS returned an illegal action')
    state = applyFullAction(state, result.action).state
    turns++
  }
  const reachedTurnLimit = turns >= maxTurns && state.phase !== 'finished' && !state.result
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const candidateTerritory = territory[candidatePlayer]
  const opponentTerritory = territory[opponent(candidatePlayer)]
  const winner: Player | 'tie' = state.result?.tie
    ? 'tie'
    : (state.result?.winner ??
      (territory.R === territory.B ? 'tie' : territory.R > territory.B ? 'R' : 'B'))
  return {
    fixtureId: loaded.id,
    turnIndex: loaded.fixture.source.turnIndex,
    candidateKey: candidate.key,
    candidateAction: candidate.action,
    pairSeed,
    winner,
    outcome: winner === 'tie' ? 'tie' : winner === candidatePlayer ? 'win' : 'loss',
    territoryCandidate: candidateTerritory,
    territoryOpponent: opponentTerritory,
    territoryDiff: candidateTerritory - opponentTerritory,
    turns,
    reachedTurnLimit,
    durationMs: round(now() - startedAt),
  }
}

export function aggregateCounterfactualMatches(rows: readonly CounterfactualMatch[]) {
  const groups = new Map<string, CounterfactualMatch[]>()
  for (const row of rows)
    groups.set(row.candidateKey, [...(groups.get(row.candidateKey) ?? []), row])
  return Array.from(groups.entries()).map(([candidateKey, matches]) => {
    const games = matches.length
    const wins = matches.filter((row) => row.outcome === 'win').length
    const losses = matches.filter((row) => row.outcome === 'loss').length
    const ties = games - wins - losses
    const average = (pick: (row: CounterfactualMatch) => number) =>
      round(matches.reduce((sum, row) => sum + pick(row), 0) / games)
    return {
      candidateKey,
      action: matches[0]!.candidateAction,
      games,
      wins,
      losses,
      ties,
      winRate: round(wins / games),
      winRateCI95: wilson95(wins, games),
      averageTerritory: average((row) => row.territoryCandidate),
      averageTerritoryDiff: average((row) => row.territoryDiff),
      averageDurationMs: average((row) => row.durationMs),
    }
  })
}

export function summarizeBudgetStability(rows: readonly SelectionObservation[]) {
  const budgets = Array.from(new Set(rows.map((row) => row.budget))).sort((a, b) => a - b)
  return budgets.map((budget) => {
    const selected = rows.filter((row) => row.budget === budget)
    const counts = new Map<string, number>()
    for (const row of selected) counts.set(row.actionKey, (counts.get(row.actionKey) ?? 0) + 1)
    const ranking = Array.from(counts.entries()).sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    const modalKey = ranking[0]?.[0] ?? ''
    const modalRows = selected.filter((row) => row.actionKey === modalKey)
    return {
      budget,
      seeds: selected.length,
      uniqueActions: counts.size,
      modalActionKey: modalKey,
      modalFrequency: selected.length ? round(modalRows.length / selected.length) : 0,
      averageVisits: modalRows.length
        ? round(modalRows.reduce((sum, row) => sum + row.visits, 0) / modalRows.length)
        : 0,
      averageValue: modalRows.length
        ? round(modalRows.reduce((sum, row) => sum + row.value, 0) / modalRows.length)
        : 0,
      averageElapsedMs: selected.length
        ? round(selected.reduce((sum, row) => sum + row.elapsedMs, 0) / selected.length)
        : 0,
    }
  })
}

export function classifyDecision(params: {
  finalActionKey: string
  originalActionKey?: string
  stability: ReturnType<typeof summarizeBudgetStability>
  aggregates: ReturnType<typeof aggregateCounterfactualMatches>
}): DecisionClassification[] {
  const categories = new Set<DecisionClassification>()
  const modalKeys = new Set(params.stability.map((row) => row.modalActionKey))
  const minimumFrequency = Math.min(...params.stability.map((row) => row.modalFrequency))
  if (modalKeys.size === 1 && minimumFrequency >= 0.7) categories.add('stable')
  if (modalKeys.size > 1) categories.add('budget-sensitive')
  if (minimumFrequency < 0.6) categories.add('seed-sensitive')
  const final = params.aggregates.find((row) => row.candidateKey === params.finalActionKey)
  const original = params.aggregates.find((row) => row.candidateKey === params.originalActionKey)
  if (
    final &&
    original &&
    final.winRate >= original.winRate &&
    final.averageTerritoryDiff >= original.averageTerritoryDiff + 2
  )
    categories.add('tactical-improvement-supported')
  if (final) {
    const better = params.aggregates.find(
      (row) =>
        row.candidateKey !== final.candidateKey &&
        row.games >= 2 &&
        row.wins >= 2 &&
        row.losses === 0 &&
        row.winRate >= final.winRate + 0.15 &&
        row.averageTerritoryDiff >= final.averageTerritoryDiff + 2,
    )
    if (better) categories.add('possible-suboptimal-action')
  }
  if (categories.size === 0) categories.add('inconclusive')
  return Array.from(categories)
}

function csvEscape(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return `"${text.split('"').join('""')}"`
}

function writeCsv<T extends object>(filePath: string, rows: readonly T[]): void {
  if (!rows.length) return writeFileSync(filePath, '', 'utf8')
  const headers = Object.keys(rows[0] as object)
  writeFileSync(
    filePath,
    `${headers.join(',')}\n${rows
      .map((row) =>
        headers.map((key) => csvEscape((row as Record<string, unknown>)[key])).join(','),
      )
      .join('\n')}\n`,
    'utf8',
  )
}

export async function evaluateHumanMCTSCounterfactual(
  fixturePaths: readonly string[],
  options: CounterfactualOptions = {},
) {
  const startedAt = performance.now()
  const loadedFixtures = fixturePaths.map(loadCounterfactualFixture)
  const allSelections: SelectionObservation[] = []
  const allMatches: CounterfactualMatch[] = []
  const decisions = []
  for (const loaded of loadedFixtures) {
    const selections = await collectSelectionObservations(loaded, options)
    allSelections.push(...selections)
    const budgets = options.budgets ?? DEFAULT_BUDGETS
    const highBudgets = budgets.slice(-2)
    const candidates = buildCandidates(loaded.fixture, selections, highBudgets)
    const matches: CounterfactualMatch[] = []
    for (const pairSeed of options.matchSeeds ?? DEFAULT_MATCH_SEEDS)
      for (const candidate of candidates)
        matches.push(await runCounterfactualMatch(loaded, candidate, pairSeed, options))
    allMatches.push(...matches)
    const stability = summarizeBudgetStability(selections)
    const aggregates = aggregateCounterfactualMatches(matches)
    const finalKey = structuralActionKey(loaded.fixture.action)
    const originalKey = loaded.fixture.mcts?.originalAction
      ? structuralActionKey(loaded.fixture.mcts.originalAction)
      : undefined
    decisions.push({
      fixtureId: loaded.id,
      turnIndex: loaded.fixture.source.turnIndex,
      player: loaded.fixture.player,
      candidates,
      stability,
      aggregates,
      classifications: classifyDecision({
        finalActionKey: finalKey,
        originalActionKey: originalKey,
        stability,
        aggregates,
      }),
    })
  }
  const summary = {
    schema: 'HumanMCTSCounterfactualSummaryV1',
    evaluatorVersion: COUNTERFACTUAL_VERSION,
    mode: 'pilot',
    generatedAt: new Date().toISOString(),
    design: {
      budgets: options.budgets ?? DEFAULT_BUDGETS,
      selectionSeeds: options.selectionSeeds ?? DEFAULT_SELECTION_SEEDS,
      pairedMatchSeeds: options.matchSeeds ?? DEFAULT_MATCH_SEEDS,
      referenceSimulations: options.referenceSimulations ?? DEFAULT_REFERENCE_SIMULATIONS,
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      configRule: 'FINAL_MCTS_CONFIG copied with simulations as the only override.',
    },
    durationMs: round(performance.now() - startedAt),
    decisions,
    disclaimer:
      'Pilot classifications are provisional; signals do not prove an action was erroneous.',
  }
  if (options.writeResults !== false) {
    const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR)
    mkdirSync(outputDir, { recursive: true })
    for (const decision of decisions) {
      const dir = path.join(outputDir, decision.fixtureId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(decision, null, 2)}\n`)
    }
    writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    writeCsv(
      path.join(outputDir, 'budget_stability.csv'),
      decisions.flatMap((decision) =>
        decision.stability.map((row) => ({
          fixtureId: decision.fixtureId,
          turnIndex: decision.turnIndex,
          ...row,
        })),
      ),
    )
    writeCsv(path.join(outputDir, 'counterfactual_matches.csv'), allMatches)
    writeCsv(
      path.join(outputDir, 'decision_comparison.csv'),
      decisions.flatMap((decision) =>
        decision.aggregates.map((row) => ({
          fixtureId: decision.fixtureId,
          turnIndex: decision.turnIndex,
          classifications: decision.classifications,
          ...row,
        })),
      ),
    )
    const report = [
      '# Evaluación contrafactual piloto humano–MCTS g_41746ecd',
      '',
      '> Resultados provisionales: no demuestran por sí solos que una acción sea un error.',
      '',
      `- Duración: ${summary.durationMs} ms`,
      `- Presupuestos: ${summary.design.budgets.join(', ')}`,
      `- Semillas por presupuesto: ${summary.design.selectionSeeds.length}`,
      `- Semillas emparejadas contrafactuales: ${summary.design.pairedMatchSeeds.length}`,
      `- Presupuesto MCTS de referencia: ${summary.design.referenceSimulations}`,
      '',
      ...decisions.flatMap((decision) => [
        `## ${decision.fixtureId} — turno ${decision.turnIndex}`,
        '',
        `- Clasificación provisional: ${decision.classifications.join(', ')}`,
        `- Acciones candidatas: ${decision.candidates.length}`,
        `- Modales por presupuesto: ${decision.stability.map((row) => `${row.budget}:${row.modalFrequency}`).join('; ')}`,
        '',
        ...decision.aggregates.map(
          (row) =>
            `- ${row.candidateKey}: ${row.wins}-${row.losses}-${row.ties}, territorio medio ${row.averageTerritory}, diferencia ${row.averageTerritoryDiff}, IC95 victoria ${row.winRateCI95.low}–${row.winRateCI95.high}%`,
        ),
        '',
      ]),
      '## Interpretación',
      '',
      'La confirmación extensa debe decidirse después de valorar el coste del piloto, la separación de los intervalos y la estabilidad de las alternativas.',
      '',
    ].join('\n')
    writeFileSync(path.join(outputDir, 'report.md'), report, 'utf8')
  }
  return { summary, selections: allSelections, matches: allMatches }
}

async function main(): Promise<void> {
  const fixturePaths = process.argv.slice(2)
  if (!fixturePaths.length)
    throw new Error('Usage: npm run evaluate:human-mcts-counterfactual -- <fixture...>')
  for (const fixturePath of fixturePaths)
    if (!existsSync(fixturePath)) throw new Error(`Fixture not found: ${fixturePath}`)
  const result = await evaluateHumanMCTSCounterfactual(fixturePaths)
  console.log(
    JSON.stringify({ outputDir: path.resolve(DEFAULT_OUTPUT_DIR), ...result.summary }, null, 2),
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
