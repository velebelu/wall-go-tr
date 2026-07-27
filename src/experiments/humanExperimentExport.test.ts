import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  atomicWriteJson,
  exportHumanExperiment,
  gamesCsv,
  participantsCsv,
} from './humanExperimentExport'
import type { HumanExperimentRegistry } from './humanExperimentTypes'

const registry = {
  schema: 'HumanExperimentRegistryV1',
  experimentId: 'PILOT',
  participants: [
    {
      schema: 'HumanExperimentParticipantV1',
      experimentId: 'PILOT',
      participantId: 'P1',
      experienceGroup: 'none',
      previousWallGoGames: 0,
      practiceGames: 1,
      colorOrder: ['R', 'B'],
      notes: 'comma, and "quote"',
    },
  ],
  games: [],
} as HumanExperimentRegistry

describe('human experiment export', () => {
  it('escapes CSV and creates one participant row', () => {
    expect(participantsCsv(registry).trim().split('\n')).toHaveLength(2)
    expect(participantsCsv(registry)).toContain('"comma, and ""quote"""')
    expect(gamesCsv(registry).trim().split('\n')).toHaveLength(1)
  })
  it('preserves the old file if atomic writing fails before rename', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'wgtr-atomic-'))
    const path = resolve(directory, 'registry.json')
    await writeFile(path, '{"old":true}\n')
    await expect(
      atomicWriteJson(
        path,
        { old: false },
        {
          beforeRename: () => {
            throw new Error('simulated')
          },
        },
      ),
    ).rejects.toThrow('simulated')
    expect(await readFile(path, 'utf8')).toBe('{"old":true}\n')
    await rm(directory, { recursive: true })
  })
  it('writes manifest hashes and relative filenames', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'wgtr-export-'))
    const result = await exportHumanExperiment({
      registry,
      outputDirectory: directory,
      command: 'test export',
      exportedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(result.manifest).toMatchObject({
      participantCount: 1,
      gameCount: 0,
      validation: { ok: true },
    })
    expect(Object.keys(result.manifest.files)).toEqual([
      'participants.csv',
      'games.csv',
      'summary.json',
    ])
    await rm(directory, { recursive: true })
  })
})
