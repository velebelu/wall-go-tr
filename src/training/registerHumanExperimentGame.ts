import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { atomicWriteJson, readRegistry } from '@/experiments/humanExperimentExport'
import type { HumanExperimentGameInput } from '@/experiments/humanExperimentTypes'
import { addGame, deriveGameFromTrace } from '@/experiments/humanExperimentValidation'

const inputPath = process.argv[2]
const tracePath = process.argv[3]
if (!inputPath || !tracePath)
  throw new Error('Usage: registerHumanExperimentGame <game.json> <trace.json>')
const absoluteInput = resolve(inputPath)
const absoluteTrace = resolve(tracePath)
const experimentDirectory = dirname(absoluteInput)
const registryPath = resolve(experimentDirectory, 'registry.json')
const registry = await readRegistry(registryPath)
const input = JSON.parse(await readFile(absoluteInput, 'utf8')) as HumanExperimentGameInput
const traceJson = await readFile(absoluteTrace, 'utf8')
const relativeTrace = relative(experimentDirectory, absoluteTrace).replace(/\\/g, '/')
const game = await deriveGameFromTrace({
  registry,
  input,
  traceJson,
  tracePath: relativeTrace,
  pilot: experimentDirectory.replace(/\\/g, '/').split('/').includes('pilot'),
})
await atomicWriteJson(registryPath, addGame(registry, game))
console.log(`Registered game ${game.gameId} in ${registryPath}`)
