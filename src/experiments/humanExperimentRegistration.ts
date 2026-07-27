import { readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { atomicWriteJson, readRegistry } from './humanExperimentExport'
import type { HumanExperimentGameInput, HumanExperimentParticipant } from './humanExperimentTypes'
import { addGame, addParticipant, deriveGameFromTrace } from './humanExperimentValidation'

export interface RegistrationWriteHooks {
  beforeRename?: () => Promise<void> | void
}

export async function registerParticipantFromFiles(params: {
  experimentDirectory: string
  participantJsonPath: string
  hooks?: RegistrationWriteHooks
}): Promise<{ participantId: string; registryPath: string }> {
  const experimentDirectory = resolve(params.experimentDirectory)
  await requireDirectory(experimentDirectory)
  const registryPath = resolve(experimentDirectory, 'registry.json')
  const registry = await readRequiredRegistry(registryPath)
  const participant = JSON.parse(
    await readFile(resolve(params.participantJsonPath), 'utf8'),
  ) as HumanExperimentParticipant
  if (participant.experimentId !== registry.experimentId)
    throw new Error('Participant experimentId does not match the experiment registry')
  const updated = addParticipant(registry, participant)
  await atomicWriteJson(registryPath, updated, params.hooks)
  return { participantId: participant.participantId, registryPath }
}

export async function registerGameFromFiles(params: {
  experimentDirectory: string
  gameJsonPath: string
  traceJsonPath: string
  hooks?: RegistrationWriteHooks
}): Promise<{ gameId: string; registryPath: string }> {
  const experimentDirectory = resolve(params.experimentDirectory)
  await requireDirectory(experimentDirectory)
  const registryPath = resolve(experimentDirectory, 'registry.json')
  const registry = await readRequiredRegistry(registryPath)
  const input = JSON.parse(
    await readFile(resolve(params.gameJsonPath), 'utf8'),
  ) as HumanExperimentGameInput
  if (input.experimentId !== registry.experimentId)
    throw new Error('Game experimentId does not match the experiment registry')
  const absoluteTrace = resolve(params.traceJsonPath)
  const traceJson = await readFile(absoluteTrace, 'utf8')
  const relativeTrace = relative(experimentDirectory, absoluteTrace).replace(/\\/g, '/')
  const game = await deriveGameFromTrace({
    registry,
    input,
    traceJson,
    tracePath: relativeTrace,
    pilot: experimentDirectory.replace(/\\/g, '/').split('/').includes('pilot'),
  })
  await atomicWriteJson(registryPath, addGame(registry, game), params.hooks)
  return { gameId: game.gameId, registryPath }
}

async function requireDirectory(path: string): Promise<void> {
  let details
  try {
    details = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`Experiment directory does not exist: ${path}`)
    throw error
  }
  if (!details.isDirectory()) throw new Error(`Experiment path is not a directory: ${path}`)
}

async function readRequiredRegistry(path: string) {
  try {
    return await readRegistry(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`Experiment registry does not exist: ${path}`)
    throw error
  }
}
