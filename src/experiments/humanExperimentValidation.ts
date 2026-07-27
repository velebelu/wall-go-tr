import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import type { Player } from '@/lib/types'
import {
  parseHumanMCTSTrace,
  replayHumanMCTSTrace,
  type HumanMCTSTraceV1,
} from '@/utils/humanMCTSTrace'
import {
  canonicalStringify,
  createExperimentalGameId,
  sha256Canonical,
} from './humanExperimentCanonical'
import type {
  HumanExperimentGame,
  HumanExperimentGameInput,
  HumanExperimentIncident,
  HumanExperimentParticipant,
  HumanExperimentRegistry,
  HumanExperimentWinner,
} from './humanExperimentTypes'

const INCIDENT_CODES = new Set([
  'performance-warning',
  'participant-interruption',
  'application-reload',
  'trace-download-failure',
  'wrong-color-order',
  'practice-protocol-deviation',
  'missing-commit-pilot-only',
  'other',
])

export function emptyRegistry(experimentId: string): HumanExperimentRegistry {
  return { schema: 'HumanExperimentRegistryV1', experimentId, participants: [], games: [] }
}

export function validateParticipant(participant: HumanExperimentParticipant): void {
  if (participant.schema !== 'HumanExperimentParticipantV1') fail('Invalid participant schema')
  nonempty(participant.experimentId, 'experimentId')
  const id = participant.participantId?.trim()
  nonempty(id, 'participantId')
  if (
    id.includes('@') ||
    /[\\/]/.test(id) ||
    /\s/.test(id) ||
    /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:[-_ ][A-ZÁÉÍÓÚÑ]?[a-záéíóúñ]+)+$/.test(id)
  )
    fail('participantId must be a pseudonym without names, email addresses, spaces, or paths')
  if (!['none', 'basic', 'experienced'].includes(participant.experienceGroup))
    fail('Invalid experienceGroup')
  nonnegativeInteger(participant.previousWallGoGames, 'previousWallGoGames')
  nonnegativeInteger(participant.practiceGames, 'practiceGames')
  if (!validColorOrder(participant.colorOrder)) fail('colorOrder must be ["R","B"] or ["B","R"]')
  if (participant.notes && participant.notes.length > 240)
    fail('notes must not exceed 240 characters')
}

export function addParticipant(
  registry: HumanExperimentRegistry,
  participant: HumanExperimentParticipant,
): HumanExperimentRegistry {
  validateRegistryShape(registry)
  validateParticipant(participant)
  if (registry.experimentId !== participant.experimentId) fail('Experiment mismatch')
  if (registry.participants.some((row) => row.participantId === participant.participantId))
    fail('Duplicate participantId')
  return { ...registry, participants: [...registry.participants, structuredClone(participant)] }
}

export async function deriveGameFromTrace(params: {
  registry: HumanExperimentRegistry
  input: HumanExperimentGameInput
  traceJson: string
  tracePath: string
  pilot?: boolean
}): Promise<HumanExperimentGame> {
  const trace = parseHumanMCTSTrace(params.traceJson)
  if (!trace.final) fail('Trace is not finalized')
  const replay = replayHumanMCTSTrace(trace)
  if (!replay.ok) fail(`Trace replay failed: ${replay.divergence?.message ?? 'unknown divergence'}`)
  const input = params.input
  const participant = params.registry.participants.find(
    (row) => row.participantId === input.participantId,
  )
  if (!participant) fail('Participant does not exist')
  if (input.experimentId !== params.registry.experimentId) fail('Experiment mismatch')
  if (input.gameNumber !== 1 && input.gameNumber !== 2) fail('gameNumber must be 1 or 2')
  const humanColor = trace.metadata.humanColor
  const aiColor = trace.metadata.mctsColor
  if (humanColor === aiColor) fail('Human and AI colors must be opposite')
  if (participant.colorOrder[input.gameNumber - 1] !== humanColor) fail('Wrong color order')

  const startedAt = input.startedAt ?? trace.metadata.startedAt ?? trace.metadata.createdAt
  const finishedAt = input.finishedAt ?? trace.metadata.finishedAt
  if (!finishedAt) fail('finishedAt is missing')
  const expectedDuration = Date.parse(finishedAt) - Date.parse(startedAt)
  if (!Number.isFinite(expectedDuration) || expectedDuration < 0) fail('Invalid game dates')
  const durationMs = input.durationMs ?? trace.metadata.durationMs ?? expectedDuration
  if (durationMs !== expectedDuration) fail('durationMs does not match timestamps')

  const humanTerritory = trace.final.territory[humanColor]
  const aiTerritory = trace.final.territory[aiColor]
  const winner = winnerFromTrace(trace, humanColor, aiColor)
  const effectiveConfig = trace.metadata.finalHumanChallengeConfig
  if (!effectiveConfig) fail('Trace has no final human-challenge configuration')
  if (canonicalStringify(effectiveConfig) !== canonicalStringify(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG))
    fail('Trace configuration is not FINAL_HUMAN_CHALLENGE_MCTS_CONFIG')
  const effectiveConfigSha256 = await sha256Canonical(effectiveConfig)
  const traceSha256 = await sha256Canonical(trace)
  if (input.traceSha256 && input.traceSha256 !== traceSha256) fail('Trace SHA-256 mismatch')
  if (input.effectiveConfigSha256 && input.effectiveConfigSha256 !== effectiveConfigSha256)
    fail('Configuration SHA-256 mismatch')

  const sourceCommit = (input.sourceCommit ?? trace.metadata.projectCommit ?? '').trim()
  const incidents = validateIncidents(input.incidents ?? [])
  if (!sourceCommit) {
    const permitted =
      params.pilot && incidents.some((incident) => incident.code === 'missing-commit-pilot-only')
    if (!permitted) fail('sourceCommit is required')
  }

  const gameId = input.gameId ?? createExperimentalGameId(input.participantId, input.gameNumber)
  const traceId = input.traceId ?? `trace-${globalThis.crypto.randomUUID()}`
  const game: HumanExperimentGame = {
    schema: 'HumanExperimentGameV1',
    experimentId: input.experimentId,
    participantId: input.participantId,
    gameId,
    gameNumber: input.gameNumber,
    humanColor,
    aiColor,
    winner,
    humanTerritory,
    aiTerritory,
    territoryDiffHuman: humanTerritory - aiTerritory,
    turnCount: trace.final.totalTurns,
    startedAt,
    finishedAt,
    durationMs,
    terminalReason: input.terminalReason ?? trace.final.finishReason,
    traceId,
    tracePath: normalizeRelativePath(params.tracePath),
    traceSha256,
    seed: trace.metadata.seed,
    effectiveConfig: structuredClone(effectiveConfig),
    effectiveConfigSha256,
    sourceCommit,
    sourceVersion: input.sourceVersion ?? trace.metadata.projectVersion,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    incidents,
  }
  validateGameAgainstTrace(game, trace)
  return game
}

export function addGame(
  registry: HumanExperimentRegistry,
  game: HumanExperimentGame,
): HumanExperimentRegistry {
  validateRegistryShape(registry)
  const participant = registry.participants.find((row) => row.participantId === game.participantId)
  if (!participant) fail('Participant does not exist')
  if (registry.games.filter((row) => row.participantId === game.participantId).length >= 2)
    fail('Participant already has two games')
  if (registry.games.some((row) => row.gameId === game.gameId)) fail('Duplicate gameId')
  if (registry.games.some((row) => row.traceId === game.traceId)) fail('Duplicate traceId')
  if (registry.games.some((row) => row.tracePath === game.tracePath))
    fail('Trace path already used')
  if (
    registry.games.some(
      (row) => row.participantId === game.participantId && row.gameNumber === game.gameNumber,
    )
  )
    fail('Duplicate gameNumber for participant')
  if (participant.colorOrder[game.gameNumber - 1] !== game.humanColor) fail('Wrong color order')
  return { ...registry, games: [...registry.games, structuredClone(game)] }
}

export function validateRegistry(registry: HumanExperimentRegistry): void {
  validateRegistryShape(registry)
  let rebuilt = emptyRegistry(registry.experimentId)
  for (const participant of registry.participants) rebuilt = addParticipant(rebuilt, participant)
  for (const game of registry.games) rebuilt = addGame(rebuilt, game)
}

function validateGameAgainstTrace(game: HumanExperimentGame, trace: HumanMCTSTraceV1): void {
  if (!trace.final) fail('Trace is not finalized')
  if (game.turnCount !== trace.decisions.length || game.turnCount !== trace.final.totalTurns)
    fail('Turn count mismatch')
  if (game.humanTerritory !== trace.final.territory[game.humanColor])
    fail('Human territory mismatch')
  if (game.aiTerritory !== trace.final.territory[game.aiColor]) fail('AI territory mismatch')
  if (game.territoryDiffHuman !== game.humanTerritory - game.aiTerritory)
    fail('Territory difference mismatch')
  if (game.winner !== winnerFromTrace(trace, game.humanColor, game.aiColor)) fail('Winner mismatch')
  if (!game.terminalReason) fail('terminalReason is required')
}

function winnerFromTrace(
  trace: HumanMCTSTraceV1,
  humanColor: Player,
  aiColor: Player,
): HumanExperimentWinner {
  if (!trace.final) fail('Trace is not finalized')
  if (trace.final.result.tie) return 'draw'
  if (trace.final.result.winner === humanColor) return 'human'
  if (trace.final.result.winner === aiColor) return 'ai'
  fail('Trace has no coherent terminal winner')
}

function validateRegistryShape(registry: HumanExperimentRegistry): void {
  if (
    registry.schema !== 'HumanExperimentRegistryV1' ||
    !registry.experimentId ||
    !Array.isArray(registry.participants) ||
    !Array.isArray(registry.games)
  )
    fail('Invalid registry')
}

function validateIncidents(incidents: HumanExperimentIncident[]): HumanExperimentIncident[] {
  for (const incident of incidents) {
    if (!INCIDENT_CODES.has(incident.code)) fail(`Invalid incident code: ${incident.code}`)
    if (incident.description && incident.description.length > 160)
      fail('Incident description must not exceed 160 characters')
    if (incident.code === 'other' && !incident.description)
      fail('other incident needs a description')
  }
  return structuredClone(incidents)
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes('..')
  )
    fail('tracePath must be a safe relative path')
  return normalized
}

function validColorOrder(order: readonly Player[]): boolean {
  return order.length === 2 && order[0] !== order[1] && order.includes('R') && order.includes('B')
}
function nonempty(value: string, field: string): void {
  if (!value?.trim()) fail(`${field} is required`)
}
function nonnegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) fail(`${field} must be a non-negative integer`)
}
function fail(message: string): never {
  throw new Error(message)
}
