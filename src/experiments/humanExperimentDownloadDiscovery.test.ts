import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HumanExperimentError } from './humanExperimentErrors'
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

  it('gives up instead of looping when the file never stabilizes', async () => {
    // `io` inyectado: cada `stat` devuelve una firma distinta, así que el archivo nunca se
    // estabiliza. Sin límite esto giraba para siempre y, con intervalMs 0, al 100 % de CPU.
    let calls = 0
    const io = {
      stat: (async () => {
        calls += 1
        return { size: calls, mtimeMs: calls, isFile: () => true, isDirectory: () => false }
      }) as unknown as typeof stat,
      readFile: (async () => '{"schema":"HumanMCTSTraceV1"}') as unknown as typeof readFile,
    }
    await expect(
      readStableFile('never-stable.json', {
        stableObservations: 3,
        intervalMs: 0,
        maxAttempts: 5,
        io,
      }),
    ).rejects.toThrow('seguía cambiando')
    expect(calls).toBeLessThanOrEqual(6)
  })

  it('classifies an exhausted wait as FILE_STILL_WRITING', async () => {
    let calls = 0
    const io = {
      stat: (async () => {
        calls += 1
        return { size: calls, mtimeMs: calls, isFile: () => true, isDirectory: () => false }
      }) as unknown as typeof stat,
      readFile: (async () => '{}') as unknown as typeof readFile,
    }
    try {
      await readStableFile('never-stable.json', { stableObservations: 2, maxAttempts: 3, io })
      expect.unreachable('the wait should have been exhausted')
    } catch (error) {
      expect(error).toBeInstanceOf(HumanExperimentError)
      expect((error as HumanExperimentError).code).toBe('FILE_STILL_WRITING')
      expect((error as HumanExperimentError).retry).toBe('recoverable')
    }
  })

  it('stops waiting once the time limit is reached', async () => {
    let clock = 0
    const io = {
      stat: (async () => {
        clock += 1
        return { size: clock, mtimeMs: clock, isFile: () => true, isDirectory: () => false }
      }) as unknown as typeof stat,
      readFile: (async () => '{}') as unknown as typeof readFile,
    }
    await expect(
      readStableFile('never-stable.json', {
        stableObservations: 3,
        timeoutMs: 10,
        maxAttempts: 1_000,
        io,
        now: () => clock * 5,
      }),
    ).rejects.toThrow('seguía cambiando')
  })

  it('reports why a trace-shaped file was rejected', async () => {
    const path = await directory()
    await writeFile(resolve(path, 'traza_humano_mcts_rejected.json'), JSON.stringify(trace))
    const result = await discoverHumanMCTSTraces({
      directories: [path],
      accept: async () => {
        throw new HumanExperimentError(
          'COMMIT_MISMATCH',
          'Trace projectCommit does not match the expected runtime',
        )
      },
    })
    expect(result.candidates).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].code).toBe('COMMIT_MISMATCH')
    expect(result.rejected[0].reason).toContain('projectCommit')
  })

  it('reports an incomplete trace but stays silent about unrelated JSON', async () => {
    const path = await directory()
    await Promise.all([
      // Dice ser una traza pero le faltan piezas: interesa verlo.
      writeFile(
        resolve(path, 'incomplete.json'),
        JSON.stringify({ schema: 'HumanMCTSTraceV1', schemaVersion: 1 }),
      ),
      // JSON corriente de la carpeta de descargas: no es asunto del experimento.
      writeFile(resolve(path, 'unrelated.json'), JSON.stringify({ schema: 'Other' })),
      writeFile(resolve(path, 'broken.json'), '{'),
    ])
    const result = await discoverHumanMCTSTraces({ directories: [path] })
    expect(result.candidates).toHaveLength(0)
    const paths = result.rejected.map((rejection) => rejection.path)
    expect(paths.some((value) => value.endsWith('incomplete.json'))).toBe(true)
    expect(paths.some((value) => value.endsWith('unrelated.json'))).toBe(false)
    expect(result.rejected.every((rejection) => rejection.code === 'JSON_INCOMPLETE')).toBe(true)
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
