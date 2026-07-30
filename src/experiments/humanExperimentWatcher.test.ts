import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IngestionSummary } from './humanExperimentIngestion'
import type { HumanExperimentRegistry } from './humanExperimentTypes'
import { HumanExperimentWatcher, nextPendingHumanExperimentGame } from './humanExperimentWatcher'

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
      .mockRejectedValueOnce(new Error('No compatible trace found'))
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
    expect(await readdir(resolve(paths.root, 'quarantine'))).toHaveLength(1)
    await writeFile(resolve(paths.downloads, 'traza_humano_mcts_good.json'), '{"good":true}')
    await watcher.scanOnce()
    expect(ingest).toHaveBeenCalledTimes(2)
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
