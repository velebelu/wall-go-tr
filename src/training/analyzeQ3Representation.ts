import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLearningStateKey } from '@/agents/learningPolicy'
import {
  getLearningActionKeyQ3,
  getLearningQTableKeyQ3,
  getLearningStateKeyQ3,
} from '@/agents/learningPolicyQ3'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import type { TrainingTraceGameRecord } from '@/utils/trainingTrace'
import { parseLegacyStateKey, parseTraceActionKey } from './analyzeHeuristicTracesForQ3'

export const DEFAULT_Q3_REPRESENTATION_INPUT_DIR = 'data/entrenamiento/heuristicas'
export const DEFAULT_Q3_REPRESENTATION_OUTPUT_DIR =
  'data/entrenamiento/q3/diagnostico_representacion'

type Winner = Player | 'tie'
type LogicalActionKind = 'place' | 'move-wall' | 'wall' | 'move'

interface Rejection {
  file: string
  reason: string
}

interface LogicalDecision {
  traceId: string
  player: Player
  winner: Winner
  legacyStateKey: string
  state: GameSnapshot
  action: PlayerAction
  kind: LogicalActionKind
}

interface StateDistributionRow {
  q3StateKey: string
  visits: number
  uniqueActions: number
  players: string
  wins: number
  losses: number
  draws: number
  placeActions: number
  moveWallActions: number
  wallActions: number
}

interface StateAccumulator {
  visits: number
  actions: Record<string, true>
  players: Partial<Record<Player, true>>
  wins: number
  losses: number
  draws: number
  placeActions: number
  moveWallActions: number
  wallActions: number
}

export interface AnalyzeQ3RepresentationOptions {
  inputDir?: string
  outputDir?: string
  createdAt?: string
  writeOutputs?: boolean
}

export interface Q3RepresentationAnalysis {
  createdAt: string
  inputFiles: string[]
  outputFiles: {
    json: string
    stateDistributionCsv: string
  }
  validation: {
    gamesRead: number
    validGames: number
    rejectedGames: number
    rejections: Rejection[]
  }
  decisions: {
    logicalDecisions: number
    places: number
    moveWall: number
    independentWalls: number
    movesWithoutWall: number
    unconvertedActions: number
    preservedMoveWalls: number
  }
  keys: {
    uniqueLegacyStateKeys: number
    uniqueQ2StateKeys: number
    uniqueQ3StateKeys: number
    uniqueQ3StateActionPairs: number
    legacyToQ3StateReductionPercentage: number
    q2ToQ3StateReductionPercentage: number
    q2ToQ3Explanation: string
  }
  visits: {
    min: number
    max: number
    mean: number
    median: number
    statesVisitedOnce: number
    statesWithAtLeast2: number
    statesWithAtLeast5: number
    statesWithAtLeast10: number
    statesWithAtLeast20: number
  }
  bucketDistributions: Record<
    'td' | 'mobMine' | 'mobOpponent' | 'trapMine' | 'trapOpponent' | 'walls',
    Record<string, number>
  >
  playersBeforeNormalization: Record<Player, number>
  playersAfterNormalization: Array<{ q3StateKey: string; players: string; visits: number }>
  perspectiveEquivalenceExamples: Array<{ q3StateKey: string; players: string; visits: number }>
  moveWallVariants: Array<{
    moveKey: string
    variants: string[]
    variantCount: number
  }>
  warnings: string[]
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function csvEscape(value: string | number): string {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function stateDistributionToCsv(rows: StateDistributionRow[]): string {
  const headers = [
    'q3StateKey',
    'visits',
    'uniqueActions',
    'players',
    'wins',
    'losses',
    'draws',
    'placeActions',
    'moveWallActions',
    'wallActions',
  ]
  return [
    headers.join(','),
    ...rows.map((row) =>
      headers.map((header) => csvEscape(row[header as keyof StateDistributionRow])).join(','),
    ),
  ].join('\n')
}

function readTraceFiles(inputDir: string): string[] {
  return readdirSync(inputDir)
    .filter((file) => /^training_game_\d+\.json$/.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => path.join(inputDir, file))
}

function validateTrace(raw: unknown): TrainingTraceGameRecord {
  const trace = raw as Partial<TrainingTraceGameRecord>
  if (!trace || typeof trace !== 'object') throw new Error('Trace is not an object')
  if (trace.mode !== 'heuristic_vs_heuristic') throw new Error(`Unsupported mode: ${trace.mode}`)
  if (trace.winner !== 'R' && trace.winner !== 'B' && trace.winner !== 'tie') {
    throw new Error(`Invalid winner: ${String(trace.winner)}`)
  }
  if (!Array.isArray(trace.actions)) throw new Error('Missing actions array')
  return trace as TrainingTraceGameRecord
}

function isSafeMoveWall(move: PlayerAction, wall: PlayerAction): boolean {
  return (
    move.type === 'move' &&
    wall.type === 'wall' &&
    Boolean(wall.dir) &&
    move.pos.x === wall.pos.x &&
    move.pos.y === wall.pos.y
  )
}

function getOutcome(winner: Winner, player: Player): 'wins' | 'losses' | 'draws' {
  if (winner === 'tie') return 'draws'
  return winner === player ? 'wins' : 'losses'
}

function addCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function parseQ3StateParts(q3StateKey: string): Record<string, string> {
  const parts: Record<string, string> = {}
  for (const segment of q3StateKey.split('|').slice(1)) {
    const [key, value] = segment.split(':')
    if (key && value) parts[key] = value
  }
  return parts
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function summarizeVisits(visits: number[]): Q3RepresentationAnalysis['visits'] {
  const total = visits.reduce((sum, value) => sum + value, 0)
  return {
    min: visits.length ? Math.min(...visits) : 0,
    max: visits.length ? Math.max(...visits) : 0,
    mean: visits.length ? roundMetric(total / visits.length) : 0,
    median: roundMetric(median(visits)),
    statesVisitedOnce: visits.filter((value) => value === 1).length,
    statesWithAtLeast2: visits.filter((value) => value >= 2).length,
    statesWithAtLeast5: visits.filter((value) => value >= 5).length,
    statesWithAtLeast10: visits.filter((value) => value >= 10).length,
    statesWithAtLeast20: visits.filter((value) => value >= 20).length,
  }
}

function buildWarnings(
  distributions: Q3RepresentationAnalysis['bucketDistributions'],
  total: number,
): string[] {
  const warnings: string[] = []
  for (const [name, distribution] of Object.entries(distributions)) {
    for (const [bucket, count] of Object.entries(distribution)) {
      if (total > 0 && count / total > 0.7) {
        warnings.push(
          `${name}:${bucket} concentrates ${roundMetric((count / total) * 100)}% of observations`,
        )
      }
    }
    if (Object.keys(distribution).length <= 1) {
      warnings.push(`${name} uses one or zero buckets`)
    }
  }
  return warnings
}

export function analyzeQ3Representation(
  options: AnalyzeQ3RepresentationOptions = {},
): Q3RepresentationAnalysis {
  const inputDir = path.resolve(options.inputDir ?? DEFAULT_Q3_REPRESENTATION_INPUT_DIR)
  const outputDir = path.resolve(options.outputDir ?? DEFAULT_Q3_REPRESENTATION_OUTPUT_DIR)
  const createdAt = options.createdAt ?? new Date().toISOString()
  const writeOutputs = options.writeOutputs ?? true
  const inputFiles = readTraceFiles(inputDir)
  const rejections: Rejection[] = []
  const decisions: LogicalDecision[] = []
  let unconvertedActions = 0

  for (const file of inputFiles) {
    try {
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        throw new Error(`Invalid JSON: ${(error as Error).message}`)
      }
      const trace = validateTrace(raw)
      for (let index = 0; index < trace.actions.length; index++) {
        const entry = trace.actions[index]!
        const state = parseLegacyStateKey(entry.stateKey)
        const action = parseTraceActionKey(entry.actionType, entry.actionKey)
        const nextEntry = trace.actions[index + 1]

        if (action.type === 'move' && nextEntry && nextEntry.player === entry.player) {
          const nextAction = parseTraceActionKey(nextEntry.actionType, nextEntry.actionKey)
          if (nextEntry.turn === entry.turn + 1 && isSafeMoveWall(action, nextAction)) {
            decisions.push({
              traceId: trace.id,
              player: entry.player,
              winner: trace.winner,
              legacyStateKey: entry.stateKey,
              state,
              action: { ...action, followUp: nextAction },
              kind: 'move-wall',
            })
            index++
            continue
          }
        }

        if (action.type === 'place') {
          decisions.push({
            traceId: trace.id,
            player: entry.player,
            winner: trace.winner,
            legacyStateKey: entry.stateKey,
            state,
            action,
            kind: 'place',
          })
        } else if (action.type === 'wall') {
          decisions.push({
            traceId: trace.id,
            player: entry.player,
            winner: trace.winner,
            legacyStateKey: entry.stateKey,
            state,
            action,
            kind: 'wall',
          })
        } else if (action.type === 'move') {
          decisions.push({
            traceId: trace.id,
            player: entry.player,
            winner: trace.winner,
            legacyStateKey: entry.stateKey,
            state,
            action,
            kind: 'move',
          })
        } else {
          unconvertedActions++
        }
      }
    } catch (error) {
      rejections.push({ file, reason: (error as Error).message })
    }
  }

  const legacyStateKeys = new Set<string>()
  const q2StateKeys = new Set<string>()
  const q3StateKeys = new Set<string>()
  const q3StateActionPairs = new Set<string>()
  const playersBeforeNormalization: Record<Player, number> = { R: 0, B: 0 }
  const stateRows: Record<string, StateAccumulator> = {}
  const bucketDistributions: Q3RepresentationAnalysis['bucketDistributions'] = {
    td: {},
    mobMine: {},
    mobOpponent: {},
    trapMine: {},
    trapOpponent: {},
    walls: {},
  }
  const moveWallVariants: Record<string, Record<string, true>> = {}

  for (const decision of decisions) {
    legacyStateKeys.add(decision.legacyStateKey)
    q2StateKeys.add(getLearningStateKey(decision.state))
    const q3StateKey = getLearningStateKeyQ3(decision.state)
    const q3ActionKey = getLearningActionKeyQ3(decision.state, decision.action)
    q3StateKeys.add(q3StateKey)
    q3StateActionPairs.add(getLearningQTableKeyQ3(decision.state, decision.action))
    playersBeforeNormalization[decision.player]++

    const parts = parseQ3StateParts(q3StateKey)
    addCount(bucketDistributions.td, parts.td ?? '')
    const [mobMine, mobOpponent] = (parts.mob ?? ',').split(',')
    addCount(bucketDistributions.mobMine, mobMine ?? '')
    addCount(bucketDistributions.mobOpponent, mobOpponent ?? '')
    const [trapMine, trapOpponent] = (parts.trap ?? ',').split(',')
    addCount(bucketDistributions.trapMine, trapMine ?? '')
    addCount(bucketDistributions.trapOpponent, trapOpponent ?? '')
    addCount(bucketDistributions.walls, parts.walls ?? '')

    const row = stateRows[q3StateKey] ?? {
      visits: 0,
      actions: {},
      players: {},
      wins: 0,
      losses: 0,
      draws: 0,
      placeActions: 0,
      moveWallActions: 0,
      wallActions: 0,
    }
    row.visits++
    row.actions[q3ActionKey] = true
    row.players[decision.player] = true
    row[getOutcome(decision.winner, decision.player)]++
    if (decision.kind === 'place') row.placeActions++
    if (decision.kind === 'move-wall') row.moveWallActions++
    if (decision.kind === 'wall') row.wallActions++
    stateRows[q3StateKey] = row

    if (
      decision.kind === 'move-wall' &&
      decision.action.type === 'move' &&
      decision.action.followUp
    ) {
      const moveOnly = getLearningActionKeyQ3(decision.state, {
        type: 'move',
        from: decision.action.from,
        pos: decision.action.pos,
      })
      moveWallVariants[moveOnly] = moveWallVariants[moveOnly] ?? {}
      moveWallVariants[moveOnly][q3ActionKey] = true
    }
  }

  const stateDistributionRows: StateDistributionRow[] = Object.entries(stateRows)
    .map(([q3StateKey, row]) => ({
      q3StateKey,
      visits: row.visits,
      uniqueActions: Object.keys(row.actions).length,
      players: Object.keys(row.players).sort().join('|'),
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
      placeActions: row.placeActions,
      moveWallActions: row.moveWallActions,
      wallActions: row.wallActions,
    }))
    .sort((a, b) => b.visits - a.visits || a.q3StateKey.localeCompare(b.q3StateKey))

  const visits = stateDistributionRows.map((row) => row.visits)
  const q2ToQ3Reduction = q2StateKeys.size
    ? roundMetric(((q2StateKeys.size - q3StateKeys.size) / q2StateKeys.size) * 100)
    : 0
  const outputFiles = {
    json: path.join(outputDir, 'q3_representation_analysis.json'),
    stateDistributionCsv: path.join(outputDir, 'q3_state_distribution.csv'),
  }

  const analysis: Q3RepresentationAnalysis = {
    createdAt,
    inputFiles,
    outputFiles,
    validation: {
      gamesRead: inputFiles.length,
      validGames: inputFiles.length - rejections.length,
      rejectedGames: rejections.length,
      rejections,
    },
    decisions: {
      logicalDecisions: decisions.length,
      places: decisions.filter((decision) => decision.kind === 'place').length,
      moveWall: decisions.filter((decision) => decision.kind === 'move-wall').length,
      independentWalls: decisions.filter((decision) => decision.kind === 'wall').length,
      movesWithoutWall: decisions.filter((decision) => decision.kind === 'move').length,
      unconvertedActions,
      preservedMoveWalls: decisions.filter((decision) => decision.kind === 'move-wall').length,
    },
    keys: {
      uniqueLegacyStateKeys: legacyStateKeys.size,
      uniqueQ2StateKeys: q2StateKeys.size,
      uniqueQ3StateKeys: q3StateKeys.size,
      uniqueQ3StateActionPairs: q3StateActionPairs.size,
      legacyToQ3StateReductionPercentage: legacyStateKeys.size
        ? roundMetric(((legacyStateKeys.size - q3StateKeys.size) / legacyStateKeys.size) * 100)
        : 0,
      q2ToQ3StateReductionPercentage: q2ToQ3Reduction,
      q2ToQ3Explanation:
        q2ToQ3Reduction >= 0
          ? 'Positive means Q3 has fewer state keys than Q2 on these traces.'
          : 'Negative means Q3 expands the number of state keys compared with Q2 on these traces.',
    },
    visits: summarizeVisits(visits),
    bucketDistributions,
    playersBeforeNormalization,
    playersAfterNormalization: stateDistributionRows
      .filter((row) => row.players.includes('|'))
      .map(({ q3StateKey, players, visits }) => ({ q3StateKey, players, visits }))
      .slice(0, 20),
    perspectiveEquivalenceExamples: stateDistributionRows
      .filter((row) => row.players === 'B|R' || row.players === 'R|B')
      .map(({ q3StateKey, players, visits }) => ({ q3StateKey, players, visits }))
      .slice(0, 10),
    moveWallVariants: Object.entries(moveWallVariants)
      .map(([moveKey, variants]) => ({
        moveKey,
        variants: Object.keys(variants).sort(),
        variantCount: Object.keys(variants).length,
      }))
      .sort((a, b) => b.variantCount - a.variantCount || a.moveKey.localeCompare(b.moveKey))
      .slice(0, 20),
    warnings: buildWarnings(bucketDistributions, decisions.length),
  }

  if (writeOutputs) {
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(outputFiles.json, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8')
    writeFileSync(
      outputFiles.stateDistributionCsv,
      `${stateDistributionToCsv(stateDistributionRows)}\n`,
      'utf8',
    )
  }

  return analysis
}

function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectExecution()) {
  const analysis = analyzeQ3Representation()
  console.log(
    `[analyzeQ3Representation] valid games: ${analysis.validation.validGames}/${analysis.validation.gamesRead}`,
  )
  console.log(`[analyzeQ3Representation] logical decisions: ${analysis.decisions.logicalDecisions}`)
  console.log(`[analyzeQ3Representation] Q3 state keys: ${analysis.keys.uniqueQ3StateKeys}`)
  console.log(`[analyzeQ3Representation] output: ${analysis.outputFiles.json}`)
}
