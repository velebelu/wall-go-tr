import {
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
  chooseHumanChallengeMCTSDecision,
  type HumanChallengeConfig,
} from '@/agents/humanChallengeMCTS'
import { applyFullAction } from '@/engine/gameSimulator'
import { PLAYER_LIST, type Player, type PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { checkGameEnd } from '@/utils/game'
import { getTerritoryMap } from '@/utils/territory'
import { canonicalStringify } from './humanExperimentCanonical'

export const SELF_PLAY_EXPERIMENT_ID = 'WGTR-MCTS-SELFPLAY-COLOR-BIAS-2026-V1'
export const SELF_PLAY_SCHEMA_VERSION = 'MCTSSelfPlayColorBiasV1'
export const SELF_PLAY_OUTPUT_DIRECTORY = 'data/mcts-selfplay/final-2026-color-bias-v1'

export const SELF_PLAY_PAIR_COUNT = 100
export const SELF_PLAY_GAME_COUNT = SELF_PLAY_PAIR_COUNT * 2

/**
 * Seed layout. Every decision of a side consumes `streamBase + decisionIndex`, so a stream
 * needs one contiguous block per game. The stride keeps the blocks disjoint with a wide
 * margin over SELF_PLAY_MAX_DECISIONS, which makes seed collisions structurally impossible.
 */
export const SELF_PLAY_SEED_BASE = 2_026_080_300
export const SELF_PLAY_PAIR_SEED_STRIDE = 2_000
export const SELF_PLAY_STREAM_SEED_OFFSET = 1_000
export const SELF_PLAY_MAX_DECISIONS = 400

export const SELF_PLAY_SEED_RULE =
  'alphaSeedBase = SELF_PLAY_SEED_BASE + (pairNumber - 1) * SELF_PLAY_PAIR_SEED_STRIDE; ' +
  'betaSeedBase = alphaSeedBase + SELF_PLAY_STREAM_SEED_OFFSET; ' +
  'decision seed = sideSeedBase + decisionIndexOfThatSide'

/**
 * The 5 s per-decision guard of the deployed agent is a user-interface latency limit measured
 * against the wall clock. Offline it would make the outcome depend on machine load, so the run
 * injects a frozen virtual clock through the official `now` parameter of
 * `chooseHumanChallengeMCTSDecision`. No search parameter is altered: every decision simply
 * completes its full 250/500 simulation budget, identically for both colours.
 */
export const SELF_PLAY_VIRTUAL_CLOCK: () => number = () => 0

export type SelfPlayOrientation = 'direct' | 'swapped'
export type SelfPlaySeedStream = 'alpha' | 'beta'
export type SelfPlayWinner = Player | 'tie'
export type SelfPlayTerminationReason =
  | 'all-territory-closed'
  | 'all-players-blocked'
  | 'no-legal-actions'
  | 'safety-limit'

export interface SelfPlayPlanRow {
  gameId: string
  gameNumber: number
  pairNumber: number
  orientation: SelfPlayOrientation
  alphaSeedBase: number
  betaSeedBase: number
  redSeedBase: number
  blueSeedBase: number
  redSeedStream: SelfPlaySeedStream
  blueSeedStream: SelfPlaySeedStream
}

export interface SelfPlayActionCounts {
  placements: number
  moves: number
  walls: number
}

export interface SelfPlayDecisionDiagnostics {
  expandedTo500: number
  stoppedByTimeLimit: number
  tacticalChanged: number
  totalSimulations: number
}

export interface SelfPlayGameResult extends SelfPlayPlanRow {
  schema: typeof SELF_PLAY_SCHEMA_VERSION
  experimentId: typeof SELF_PLAY_EXPERIMENT_ID
  implementationCommit: string
  configSha256: string
  redConfig: HumanChallengeConfig
  blueConfig: HumanChallengeConfig
  configsIdentical: boolean
  firstActionColor: Player
  winner: SelfPlayWinner
  tie: boolean
  territoryRed: number
  territoryBlue: number
  territoryDiff: number
  redScore: number
  totalDecisions: number
  redDecisions: number
  blueDecisions: number
  redSeedCount: number
  blueSeedCount: number
  redActions: SelfPlayActionCounts
  blueActions: SelfPlayActionCounts
  terminationReason: SelfPlayTerminationReason
  terminal: boolean
  durationMs: number
  diagnostics: SelfPlayDecisionDiagnostics
  actions: PlayerAction[]
  actionSequenceSha256: string
  outcomeSha256: string
  reproducible: boolean
  virtualClock: true
  latencyGuardDisabled: true
  startedAt: string
  finishedAt: string
}

export interface RunSelfPlayGameOptions {
  implementationCommit: string
  config?: Readonly<HumanChallengeConfig>
  maxDecisions?: number
  now?: () => number
  sha256: (value: string) => string
  timestamp?: () => string
}

function padPair(pairNumber: number): string {
  return String(pairNumber).padStart(3, '0')
}

export function buildSelfPlayPlan(pairCount = SELF_PLAY_PAIR_COUNT): SelfPlayPlanRow[] {
  return Array.from({ length: pairCount }, (_, index) => {
    const pairNumber = index + 1
    const alphaSeedBase = SELF_PLAY_SEED_BASE + index * SELF_PLAY_PAIR_SEED_STRIDE
    const betaSeedBase = alphaSeedBase + SELF_PLAY_STREAM_SEED_OFFSET
    const shared = { pairNumber, alphaSeedBase, betaSeedBase }
    return [
      {
        ...shared,
        gameId: `pair-${padPair(pairNumber)}-direct`,
        gameNumber: index * 2 + 1,
        orientation: 'direct' as const,
        redSeedBase: alphaSeedBase,
        blueSeedBase: betaSeedBase,
        redSeedStream: 'alpha' as const,
        blueSeedStream: 'beta' as const,
      },
      {
        ...shared,
        gameId: `pair-${padPair(pairNumber)}-swapped`,
        gameNumber: index * 2 + 2,
        orientation: 'swapped' as const,
        redSeedBase: betaSeedBase,
        blueSeedBase: alphaSeedBase,
        redSeedStream: 'beta' as const,
        blueSeedStream: 'alpha' as const,
      },
    ]
  }).flat()
}

export function validateSelfPlayPlan(
  plan: readonly SelfPlayPlanRow[],
  pairCount = SELF_PLAY_PAIR_COUNT,
): void {
  if (plan.length !== pairCount * 2) throw new Error(`The plan must contain ${pairCount * 2} games`)
  if (new Set(plan.map((row) => row.gameId)).size !== plan.length)
    throw new Error('The plan contains duplicate game identifiers')
  if (new Set(plan.map((row) => row.gameNumber)).size !== plan.length)
    throw new Error('The plan contains duplicate game numbers')
  const expected = buildSelfPlayPlan(pairCount)
  if (canonicalStringify(plan) !== canonicalStringify(expected))
    throw new Error('The plan does not match the deterministic seed layout')
  for (let pairNumber = 1; pairNumber <= pairCount; pairNumber++) {
    const pair = plan.filter((row) => row.pairNumber === pairNumber)
    if (pair.length !== 2) throw new Error(`Pair ${pairNumber} does not contain exactly two games`)
    const direct = pair.find((row) => row.orientation === 'direct')
    const swapped = pair.find((row) => row.orientation === 'swapped')
    if (!direct || !swapped) throw new Error(`Pair ${pairNumber} is missing an orientation`)
    if (direct.redSeedBase !== swapped.blueSeedBase || direct.blueSeedBase !== swapped.redSeedBase)
      throw new Error(`Pair ${pairNumber} does not swap the seed streams between colours`)
  }
  const blocks = plan.flatMap((row) => [row.redSeedBase, row.blueSeedBase])
  const sorted = [...new Set(blocks)].sort((left, right) => left - right)
  if (sorted.length !== pairCount * 2)
    throw new Error('Every pair must define exactly two distinct seed streams')
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index]! - sorted[index - 1]! < SELF_PLAY_MAX_DECISIONS)
      throw new Error('Seed blocks are too close and could overlap between sides')
  }
}

export function emptyActionCounts(): SelfPlayActionCounts {
  return { placements: 0, moves: 0, walls: 0 }
}

export function countActionAtoms(action: PlayerAction, into: SelfPlayActionCounts): void {
  for (const atom of [action, action.followUp]) {
    if (!atom) continue
    if (atom.type === 'place') into.placements++
    else if (atom.type === 'move') into.moves++
    else into.walls++
  }
}

export function territoryCountsFromBoard(
  board: Parameters<typeof getTerritoryMap>[0],
): Record<Player, number> {
  const totals: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(board)) for (const owner of row) if (owner) totals[owner]++
  return totals
}

export function scoreForRed(winner: SelfPlayWinner): number {
  return winner === 'R' ? 1 : winner === 'tie' ? 0.5 : 0
}

export function runSelfPlayGame(
  planned: SelfPlayPlanRow,
  options: RunSelfPlayGameOptions,
): SelfPlayGameResult {
  const config = options.config ?? FINAL_HUMAN_CHALLENGE_MCTS_CONFIG
  const maxDecisions = options.maxDecisions ?? SELF_PLAY_MAX_DECISIONS
  const timestamp = options.timestamp ?? (() => new Date().toISOString())
  const startedAt = timestamp()
  const startedMs = performance.now()
  const seedBases: Record<Player, number> = {
    R: planned.redSeedBase,
    B: planned.blueSeedBase,
  }
  const decisionCounters: Record<Player, number> = { R: 0, B: 0 }
  const actionCounts: Record<Player, SelfPlayActionCounts> = {
    R: emptyActionCounts(),
    B: emptyActionCounts(),
  }
  const diagnostics: SelfPlayDecisionDiagnostics = {
    expandedTo500: 0,
    stoppedByTimeLimit: 0,
    tacticalChanged: 0,
    totalSimulations: 0,
  }
  const actions: PlayerAction[] = []
  let state = makeInitialState()
  const firstActionColor = state.turn
  let totalDecisions = 0

  while (state.phase !== 'finished' && !state.result && totalDecisions < maxDecisions) {
    const legal = getLegalActions(state)
    if (!legal.length) break
    const mover = state.turn
    const decision = chooseHumanChallengeMCTSDecision({
      gameState: state,
      seed: seedBases[mover] + decisionCounters[mover]++,
      config,
      endgameEnabled: false,
      now: options.now ?? SELF_PLAY_VIRTUAL_CLOCK,
    })
    const action = decision.action
    if (!legal.some((candidate) => canonicalStringify(candidate) === canonicalStringify(action)))
      throw new Error(`Illegal action produced in ${planned.gameId}`)
    diagnostics.expandedTo500 += decision.expandedTo500 ? 1 : 0
    diagnostics.stoppedByTimeLimit += decision.stoppedByTimeLimit ? 1 : 0
    diagnostics.tacticalChanged += decision.tacticalChanged ? 1 : 0
    diagnostics.totalSimulations += decision.simulations
    countActionAtoms(action, actionCounts[mover])
    actions.push(action)
    state = applyFullAction(state, action).state
    totalDecisions++
  }

  const terminal = state.phase === 'finished' || state.result !== undefined
  const territory = state.result?.score ?? territoryCountsFromBoard(state.board)
  const winner: SelfPlayWinner = state.result?.tie
    ? 'tie'
    : (state.result?.winner ??
      (territory.R === territory.B ? 'tie' : territory.R > territory.B ? 'R' : 'B'))
  const terminationReason: SelfPlayTerminationReason = !terminal
    ? totalDecisions >= maxDecisions
      ? 'safety-limit'
      : 'no-legal-actions'
    : checkGameEnd(state.board, PLAYER_LIST.slice()).finished
      ? 'all-territory-closed'
      : 'all-players-blocked'

  const configSha256 = options.sha256(canonicalStringify(config))
  const outcome = {
    gameId: planned.gameId,
    winner,
    territoryRed: territory.R,
    territoryBlue: territory.B,
    totalDecisions,
    terminationReason,
  }

  return {
    ...planned,
    schema: SELF_PLAY_SCHEMA_VERSION,
    experimentId: SELF_PLAY_EXPERIMENT_ID,
    implementationCommit: options.implementationCommit,
    configSha256,
    redConfig: config as HumanChallengeConfig,
    blueConfig: config as HumanChallengeConfig,
    configsIdentical: true,
    firstActionColor,
    winner,
    tie: winner === 'tie',
    territoryRed: territory.R,
    territoryBlue: territory.B,
    territoryDiff: territory.R - territory.B,
    redScore: scoreForRed(winner),
    totalDecisions,
    redDecisions: decisionCounters.R,
    blueDecisions: decisionCounters.B,
    redSeedCount: decisionCounters.R,
    blueSeedCount: decisionCounters.B,
    redActions: actionCounts.R,
    blueActions: actionCounts.B,
    terminationReason,
    terminal,
    durationMs: Number((performance.now() - startedMs).toFixed(3)),
    diagnostics,
    actions,
    actionSequenceSha256: options.sha256(canonicalStringify(actions)),
    outcomeSha256: options.sha256(canonicalStringify(outcome)),
    reproducible: true,
    virtualClock: true,
    latencyGuardDisabled: true,
    startedAt,
    finishedAt: timestamp(),
  }
}
