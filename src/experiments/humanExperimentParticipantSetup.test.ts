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
      run: (_command: string, args: string[]) => (args[0] === 'rev-parse' ? `${commit}\n` : ''),
      spawnProcess,
      platform: 'win32',
      environment: {
        PATH: 'test',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        VITE_SECURED_TERRITORY_POLICY: 'true',
        SECURED_TERRITORY_POLICY: 'true',
      },
      argv: ['diagnostic', 'B'],
    })
    expect(result.commit).toBe(commit)
    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'npm run dev'],
      expect.objectContaining({ env: expect.objectContaining({ VITE_GIT_COMMIT: commit }) }),
    )
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    const spawnCall = spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string | undefined> },
    ]
    const spawnedEnvironment = spawnCall[2].env
    expect(spawnedEnvironment.VITE_SECURED_TERRITORY_POLICY).toBeUndefined()
    expect(spawnedEnvironment.SECURED_TERRITORY_POLICY).toBeUndefined()
    child.emit('exit', 0, null)
  })

  it('accepts the binding commit and later commits with only operational data changes', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    const implementation = 'a'.repeat(40)
    const binding = 'b'.repeat(40)
    const metadata = {
      aiPolicy: { securedTerritoryPolicy: false },
      codeFreeze: {
        status: 'frozen',
        implementationCommit: implementation,
        experimentPreparationCommit: implementation,
      },
    }
    const git = {
      commitExists: () => true,
      isAncestor: () => true,
      ancestryPath: () => [binding],
      commitParents: () => [implementation],
      changedPathsInCommit: () => [module.CODE_FREEZE_METADATA_PATH],
      fileAtCommit: () => JSON.stringify(metadata),
      changedPaths: () => [],
    }
    expect(module.validateOfficialCodeFreeze(metadata, binding, git)).toEqual({
      ...metadata.codeFreeze,
      codeFreezeBindingCommit: binding,
    })
    for (const path of [
      'data/human-experiment/final-2026-v3/registry.json',
      'data/human-experiment/final-2026-v3/metadata.json',
      'data/human-experiment/final-2026-v3/participants/P01/participant.json',
    ]) {
      expect(() =>
        module.validateOfficialCodeFreeze(metadata, 'e'.repeat(40), {
          ...git,
          changedPaths: () => [path],
        }),
      ).not.toThrow()
    }
  })

  it('accepts every explicitly allowed operational path and rejects nearby paths', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    for (const path of [
      'data/human-experiment/final-2026-v3/registry.json',
      'data/human-experiment/final-2026-v3/metadata.json',
      'data/human-experiment/final-2026-v3/participants/P08/participant.json',
      'data/human-experiment/final-2026-v3/participants/P01/game-1.json',
      'data/human-experiment/final-2026-v3/participants/P01/game-2.json',
      'data/human-experiment/final-2026-v3/participants/P01/traces/game-1.json',
      'data/human-experiment/final-2026-v3/participants/P01/auxiliary/game-2/notes.json',
      'data/human-experiment/final-2026-v3/participants/P01/checklist.md',
      'src/experiments/humanExperimentIngestion.ts',
      'src/experiments/humanExperimentTransaction.ts',
      'src/experiments/humanExperimentWatcher.ts',
      'scripts/start-human-experiment.mjs',
    ])
      expect(module.isAllowedOperationalExperimentPath(path)).toBe(true)
    for (const path of [
      'data/human-experiment/final-2026-v3/README.md',
      'data/human-experiment/final-2026-v3/commands.md',
      'data/human-experiment/final-2026-v3/participants/P09/participant.json',
      'data/other/registry.json',
    ])
      expect(module.isAllowedOperationalExperimentPath(path)).toBe(false)
  })

  it('accepts the complete ingestion infrastructure and data set in a post-freeze commit', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    const implementation = 'a'.repeat(40)
    const binding = 'b'.repeat(40)
    const metadata = {
      aiPolicy: { securedTerritoryPolicy: false },
      codeFreeze: {
        status: 'frozen',
        implementationCommit: implementation,
        experimentPreparationCommit: implementation,
      },
    }
    expect(() =>
      module.validateOfficialCodeFreeze(metadata, 'e'.repeat(40), {
        commitExists: () => true,
        isAncestor: () => true,
        ancestryPath: () => [binding],
        commitParents: () => [implementation],
        changedPathsInCommit: () => [module.CODE_FREEZE_METADATA_PATH],
        fileAtCommit: () => JSON.stringify(metadata),
        changedPaths: () => [
          'scripts/start-human-experiment.mjs',
          'src/experiments/humanExperimentIngestion.ts',
          'src/experiments/humanExperimentTransaction.ts',
          'src/experiments/humanExperimentWatcher.ts',
          'src/experiments/humanExperimentIngestion.test.ts',
          'src/experiments/humanExperimentParticipantSetup.test.ts',
          'src/training/validateHumanExperimentV3.test.ts',
          'data/human-experiment/final-2026-v3/metadata.json',
          'data/human-experiment/final-2026-v3/registry.json',
          'data/human-experiment/final-2026-v3/participants/P01/game-1.json',
          'data/human-experiment/final-2026-v3/participants/P01/traces/game-1.json',
        ],
      }),
    ).not.toThrow()
  })

  it('derives a non-circular binding and requires it to change only metadata', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    const implementation = 'a'.repeat(40)
    const binding = 'b'.repeat(40)
    const metadata = {
      aiPolicy: { securedTerritoryPolicy: false },
      codeFreeze: {
        status: 'frozen',
        implementationCommit: implementation,
        experimentPreparationCommit: implementation,
      },
    }
    const git = {
      commitExists: () => true,
      isAncestor: () => true,
      ancestryPath: () => [binding],
      commitParents: () => [implementation],
      changedPathsInCommit: () => [module.CODE_FREEZE_METADATA_PATH, 'src/components/Game.tsx'],
      changedPaths: () => [],
    }
    expect(() => module.validateOfficialCodeFreeze(metadata, binding, git)).toThrow(
      'must modify only metadata.json',
    )
    expect(() =>
      module.validateOfficialCodeFreeze(metadata, binding, {
        ...git,
        changedPathsInCommit: () => [module.CODE_FREEZE_METADATA_PATH],
        fileAtCommit: () =>
          JSON.stringify({
            ...metadata,
            codeFreeze: { ...metadata.codeFreeze, status: 'draft' },
          }),
      }),
    ).toThrow('does not match')
  })

  it('permanently blocks V3 official sessions before starting any process', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    const runtime = 'ee39b9b888bc0d31a7ce8ef08b9d64f9bb1c1da6'
    const implementation = 'a'.repeat(40)
    const binding = 'b'.repeat(40)
    const children: Array<EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn> }> = []
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        killed: boolean
        kill: ReturnType<typeof vi.fn>
      }
      child.killed = false
      child.kill = vi.fn()
      children.push(child)
      return child
    })
    const metadata = {
      experimentId: module.CURRENT_EXPERIMENT_ID,
      aiPolicy: { securedTerritoryPolicy: false },
      codeFreeze: {
        status: 'frozen',
        implementationCommit: implementation,
        experimentPreparationCommit: implementation,
      },
    }
    const registry = {
      experimentId: module.CURRENT_EXPERIMENT_ID,
      participants: [{ participantId: 'P01', colorOrder: ['R', 'B'] }],
      games: [],
    }
    expect(() =>
      module.startHumanExperimentServer({
        run: (_command: string, args: string[]) => {
          if (args[0] === 'rev-parse') return runtime
          if (args[0] === 'status') return ''
          if (args[0] === 'rev-list') return `${binding}\n${runtime}`
          if (args[0] === 'show' && args[1] === '-s') return implementation
          if (args[0] === 'show') return JSON.stringify(metadata)
          if (args[0] === 'diff-tree') return module.CODE_FREEZE_METADATA_PATH
          if (args[0] === 'diff') return ''
          return ''
        },
        read: (path: string) =>
          path.endsWith('metadata.json') ? JSON.stringify(metadata) : JSON.stringify(registry),
        spawnProcess,
        platform: 'linux',
        environment: {},
        argv: ['official', 'P01', '1'],
      }),
    ).toThrow('archived and closed permanently')
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(children).toHaveLength(0)
  })

  it.each(['src/components/Game.tsx'])('rejects post-freeze functional change %s', async (path) => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    const implementation = 'a'.repeat(40)
    const binding = 'b'.repeat(40)
    const metadata = {
      aiPolicy: { securedTerritoryPolicy: false },
      codeFreeze: {
        status: 'frozen',
        implementationCommit: implementation,
        experimentPreparationCommit: implementation,
      },
    }
    expect(() =>
      module.validateOfficialCodeFreeze(metadata, 'e'.repeat(40), {
        commitExists: () => true,
        isAncestor: () => true,
        ancestryPath: () => [binding],
        commitParents: () => [implementation],
        changedPathsInCommit: () => [module.CODE_FREEZE_METADATA_PATH],
        changedPaths: () => [path],
      }),
    ).toThrow('Functional files changed')
  })

  it('rejects non-descendants, dirty trees, and missing or incorrect frozen hashes', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    const implementation = 'a'.repeat(40)
    const binding = 'b'.repeat(40)
    const metadata = {
      aiPolicy: { securedTerritoryPolicy: false },
      codeFreeze: {
        status: 'frozen',
        implementationCommit: implementation,
        experimentPreparationCommit: implementation,
      },
    }
    expect(() =>
      module.validateOfficialCodeFreeze(metadata, 'e'.repeat(40), {
        commitExists: () => true,
        isAncestor: () => false,
        ancestryPath: () => [binding],
        commitParents: () => [implementation],
        changedPathsInCommit: () => [module.CODE_FREEZE_METADATA_PATH],
        changedPaths: () => [],
      }),
    ).toThrow('does not descend')
    expect(() =>
      module.validateOfficialCodeFreeze(metadata, 'e'.repeat(40), {
        commitExists: () => false,
        isAncestor: () => true,
        ancestryPath: () => [binding],
        commitParents: () => [implementation],
        changedPathsInCommit: () => [module.CODE_FREEZE_METADATA_PATH],
        changedPaths: () => [],
      }),
    ).toThrow('does not exist')
    expect(() =>
      module.validateOfficialCodeFreeze(
        {
          ...metadata,
          codeFreeze: { ...metadata.codeFreeze, implementationCommit: 'f'.repeat(40) },
        },
        'e'.repeat(40),
      ),
    ).toThrow('must match')
    expect(() =>
      module.assertCleanWorktree((_command: string, args: string[]) =>
        args[0] === 'status' ? ' M registry.json' : '',
      ),
    ).toThrow('cambios sin commit')
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

  it('refuses to start an experiment from a dirty worktree', async () => {
    // @ts-expect-error The runtime script intentionally has no declaration file.
    const module = await import('../../scripts/start-human-experiment.mjs')
    expect(() =>
      module.startHumanExperimentServer({
        run: (_command: string, args: string[]) =>
          args[0] === 'rev-parse' ? 'a'.repeat(40) : ' M src/example.ts',
        spawnProcess: vi.fn(),
      }),
    ).toThrow('cambios sin commit')
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
      run: (_command: string, args: string[]) => (args[0] === 'rev-parse' ? 'a'.repeat(40) : ''),
      spawnProcess: () => child,
      argv: ['diagnostic', 'B'],
    })
    interrupt?.('SIGINT')
    expect(child.kill).toHaveBeenCalledWith('SIGINT')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})
