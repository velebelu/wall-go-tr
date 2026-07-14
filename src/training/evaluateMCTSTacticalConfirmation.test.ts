import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import type { MCTSAggregateMetrics, MCTSGameResult } from './evaluateMCTS'
import {
  buildPairedUtility,
  buildTacticalConfirmationSchedule,
  evaluateMCTSTacticalConfirmation,
  combineDirectTop2Results,
  getDirectOpponentConfig,
  MCTS_TACTICAL_CONFIRMATION_CONFIGS,
  MCTS_TACTICAL_CONFIRMATION_GAMES,
  MCTS_TACTICAL_CONFIRMATION_RIVALS,
  wilson95,
} from './evaluateMCTSTacticalConfirmation'

function resultFixture(overrides: Partial<MCTSGameResult>): MCTSGameResult {
  return {
    config: MCTS_TACTICAL_CONFIRMATION_CONFIGS[0], rival: 'heuristic', colorMCTS: 'R',
    game: 1, seed: 1, winner: 'R', mctsWon: true, tie: false,
    territoryMCTS: 20, territoryRival: 10, territoryDiff: 10, turns: 4,
    durationMs: 100, mctsDecisionTimeMs: 80, mctsDecisions: 2, averageDecisionMs: 40,
    averageRootLegalActions: 4, averageRootExpandedChildren: 3,
    averageMaxDepthReached: 4, averageSelectedDepth: 2,
    averageRootExplorationRatio: 0.75, averageQPriorKnownActions: 0,
    averageQPriorReliableActions: 0, qPriorSelectedActionKnownRate: 0,
    qPriorSelectedActionReliableRate: 0, averageSelectedQPrior: 0,
    mctsActionsLegal: true, tacticalCandidatesChecked: 0,
    tacticalSelectionChanges: 0, tacticalSelectionChangeRate: 0,
    averageVerificationTimeMs: 0, immediateTerminalLossesAvoided: 0,
    ...overrides,
  }
}

describe('evaluateMCTSTacticalConfirmation', () => {
  it('usa exclusivamente baseline y top-2 con la configuracion final intacta', () => {
    expect(MCTS_TACTICAL_CONFIRMATION_CONFIGS.map((config) => config.name))
      .toEqual(['baseline-final', 'tactical-top-2'])
    expect(MCTS_TACTICAL_CONFIRMATION_CONFIGS[0].tacticalVerification).toBe(false)
    expect(MCTS_TACTICAL_CONFIRMATION_CONFIGS[1]).toMatchObject({
      tacticalVerification: true, tacticalCandidateCount: 2,
    })
    for (const config of MCTS_TACTICAL_CONFIRMATION_CONFIGS) {
      const { name: _name, tacticalVerification: _tv, tacticalCandidateCount: _tc, ...fixed } = config
      expect(fixed).toEqual(FINAL_MCTS_CONFIG)
    }
    expect(FINAL_MCTS_CONFIG).not.toHaveProperty('tacticalVerification')
  })

  it('construye 340 partidas con colores exactamente equilibrados y semillas emparejadas', () => {
    const schedule = buildTacticalConfirmationSchedule()
    expect(schedule).toHaveLength(340)
    for (const rival of MCTS_TACTICAL_CONFIRMATION_RIVALS) {
      for (const config of MCTS_TACTICAL_CONFIRMATION_CONFIGS) {
        const rows = schedule.filter((row) => row.rival === rival && row.config.name === config.name)
        expect(rows).toHaveLength(MCTS_TACTICAL_CONFIRMATION_GAMES[rival])
        expect(rows.filter((row) => row.colorMCTS === 'R')).toHaveLength(rows.length / 2)
        expect(rows.filter((row) => row.colorMCTS === 'B')).toHaveLength(rows.length / 2)
      }
      const baselineSeeds = schedule.filter((row) => row.rival === rival && row.config.name === 'baseline-final').map((row) => row.seed)
      const top2Seeds = schedule.filter((row) => row.rival === rival && row.config.name === 'tactical-top-2').map((row) => row.seed)
      expect(top2Seeds).toEqual(baselineSeeds)
    }
  })

  it('alterna realmente las configuraciones en el enfrentamiento directo', () => {
    expect(getDirectOpponentConfig('baseline-final')).toBe(MCTS_TACTICAL_CONFIRMATION_CONFIGS[1])
    expect(getDirectOpponentConfig('tactical-top-2')).toBe(MCTS_TACTICAL_CONFIRMATION_CONFIGS[0])
  })

  it('combina las dos orientaciones del enfrentamiento directo desde la perspectiva top-2', () => {
    const aggregate = (wins: number, losses: number, territory: number) => ({
      games: wins + losses, wins, losses, ties: 0, averageTerritoryDiff: territory,
    } as MCTSAggregateMetrics)
    const result = combineDirectTop2Results([
      { config: 'baseline-final', rival: 'baseline-mcts', aggregate: aggregate(17, 33, -7),
        byColor: { R: aggregate(9, 16, -1), B: aggregate(8, 17, -13) } },
      { config: 'tactical-top-2', rival: 'baseline-mcts', aggregate: aggregate(28, 22, 2.02),
        byColor: { R: aggregate(14, 11, 0.72), B: aggregate(14, 11, 3.32) } },
    ])
    expect(result).toMatchObject({ games: 100, wins: 61, losses: 39, averageTerritoryDiff: 4.51 })
    expect(result?.byColor).toEqual({
      R: { games: 50, wins: 31, losses: 19, ties: 0 },
      B: { games: 50, wins: 30, losses: 20, ties: 0 },
    })
  })

  it('calcula correctamente el IC95 de Wilson', () => {
    expect(wilson95(30, 50)).toEqual({ low: 46.1814, high: 72.3916 })
    expect(wilson95(0, 0)).toEqual({ low: 0, high: 0 })
  })

  it('clasifica beneficios y perjuicios emparejados cuando cambia la accion', () => {
    const baseline = resultFixture({ territoryDiff: -2 })
    const top2 = resultFixture({
      config: MCTS_TACTICAL_CONFIRMATION_CONFIGS[1], territoryDiff: 5,
      tacticalSelectionChanges: 1,
    })
    const utility = buildPairedUtility([baseline, top2])
    expect(utility.changed).toEqual({ pairs: 1, benefits: 1, harms: 0, same: 0, averageTerritoryDelta: 7 })
  })

  it('es determinista en una ejecucion pequena y no modifica el modo jugable', async () => {
    const aDir = mkdtempSync(path.join(os.tmpdir(), 'mcts-tactical-confirm-a-'))
    const bDir = mkdtempSync(path.join(os.tmpdir(), 'mcts-tactical-confirm-b-'))
    const options = {
      configs: MCTS_TACTICAL_CONFIRMATION_CONFIGS,
      rivals: ['heuristic'] as const,
      gamesPerRival: { heuristic: 2 }, maxTurns: 2, progressEvery: 0, createdAt: 'fixed',
    }
    const a = await evaluateMCTSTacticalConfirmation({ ...options, outputDir: aDir })
    const b = await evaluateMCTSTacticalConfirmation({ ...options, outputDir: bDir })
    const stable = (rows: MCTSGameResult[]) => rows.map(({
      durationMs: _d, mctsDecisionTimeMs: _m, averageDecisionMs: _a,
      averageVerificationTimeMs: _v, ...row
    }) => row)
    expect(stable(a.results)).toEqual(stable(b.results))
    expect(FINAL_MCTS_CONFIG).not.toHaveProperty('tacticalVerification')
  }, 120_000)
})
