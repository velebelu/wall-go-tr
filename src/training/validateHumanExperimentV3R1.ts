import { access, readFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import { CURRENT_HUMAN_EXPERIMENT_DIRECTORY } from '@/experiments/humanExperimentConfig'
import { canonicalStringify } from '@/experiments/humanExperimentCanonical'
import { readRegistry } from '@/experiments/humanExperimentExport'
import type {
  HumanExperimentGame,
  HumanExperimentParticipant,
  HumanExperimentRegistry,
} from '@/experiments/humanExperimentTypes'
import { validateParticipant, validateRegistry } from '@/experiments/humanExperimentValidation'

const EXPECTED_PARTICIPANTS = Array.from({ length: 8 }, (_, index) => `P0${index + 1}`)
const V3_R1_EXPERIMENT_ID = 'WGTR-HUMAN-FINAL-2026-V3-R1'
const V3_R1_EXPERIMENT_DIRECTORY = CURRENT_HUMAN_EXPERIMENT_DIRECTORY
const FULL_COMMIT = /^[0-9a-f]{40}$/i
const TRACE_FILE = /\.json$/i

interface V3R1Metadata {
  schema?: string
  experimentId?: string
  supersedes?: string
  archivedExperimentDirectory?: string
  gameCount?: number
  aiPolicy?: {
    status?: string
    accepted?: boolean
    reason?: string
    securedTerritoryPolicy?: boolean
  }
  codeFreeze?: {
    status?: string
    aiImplementationCommit?: string
    implementationCommit?: string
    experimentPreparationCommit?: string
  }
}

interface InvalidSessionManifest {
  schema?: string
  status?: string
  validity?: string
  registration?: string
  repeatRequired?: boolean
  gameId?: string
  participantId?: string
  intendedGameNumber?: number
  runtimeCommit?: string
  traceSha256?: string
  reason?: string
  sessionId?: string
  experimentId?: string
  date?: string
  displayedTurnApproximation?: number
  displayedActivePlayer?: string
  error?: string
  persistentTrace?: string
  recoverableArtifactHash?: string
  diagnosticSha256?: string
  partialTraceSha256?: string
  packageSha256?: string
  manifestPayloadSha256?: string
}

export interface HumanExperimentV3R1State {
  metadata: V3R1Metadata
  registry: HumanExperimentRegistry
  templates: Record<string, HumanExperimentParticipant>
  gameFiles: Record<string, unknown>
  officialTracePaths: string[]
  invalidSessions: InvalidSessionManifest[]
}

export function validateHumanExperimentV3R1State(state: HumanExperimentV3R1State): void {
  const { metadata, registry } = state
  if (metadata.schema !== 'HumanExperimentMetadataV2') fail('Invalid V3-R1 metadata schema')
  if (
    metadata.experimentId !== V3_R1_EXPERIMENT_ID ||
    registry.experimentId !== V3_R1_EXPERIMENT_ID
  )
    fail('V3-R1 experimentId mismatch')
  if (
    metadata.supersedes !== 'WGTR-HUMAN-FINAL-2026-V3' ||
    metadata.archivedExperimentDirectory !== 'data/human-experiment/final-2026-v3'
  )
    fail('V3-R1 must reference the archived V3 experiment')
  validateRegistry(registry)
  if (metadata.gameCount !== registry.games.length) fail('metadata.gameCount mismatch')
  validateFreeze(metadata)

  const participantIds = registry.participants.map((participant) => participant.participantId)
  if (new Set(participantIds).size !== participantIds.length) fail('Duplicate participant')
  for (const participant of registry.participants) {
    if (!EXPECTED_PARTICIPANTS.includes(participant.participantId))
      fail(`Unknown participant: ${participant.participantId}`)
    validateParticipant(participant)
    if (
      canonicalStringify(participant) !==
      canonicalStringify(state.templates[participant.participantId])
    )
      fail(`Registered participant does not match template: ${participant.participantId}`)
  }

  for (const [index, participantId] of EXPECTED_PARTICIPANTS.entries()) {
    const template = state.templates[participantId]
    if (!template) fail(`Missing participant template: ${participantId}`)
    if (template.experimentId !== V3_R1_EXPERIMENT_ID || template.participantId !== participantId)
      fail(`Invalid participant template identity: ${participantId}`)
    const expectedColors = index % 2 === 0 ? ['R', 'B'] : ['B', 'R']
    if (canonicalStringify(template.colorOrder) !== canonicalStringify(expectedColors))
      fail(`Invalid color order for ${participantId}`)
    if (template.practiceGames !== 1) fail(`Invalid practice count for ${participantId}`)
    for (const gameNumber of [1, 2]) {
      const game = state.gameFiles[`${participantId}/${gameNumber}`] as {
        schema?: string
        experimentId?: string
        participantId?: string
        gameNumber?: number
        incidents?: unknown[]
      }
      if (!game) fail(`Missing game file for ${participantId}-${gameNumber}`)
      const registered = registry.games.some(
        (entry) => entry.participantId === participantId && entry.gameNumber === gameNumber,
      )
      if (
        !registered &&
        (game.schema !== 'HumanExperimentGameInputV1' ||
          game.experimentId !== V3_R1_EXPERIMENT_ID ||
          game.participantId !== participantId ||
          game.gameNumber !== gameNumber ||
          !Array.isArray(game.incidents))
      )
        fail(`Invalid empty game template: ${participantId}-${gameNumber}`)
    }
  }

  validateGames(registry, state.gameFiles)
  validateTraceInventory(registry, state.officialTracePaths)
  validateInvalidSessions(state)
}

export async function validateHumanExperimentV3R1Directory(
  root = resolve(V3_R1_EXPERIMENT_DIRECTORY),
): Promise<HumanExperimentV3R1State> {
  const registry = await readRegistry(resolve(root, 'registry.json'))
  const metadata = JSON.parse(
    await readFile(resolve(root, 'metadata.json'), 'utf8'),
  ) as V3R1Metadata
  const templates: Record<string, HumanExperimentParticipant> = {}
  const gameFiles: Record<string, unknown> = {}
  const officialTracePaths: string[] = []

  const participantDirectories = (await readdir(resolve(root, 'participants'))).sort()
  if (canonicalStringify(participantDirectories) !== canonicalStringify(EXPECTED_PARTICIPANTS))
    fail('V3-R1 must contain exactly the P01-P08 participant directories')
  for (const participantId of EXPECTED_PARTICIPANTS) {
    const directory = resolve(root, 'participants', participantId)
    templates[participantId] = JSON.parse(
      await readFile(resolve(directory, 'participant.json'), 'utf8'),
    ) as HumanExperimentParticipant
    for (const gameNumber of [1, 2]) {
      gameFiles[`${participantId}/${gameNumber}`] = JSON.parse(
        await readFile(resolve(directory, `game-${gameNumber}.json`), 'utf8'),
      )
      await access(resolve(directory, 'auxiliary', `game-${gameNumber}`))
    }
    await access(resolve(directory, 'checklist.md'))
    for (const name of await readdir(resolve(directory, 'traces'))) {
      if (name !== '.gitkeep' && TRACE_FILE.test(name))
        officialTracePaths.push(`participants/${participantId}/traces/${name}`)
    }
  }

  const invalidDirectory = resolve(dirname(root), 'invalid-sessions-v3-r1')
  let invalidSessions: InvalidSessionManifest[] = []
  try {
    invalidSessions = await Promise.all(
      (await readdir(invalidDirectory))
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => JSON.parse(await readFile(resolve(invalidDirectory, name), 'utf8'))),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const state = {
    metadata,
    registry,
    templates,
    gameFiles,
    officialTracePaths: officialTracePaths.sort(),
    invalidSessions,
  }
  validateHumanExperimentV3R1State(state)
  if (metadata.codeFreeze?.status === 'prepared') {
    if (
      registry.participants.length !== 0 ||
      registry.games.length !== 0 ||
      officialTracePaths.length !== 0 ||
      invalidSessions.length !== 0
    )
      fail('Prepared V3-R1 must be completely empty')
  } else {
    await validateCurrentBinding(metadata)
  }
  return state
}

async function validateCurrentBinding(metadata: V3R1Metadata): Promise<void> {
  // The launcher owns the authoritative Git ancestry and post-binding path policy.
  // @ts-expect-error The runtime launcher is JavaScript and intentionally has no declaration file.
  const launcher = await import('../../scripts/start-human-experiment.mjs')
  const git = (args: string[]): string =>
    String(execFileSync('git', args, { encoding: 'utf8' })).trim()
  const runtimeCommit = String(
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
  ).trim()
  launcher.validateOfficialCodeFreeze(metadata, runtimeCommit, {
    commitExists: (commit: string) => {
      execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' })
      return true
    },
    isAncestor: (ancestor: string, descendant: string) => {
      execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
        stdio: 'ignore',
      })
      return true
    },
    ancestryPath: (ancestor: string, descendant: string) =>
      lines(git(['rev-list', '--ancestry-path', '--reverse', `${ancestor}..${descendant}`])),
    commitParents: (commit: string) => lines(git(['show', '-s', '--format=%P', commit])),
    changedPathsInCommit: (commit: string) =>
      lines(git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit])),
    fileAtCommit: (commit: string, path: string) => git(['show', `${commit}:${path}`]),
    changedPaths: (binding: string, runtime: string) =>
      lines(git(['diff', '--name-only', `${binding}..${runtime}`])),
  })
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function validateFreeze(metadata: V3R1Metadata): void {
  if (
    metadata.aiPolicy?.status !== 'rejected' ||
    metadata.aiPolicy.accepted !== false ||
    metadata.aiPolicy.reason !== 'negative-counterfactual-effect' ||
    metadata.aiPolicy.securedTerritoryPolicy !== false
  )
    fail('securedTerritoryPolicy rejection metadata mismatch')
  const freeze = metadata.codeFreeze
  if (freeze?.aiImplementationCommit !== 'd24414802111390f0d4cffc5cb87b0de56932904')
    fail('V3-R1 AI implementation commit changed')
  if (freeze.status === 'prepared') {
    if (
      freeze.implementationCommit !== 'PENDING_V3_R1_PREPARATION_COMMIT' ||
      freeze.experimentPreparationCommit !== 'PENDING_V3_R1_PREPARATION_COMMIT'
    )
      fail('Invalid V3-R1 preparation markers')
    return
  }
  if (freeze.status !== 'frozen') fail('V3-R1 metadata is neither prepared nor frozen')
  for (const [field, value] of Object.entries({
    implementationCommit: freeze.implementationCommit,
    experimentPreparationCommit: freeze.experimentPreparationCommit,
    ...(freeze.aiImplementationCommit
      ? { aiImplementationCommit: freeze.aiImplementationCommit }
      : {}),
  }))
    if (!FULL_COMMIT.test(value ?? '')) fail(`Invalid ${field}`)
  if (freeze.implementationCommit !== freeze.experimentPreparationCommit)
    fail('implementationCommit and experimentPreparationCommit must match')
}

function validateGames(
  registry: HumanExperimentRegistry,
  gameFiles: Record<string, unknown>,
): void {
  const gamesByParticipant = new Map<string, HumanExperimentGame[]>()
  for (const game of registry.games) {
    const games = gamesByParticipant.get(game.participantId) ?? []
    games.push(game)
    gamesByParticipant.set(game.participantId, games)
    const file = gameFiles[`${game.participantId}/${game.gameNumber}`]
    if (canonicalStringify(file) !== canonicalStringify(game))
      fail(`Registered game file mismatch: ${game.participantId}-${game.gameNumber}`)
    if (
      canonicalStringify(game.effectiveConfig) !==
      canonicalStringify(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG)
    )
      fail(`Invalid MCTS configuration: ${game.gameId}`)
    const expectedTracePath = `participants/${game.participantId}/traces/game-${game.gameNumber}.json`
    if (game.tracePath !== expectedTracePath) fail(`Invalid official trace path: ${game.tracePath}`)
  }
  for (const [participantId, games] of gamesByParticipant) {
    const numbers = games.map((game) => game.gameNumber).sort()
    if (numbers.includes(2) && !numbers.includes(1))
      fail(`Game 2 exists without game 1 for ${participantId}`)
  }
}

function validateTraceInventory(
  registry: HumanExperimentRegistry,
  officialTracePaths: string[],
): void {
  const registered = registry.games.map((game) => game.tracePath).sort()
  const actual = [...officialTracePaths].sort()
  if (new Set(actual).size !== actual.length) fail('Duplicate official trace path')
  if (canonicalStringify(actual) !== canonicalStringify(registered))
    fail('Official trace inventory does not match registry')
}

function validateInvalidSessions(state: HumanExperimentV3R1State): void {
  const ids = new Set<string>()
  for (const manifest of state.invalidSessions) {
    if (manifest.schema === 'HumanExperimentInvalidSessionManifestV1') {
      validatePersistedTransitionMismatch(state, manifest, ids)
      continue
    }
    if (manifest.schema === 'HumanExperimentInvalidSessionEvidenceV1') {
      validateInvalidSessionWithoutArtifacts(state, manifest, ids)
      continue
    }
    if (
      manifest.status !== 'quarantined' ||
      manifest.validity !== 'invalid-trace-mismatch' ||
      manifest.registration !== 'rejected' ||
      manifest.repeatRequired !== true ||
      !manifest.reason
    )
      fail('Invalid invalid-session manifest')
    if (!manifest.gameId || ids.has(manifest.gameId)) fail('Duplicate invalid-session gameId')
    ids.add(manifest.gameId)
    if (!EXPECTED_PARTICIPANTS.includes(manifest.participantId ?? ''))
      fail('Invalid-session participant is unknown')
    if (manifest.intendedGameNumber !== 1 && manifest.intendedGameNumber !== 2)
      fail('Invalid-session game number')
    if (!FULL_COMMIT.test(manifest.runtimeCommit ?? '')) fail('Invalid-session runtime commit')
    if (!/^[0-9a-f]{64}$/i.test(manifest.traceSha256 ?? '')) fail('Invalid-session trace SHA-256')
    if (state.registry.games.some((game) => game.gameId === manifest.gameId))
      fail('Invalid session was introduced into the official sample')
    // La comprobación anterior buscaba el gameId dentro de la ruta de la traza, pero las rutas
    // oficiales son `participants/P0X/traces/game-N.json` y nunca lo contienen: no podía fallar
    // nunca. El vínculo real entre manifiesto y registro es el contenido de la traza.
    if (state.registry.games.some((game) => game.traceSha256 === manifest.traceSha256))
      fail('Invalid session trace was registered as official')
  }
}

function validatePersistedTransitionMismatch(
  state: HumanExperimentV3R1State,
  manifest: InvalidSessionManifest,
  ids: Set<string>,
): void {
  if (
    manifest.status !== 'quarantined' ||
    manifest.validity !== 'invalid-transition-mismatch' ||
    manifest.registration !== 'rejected' ||
    manifest.repeatRequired !== true ||
    !manifest.reason
  )
    fail('Invalid persisted transition-mismatch manifest')
  if (!manifest.sessionId || ids.has(manifest.sessionId))
    fail('Duplicate or missing invalid-session sessionId')
  ids.add(manifest.sessionId)
  if (!EXPECTED_PARTICIPANTS.includes(manifest.participantId ?? ''))
    fail('Invalid-session participant is unknown')
  if (manifest.intendedGameNumber !== 1 && manifest.intendedGameNumber !== 2)
    fail('Invalid-session game number')
  if (!FULL_COMMIT.test(manifest.runtimeCommit ?? '')) fail('Invalid-session runtime commit')
  for (const hash of [
    manifest.diagnosticSha256,
    manifest.partialTraceSha256,
    manifest.packageSha256,
    manifest.manifestPayloadSha256,
  ])
    if (hash !== undefined && !/^[0-9a-f]{64}$/i.test(hash))
      fail('Invalid transition diagnostic SHA-256')
  if (!manifest.diagnosticSha256 || !manifest.packageSha256 || !manifest.manifestPayloadSha256)
    fail('Persisted transition diagnostic hashes are incomplete')
  if (
    state.registry.games.some(
      (game) =>
        game.traceSha256 === manifest.partialTraceSha256 ||
        (game.participantId === manifest.participantId &&
          game.gameNumber === manifest.intendedGameNumber),
    )
  )
    fail('Invalid transition session was introduced into the official sample')
}

function validateInvalidSessionWithoutArtifacts(
  state: HumanExperimentV3R1State,
  manifest: InvalidSessionManifest,
  ids: Set<string>,
): void {
  if (
    manifest.experimentId !== V3_R1_EXPERIMENT_ID ||
    manifest.validity !== 'invalid' ||
    manifest.registration !== 'rejected' ||
    manifest.repeatRequired !== true ||
    manifest.error !== 'committed-state-mismatch' ||
    manifest.persistentTrace !== 'absent' ||
    manifest.recoverableArtifactHash !== 'absent' ||
    !manifest.reason
  )
    fail('Invalid artifact-free session manifest')
  if (!manifest.sessionId || ids.has(manifest.sessionId))
    fail('Duplicate or missing invalid-session sessionId')
  ids.add(manifest.sessionId)
  if (!EXPECTED_PARTICIPANTS.includes(manifest.participantId ?? ''))
    fail('Invalid-session participant is unknown')
  if (manifest.intendedGameNumber !== 1 && manifest.intendedGameNumber !== 2)
    fail('Invalid-session game number')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.date ?? '')) fail('Invalid-session date')
  if (
    !Number.isInteger(manifest.displayedTurnApproximation) ||
    (manifest.displayedTurnApproximation ?? -1) < 0
  )
    fail('Invalid-session displayed turn')
  if (manifest.displayedActivePlayer !== 'R' && manifest.displayedActivePlayer !== 'B')
    fail('Invalid-session active player')
  if (manifest.traceSha256 !== undefined || manifest.runtimeCommit !== undefined)
    fail('Artifact-free invalid session must not invent trace or runtime hashes')
  if (
    state.registry.games.some(
      (game) =>
        game.participantId === manifest.participantId &&
        game.gameNumber === manifest.intendedGameNumber,
    )
  )
    fail('Invalid session occupied its intended official game')
}

function fail(message: string): never {
  throw new Error(message)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const state = await validateHumanExperimentV3R1Directory()
  const freezeStatus = state.metadata.codeFreeze?.status
  console.log(
    `Valid V3-R1 ${freezeStatus} state: ${state.registry.participants.length} registered participants, ` +
      `${state.registry.games.length} games, ${state.officialTracePaths.length} official traces, ` +
      `${state.invalidSessions.length} quarantined invalid sessions.`,
  )
}
