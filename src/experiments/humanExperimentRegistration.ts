import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { atomicWriteJson, readRegistry } from './humanExperimentExport'
import type { HumanExperimentParticipant } from './humanExperimentTypes'
import { addParticipant } from './humanExperimentValidation'

/**
 * El registro de partidas vivía aquí y escribía `registry.json` por su cuenta. Se retiró:
 * no validaba `sessionType`, commits, replay ni `traceSha256`, y dejaba sin actualizar
 * `metadata.json`, el archivo de partida y la traza oficial, de modo que el experimento
 * quedaba fallando su propia validación. La única vía admitida es
 * `ingestLatestHumanExperimentTrace`, que publica los cuatro archivos en una transacción.
 */

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
