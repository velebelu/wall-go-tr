import { resolve } from 'node:path'
import { HumanExperimentWatcher } from '@/experiments/humanExperimentWatcher'

const experimentDirectory = resolve(
  process.env.HUMAN_EXPERIMENT_DIR ?? 'data/human-experiment/final-2026',
)
const downloadDirectory =
  process.env.HUMAN_EXPERIMENT_DOWNLOAD_DIR ?? 'Z:\\ARCHIVOS ERIC\\Descargas'
const expectedCommit = process.env.VITE_GIT_COMMIT
if (!expectedCommit) throw new Error('VITE_GIT_COMMIT is required')

const watcher = new HumanExperimentWatcher({
  experimentDirectory,
  downloadDirectory,
  expectedCommit,
  logger: console,
})

const shutdown = () => watcher.close()
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

try {
  await watcher.start()
} catch (error) {
  watcher.close()
  throw error
}
