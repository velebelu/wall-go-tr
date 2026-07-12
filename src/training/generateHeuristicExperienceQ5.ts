import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import {
  calculatePlayerMobilityQ3,
  getLearningActionKeyQ3,
  getLearningStateKeyQ3,
} from '@/agents/learningPolicyQ3'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import * as ai from '@/utils/ai'
import { applyActionToState, getTerritoryCounts } from './compareLearningAgents'
import {
  chooseHeuristicOpponentActionQ4,
  chooseRandomActionWithRngQ4,
  createSeededRngQ4,
} from './trainLearningAgentQ4'

export const Q5_HEURISTIC_EXPERIENCE_BASE_DIR = 'data/entrenamiento/q5/heuristic_experience'
export const Q5_HEURISTIC_EXPERIENCE_PILOT_40_DIR = path.join(
  Q5_HEURISTIC_EXPERIENCE_BASE_DIR,
  'pilot_40',
)
export const Q5_HEURISTIC_EXPERIENCE_DATASET_2000_DIR = path.join(
  Q5_HEURISTIC_EXPERIENCE_BASE_DIR,
  'dataset_2000',
)
export const Q5_HEURISTIC_EXPERIENCE_MAX_TURNS = 250

export type Q5HeuristicExperienceOpponent = 'random' | 'heuristic'

export interface Q5HeuristicExperienceScheduleItem {
  gameId: number
  seed: number
  opponent: Q5HeuristicExperienceOpponent
  heuristicColor: Player
}

export interface Q5HeuristicExperienceConfig {
  totalGames: number
  seedBase: number
  outputDir: string
  maxTurns: number
  overwrite: boolean
}

export interface Q5HeuristicExperienceRecord {
  experienceId: string
  gameId: number
  seed: number
  opponent: Q5HeuristicExperienceOpponent
  heuristicColor: Player
  turnNumber: number
  previousQ3State: string
  heuristicAction: PlayerAction
  heuristicActionQ3Key: string
  nextQ3State: string
  previousTerritoryDiff: number
  nextTerritoryDiff: number
  previousOwnMobility: number
  nextOwnMobility: number
  previousOwnTrappedPieces: number
  nextOwnTrappedPieces: number
  legalActionsAvailable: number
  legalActionQ3Keys: string[]
  actionWasLegal: boolean
  winner: Player | 'tie'
  finalTerritoryDiff: number
  totalTurns: number
}

interface GameResult {
  gameId: number
  seed: number
  opponent: Q5HeuristicExperienceOpponent
  heuristicColor: Player
  opponentColor: Player
  winner: Player | 'tie'
  resultForHeuristic: 'win' | 'loss' | 'tie'
  territoryHeuristic: number
  territoryOpponent: number
  territoryDiff: number
  averageOwnMobilityBefore: number
  averageOwnMobilityAfter: number
  averageOwnTrappedBefore: number
  averageOwnTrappedAfter: number
  totalTurns: number
  experiences: number
}

interface ResultStats {
  games: number
  wins: number
  losses: number
  ties: number
}

interface ExperienceSummary {
  totalGames: number
  totalExperiences: number
  gamesByOpponent: Record<Q5HeuristicExperienceOpponent, number>
  gamesByColor: Record<Player, number>
  gamesByCombination: Record<string, number>
  experiencesByOpponent: Record<Q5HeuristicExperienceOpponent, number>
  experiencesByColor: Record<Player, number>
  results: ResultStats
  resultsByOpponent: Record<Q5HeuristicExperienceOpponent, ResultStats>
  resultsByColor: Record<Player, ResultStats>
  averageTerritory: {
    heuristic: number
    opponent: number
  }
  averageTerritoryDiff: number
  averagePreviousOwnMobility: number
  averageNextOwnMobility: number
  averagePreviousOwnTrappedPieces: number
  averageNextOwnTrappedPieces: number
  averageTurns: number
  coverage: CoverageSummary
  validations: ValidationSummary
}

interface ConditionSummary {
  games: number
  experiences: number
  wins: number
  losses: number
  ties: number
  averageExperiences: number
  averageTerritoryDiff: number
  averageTurns: number
  averageDeltaTerritory: number
  averageDeltaMobility: number
  averageDeltaTrappedPieces: number
}

interface CoverageSummary {
  totalExperiences: number
  uniqueStates: number
  uniqueStateActionPairs: number
  averageObservedActionsPerState: number
  stateActionFrequency: {
    min: number
    mean: number
    median: number
    max: number
  }
  repeatedExperiencePercentage: number
  distribution: {
    opponents: Record<Q5HeuristicExperienceOpponent, number>
    colors: Record<Player, number>
    results: Record<'win' | 'loss' | 'tie', number>
  }
  heuristicVsHeuristicByColor: Record<Player, ResultStats>
  conditions: Record<string, ConditionSummary>
  averageDeltas: {
    territory: number
    mobility: number
    trappedPieces: number
  }
}

interface ValidationSummary {
  allActionsLegal: boolean
  allStatesUseQ3: boolean
  plannedConditionCountsPreserved: boolean
  sameHeuristicConfigurationBothSides: boolean
  averageExperiencesByOpponent: Record<Q5HeuristicExperienceOpponent, number>
  colorBias: {
    winRateR: number
    winRateB: number
    differencePercentagePoints: number
  }
  heuristicMirrorOrderBias: {
    games: number
    winRateAsR: number
    winRateAsB: number
    differencePercentagePoints: number
  }
}

export interface Q5HeuristicExperienceMetadata {
  model: 'Q5'
  artifact: 'heuristic_experience'
  seedBase: number
  totalGames: number
  maxTurns: number
  stateRepresentation: 'Q3'
  qTableCreated: false
  qLearningTrainingExecuted: false
  heuristicPolicy: {
    placement: 'getBestPlacement'
    playing: 'getBestHeuristicAction'
    policy: 'default'
  }
  targetDistribution: {
    opponents: Record<Q5HeuristicExperienceOpponent, number>
    colors: Record<Player, number>
    combinations: Record<string, number>
  }
  schedule: Q5HeuristicExperienceScheduleItem[]
  games: GameResult[]
  summary: ExperienceSummary
  createdAt: string
  durationMs: number
  outputFiles: {
    metadata: string
    experienceSummary: string
    experiencesJsonl: string
    gameResultsCsv: string
  }
}

export const DEFAULT_Q5_HEURISTIC_EXPERIENCE_CONFIG: Q5HeuristicExperienceConfig = {
  totalGames: 40,
  seedBase: 3,
  outputDir: Q5_HEURISTIC_EXPERIENCE_PILOT_40_DIR,
  maxTurns: Q5_HEURISTIC_EXPERIENCE_MAX_TURNS,
  overwrite: false,
}

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4))
}

function combinationKey(opponent: Q5HeuristicExperienceOpponent, color: Player): string {
  return `${opponent}_${color}`
}

function assertOutputCanBeWritten(outputDir: string, overwrite: boolean): void {
  if (!existsSync(outputDir)) return
  if (overwrite) return
  if (readdirSync(outputDir).length > 0) {
    throw new Error(`Output directory already exists and is not empty: ${outputDir}`)
  }
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function writeJsonl(filePath: string, records: Q5HeuristicExperienceRecord[]): void {
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

function csvEscape(value: unknown): string {
  const text = String(value)
  if (!/[",\n\r]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function writeGameResultsCsv(filePath: string, games: GameResult[]): void {
  const header = [
    'gameId',
    'seed',
    'opponent',
    'heuristicColor',
    'opponentColor',
    'winner',
    'resultForHeuristic',
    'territoryHeuristic',
    'territoryOpponent',
    'territoryDiff',
    'averageOwnMobilityBefore',
    'averageOwnMobilityAfter',
    'averageOwnTrappedBefore',
    'averageOwnTrappedAfter',
    'totalTurns',
    'experiences',
  ]
  const rows = games.map((game) => header.map((key) => csvEscape(game[key as keyof GameResult])))
  writeFileSync(filePath, `${[header, ...rows].map((row) => row.join(',')).join('\n')}\n`, 'utf8')
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

function finalizeGameIfNeeded(state: GameSnapshot): GameSnapshot {
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

function getTerritoryDiff(state: GameSnapshot, player: Player): number {
  const opponent = getOpponent(player)
  const territory = getTerritoryCounts(state.board)
  return territory[player] - territory[opponent]
}

function isSameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function createResultStats(): ResultStats {
  return { games: 0, wins: 0, losses: 0, ties: 0 }
}

function addResult(stats: ResultStats, result: GameResult['resultForHeuristic']): void {
  stats.games++
  if (result === 'win') stats.wins++
  else if (result === 'loss') stats.losses++
  else stats.ties++
}

export function buildBalancedQ5HeuristicExperienceSchedule(
  totalGames: number,
  seedBase: number,
): Q5HeuristicExperienceScheduleItem[] {
  if (totalGames % 4 !== 0) throw new Error('Q5 heuristic experience games must divide by 4')
  const block = [
    { opponent: 'random', heuristicColor: 'R' },
    { opponent: 'random', heuristicColor: 'B' },
    { opponent: 'heuristic', heuristicColor: 'R' },
    { opponent: 'heuristic', heuristicColor: 'B' },
  ] satisfies Array<Omit<Q5HeuristicExperienceScheduleItem, 'gameId' | 'seed'>>
  const schedule: Q5HeuristicExperienceScheduleItem[] = []

  for (let offset = 0; offset < totalGames; offset += block.length) {
    for (const item of block) {
      const gameId = schedule.length + 1
      schedule.push({ ...item, gameId, seed: seedBase * 1000 + gameId })
    }
  }

  return schedule
}

function buildTargetDistribution(
  totalGames: number,
): Q5HeuristicExperienceMetadata['targetDistribution'] {
  return {
    opponents: { random: totalGames / 2, heuristic: totalGames / 2 },
    colors: { R: totalGames / 2, B: totalGames / 2 },
    combinations: {
      random_R: totalGames / 4,
      random_B: totalGames / 4,
      heuristic_R: totalGames / 4,
      heuristic_B: totalGames / 4,
    },
  }
}

function createConditionSummary(): ConditionSummary {
  return {
    games: 0,
    experiences: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    averageExperiences: 0,
    averageTerritoryDiff: 0,
    averageTurns: 0,
    averageDeltaTerritory: 0,
    averageDeltaMobility: 0,
    averageDeltaTrappedPieces: 0,
  }
}

function addGameToCondition(summary: ConditionSummary, game: GameResult): void {
  summary.games++
  summary.experiences += game.experiences
  if (game.resultForHeuristic === 'win') summary.wins++
  else if (game.resultForHeuristic === 'loss') summary.losses++
  else summary.ties++
  summary.averageTerritoryDiff += game.territoryDiff
  summary.averageTurns += game.totalTurns
}

function addExperienceToCondition(
  summary: ConditionSummary,
  experience: Q5HeuristicExperienceRecord,
): void {
  summary.averageDeltaTerritory += experience.nextTerritoryDiff - experience.previousTerritoryDiff
  summary.averageDeltaMobility += experience.nextOwnMobility - experience.previousOwnMobility
  summary.averageDeltaTrappedPieces +=
    experience.nextOwnTrappedPieces - experience.previousOwnTrappedPieces
}

function finalizeConditionSummary(summary: ConditionSummary): void {
  summary.averageExperiences = summary.games ? roundMetric(summary.experiences / summary.games) : 0
  summary.averageTerritoryDiff = summary.games
    ? roundMetric(summary.averageTerritoryDiff / summary.games)
    : 0
  summary.averageTurns = summary.games ? roundMetric(summary.averageTurns / summary.games) : 0
  summary.averageDeltaTerritory = summary.experiences
    ? roundMetric(summary.averageDeltaTerritory / summary.experiences)
    : 0
  summary.averageDeltaMobility = summary.experiences
    ? roundMetric(summary.averageDeltaMobility / summary.experiences)
    : 0
  summary.averageDeltaTrappedPieces = summary.experiences
    ? roundMetric(summary.averageDeltaTrappedPieces / summary.experiences)
    : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function winRate(stats: ResultStats): number {
  return stats.games ? roundMetric((stats.wins / stats.games) * 100) : 0
}

function buildCoverageSummary(
  games: GameResult[],
  experiences: Q5HeuristicExperienceRecord[],
): CoverageSummary {
  const states: Record<string, true> = {}
  const stateActions: Record<string, number> = {}
  const actionsPerState: Record<string, Record<string, true>> = {}
  const resultDistribution: Record<'win' | 'loss' | 'tie', number> = { win: 0, loss: 0, tie: 0 }
  const heuristicVsHeuristicByColor: Record<Player, ResultStats> = {
    R: createResultStats(),
    B: createResultStats(),
  }
  const conditions: Record<string, ConditionSummary> = {
    random_R: createConditionSummary(),
    random_B: createConditionSummary(),
    heuristic_R: createConditionSummary(),
    heuristic_B: createConditionSummary(),
  }

  for (const game of games) {
    const key = combinationKey(game.opponent, game.heuristicColor)
    addGameToCondition(conditions[key], game)
    if (game.resultForHeuristic === 'win') resultDistribution.win++
    else if (game.resultForHeuristic === 'loss') resultDistribution.loss++
    else resultDistribution.tie++
    if (game.opponent === 'heuristic') {
      addResult(heuristicVsHeuristicByColor[game.heuristicColor], game.resultForHeuristic)
    }
  }

  let deltaTerritory = 0
  let deltaMobility = 0
  let deltaTrappedPieces = 0
  for (const experience of experiences) {
    states[experience.previousQ3State] = true
    states[experience.nextQ3State] = true
    const pairKey = `${experience.previousQ3State}|||${experience.heuristicActionQ3Key}`
    stateActions[pairKey] = (stateActions[pairKey] ?? 0) + 1
    actionsPerState[experience.previousQ3State] ??= {}
    actionsPerState[experience.previousQ3State][experience.heuristicActionQ3Key] = true
    deltaTerritory += experience.nextTerritoryDiff - experience.previousTerritoryDiff
    deltaMobility += experience.nextOwnMobility - experience.previousOwnMobility
    deltaTrappedPieces += experience.nextOwnTrappedPieces - experience.previousOwnTrappedPieces
    addExperienceToCondition(
      conditions[combinationKey(experience.opponent, experience.heuristicColor)],
      experience,
    )
  }

  for (const condition of Object.values(conditions)) {
    finalizeConditionSummary(condition)
  }

  const frequencies = Object.values(stateActions)
  const repeatedExperiences = frequencies.reduce(
    (sum, frequency) => sum + Math.max(0, frequency - 1),
    0,
  )
  const observedActionCounts = Object.values(actionsPerState).map(
    (actions) => Object.keys(actions).length,
  )
  const averageObservedActionsPerState = observedActionCounts.length
    ? observedActionCounts.reduce((sum, count) => sum + count, 0) / observedActionCounts.length
    : 0

  return {
    totalExperiences: experiences.length,
    uniqueStates: Object.keys(states).length,
    uniqueStateActionPairs: Object.keys(stateActions).length,
    averageObservedActionsPerState: roundMetric(averageObservedActionsPerState),
    stateActionFrequency: {
      min: frequencies.length ? Math.min(...frequencies) : 0,
      mean: frequencies.length
        ? roundMetric(
            frequencies.reduce((sum, frequency) => sum + frequency, 0) / frequencies.length,
          )
        : 0,
      median: roundMetric(median(frequencies)),
      max: frequencies.length ? Math.max(...frequencies) : 0,
    },
    repeatedExperiencePercentage: experiences.length
      ? roundMetric((repeatedExperiences / experiences.length) * 100)
      : 0,
    distribution: {
      opponents: {
        random: experiences.filter((experience) => experience.opponent === 'random').length,
        heuristic: experiences.filter((experience) => experience.opponent === 'heuristic').length,
      },
      colors: {
        R: experiences.filter((experience) => experience.heuristicColor === 'R').length,
        B: experiences.filter((experience) => experience.heuristicColor === 'B').length,
      },
      results: resultDistribution,
    },
    heuristicVsHeuristicByColor,
    conditions,
    averageDeltas: {
      territory: experiences.length ? roundMetric(deltaTerritory / experiences.length) : 0,
      mobility: experiences.length ? roundMetric(deltaMobility / experiences.length) : 0,
      trappedPieces: experiences.length ? roundMetric(deltaTrappedPieces / experiences.length) : 0,
    },
  }
}

function buildValidationSummary(
  games: GameResult[],
  experiences: Q5HeuristicExperienceRecord[],
  totalGames: number,
): ValidationSummary {
  const resultsByColor: Record<Player, ResultStats> = {
    R: createResultStats(),
    B: createResultStats(),
  }
  const heuristicByColor: Record<Player, ResultStats> = {
    R: createResultStats(),
    B: createResultStats(),
  }
  for (const game of games) {
    addResult(resultsByColor[game.heuristicColor], game.resultForHeuristic)
    if (game.opponent === 'heuristic')
      addResult(heuristicByColor[game.heuristicColor], game.resultForHeuristic)
  }
  const winRateR = winRate(resultsByColor.R)
  const winRateB = winRate(resultsByColor.B)
  const heuristicWinRateR = winRate(heuristicByColor.R)
  const heuristicWinRateB = winRate(heuristicByColor.B)

  return {
    allActionsLegal: experiences.every((experience) => experience.actionWasLegal),
    allStatesUseQ3: experiences.every(
      (experience) =>
        experience.previousQ3State.startsWith('q3|') && experience.nextQ3State.startsWith('q3|'),
    ),
    plannedConditionCountsPreserved: games.length === totalGames,
    sameHeuristicConfigurationBothSides: true,
    averageExperiencesByOpponent: {
      random: games.filter((game) => game.opponent === 'random').length
        ? roundMetric(
            experiences.filter((experience) => experience.opponent === 'random').length /
              games.filter((game) => game.opponent === 'random').length,
          )
        : 0,
      heuristic: games.filter((game) => game.opponent === 'heuristic').length
        ? roundMetric(
            experiences.filter((experience) => experience.opponent === 'heuristic').length /
              games.filter((game) => game.opponent === 'heuristic').length,
          )
        : 0,
    },
    colorBias: {
      winRateR,
      winRateB,
      differencePercentagePoints: roundMetric(winRateR - winRateB),
    },
    heuristicMirrorOrderBias: {
      games: games.filter((game) => game.opponent === 'heuristic').length,
      winRateAsR: heuristicWinRateR,
      winRateAsB: heuristicWinRateB,
      differencePercentagePoints: roundMetric(heuristicWinRateR - heuristicWinRateB),
    },
  }
}

function chooseAction(params: {
  state: GameSnapshot
  agent: Q5HeuristicExperienceOpponent
  rng: () => number
}): PlayerAction {
  if (params.agent === 'random') {
    return chooseRandomActionWithRngQ4(ai.getLegalActions(params.state), params.rng)
  }
  return chooseHeuristicOpponentActionQ4(params.state, params.rng)
}

function createExperience(params: {
  gameId: number
  seed: number
  opponent: Q5HeuristicExperienceOpponent
  heuristicColor: Player
  turnNumber: number
  previousState: GameSnapshot
  action: PlayerAction
  nextState: GameSnapshot
}): Omit<Q5HeuristicExperienceRecord, 'winner' | 'finalTerritoryDiff' | 'totalTurns'> {
  const legalActions = ai.getLegalActions(params.previousState)
  const previousMobility = calculatePlayerMobilityQ3(params.previousState, params.heuristicColor)
  const nextMobility = calculatePlayerMobilityQ3(params.nextState, params.heuristicColor)

  return {
    experienceId: `${params.gameId}:${params.turnNumber}`,
    gameId: params.gameId,
    seed: params.seed,
    opponent: params.opponent,
    heuristicColor: params.heuristicColor,
    turnNumber: params.turnNumber,
    previousQ3State: getLearningStateKeyQ3(params.previousState),
    heuristicAction: params.action,
    heuristicActionQ3Key: getLearningActionKeyQ3(params.previousState, params.action),
    nextQ3State: getLearningStateKeyQ3(params.nextState),
    previousTerritoryDiff: getTerritoryDiff(params.previousState, params.heuristicColor),
    nextTerritoryDiff: getTerritoryDiff(params.nextState, params.heuristicColor),
    previousOwnMobility: previousMobility.totalDestinations,
    nextOwnMobility: nextMobility.totalDestinations,
    previousOwnTrappedPieces: previousMobility.trapPieces,
    nextOwnTrappedPieces: nextMobility.trapPieces,
    legalActionsAvailable: legalActions.length,
    legalActionQ3Keys: legalActions.map((action) =>
      getLearningActionKeyQ3(params.previousState, action),
    ),
    actionWasLegal: legalActions.some((legalAction) => isSameAction(legalAction, params.action)),
  }
}

async function runExperienceGame(params: {
  scheduleItem: Q5HeuristicExperienceScheduleItem
  maxTurns: number
}): Promise<{ game: GameResult; experiences: Q5HeuristicExperienceRecord[] }> {
  let state = makeInitialState()
  const heuristicColor = params.scheduleItem.heuristicColor
  const opponentColor = getOpponent(heuristicColor)
  const rng = createSeededRngQ4(params.scheduleItem.seed)
  const experiences: Array<
    Omit<Q5HeuristicExperienceRecord, 'winner' | 'finalTerritoryDiff' | 'totalTurns'>
  > = []
  let turns = 0

  while (state.phase !== 'finished' && !state.result && turns < params.maxTurns) {
    const previousState = snapshotFromState(state)
    const isHeuristicTurn = previousState.turn === heuristicColor
    const agent = isHeuristicTurn ? 'heuristic' : params.scheduleItem.opponent
    const action = chooseAction({ state: previousState, agent, rng })
    const applied = applyFullAction(state, action)
    state = applied.state
    turns += applied.turns

    if (isHeuristicTurn) {
      experiences.push(
        createExperience({
          gameId: params.scheduleItem.gameId,
          seed: params.scheduleItem.seed,
          opponent: params.scheduleItem.opponent,
          heuristicColor,
          turnNumber: turns,
          previousState,
          action,
          nextState: state,
        }),
      )
    }
  }

  state = finalizeGameIfNeeded(state)
  const territory = state.result?.score ?? getTerritoryCounts(state.board)
  const winner: Player | 'tie' = state.result?.tie ? 'tie' : (state.result?.winner ?? 'tie')
  const finalTerritoryDiff = territory[heuristicColor] - territory[opponentColor]
  const completedExperiences = experiences.map((experience) => ({
    ...experience,
    winner,
    finalTerritoryDiff,
    totalTurns: turns,
  }))

  const averagePreviousOwnMobility = completedExperiences.length
    ? completedExperiences.reduce((sum, experience) => sum + experience.previousOwnMobility, 0) /
      completedExperiences.length
    : 0
  const averageNextOwnMobility = completedExperiences.length
    ? completedExperiences.reduce((sum, experience) => sum + experience.nextOwnMobility, 0) /
      completedExperiences.length
    : 0
  const averageOwnTrappedBefore = completedExperiences.length
    ? completedExperiences.reduce(
        (sum, experience) => sum + experience.previousOwnTrappedPieces,
        0,
      ) / completedExperiences.length
    : 0
  const averageOwnTrappedAfter = completedExperiences.length
    ? completedExperiences.reduce((sum, experience) => sum + experience.nextOwnTrappedPieces, 0) /
      completedExperiences.length
    : 0

  return {
    game: {
      gameId: params.scheduleItem.gameId,
      seed: params.scheduleItem.seed,
      opponent: params.scheduleItem.opponent,
      heuristicColor,
      opponentColor,
      winner,
      resultForHeuristic: winner === 'tie' ? 'tie' : winner === heuristicColor ? 'win' : 'loss',
      territoryHeuristic: territory[heuristicColor],
      territoryOpponent: territory[opponentColor],
      territoryDiff: finalTerritoryDiff,
      averageOwnMobilityBefore: roundMetric(averagePreviousOwnMobility),
      averageOwnMobilityAfter: roundMetric(averageNextOwnMobility),
      averageOwnTrappedBefore: roundMetric(averageOwnTrappedBefore),
      averageOwnTrappedAfter: roundMetric(averageOwnTrappedAfter),
      totalTurns: turns,
      experiences: completedExperiences.length,
    },
    experiences: completedExperiences,
  }
}

function summarizeGames(
  games: GameResult[],
  experiences: Q5HeuristicExperienceRecord[],
): ExperienceSummary {
  const summary: ExperienceSummary = {
    totalGames: games.length,
    totalExperiences: experiences.length,
    gamesByOpponent: { random: 0, heuristic: 0 },
    gamesByColor: { R: 0, B: 0 },
    gamesByCombination: {
      random_R: 0,
      random_B: 0,
      heuristic_R: 0,
      heuristic_B: 0,
    },
    experiencesByOpponent: { random: 0, heuristic: 0 },
    experiencesByColor: { R: 0, B: 0 },
    results: createResultStats(),
    resultsByOpponent: { random: createResultStats(), heuristic: createResultStats() },
    resultsByColor: { R: createResultStats(), B: createResultStats() },
    averageTerritory: {
      heuristic: 0,
      opponent: 0,
    },
    averageTerritoryDiff: 0,
    averagePreviousOwnMobility: 0,
    averageNextOwnMobility: 0,
    averagePreviousOwnTrappedPieces: 0,
    averageNextOwnTrappedPieces: 0,
    averageTurns: 0,
    coverage: buildCoverageSummary(games, experiences),
    validations: buildValidationSummary(games, experiences, games.length),
  }

  let territoryHeuristic = 0
  let territoryOpponent = 0
  let territoryDiff = 0
  let turns = 0

  for (const game of games) {
    summary.gamesByOpponent[game.opponent]++
    summary.gamesByColor[game.heuristicColor]++
    summary.gamesByCombination[combinationKey(game.opponent, game.heuristicColor)]++
    addResult(summary.results, game.resultForHeuristic)
    addResult(summary.resultsByOpponent[game.opponent], game.resultForHeuristic)
    addResult(summary.resultsByColor[game.heuristicColor], game.resultForHeuristic)
    territoryHeuristic += game.territoryHeuristic
    territoryOpponent += game.territoryOpponent
    territoryDiff += game.territoryDiff
    turns += game.totalTurns
  }

  for (const experience of experiences) {
    summary.experiencesByOpponent[experience.opponent]++
    summary.experiencesByColor[experience.heuristicColor]++
    summary.averagePreviousOwnMobility += experience.previousOwnMobility
    summary.averageNextOwnMobility += experience.nextOwnMobility
    summary.averagePreviousOwnTrappedPieces += experience.previousOwnTrappedPieces
    summary.averageNextOwnTrappedPieces += experience.nextOwnTrappedPieces
  }

  summary.averageTerritory.heuristic = games.length
    ? roundMetric(territoryHeuristic / games.length)
    : 0
  summary.averageTerritory.opponent = games.length
    ? roundMetric(territoryOpponent / games.length)
    : 0
  summary.averageTerritoryDiff = games.length ? roundMetric(territoryDiff / games.length) : 0
  summary.averageTurns = games.length ? roundMetric(turns / games.length) : 0
  summary.averagePreviousOwnMobility = experiences.length
    ? roundMetric(summary.averagePreviousOwnMobility / experiences.length)
    : 0
  summary.averageNextOwnMobility = experiences.length
    ? roundMetric(summary.averageNextOwnMobility / experiences.length)
    : 0
  summary.averagePreviousOwnTrappedPieces = experiences.length
    ? roundMetric(summary.averagePreviousOwnTrappedPieces / experiences.length)
    : 0
  summary.averageNextOwnTrappedPieces = experiences.length
    ? roundMetric(summary.averageNextOwnTrappedPieces / experiences.length)
    : 0

  return summary
}

export async function generateHeuristicExperienceQ5(
  options: Partial<Q5HeuristicExperienceConfig> = {},
): Promise<{
  metadata: Q5HeuristicExperienceMetadata
  experiences: Q5HeuristicExperienceRecord[]
}> {
  const config = { ...DEFAULT_Q5_HEURISTIC_EXPERIENCE_CONFIG, ...options }
  assertOutputCanBeWritten(config.outputDir, config.overwrite)
  const startedAt = Date.now()
  const schedule = buildBalancedQ5HeuristicExperienceSchedule(config.totalGames, config.seedBase)
  const games: GameResult[] = []
  const experiences: Q5HeuristicExperienceRecord[] = []

  for (const scheduleItem of schedule) {
    const result = await runExperienceGame({ scheduleItem, maxTurns: config.maxTurns })
    games.push(result.game)
    experiences.push(...result.experiences)
  }

  const summary = summarizeGames(games, experiences)
  const outputFiles = {
    metadata: path.join(config.outputDir, 'metadata.json'),
    experienceSummary: path.join(config.outputDir, 'experience_summary.json'),
    experiencesJsonl: path.join(config.outputDir, 'experiences.jsonl'),
    gameResultsCsv: path.join(config.outputDir, 'game_results.csv'),
  }
  const metadata: Q5HeuristicExperienceMetadata = {
    model: 'Q5',
    artifact: 'heuristic_experience',
    seedBase: config.seedBase,
    totalGames: config.totalGames,
    maxTurns: config.maxTurns,
    stateRepresentation: 'Q3',
    qTableCreated: false,
    qLearningTrainingExecuted: false,
    heuristicPolicy: {
      placement: 'getBestPlacement',
      playing: 'getBestHeuristicAction',
      policy: 'default',
    },
    targetDistribution: buildTargetDistribution(config.totalGames),
    schedule,
    games,
    summary,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    outputFiles,
  }

  mkdirSync(config.outputDir, { recursive: true })
  writeJson(outputFiles.metadata, metadata)
  writeJson(outputFiles.experienceSummary, summary)
  writeJsonl(outputFiles.experiencesJsonl, experiences)
  writeGameResultsCsv(outputFiles.gameResultsCsv, games)

  return { metadata, experiences }
}

export function loadQ5HeuristicExperienceMetadata(
  metadataPath: string,
): Q5HeuristicExperienceMetadata {
  return JSON.parse(
    readFileSync(path.resolve(metadataPath), 'utf8'),
  ) as Q5HeuristicExperienceMetadata
}

export function validateQ5HeuristicExperiencePilotMetadata(
  metadata: Q5HeuristicExperienceMetadata,
): void {
  if (metadata.model !== 'Q5') throw new Error('metadata.model must be Q5')
  if (metadata.artifact !== 'heuristic_experience') {
    throw new Error('Expected heuristic experience artifact')
  }
  if (metadata.seedBase !== 3) throw new Error('Q5 heuristic experience pilot seed must be 3')
  if (metadata.totalGames !== 40)
    throw new Error('Q5 heuristic experience pilot must have 40 games')
  if (metadata.maxTurns !== Q5_HEURISTIC_EXPERIENCE_MAX_TURNS) {
    throw new Error('Q5 heuristic experience pilot must keep maxTurns=250')
  }
  if (metadata.stateRepresentation !== 'Q3') throw new Error('Experiences must use Q3 states')
  if (metadata.qTableCreated) throw new Error('Heuristic experience must not create a Q-table')
  if (metadata.qLearningTrainingExecuted) {
    throw new Error('Heuristic experience must not execute Q-learning training')
  }
  const expected = buildTargetDistribution(40)
  if (JSON.stringify(metadata.summary.gamesByOpponent) !== JSON.stringify(expected.opponents)) {
    throw new Error('Opponent distribution mismatch')
  }
  if (JSON.stringify(metadata.summary.gamesByColor) !== JSON.stringify(expected.colors)) {
    throw new Error('Color distribution mismatch')
  }
  if (
    JSON.stringify(metadata.summary.gamesByCombination) !== JSON.stringify(expected.combinations)
  ) {
    throw new Error('Combination distribution mismatch')
  }
  if (metadata.summary.totalExperiences <= 0) throw new Error('Expected heuristic experiences')
}

export function validateQ5HeuristicExperienceDatasetMetadata(
  metadata: Q5HeuristicExperienceMetadata,
): void {
  if (metadata.model !== 'Q5') throw new Error('metadata.model must be Q5')
  if (metadata.artifact !== 'heuristic_experience') throw new Error('Expected experience artifact')
  if (metadata.seedBase !== 3) throw new Error('Q5 dataset seed base must be 3')
  if (metadata.totalGames !== 2000) throw new Error('Q5 dataset must have 2000 games')
  if (metadata.maxTurns !== Q5_HEURISTIC_EXPERIENCE_MAX_TURNS) {
    throw new Error('Q5 dataset must keep maxTurns=250')
  }
  if (metadata.stateRepresentation !== 'Q3') throw new Error('Dataset must use Q3 states')
  if (metadata.qTableCreated) throw new Error('Dataset must not create a Q-table')
  if (metadata.qLearningTrainingExecuted) throw new Error('Dataset must not run Q-learning')
  const expected = buildTargetDistribution(2000)
  if (JSON.stringify(metadata.summary.gamesByOpponent) !== JSON.stringify(expected.opponents)) {
    throw new Error('Dataset opponent distribution mismatch')
  }
  if (JSON.stringify(metadata.summary.gamesByColor) !== JSON.stringify(expected.colors)) {
    throw new Error('Dataset color distribution mismatch')
  }
  if (
    JSON.stringify(metadata.summary.gamesByCombination) !== JSON.stringify(expected.combinations)
  ) {
    throw new Error('Dataset combination distribution mismatch')
  }
  if (!metadata.summary.validations.allActionsLegal) throw new Error('Dataset has illegal actions')
  if (!metadata.summary.validations.allStatesUseQ3) throw new Error('Dataset has non-Q3 states')
  if (!metadata.summary.validations.plannedConditionCountsPreserved) {
    throw new Error('Dataset did not preserve planned condition counts')
  }
  if (!metadata.summary.validations.sameHeuristicConfigurationBothSides) {
    throw new Error('Dataset heuristic configuration mismatch')
  }
  if (metadata.summary.coverage.totalExperiences <= 0) throw new Error('Expected experiences')
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'pilot-40'
  if (command === 'dataset-2000') {
    const result = await generateHeuristicExperienceQ5({
      totalGames: 2000,
      seedBase: 3,
      outputDir: Q5_HEURISTIC_EXPERIENCE_DATASET_2000_DIR,
      maxTurns: Q5_HEURISTIC_EXPERIENCE_MAX_TURNS,
      overwrite: true,
    })
    validateQ5HeuristicExperienceDatasetMetadata(result.metadata)
    console.log(`[generateHeuristicExperienceQ5] games: ${result.metadata.totalGames}`)
    console.log(`[generateHeuristicExperienceQ5] experiences: ${result.experiences.length}`)
    console.log(`[generateHeuristicExperienceQ5] output: ${result.metadata.outputFiles.metadata}`)
    return
  }
  if (command !== 'pilot-40') throw new Error(`Unknown command: ${command}`)
  const result = await generateHeuristicExperienceQ5()
  validateQ5HeuristicExperiencePilotMetadata(result.metadata)
  console.log(`[generateHeuristicExperienceQ5] games: ${result.metadata.totalGames}`)
  console.log(`[generateHeuristicExperienceQ5] experiences: ${result.experiences.length}`)
  console.log(`[generateHeuristicExperienceQ5] output: ${result.metadata.outputFiles.metadata}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
