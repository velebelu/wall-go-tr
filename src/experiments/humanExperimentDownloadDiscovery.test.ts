import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverHumanMCTSTraces,
  readStableFile,
  usualDownloadDirectories,
} from './humanExperimentDownloadDiscovery'

const temporaryDirectories: string[] = []
const trace = {
  schema: 'HumanMCTSTraceV1',
  schemaVersion: 1,
  metadata: {},
  decisions: [],
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

async function directory() {
  const path = await mkdtemp(resolve(tmpdir(), 'wgtr-downloads-'))
  temporaryDirectories.push(path)
  return path
}

describe('trace download discovery', () => {
  it('returns zero candidates from an empty directory', async () => {
    const path = await directory()
    expect((await discoverHumanMCTSTraces({ directories: [path] })).candidates).toHaveLength(0)
  })

  it('finds one valid-schema JSON and does not remove it', async () => {
    const path = await directory()
    const file = resolve(path, 'traza_humano_mcts_g_test.json')
    await writeFile(file, JSON.stringify(trace))
    expect((await discoverHumanMCTSTraces({ directories: [path] })).candidates).toHaveLength(1)
    await expect((await import('node:fs/promises')).access(file)).resolves.toBeUndefined()
  })

  it('deduplicates two paths with identical content', async () => {
    const path = await directory()
    await Promise.all([
      writeFile(resolve(path, 'one.json'), JSON.stringify(trace)),
      writeFile(resolve(path, 'two.json'), JSON.stringify(trace)),
    ])
    expect((await discoverHumanMCTSTraces({ directories: [path] })).candidates).toHaveLength(1)
  })

  it('ignores invalid JSON and wrong schemas', async () => {
    const path = await directory()
    await Promise.all([
      writeFile(resolve(path, 'invalid.json'), '{'),
      writeFile(resolve(path, 'wrong.json'), JSON.stringify({ schema: 'Other' })),
    ])
    expect((await discoverHumanMCTSTraces({ directories: [path] })).candidates).toHaveLength(0)
  })

  it('supports an explicit path', async () => {
    const path = await directory()
    const file = resolve(path, 'chosen.json')
    await writeFile(file, JSON.stringify(trace))
    const result = await discoverHumanMCTSTraces({ explicitTracePath: file })
    expect(result.candidates.map((candidate) => candidate.path)).toEqual([file])
  })

  it('waits for a progressively written JSON to become stable', async () => {
    const path = await directory()
    const file = resolve(path, 'progressive.json')
    await writeFile(file, '{"schema":')
    const reading = readStableFile(file, { stableObservations: 3, intervalMs: 5 })
    await new Promise((done) => setTimeout(done, 7))
    await writeFile(file, JSON.stringify(trace))
    const stable = await reading
    expect(JSON.parse(stable.contents)).toEqual(trace)
    expect(stable.signature).toContain(`${Buffer.byteLength(stable.contents)}:`)
    expect(stable.contentSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('honors HUMAN_EXPERIMENT_DOWNLOAD_DIR with a path containing spaces', async () => {
    const root = await directory()
    const downloads = resolve(root, 'ARCHIVOS ERIC', 'Descargas')
    await mkdir(downloads, { recursive: true })
    expect(
      await usualDownloadDirectories({
        HUMAN_EXPERIMENT_DOWNLOAD_DIR: downloads,
      }),
    ).toContain(downloads)
  })
})
