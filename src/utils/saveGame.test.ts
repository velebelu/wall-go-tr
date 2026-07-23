import { describe, expect, it, vi } from 'vitest'
import {
  buildGameResultCsv,
  buildMCTSGameTraceCsv,
  saveFinishedGameArtifacts,
  validateCompleteMCTSGameTrace,
  type MCTSGameTurnTrace,
  type SaveGamePayload,
} from './saveGame'

describe('CSV game diagnostics', () => {
  const payload: SaveGamePayload = {
    id_partida: 'g_test',
    fecha: '2026-07-23T00:00:00.000Z',
    tipo_partida: 'ia_mcts_final',
    jugador_rojo: 'ia_mcts_final',
    jugador_azul: 'humano',
    ganador: 'rojo',
    turnos: 1,
    territorio_rojo: 30,
    territorio_azul: 19,
    muros_colocados: 8,
    observaciones: 'test',
  }

  const trace: MCTSGameTurnTrace[] = [
    {
      decisionNumber: 0,
      phase: 'playing',
      activePlayer: 'R',
      aiColor: 'R',
      actorType: 'mcts',
      actionType: 'move',
      hasWall: true,
      toX: 2,
      toY: 1,
      territoryRedBefore: 4,
      territoryBlueBefore: 4,
      territoryRedAfter: 5,
      territoryBlueAfter: 4,
      legalActionCount: 12,
      decisionMs: 350,
      baseSeed: 123,
      decisionIndex: 0,
      decisionSeed: 123,
    },
  ]

  it('exports a game result with column names and one data row', () => {
    const csv = buildGameResultCsv(payload)
    const lines = csv.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(
      'id_partida,fecha,tipo_partida,jugador_rojo,jugador_azul,ganador,turnos,' +
        'territorio_rojo,territorio_azul,muros_colocados,observaciones',
    )
  })

  it('exports the complete per-turn MCTS diagnostic schema', () => {
    const csv = buildMCTSGameTraceCsv(trace)
    expect(csv.split('\n')).toHaveLength(2)
    expect(csv).toContain('decisionNumber,phase,activePlayer,aiColor,actorType,actionType,hasWall')
    expect(csv).toContain(
      'territoryRedBefore,territoryBlueBefore,territoryRedAfter,territoryBlueAfter',
    )
    expect(csv).toContain('baseSeed,decisionIndex,decisionSeed')
  })

  it('saves the final MCTS trace once with the same game id as the result', () => {
    const saveResult = vi.fn(() => ({ saved: true as const }))
    const saveTrace = vi.fn(() => ({
      status: 'download_requested' as const,
      fileName: 'traza_partida_mcts_g_test.csv',
      rowCount: 1,
    }))

    saveFinishedGameArtifacts(payload, 'mcts-final', trace, { saveResult, saveTrace })

    expect(saveResult).toHaveBeenCalledOnce()
    expect(saveResult).toHaveBeenCalledWith(payload)
    expect(saveTrace).toHaveBeenCalledOnce()
    expect(saveTrace).toHaveBeenCalledWith(payload.id_partida, trace)
    expect(saveTrace.mock.results[0]?.value.fileName).toBe(
      `traza_partida_mcts_${payload.id_partida}.csv`,
    )
  })

  it('rejects duplicate turns, multiple base seeds and non-consecutive decision indexes', () => {
    const multipleSeeds = [
      trace[0]!,
      { ...trace[0]!, decisionNumber: 1, baseSeed: 999, decisionIndex: 1 },
    ]
    expect(() => validateCompleteMCTSGameTrace(multipleSeeds, 2)).toThrow('única semilla base')

    const duplicateDecision = [trace[0]!, { ...trace[0]!, decisionNumber: 1, decisionIndex: 0 }]
    expect(() => validateCompleteMCTSGameTrace(duplicateDecision, 2)).toThrow(
      'decisionIndex no consecutivo',
    )

    const duplicateTurn = [trace[0]!, { ...trace[0]!, decisionIndex: 1 }]
    expect(() => validateCompleteMCTSGameTrace(duplicateTurn, 2)).toThrow(
      'Decisión duplicada o no consecutiva',
    )
    expect(() => validateCompleteMCTSGameTrace(trace, 2)).toThrow('Traza incompleta')
  })

  it('keeps human rows explicit and without MCTS diagnostics', () => {
    const completeTrace: MCTSGameTurnTrace[] = [
      trace[0]!,
      {
        ...trace[0]!,
        decisionNumber: 1,
        activePlayer: 'B',
        actorType: 'human',
        baseSeed: undefined,
        decisionIndex: undefined,
        decisionSeed: undefined,
      },
    ]
    expect(() => validateCompleteMCTSGameTrace(completeTrace, 2)).not.toThrow()
    expect(buildMCTSGameTraceCsv(completeTrace).split('\n')).toHaveLength(3)
  })
})
