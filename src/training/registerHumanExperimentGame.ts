import { registerGameFromFiles } from '@/experiments/humanExperimentRegistration'

const experimentDirectory = process.argv[2]
const gameJsonPath = process.argv[3]
const traceJsonPath = process.argv[4]
if (!experimentDirectory || !gameJsonPath || !traceJsonPath)
  throw new Error(
    'Usage: registerHumanExperimentGame <experiment-directory> <game.json> <trace.json>',
  )
const result = await registerGameFromFiles({
  experimentDirectory,
  gameJsonPath,
  traceJsonPath,
})
console.log(`Registered game ${result.gameId} in ${result.registryPath}`)
