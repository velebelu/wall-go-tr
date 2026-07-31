import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  validateHumanExperimentV3R1Directory,
  validateHumanExperimentV3R1State,
} from './validateHumanExperimentV3R1'

describe('V3-R1 lifecycle', () => {
  it('starts with no participants, games, traces, or inherited invalid sessions', async () => {
    const state = await validateHumanExperimentV3R1Directory()

    expect(state.metadata.experimentId).toBe('WGTR-HUMAN-FINAL-2026-V3-R1')
    const freeze = state.metadata.codeFreeze
    expect(freeze?.aiImplementationCommit).toBe('d24414802111390f0d4cffc5cb87b0de56932904')
    expect(['prepared', 'frozen']).toContain(freeze?.status)
    if (freeze?.status === 'prepared') {
      expect(freeze.implementationCommit).toBe('PENDING_V3_R1_PREPARATION_COMMIT')
      expect(freeze.experimentPreparationCommit).toBe('PENDING_V3_R1_PREPARATION_COMMIT')
    } else {
      expect(freeze?.implementationCommit).toMatch(/^[0-9a-f]{40}$/)
      expect(freeze?.experimentPreparationCommit).toBe(freeze?.implementationCommit)
    }
    expect(state.registry.participants).toEqual([])
    expect(state.registry.games).toEqual([])
    expect(state.officialTracePaths).toEqual([])
    expect(state.invalidSessions).toEqual([])
  })

  it('accepts only the prepared markers or a coherent frozen commit pair', async () => {
    const state = await validateHumanExperimentV3R1Directory()
    const prepared = structuredClone(state)
    prepared.metadata.codeFreeze = {
      status: 'prepared',
      aiImplementationCommit: 'd24414802111390f0d4cffc5cb87b0de56932904',
      implementationCommit: 'PENDING_V3_R1_PREPARATION_COMMIT',
      experimentPreparationCommit: 'PENDING_V3_R1_PREPARATION_COMMIT',
    }
    expect(() => validateHumanExperimentV3R1State(prepared)).not.toThrow()

    const frozen = structuredClone(prepared)
    frozen.metadata.codeFreeze = {
      ...prepared.metadata.codeFreeze,
      status: 'frozen',
      implementationCommit: 'a'.repeat(40),
      experimentPreparationCommit: 'a'.repeat(40),
    }
    expect(() => validateHumanExperimentV3R1State(frozen)).not.toThrow()

    const incoherent = structuredClone(frozen)
    incoherent.metadata.codeFreeze = {
      ...frozen.metadata.codeFreeze,
      experimentPreparationCommit: 'b'.repeat(40),
    }
    expect(() => validateHumanExperimentV3R1State(incoherent)).toThrow(
      'implementationCommit and experimentPreparationCommit must match',
    )

    const arbitrary = structuredClone(prepared)
    arbitrary.metadata.codeFreeze = { ...prepared.metadata.codeFreeze, status: 'draft' }
    expect(() => validateHumanExperimentV3R1State(arbitrary)).toThrow('neither prepared nor frozen')
  })

  it('allows P01 to be registered again from a blank template', async () => {
    const participant = JSON.parse(
      await readFile(
        resolve('data/human-experiment/final-2026-v3-r1/participants/P01/participant.json'),
        'utf8',
      ),
    )

    expect(participant).toMatchObject({
      experimentId: 'WGTR-HUMAN-FINAL-2026-V3-R1',
      participantId: 'P01',
      experienceGroup: null,
      previousWallGoGames: null,
      colorOrder: ['R', 'B'],
    })
  })

  it('rejects an inherited official result', async () => {
    const state = await validateHumanExperimentV3R1Directory()
    const inherited = structuredClone(state)
    inherited.registry.games.push({
      experimentId: 'WGTR-HUMAN-FINAL-2026-V3',
      participantId: 'P01',
      gameNumber: 1,
    } as never)

    expect(() => validateHumanExperimentV3R1State(inherited)).toThrow()
  })
})
