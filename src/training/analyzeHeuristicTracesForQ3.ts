import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLearningActionKey, getLearningStateKey } from '@/agents/learningPolicy'
import type { GameSnapshot, Player, PlayerAction, WallDir } from '@/lib/types'
import type { TrainingTraceActionEntry, TrainingTraceGameRecord } from '@/utils/trainingTrace'

export const DEFAULT_Q3_TRACE_INPUT_DIR = 'data/entrenamiento/heuristicas'
export const DEFAULT_Q3_DIAGNOSTIC_OUTPUT_DIR = 'data/entrenamiento/q3/diagnostico'
export const DEFAULT_Q3_ANALYSIS_JSON = 'heuristic_trace_analysis.json'
export const DEFAULT_Q3_COLLISIONS_CSV = 'heuristic_trace_collisions.csv'

type ActionType = PlayerAction['type']
type Winner = Player | 'tie'

interface RejectedTraceFile {
  file: string
  reason: string
}

interface CollisionAccumulator {
  compactStateKey: string
  compactActionKey: string
  legacyStates: Set<string>
  legacyStateActions: Set<string>
  players: Partial<Record<Player, true>>
  actionTypes: Partial<Record<ActionType, true>>
  occurrences: number
  wins: number
  losses: number
  draws: number
}

export interface CollisionCsvRow {
  compactStateKey: string
  compactActionKey: string
  legacyStateCount: number
  legacyStateActionCount: number
  players: string
  actionTypes: string
  occurrences: number
  wins: number
  losses: number
  draws: number
}

interface ParsedActionEntry {
  file: string
  traceId: string
  winner: Winner
  entry: TrainingTraceActionEntry
  state: GameSnapshot
  action: PlayerAction
  compactStateKey: string
  compactActionKey: string
  legacyStateActionKey: string
  compactStateActionKey: string
}

export interface AnalyzeHeuristicTracesForQ3Options {
  inputDir?: string
  outputDir?: string
  createdAt?: string
  writeOutputs?: boolean
}

export interface HeuristicTraceAnalysis {
  createdAt: string
  inputFiles: string[]
  outputFiles: {
    json: string
    collisionsCsv: string
  }
  config: {
    inputDir: string
    outputDir: string
    mode: 'dry-run'
    generatedQTable: false
    reusedKeyFunctions: string[]
    inferredPolicies: {
      R: 'offensive'
      B: 'defensive'
      source: string
      explicitlyStoredInTrace: false
    }
  }
  validation: {
    gamesRead: number
    validGames: number
    rejectedGames: number
    rejections: RejectedTraceFile[]
  }
  globalMetrics: {
    totalGames: number
    wins: Record<Winner, number>
    totalActions: number
    actionsByPlayer: Record<Player, number>
    actionsByType: Record<ActionType, number>
    actionsByOutcomeForActor: {
      wins: number
      losses: number
      draws: number
    }
  }
  collisionMetrics: {
    uniqueLegacyStateKeys: number
    uniqueCompactStateKeys: number
    uniqueLegacyStateActionPairs: number
    uniqueCompactStateActionPairs: number
    stateCollapsePercentage: number
    stateActionCollapsePercentage: number
    maxLegacyStatesPerCompactState: number
    compactStateCollisionGroupSizeDistribution: Record<string, number>
    topCompactStateCollisions: Array<{
      compactStateKey: string
      legacyStateCount: number
      occurrences: number
    }>
    topStateActionCollisions: CollisionCsvRow[]
    compactActionCollisions: Array<{
      compactActionKey: string
      legacyActionCount: number
      legacyContextCount: number
      occurrences: number
      actionTypes: string[]
    }>
  }
  compositeActionMetrics: {
    totalMoves: number
    secureMovesFollowedByWall: number
    possibleMovesFollowedByWall: number
    movesWithoutIdentifiableWall: number
    possibleMoveWallCombinations: number
    maxWallVariantsForSameMoveActionKey: number
    moveActionKeysWithMultipleWallVariants: Array<{
      compactMoveActionKey: string
      wallVariantCount: number
      wallActionKeys: string[]
    }>
    notes: string[]
  }
  biasMetrics: {
    actionsByPlayer: Record<Player, number>
    actionsByInferredPolicy: Record<'offensive_R' | 'defensive_B', number>
    actionsByPlayerAndGameOutcome: Record<Player, { wins: number; losses: number; draws: number }>
    gamesByWinner: Record<Winner, number>
    explicitPolicyStoredInTrace: false
    inferredPolicySource: string
  }
  warnings: string[]
  conclusion: string
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function emptyPlayerCounts(): Record<Player, number> {
  return { R: 0, B: 0 }
}

function emptyActionTypeCounts(): Record<ActionType, number> {
  return { place: 0, move: 0, wall: 0 }
}

function emptyWinnerCounts(): Record<Winner, number> {
  return { R: 0, B: 0, tie: 0 }
}

function isPlayer(value: unknown): value is Player {
  return value === 'R' || value === 'B'
}

function isWinner(value: unknown): value is Winner {
  return value === 'R' || value === 'B' || value === 'tie'
}

function isActionType(value: unknown): value is ActionType {
  return value === 'place' || value === 'move' || value === 'wall'
}

function parseNumber(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid numeric ${label}: ${value}`)
  }
  return parsed
}

export function parseTraceActionKey(actionType: ActionType, actionKey: string): PlayerAction {
  const parts = actionKey.split('|')
  if (parts[0] !== actionType) {
    throw new Error(`Action type mismatch: ${actionType} vs ${parts[0] ?? ''}`)
  }

  if (actionType === 'place') {
    if (parts.length !== 3) throw new Error(`Invalid place actionKey: ${actionKey}`)
    return {
      type: 'place',
      pos: { x: parseNumber(parts[1], 'place x'), y: parseNumber(parts[2], 'place y') },
    }
  }

  if (actionType === 'move') {
    if (parts.length !== 5) throw new Error(`Invalid move actionKey: ${actionKey}`)
    return {
      type: 'move',
      from: { x: parseNumber(parts[1], 'move from x'), y: parseNumber(parts[2], 'move from y') },
      pos: { x: parseNumber(parts[3], 'move to x'), y: parseNumber(parts[4], 'move to y') },
    }
  }

  if (parts.length !== 4) throw new Error(`Invalid wall actionKey: ${actionKey}`)
  const dir = parts[3]
  if (dir !== 'top' && dir !== 'left' && dir !== 'right' && dir !== 'bottom') {
    throw new Error(`Invalid wall direction: ${dir}`)
  }
  return {
    type: 'wall',
    pos: { x: parseNumber(parts[1], 'wall x'), y: parseNumber(parts[2], 'wall y') },
    dir: dir as WallDir,
  }
}

export function parseLegacyStateKey(stateKey: string): GameSnapshot {
  const parsed = JSON.parse(stateKey) as Omit<GameSnapshot, 'legal'> & { legal?: string[] }
  if (!isPlayer(parsed.turn)) throw new Error('Parsed state has invalid turn')
  if (!parsed.phase) throw new Error('Parsed state is missing phase')
  if (
    !parsed.stonesPlaced ||
    typeof parsed.stonesPlaced.R !== 'number' ||
    typeof parsed.stonesPlaced.B !== 'number'
  ) {
    throw new Error('Parsed state is missing stonesPlaced')
  }
  if (typeof parsed.stepsTaken !== 'number') throw new Error('Parsed state is missing stepsTaken')
  return {
    ...parsed,
    legal: new Set(parsed.legal ?? []),
  } as GameSnapshot
}

function validateTrace(trace: unknown): TrainingTraceGameRecord {
  const candidate = trace as Partial<TrainingTraceGameRecord>
  if (!candidate || typeof candidate !== 'object') throw new Error('Trace is not an object')
  if (typeof candidate.id !== 'string') throw new Error('Missing id')
  if (candidate.mode !== 'heuristic_vs_heuristic')
    throw new Error(`Unsupported mode: ${candidate.mode}`)
  if (!isWinner(candidate.winner)) throw new Error(`Invalid winner: ${String(candidate.winner)}`)
  if (
    !candidate.finalScore ||
    typeof candidate.finalScore.R !== 'number' ||
    typeof candidate.finalScore.B !== 'number'
  ) {
    throw new Error('Invalid finalScore')
  }
  if (!Array.isArray(candidate.actions)) throw new Error('Missing actions array')
  for (const action of candidate.actions) {
    if (!Number.isInteger(action.turn)) throw new Error('Action has invalid turn')
    if (!isPlayer(action.player)) throw new Error('Action has invalid player')
    if (typeof action.stateKey !== 'string') throw new Error('Action has invalid stateKey')
    if (!isActionType(action.actionType)) throw new Error('Action has invalid actionType')
    if (typeof action.actionKey !== 'string') throw new Error('Action has invalid actionKey')
    parseLegacyStateKey(action.stateKey)
    parseTraceActionKey(action.actionType, action.actionKey)
  }
  return candidate as TrainingTraceGameRecord
}

function readTraceFiles(inputDir: string): string[] {
  return readdirSync(inputDir)
    .filter((file) => /^training_game_\d+\.json$/.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => path.join(inputDir, file))
}

function getOutcomeForActor(winner: Winner, player: Player): 'wins' | 'losses' | 'draws' {
  if (winner === 'tie') return 'draws'
  return winner === player ? 'wins' : 'losses'
}

function incrementOutcome(
  target: { wins: number; losses: number; draws: number },
  winner: Winner,
  player: Player,
): void {
  target[getOutcomeForActor(winner, player)]++
}

function getOrCreateCollision(
  collisions: Record<string, CollisionAccumulator>,
  compactStateKey: string,
  compactActionKey: string,
): CollisionAccumulator {
  const key = `${compactStateKey}|||${compactActionKey}`
  const existing = collisions[key]
  if (existing) return existing
  const created: CollisionAccumulator = {
    compactStateKey,
    compactActionKey,
    legacyStates: new Set(),
    legacyStateActions: new Set(),
    players: {},
    actionTypes: {},
    occurrences: 0,
    wins: 0,
    losses: 0,
    draws: 0,
  }
  collisions[key] = created
  return created
}

function toCollisionRow(collision: CollisionAccumulator): CollisionCsvRow {
  return {
    compactStateKey: collision.compactStateKey,
    compactActionKey: collision.compactActionKey,
    legacyStateCount: collision.legacyStates.size,
    legacyStateActionCount: collision.legacyStateActions.size,
    players: Object.keys(collision.players).sort().join('|'),
    actionTypes: Object.keys(collision.actionTypes).sort().join('|'),
    occurrences: collision.occurrences,
    wins: collision.wins,
    losses: collision.losses,
    draws: collision.draws,
  }
}

function csvEscape(value: string | number): string {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function collisionsToCsv(rows: CollisionCsvRow[]): string {
  const headers = [
    'compactStateKey',
    'compactActionKey',
    'legacyStateCount',
    'legacyStateActionCount',
    'players',
    'actionTypes',
    'occurrences',
    'wins',
    'losses',
    'draws',
  ]
  return [
    headers.join(','),
    ...rows.map((row) =>
      headers.map((header) => csvEscape(row[header as keyof CollisionCsvRow])).join(','),
    ),
  ].join('\n')
}

function sortCollisionRows(rows: CollisionCsvRow[]): CollisionCsvRow[] {
  return [...rows].sort(
    (a, b) =>
      b.legacyStateActionCount - a.legacyStateActionCount ||
      b.legacyStateCount - a.legacyStateCount ||
      b.occurrences - a.occurrences ||
      a.compactStateKey.localeCompare(b.compactStateKey) ||
      a.compactActionKey.localeCompare(b.compactActionKey),
  )
}

function buildCompositeMetrics(
  actions: ParsedActionEntry[],
): HeuristicTraceAnalysis['compositeActionMetrics'] {
  let totalMoves = 0
  let secureMovesFollowedByWall = 0
  let possibleMovesFollowedByWall = 0
  const wallVariantsByMoveKey: Record<string, Record<string, true>> = Object.create(null)

  for (let index = 0; index < actions.length; index++) {
    const current = actions[index]!
    if (current.action.type !== 'move') continue
    totalMoves++

    const next = actions[index + 1]
    if (
      !next ||
      next.traceId !== current.traceId ||
      next.entry.player !== current.entry.player ||
      next.action.type !== 'wall'
    ) {
      continue
    }

    const sameMovedStone =
      next.action.pos.x === current.action.pos.x && next.action.pos.y === current.action.pos.y
    if (sameMovedStone && next.entry.turn === current.entry.turn + 1) {
      secureMovesFollowedByWall++
    } else {
      possibleMovesFollowedByWall++
    }

    const variants = wallVariantsByMoveKey[current.compactActionKey] ?? Object.create(null)
    variants[next.compactActionKey] = true
    wallVariantsByMoveKey[current.compactActionKey] = variants
  }

  const movesWithWall = secureMovesFollowedByWall + possibleMovesFollowedByWall
  const moveActionKeysWithMultipleWallVariants = Object.entries(wallVariantsByMoveKey)
    .map(([compactMoveActionKey, wallActionKeys]) => ({
      compactMoveActionKey,
      wallVariantCount: Object.keys(wallActionKeys).length,
      wallActionKeys: Object.keys(wallActionKeys).sort(),
    }))
    .filter((entry) => entry.wallVariantCount > 1)
    .sort(
      (a, b) =>
        b.wallVariantCount - a.wallVariantCount ||
        a.compactMoveActionKey.localeCompare(b.compactMoveActionKey),
    )

  return {
    totalMoves,
    secureMovesFollowedByWall,
    possibleMovesFollowedByWall,
    movesWithoutIdentifiableWall: totalMoves - movesWithWall,
    possibleMoveWallCombinations: movesWithWall,
    maxWallVariantsForSameMoveActionKey: Math.max(
      0,
      ...Object.values(wallVariantsByMoveKey).map((variants) => Object.keys(variants).length),
    ),
    moveActionKeysWithMultipleWallVariants: moveActionKeysWithMultipleWallVariants.slice(0, 20),
    notes: [
      'A secure move+wall association requires adjacent trace entries from the same game and player, a wall immediately after the move, and the wall position equal to the move destination.',
      'Possible associations are adjacent same-player move+wall entries that do not satisfy all secure checks.',
      'The trace format stores action entries separately, so this analysis does not rewrite them as followUp actions.',
    ],
  }
}

function buildConclusion(params: {
  stateActionCollapsePercentage: number
  maxLegacyStatesPerCompactState: number
  secureMovesFollowedByWall: number
  possibleMovesFollowedByWall: number
  warnings: string[]
}): string {
  return [
    `The dry-run conversion found a ${params.stateActionCollapsePercentage}% collapse from legacy state-action pairs to compact Q2-style state-action pairs.`,
    `The largest compact state groups ${params.maxLegacyStatesPerCompactState} distinct legacy states.`,
    `Detected ${params.secureMovesFollowedByWall} secure and ${params.possibleMovesFollowedByWall} possible move+wall associations in the existing traces.`,
    `Warnings recorded: ${params.warnings.length}.`,
    'This is descriptive only; it does not choose the final Q3 state representation.',
  ].join(' ')
}

export function analyzeHeuristicTracesForQ3(
  options: AnalyzeHeuristicTracesForQ3Options = {},
): HeuristicTraceAnalysis {
  const inputDir = path.resolve(options.inputDir ?? DEFAULT_Q3_TRACE_INPUT_DIR)
  const outputDir = path.resolve(options.outputDir ?? DEFAULT_Q3_DIAGNOSTIC_OUTPUT_DIR)
  const createdAt = options.createdAt ?? new Date().toISOString()
  const writeOutputs = options.writeOutputs ?? true
  const inputFiles = readTraceFiles(inputDir)
  const rejections: RejectedTraceFile[] = []
  const validTraces: Array<{ file: string; trace: TrainingTraceGameRecord }> = []
  const parsedActions: ParsedActionEntry[] = []
  const warnings = [
    'Trace JSON stores heuristic players generically; offensive R and defensive B are inferred from TrainingRunner configuration, not explicit trace fields.',
    'Legacy state keys contain full serialized state while compact keys intentionally omit board, selected stone and legal moves.',
    'Q2 action keys do not encode followUp walls attached to move actions.',
  ]

  for (const file of inputFiles) {
    try {
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        throw new Error(`Invalid JSON: ${(error as Error).message}`)
      }
      const trace = validateTrace(raw)
      validTraces.push({ file, trace })
      for (const entry of trace.actions) {
        const state = parseLegacyStateKey(entry.stateKey)
        const action = parseTraceActionKey(entry.actionType, entry.actionKey)
        const compactStateKey = getLearningStateKey(state)
        const compactActionKey = getLearningActionKey(action)
        parsedActions.push({
          file,
          traceId: trace.id,
          winner: trace.winner,
          entry,
          state,
          action,
          compactStateKey,
          compactActionKey,
          legacyStateActionKey: `${entry.stateKey}|||${entry.actionKey}`,
          compactStateActionKey: `${compactStateKey}|||${compactActionKey}`,
        })
      }
    } catch (error) {
      rejections.push({ file, reason: (error as Error).message })
    }
  }

  const wins = emptyWinnerCounts()
  const actionsByPlayer = emptyPlayerCounts()
  const actionsByType = emptyActionTypeCounts()
  const actionsByOutcomeForActor = { wins: 0, losses: 0, draws: 0 }
  const actionsByPlayerAndGameOutcome = {
    R: { wins: 0, losses: 0, draws: 0 },
    B: { wins: 0, losses: 0, draws: 0 },
  }
  const actionsByInferredPolicy = { offensive_R: 0, defensive_B: 0 }

  for (const { trace } of validTraces) {
    wins[trace.winner]++
  }

  const legacyStateKeys = new Set<string>()
  const compactStateKeys = new Set<string>()
  const legacyStateActionPairs = new Set<string>()
  const compactStateActionPairs = new Set<string>()
  const legacyStatesByCompactState: Record<string, Set<string>> = Object.create(null)
  const compactStateOccurrences: Record<string, number> = Object.create(null)
  const stateActionCollisions: Record<string, CollisionAccumulator> = Object.create(null)
  const compactActionContexts: Record<
    string,
    {
      legacyActions: Set<string>
      legacyContexts: Set<string>
      occurrences: number
      actionTypes: Partial<Record<ActionType, true>>
    }
  > = Object.create(null)

  for (const parsed of parsedActions) {
    actionsByPlayer[parsed.entry.player]++
    actionsByType[parsed.entry.actionType]++
    actionsByInferredPolicy[parsed.entry.player === 'R' ? 'offensive_R' : 'defensive_B']++
    incrementOutcome(actionsByOutcomeForActor, parsed.winner, parsed.entry.player)
    incrementOutcome(
      actionsByPlayerAndGameOutcome[parsed.entry.player],
      parsed.winner,
      parsed.entry.player,
    )

    legacyStateKeys.add(parsed.entry.stateKey)
    compactStateKeys.add(parsed.compactStateKey)
    legacyStateActionPairs.add(parsed.legacyStateActionKey)
    compactStateActionPairs.add(parsed.compactStateActionKey)

    const legacyStates = legacyStatesByCompactState[parsed.compactStateKey] ?? new Set<string>()
    legacyStates.add(parsed.entry.stateKey)
    legacyStatesByCompactState[parsed.compactStateKey] = legacyStates
    compactStateOccurrences[parsed.compactStateKey] =
      (compactStateOccurrences[parsed.compactStateKey] ?? 0) + 1

    const collision = getOrCreateCollision(
      stateActionCollisions,
      parsed.compactStateKey,
      parsed.compactActionKey,
    )
    collision.legacyStates.add(parsed.entry.stateKey)
    collision.legacyStateActions.add(parsed.legacyStateActionKey)
    collision.players[parsed.entry.player] = true
    collision.actionTypes[parsed.entry.actionType] = true
    collision.occurrences++
    incrementOutcome(collision, parsed.winner, parsed.entry.player)

    const actionContext = compactActionContexts[parsed.compactActionKey] ?? {
      legacyActions: new Set<string>(),
      legacyContexts: new Set<string>(),
      occurrences: 0,
      actionTypes: {},
    }
    actionContext.legacyActions.add(parsed.entry.actionKey)
    actionContext.legacyContexts.add(parsed.legacyStateActionKey)
    actionContext.occurrences++
    actionContext.actionTypes[parsed.entry.actionType] = true
    compactActionContexts[parsed.compactActionKey] = actionContext
  }

  const stateCollapsePercentage = legacyStateKeys.size
    ? roundMetric(((legacyStateKeys.size - compactStateKeys.size) / legacyStateKeys.size) * 100)
    : 0
  const stateActionCollapsePercentage = legacyStateActionPairs.size
    ? roundMetric(
        ((legacyStateActionPairs.size - compactStateActionPairs.size) /
          legacyStateActionPairs.size) *
          100,
      )
    : 0

  const compactStateCollisionGroupSizeDistribution: Record<string, number> = {}
  for (const legacyStates of Object.values(legacyStatesByCompactState)) {
    const size = String(legacyStates.size)
    compactStateCollisionGroupSizeDistribution[size] =
      (compactStateCollisionGroupSizeDistribution[size] ?? 0) + 1
  }

  const maxLegacyStatesPerCompactState = Math.max(
    0,
    ...Object.values(legacyStatesByCompactState).map((states) => states.size),
  )
  const topCompactStateCollisions = Object.entries(legacyStatesByCompactState)
    .map(([compactStateKey, legacyStates]) => ({
      compactStateKey,
      legacyStateCount: legacyStates.size,
      occurrences: compactStateOccurrences[compactStateKey] ?? 0,
    }))
    .sort(
      (a, b) =>
        b.legacyStateCount - a.legacyStateCount ||
        b.occurrences - a.occurrences ||
        a.compactStateKey.localeCompare(b.compactStateKey),
    )
    .slice(0, 20)

  const collisionRows = sortCollisionRows(Object.values(stateActionCollisions).map(toCollisionRow))
  const compactActionCollisions = Object.entries(compactActionContexts)
    .map(([compactActionKey, context]) => ({
      compactActionKey,
      legacyActionCount: context.legacyActions.size,
      legacyContextCount: context.legacyContexts.size,
      occurrences: context.occurrences,
      actionTypes: Object.keys(context.actionTypes).sort(),
    }))
    .filter((entry) => entry.legacyActionCount > 1 || entry.legacyContextCount > 1)
    .sort(
      (a, b) =>
        b.legacyContextCount - a.legacyContextCount ||
        b.occurrences - a.occurrences ||
        a.compactActionKey.localeCompare(b.compactActionKey),
    )
    .slice(0, 20)
  const compositeActionMetrics = buildCompositeMetrics(parsedActions)

  const outputFiles = {
    json: path.join(outputDir, DEFAULT_Q3_ANALYSIS_JSON),
    collisionsCsv: path.join(outputDir, DEFAULT_Q3_COLLISIONS_CSV),
  }

  const analysis: HeuristicTraceAnalysis = {
    createdAt,
    inputFiles,
    outputFiles,
    config: {
      inputDir,
      outputDir,
      mode: 'dry-run',
      generatedQTable: false,
      reusedKeyFunctions: ['getLearningStateKey', 'getLearningActionKey'],
      inferredPolicies: {
        R: 'offensive',
        B: 'defensive',
        source:
          'src/training/TrainingRunner.ts assigns R=HeuristicAgent(offensive), B=HeuristicAgent(defensive)',
        explicitlyStoredInTrace: false,
      },
    },
    validation: {
      gamesRead: inputFiles.length,
      validGames: validTraces.length,
      rejectedGames: rejections.length,
      rejections,
    },
    globalMetrics: {
      totalGames: validTraces.length,
      wins,
      totalActions: parsedActions.length,
      actionsByPlayer,
      actionsByType,
      actionsByOutcomeForActor,
    },
    collisionMetrics: {
      uniqueLegacyStateKeys: legacyStateKeys.size,
      uniqueCompactStateKeys: compactStateKeys.size,
      uniqueLegacyStateActionPairs: legacyStateActionPairs.size,
      uniqueCompactStateActionPairs: compactStateActionPairs.size,
      stateCollapsePercentage,
      stateActionCollapsePercentage,
      maxLegacyStatesPerCompactState,
      compactStateCollisionGroupSizeDistribution,
      topCompactStateCollisions,
      topStateActionCollisions: collisionRows.slice(0, 20),
      compactActionCollisions,
    },
    compositeActionMetrics,
    biasMetrics: {
      actionsByPlayer,
      actionsByInferredPolicy,
      actionsByPlayerAndGameOutcome,
      gamesByWinner: wins,
      explicitPolicyStoredInTrace: false,
      inferredPolicySource:
        'TrainingRunner constructs R as offensive and B as defensive; trace JSON stores both as heuristic only.',
    },
    warnings,
    conclusion: buildConclusion({
      stateActionCollapsePercentage,
      maxLegacyStatesPerCompactState,
      secureMovesFollowedByWall: compositeActionMetrics.secureMovesFollowedByWall,
      possibleMovesFollowedByWall: compositeActionMetrics.possibleMovesFollowedByWall,
      warnings,
    }),
  }

  if (writeOutputs) {
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(outputFiles.json, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8')
    writeFileSync(outputFiles.collisionsCsv, `${collisionsToCsv(collisionRows)}\n`, 'utf8')
  }

  return analysis
}

function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectExecution()) {
  const analysis = analyzeHeuristicTracesForQ3()
  console.log(
    `[analyzeHeuristicTracesForQ3] valid games: ${analysis.validation.validGames}/${analysis.validation.gamesRead}`,
  )
  console.log(`[analyzeHeuristicTracesForQ3] actions: ${analysis.globalMetrics.totalActions}`)
  console.log(
    `[analyzeHeuristicTracesForQ3] state-action collapse: ${analysis.collisionMetrics.stateActionCollapsePercentage}%`,
  )
  console.log(`[analyzeHeuristicTracesForQ3] output: ${analysis.outputFiles.json}`)
}
