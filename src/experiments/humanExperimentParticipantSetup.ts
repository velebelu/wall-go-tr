import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { atomicWriteJson, readRegistry } from './humanExperimentExport'
import type { ExperienceGroup, HumanExperimentParticipant } from './humanExperimentTypes'
import { addParticipant, validateParticipant } from './humanExperimentValidation'

const PARTICIPANT_PATTERN = /^P0[1-8]$/

export async function setupHumanExperimentParticipant(params: {
  experimentDirectory: string
  participantId: string
  experienceGroup: string
  previousWallGoGames: number
  notes?: string
  hooks?: {
    beforeRegistryRename?: () => Promise<void> | void
    beforeParticipantRename?: () => Promise<void> | void
  }
}) {
  validateSetupValues(params.participantId, params.experienceGroup, params.previousWallGoGames)
  const root = resolve(params.experimentDirectory)
  const registryPath = resolve(root, 'registry.json')
  const participantPath = resolve(root, 'participants', params.participantId, 'participant.json')
  const registry = await readRegistry(registryPath)
  if (registry.participants.some((entry) => entry.participantId === params.participantId))
    throw new Error(`Participant already registered: ${params.participantId}`)
  const template = JSON.parse(await readFile(participantPath, 'utf8')) as HumanExperimentParticipant
  if (template.participantId !== params.participantId)
    throw new Error('Participant template ID mismatch')
  if (template.experimentId !== registry.experimentId)
    throw new Error('Participant template experimentId mismatch')
  const participant: HumanExperimentParticipant = {
    ...template,
    experienceGroup: params.experienceGroup as ExperienceGroup,
    previousWallGoGames: params.previousWallGoGames,
    notes: params.notes ?? '',
  }
  validateParticipant(participant)
  const updatedRegistry = addParticipant(registry, participant)
  const originalRegistry = JSON.parse(JSON.stringify(registry))
  try {
    await atomicWriteJson(registryPath, updatedRegistry, {
      beforeRename: params.hooks?.beforeRegistryRename,
    })
    await atomicWriteJson(participantPath, participant, {
      beforeRename: params.hooks?.beforeParticipantRename,
    })
  } catch (error) {
    await atomicWriteJson(registryPath, originalRegistry)
    throw error
  }
  return { participant, registry: updatedRegistry, participantPath, registryPath }
}

export function validateSetupValues(
  participantId: string,
  experienceGroup: string,
  previousWallGoGames: number,
): void {
  if (!PARTICIPANT_PATTERN.test(participantId)) throw new Error('participantId must be P01-P08')
  if (!['none', 'basic', 'experienced'].includes(experienceGroup))
    throw new Error('experienceGroup must be none, basic, or experienced')
  if (!Number.isInteger(previousWallGoGames) || previousWallGoGames < 0)
    throw new Error('previousWallGoGames must be a non-negative integer')
  const coherent =
    (experienceGroup === 'none' && previousWallGoGames === 0) ||
    (experienceGroup === 'basic' && previousWallGoGames >= 1 && previousWallGoGames <= 5) ||
    (experienceGroup === 'experienced' && previousWallGoGames >= 6)
  if (!coherent) throw new Error('experienceGroup is inconsistent with previousWallGoGames')
}
