import { copyFile, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import { canonicalStringify, sha256Canonical } from './humanExperimentCanonical'
import { discoverHumanMCTSTraces, type TraceCandidate } from './humanExperimentDownloadDiscovery'
import { readRegistry } from './humanExperimentExport'
import { registerGameFromFiles } from './humanExperimentRegistration'
import type { HumanExperimentGameInput, HumanExperimentRegistry } from './humanExperimentTypes'
import { deriveGameFromTrace, validateRegistry } from './humanExperimentValidation'

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
  hooks?: { afterCopy?: () => Promise<void> | void }
}): Promise<IngestionSummary> {
  if (!/^P0[1-8]$/.test(params.participantId)) throw new Error('participantId must be P01-P08')
  if (params.gameNumber !== 1 && params.gameNumber !== 2)
    throw new Error('gameNumber must be 1 or 2')
  const gameNumber = params.gameNumber as 1 | 2
  const root = resolve(params.experimentDirectory)
  const registryPath = resolve(root, 'registry.json')
  const registry = await readRegistry(registryPath)
  const participant = registry.participants.find(
    (entry) => entry.participantId === params.participantId,
  )
  if (!participant) throw new Error(`Participant is not registered: ${params.participantId}`)
  const existingGames = registry.games.filter((game) => game.participantId === params.participantId)
  if (existingGames.some((game) => game.gameNumber === gameNumber))
    throw new Error(`Game ${gameNumber} is already registered for ${params.participantId}`)
  if (gameNumber === 2 && !existingGames.some((game) => game.gameNumber === 1))
    throw new Error('Game 1 must be registered before game 2')
  const expectedCommit = params.expectedCommit ?? currentGitCommit()
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
  const accepted = async (candidate: TraceCandidate) =>
    candidateIsValid({
      candidate,
      registry,
      input,
      expectedCommit,
      root,
      participantId: params.participantId,
      gameNumber,
    })
  const discovery = await discoverHumanMCTSTraces({
    directories: params.downloadDirectories,
    explicitTracePath: params.explicitTracePath,
    accept: accepted,
  })
  if (discovery.candidates.length === 0) {
    const searched = params.explicitTracePath
      ? params.explicitTracePath
      : discovery.searchedDirectories.join(', ') || '<none>'
    throw new Error(`No compatible trace found. Searched: ${searched}`)
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
  await mkdir(resolve(destination, '..'), { recursive: true })
  try {
    await copyFile(candidate.path, destination, 1)
    await params.hooks?.afterCopy?.()
    await registerGameFromFiles({
      experimentDirectory: root,
      gameJsonPath,
      traceJsonPath: destination,
    })
    const updatedRegistry = await readRegistry(registryPath)
    validateRegistry(updatedRegistry)
    const game = updatedRegistry.games.find(
      (entry) => entry.participantId === params.participantId && entry.gameNumber === gameNumber,
    )
    if (!game) throw new Error('Registered game is missing after ingestion')
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
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  }
}

async function candidateIsValid(params: {
  candidate: TraceCandidate
  registry: HumanExperimentRegistry
  input: HumanExperimentGameInput
  expectedCommit: string
  root: string
  participantId: string
  gameNumber: 1 | 2
}): Promise<boolean> {
  const trace = params.candidate.trace
  if (!trace.final || trace.decisions.length === 0) return false
  if (trace.metadata.experimentId !== params.registry.experimentId) return false
  if (trace.metadata.projectCommit !== params.expectedCommit) return false
  if (
    canonicalStringify(trace.metadata.finalHumanChallengeConfig) !==
    canonicalStringify(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG)
  )
    return false
  if (params.candidate.path.replace(/\\/g, '/').includes('/data/human-experiment/pilot/'))
    return false
  if (params.candidate.path.replace(/\\/g, '/').includes('/data/human-experiment/real-pilot/'))
    return false
  const traceHash = await sha256Canonical(trace)
  if (params.registry.games.some((game) => game.traceSha256 === traceHash)) return false
  try {
    await deriveGameFromTrace({
      registry: params.registry,
      input: params.input,
      traceJson: JSON.stringify(trace),
      tracePath: `participants/${params.participantId}/traces/game-${params.gameNumber}.json`,
    })
    return true
  } catch {
    return false
  }
}

async function gameInput(path: string): Promise<HumanExperimentGameInput> {
  const { readFile } = await import('node:fs/promises')
  return JSON.parse(await readFile(path, 'utf8')) as HumanExperimentGameInput
}

async function ensureDestinationAbsent(path: string): Promise<void> {
  const { access } = await import('node:fs/promises')
  try {
    await access(path)
    throw new Error(`Destination already exists: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
