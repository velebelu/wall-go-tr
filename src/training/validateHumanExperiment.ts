import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { readRegistry } from '@/experiments/humanExperimentExport'
import { canonicalStringify } from '@/experiments/humanExperimentCanonical'
import { deriveGameFromTrace, validateRegistry } from '@/experiments/humanExperimentValidation'
import { CURRENT_HUMAN_EXPERIMENT_DIRECTORY } from '@/experiments/humanExperimentConfig'

const experimentDirectory = process.argv[2] ?? CURRENT_HUMAN_EXPERIMENT_DIRECTORY
const registry = await readRegistry(resolve(experimentDirectory, 'registry.json'))
validateRegistry(registry)
await Promise.all(
  registry.games.map(async (game) => {
    const tracePath = resolve(
      dirname(resolve(experimentDirectory, 'registry.json')),
      game.tracePath,
    )
    const traceJson = await readFile(tracePath, 'utf8')
    const derived = await deriveGameFromTrace({
      registry,
      traceJson,
      tracePath: game.tracePath,
      pilot: experimentDirectory.replace(/\\/g, '/').split('/').includes('pilot'),
      input: {
        schema: 'HumanExperimentGameInputV1',
        experimentId: game.experimentId,
        participantId: game.participantId,
        gameNumber: game.gameNumber,
        gameId: game.gameId,
        traceId: game.traceId,
        startedAt: game.startedAt,
        finishedAt: game.finishedAt,
        durationMs: game.durationMs,
        terminalReason: game.terminalReason,
        traceSha256: game.traceSha256,
        effectiveConfigSha256: game.effectiveConfigSha256,
        sourceCommit: game.sourceCommit,
        sourceVersion: game.sourceVersion,
        recordedAt: game.recordedAt,
        incidents: game.incidents,
      },
    })
    if (canonicalStringify(derived) !== canonicalStringify(game))
      throw new Error(`Stored game differs from trace: ${game.gameId}`)
  }),
)
console.log(
  `Valid registry: ${registry.participants.length} participants, ${registry.games.length} games`,
)
