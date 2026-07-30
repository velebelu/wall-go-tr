import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PlayerAction } from '@/lib/types'
import {
  loadCounterfactualFixture,
  runCounterfactualMatch,
  structuralActionKey,
  type CandidateAction,
  type CounterfactualMatch,
  type CounterfactualOptions,
  type LoadedCounterfactualFixture,
} from './evaluateHumanMCTSCounterfactual'
import { wilson95 } from './evaluateMCTSTacticalConfirmation'

export const TURN_10_CONFIRMATION_VERSION = 'human-mcts-turn-10-confirmation-v1'
export const TURN_10_FIXTURE_ID = '3_turn_10_mcts_5'
export const TURN_10_GAME_ID = 'g_41746ecd'
export const TURN_10_INDEX = 10
export const TURN_10_REFERENCE_SIMULATIONS = 250
export const TURN_10_PAIR_SEEDS = Object.freeze(
  Array.from({ length: 20 }, (_, index) => 617_460 + index),
)
export const TURN_10_OUTPUT_DIR = path.join(
  'data',
  'entrenamiento',
  'mcts',
  'confirmacion_turno_10_humano_g_41746ecd',
)

export const TURN_10_FINAL_ACTION: PlayerAction = Object.freeze<PlayerAction>({
  type: 'move',
  from: { x: 5, y: 5 },
  pos: { x: 5, y: 4 },
  followUp: { type: 'wall', pos: { x: 5, y: 4 }, dir: 'left' },
})
export const TURN_10_ORIGINAL_ACTION: PlayerAction = Object.freeze<PlayerAction>({
  type: 'move',
  from: { x: 5, y: 5 },
  pos: { x: 4, y: 5 },
  followUp: { type: 'wall', pos: { x: 4, y: 5 }, dir: 'top' },
})

export type ConfirmedActionName = 'final' | 'original'
export type Turn10Classification =
  | 'original-supported'
  | 'final-supported'
  | 'inconclusive'
  | 'possible-tactical-regression'

export interface NamedConfirmationMatch extends CounterfactualMatch {
  actionName: ConfirmedActionName
}

export interface Turn10Progress {
  schema: 'HumanMCTSTurn10ProgressV1'
  evaluatorVersion: typeof TURN_10_CONFIRMATION_VERSION
  fixtureId: typeof TURN_10_FIXTURE_ID
  plannedSeeds: readonly number[]
  completedSeeds: number[]
  matches: NamedConfirmationMatch[]
  startedAt: string
  updatedAt: string
  durationMsAccumulated: number
  complete: boolean
}

export interface Turn10ConfirmationOptions
  extends Pick<
    CounterfactualOptions,
    'chooseDecision' | 'maxTurns' | 'now' | 'referenceSimulations'
  > {
  outputDir?: string
  seeds?: readonly number[]
  onProgress?: (message: string) => void
  shouldAbort?: () => boolean
  runMatch?: typeof runCounterfactualMatch
}

function round(value: number): number {
  return Number(value.toFixed(4))
}

function median(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1),
  )
}

function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function bootstrapMeanCI95(
  values: readonly number[],
  iterations = 10_000,
  seed = 710_010,
): { low: number; high: number; iterations: number; seed: number } {
  if (!values.length) return { low: 0, high: 0, iterations, seed }
  const rng = createRng(seed)
  const samples: number[] = []
  for (let iteration = 0; iteration < iterations; iteration++) {
    let total = 0
    for (let index = 0; index < values.length; index++)
      total += values[Math.floor(rng() * values.length)]!
    samples.push(total / values.length)
  }
  samples.sort((a, b) => a - b)
  return {
    low: round(samples[Math.floor(iterations * 0.025)]!),
    high: round(samples[Math.min(iterations - 1, Math.floor(iterations * 0.975))]!),
    iterations,
    seed,
  }
}

function combination(n: number, k: number): number {
  let result = 1
  for (let index = 1; index <= k; index++) result = (result * (n - index + 1)) / index
  return result
}

export function exactTwoSidedSignTest(positive: number, negative: number) {
  const n = positive + negative
  if (!n) return { positive, negative, tiesExcluded: 0, pValue: 1 }
  const smaller = Math.min(positive, negative)
  let tail = 0
  for (let k = 0; k <= smaller; k++) tail += combination(n, k) * 0.5 ** n
  return { positive, negative, tiesExcluded: 0, pValue: round(Math.min(1, 2 * tail)) }
}

export function validateTurn10Fixture(filePath: string): LoadedCounterfactualFixture {
  const loaded = loadCounterfactualFixture(filePath)
  if (
    loaded.fixture.source.gameId !== TURN_10_GAME_ID ||
    loaded.fixture.source.turnIndex !== TURN_10_INDEX ||
    loaded.id !== TURN_10_FIXTURE_ID
  )
    throw new Error('Expected the g_41746ecd turn-10 MCTS fixture')
  if (structuralActionKey(loaded.fixture.action) !== structuralActionKey(TURN_10_FINAL_ACTION))
    throw new Error('Fixture final action does not match the defined turn-10 final action')
  if (
    !loaded.fixture.mcts?.originalAction ||
    structuralActionKey(loaded.fixture.mcts.originalAction) !==
      structuralActionKey(TURN_10_ORIGINAL_ACTION)
  )
    throw new Error('Fixture original action does not match the defined turn-10 original action')
  return loaded
}

export function confirmationCandidates(): Readonly<Record<ConfirmedActionName, CandidateAction>> {
  return Object.freeze({
    final: {
      key: structuralActionKey(TURN_10_FINAL_ACTION),
      action: TURN_10_FINAL_ACTION,
      sources: ['final-played'],
    },
    original: {
      key: structuralActionKey(TURN_10_ORIGINAL_ACTION),
      action: TURN_10_ORIGINAL_ACTION,
      sources: ['original-pre-tactical'],
    },
  })
}

function emptyProgress(seeds: readonly number[]): Turn10Progress {
  const now = new Date().toISOString()
  return {
    schema: 'HumanMCTSTurn10ProgressV1',
    evaluatorVersion: TURN_10_CONFIRMATION_VERSION,
    fixtureId: TURN_10_FIXTURE_ID,
    plannedSeeds: [...seeds],
    completedSeeds: [],
    matches: [],
    startedAt: now,
    updatedAt: now,
    durationMsAccumulated: 0,
    complete: false,
  }
}

export function loadProgress(outputDir: string, seeds: readonly number[]): Turn10Progress {
  const progressPath = path.join(outputDir, 'progress.json')
  if (!existsSync(progressPath)) return emptyProgress(seeds)
  const progress = JSON.parse(readFileSync(progressPath, 'utf8')) as Turn10Progress
  if (
    progress.schema !== 'HumanMCTSTurn10ProgressV1' ||
    JSON.stringify(progress.plannedSeeds) !== JSON.stringify(seeds)
  )
    throw new Error('Existing progress is incompatible with the requested confirmation plan')
  const uniqueMatches = new Set(progress.matches.map((row) => `${row.pairSeed}:${row.actionName}`))
  if (uniqueMatches.size !== progress.matches.length)
    throw new Error('Existing progress contains duplicate matches')
  for (const seed of progress.completedSeeds) {
    if (
      !progress.matches.some((row) => row.pairSeed === seed && row.actionName === 'final') ||
      !progress.matches.some((row) => row.pairSeed === seed && row.actionName === 'original')
    )
      throw new Error(`Completed seed ${seed} does not contain an exact action pair`)
  }
  return progress
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

export function aggregateActionMatches(rows: readonly NamedConfirmationMatch[]) {
  const games = rows.length
  const wins = rows.filter((row) => row.outcome === 'win').length
  const losses = rows.filter((row) => row.outcome === 'loss').length
  const ties = games - wins - losses
  const own = rows.map((row) => row.territoryCandidate)
  const rival = rows.map((row) => row.territoryOpponent)
  const differences = rows.map((row) => row.territoryDiff)
  const durations = rows.map((row) => row.durationMs)
  const mean = (values: readonly number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  return {
    games,
    wins,
    losses,
    ties,
    winRate: games ? round(wins / games) : 0,
    winRateCI95: wilson95(wins, games),
    averageOwnTerritory: round(mean(own)),
    averageOpponentTerritory: round(mean(rival)),
    averageTerritoryDiff: round(mean(differences)),
    medianOwnTerritory: round(median(own)),
    medianOpponentTerritory: round(median(rival)),
    medianTerritoryDiff: round(median(differences)),
    territoryDiffStandardDeviation: round(sampleStandardDeviation(differences)),
    averageDurationMs: round(mean(durations)),
    totalDurationMs: round(durations.reduce((sum, value) => sum + value, 0)),
  }
}

function outcomeScore(outcome: NamedConfirmationMatch['outcome']): number {
  return outcome === 'win' ? 1 : outcome === 'tie' ? 0.5 : 0
}

export function buildPairedComparison(rows: readonly NamedConfirmationMatch[]) {
  const seeds = Array.from(new Set(rows.map((row) => row.pairSeed))).sort((a, b) => a - b)
  const pairs = seeds.flatMap((seed) => {
    const final = rows.find((row) => row.pairSeed === seed && row.actionName === 'final')
    const original = rows.find((row) => row.pairSeed === seed && row.actionName === 'original')
    if (!final || !original) return []
    const resultDelta = outcomeScore(original.outcome) - outcomeScore(final.outcome)
    const territoryDelta = original.territoryDiff - final.territoryDiff
    return [
      {
        seed,
        finalOutcome: final.outcome,
        originalOutcome: original.outcome,
        finalTerritoryDiff: final.territoryDiff,
        originalTerritoryDiff: original.territoryDiff,
        resultDelta,
        territoryDelta,
        preferred:
          resultDelta > 0 || (resultDelta === 0 && territoryDelta > 0)
            ? ('original' as const)
            : resultDelta < 0 || territoryDelta < 0
              ? ('final' as const)
              : ('tie' as const),
      },
    ]
  })
  const territoryDeltas = pairs.map((row) => row.territoryDelta)
  const originalPreferred = pairs.filter((row) => row.preferred === 'original').length
  const finalPreferred = pairs.filter((row) => row.preferred === 'final').length
  const tied = pairs.length - originalPreferred - finalPreferred
  const originalOutcomeBetter = pairs.filter((row) => row.resultDelta > 0).length
  const finalOutcomeBetter = pairs.filter((row) => row.resultDelta < 0).length
  const equalOutcomes = pairs.length - originalOutcomeBetter - finalOutcomeBetter
  return {
    pairs,
    summary: {
      pairs: pairs.length,
      originalPreferred,
      finalPreferred,
      tied,
      originalOutcomeBetter,
      finalOutcomeBetter,
      equalOutcomes,
      averageTerritoryDelta: round(
        territoryDeltas.reduce((sum, value) => sum + value, 0) /
          Math.max(1, territoryDeltas.length),
      ),
      medianTerritoryDelta: round(median(territoryDeltas)),
      bootstrapMeanCI95: bootstrapMeanCI95(territoryDeltas),
      signTest: exactTwoSidedSignTest(originalPreferred, finalPreferred),
    },
  }
}

export function classifyTurn10(
  finalAggregate: ReturnType<typeof aggregateActionMatches>,
  originalAggregate: ReturnType<typeof aggregateActionMatches>,
  paired: ReturnType<typeof buildPairedComparison>['summary'],
): Turn10Classification {
  const originalConsistent =
    paired.originalPreferred > paired.finalPreferred &&
    originalAggregate.winRate > finalAggregate.winRate &&
    paired.averageTerritoryDelta > 0
  const finalConsistent =
    paired.finalPreferred > paired.originalPreferred &&
    finalAggregate.winRate > originalAggregate.winRate &&
    paired.averageTerritoryDelta < 0
  if (originalConsistent && paired.bootstrapMeanCI95.low > 0 && paired.signTest.pValue < 0.05)
    return 'possible-tactical-regression'
  if (originalConsistent && (paired.bootstrapMeanCI95.low > 0 || paired.signTest.pValue < 0.1))
    return 'original-supported'
  if (finalConsistent && (paired.bootstrapMeanCI95.high < 0 || paired.signTest.pValue < 0.1))
    return 'final-supported'
  return 'inconclusive'
}

function persistProgress(outputDir: string, progress: Turn10Progress): void {
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(path.join(outputDir, 'progress.json'), `${JSON.stringify(progress, null, 2)}\n`)
  writeCsv(path.join(outputDir, 'matches.csv'), progress.matches)
}

export function writeFinalArtifacts(outputDir: string, progress: Turn10Progress) {
  const finalRows = progress.matches.filter((row) => row.actionName === 'final')
  const originalRows = progress.matches.filter((row) => row.actionName === 'original')
  const finalAggregate = aggregateActionMatches(finalRows)
  const originalAggregate = aggregateActionMatches(originalRows)
  const paired = buildPairedComparison(progress.matches)
  const classification = classifyTurn10(finalAggregate, originalAggregate, paired.summary)
  const summary = {
    schema: 'HumanMCTSTurn10ConfirmationSummaryV1',
    evaluatorVersion: TURN_10_CONFIRMATION_VERSION,
    fixtureId: TURN_10_FIXTURE_ID,
    complete: progress.complete,
    classification,
    actions: { final: finalAggregate, original: originalAggregate },
    paired: paired.summary,
    disclaimer:
      'This comparison can support a tactical-regression hypothesis but does not label an action as an error.',
  }
  writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeCsv(path.join(outputDir, 'paired_results.csv'), paired.pairs)
  const metadata = {
    schema: 'HumanMCTSTurn10ConfirmationMetadataV1',
    evaluatorVersion: TURN_10_CONFIRMATION_VERSION,
    fixtureId: TURN_10_FIXTURE_ID,
    gameId: TURN_10_GAME_ID,
    turnIndex: TURN_10_INDEX,
    referenceSimulations: TURN_10_REFERENCE_SIMULATIONS,
    seeds: progress.plannedSeeds,
    completedSeeds: progress.completedSeeds,
    matches: progress.matches.length,
    durationMsAccumulated: progress.durationMsAccumulated,
    configRule: 'FINAL_MCTS_CONFIG copied with simulations as the only override.',
    finalAction: TURN_10_FINAL_ACTION,
    originalAction: TURN_10_ORIGINAL_ACTION,
  }
  writeFileSync(path.join(outputDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  const report = [
    '# Confirmación contrafactual — turno 10, g_41746ecd',
    '',
    '> No se utiliza la palabra «error»: la clasificación expresa evidencia comparativa.',
    '',
    `- Completa: ${progress.complete ? 'sí' : 'no'}`,
    `- Pares: ${paired.summary.pairs}/${progress.plannedSeeds.length}`,
    `- Duración acumulada: ${progress.durationMsAccumulated} ms`,
    `- Clasificación: **${classification}**`,
    '',
    '## Acción final',
    '',
    `- W-L-T: ${finalAggregate.wins}-${finalAggregate.losses}-${finalAggregate.ties}`,
    `- Tasa de victoria: ${finalAggregate.winRate}`,
    `- IC95 Wilson: ${finalAggregate.winRateCI95.low}–${finalAggregate.winRateCI95.high}%`,
    `- Diferencia territorial media: ${finalAggregate.averageTerritoryDiff}`,
    '',
    '## Acción original',
    '',
    `- W-L-T: ${originalAggregate.wins}-${originalAggregate.losses}-${originalAggregate.ties}`,
    `- Tasa de victoria: ${originalAggregate.winRate}`,
    `- IC95 Wilson: ${originalAggregate.winRateCI95.low}–${originalAggregate.winRateCI95.high}%`,
    `- Diferencia territorial media: ${originalAggregate.averageTerritoryDiff}`,
    '',
    '## Comparación emparejada',
    '',
    `- Prefiere original: ${paired.summary.originalPreferred}`,
    `- Prefiere final: ${paired.summary.finalPreferred}`,
    `- Empates: ${paired.summary.tied}`,
    `- Resultado puro mejor para original: ${paired.summary.originalOutcomeBetter}`,
    `- Resultado puro mejor para final: ${paired.summary.finalOutcomeBetter}`,
    `- Resultado puro igual: ${paired.summary.equalOutcomes}`,
    `- Diferencia territorial emparejada media: ${paired.summary.averageTerritoryDelta}`,
    `- Mediana: ${paired.summary.medianTerritoryDelta}`,
    `- Bootstrap IC95: ${paired.summary.bootstrapMeanCI95.low}–${paired.summary.bootstrapMeanCI95.high}`,
    `- Sign test bilateral: p=${paired.summary.signTest.pValue}`,
    '',
  ].join('\n')
  writeFileSync(path.join(outputDir, 'report.md'), report, 'utf8')
  return summary
}

export async function confirmHumanMCTSTurn10(
  fixturePath: string,
  options: Turn10ConfirmationOptions = {},
) {
  const loaded = validateTurn10Fixture(fixturePath)
  const seeds = options.seeds ?? TURN_10_PAIR_SEEDS
  if (seeds.length > 20) throw new Error('Turn-10 confirmation cannot exceed 20 seed pairs')
  if (new Set(seeds).size !== seeds.length) throw new Error('Confirmation seeds must be unique')
  const outputDir = path.resolve(options.outputDir ?? TURN_10_OUTPUT_DIR)
  const progress = loadProgress(outputDir, seeds)
  const candidates = confirmationCandidates()
  const runMatch = options.runMatch ?? runCounterfactualMatch
  const now = options.now ?? (() => performance.now())
  for (const seed of seeds) {
    if (progress.completedSeeds.includes(seed)) {
      options.onProgress?.(`seed ${seed}: already complete, skipping`)
      continue
    }
    if (options.shouldAbort?.()) break
    const pairStartedAt = now()
    const final = await runMatch(loaded, candidates.final, seed, {
      ...options,
      referenceSimulations: TURN_10_REFERENCE_SIMULATIONS,
    })
    const original = await runMatch(loaded, candidates.original, seed, {
      ...options,
      referenceSimulations: TURN_10_REFERENCE_SIMULATIONS,
    })
    progress.matches.push(
      { ...final, actionName: 'final' },
      { ...original, actionName: 'original' },
    )
    progress.completedSeeds.push(seed)
    progress.durationMsAccumulated = round(progress.durationMsAccumulated + (now() - pairStartedAt))
    progress.updatedAt = new Date().toISOString()
    progress.complete = progress.completedSeeds.length === seeds.length
    persistProgress(outputDir, progress)
    writeFinalArtifacts(outputDir, progress)
    options.onProgress?.(
      `seed ${seed}: ${progress.completedSeeds.length}/${seeds.length} pairs, ` +
        `${progress.matches.length}/40 matches, ${progress.durationMsAccumulated} ms`,
    )
  }
  progress.complete = progress.completedSeeds.length === seeds.length
  persistProgress(outputDir, progress)
  return { progress, summary: writeFinalArtifacts(outputDir, progress) }
}

async function main(): Promise<void> {
  const fixturePath = process.argv[2]
  if (!fixturePath) throw new Error('Usage: npm run confirm:human-mcts-turn-10 -- <fixture>')
  let abortRequested = false
  const requestAbort = () => {
    abortRequested = true
    console.log('Abort requested; the current pair will finish and remain persisted.')
  }
  process.once('SIGINT', requestAbort)
  process.once('SIGTERM', requestAbort)
  const result = await confirmHumanMCTSTurn10(fixturePath, {
    shouldAbort: () => abortRequested,
    onProgress: console.log,
  })
  console.log(JSON.stringify(result.summary, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
