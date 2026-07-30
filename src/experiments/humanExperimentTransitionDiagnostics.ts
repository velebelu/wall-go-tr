import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import {
  serializeGameSnapshot,
  type HumanMCTSTraceDecisionV1,
  type HumanMCTSTraceV1,
  type SerializableGameSnapshot,
} from '@/utils/humanMCTSTrace'
import { canonicalStringify, sha256Canonical } from './humanExperimentCanonical'

export const TRANSITION_MISMATCH_SCHEMA = 'HumanExperimentTransitionMismatchV1' as const
export const COMMITTED_STATE_MISMATCH_ERROR =
  'Official session stopped: the committed state does not match the engine transition.'

export interface TransitionFieldDiff {
  path: string
  expected?: unknown
  committed?: unknown
}

export interface CapturedTransitionMismatch {
  experimentId?: string
  participantId?: string
  gameNumber?: 1 | 2
  sessionId?: string
  turnNumber: number
  turnNumberBasis: 'confirmed-decisions-count'
  activePlayer: Player
  runtimeCommit?: string
  projectCommit?: string
  implementationCommit?: string
  experimentPreparationCommit?: string
  codeFreezeBindingCommit?: string
  capturedAt: string
  stateBefore: SerializableGameSnapshot
  action: PlayerAction
  expectedState: SerializableGameSnapshot
  committedState: SerializableGameSnapshot
  fieldDiff: TransitionFieldDiff[]
  confirmedDecisions: HumanMCTSTraceDecisionV1[]
  partialTrace?: HumanMCTSTraceV1
}

export interface TransitionMismatchArtifact extends CapturedTransitionMismatch {
  schema: typeof TRANSITION_MISMATCH_SCHEMA
  schemaVersion: 1
  official: false
  registrationAllowed: false
  partialTraceDiagnostic?: {
    schema: 'HumanMCTSTraceDiagnosticV1'
    schemaVersion: 1
    official: false
    registrationAllowed: false
    error: 'committed-state-mismatch'
    trace: HumanMCTSTraceV1
  }
  proposedInvalidSessionManifest: {
    schema: 'HumanExperimentInvalidSessionManifestV1'
    status: 'quarantined'
    validity: 'invalid-transition-mismatch'
    registration: 'rejected'
    repeatRequired: true
    experimentId?: string
    sessionId?: string
    participantId?: string
    intendedGameNumber?: 1 | 2
    runtimeCommit?: string
    diagnosticSha256: string
    partialTraceSha256?: string
    reason: string
  }
  artifactHashes: {
    mismatchPayloadSha256: string
    partialTraceSha256?: string
    proposedManifestSha256: string
  }
  error: 'committed-state-mismatch'
  validity: 'invalid'
}

export interface PreparedTransitionMismatchArtifact {
  fileName: string
  bytes: number
  json: string
  artifact: TransitionMismatchArtifact
}

export function captureTransitionMismatch(params: {
  stateBefore: GameSnapshot
  action: PlayerAction
  expectedState: GameSnapshot
  committedState: GameSnapshot
  trace?: HumanMCTSTraceV1 | null
  capturedAt?: string
}): CapturedTransitionMismatch {
  const trace = params.trace ? structuredClone(params.trace) : undefined
  const metadata = trace?.metadata
  const expectedState = serializeGameSnapshot(params.expectedState)
  const committedState = serializeGameSnapshot(params.committedState)
  return structuredClone({
    experimentId: metadata?.experimentId,
    participantId: metadata?.participantId,
    gameNumber: metadata?.gameNumber,
    sessionId: metadata?.sessionId,
    turnNumber: trace?.decisions.length ?? 0,
    turnNumberBasis: 'confirmed-decisions-count' as const,
    activePlayer: params.stateBefore.turn,
    runtimeCommit: metadata?.runtimeCommit,
    projectCommit: metadata?.projectCommit,
    implementationCommit: metadata?.implementationCommit,
    experimentPreparationCommit: metadata?.experimentPreparationCommit,
    codeFreezeBindingCommit: metadata?.codeFreezeBindingCommit,
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    stateBefore: serializeGameSnapshot(params.stateBefore),
    action: params.action,
    expectedState,
    committedState,
    fieldDiff: diffValues(expectedState, committedState),
    confirmedDecisions: trace?.decisions ?? [],
    partialTrace: trace,
  })
}

export async function prepareTransitionMismatchArtifact(
  captured: CapturedTransitionMismatch,
): Promise<PreparedTransitionMismatchArtifact> {
  const mismatchPayloadSha256 = await sha256Canonical(captured)
  const partialTraceDiagnostic = captured.partialTrace
    ? {
        schema: 'HumanMCTSTraceDiagnosticV1' as const,
        schemaVersion: 1 as const,
        official: false as const,
        registrationAllowed: false as const,
        error: 'committed-state-mismatch' as const,
        trace: structuredClone(captured.partialTrace),
      }
    : undefined
  const partialTraceSha256 = partialTraceDiagnostic
    ? await sha256Canonical(partialTraceDiagnostic)
    : undefined
  const proposedInvalidSessionManifest = {
    schema: 'HumanExperimentInvalidSessionManifestV1' as const,
    status: 'quarantined' as const,
    validity: 'invalid-transition-mismatch' as const,
    registration: 'rejected' as const,
    repeatRequired: true as const,
    experimentId: captured.experimentId,
    sessionId: captured.sessionId,
    participantId: captured.participantId,
    intendedGameNumber: captured.gameNumber,
    runtimeCommit: captured.runtimeCommit,
    diagnosticSha256: mismatchPayloadSha256,
    partialTraceSha256,
    reason: COMMITTED_STATE_MISMATCH_ERROR,
  }
  const proposedManifestSha256 = await sha256Canonical(proposedInvalidSessionManifest)
  const artifact: TransitionMismatchArtifact = {
    schema: TRANSITION_MISMATCH_SCHEMA,
    schemaVersion: 1,
    official: false,
    registrationAllowed: false,
    ...structuredClone(captured),
    partialTraceDiagnostic,
    proposedInvalidSessionManifest,
    artifactHashes: {
      mismatchPayloadSha256,
      partialTraceSha256,
      proposedManifestSha256,
    },
    error: 'committed-state-mismatch',
    validity: 'invalid',
  }
  const json = `${JSON.stringify(artifact, null, 2)}\n`
  return {
    fileName: `diagnostico_transicion_${safeName(captured.sessionId ?? 'sin-sesion')}_turno-${captured.turnNumber}.json`,
    bytes: new TextEncoder().encode(json).length,
    json,
    artifact,
  }
}

export async function validateTransitionMismatchArtifact(
  value: unknown,
): Promise<TransitionMismatchArtifact> {
  const artifact = value as TransitionMismatchArtifact
  if (
    artifact?.schema !== TRANSITION_MISMATCH_SCHEMA ||
    artifact.schemaVersion !== 1 ||
    artifact.official !== false ||
    artifact.registrationAllowed !== false ||
    artifact.error !== 'committed-state-mismatch' ||
    artifact.validity !== 'invalid'
  )
    throw new Error('Invalid transition mismatch diagnostic')
  if (
    !artifact.stateBefore ||
    !artifact.action ||
    !artifact.expectedState ||
    !artifact.committedState ||
    !Array.isArray(artifact.fieldDiff) ||
    !Array.isArray(artifact.confirmedDecisions)
  )
    throw new Error('Incomplete transition mismatch diagnostic')
  if (artifact.fieldDiff.length === 0)
    throw new Error('Transition mismatch diagnostic has no field differences')

  const {
    schema: _schema,
    schemaVersion: _schemaVersion,
    official: _official,
    registrationAllowed: _registrationAllowed,
    partialTraceDiagnostic,
    proposedInvalidSessionManifest,
    artifactHashes,
    error: _error,
    validity: _validity,
    ...captured
  } = artifact
  if ((await sha256Canonical(captured)) !== artifactHashes.mismatchPayloadSha256)
    throw new Error('Transition mismatch payload SHA-256 mismatch')
  if (partialTraceDiagnostic) {
    if (
      partialTraceDiagnostic.official !== false ||
      partialTraceDiagnostic.registrationAllowed !== false
    )
      throw new Error('Transition mismatch partial trace is not blocked from registration')
    if ((await sha256Canonical(partialTraceDiagnostic)) !== artifactHashes.partialTraceSha256)
      throw new Error('Transition mismatch partial trace SHA-256 mismatch')
  } else if (artifactHashes.partialTraceSha256) {
    throw new Error('Transition mismatch partial trace hash has no artifact')
  }
  if (
    (await sha256Canonical(proposedInvalidSessionManifest)) !==
    artifactHashes.proposedManifestSha256
  )
    throw new Error('Transition mismatch manifest SHA-256 mismatch')
  return structuredClone(artifact)
}

export function downloadTransitionMismatchArtifact(
  prepared: PreparedTransitionMismatchArtifact,
): void {
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
}

export async function persistTransitionMismatch(
  captured: CapturedTransitionMismatch,
): Promise<void> {
  downloadTransitionMismatchArtifact(await prepareTransitionMismatchArtifact(captured))
}

export function throwCommittedStateMismatchWithDiagnostic(
  captured: CapturedTransitionMismatch,
  persist: (value: CapturedTransitionMismatch) => Promise<void> = persistTransitionMismatch,
  logger: Pick<Console, 'error'> = console,
): never {
  void persist(captured).catch((error: unknown) => {
    logger.error('[Game] No se pudo persistir el diagnóstico de transición:', error)
  })
  throw new Error(COMMITTED_STATE_MISMATCH_ERROR)
}

export function verifyCommittedTransition(
  params: {
    stateBefore: GameSnapshot
    action: PlayerAction
    expectedState: GameSnapshot
    committedState: GameSnapshot
    trace?: HumanMCTSTraceV1 | null
    capturedAt?: string
  },
  persist: (value: CapturedTransitionMismatch) => Promise<void> = persistTransitionMismatch,
  logger: Pick<Console, 'error'> = console,
): void {
  if (
    diffValues(
      serializeGameSnapshot(params.expectedState),
      serializeGameSnapshot(params.committedState),
    ).length === 0
  )
    return
  const captured = captureTransitionMismatch(params)
  throwCommittedStateMismatchWithDiagnostic(captured, persist, logger)
}

export function diffValues(
  expected: unknown,
  committed: unknown,
  path = '',
): TransitionFieldDiff[] {
  if (canonicalStringify(expected) === canonicalStringify(committed)) return []
  if (isRecord(expected) && isRecord(committed)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(committed)])].sort()
    return keys.flatMap((key) =>
      diffValues(expected[key], committed[key], path ? `${path}.${key}` : key),
    )
  }
  if (Array.isArray(expected) && Array.isArray(committed)) {
    const length = Math.max(expected.length, committed.length)
    return Array.from({ length }, (_, index) =>
      diffValues(expected[index], committed[index], `${path}[${index}]`),
    ).flat()
  }
  return [
    {
      path: path || '$',
      expected: structuredClone(expected),
      committed: structuredClone(committed),
    },
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '_')
}
