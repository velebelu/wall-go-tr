import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerGameFromFiles, registerParticipantFromFiles } from './humanExperimentRegistration'
import type { HumanExperimentParticipant, HumanExperimentRegistry } from './humanExperimentTypes'

const temporaryDirectories: string[] = []
const experimentId = 'TEST-EXPERIMENT'
const participant: HumanExperimentParticipant = {
  schema: 'HumanExperimentParticipantV1',
  experimentId,
  participantId: 'P01',
  experienceGroup: 'none',
  previousWallGoGames: 0,
  practiceGames: 1,
  colorOrder: ['R', 'B'],
  notes: '',
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

async function fixture(
  params: { registry?: boolean; participant?: HumanExperimentParticipant } = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), 'wgtr-registration-'))
  temporaryDirectories.push(root)
  const participantDirectory = resolve(root, 'participants', 'P01')
  await mkdir(participantDirectory, { recursive: true })
  const participantPath = resolve(participantDirectory, 'participant.json')
  await writeFile(participantPath, JSON.stringify(params.participant ?? participant))
  if (params.registry !== false) {
    const registry: HumanExperimentRegistry = {
      schema: 'HumanExperimentRegistryV1',
      experimentId,
      participants: [],
      games: [],
    }
    await writeFile(resolve(root, 'registry.json'), JSON.stringify(registry))
  }
  return { root, participantDirectory, participantPath }
}

describe('explicit experiment root registration', () => {
  it('registers a participant from a subfolder in the root registry', async () => {
    const paths = await fixture()
    const result = await registerParticipantFromFiles({
      experimentDirectory: paths.root,
      participantJsonPath: paths.participantPath,
    })
    const registry = JSON.parse(
      await readFile(resolve(paths.root, 'registry.json'), 'utf8'),
    ) as HumanExperimentRegistry
    expect(result.registryPath).toBe(resolve(paths.root, 'registry.json'))
    expect(registry.participants.map((entry) => entry.participantId)).toEqual(['P01'])
  })

  it('does not create a registry beside the participant JSON', async () => {
    const paths = await fixture()
    await registerParticipantFromFiles({
      experimentDirectory: paths.root,
      participantJsonPath: paths.participantPath,
    })
    await expect(
      access(resolve(paths.participantDirectory, 'registry.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects an incompatible experimentId without changing the registry', async () => {
    const paths = await fixture({
      participant: { ...participant, experimentId: 'OTHER-EXPERIMENT' },
    })
    const before = await readFile(resolve(paths.root, 'registry.json'), 'utf8')
    await expect(
      registerParticipantFromFiles({
        experimentDirectory: paths.root,
        participantJsonPath: paths.participantPath,
      }),
    ).rejects.toThrow('does not match')
    expect(await readFile(resolve(paths.root, 'registry.json'), 'utf8')).toBe(before)
  })

  it('rejects a nonexistent experiment root', async () => {
    const paths = await fixture()
    await expect(
      registerParticipantFromFiles({
        experimentDirectory: resolve(paths.root, 'missing'),
        participantJsonPath: paths.participantPath,
      }),
    ).rejects.toThrow('directory does not exist')
  })

  it('rejects a missing root registry instead of creating one', async () => {
    const paths = await fixture({ registry: false })
    await expect(
      registerParticipantFromFiles({
        experimentDirectory: paths.root,
        participantJsonPath: paths.participantPath,
      }),
    ).rejects.toThrow('registry does not exist')
    await expect(access(resolve(paths.root, 'registry.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects a duplicate P01', async () => {
    const paths = await fixture()
    const params = {
      experimentDirectory: paths.root,
      participantJsonPath: paths.participantPath,
    }
    await registerParticipantFromFiles(params)
    await expect(registerParticipantFromFiles(params)).rejects.toThrow('Duplicate participantId')
  })

  it('preserves the root registry if atomic writing fails before rename', async () => {
    const paths = await fixture()
    const registryPath = resolve(paths.root, 'registry.json')
    const before = await readFile(registryPath, 'utf8')
    await expect(
      registerParticipantFromFiles({
        experimentDirectory: paths.root,
        participantJsonPath: paths.participantPath,
        hooks: {
          beforeRename: () => {
            throw new Error('simulated atomic failure')
          },
        },
      }),
    ).rejects.toThrow('simulated atomic failure')
    expect(await readFile(registryPath, 'utf8')).toBe(before)
  })

  it('registers a nested game against the explicit root registry', async () => {
    const paths = await fixture()
    await registerParticipantFromFiles({
      experimentDirectory: paths.root,
      participantJsonPath: paths.participantPath,
    })
    const gamePath = resolve(paths.participantDirectory, 'game-1.json')
    const traceDirectory = resolve(paths.participantDirectory, 'traces')
    const tracePath = resolve(traceDirectory, 'game-1.json')
    await mkdir(traceDirectory)
    await writeFile(
      gamePath,
      JSON.stringify({
        schema: 'HumanExperimentGameInputV1',
        experimentId,
        participantId: 'P01',
        gameNumber: 1,
        sourceCommit: '60d45a283e4b6f91af32f307a2bb613ffad76970',
        incidents: [],
      }),
    )
    await copyFile(resolve('data/human-experiment/real-pilot/traces/game-1.json'), tracePath)
    await registerGameFromFiles({
      experimentDirectory: paths.root,
      gameJsonPath: gamePath,
      traceJsonPath: tracePath,
    })
    const registry = JSON.parse(
      await readFile(resolve(paths.root, 'registry.json'), 'utf8'),
    ) as HumanExperimentRegistry
    expect(registry.games).toHaveLength(1)
    await expect(
      access(resolve(paths.participantDirectory, 'registry.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
