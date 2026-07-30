import { access, readFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import {
  CURRENT_HUMAN_EXPERIMENT_DIRECTORY,
  CURRENT_HUMAN_EXPERIMENT_ID,
} from '@/experiments/humanExperimentConfig'
import { canonicalStringify } from '@/experiments/humanExperimentCanonical'
import { readRegistry } from '@/experiments/humanExperimentExport'
import type {
  HumanExperimentGame,
  HumanExperimentParticipant,
  HumanExperimentRegistry,
} from '@/experiments/humanExperimentTypes'
import { validateParticipant, validateRegistry } from '@/experiments/humanExperimentValidation'

const EXPECTED_PARTICIPANTS = Array.from({ length: 8 }, (_, index) => `P0${index + 1}`)
const FULL_COMMIT = /^[0-9a-f]{40}$/i
const TRACE_FILE = /\.json$/i

interface V3Metadata {
  schema?: string
  experimentId?: string
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
}

export interface HumanExperimentV3State {
  metadata: V3Metadata
  registry: HumanExperimentRegistry
  templates: Record<string, HumanExperimentParticipant>
  gameFiles: Record<string, unknown>
  officialTracePaths: string[]
  invalidSessions: InvalidSessionManifest[]
}

export function validateHumanExperimentV3State(state: HumanExperimentV3State): void {
  const { metadata, registry } = state
  if (metadata.schema !== 'HumanExperimentMetadataV2') fail('Invalid V3 metadata schema')
  if (
    metadata.experimentId !== CURRENT_HUMAN_EXPERIMENT_ID ||
    registry.experimentId !== CURRENT_HUMAN_EXPERIMENT_ID
  )
    fail('V3 experimentId mismatch')
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
    const expectedColors = index % 2 === 0 ? ['R', 'B'] : ['B', 'R']
    if (canonicalStringify(template.colorOrder) !== canonicalStringify(expectedColors))
      fail(`Invalid color order for ${participantId}`)
    if (template.practiceGames !== 1) fail(`Invalid practice count for ${participantId}`)
    for (const gameNumber of [1, 2]) {
      if (!state.gameFiles[`${participantId}/${gameNumber}`])
        fail(`Missing game file for ${participantId}-${gameNumber}`)
    }
  }

  validateGames(registry, state.gameFiles)
  validateTraceInventory(registry, state.officialTracePaths)
  validateInvalidSessions(state)
}

export async function validateHumanExperimentV3Directory(
  root = resolve(CURRENT_HUMAN_EXPERIMENT_DIRECTORY),
): Promise<HumanExperimentV3State> {
  const registry = await readRegistry(resolve(root, 'registry.json'))
  const metadata = JSON.parse(await readFile(resolve(root, 'metadata.json'), 'utf8')) as V3Metadata
  const templates: Record<string, HumanExperimentParticipant> = {}
  const gameFiles: Record<string, unknown> = {}
  const officialTracePaths: string[] = []

  const participantDirectories = (await readdir(resolve(root, 'participants'))).sort()
  if (canonicalStringify(participantDirectories) !== canonicalStringify(EXPECTED_PARTICIPANTS))
    fail('V3 must contain exactly the P01-P08 participant directories')
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

  const invalidDirectory = resolve(dirname(root), 'invalid-sessions-v3')
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
  validateHumanExperimentV3State(state)
  await validateCurrentBinding(metadata)
  return state
}

async function validateCurrentBinding(metadata: V3Metadata): Promise<void> {
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

function validateFreeze(metadata: V3Metadata): void {
  if (
    metadata.aiPolicy?.status !== 'rejected' ||
    metadata.aiPolicy.accepted !== false ||
    metadata.aiPolicy.reason !== 'negative-counterfactual-effect' ||
    metadata.aiPolicy.securedTerritoryPolicy !== false
  )
    fail('securedTerritoryPolicy rejection metadata mismatch')
  const freeze = metadata.codeFreeze
  if (freeze?.status !== 'frozen') fail('V3 metadata is not frozen')
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

function validateInvalidSessions(state: HumanExperimentV3State): void {
  const ids = new Set<string>()
  for (const manifest of state.invalidSessions) {
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
    if (state.officialTracePaths.some((path) => path.includes(manifest.gameId!)))
      fail('Invalid session has an official trace')
  }
}

function fail(message: string): never {
  throw new Error(message)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const state = await validateHumanExperimentV3Directory()
  console.log(
    `Valid V3 operational state: ${state.registry.participants.length} registered participants, ` +
      `${state.registry.games.length} games, ${state.officialTracePaths.length} official traces, ` +
      `${state.invalidSessions.length} quarantined invalid sessions.`,
  )
}
