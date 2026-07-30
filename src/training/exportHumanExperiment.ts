import { resolve } from 'node:path'
import { exportHumanExperiment, readRegistry } from '@/experiments/humanExperimentExport'
import { CURRENT_HUMAN_EXPERIMENT_DIRECTORY } from '@/experiments/humanExperimentConfig'

const experimentDirectory = process.argv[2] ?? CURRENT_HUMAN_EXPERIMENT_DIRECTORY
const outputDirectory = process.argv[3]
const registry = await readRegistry(resolve(experimentDirectory, 'registry.json'))
const output = outputDirectory ?? resolve(experimentDirectory, 'export')
const result = await exportHumanExperiment({
  registry,
  outputDirectory: output,
  command: `npm run human-experiment:export -- ${experimentDirectory} ${outputDirectory ?? 'export'}`,
})
console.log(JSON.stringify(result, null, 2))
