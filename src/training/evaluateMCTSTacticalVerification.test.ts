import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import {
  evaluateMCTSTacticalVerification,
  MCTS_TACTICAL_VERIFICATION_CONFIGS,
  MCTS_TACTICAL_VERIFICATION_RIVALS,
  summarizeTacticalVerification,
} from './evaluateMCTSTacticalVerification'
import { buildMCTSEvaluationSchedule } from './evaluateMCTS'

describe('evaluateMCTSTacticalVerification', () => {
  it('define solo las tres configuraciones solicitadas y mantiene intacto el modo jugable', () => {
    expect(
      MCTS_TACTICAL_VERIFICATION_CONFIGS.map((config) => [
        config.name,
        config.tacticalVerification,
        config.tacticalCandidateCount,
      ]),
    ).toEqual([
      ['baseline-final', false, undefined],
      ['tactical-top-2', true, 2],
      ['tactical-top-3', true, 3],
    ])
    const {
      tacticalVerification: _finalTv,
      tacticalCandidateCount: _finalTc,
      ...finalFixed
    } = FINAL_MCTS_CONFIG
    for (const config of MCTS_TACTICAL_VERIFICATION_CONFIGS) {
      const {
        name: _name,
        tacticalVerification: _enabled,
        tacticalCandidateCount: _count,
        ...fixed
      } = config
      expect(fixed).toEqual(finalFixed)
    }
    // La configuración jugable adoptó la variante confirmada tactical-top-2.
    expect(FINAL_MCTS_CONFIG).toMatchObject({
      tacticalVerification: true,
      tacticalCandidateCount: 2,
    })
  })

  it('crea exactamente 90 partidas equilibradas por color', () => {
    const schedule = buildMCTSEvaluationSchedule(
      MCTS_TACTICAL_VERIFICATION_CONFIGS,
      [...MCTS_TACTICAL_VERIFICATION_RIVALS],
      10,
    )
    expect(schedule).toHaveLength(90)
    for (const config of MCTS_TACTICAL_VERIFICATION_CONFIGS) {
      for (const rival of MCTS_TACTICAL_VERIFICATION_RIVALS) {
        const rows = schedule.filter(
          (row) => row.config.name === config.name && row.rival === rival,
        )
        expect(rows.filter((row) => row.colorMCTS === 'R')).toHaveLength(5)
        expect(rows.filter((row) => row.colorMCTS === 'B')).toHaveLength(5)
      }
    }
  })

  it('resume cambios, coste y rendimiento cuando cambia la seleccion', () => {
    const fixture = {
      config: MCTS_TACTICAL_VERIFICATION_CONFIGS[1],
      rival: 'heuristic' as const,
      colorMCTS: 'R' as const,
      game: 1,
      seed: 1,
      winner: 'R' as const,
      mctsWon: true,
      tie: false,
      territoryMCTS: 20,
      territoryRival: 10,
      territoryDiff: 10,
      turns: 4,
      durationMs: 100,
      mctsDecisionTimeMs: 80,
      mctsDecisions: 2,
      averageDecisionMs: 40,
      averageRootLegalActions: 4,
      averageRootExpandedChildren: 3,
      averageMaxDepthReached: 4,
      averageSelectedDepth: 2,
      averageRootExplorationRatio: 0.75,
      averageQPriorKnownActions: 0,
      averageQPriorReliableActions: 0,
      qPriorSelectedActionKnownRate: 0,
      qPriorSelectedActionReliableRate: 0,
      averageSelectedQPrior: 0,
      mctsActionsLegal: true,
      tacticalCandidatesChecked: 4,
      tacticalSelectionChanges: 1,
      tacticalSelectionChangeRate: 0.5,
      averageVerificationTimeMs: 5,
      immediateTerminalLossesAvoided: 1,
    }
    const row = summarizeTacticalVerification([fixture]).find(
      (entry) => entry.config === 'tactical-top-2' && entry.rival === 'heuristic',
    )!
    expect(row.tactical).toMatchObject({
      decisions: 2,
      candidatesChecked: 4,
      selectionChanges: 1,
      selectionChangeRate: 50,
      averageVerificationTimeMs: 5,
      immediateTerminalLossesAvoided: 1,
      winsWhenChanged: 1,
    })
  })

  it('es determinista en una ejecucion minima y no sobrescribe otros resultados', async () => {
    const first = mkdtempSync(path.join(os.tmpdir(), 'mcts-tactical-a-'))
    const second = mkdtempSync(path.join(os.tmpdir(), 'mcts-tactical-b-'))
    const options = {
      gamesPerCombination: 2,
      maxTurns: 2,
      progressEvery: 0,
      configs: MCTS_TACTICAL_VERIFICATION_CONFIGS.slice(0, 2),
      rivals: ['heuristic'] as const,
      createdAt: 'fixed',
    }
    const a = await evaluateMCTSTacticalVerification({ ...options, outputDir: first })
    const b = await evaluateMCTSTacticalVerification({ ...options, outputDir: second })
    expect(
      a.results.map(
        ({
          durationMs: _d,
          mctsDecisionTimeMs: _m,
          averageDecisionMs: _a,
          averageVerificationTimeMs: _v,
          ...row
        }) => row,
      ),
    ).toEqual(
      b.results.map(
        ({
          durationMs: _d,
          mctsDecisionTimeMs: _m,
          averageDecisionMs: _a,
          averageVerificationTimeMs: _v,
          ...row
        }) => row,
      ),
    )
    expect(
      readFileSync(path.join(first, 'mcts_tactical_verification_summary.json'), 'utf8'),
    ).toContain('playableFinalConfigurationReplaced')
  }, 120_000)
})
