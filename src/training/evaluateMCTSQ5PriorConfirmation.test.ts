import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Q5_CHECKPOINT_SHA256, Q5_CHECKPOINT_SOURCE } from '@/agents/Q5LearningAgent'
import { EXPECTED_Q5_CONFIDENCE_STATS, loadFrozenQ5EvaluationResources, type MCTSGameResult } from './evaluateMCTS'
import {
  MCTS_Q5_PRIOR_CONFIRMATION_GAMES,
  buildConfirmationPairs,
  buildQ5PriorConfirmationSchedule,
  evaluateMCTSQ5PriorConfirmation,
  mcnemarExact,
  pairedMeanConfidence95,
  wilson95,
} from './evaluateMCTSQ5PriorConfirmation'

function temp(label: string): string { return mkdtempSync(path.join(os.tmpdir(), `wall-go-confirmation-${label}-`)) }
function clock(): () => number { let value = 0; return () => value++ }

function synthetic(configName: 'baseline' | 'q5-prior-1', params: Partial<MCTSGameResult> = {}): MCTSGameResult {
  return {
    config: { name: configName, simulations: 1, explorationConstant: Math.SQRT2, maxDepth: 1, rolloutPolicy: 'mixed', expansionPolicy: configName === 'baseline' ? 'heuristic' : 'heuristic-q5', qPriorWeight: configName === 'baseline' ? 0 : 1 },
    rival: 'heuristic', colorMCTS: 'R', game: 1, seed: 10, winner: 'R', mctsWon: true, tie: false,
    territoryMCTS: 20, territoryRival: 10, territoryDiff: 10, turns: 2, durationMs: 1,
    mctsDecisionTimeMs: 1, mctsDecisions: 2, averageDecisionMs: 0.5, averageRootLegalActions: 2,
    averageRootExpandedChildren: 1, averageMaxDepthReached: 1, averageSelectedDepth: 1,
    averageRootExplorationRatio: 0.5, averageQPriorKnownActions: 1, averageQPriorReliableActions: 1,
    qPriorSelectedActionKnownRate: 1, qPriorSelectedActionReliableRate: 0.5, averageSelectedQPrior: 0.2,
    mctsActionsLegal: true, mctsActionSignatures: ['a', 'b'], ...params,
  }
}

describe('evaluateMCTSQ5PriorConfirmation', () => {
  it('construye 240 partidas exactas, colores equilibrados y parejas con semilla comun', () => {
    const schedule = buildQ5PriorConfirmationSchedule()
    expect(schedule).toHaveLength(240)
    for (const rival of ['heuristic', 'q5-final', 'random'] as const) {
      const selected = schedule.filter((row) => row.rival === rival)
      expect(selected).toHaveLength(MCTS_Q5_PRIOR_CONFIRMATION_GAMES[rival] * 2)
      for (const color of ['R', 'B'] as const) {
        expect(selected.filter((row) => row.colorMCTS === color)).toHaveLength(MCTS_Q5_PRIOR_CONFIRMATION_GAMES[rival])
      }
    }
    for (const pairId of new Set(schedule.map((row) => row.pairId))) {
      const pair = schedule.filter((row) => row.pairId === pairId)
      expect(pair).toHaveLength(2)
      expect(new Set(pair.map((row) => row.seed)).size).toBe(1)
      expect(new Set(pair.map((row) => row.configName))).toEqual(new Set(['baseline', 'q5-prior-1']))
    }
  })

  it('calcula mejora, empate, empeoramiento y divergencias emparejadas', () => {
    const improved = buildConfirmationPairs([
      synthetic('baseline', { winner: 'B', mctsWon: false, territoryDiff: -2 }),
      synthetic('q5-prior-1', { territoryDiff: 5, mctsActionSignatures: ['x', 'b'] }),
    ])[0]!
    expect(improved).toMatchObject({ resultChange: 'improves', territoryImprovement: 7, initialActionsDiverge: true, divergentDecisions: 1, divergentDecisionPercentage: 50 })
    const same = buildConfirmationPairs([synthetic('baseline'), synthetic('q5-prior-1')])[0]!
    expect(same.resultChange).toBe('same')
    const worse = buildConfirmationPairs([synthetic('baseline'), synthetic('q5-prior-1', { winner: 'B', mctsWon: false })])[0]!
    expect(worse.resultChange).toBe('worsens')
  })

  it('calcula intervalos y McNemar exacto conocidos', () => {
    expect(pairedMeanConfidence95([1, 2, 3])).toEqual({ mean: 2, median: 2, low: 0.8684, high: 3.1316 })
    expect(wilson95(5, 10)).toEqual({ low: 0.2366, high: 0.7634 })
    expect(mcnemarExact(0, 5).pValue).toBe(0.0625)
  })

  it('valida guardas exactas y mantiene Q5 congelada', () => {
    const checkpoint = path.resolve(Q5_CHECKPOINT_SOURCE)
    const before = readFileSync(checkpoint)
    const resources = loadFrozenQ5EvaluationResources()
    expect(resources.confidenceStats).toEqual(EXPECTED_Q5_CONFIDENCE_STATS)
    expect(createHash('sha256').update(readFileSync(checkpoint)).digest('hex')).toBe(Q5_CHECKPOINT_SHA256)
    expect(readFileSync(checkpoint).equals(before)).toBe(true)
  })

  it('es determinista en pequeño, produce acciones legales y no sobrescribe', async () => {
    const checkpoint = readFileSync(path.resolve(Q5_CHECKPOINT_SOURCE))
    const common = { games: { heuristic: 2, 'q5-final': 2, random: 2 }, simulations: 1, maxDepth: 1, maxTurns: 1, progressEvery: 0, createdAt: '2026-07-14T00:00:00.000Z' }
    const first = await evaluateMCTSQ5PriorConfirmation({ ...common, outputDir: temp('a'), now: clock() })
    const secondDir = temp('b')
    const second = await evaluateMCTSQ5PriorConfirmation({ ...common, outputDir: secondDir, now: clock() })
    expect(first.results).toEqual(second.results)
    expect(first.results).toHaveLength(12)
    expect(first.results.every((row) => row.mctsActionsLegal)).toBe(true)
    expect(first.pairs).toHaveLength(6)
    expect(existsSync(path.join(secondDir, 'mcts_q5_prior_confirmation_pairs.csv'))).toBe(true)
    await expect(evaluateMCTSQ5PriorConfirmation({ ...common, outputDir: secondDir })).rejects.toThrow(/output already exists/i)
    expect(readFileSync(path.resolve(Q5_CHECKPOINT_SOURCE)).equals(checkpoint)).toBe(true)
  }, 30_000)
})
