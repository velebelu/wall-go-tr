import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HumanExperimentError } from './humanExperimentErrors'
import type { IngestionSummary } from './humanExperimentIngestion'
import type { HumanExperimentRegistry } from './humanExperimentTypes'
import { HumanExperimentWatcher, nextPendingHumanExperimentGame } from './humanExperimentWatcher'
import {
  captureTransitionMismatch,
  prepareTransitionMismatchArtifact,
} from './humanExperimentTransitionDiagnostics'
import { makeInitialState } from '@/store/gameState'
import { applyRecordedPlayerAction } from './atomicPlayerTransition'

const temporaryDirectories: string[] = []
const COMMIT = 'a'.repeat(40)

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

function registry(games: HumanExperimentRegistry['games'] = []): HumanExperimentRegistry {
  return {
    schema: 'HumanExperimentRegistryV1',
    experimentId: 'WGTR-HUMAN-FINAL-2026',
    participants: [
      {
        schema: 'HumanExperimentParticipantV1',
        experimentId: 'WGTR-HUMAN-FINAL-2026',
        participantId: 'P01',
        experienceGroup: 'none',
        previousWallGoGames: 0,
        practiceGames: 1,
        colorOrder: ['R', 'B'],
      },
      {
        schema: 'HumanExperimentParticipantV1',
        experimentId: 'WGTR-HUMAN-FINAL-2026',
        participantId: 'P02',
        experienceGroup: 'none',
        previousWallGoGames: 0,
        practiceGames: 1,
        colorOrder: ['B', 'R'],
      },
    ],
    games,
  }
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'wgtr watcher windows spaces-'))
  temporaryDirectories.push(root)
  const downloads = resolve(root, 'ARCHIVOS ERIC', 'Descargas')
  await mkdir(downloads, { recursive: true })
  await writeFile(resolve(root, 'registry.json'), JSON.stringify(registry()))
  return { root, downloads }
}

function result(): IngestionSummary {
  return {
    participantId: 'P01',
    gameNumber: 1,
    source: 'source',
    destination: 'destination',
    humanColor: 'R',
    aiColor: 'B',
    winner: 'human',
    humanTerritory: 20,
    aiTerritory: 10,
    turnCount: 12,
    durationMs: 1000,
    participantCount: 2,
    gameCount: 1,
  }
}

describe('human experiment watcher', () => {
  it('detects the next pending game and the AI menu button', () => {
    expect(nextPendingHumanExperimentGame(registry())).toEqual({
      participantId: 'P01',
      gameNumber: 1,
      humanColor: 'R',
      aiColor: 'B',
      menuButton: 'Azul',
    })
  })

  it('detects P02 game 2 from the current registration sequence', () => {
    const games = [
      { participantId: 'P01', gameNumber: 1 },
      { participantId: 'P01', gameNumber: 2 },
      { participantId: 'P02', gameNumber: 1 },
    ] as HumanExperimentRegistry['games']
    expect(nextPendingHumanExperimentGame(registry(games))).toEqual({
      participantId: 'P02',
      gameNumber: 2,
      humanColor: 'R',
      aiColor: 'B',
      menuButton: 'Azul',
    })
  })

  it('ignores old files, detects a new file once, and supports Windows paths with spaces', async () => {
    const paths = await fixture()
    await writeFile(resolve(paths.downloads, 'traza_humano_mcts_old.json'), '{}')
    const ingest = vi.fn(async () => result())
    const watcher = new HumanExperimentWatcher({
      experimentDirectory: paths.root,
      downloadDirectory: paths.downloads,
      expectedCommit: COMMIT,
      pollIntervalMs: 60_000,
      stabilityIntervalMs: 1,
      logger: { log: vi.fn(), error: vi.fn() },
      ingest,
    })
    await watcher.start()
    expect(ingest).not.toHaveBeenCalled()
    const fresh = resolve(paths.downloads, 'traza_humano_mcts_new.json')
    await writeFile(fresh, '{}')
    await watcher.scanOnce()
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ explicitTracePath: fresh }))
    await watcher.scanOnce()
    expect(ingest).toHaveBeenCalledTimes(1)
    watcher.close()
  })

  it('reports an incompatible trace and continues watching', async () => {
    const paths = await fixture()
    const logger = { log: vi.fn(), error: vi.fn() }
    const ingest = vi
      .fn()
      .mockRejectedValueOnce(new HumanExperimentError('INVALID_TRACE', 'No compatible trace found'))
      .mockResolvedValueOnce(result())
    const watcher = new HumanExperimentWatcher({
      experimentDirectory: paths.root,
      downloadDirectory: paths.downloads,
      expectedCommit: COMMIT,
      pollIntervalMs: 60_000,
      stabilityIntervalMs: 1,
      logger,
      ingest,
    })
    await watcher.start()
    await writeFile(resolve(paths.downloads, 'traza_humano_mcts_bad.json'), '{"bad":true}')
    await watcher.scanOnce()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('No compatible trace found'))
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('INVALID_TRACE (final)'))
    expect(await readdir(resolve(paths.root, 'quarantine'))).toHaveLength(1)
    await writeFile(resolve(paths.downloads, 'traza_humano_mcts_good.json'), '{"good":true}')
    await watcher.scanOnce()
    expect(ingest).toHaveBeenCalledTimes(2)
    watcher.close()
  })

  it('archives a transition diagnostic without invoking ingestion or modifying the registry', async () => {
    const paths = await fixture()
    const invalidSessions = resolve(paths.root, 'invalid-sessions')
    const ingest = vi.fn(async () => result())
    const logger = { log: vi.fn(), error: vi.fn() }
    const watcher = new HumanExperimentWatcher({
      experimentDirectory: paths.root,
      downloadDirectory: paths.downloads,
      expectedCommit: COMMIT,
      pollIntervalMs: 60_000,
      stabilityIntervalMs: 1,
      invalidSessionDirectory: invalidSessions,
      logger,
      ingest,
    })
    await watcher.start()
    const registryBefore = await readFile(resolve(paths.root, 'registry.json'), 'utf8')
    const stateBefore = makeInitialState()
    const expectedState = applyRecordedPlayerAction(stateBefore, {
      type: 'place',
      pos: { x: 0, y: 0 },
    })
    const prepared = await prepareTransitionMismatchArtifact(
      captureTransitionMismatch({
        stateBefore,
        action: { type: 'place', pos: { x: 0, y: 0 } },
        expectedState,
        committedState: stateBefore,
        capturedAt: '2026-07-30T00:00:00.000Z',
      }),
    )
    await writeFile(resolve(paths.downloads, prepared.fileName), prepared.json)

    await watcher.scanOnce()
    watcher.close()

    expect(ingest).not.toHaveBeenCalled()
    expect(await readFile(resolve(paths.root, 'registry.json'), 'utf8')).toBe(registryBefore)
    expect(await readdir(resolve(paths.root, 'quarantine'))).toHaveLength(1)
    expect(await readdir(invalidSessions)).toHaveLength(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Sesión inválida archivada sin ingesta oficial'),
    )
  })

  it('reports an already registered content instead of ingesting it twice', async () => {
    const paths = await fixture()
    const logger = { log: vi.fn(), error: vi.fn() }
    const ingest = vi.fn(async () => result())
    const watcher = new HumanExperimentWatcher({
      experimentDirectory: paths.root,
      downloadDirectory: paths.downloads,
      expectedCommit: COMMIT,
      pollIntervalMs: 60_000,
      stabilityIntervalMs: 1,
      logger,
      ingest,
    })
    await watcher.start()
    const file = resolve(paths.downloads, 'traza_humano_mcts_repeat.json')
    await writeFile(file, '{"same":true}')
    await watcher.scanOnce()
    // Misma partida descargada de nuevo: se avisa y no se vuelve a ingerir.
    await writeFile(resolve(paths.downloads, 'traza_humano_mcts_repeat_copy.json'), '{"same":true}')
    await watcher.scanOnce()
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('ya registrada como P01-1'))
    watcher.close()
  })

  it('does not retry a final rejection but says so out loud', async () => {
    const paths = await fixture()
    const logger = { log: vi.fn(), error: vi.fn() }
    const ingest = vi
      .fn()
      .mockRejectedValue(new HumanExperimentError('COMMIT_MISMATCH', 'commit distinto'))
    const watcher = new HumanExperimentWatcher({
      experimentDirectory: paths.root,
      downloadDirectory: paths.downloads,
      expectedCommit: COMMIT,
      pollIntervalMs: 60_000,
      stabilityIntervalMs: 1,
      logger,
      ingest,
    })
    await watcher.start()
    const file = resolve(paths.downloads, 'traza_humano_mcts_commit.json')
    await writeFile(file, '{"commit":"wrong"}')
    await watcher.scanOnce()
    await writeFile(
      resolve(paths.downloads, 'traza_humano_mcts_commit_again.json'),
      '{"commit":"wrong"}',
    )
    await watcher.scanOnce()
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('No se reintenta: descargue una traza nueva'),
    )
    watcher.close()
  })

  it('retries a recoverable failure up to the limit without quarantining it early', async () => {
    const paths = await fixture()
    const logger = { log: vi.fn(), error: vi.fn() }
    const ingest = vi
      .fn()
      .mockRejectedValue(new HumanExperimentError('TRANSACTION_IO_FAILURE', 'disco ocupado'))
    const watcher = new HumanExperimentWatcher({
      experimentDirectory: paths.root,
      downloadDirectory: paths.downloads,
      expectedCommit: COMMIT,
      pollIntervalMs: 60_000,
      stabilityIntervalMs: 1,
      logger,
      ingest,
    })
    await watcher.start()
    const contents = '{"io":"failure"}'
    for (const name of ['one', 'two', 'three', 'four', 'five']) {
      await writeFile(resolve(paths.downloads, `traza_humano_mcts_${name}.json`), contents)
      await watcher.scanOnce()
    }
    // Tres intentos como máximo, aunque el mismo contenido reaparezca cinco veces.
    expect(ingest).toHaveBeenCalledTimes(3)
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Reintento 2/3'))
    expect(await readdir(resolve(paths.root, 'quarantine'))).toHaveLength(1)
    watcher.close()
  })

  it('recovers a pending transaction when it starts', async () => {
    const paths = await fixture()
    const transaction = resolve(paths.root, '.ingestion-transaction')
    await mkdir(resolve(transaction, 'backups'), { recursive: true })
    const original = await readFile(resolve(paths.root, 'registry.json'), 'utf8')
    await writeFile(resolve(transaction, 'backups', 'registry.json'), original)
    await writeFile(resolve(paths.root, 'registry.json'), '{"partial":true}')
    await writeFile(
      resolve(transaction, 'manifest.json'),
      JSON.stringify({
        schema: 'HumanExperimentIngestionTransactionV1',
        state: 'prepared',
        targets: [{ relativePath: 'registry.json', existed: true }],
      }),
    )
    const watcher = new HumanExperimentWatcher({
      experimentDirectory: paths.root,
      downloadDirectory: paths.downloads,
      expectedCommit: COMMIT,
      pollIntervalMs: 60_000,
      logger: { log: vi.fn(), error: vi.fn() },
      ingest: vi.fn(async () => result()),
    })
    await watcher.start()
    expect(await readFile(resolve(paths.root, 'registry.json'), 'utf8')).toBe(original)
    watcher.close()
  })

  it('stops scanning after close', async () => {
    const paths = await fixture()
    const ingest = vi.fn(async () => result())
    const watcher = new HumanExperimentWatcher({
      experimentDirectory: paths.root,
      downloadDirectory: paths.downloads,
      expectedCommit: COMMIT,
      pollIntervalMs: 60_000,
      stabilityIntervalMs: 1,
      logger: { log: vi.fn(), error: vi.fn() },
      ingest,
    })
    await watcher.start()
    watcher.close()
    await writeFile(resolve(paths.downloads, 'traza_humano_mcts_late.json'), '{}')
    await watcher.scanOnce()
    expect(ingest).not.toHaveBeenCalled()
  })

  it('deduplicates a second filesystem event and a second path with identical content', async () => {
    const paths = await fixture()
    const ingest = vi.fn(async () => result())
    const watcher = new HumanExperimentWatcher({
      experimentDirectory: paths.root,
      downloadDirectory: paths.downloads,
      expectedCommit: COMMIT,
      pollIntervalMs: 60_000,
      stabilityIntervalMs: 1,
      logger: { log: vi.fn(), error: vi.fn() },
      ingest,
    })
    await watcher.start()
    const contents = '{"same":"content"}'
    const first = resolve(paths.downloads, 'traza_humano_mcts_first.json')
    await writeFile(first, contents)
    await watcher.scanOnce()
    await writeFile(first, contents)
    await watcher.scanOnce()
    await writeFile(resolve(paths.downloads, 'traza_humano_mcts_copy.json'), contents)
    await watcher.scanOnce()

    expect(ingest).toHaveBeenCalledTimes(1)
    watcher.close()
  })

  it('runs the complete watcher and real ingestion flow only inside temporary directories', async () => {
    const paths = await fixture()
    const experimentId = 'WGTR-HUMAN-FINAL-2026-V2'
    const participantDirectory = resolve(paths.root, 'participants', 'P01')
    await mkdir(resolve(participantDirectory, 'traces'), { recursive: true })
    const isolatedRegistry = registry()
    isolatedRegistry.experimentId = experimentId
    isolatedRegistry.participants = [{ ...isolatedRegistry.participants[0], experimentId }]
    await writeFile(resolve(paths.root, 'registry.json'), JSON.stringify(isolatedRegistry))
    await writeFile(
      resolve(paths.root, 'metadata.json'),
      JSON.stringify({
        schema: 'HumanExperimentMetadataV2',
        experimentId,
        gameCount: 0,
      }),
    )
    await writeFile(
      resolve(participantDirectory, 'game-1.json'),
      JSON.stringify({
        schema: 'HumanExperimentGameInputV1',
        experimentId,
        participantId: 'P01',
        gameNumber: 1,
        incidents: [],
      }),
    )

    const archivedTracePath = resolve(
      'data',
      'human-experiment',
      'invalidated-2026-pre-wall-fix',
      'participants',
      'P01',
      'traces',
      'game-1.json',
    )
    const trace = JSON.parse(await readFile(archivedTracePath, 'utf8')) as {
      metadata: {
        experimentId?: string
        participantId?: string
        gameNumber?: number
        sessionType?: string
        sessionId?: string
        projectCommit: string
        runtimeCommit?: string
        implementationCommit?: string
        experimentPreparationCommit?: string
        codeFreezeBindingCommit?: string
      }
    }
    trace.metadata.experimentId = experimentId
    trace.metadata.participantId = 'P01'
    trace.metadata.gameNumber = 1
    trace.metadata.sessionType = 'official'
    trace.metadata.sessionId = 'watcher-integration'
    trace.metadata.runtimeCommit = trace.metadata.projectCommit
    trace.metadata.implementationCommit = '8a3e866635f4af9b9fbef28f4c40d5ebff6b4e0c'
    trace.metadata.experimentPreparationCommit = '526a210087eed3cbb36491b9469fa62e93f47d75'
    trace.metadata.codeFreezeBindingCommit = '0f3caea4d1ea1ebf500c2475959ae301d51dbeb6'
    const logger = { log: vi.fn(), error: vi.fn() }
    const watcher = new HumanExperimentWatcher({
      experimentDirectory: paths.root,
      downloadDirectory: paths.downloads,
      expectedCommit: trace.metadata.projectCommit,
      pollIntervalMs: 60_000,
      stabilityIntervalMs: 1,
      logger,
    })
    await watcher.start()
    await writeFile(
      resolve(paths.downloads, 'traza_humano_mcts_temporary_integration.json'),
      JSON.stringify(trace),
    )
    await watcher.scanOnce()
    watcher.close()

    const updated = JSON.parse(
      await readFile(resolve(paths.root, 'registry.json'), 'utf8'),
    ) as HumanExperimentRegistry
    expect(updated.games).toHaveLength(1)
    expect(updated.games[0]).toMatchObject({ participantId: 'P01', gameNumber: 1 })
    expect(logger.error).not.toHaveBeenCalled()
  })
})
