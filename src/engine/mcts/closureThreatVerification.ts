import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction, Pos } from '@/lib/types'
import { getLegalActions } from '@/utils/ai'
import { floodRegions, type Region } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'
import type { MCTSChildResult } from './types'

export interface ClosureThreatVerificationConfig {
  enabled: boolean
  candidateCount: number
  maxRepliesPerCandidate: number
  maxTimeMsPerCandidate: number
  minimumOpponentTerritoryGain: number
  minimumOwnAccessibleDrop: number
  minimumExposedComponentSize: number
  terminalTerritoryDiffThreshold: number
}

export const EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG: Readonly<ClosureThreatVerificationConfig> =
  Object.freeze({
    enabled: true,
    candidateCount: 4,
    maxRepliesPerCandidate: 80,
    maxTimeMsPerCandidate: 250,
    minimumOpponentTerritoryGain: 12,
    minimumOwnAccessibleDrop: 12,
    minimumExposedComponentSize: 15,
    terminalTerritoryDiffThreshold: -12,
  })

export interface ClosureReplyDiagnostic {
  action: PlayerAction
  ownTerritoryBefore: number
  ownTerritoryAfter: number
  opponentTerritoryBefore: number
  opponentTerritoryAfter: number
  ownAccessibleBefore: number
  ownAccessibleAfter: number
  opponentAccessibleBefore: number
  opponentAccessibleAfter: number
  opponentTerritoryGain: number
  ownAccessibleDrop: number
  largestComponentBefore: number
  largestComponentAfter: number
  lostLastOwnStoneInLargeComponent: boolean
  exposedComponentSize: number
  terminalTerritoryDiff?: number
  severe: boolean
  reasons: string[]
}

export interface ClosureCandidateDiagnostic {
  action: PlayerAction
  visits: number
  value: number
  severe: boolean
  repliesAvailable: number
  repliesChecked: number
  stoppedByTimeLimit: boolean
  elapsedMs: number
  maximumOpponentTerritoryGain: number
  maximumOwnAccessibleDrop: number
  lostLastOwnStoneInLargeComponent: boolean
  worstReply?: ClosureReplyDiagnostic
}

export interface ClosureThreatVerificationResult {
  action: PlayerAction
  changed: boolean
  reason:
    | 'disabled'
    | 'original-safe'
    | 'safer-candidate-preferred'
    | 'all-candidates-collapse-fallback'
  originalAction: PlayerAction
  candidates: ClosureCandidateDiagnostic[]
  threatsDetected: number
  totalElapsedMs: number
}

function opponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function territoryCounts(state: GameSnapshot): Record<Player, number> {
  const counts: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board)) {
    for (const owner of row) if (owner) counts[owner]++
  }
  return counts
}

function accessibleCount(state: GameSnapshot, player: Player): number {
  return floodRegions(state.board).reduce(
    (sum, region) => sum + (region.borderingCounts[player] > 0 ? region.cells.length : 0),
    0,
  )
}

function largestComponent(regions: readonly Region[]): number {
  return Math.max(0, ...regions.map((region) => region.cells.length))
}

function positionKey(position: Pos): string {
  return `${position.x},${position.y}`
}

function lastOwnStoneLoss(
  before: readonly Region[],
  after: readonly Region[],
  perspective: Player,
  minimumSize: number,
): { detected: boolean; exposedComponentSize: number } {
  const rival = opponent(perspective)
  let exposedComponentSize = 0
  for (const region of before) {
    if (
      region.cells.length < minimumSize ||
      region.borderingCounts[perspective] === 0 ||
      region.borderingCounts[rival] === 0
    )
      continue
    const beforeCells = new Set(region.cells.map(positionKey))
    for (const resulting of after) {
      if (
        resulting.borderingCounts[perspective] !== 0 ||
        resulting.borderingCounts[rival] === 0 ||
        !resulting.cells.some((cell) => beforeCells.has(positionKey(cell)))
      )
        continue
      exposedComponentSize = Math.max(exposedComponentSize, resulting.cells.length)
    }
  }
  return {
    detected: exposedComponentSize >= minimumSize,
    exposedComponentSize,
  }
}

function replyPriority(action: PlayerAction): number {
  if (action.followUp?.type === 'wall') return 0
  if (action.type === 'wall') return 1
  return 2
}

export function analyzeClosureReply(
  stateAfterCandidate: GameSnapshot,
  perspective: Player,
  reply: PlayerAction,
  config: ClosureThreatVerificationConfig,
): ClosureReplyDiagnostic {
  const rival = opponent(perspective)
  const territoryBefore = territoryCounts(stateAfterCandidate)
  const ownAccessibleBefore = accessibleCount(stateAfterCandidate, perspective)
  const opponentAccessibleBefore = accessibleCount(stateAfterCandidate, rival)
  const regionsBefore = floodRegions(stateAfterCandidate.board)
  const after = applyFullAction(stateAfterCandidate, reply).state
  const territoryAfter = after.result?.score ?? territoryCounts(after)
  const ownAccessibleAfter = accessibleCount(after, perspective)
  const opponentAccessibleAfter = accessibleCount(after, rival)
  const regionsAfter = floodRegions(after.board)
  const lastStone = lastOwnStoneLoss(
    regionsBefore,
    regionsAfter,
    perspective,
    config.minimumExposedComponentSize,
  )
  const opponentTerritoryGain = territoryAfter[rival] - territoryBefore[rival]
  const ownAccessibleDrop = ownAccessibleBefore - ownAccessibleAfter
  const terminalTerritoryDiff = after.result
    ? territoryAfter[perspective] - territoryAfter[rival]
    : undefined
  const reasons: string[] = []
  if (opponentTerritoryGain >= config.minimumOpponentTerritoryGain)
    reasons.push('opponent-territory-gain')
  if (ownAccessibleDrop >= config.minimumOwnAccessibleDrop) reasons.push('own-accessibility-drop')
  if (lastStone.detected) reasons.push('last-own-stone-lost-in-large-component')
  if (
    terminalTerritoryDiff !== undefined &&
    terminalTerritoryDiff <= config.terminalTerritoryDiffThreshold
  )
    reasons.push('terminal-negative-territory-difference')
  return {
    action: reply,
    ownTerritoryBefore: territoryBefore[perspective],
    ownTerritoryAfter: territoryAfter[perspective],
    opponentTerritoryBefore: territoryBefore[rival],
    opponentTerritoryAfter: territoryAfter[rival],
    ownAccessibleBefore,
    ownAccessibleAfter,
    opponentAccessibleBefore,
    opponentAccessibleAfter,
    opponentTerritoryGain,
    ownAccessibleDrop,
    largestComponentBefore: largestComponent(regionsBefore),
    largestComponentAfter: largestComponent(regionsAfter),
    lostLastOwnStoneInLargeComponent: lastStone.detected,
    exposedComponentSize: lastStone.exposedComponentSize,
    terminalTerritoryDiff,
    severe: reasons.length > 0,
    reasons,
  }
}

function severity(diagnostic: ClosureReplyDiagnostic): number {
  return (
    diagnostic.opponentTerritoryGain +
    diagnostic.ownAccessibleDrop +
    diagnostic.exposedComponentSize +
    (diagnostic.terminalTerritoryDiff === undefined
      ? 0
      : Math.max(0, -diagnostic.terminalTerritoryDiff))
  )
}

export function analyzeClosureCandidate(
  rootState: GameSnapshot,
  perspective: Player,
  candidate: MCTSChildResult,
  config: ClosureThreatVerificationConfig,
  now: () => number = () => performance.now(),
): ClosureCandidateDiagnostic {
  const startedAt = now()
  const stateAfterCandidate = applyFullAction(rootState, candidate.action).state
  const replies = stateAfterCandidate.result
    ? []
    : [...getLegalActions(stateAfterCandidate)].sort(
        (left, right) => replyPriority(left) - replyPriority(right),
      )
  let worstReply: ClosureReplyDiagnostic | undefined
  let repliesChecked = 0
  let stoppedByTimeLimit = false
  for (const reply of replies.slice(0, config.maxRepliesPerCandidate)) {
    if (now() - startedAt >= config.maxTimeMsPerCandidate) {
      stoppedByTimeLimit = true
      break
    }
    const diagnostic = analyzeClosureReply(stateAfterCandidate, perspective, reply, config)
    repliesChecked++
    if (!worstReply || severity(diagnostic) > severity(worstReply)) worstReply = diagnostic
  }
  if (stateAfterCandidate.result) {
    const score = stateAfterCandidate.result.score ?? territoryCounts(stateAfterCandidate)
    const rival = opponent(perspective)
    const diff = score[perspective] - score[rival]
    const severe = diff <= config.terminalTerritoryDiffThreshold
    worstReply = {
      action: candidate.action,
      ownTerritoryBefore: score[perspective],
      ownTerritoryAfter: score[perspective],
      opponentTerritoryBefore: score[rival],
      opponentTerritoryAfter: score[rival],
      ownAccessibleBefore: accessibleCount(stateAfterCandidate, perspective),
      ownAccessibleAfter: accessibleCount(stateAfterCandidate, perspective),
      opponentAccessibleBefore: accessibleCount(stateAfterCandidate, rival),
      opponentAccessibleAfter: accessibleCount(stateAfterCandidate, rival),
      opponentTerritoryGain: 0,
      ownAccessibleDrop: 0,
      largestComponentBefore: largestComponent(floodRegions(stateAfterCandidate.board)),
      largestComponentAfter: largestComponent(floodRegions(stateAfterCandidate.board)),
      lostLastOwnStoneInLargeComponent: false,
      exposedComponentSize: 0,
      terminalTerritoryDiff: diff,
      severe,
      reasons: severe ? ['terminal-negative-territory-difference'] : [],
    }
  }
  return {
    action: candidate.action,
    visits: candidate.visits,
    value: candidate.value,
    severe: worstReply?.severe ?? false,
    repliesAvailable: replies.length,
    repliesChecked,
    stoppedByTimeLimit,
    elapsedMs: now() - startedAt,
    maximumOpponentTerritoryGain: worstReply?.opponentTerritoryGain ?? 0,
    maximumOwnAccessibleDrop: worstReply?.ownAccessibleDrop ?? 0,
    lostLastOwnStoneInLargeComponent: worstReply?.lostLastOwnStoneInLargeComponent ?? false,
    worstReply,
  }
}

export function verifyClosureThreatCandidates(params: {
  rootState: GameSnapshot
  perspective: Player
  children: readonly MCTSChildResult[]
  originalAction: PlayerAction
  config?: ClosureThreatVerificationConfig
  now?: () => number
}): ClosureThreatVerificationResult {
  const config = params.config ?? EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG
  const startedAt = (params.now ?? (() => performance.now()))()
  if (!config.enabled)
    return {
      action: params.originalAction,
      changed: false,
      reason: 'disabled',
      originalAction: params.originalAction,
      candidates: [],
      threatsDetected: 0,
      totalElapsedMs: 0,
    }
  const ranked = [...params.children].sort(
    (left, right) => right.visits - left.visits || right.value - left.value,
  )
  const original = ranked.find((candidate) => sameAction(candidate.action, params.originalAction))
  const selected = new Map<string, MCTSChildResult>()
  if (original) selected.set(JSON.stringify(original.action), original)
  for (const candidate of ranked.slice(0, config.candidateCount))
    selected.set(JSON.stringify(candidate.action), candidate)
  const now = params.now ?? (() => performance.now())
  const candidates = Array.from(selected.values()).map((candidate) =>
    analyzeClosureCandidate(params.rootState, params.perspective, candidate, config, now),
  )
  const originalDiagnostic = candidates.find((candidate) =>
    sameAction(candidate.action, params.originalAction),
  )
  const safe = candidates
    .filter((candidate) => !candidate.severe)
    .sort((left, right) => right.visits - left.visits || right.value - left.value)
  const chosen = originalDiagnostic?.severe ? safe[0] : originalDiagnostic
  const allCollapse = candidates.length > 0 && candidates.every((candidate) => candidate.severe)
  const action = chosen?.action ?? params.originalAction
  return {
    action,
    changed: !sameAction(action, params.originalAction),
    reason: allCollapse
      ? 'all-candidates-collapse-fallback'
      : originalDiagnostic?.severe && chosen
        ? 'safer-candidate-preferred'
        : 'original-safe',
    originalAction: params.originalAction,
    candidates,
    threatsDetected: candidates.filter((candidate) => candidate.severe).length,
    totalElapsedMs: now() - startedAt,
  }
}
