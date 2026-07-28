import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HumanExperimentRegistry } from './humanExperimentTypes'
import {
  setupHumanExperimentParticipant,
  validateSetupValues,
} from './humanExperimentParticipantSetup'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

async function setupFixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'wgtr-setup-'))
  temporaryDirectories.push(root)
  const participantDirectory = resolve(root, 'participants', 'P02')
  await mkdir(participantDirectory, { recursive: true })
  await writeFile(
    resolve(root, 'registry.json'),
    JSON.stringify({
      schema: 'HumanExperimentRegistryV1',
      experimentId: 'WGTR-HUMAN-FINAL-2026',
      participants: [],
      games: [],
    }),
  )
  await writeFile(
    resolve(participantDirectory, 'participant.json'),
    JSON.stringify({
      schema: 'HumanExperimentParticipantV1',
      experimentId: 'WGTR-HUMAN-FINAL-2026',
      participantId: 'P02',
      experienceGroup: null,
      previousWallGoGames: null,
      practiceGames: 1,
      colorOrder: ['B', 'R'],
      notes: '',
    }),
  )
  return { root, participantPath: resolve(participantDirectory, 'participant.json') }
}

describe('participant setup', () => {
  it('completes and registers a participant while preserving assigned fields', async () => {
    const fixture = await setupFixture()
    const result = await setupHumanExperimentParticipant({
      experimentDirectory: fixture.root,
      participantId: 'P02',
      experienceGroup: 'basic',
      previousWallGoGames: 3,
      notes: 'brief note',
    })
    expect(result.participant).toMatchObject({
      participantId: 'P02',
      practiceGames: 1,
      colorOrder: ['B', 'R'],
      experienceGroup: 'basic',
      previousWallGoGames: 3,
    })
    expect(result.registry.participants).toHaveLength(1)
  })

  it.each([
    ['P09', 'none', 0, 'P01-P08'],
    ['P02', 'invalid', 0, 'experienceGroup'],
    ['P02', 'none', -1, 'non-negative'],
    ['P02', 'basic', 1.5, 'non-negative'],
    ['P02', 'none', 1, 'inconsistent'],
    ['P02', 'basic', 6, 'inconsistent'],
    ['P02', 'experienced', 5, 'inconsistent'],
  ])('rejects invalid setup values', (id, group, games, message) => {
    expect(() => validateSetupValues(id, group, games)).toThrow(message)
  })

  it('rejects a participant already in the registry', async () => {
    const fixture = await setupFixture()
    const params = {
      experimentDirectory: fixture.root,
      participantId: 'P02',
      experienceGroup: 'basic',
      previousWallGoGames: 3,
    }
    await setupHumanExperimentParticipant(params)
    await expect(setupHumanExperimentParticipant(params)).rejects.toThrow('already registered')
  })

  it('rolls the registry back if template writing fails', async () => {
    const fixture = await setupFixture()
    const registryPath = resolve(fixture.root, 'registry.json')
    const originalRegistry = await readFile(registryPath, 'utf8')
    const originalParticipant = await readFile(fixture.participantPath, 'utf8')
    await expect(
      setupHumanExperimentParticipant({
        experimentDirectory: fixture.root,
        participantId: 'P02',
        experienceGroup: 'basic',
        previousWallGoGames: 3,
        hooks: {
          beforeParticipantRename: () => {
            throw new Error('simulated participant failure')
          },
        },
      }),
    ).rejects.toThrow('simulated')
    expect(
      (JSON.parse(await readFile(registryPath, 'utf8')) as HumanExperimentRegistry).participants,
    ).toEqual([])
    expect(await readFile(fixture.participantPath, 'utf8')).toBe(originalParticipant)
    expect(originalRegistry).toContain('"participants":[]')
  })
})

describe('human experiment start script', () => {
  it('gets a full commit and passes it to the child process', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean
      kill: (signal: string) => void
    }
    child.killed = false
    child.kill = vi.fn()
    const spawnProcess = vi.fn(() => child)
    const commit = 'a'.repeat(40)
    const result = module.startHumanExperimentServer({
      run: () => `${commit}\n`,
      spawnProcess,
      platform: 'win32',
      environment: { PATH: 'test', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    })
    expect(result.commit).toBe(commit)
    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'npm run dev'],
      expect.objectContaining({ env: expect.objectContaining({ VITE_GIT_COMMIT: commit }) }),
    )
    expect(spawnProcess).toHaveBeenCalledTimes(2)
    child.emit('exit', 0, null)
  })

  it('rejects invalid hashes and unavailable Git', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    expect(() => module.getGitCommit(() => 'short')).toThrow('Unable to determine')
    expect(() =>
      module.getGitCommit(() => {
        throw new Error('git unavailable')
      }),
    ).toThrow('git unavailable')
  })

  it('resolves the Vite command for Windows, Linux, and macOS', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    expect(module.resolveDevCommand('win32', { ComSpec: 'C:\\Windows\\cmd.exe' })).toEqual({
      command: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm run dev'],
    })
    expect(module.resolveDevCommand('linux', {})).toEqual({
      command: 'npm',
      args: ['run', 'dev'],
    })
    expect(module.resolveDevCommand('darwin', {})).toEqual({
      command: 'npm',
      args: ['run', 'dev'],
    })
    expect(() => module.resolveDevCommand('win32', {})).toThrow('ComSpec')
  })

  it('forwards shutdown signals to the Vite child', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    let interrupt: ((signal: string) => void) | undefined
    vi.spyOn(process, 'once').mockImplementation((event, listener) => {
      if (event === 'SIGINT') interrupt = listener as (signal: string) => void
      return process
    })
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean
      kill: ReturnType<typeof vi.fn>
    }
    child.killed = false
    child.kill = vi.fn()
    module.startHumanExperimentServer({
      run: () => 'a'.repeat(40),
      spawnProcess: () => child,
    })
    interrupt?.('SIGINT')
    expect(child.kill).toHaveBeenCalledWith('SIGINT')
    expect(child.kill).toHaveBeenCalledTimes(2)
  })
})
