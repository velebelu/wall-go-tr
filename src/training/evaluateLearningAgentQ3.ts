import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import type { QTableSnapshot } from '@/agents/learningPolicy'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { getBestHeuristicAction, getBestPlacement, getLegalActions } from '@/utils/ai'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { applyActionToState, getTerritoryCounts } from './compareLearningAgents'

export const DEFAULT_Q3_500_QTABLE_PATH = 'data/entrenamiento/q3/checkpoint_500/qtable_q3_500.json'
export const DEFAULT_Q3_500_EVALUATION_DIR =
  'data/entrenamiento/q3/evaluaciones/checkpoint_500_eval200'
export const DEFAULT_Q3_EVALUATION_SEED = 300500
export const Q3_EVALUATION_GAMES_PER_COLOR = 100
export const Q3_EVALUATION_MAX_TURNS = 250

type RivalKind = 'random' | 'learning-empty-Q3' | 'heuristic'
type ActionKindQ3 = 'place' | 'move' | 'wall' | 'move-wall' | 'unknown'

interface ChoiceDiagnostics {
  selectedKey: string
  selectedKeyExists: boolean
  selectedValue: number
  consultedKeys: string[]
  knownLegalActionKeys: string[]
  bestActions: PlayerAction[]
  invalidKeyCount: number
  q2KeyCount: number
}

interface RuntimeDiagnostics {
  decisions: number
  qHits: number
  qMisses: number
  actionDistribution: Record<ActionKindQ3, number>
  consultedStateKeys: Set<string>
  consultedStateActionPairs: Set<string>
  consultedKnownQTableEntries: Set<string>
  decisionsNoKnownAction: number
  decisionsOneKnownAction: number
  decisionsMultipleKnownActions: number
  selectedQValueTotal: number
  tieBreakDecisions: number
  totalBestTiedActions: number
  invalidKeys: number
  q2KeysFound: number
  stateKeysAllQ3: boolean
  moveWallComplete: boolean
}

interface GameResultQ3 {
  rival: RivalKind
  seed: number
  game: number
  colorQ3: Player
  winner: Player | 'tie'
  q3Won: boolean
  tie: boolean
  territoryQ3: number
  territoryRival: number
  territorialDiff: number
  turns: number
  endedByTurnLimit: boolean
  qHits: number
  qMisses: number
  qTableChangedDuringEvaluation: boolean
}

interface RivalSummaryQ3 {
  rival: RivalKind
  games: number
  wins: number
  losses: number
  ties: number
  winRate: number
  byColor: Record<
    Player,
    { games: number; wins: number; losses: number; ties: number; winRate: number }
  >
  averageTerritoryQ3: number
  averageTerritoryRival: number
  averageTerritorialDiff: number
  medianTerritorialDiff: number
  averageTurns: number
  endedByTurnLimit: number
  actionsTotal: number
  qHits: number
  qMisses: number
  qHitRate: number
  actionDistribution: Record<ActionKindQ3, number>
  invalidKeys: number
  q2KeysFound: number
  stateKeysAllQ3: boolean
  moveWallComplete: boolean
  uniqueQ3StatesConsulted: number
  stateActionPairsConsulted: number
  qTableEntriesNeverConsulted: number
  qTableUsagePercentage: number
  decisionsNoKnownAction: number
  decisionsOneKnownAction: number
  decisionsMultipleKnownActions: number
  averageSelectedQValue: number
  tieBreakDecisionPercentage: number
  qTableChangedDuringEvaluation: boolean
  hashBefore: string
  hashAfter: string
}

export interface Q3EvaluationSummary {
  createdAt: string
  model: 'Q3'
  checkpoint: 'Q3-500'
  qTablePath: string
  qTableEntries: number
  qTableHashBefore: string
  qTableHashAfter: string
  qTableChangedDuringEvaluation: boolean
  seeds: {
    baseSeed: number
    gamesPerColor: number
    maxTurns: number
  }
  learningEmptyDefinition: {
    name: 'learning-empty-Q3'
    representation: 'Q3'
    table: 'empty'
    learnsDuringEvaluation: false
    sharesQ3Table: false
  }
  experiments: RivalSummaryQ3[]
  q2Comparison: unknown
}

export interface Q3EvaluationOptions {
  qTablePath?: string
  outputDir?: string
  seed?: number
  gamesPerColor?: number
  maxTurns?: number
  overwrite?: boolean
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function withSeededMathRandom<T>(rng: () => number, fn: () => T): T {
  const previous = Math.random
  Math.random = rng
  try {
    return fn()
  } finally {
    Math.random = previous
  }
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

export const hashFileForTest = hashFile

function loadQTable(qTablePath: string): QTableSnapshot {
  return JSON.parse(readFileSync(path.resolve(qTablePath), 'utf8')) as QTableSnapshot
}

function qTableFingerprint(qTable: QTableSnapshot): string {
  return JSON.stringify(qTable)
}

function assertOutputCanBeWritten(outputDir: string, overwrite: boolean): void {
  if (!existsSync(outputDir)) return
  if (overwrite) return
  if (readdirSync(outputDir).length > 0) {
    throw new Error(`Output directory already exists and is not empty: ${outputDir}`)
  }
}

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function getActionKind(action: PlayerAction | undefined): ActionKindQ3 {
  if (!action) return 'unknown'
  if (action.type === 'move' && action.followUp?.type === 'wall') return 'move-wall'
  return action.type
}

function createDiagnostics(): RuntimeDiagnostics {
  return {
    decisions: 0,
    qHits: 0,
    qMisses: 0,
    actionDistribution: { place: 0, move: 0, wall: 0, 'move-wall': 0, unknown: 0 },
    consultedStateKeys: new Set<string>(),
    consultedStateActionPairs: new Set<string>(),
    consultedKnownQTableEntries: new Set<string>(),
    decisionsNoKnownAction: 0,
    decisionsOneKnownAction: 0,
    decisionsMultipleKnownActions: 0,
    selectedQValueTotal: 0,
    tieBreakDecisions: 0,
    totalBestTiedActions: 0,
    invalidKeys: 0,
    q2KeysFound: 0,
    stateKeysAllQ3: true,
    moveWallComplete: true,
  }
}

function mergeDiagnostics(target: RuntimeDiagnostics, source: RuntimeDiagnostics): void {
  target.decisions += source.decisions
  target.qHits += source.qHits
  target.qMisses += source.qMisses
  for (const key of Object.keys(target.actionDistribution) as ActionKindQ3[]) {
    target.actionDistribution[key] += source.actionDistribution[key]
  }
  source.consultedStateKeys.forEach((key) => target.consultedStateKeys.add(key))
  source.consultedStateActionPairs.forEach((key) => target.consultedStateActionPairs.add(key))
  source.consultedKnownQTableEntries.forEach((key) => target.consultedKnownQTableEntries.add(key))
  target.decisionsNoKnownAction += source.decisionsNoKnownAction
  target.decisionsOneKnownAction += source.decisionsOneKnownAction
  target.decisionsMultipleKnownActions += source.decisionsMultipleKnownActions
  target.selectedQValueTotal += source.selectedQValueTotal
  target.tieBreakDecisions += source.tieBreakDecisions
  target.totalBestTiedActions += source.totalBestTiedActions
  target.invalidKeys += source.invalidKeys
  target.q2KeysFound += source.q2KeysFound
  target.stateKeysAllQ3 = target.stateKeysAllQ3 && source.stateKeysAllQ3
  target.moveWallComplete = target.moveWallComplete && source.moveWallComplete
}

export function inspectQ3ActionChoice(
  state: GameSnapshot,
  legalActions: PlayerAction[],
  qTable: QTableSnapshot,
  rng: () => number,
): { action: PlayerAction; diagnostics: ChoiceDiagnostics } {
  if (legalActions.length === 0) throw new Error('No legal actions available')

  let bestValue = -Infinity
  const bestActions: PlayerAction[] = []
  const consultedKeys: string[] = []
  const knownLegalActionKeys: string[] = []
  let invalidKeyCount = 0
  let q2KeyCount = 0

  for (const action of legalActions) {
    const key = getLearningQTableKeyQ3(state, action)
    consultedKeys.push(key)
    const [stateKey, actionKey] = key.split('|||')
    if (!stateKey?.startsWith('q3|')) q2KeyCount++
    if (action.type === 'move' && action.followUp?.type === 'wall') {
      const parts = actionKey?.split('|') ?? []
      if (parts.length !== 8) invalidKeyCount++
    }
    const exists = qTable[key] !== undefined
    if (exists) knownLegalActionKeys.push(key)
    const value = qTable[key] ?? 0
    if (value > bestValue) {
      bestValue = value
      bestActions.length = 0
      bestActions.push(action)
    } else if (value === bestValue) {
      bestActions.push(action)
    }
  }

  const action = bestActions[Math.floor(rng() * bestActions.length)]!
  const selectedKey = getLearningQTableKeyQ3(state, action)
  return {
    action,
    diagnostics: {
      selectedKey,
      selectedKeyExists: qTable[selectedKey] !== undefined,
      selectedValue: qTable[selectedKey] ?? 0,
      consultedKeys,
      knownLegalActionKeys,
      bestActions,
      invalidKeyCount,
      q2KeyCount,
    },
  }
}

function recordChoiceDiagnostics(
  diagnostics: RuntimeDiagnostics,
  action: PlayerAction,
  choice: ChoiceDiagnostics,
  qTable: QTableSnapshot,
): void {
  diagnostics.decisions++
  if (choice.selectedKeyExists) diagnostics.qHits++
  else diagnostics.qMisses++
  diagnostics.actionDistribution[getActionKind(action)]++
  diagnostics.selectedQValueTotal += choice.selectedValue
  diagnostics.totalBestTiedActions += choice.bestActions.length
  if (choice.bestActions.length > 1) diagnostics.tieBreakDecisions++
  if (choice.knownLegalActionKeys.length === 0) diagnostics.decisionsNoKnownAction++
  else if (choice.knownLegalActionKeys.length === 1) diagnostics.decisionsOneKnownAction++
  else diagnostics.decisionsMultipleKnownActions++
  diagnostics.invalidKeys += choice.invalidKeyCount
  diagnostics.q2KeysFound += choice.q2KeyCount
  if (choice.q2KeyCount > 0) diagnostics.stateKeysAllQ3 = false
  if (choice.invalidKeyCount > 0) diagnostics.moveWallComplete = false
  for (const key of choice.consultedKeys) {
    diagnostics.consultedStateActionPairs.add(key)
    const [stateKey] = key.split('|||')
    if (stateKey) diagnostics.consultedStateKeys.add(stateKey)
    if (qTable[key] !== undefined) diagnostics.consultedKnownQTableEntries.add(key)
  }
}

function applyFullAction(
  state: GameSnapshot,
  action: PlayerAction,
): { state: GameSnapshot; turns: number } {
  let nextState = applyActionToState(state, action)
  let turns = 1
  if (action.followUp && nextState.phase !== 'finished') {
    nextState = applyActionToState(nextState, action.followUp)
    turns += 1
  }
  return { state: nextState, turns }
}

function finalizeIfNeeded(state: GameSnapshot): GameSnapshot {
  if (state.phase === 'finished' || state.result) return state
  const territory = getTerritoryCounts(state.board)
  return {
    ...state,
    phase: 'finished',
    result:
      territory.R === territory.B
        ? { finished: true, tie: true, score: territory }
        : { finished: true, winner: territory.R > territory.B ? 'R' : 'B', score: territory },
  }
}

function chooseRandomAction(state: GameSnapshot, rng: () => number): PlayerAction {
  const legalActions = getLegalActions(state)
  if (legalActions.length === 0) throw new Error(`No legal actions for ${state.turn}`)
  return legalActions[Math.floor(rng() * legalActions.length)]!
}

function chooseHeuristicAction(state: GameSnapshot, rng: () => number): PlayerAction {
  return withSeededMathRandom(rng, () => {
    if (state.phase === 'placing') return getBestPlacement(state)
    return getBestHeuristicAction(state) ?? chooseRandomAction(state, rng)
  })
}

async function runSingleQ3EvaluationGame(params: {
  rival: RivalKind
  game: number
  seed: number
  q3Color: Player
  qTable: QTableSnapshot
  qTablePath: string
  initialFileHash: string
  initialFingerprint: string
  maxTurns: number
}): Promise<{ result: GameResultQ3; diagnostics: RuntimeDiagnostics }> {
  const rng = createSeededRng(params.seed)
  const diagnostics = createDiagnostics()
  const emptyQ3Table: QTableSnapshot = {}
  let state = makeInitialState()
  let turns = 0

  while (state.phase !== 'finished' && !state.result && turns < params.maxTurns) {
    const prevState = snapshotFromState(state)
    const current = prevState.turn
    let action: PlayerAction

    if (current === params.q3Color) {
      const choice = inspectQ3ActionChoice(
        prevState,
        getLegalActions(prevState),
        params.qTable,
        rng,
      )
      action = choice.action
      recordChoiceDiagnostics(diagnostics, action, choice.diagnostics, params.qTable)
    } else if (params.rival === 'random') {
      action = chooseRandomAction(prevState, rng)
    } else if (params.rival === 'heuristic') {
      action = chooseHeuristicAction(prevState, rng)
    } else {
      const choice = inspectQ3ActionChoice(prevState, getLegalActions(prevState), emptyQ3Table, rng)
      action = choice.action
    }

    const applied = applyFullAction(state, action)
    state = applied.state
    turns += applied.turns
  }

  const endedByTurnLimit = state.phase !== 'finished' && !state.result
  state = finalizeIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')
  const rivalColor = getOpponent(params.q3Color)
  const qTableChangedDuringEvaluation =
    hashFile(params.qTablePath) !== params.initialFileHash ||
    qTableFingerprint(params.qTable) !== params.initialFingerprint ||
    Object.keys(params.qTable).length !==
      Object.keys(JSON.parse(readFileSync(params.qTablePath, 'utf8'))).length

  return {
    result: {
      rival: params.rival,
      seed: params.seed,
      game: params.game,
      colorQ3: params.q3Color,
      winner,
      q3Won: winner === params.q3Color,
      tie: winner === 'tie',
      territoryQ3: territory[params.q3Color],
      territoryRival: territory[rivalColor],
      territorialDiff: territory[params.q3Color] - territory[rivalColor],
      turns,
      endedByTurnLimit,
      qHits: diagnostics.qHits,
      qMisses: diagnostics.qMisses,
      qTableChangedDuringEvaluation,
    },
    diagnostics,
  }
}

function summarizeRival(
  rival: RivalKind,
  results: GameResultQ3[],
  diagnostics: RuntimeDiagnostics,
  qTableEntries: number,
  hashBefore: string,
  hashAfter: string,
): RivalSummaryQ3 {
  const wins = results.filter((result) => result.q3Won).length
  const ties = results.filter((result) => result.tie).length
  const losses = results.length - wins - ties
  const byColor = Object.fromEntries(
    (['R', 'B'] as const).map((color) => {
      const colorResults = results.filter((result) => result.colorQ3 === color)
      const colorWins = colorResults.filter((result) => result.q3Won).length
      const colorTies = colorResults.filter((result) => result.tie).length
      const colorLosses = colorResults.length - colorWins - colorTies
      return [
        color,
        {
          games: colorResults.length,
          wins: colorWins,
          losses: colorLosses,
          ties: colorTies,
          winRate: colorResults.length ? roundMetric((colorWins / colorResults.length) * 100) : 0,
        },
      ]
    }),
  ) as RivalSummaryQ3['byColor']
  const qTotal = diagnostics.qHits + diagnostics.qMisses
  return {
    rival,
    games: results.length,
    wins,
    losses,
    ties,
    winRate: results.length ? roundMetric((wins / results.length) * 100) : 0,
    byColor,
    averageTerritoryQ3: roundMetric(
      results.reduce((sum, result) => sum + result.territoryQ3, 0) / results.length,
    ),
    averageTerritoryRival: roundMetric(
      results.reduce((sum, result) => sum + result.territoryRival, 0) / results.length,
    ),
    averageTerritorialDiff: roundMetric(
      results.reduce((sum, result) => sum + result.territorialDiff, 0) / results.length,
    ),
    medianTerritorialDiff: roundMetric(median(results.map((result) => result.territorialDiff))),
    averageTurns: roundMetric(
      results.reduce((sum, result) => sum + result.turns, 0) / results.length,
    ),
    endedByTurnLimit: results.filter((result) => result.endedByTurnLimit).length,
    actionsTotal: diagnostics.decisions,
    qHits: diagnostics.qHits,
    qMisses: diagnostics.qMisses,
    qHitRate: qTotal ? roundMetric((diagnostics.qHits / qTotal) * 100) : 0,
    actionDistribution: diagnostics.actionDistribution,
    invalidKeys: diagnostics.invalidKeys,
    q2KeysFound: diagnostics.q2KeysFound,
    stateKeysAllQ3: diagnostics.stateKeysAllQ3,
    moveWallComplete: diagnostics.moveWallComplete,
    uniqueQ3StatesConsulted: diagnostics.consultedStateKeys.size,
    stateActionPairsConsulted: diagnostics.consultedStateActionPairs.size,
    qTableEntriesNeverConsulted: qTableEntries - diagnostics.consultedKnownQTableEntries.size,
    qTableUsagePercentage: qTableEntries
      ? roundMetric((diagnostics.consultedKnownQTableEntries.size / qTableEntries) * 100)
      : 0,
    decisionsNoKnownAction: diagnostics.decisionsNoKnownAction,
    decisionsOneKnownAction: diagnostics.decisionsOneKnownAction,
    decisionsMultipleKnownActions: diagnostics.decisionsMultipleKnownActions,
    averageSelectedQValue: diagnostics.decisions
      ? roundMetric(diagnostics.selectedQValueTotal / diagnostics.decisions)
      : 0,
    tieBreakDecisionPercentage: diagnostics.decisions
      ? roundMetric((diagnostics.tieBreakDecisions / diagnostics.decisions) * 100)
      : 0,
    qTableChangedDuringEvaluation:
      results.some((result) => result.qTableChangedDuringEvaluation) || hashBefore !== hashAfter,
    hashBefore,
    hashAfter,
  }
}

function csvEscape(value: string | number | boolean): string {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function resultsToCsv(results: GameResultQ3[]): string {
  const headers = [
    'rival',
    'seed',
    'game',
    'colorQ3',
    'winner',
    'territoryQ3',
    'territoryRival',
    'diferenciaTerritorial',
    'turns',
    'qHits',
    'qMisses',
    'qTableChangedDuringEvaluation',
  ]
  const rows = results.map((result) => [
    result.rival,
    result.seed,
    result.game,
    result.colorQ3,
    result.winner,
    result.territoryQ3,
    result.territoryRival,
    result.territorialDiff,
    result.turns,
    result.qHits,
    result.qMisses,
    result.qTableChangedDuringEvaluation,
  ])
  return [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n')
}

function readJsonIfExists(filePath: string): unknown | undefined {
  if (!existsSync(filePath)) return undefined
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
}

function buildQ2Comparison(q3Experiments: RivalSummaryQ3[]): unknown {
  const q2Files = {
    q2_500: 'data/entrenamiento/q2/evaluaciones/checkpoint_0500/learning_comparison_summary.json',
    q2_2000: 'data/entrenamiento/q2/evaluaciones/checkpoint_2000/learning_comparison_summary.json',
    q2_2000_eval100:
      'data/entrenamiento/q2/evaluaciones/checkpoint_2000_eval100/learning_comparison_summary.json',
  }
  return {
    note: 'Descriptive comparison only. Q3 uses learning-empty-Q3, while Q2 summaries may use learning-empty with Q2 keys.',
    q3_500: q3Experiments.map((experiment) => ({
      rival: experiment.rival,
      winRate: experiment.winRate,
      averageTerritorialDiff: experiment.averageTerritorialDiff,
      colorWinRates: { R: experiment.byColor.R.winRate, B: experiment.byColor.B.winRate },
      qHitRate: experiment.qHitRate,
    })),
    q2Sources: Object.fromEntries(
      Object.entries(q2Files).map(([name, file]) => [name, readJsonIfExists(file) ? file : null]),
    ),
  }
}

export async function runLearningAgentQ3Evaluation(
  options: Q3EvaluationOptions = {},
): Promise<{ summary: Q3EvaluationSummary; results: GameResultQ3[]; outputDir: string }> {
  const qTablePath = path.resolve(options.qTablePath ?? DEFAULT_Q3_500_QTABLE_PATH)
  const outputDir = path.resolve(options.outputDir ?? DEFAULT_Q3_500_EVALUATION_DIR)
  const seed = options.seed ?? DEFAULT_Q3_EVALUATION_SEED
  const gamesPerColor = options.gamesPerColor ?? Q3_EVALUATION_GAMES_PER_COLOR
  const maxTurns = options.maxTurns ?? Q3_EVALUATION_MAX_TURNS
  assertOutputCanBeWritten(outputDir, options.overwrite ?? false)

  const qTable = Object.freeze({ ...loadQTable(qTablePath) }) as QTableSnapshot
  const qTableEntries = Object.keys(qTable).length
  const hashBefore = hashFile(qTablePath)
  const fingerprintBefore = qTableFingerprint(qTable)
  const allResults: GameResultQ3[] = []
  const summaries: RivalSummaryQ3[] = []
  let globalGame = 0

  for (const rival of ['random', 'learning-empty-Q3', 'heuristic'] as const) {
    const rivalDiagnostics = createDiagnostics()
    const rivalResults: GameResultQ3[] = []
    const rivalHashBefore = hashFile(qTablePath)
    for (const colorQ3 of ['R', 'B'] as const) {
      for (let game = 1; game <= gamesPerColor; game++) {
        globalGame++
        const result = await runSingleQ3EvaluationGame({
          rival,
          game,
          seed: seed + globalGame,
          q3Color: colorQ3,
          qTable,
          qTablePath,
          initialFileHash: hashBefore,
          initialFingerprint: fingerprintBefore,
          maxTurns,
        })
        mergeDiagnostics(rivalDiagnostics, result.diagnostics)
        rivalResults.push(result.result)
        allResults.push(result.result)
        if (result.result.qTableChangedDuringEvaluation) {
          throw new Error(`Q3 qTable changed during evaluation against ${rival}`)
        }
      }
    }
    const rivalHashAfter = hashFile(qTablePath)
    if (rivalHashBefore !== rivalHashAfter) {
      throw new Error(`Q3 qTable file hash changed during evaluation against ${rival}`)
    }
    summaries.push(
      summarizeRival(
        rival,
        rivalResults,
        rivalDiagnostics,
        qTableEntries,
        rivalHashBefore,
        rivalHashAfter,
      ),
    )
  }

  const hashAfter = hashFile(qTablePath)
  const summary: Q3EvaluationSummary = {
    createdAt: new Date().toISOString(),
    model: 'Q3',
    checkpoint: 'Q3-500',
    qTablePath,
    qTableEntries,
    qTableHashBefore: hashBefore,
    qTableHashAfter: hashAfter,
    qTableChangedDuringEvaluation:
      hashBefore !== hashAfter || qTableFingerprint(qTable) !== fingerprintBefore,
    seeds: { baseSeed: seed, gamesPerColor, maxTurns },
    learningEmptyDefinition: {
      name: 'learning-empty-Q3',
      representation: 'Q3',
      table: 'empty',
      learnsDuringEvaluation: false,
      sharesQ3Table: false,
    },
    experiments: summaries,
    q2Comparison: buildQ2Comparison(summaries),
  }

  if (summary.qTableChangedDuringEvaluation) {
    throw new Error('Q3 qTable changed during evaluation')
  }

  mkdirSync(outputDir, { recursive: true })
  writeFileSync(
    path.join(outputDir, 'learning_comparison_summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    path.join(outputDir, 'learning_comparison_results.csv'),
    `${resultsToCsv(allResults)}\n`,
    'utf8',
  )
  writeFileSync(
    path.join(outputDir, 'evaluation_metadata.json'),
    `${JSON.stringify(
      {
        createdAt: summary.createdAt,
        qTablePath,
        qTableEntries,
        hashBefore,
        hashAfter,
        outputDir,
        protocol: {
          rivals: ['random', 'learning-empty-Q3', 'heuristic'],
          gamesPerRival: gamesPerColor * 2,
          gamesPerColor,
          totalGames: allResults.length,
          epsilon: 0,
          tieBreak: 'random among max-Q actions using seeded RNG, matching Q2 tie behavior',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return { summary, results: allResults, outputDir }
}

async function runCli(): Promise<void> {
  const result = await runLearningAgentQ3Evaluation()
  console.log(`[evaluateLearningAgentQ3] games: ${result.results.length}`)
  console.log(`[evaluateLearningAgentQ3] output: ${result.outputDir}`)
}

function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectExecution()) {
  await runCli()
}
