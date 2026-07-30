import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import { canonicalStringify, sha256Canonical } from './humanExperimentCanonical'
import {
  discoverHumanMCTSTraces,
  type TraceCandidate,
  type TraceRejection,
} from './humanExperimentDownloadDiscovery'
import { HumanExperimentError, type HumanExperimentErrorCode } from './humanExperimentErrors'
import { readRegistry } from './humanExperimentExport'
import { addGame } from './humanExperimentValidation'
import {
  publishHumanExperimentTransaction,
  recoverHumanExperimentTransaction,
  type TransactionHooks,
} from './humanExperimentTransaction'
import type { HumanExperimentGameInput, HumanExperimentRegistry } from './humanExperimentTypes'
import { deriveGameFromTrace, validateRegistry } from './humanExperimentValidation'
import {
  CURRENT_HUMAN_EXPERIMENT_ID,
  type HumanExperimentCodeFreezeTraceability,
} from './humanExperimentConfig'

export interface IngestionSummary {
  participantId: string
  gameNumber: 1 | 2
  source: string
  destination: string
  humanColor: 'R' | 'B'
  aiColor: 'R' | 'B'
  winner: 'human' | 'ai' | 'draw'
  humanTerritory: number
  aiTerritory: number
  turnCount: number
  durationMs: number
  participantCount: number
  gameCount: number
}

export function currentGitCommit(run = execFileSync): string {
  let value: string
  try {
    value = String(run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })).trim()
  } catch (error) {
    throw new Error(
      `Unable to determine Git commit: ${error instanceof Error ? error.message : error}`,
    )
  }
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`Invalid Git commit: ${value || '<empty>'}`)
  return value
}

export async function ingestLatestHumanExperimentTrace(params: {
  experimentDirectory: string
  participantId: string
  gameNumber: number
  explicitTracePath?: string
  downloadDirectories?: string[]
  expectedCommit?: string
  expectedCodeFreeze?: HumanExperimentCodeFreezeTraceability
  hooks?: TransactionHooks
}): Promise<IngestionSummary> {
  if (!/^P0[1-8]$/.test(params.participantId)) throw new Error('participantId must be P01-P08')
  if (params.gameNumber !== 1 && params.gameNumber !== 2)
    throw new Error('gameNumber must be 1 or 2')
  const gameNumber = params.gameNumber as 1 | 2
  const root = resolve(params.experimentDirectory)
  await recoverHumanExperimentTransaction(root)
  const registryPath = resolve(root, 'registry.json')
  const registry = await readRegistry(registryPath)
  const participant = registry.participants.find(
    (entry) => entry.participantId === params.participantId,
  )
  if (!participant)
    throw new HumanExperimentError(
      'PARTICIPANT_NOT_REGISTERED',
      `Participant is not registered: ${params.participantId}`,
    )
  const existingGames = registry.games.filter((game) => game.participantId === params.participantId)
  if (existingGames.some((game) => game.gameNumber === gameNumber))
    throw new HumanExperimentError(
      'ALREADY_REGISTERED',
      `Game ${gameNumber} is already registered for ${params.participantId}`,
    )
  if (gameNumber === 2 && !existingGames.some((game) => game.gameNumber === 1))
    throw new HumanExperimentError(
      'PARTICIPANT_NOT_REGISTERED',
      'Game 1 must be registered before game 2',
    )
  const expectedCommit = params.expectedCommit ?? currentGitCommit()
  const expectedCodeFreeze =
    params.expectedCodeFreeze ??
    (registry.experimentId === CURRENT_HUMAN_EXPERIMENT_ID
      ? await currentCodeFreeze(root, expectedCommit)
      : undefined)
  const gameJsonPath = resolve(
    root,
    'participants',
    params.participantId,
    `game-${gameNumber}.json`,
  )
  const destination = resolve(
    root,
    'participants',
    params.participantId,
    'traces',
    `game-${gameNumber}.json`,
  )
  await ensureDestinationAbsent(destination)
  const input = await gameInput(gameJsonPath)
  const accepted = async (candidate: TraceCandidate) => {
    await validateCandidate({
      candidate,
      registry,
      input,
      expectedCommit,
      expectedCodeFreeze,
      root,
      participantId: params.participantId,
      gameNumber,
    })
    return true
  }
  const discovery = await discoverHumanMCTSTraces({
    directories: params.downloadDirectories,
    explicitTracePath: params.explicitTracePath,
    accept: accepted,
  })
  if (discovery.candidates.length === 0) {
    const searched = params.explicitTracePath
      ? params.explicitTracePath
      : discovery.searchedDirectories.join(', ') || '<none>'
    throw new HumanExperimentError(
      'INVALID_TRACE',
      `No compatible trace found. Searched: ${searched}${formatRejections(discovery.rejected)}`,
    )
  }
  if (discovery.candidates.length > 1) {
    const details = discovery.candidates
      .map((candidate) => {
        const trace = candidate.trace
        const result = trace.final?.result.tie ? 'draw' : (trace.final?.result.winner ?? 'unknown')
        return (
          `${candidate.path} | ${new Date(candidate.modifiedMs).toISOString()} | ` +
          `${trace.metadata.gameId} | human ${trace.metadata.humanColor} | result ${result}`
        )
      })
      .join('\n')
    throw new Error(`Multiple compatible traces found; pass an explicit path:\n${details}`)
  }
  const candidate = discovery.candidates[0]
  const traceJson = await readFile(candidate.path, 'utf8')
  const game = await deriveGameFromTrace({
    registry,
    input,
    traceJson,
    tracePath: `participants/${params.participantId}/traces/game-${gameNumber}.json`,
  })
  const updatedRegistry = addGame(registry, game)
  validateRegistry(updatedRegistry)
  const metadataPath = resolve(root, 'metadata.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
  if (metadata.experimentId !== registry.experimentId)
    throw new Error('Metadata experimentId does not match the registry')
  const updatedMetadata = { ...metadata, gameCount: updatedRegistry.games.length }
  validatePreparedState({
    registry: updatedRegistry,
    game,
    traceJson,
    metadata: updatedMetadata,
    expectedTracePath: game.tracePath,
  })
  await publishHumanExperimentTransaction({
    root,
    candidates: {
      [game.tracePath]: traceJson,
      'registry.json': json(updatedRegistry),
      [`participants/${params.participantId}/game-${gameNumber}.json`]: json(game),
      'metadata.json': json(updatedMetadata),
    },
    hooks: params.hooks,
  })
  return {
    participantId: params.participantId,
    gameNumber,
    source: candidate.path,
    destination,
    humanColor: game.humanColor,
    aiColor: game.aiColor,
    winner: game.winner,
    humanTerritory: game.humanTerritory,
    aiTerritory: game.aiTerritory,
    turnCount: game.turnCount,
    durationMs: game.durationMs,
    participantCount: updatedRegistry.participants.length,
    gameCount: updatedRegistry.games.length,
  }
}

function validatePreparedState(params: {
  registry: HumanExperimentRegistry
  game: HumanExperimentRegistry['games'][number]
  traceJson: string
  metadata: Record<string, unknown>
  expectedTracePath: string
}): void {
  if (params.metadata.gameCount !== params.registry.games.length)
    throw new Error('Prepared metadata.gameCount mismatch')
  const registered = params.registry.games.find((row) => row.gameId === params.game.gameId)
  if (canonicalStringify(registered) !== canonicalStringify(params.game))
    throw new Error('Prepared game file differs from registry')
  const paths = params.registry.games.map((row) => row.tracePath)
  if (!paths.includes(params.expectedTracePath) || new Set(paths).size !== paths.length)
    throw new Error('Prepared official trace inventory mismatch')
  JSON.parse(params.traceJson)
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Sin esto, una traza descartada por commit incorrecto o por ser de práctica producía
 * únicamente «No compatible trace found», sin decir cuál era el problema.
 */
function formatRejections(rejections: TraceRejection[]): string {
  if (rejections.length === 0) return ''
  const details = rejections
    .map((rejection) => {
      const code = rejection.code ? `${rejection.code}: ` : ''
      return `  ${rejection.path} → ${code}${rejection.reason}`
    })
    .join('\n')
  return `\nTrazas descartadas:\n${details}`
}

async function validateCandidate(params: {
  candidate: TraceCandidate
  registry: HumanExperimentRegistry
  input: HumanExperimentGameInput
  expectedCommit: string
  expectedCodeFreeze?: HumanExperimentCodeFreezeTraceability
  root: string
  participantId: string
  gameNumber: 1 | 2
}): Promise<void> {
  const trace = params.candidate.trace
  const reject = (code: HumanExperimentErrorCode, message: string): never => {
    throw new HumanExperimentError(code, message)
  }
  if (!trace.final || trace.decisions.length === 0)
    reject('INVALID_TRACE', 'Trace is not finalized')
  if (trace.metadata.experimentId !== params.registry.experimentId)
    reject('INVALID_TRACE', 'Trace experimentId does not match the registry')
  if (trace.metadata.participantId !== params.participantId)
    reject('INVALID_TRACE', 'Trace participantId does not match the pending participant')
  if (trace.metadata.gameNumber !== params.gameNumber)
    reject('INVALID_TRACE', 'Trace gameNumber does not match the pending game')
  if (trace.metadata.sessionType !== 'official')
    reject(
      'INVALID_TRACE',
      `Trace sessionType must be official, received ${trace.metadata.sessionType ?? '<none>'}`,
    )
  if (!trace.metadata.sessionId) reject('INVALID_TRACE', 'Trace sessionId is missing')
  if (trace.metadata.projectCommit !== params.expectedCommit)
    reject('COMMIT_MISMATCH', 'Trace projectCommit does not match the expected runtime')
  if (trace.metadata.runtimeCommit !== params.expectedCommit)
    reject('COMMIT_MISMATCH', 'Trace runtimeCommit does not match the expected runtime')
  if (
    params.expectedCodeFreeze &&
    (trace.metadata.implementationCommit !== params.expectedCodeFreeze.implementationCommit ||
      trace.metadata.experimentPreparationCommit !==
        params.expectedCodeFreeze.experimentPreparationCommit ||
      trace.metadata.codeFreezeBindingCommit !== params.expectedCodeFreeze.codeFreezeBindingCommit)
  )
    reject('COMMIT_MISMATCH', 'Trace code-freeze commits do not match the expected runtime')
  const participant = params.registry.participants.find(
    (entry) => entry.participantId === params.participantId,
  )
  if (!participant) reject('PARTICIPANT_NOT_REGISTERED', 'Participant is not registered')
  const expectedHumanColor = participant!.colorOrder[params.gameNumber - 1]
  if (trace.metadata.humanColor !== expectedHumanColor)
    reject('INVALID_TRACE', 'Trace human color does not match the assigned order')
  if (trace.metadata.mctsColor === expectedHumanColor)
    reject('INVALID_TRACE', 'Trace MCTS color must be opposite to the human color')
  if (
    canonicalStringify(trace.metadata.finalHumanChallengeConfig) !==
    canonicalStringify(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG)
  )
    reject('INVALID_TRACE', 'Trace configuration is not FINAL_HUMAN_CHALLENGE_MCTS_CONFIG')
  if (params.candidate.path.replace(/\\/g, '/').includes('/data/human-experiment/pilot/'))
    reject('INVALID_TRACE', 'Pilot traces cannot be ingested into the official experiment')
  if (params.candidate.path.replace(/\\/g, '/').includes('/data/human-experiment/real-pilot/'))
    reject('INVALID_TRACE', 'Real-pilot traces cannot be ingested into the official experiment')
  const traceHash = await sha256Canonical(trace)
  if (params.registry.games.some((game) => game.traceSha256 === traceHash))
    reject('ALREADY_REGISTERED', 'Trace content is already registered')
  await deriveGameFromTrace({
    registry: params.registry,
    input: params.input,
    traceJson: JSON.stringify(trace),
    tracePath: `participants/${params.participantId}/traces/game-${params.gameNumber}.json`,
  })
}

async function currentCodeFreeze(
  root: string,
  runtimeCommit: string,
  run = execFileSync,
): Promise<HumanExperimentCodeFreezeTraceability> {
  const metadata = JSON.parse(await readFile(resolve(root, 'metadata.json'), 'utf8'))
  const implementationCommit = fullCommit(metadata?.codeFreeze?.implementationCommit)
  const experimentPreparationCommit = fullCommit(metadata?.codeFreeze?.experimentPreparationCommit)
  const ancestry = String(
    run(
      'git',
      ['rev-list', '--ancestry-path', '--reverse', `${implementationCommit}..${runtimeCommit}`],
      { encoding: 'utf8' },
    ),
  )
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  return {
    implementationCommit,
    experimentPreparationCommit,
    codeFreezeBindingCommit: fullCommit(ancestry[0]),
  }
}

function fullCommit(value: unknown): string {
  const commit = String(value ?? '').trim()
  if (!/^[0-9a-f]{40}$/i.test(commit))
    throw new Error(`Invalid frozen Git commit: ${commit || '<empty>'}`)
  return commit
}

async function gameInput(path: string): Promise<HumanExperimentGameInput> {
  const { readFile } = await import('node:fs/promises')
  return JSON.parse(await readFile(path, 'utf8')) as HumanExperimentGameInput
}

async function ensureDestinationAbsent(path: string): Promise<void> {
  const { access } = await import('node:fs/promises')
  let present = false
  try {
    await access(path)
    present = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // `inspect`: puede ser una traza ya publicada o el resto de una operación interrumpida,
  // así que el vigilante consulta el registro antes de decidir si reintenta.
  if (present)
    throw new HumanExperimentError('DESTINATION_CONFLICT', `Destination already exists: ${path}`)
}
