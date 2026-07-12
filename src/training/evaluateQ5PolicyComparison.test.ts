import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Q5_POLICY_COMPARISON_POLICIES,
  buildQ5PolicyComparisonPairings,
  evaluateQ5PolicyComparison,
} from './evaluateQ5PolicyComparison'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q5-policy-comparison-'))
}

function countPairings(pairings: ReturnType<typeof buildQ5PolicyComparisonPairings>) {
  return {
    random: pairings.filter((pairing) => pairing.rival === 'random').length,
    heuristic: pairings.filter((pairing) => pairing.rival === 'heuristic').length,
    R: pairings.filter((pairing) => pairing.colorQ5 === 'R').length,
    B: pairings.filter((pairing) => pairing.colorQ5 === 'B').length,
    random_R: pairings.filter((pairing) => pairing.rival === 'random' && pairing.colorQ5 === 'R')
      .length,
    random_B: pairings.filter((pairing) => pairing.rival === 'random' && pairing.colorQ5 === 'B')
      .length,
    heuristic_R: pairings.filter(
      (pairing) => pairing.rival === 'heuristic' && pairing.colorQ5 === 'R',
    ).length,
    heuristic_B: pairings.filter(
      (pairing) => pairing.rival === 'heuristic' && pairing.colorQ5 === 'B',
    ).length,
  }
}

describe('evaluateQ5PolicyComparison', () => {
  it('defines the three requested frozen policies', () => {
    expect(Q5_POLICY_COMPARISON_POLICIES).toEqual([
      { id: 'E', label: 'minConfidence10_margin0.50', minConfidence: 10, minMargin: 0.5 },
      { id: 'D', label: 'minConfidence5_margin0.50', minConfidence: 5, minMargin: 0.5 },
      { id: 'C', label: 'minConfidence5_margin0.25', minConfidence: 5, minMargin: 0.25 },
    ])
  })

  it('builds 1000 games per rival with balanced colors', () => {
    const pairings = buildQ5PolicyComparisonPairings()

    expect(pairings).toHaveLength(2000)
    expect(countPairings(pairings)).toEqual({
      random: 1000,
      heuristic: 1000,
      R: 1000,
      B: 1000,
      random_R: 500,
      random_B: 500,
      heuristic_R: 500,
      heuristic_B: 500,
    })
  })

  it('uses deterministic pairings that can be shared unchanged by every policy', () => {
    const first = buildQ5PolicyComparisonPairings(10, 900000)
    const second = buildQ5PolicyComparisonPairings(10, 900000)

    expect(first).toEqual(second)
    expect(new Set(first.map((pairing) => pairing.seed)).size).toBe(first.length)
  })

  it('runs with epsilon 0, learning disabled, frozen Q-table, and writes the three output files', async () => {
    const tempDir = makeTempDir()
    const qTablePath = path.join(tempDir, 'qtable.json')
    const outputDir = path.join(tempDir, 'policy_comparison')
    writeFileSync(qTablePath, '{}\n', 'utf8')
    const before = readFileSync(qTablePath, 'utf8')

    const result = await evaluateQ5PolicyComparison({
      qTablePath,
      outputDir,
      gamesPerRival: 4,
      seedBase: 910000,
      qUpdateLogPath: [],
    })
    const after = readFileSync(qTablePath, 'utf8')
    const summary = result.summary as {
      protocol: {
        epsilon: number
        learnsDuringEvaluation: boolean
        qTableFrozen: boolean
        alphaUpdates: boolean
        gamesPerRival: number
        gamesPerColor: number
      }
      qTableChangedDuringEvaluation: boolean
      policies: Array<{ aggregate: { games: number }; byRival: Record<string, { games: number }> }>
    }

    expect(before).toBe(after)
    expect(summary.qTableChangedDuringEvaluation).toBe(false)
    expect(summary.protocol.epsilon).toBe(0)
    expect(summary.protocol.learnsDuringEvaluation).toBe(false)
    expect(summary.protocol.qTableFrozen).toBe(true)
    expect(summary.protocol.alphaUpdates).toBe(false)
    expect(summary.protocol.gamesPerRival).toBe(4)
    expect(summary.protocol.gamesPerColor).toBe(2)
    expect(result.results).toHaveLength(24)
    for (const policy of summary.policies) {
      expect(policy.aggregate.games).toBe(8)
      expect(policy.byRival.random.games).toBe(4)
      expect(policy.byRival.heuristic.games).toBe(4)
    }
    expect(existsSync(path.join(outputDir, 'policy_comparison_summary.json'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'policy_comparison_results.csv'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'policy_comparison_detailed.json'))).toBe(true)
  }, 20000)
})
