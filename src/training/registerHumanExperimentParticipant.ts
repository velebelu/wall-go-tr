import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { atomicWriteJson, readRegistry } from '@/experiments/humanExperimentExport'
import type { HumanExperimentParticipant } from '@/experiments/humanExperimentTypes'
import { addParticipant, emptyRegistry } from '@/experiments/humanExperimentValidation'

const inputPath = process.argv[2]
if (!inputPath) throw new Error('Usage: registerHumanExperimentParticipant <participant.json>')
const absoluteInput = resolve(inputPath)
const participant = JSON.parse(await readFile(absoluteInput, 'utf8')) as HumanExperimentParticipant
const registryPath = resolve(dirname(absoluteInput), 'registry.json')
let registry
try {
  registry = await readRegistry(registryPath)
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  registry = emptyRegistry(participant.experimentId)
}
const updated = addParticipant(registry, participant)
await atomicWriteJson(registryPath, updated)
console.log(`Registered participant ${participant.participantId} in ${registryPath}`)
