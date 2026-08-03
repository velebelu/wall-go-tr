import { describe, expect, it } from 'vitest'
import {
  validateHumanExperimentV3R1Directory,
  validateHumanExperimentV3R1State,
  type HumanExperimentV3R1State,
} from './validateHumanExperimentV3R1'

/**
 * Devuelve una copia en memoria del estado en la que un participante vuelve a la situación
 * previa a su registro: carpeta y plantillas creadas, datos demográficos todavía sin rellenar,
 * plantillas de partida vacías y ninguna partida ni traza en el registro.
 *
 * Se construye siempre, en lugar de buscar un participante que casualmente siga sin registrar,
 * porque el experimento oficial ya está completo con sus ocho participantes y sus dieciséis
 * partidas. Nada de esto toca el disco: `data/human-experiment/final-2026-v3-r1` permanece
 * intacto.
 */
function withBlankUnregisteredParticipant(
  state: HumanExperimentV3R1State,
  participantId: string,
): HumanExperimentV3R1State {
  const blank = structuredClone(state)

  blank.templates[participantId] = {
    ...blank.templates[participantId],
    experienceGroup: null,
    previousWallGoGames: null,
    notes: '',
  } as unknown as (typeof blank.templates)[string]

  // Hay que quitar al participante y sus partidas a la vez: dejar partidas sin su participante
  // deja huérfanas en el registro y el validador las rechaza, con razón.
  blank.registry.participants = blank.registry.participants.filter(
    (participant) => participant.participantId !== participantId,
  )
  blank.registry.games = blank.registry.games.filter((game) => game.participantId !== participantId)
  blank.metadata.gameCount = blank.registry.games.length

  // El inventario de trazas debe coincidir exactamente con el registro.
  const tracePrefix = `participants/${participantId}/traces/`
  blank.officialTracePaths = blank.officialTracePaths.filter(
    (path) => !path.startsWith(tracePrefix),
  )

  // Plantilla de partida vacía, con la misma forma que genera la preparación de una sesión.
  for (const gameNumber of [1, 2])
    blank.gameFiles[`${participantId}/${gameNumber}`] = {
      schema: 'HumanExperimentGameInputV1',
      experimentId: blank.metadata.experimentId,
      participantId,
      gameNumber,
      incidents: [],
    }

  return blank
}

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
    // El último identificador de plantilla: elección determinista que no depende de cuántos
    // participantes estén registrados en este momento. Se indexa en vez de usar `at`, que
    // exige la biblioteca ES2022 y este proyecto compila contra ES2020.
    const templateIds = Object.keys(state.templates).sort()
    const participantId = templateIds[templateIds.length - 1]
    expect(participantId, 'el experimento debe tener plantillas de participante').toBeDefined()

    const blank = withBlankUnregisteredParticipant(state, participantId!)

    // El fixture es de verdad un participante preparado y todavía sin registrar.
    expect(blank.registry.participants.some((row) => row.participantId === participantId)).toBe(
      false,
    )
    expect(blank.registry.games.some((game) => game.participantId === participantId)).toBe(false)
    expect(blank.officialTracePaths.some((path) => path.includes(`/${participantId}/`))).toBe(false)
    expect(blank.templates[participantId!]).toMatchObject({
      participantId,
      experienceGroup: null,
      previousWallGoGames: null,
    })

    expect(() => validateHumanExperimentV3R1State(blank)).not.toThrow()

    // El estado real del disco sigue intacto y sigue validando.
    expect(state.registry.participants.some((row) => row.participantId === participantId)).toBe(
      true,
    )
    expect(() => validateHumanExperimentV3R1State(state)).not.toThrow()
  })

  it('still rejects a participant removed from the registry while keeping its games', async () => {
    const state = await validateHumanExperimentV3R1Directory()
    const templateIds = Object.keys(state.templates).sort()
    const participantId = templateIds[templateIds.length - 1]!
    const orphaned = withBlankUnregisteredParticipant(state, participantId)
    // Se devuelven las partidas sin devolver al participante: el registro queda incoherente.
    orphaned.registry.games = structuredClone(state.registry.games)
    orphaned.metadata.gameCount = orphaned.registry.games.length
    orphaned.gameFiles = structuredClone(state.gameFiles)
    orphaned.officialTracePaths = [...state.officialTracePaths]

    expect(() => validateHumanExperimentV3R1State(orphaned)).toThrow()
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
