import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    await writeFile(resolve(paths.downloads, 'traza_humano_mcts_bad.json'), '{}')
    await watcher.scanOnce()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('No compatible trace found'))
    await writeFile(resolve(paths.downloads, 'traza_humano_mcts_good.json'), '{}')
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
})
