import { resolve } from 'node:path'
import { HumanExperimentWatcher } from '@/experiments/humanExperimentWatcher'
import {
  CURRENT_HUMAN_EXPERIMENT_DIRECTORY,
  CURRENT_HUMAN_EXPERIMENT_INVALID_SESSIONS_DIRECTORY,
} from '@/experiments/humanExperimentConfig'

const experimentDirectory = resolve(CURRENT_HUMAN_EXPERIMENT_DIRECTORY)
const downloadDirectory =
  process.env.HUMAN_EXPERIMENT_DOWNLOAD_DIR ?? 'Z:\\ARCHIVOS ERIC\\Descargas'
const expectedCommit = process.env.VITE_GIT_COMMIT
if (!expectedCommit) throw new Error('VITE_GIT_COMMIT is required')

// Cuarentena bruta y operativa: material rechazado, no versionado y borrable. El registro
// auditado de sesiones invalidadas es otra cosa y vive versionado en
// `data/human-experiment/invalid-sessions-v3-r1/`. Se declara aquí de forma explícita en lugar
// de heredar el valor por defecto, para que la ruta ignorada por Git y la que usa el
// vigilante sean visiblemente la misma.
const quarantineDirectory = resolve(experimentDirectory, 'quarantine')
const invalidSessionDirectory = resolve(CURRENT_HUMAN_EXPERIMENT_INVALID_SESSIONS_DIRECTORY)

const watcher = new HumanExperimentWatcher({
  experimentDirectory,
  downloadDirectory,
  expectedCommit,
  quarantineDirectory,
  invalidSessionDirectory,
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
