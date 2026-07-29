import { calculatePlayerMobilityQ3 } from '@/agents/learningPolicyQ3'
import type { TurnDecisionTrace } from '@/agents/TurnManager'
import { applyFullAction } from '@/engine/gameSimulator'
import type { MCTSConfig, MCTSResult } from '@/engine/mcts/types'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { snapshotFromState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { floodRegions } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'
import type { HumanChallengeConfig } from '@/agents/humanChallengeMCTS'

export const HUMAN_MCTS_TRACE_SCHEMA = 'HumanMCTSTraceV1' as const
export type HumanMCTSSessionType = 'practice' | 'official' | 'diagnostic'

export interface SerializableGameSnapshot extends Omit<GameSnapshot, 'legal'> {
  legal: string[]
}

export interface TracePositionMetrics {
  territory: Record<Player, number>
  accessibleTerritory: Record<Player, number>
  mobility: Record<
    Player,
    {
      trapPieces: number
      totalDestinations: number
      lowPieces: number
    }
  >
  connectedComponents: Array<{
    size: number
    redStones: number
    blueStones: number
    owner: Player | null
  }>
}

export interface HumanMCTSDecisionDiagnosticsV1 {
  baseSeed: number
  decisionIndex: number
  decisionSeed: number
  originalAction?: PlayerAction
  finalAction: PlayerAction
  simulations: number
  rootVisits: number
  selectedVisits: number
  selectedValue: number
  rootCandidates: MCTSResult['children']
  tacticalCandidatesChecked?: number
  originalScore?: number
  verifiedScore?: number
  worstOpponentReplyScore?: number
  tacticalSelectionChanged?: boolean
  immediateTerminalLossAvoided?: boolean
  searchTimeMs?: number
  verificationTimeMs?: number
  qMetrics: Pick<
    MCTSResult,
    | 'qPriorKnownActions'
    | 'qPriorReliableActions'
    | 'qPriorSelectedActionKnown'
    | 'qPriorSelectedActionReliable'
    | 'averageSelectedQPrior'
  >
  effectiveConfig: MCTSConfig
}

export interface HumanMCTSTraceDecisionV1 {
  turnIndex: number
  actorDecisionIndex: number
  player: Player
  actor: 'human' | 'mcts'
  phase: GameSnapshot['phase']
  stateBefore: SerializableGameSnapshot
  legalActions: PlayerAction[]
  action: PlayerAction
  stateAfter: SerializableGameSnapshot
  metricsBefore: TracePositionMetrics
  metricsAfter: TracePositionMetrics
  endedGame: boolean
  decisionMs: number
  mcts?: HumanMCTSDecisionDiagnosticsV1
  review?: { marked: true; markedAt: string; note?: string }
}

export interface HumanMCTSTraceV1 {
  schema: typeof HUMAN_MCTS_TRACE_SCHEMA
  schemaVersion: 1
  metadata: {
    gameId: string
    createdAt: string
    startedAt?: string
    finishedAt?: string
    durationMs?: number
    experimentId?: string
    participantId?: string
    gameNumber?: 1 | 2
    sessionType?: HumanMCTSSessionType
    sessionId?: string
    projectVersion?: string
    projectCommit?: string
    runtimeCommit?: string
    boardSize: number
    humanColor: Player
    mctsColor: Player
    seed: number
    mctsConfig: MCTSConfig
    finalHumanChallengeConfig?: HumanChallengeConfig
    initialState: SerializableGameSnapshot
  }
  decisions: HumanMCTSTraceDecisionV1[]
  final?: {
    state: SerializableGameSnapshot
    result: NonNullable<GameSnapshot['result']>
    territory: Record<Player, number>
    totalTurns: number
    finishReason: 'game-result' | 'trace-finalized'
  }
}

export interface HumanMCTSDecisionFixtureV1 {
  schema: 'HumanMCTSDecisionFixtureV1'
  source: { gameId: string; turnIndex: number; schema: typeof HUMAN_MCTS_TRACE_SCHEMA }
  player: Player
  actor: 'human' | 'mcts'
  stateBefore: SerializableGameSnapshot
  legalActions: PlayerAction[]
  action: PlayerAction
  stateAfter: SerializableGameSnapshot
  mcts?: HumanMCTSDecisionDiagnosticsV1
}

export interface ReplayResult {
  ok: boolean
  decisionsReplayed: number
  divergence?: {
    turnIndex: number
    kind: 'state-before' | 'illegal-action' | 'state-after' | 'final-state' | 'final-result'
    message: string
    expected?: unknown
    actual?: unknown
  }
}

export interface PreparedHumanMCTSTraceFile {
  fileName: string
  bytes: number
  json: string
}

export function serializeGameSnapshot(state: GameSnapshot): SerializableGameSnapshot {
  const copy = snapshotFromState(state)
  return {
    ...copy,
    legal: [...copy.legal].sort(),
  }
}

export function deserializeGameSnapshot(state: SerializableGameSnapshot): GameSnapshot {
  return snapshotFromState({
    ...structuredClone(state),
    legal: new Set(state.legal),
  })
}

export function serializeHumanMCTSTrace(trace: HumanMCTSTraceV1): string {
  return `${JSON.stringify(trace, null, 2)}\n`
}

export function parseHumanMCTSTrace(json: string): HumanMCTSTraceV1 {
  const parsed = JSON.parse(json) as HumanMCTSTraceV1
  if (parsed.schema !== HUMAN_MCTS_TRACE_SCHEMA || parsed.schemaVersion !== 1) {
    throw new Error('Unsupported human-MCTS trace schema')
  }
  if (!parsed.metadata || !Array.isArray(parsed.decisions)) {
    throw new Error('Invalid human-MCTS trace structure')
  }
  return structuredClone(parsed)
}

export function createHumanMCTSTrace(params: {
  gameId?: string
  createdAt?: string
  experimentId?: string
  participantId?: string
  gameNumber?: 1 | 2
  sessionType?: HumanMCTSSessionType
  sessionId?: string
  projectVersion?: string
  projectCommit?: string
  humanColor: Player
  mctsColor: Player
  seed: number
  mctsConfig: MCTSConfig
  finalHumanChallengeConfig?: Readonly<HumanChallengeConfig>
  initialState: GameSnapshot
}): HumanMCTSTraceV1 {
  return {
    schema: HUMAN_MCTS_TRACE_SCHEMA,
    schemaVersion: 1,
    metadata: {
      gameId: params.gameId ?? 'pending',
      createdAt: params.createdAt ?? new Date().toISOString(),
      experimentId: params.experimentId,
      participantId: params.participantId,
      gameNumber: params.gameNumber,
      sessionType: params.sessionType,
      sessionId: params.sessionId ?? globalThis.crypto.randomUUID(),
      projectVersion: params.projectVersion,
      projectCommit: params.projectCommit,
      runtimeCommit: params.projectCommit,
      boardSize: params.initialState.board.length,
      humanColor: params.humanColor,
      mctsColor: params.mctsColor,
      seed: params.seed,
      mctsConfig: structuredClone(params.mctsConfig),
      ...(params.finalHumanChallengeConfig
        ? { finalHumanChallengeConfig: structuredClone(params.finalHumanChallengeConfig) }
        : {}),
      initialState: serializeGameSnapshot(params.initialState),
    },
    decisions: [],
  }
}

export function markHumanMCTSTurnForReview(
  target: HumanMCTSTraceV1,
  turnIndex: number,
  note?: string,
  markedAt = new Date().toISOString(),
): void {
  const decision = target.decisions.find((row) => row.turnIndex === turnIndex)
  if (!decision) throw new Error(`Trace has no turn ${turnIndex}`)
  decision.review = { marked: true, markedAt, ...(note ? { note } : {}) }
}

export function appendHumanMCTSDecision(
  target: HumanMCTSTraceV1,
  decision: TurnDecisionTrace,
  mctsColor: Player,
): void {
  if (target.final) throw new Error('Cannot append a decision to a finalized trace')
  const actor = decision.player === mctsColor ? 'mcts' : 'human'
  const actorDecisionIndex = target.decisions.filter((row) => row.actor === actor).length
  const diagnostics = decision.agentDiagnostics
  target.decisions.push({
    turnIndex: decision.turnNumber,
    actorDecisionIndex,
    player: decision.player,
    actor,
    phase: decision.stateBefore.phase,
    stateBefore: serializeGameSnapshot(decision.stateBefore),
    legalActions: structuredClone(getLegalActions(decision.stateBefore)),
    action: structuredClone(decision.action),
    stateAfter: serializeGameSnapshot(decision.stateAfter),
    metricsBefore: positionMetrics(decision.stateBefore),
    metricsAfter: positionMetrics(decision.stateAfter),
    endedGame:
      decision.stateAfter.phase === 'finished' || decision.stateAfter.result?.finished === true,
    decisionMs: Number(decision.decisionMs.toFixed(4)),
    ...(actor === 'mcts' && diagnostics
      ? { mcts: toMCTSDiagnostics(diagnostics, decision.action, target.metadata.mctsConfig) }
      : {}),
  })
}

export function recordHumanMCTSDecision(
  target: HumanMCTSTraceV1 | null,
  decision: TurnDecisionTrace,
  mctsColor: Player,
): void {
  if (target) {
    appendHumanMCTSDecision(target, decision, mctsColor)
    if (decision.stateAfter.result?.finished && target.metadata.startedAt)
      markHumanMCTSTraceFinished(target)
  }
}

export function markHumanMCTSTraceStarted(
  target: HumanMCTSTraceV1,
  startedAt = new Date().toISOString(),
): void {
  if (!target.metadata.startedAt) target.metadata.startedAt = startedAt
}

export function markHumanMCTSTraceFinished(
  target: HumanMCTSTraceV1,
  finishedAt = new Date().toISOString(),
): void {
  if (!target.metadata.startedAt) throw new Error('Cannot finish a trace before it starts')
  if (target.metadata.finishedAt) return
  const durationMs = Date.parse(finishedAt) - Date.parse(target.metadata.startedAt)
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('Invalid trace timestamps')
  target.metadata.finishedAt = finishedAt
  target.metadata.durationMs = durationMs
}

export function finalizeHumanMCTSTrace(
  target: HumanMCTSTraceV1,
  gameId: string,
  state: GameSnapshot,
): void {
  if (!state.result) throw new Error('Cannot finalize a trace without a game result')
  if (target.final) throw new Error('Human-MCTS trace is already finalized')
  target.metadata.gameId = gameId
  target.final = {
    state: serializeGameSnapshot(state),
    result: structuredClone(state.result),
    territory: territoryCounts(state),
    totalTurns: target.decisions.length,
    finishReason: state.result.finished ? 'game-result' : 'trace-finalized',
  }
}

export function replayHumanMCTSTrace(trace: HumanMCTSTraceV1): ReplayResult {
  let state = deserializeGameSnapshot(trace.metadata.initialState)
  for (const decision of trace.decisions) {
    const before = serializeGameSnapshot(state)
    if (!deepEqual(before, decision.stateBefore)) {
      return divergence(decision.turnIndex, 'state-before', decision.stateBefore, before)
    }
    const replayAction = recordedActionForReplay(decision.action)
    const legalActions = getLegalActions(state)
    if (!legalActions.some((action) => samePlayableAction(action, replayAction))) {
      return {
        ok: false,
        decisionsReplayed: decision.turnIndex,
        divergence: {
          turnIndex: decision.turnIndex,
          kind: 'illegal-action',
          message: `Recorded action is not legal at turn ${decision.turnIndex}`,
          expected: decision.action,
          actual: legalActions,
        },
      }
    }
    state = applyFullAction(state, replayAction).state
    const after = serializeGameSnapshot(state)
    if (!deepEqual(after, decision.stateAfter)) {
      return divergence(decision.turnIndex, 'state-after', decision.stateAfter, after)
    }
  }
  if (trace.final) {
    const finalState = serializeGameSnapshot(state)
    if (!deepEqual(finalState, trace.final.state)) {
      return divergence(trace.decisions.length, 'final-state', trace.final.state, finalState)
    }
    if (!deepEqual(state.result, trace.final.result)) {
      return divergence(trace.decisions.length, 'final-result', trace.final.result, state.result)
    }
  }
  return { ok: true, decisionsReplayed: trace.decisions.length }
}

export function extractHumanMCTSDecisionFixture(
  trace: HumanMCTSTraceV1,
  turnIndex: number,
): HumanMCTSDecisionFixtureV1 {
  const decision = trace.decisions.find((row) => row.turnIndex === turnIndex)
  if (!decision) throw new Error(`Trace has no turn ${turnIndex}`)
  return structuredClone({
    schema: 'HumanMCTSDecisionFixtureV1',
    source: { gameId: trace.metadata.gameId, turnIndex, schema: trace.schema },
    player: decision.player,
    actor: decision.actor,
    stateBefore: decision.stateBefore,
    legalActions: decision.legalActions,
    action: decision.action,
    stateAfter: decision.stateAfter,
    mcts: decision.mcts,
  })
}

export function prepareHumanMCTSTraceFile(trace: HumanMCTSTraceV1): PreparedHumanMCTSTraceFile {
  if (!trace.final) throw new Error('Cannot prepare a download for an unfinished trace')
  const json = serializeHumanMCTSTrace(trace)
  return {
    fileName: `traza_humano_mcts_${trace.metadata.gameId}.json`,
    bytes: new TextEncoder().encode(json).length,
    json,
  }
}

export function downloadPreparedHumanMCTSTrace(prepared: PreparedHumanMCTSTraceFile): {
  fileName: string
  bytes: number
} {
  const blob = new Blob([prepared.json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = prepared.fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
  return { fileName: prepared.fileName, bytes: prepared.bytes }
}

function toMCTSDiagnostics(
  diagnostics: NonNullable<TurnDecisionTrace['agentDiagnostics']>,
  finalAction: PlayerAction,
  fallbackConfig: MCTSConfig,
): HumanMCTSDecisionDiagnosticsV1 {
  const detail = diagnostics.mcts
  const result = detail?.result
  return {
    baseSeed: diagnostics.baseSeed,
    decisionIndex: diagnostics.decisionIndex,
    decisionSeed: diagnostics.decisionSeed,
    originalAction: structuredClone(result?.originalAction),
    finalAction: structuredClone(finalAction),
    simulations: detail?.effectiveConfig.simulations ?? fallbackConfig.simulations,
    rootVisits: result?.rootVisits ?? 0,
    selectedVisits: result?.visits ?? 0,
    selectedValue: result?.value ?? 0,
    rootCandidates: structuredClone(result?.children ?? []),
    tacticalCandidatesChecked: result?.tacticalCandidatesChecked,
    originalScore: result?.originalMCTSActionScore,
    verifiedScore: result?.verifiedActionScore,
    worstOpponentReplyScore: result?.worstOpponentReplyScore,
    tacticalSelectionChanged: result?.tacticalSelectionChanged,
    immediateTerminalLossAvoided: result?.immediateTerminalLossAvoided,
    searchTimeMs: detail?.searchTimeMs,
    verificationTimeMs: result?.verificationTimeMs,
    qMetrics: {
      qPriorKnownActions: result?.qPriorKnownActions,
      qPriorReliableActions: result?.qPriorReliableActions,
      qPriorSelectedActionKnown: result?.qPriorSelectedActionKnown,
      qPriorSelectedActionReliable: result?.qPriorSelectedActionReliable,
      averageSelectedQPrior: result?.averageSelectedQPrior,
    },
    effectiveConfig: structuredClone(detail?.effectiveConfig ?? fallbackConfig),
  }
}

function positionMetrics(state: GameSnapshot): TracePositionMetrics {
  return {
    territory: territoryCounts(state),
    accessibleTerritory: {
      R: accessibleCount(state, 'R'),
      B: accessibleCount(state, 'B'),
    },
    mobility: {
      R: calculatePlayerMobilityQ3(state, 'R'),
      B: calculatePlayerMobilityQ3(state, 'B'),
    },
    connectedComponents: floodRegions(state.board).map((region) => ({
      size: region.cells.length,
      redStones: region.borderingCounts.R,
      blueStones: region.borderingCounts.B,
      owner:
        region.borderingCounts.R > 0 && region.borderingCounts.B === 0
          ? 'R'
          : region.borderingCounts.B > 0 && region.borderingCounts.R === 0
            ? 'B'
            : null,
    })),
  }
}

function territoryCounts(state: GameSnapshot): Record<Player, number> {
  const result: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board)) {
    for (const owner of row) if (owner) result[owner]++
  }
  return result
}

function accessibleCount(state: GameSnapshot, player: Player): number {
  return floodRegions(state.board).reduce(
    (sum, region) => sum + (region.borderingCounts[player] ? region.cells.length : 0),
    0,
  )
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function samePlayableAction(left: PlayerAction, right: PlayerAction): boolean {
  return deepEqual(normalizePlayableAction(left), normalizePlayableAction(right))
}

function normalizePlayableAction(action: PlayerAction): PlayerAction {
  const normalized = structuredClone(action)
  if (normalized.type === 'wall') delete normalized.from
  if (normalized.followUp) normalized.followUp = normalizePlayableAction(normalized.followUp)
  return normalized
}

// Human input can submit a wall after the UI has already moved the selected
// stone. A same-cell move therefore represents the legal standalone wall
// encoded in its follow-up; replay it canonically without altering the trace.
function recordedActionForReplay(action: PlayerAction): PlayerAction {
  if (
    action.type === 'move' &&
    action.from &&
    action.from.x === action.pos.x &&
    action.from.y === action.pos.y &&
    action.followUp?.type === 'wall' &&
    action.followUp.dir
  ) {
    return {
      type: 'wall',
      from: structuredClone(action.from),
      pos: structuredClone(action.followUp.pos),
      dir: action.followUp.dir,
    }
  }
  return action
}

function divergence(
  turnIndex: number,
  kind: NonNullable<ReplayResult['divergence']>['kind'],
  expected: unknown,
  actual: unknown,
): ReplayResult {
  return {
    ok: false,
    decisionsReplayed: turnIndex,
    divergence: {
      turnIndex,
      kind,
      message: `First divergence at turn ${turnIndex}: ${kind}`,
      expected,
      actual,
    },
  }
}
