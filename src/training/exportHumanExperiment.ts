import { resolve } from 'node:path'
import { exportHumanExperiment, readRegistry } from '@/experiments/humanExperimentExport'

const experimentDirectory = process.argv[2]
const outputDirectory = process.argv[3]
if (!experimentDirectory)
  throw new Error('Usage: exportHumanExperiment <experiment-directory> [output-directory]')
const registry = await readRegistry(resolve(experimentDirectory, 'registry.json'))
const output = outputDirectory ?? resolve(experimentDirectory, 'export')
const result = await exportHumanExperiment({
  registry,
  outputDirectory: output,
  command: `npm run human-experiment:export -- ${experimentDirectory} ${outputDirectory ?? 'export'}`,
})
console.log(JSON.stringify(result, null, 2))
