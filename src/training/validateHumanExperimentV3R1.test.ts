import { describe, expect, it } from 'vitest'
import {
  validateHumanExperimentV3R1Directory,
  validateHumanExperimentV3R1State,
} from './validateHumanExperimentV3R1'

describe('V3-R1 lifecycle', () => {
  it('keeps the live repetition coherent as official registrations accumulate', async () => {
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
    expect(state.registry.games).toContainEqual(
      expect.objectContaining({
        experimentId: 'WGTR-HUMAN-FINAL-2026-V3-R1',
        participantId: 'P01',
        gameNumber: 1,
        humanColor: 'R',
        aiColor: 'B',
        winner: 'human',
        humanTerritory: 39,
        aiTerritory: 9,
        turnCount: 39,
        durationMs: 122646,
        tracePath: 'participants/P01/traces/game-1.json',
      }),
    )
    const registeredTracePaths = state.registry.games.map((game) => game.tracePath).sort()
    expect(state.officialTracePaths.sort()).toEqual(registeredTracePaths)
    expect(new Set(registeredTracePaths).size).toBe(registeredTracePaths.length)
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

  it('accepts an unregistered blank participant fixture', async () => {
    const state = await validateHumanExperimentV3R1Directory()
    const blank = structuredClone(state)
    // El participante debe estar sin registrar y sin partidas: quitar del registro a uno que ya
    // tenga partidas dejaria partidas huerfanas, y el validador las rechaza con razon. Se elige
    // dinamicamente para que el fixture siga siendo valido segun avanza el experimento.
    const blankParticipantId = Object.keys(blank.templates)
      .sort()
      .find(
        (participantId) =>
          !blank.registry.participants.some(
            (participant) => participant.participantId === participantId,
          ) && !blank.registry.games.some((game) => game.participantId === participantId),
      )
    expect(
      blankParticipantId,
      'no queda ningun participante sin registrar y sin partidas',
    ).toBeDefined()

    blank.templates[blankParticipantId!] = {
      ...blank.templates[blankParticipantId!],
      experienceGroup: null,
      previousWallGoGames: null,
      notes: '',
    } as unknown as (typeof blank.templates)[string]

    expect(() => validateHumanExperimentV3R1State(blank)).not.toThrow()
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
