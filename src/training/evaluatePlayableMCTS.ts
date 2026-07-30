import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { choosePlayableMCTSAction } from '@/agents/mctsWorkerDecision'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import { applyFullAction } from '@/engine/gameSimulator'
import type { MCTSConfig } from '@/engine/mcts/types'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { getTerritoryCounts } from './compareLearningAgents'
import { wilson95 } from './evaluateMCTSTacticalConfirmation'
import {
  chooseHeuristicOpponentActionQ4,
  chooseRandomActionWithRngQ4,
  createSeededRngQ4,
} from './trainLearningAgentQ4'

export const PLAYABLE_MCTS_EVALUATION_VERSION = 'playable-mcts-final-v1'
export const PLAYABLE_MCTS_EVALUATION_SEED = 941_000
export const PLAYABLE_MCTS_MAX_TURNS = 250
export const PLAYABLE_MCTS_OUTPUT_DIR = path.join(
  'data/entrenamiento/mcts/evaluacion_jugable_final',
)

export type PlayableMCTSRival = 'heuristic' | 'random' | 'baseline-mcts'

export const PLAYABLE_MCTS_BASELINE_CONFIG: Readonly<MCTSConfig> = Object.freeze({
  ...FINAL_MCTS_CONFIG,
  tacticalVerification: false,
})

export const PLAYABLE_MCTS_FINAL_PLAN: Readonly<Record<PlayableMCTSRival, number>> = Object.freeze({
  heuristic: 50,
  random: 25,
  'baseline-mcts': 50,
})

export const PLAYABLE_MCTS_RIVALS: readonly PlayableMCTSRival[] = Object.freeze([
  'heuristic',
  'random',
  'baseline-mcts',
])

export interface PlayableMCTSScheduleItem {
  gameId: string
  pairId: string
  pairIndex: number
  rival: PlayableMCTSRival
  finalColor: Player
  scenarioSeed: number
  subjectBaseSeed: number
  opponentBaseSeed: number
}

export interface PlayableMCTSGameResult extends PlayableMCTSScheduleItem {
  evaluatorVersion: string
  winner: Player | 'tie'
  outcome: 'win' | 'loss' | 'tie'
  territoryRed: number
  territoryBlue: number
  territoryFinal: number
  territoryRival: number
  territoryDiff: number
  turns: number
  reachedTurnLimit: boolean
  durationMs: number
  mctsDecisions: number
  mctsDecisionTimeMs: number
  averageDecisionMs: number
  allMCTSActionsLegal: boolean
}

export interface PlayableMCTSAggregate {
  games: number
  wins: number
  losses: number
  ties: number
  winRate: number
  winRateCI95: { low: number; high: number }
  averageTerritoryFinal: number
  averageTerritoryRival: number
  averageTerritoryDiff: number
  averageTurns: number
  averageDecisionMs: number
  mctsActions: number
  illegalMCTSActions: number
}

export interface PlayableMCTSSummary {
  evaluatorVersion: string
  note: string
  overall: PlayableMCTSAggregate
  byRival: Record<PlayableMCTSRival, PlayableMCTSAggregate>
  byColor: Record<Player, PlayableMCTSAggregate>
}

export interface EvaluatePlayableMCTSOptions {
  smoke?: boolean
  outputDir?: string
  overwrite?: boolean
  now?: () => number
  maxTurns?: number
  chooseMCTS?: typeof choosePlayableMCTSAction
  progressEvery?: number
  writeResults?: boolean
  plan?: Readonly<Record<PlayableMCTSRival, number>>
}

interface MCTSRuntime {
  name: 'final' | 'baseline'
  baseSeed: number
  decisionIndex: number
  config: Readonly<MCTSConfig>
}

function round(value: number): number {
  return Number(value.toFixed(4))
}

function opponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function actionKey(action: PlayerAction): string {
  return JSON.stringify(action)
}

function isLegalAction(action: PlayerAction, legalActions: readonly PlayerAction[]): boolean {
  const key = actionKey(action)
  return legalActions.some((legalAction) => actionKey(legalAction) === key)
}

export function getPlayableDecisionSeed(baseSeed: number, decisionIndex: number): number {
  return (baseSeed + decisionIndex) >>> 0
}

export function buildPlayableMCTSSchedule(
  plan: Readonly<Record<PlayableMCTSRival, number>> = PLAYABLE_MCTS_FINAL_PLAN,
): readonly PlayableMCTSScheduleItem[] {
  const schedule: PlayableMCTSScheduleItem[] = []
  let globalPairIndex = 0
  for (const rival of PLAYABLE_MCTS_RIVALS) {
    const pairCount = plan[rival]
    for (let rivalPairIndex = 0; rivalPairIndex < pairCount; rivalPairIndex++) {
      const scenarioSeed = (PLAYABLE_MCTS_EVALUATION_SEED + globalPairIndex) >>> 0
      const pairId = `${rival}-${String(rivalPairIndex + 1).padStart(3, '0')}`
      const seeds = {
        scenarioSeed,
        subjectBaseSeed: scenarioSeed,
        opponentBaseSeed: (scenarioSeed + 0x9e3779b9) >>> 0,
      }
      for (const finalColor of ['R', 'B'] as const) {
        schedule.push(
          Object.freeze({
            gameId: `${pairId}-${finalColor}`,
            pairId,
            pairIndex: globalPairIndex,
            rival,
            finalColor,
            ...seeds,
          }),
        )
      }
      globalPairIndex++
    }
  }
  return Object.freeze(schedule)
}

function chooseMCTSAction(params: {
  runtime: MCTSRuntime
  state: GameSnapshot
  rival: PlayableMCTSRival
  gameId: string
  chooseMCTS: typeof choosePlayableMCTSAction
}): { action: PlayerAction; elapsedMs: number; decisionIndex: number } {
  const decisionIndex = params.runtime.decisionIndex
  const seed = getPlayableDecisionSeed(params.runtime.baseSeed, decisionIndex)
  const startedAt = performance.now()
  try {
    const action = params.chooseMCTS({
      gameState: params.state,
      config: params.runtime.config,
      seed,
    })
    params.runtime.decisionIndex++
    return { action, elapsedMs: performance.now() - startedAt, decisionIndex }
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new Error(
      `Playable MCTS decision failed: rival=${params.rival}, game=${params.gameId}, ` +
        `seed=${seed}, agent=${params.runtime.name}, decision=${decisionIndex}${detail}`,
    )
  }
}

export async function runPlayableMCTSGame(
  item: PlayableMCTSScheduleItem,
  options: Pick<EvaluatePlayableMCTSOptions, 'chooseMCTS' | 'maxTurns' | 'now'> = {},
): Promise<PlayableMCTSGameResult> {
  const chooseMCTS = options.chooseMCTS ?? choosePlayableMCTSAction
  const maxTurns = options.maxTurns ?? PLAYABLE_MCTS_MAX_TURNS
  const now = options.now ?? (() => performance.now())
  const finalRuntime: MCTSRuntime = {
    name: 'final',
    baseSeed: item.subjectBaseSeed,
    decisionIndex: 0,
    config: FINAL_MCTS_CONFIG,
  }
  const baselineRuntime: MCTSRuntime | undefined =
    item.rival === 'baseline-mcts'
      ? {
          name: 'baseline',
          baseSeed: item.opponentBaseSeed,
          decisionIndex: 0,
          config: PLAYABLE_MCTS_BASELINE_CONFIG,
        }
      : undefined
  const rivalRng = createSeededRngQ4(item.opponentBaseSeed)
  let state = makeInitialState()
  let turns = 0
  let mctsDecisions = 0
  let mctsDecisionTimeMs = 0
  let allMCTSActionsLegal = true
  const startedAt = now()

  while (state.phase !== 'finished' && !state.result && turns < maxTurns) {
    const snapshot = snapshotFromState(state)
    const legalActions = getLegalActions(snapshot)
    if (legalActions.length === 0) break

    let action: PlayerAction
    let runtime: MCTSRuntime | undefined
    if (snapshot.turn === item.finalColor) {
      runtime = finalRuntime
    } else if (baselineRuntime) {
      runtime = baselineRuntime
    }

    if (runtime) {
      const decision = chooseMCTSAction({
        runtime,
        state: snapshot,
        rival: item.rival,
        gameId: item.gameId,
        chooseMCTS,
      })
      action = decision.action
      mctsDecisions++
      mctsDecisionTimeMs += decision.elapsedMs
      const legal = isLegalAction(action, legalActions)
      allMCTSActionsLegal &&= legal
      if (!legal) {
        const seed = getPlayableDecisionSeed(runtime.baseSeed, decision.decisionIndex)
        throw new Error(
          `Illegal MCTS action: rival=${item.rival}, game=${item.gameId}, seed=${seed}, ` +
            `agent=${runtime.name}, decision=${decision.decisionIndex}`,
        )
      }
    } else if (item.rival === 'random') {
      action = chooseRandomActionWithRngQ4(legalActions, rivalRng)
    } else {
      action = chooseHeuristicOpponentActionQ4(snapshot, rivalRng)
    }

    const applied = applyFullAction(state, action)
    state = applied.state
    turns += applied.atomicActions
  }

  const reachedTurnLimit = turns >= maxTurns && state.phase !== 'finished' && !state.result
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const finalTerritory = territory[item.finalColor]
  const rivalTerritory = territory[opponent(item.finalColor)]
  const winner: Player | 'tie' = state.result?.tie
    ? 'tie'
    : (state.result?.winner ??
      (territory.R === territory.B ? 'tie' : territory.R > territory.B ? 'R' : 'B'))
  const outcome = winner === 'tie' ? 'tie' : winner === item.finalColor ? 'win' : 'loss'

  return {
    ...item,
    evaluatorVersion: PLAYABLE_MCTS_EVALUATION_VERSION,
    winner,
    outcome,
    territoryRed: territory.R,
    territoryBlue: territory.B,
    territoryFinal: finalTerritory,
    territoryRival: rivalTerritory,
    territoryDiff: finalTerritory - rivalTerritory,
    turns,
    reachedTurnLimit,
    durationMs: round(now() - startedAt),
    mctsDecisions,
    mctsDecisionTimeMs: round(mctsDecisionTimeMs),
    averageDecisionMs: mctsDecisions ? round(mctsDecisionTimeMs / mctsDecisions) : 0,
    allMCTSActionsLegal,
  }
}

export function aggregatePlayableMCTSResults(
  results: readonly PlayableMCTSGameResult[],
): PlayableMCTSAggregate {
  const games = results.length
  const wins = results.filter((row) => row.outcome === 'win').length
  const losses = results.filter((row) => row.outcome === 'loss').length
  const ties = games - wins - losses
  const mctsActions = results.reduce((sum, row) => sum + row.mctsDecisions, 0)
  const decisionTime = results.reduce((sum, row) => sum + row.mctsDecisionTimeMs, 0)
  const average = (select: (row: PlayableMCTSGameResult) => number) =>
    games ? round(results.reduce((sum, row) => sum + select(row), 0) / games) : 0

  return {
    games,
    wins,
    losses,
    ties,
    winRate: games ? round((wins / games) * 100) : 0,
    // Empates son no-victorias: Wilson se calcula con wins / games.
    winRateCI95: wilson95(wins, games),
    averageTerritoryFinal: average((row) => row.territoryFinal),
    averageTerritoryRival: average((row) => row.territoryRival),
    averageTerritoryDiff: average((row) => row.territoryDiff),
    averageTurns: average((row) => row.turns),
    averageDecisionMs: mctsActions ? round(decisionTime / mctsActions) : 0,
    mctsActions,
    illegalMCTSActions: results
      .filter((row) => !row.allMCTSActionsLegal)
      .reduce((sum, row) => sum + row.mctsDecisions, 0),
  }
}

export function summarizePlayableMCTSResults(
  results: readonly PlayableMCTSGameResult[],
): PlayableMCTSSummary {
  const byRival = Object.fromEntries(
    PLAYABLE_MCTS_RIVALS.map((rival) => [
      rival,
      aggregatePlayableMCTSResults(results.filter((row) => row.rival === rival)),
    ]),
  ) as Record<PlayableMCTSRival, PlayableMCTSAggregate>
  const byColor = Object.fromEntries(
    (['R', 'B'] as const).map((color) => [
      color,
      aggregatePlayableMCTSResults(results.filter((row) => row.finalColor === color)),
    ]),
  ) as Record<Player, PlayableMCTSAggregate>

  return {
    evaluatorVersion: PLAYABLE_MCTS_EVALUATION_VERSION,
    note: 'El IC Wilson 95% usa victorias/partidas; los empates cuentan como no-victorias.',
    overall: aggregatePlayableMCTSResults(results),
    byRival,
    byColor,
  }
}

function assertOutputCanBeWritten(outputDir: string, overwrite: boolean): void {
  if (existsSync(outputDir) && readdirSync(outputDir).length > 0) {
    if (!overwrite)
      throw new Error(`Output directory already exists and is not empty: ${outputDir}`)
  }
  mkdirSync(outputDir, { recursive: true })
}

function csvCell(value: unknown): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function resultsCsv(results: readonly PlayableMCTSGameResult[]): string {
  const columns: Array<keyof PlayableMCTSGameResult> = [
    'evaluatorVersion',
    'gameId',
    'pairId',
    'pairIndex',
    'rival',
    'finalColor',
    'scenarioSeed',
    'subjectBaseSeed',
    'opponentBaseSeed',
    'winner',
    'outcome',
    'territoryRed',
    'territoryBlue',
    'territoryFinal',
    'territoryRival',
    'territoryDiff',
    'turns',
    'reachedTurnLimit',
    'durationMs',
    'mctsDecisions',
    'mctsDecisionTimeMs',
    'averageDecisionMs',
    'allMCTSActionsLegal',
  ]
  return [
    columns.join(','),
    ...results.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
  ].join('\n')
}

type PairablePlayableMCTSResult = Pick<
  PlayableMCTSGameResult,
  | 'pairId'
  | 'rival'
  | 'finalColor'
  | 'scenarioSeed'
  | 'subjectBaseSeed'
  | 'opponentBaseSeed'
  | 'outcome'
  | 'territoryDiff'
>

export function pairedCsv(results: readonly PairablePlayableMCTSResult[]): string {
  const rows = new Map<string, PairablePlayableMCTSResult[]>()
  for (const result of results) {
    const pair = rows.get(result.pairId) ?? []
    pair.push(result)
    rows.set(result.pairId, pair)
  }
  const header =
    'pairId,rival,scenarioSeed,subjectBaseSeed,opponentBaseSeed,redOutcome,blueOutcome,' +
    'redTerritoryDiff,blueTerritoryDiff'
  return [
    header,
    ...Array.from(rows.values()).map((pair) => {
      if (pair.length !== 2) {
        const kind = pair.length < 2 ? 'Incomplete' : 'Duplicate'
        throw new Error(
          `${kind} color pair: ${pair[0]?.pairId ?? 'unknown'} (${pair.length} games)`,
        )
      }
      const red = pair.find((row) => row.finalColor === 'R')
      const blue = pair.find((row) => row.finalColor === 'B')
      if (!red || !blue) throw new Error(`Duplicate color in pair: ${pair[0]?.pairId}`)
      return [
        red.pairId,
        red.rival,
        red.scenarioSeed,
        red.subjectBaseSeed,
        red.opponentBaseSeed,
        red.outcome,
        blue.outcome,
        red.territoryDiff,
        blue.territoryDiff,
      ].join(',')
    }),
  ].join('\n')
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"'
        index++
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      cells.push(cell)
      cell = ''
    } else {
      cell += character
    }
  }
  if (quoted) throw new Error('Unterminated quoted CSV field')
  cells.push(cell)
  return cells
}

function parsePairableResultsCsv(csv: string): PairablePlayableMCTSResult[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length < 2) throw new Error('Playable MCTS results CSV has no result rows')
  const headers = parseCsvLine(lines[0]!)
  const required = [
    'pairId',
    'rival',
    'finalColor',
    'scenarioSeed',
    'subjectBaseSeed',
    'opponentBaseSeed',
    'outcome',
    'territoryDiff',
  ] as const
  const indexes = Object.fromEntries(
    required.map((column) => {
      const index = headers.indexOf(column)
      if (index < 0) throw new Error(`Missing CSV column: ${column}`)
      return [column, index]
    }),
  ) as Record<(typeof required)[number], number>

  return lines.slice(1).map((line, rowIndex) => {
    const cells = parseCsvLine(line)
    const value = (column: (typeof required)[number]) => cells[indexes[column]]
    const rival = value('rival')
    const finalColor = value('finalColor')
    const outcome = value('outcome')
    if (rival !== 'heuristic' && rival !== 'random' && rival !== 'baseline-mcts') {
      throw new Error(`Invalid rival at CSV row ${rowIndex + 2}: ${rival}`)
    }
    if (finalColor !== 'R' && finalColor !== 'B') {
      throw new Error(`Invalid finalColor at CSV row ${rowIndex + 2}: ${finalColor}`)
    }
    if (outcome !== 'win' && outcome !== 'loss' && outcome !== 'tie') {
      throw new Error(`Invalid outcome at CSV row ${rowIndex + 2}: ${outcome}`)
    }
    return {
      pairId: value('pairId')!,
      rival,
      finalColor,
      scenarioSeed: Number(value('scenarioSeed')),
      subjectBaseSeed: Number(value('subjectBaseSeed')),
      opponentBaseSeed: Number(value('opponentBaseSeed')),
      outcome,
      territoryDiff: Number(value('territoryDiff')),
    }
  })
}

export function regeneratePlayableMCTSPairedCsv(outputDir: string = PLAYABLE_MCTS_OUTPUT_DIR): {
  games: number
  pairs: number
  lines: number
  outputPath: string
} {
  const resolvedOutputDir = path.resolve(outputDir)
  const resultsPath = path.join(resolvedOutputDir, 'playable_mcts_final_results.csv')
  const outputPath = path.join(resolvedOutputDir, 'playable_mcts_final_paired.csv')
  const results = parsePairableResultsCsv(readFileSync(resultsPath, 'utf8'))
  const csv = pairedCsv(results)
  writeFileSync(outputPath, `${csv}\n`, 'utf8')
  return {
    games: results.length,
    pairs: results.length / 2,
    lines: csv.split('\n').length,
    outputPath,
  }
}

function gitValue(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function evaluatePlayableMCTS(options: EvaluatePlayableMCTSOptions = {}): Promise<{
  results: PlayableMCTSGameResult[]
  summary: PlayableMCTSSummary
  outputDir?: string
}> {
  const smoke = options.smoke ?? false
  const plan = Object.freeze(
    smoke
      ? { heuristic: 1, random: 1, 'baseline-mcts': 1 }
      : { ...(options.plan ?? PLAYABLE_MCTS_FINAL_PLAN) },
  )
  const shouldWrite = options.writeResults ?? true
  const outputDir = shouldWrite
    ? path.resolve(
        options.outputDir ??
          (smoke
            ? mkdtempSync(path.join(tmpdir(), 'wall-go-playable-mcts-smoke-'))
            : PLAYABLE_MCTS_OUTPUT_DIR),
      )
    : undefined
  if (outputDir) assertOutputCanBeWritten(outputDir, options.overwrite ?? false)
  const schedule = buildPlayableMCTSSchedule(plan)
  if (schedule.length === 0) throw new Error('Playable MCTS evaluation schedule is empty')
  const results: PlayableMCTSGameResult[] = []
  for (let index = 0; index < schedule.length; index++) {
    const item = schedule[index]!
    results.push(await runPlayableMCTSGame(item, options))
    if (options.progressEvery && (index + 1) % options.progressEvery === 0) {
      console.log(`[evaluatePlayableMCTS] ${index + 1}/${schedule.length}`)
    }
  }
  const summary = summarizePlayableMCTSResults(results)
  if (!shouldWrite) return { results, summary }
  if (!outputDir) throw new Error('Output directory was not initialized')
  const metadata = {
    commit: gitValue('rev-parse', 'HEAD'),
    branch: gitValue('branch', '--show-current'),
    createdAt: new Date().toISOString(),
    nodeVersion: process.version,
    evaluatorVersion: PLAYABLE_MCTS_EVALUATION_VERSION,
    finalMCTSConfig: FINAL_MCTS_CONFIG,
    baselineMCTSConfig: PLAYABLE_MCTS_BASELINE_CONFIG,
    masterSeed: PLAYABLE_MCTS_EVALUATION_SEED,
    seedProtocol: {
      scenarioSeed: '(PLAYABLE_MCTS_EVALUATION_SEED + pairIndex) >>> 0',
      subjectBaseSeed: 'scenarioSeed',
      opponentBaseSeed: '(scenarioSeed + 0x9e3779b9) >>> 0',
      decisionSeed: '(agentBaseSeed + decisionIndex) >>> 0',
      reset: 'Each MCTS decision creates a new playable RNG; counters restart at 0 per game.',
    },
    plan,
    games: schedule.length,
    maxTurns: options.maxTurns ?? PLAYABLE_MCTS_MAX_TURNS,
    protocol: 'choosePlayableMCTSAction',
    q5: { loaded: false, qPriorSource: 'undefined', qPriorWeight: FINAL_MCTS_CONFIG.qPriorWeight },
    wilson: '95%; wins/games; ties count as non-wins.',
    smoke,
  }
  writeJson(path.join(outputDir, 'playable_mcts_final_summary.json'), summary)
  writeFileSync(
    path.join(outputDir, 'playable_mcts_final_results.csv'),
    `${resultsCsv(results)}\n`,
    'utf8',
  )
  writeFileSync(
    path.join(outputDir, 'playable_mcts_final_paired.csv'),
    `${pairedCsv(results)}\n`,
    'utf8',
  )
  writeJson(path.join(outputDir, 'metadata.json'), metadata)
  return { results, summary, outputDir }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const allowed = new Set(['--smoke', '--overwrite', '--regenerate-paired'])
  const unsupported = [...args].filter((arg) => !allowed.has(arg))
  if (unsupported.length) throw new Error(`Unsupported arguments: ${unsupported.join(', ')}`)
  if (args.has('--regenerate-paired')) {
    if (args.size !== 1) {
      throw new Error('--regenerate-paired cannot be combined with other arguments')
    }
    console.log(JSON.stringify(regeneratePlayableMCTSPairedCsv(), null, 2))
    return
  }
  const smoke = args.has('--smoke')
  const startedAt = performance.now()
  const evaluation = await evaluatePlayableMCTS({
    smoke,
    overwrite: args.has('--overwrite'),
    progressEvery: smoke ? 1 : 10,
  })
  console.log(JSON.stringify(evaluation.summary, null, 2))
  console.log(`[evaluatePlayableMCTS] output: ${evaluation.outputDir}`)
  console.log(`[evaluatePlayableMCTS] elapsedMs: ${round(performance.now() - startedAt)}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main()
}
