import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Q5_1000_VS_1500_POLICIES,
  Q5_CONSERVATIVE_ALPHA_COMPARISON_POLICIES,
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

  it('defines the two requested Q5-1000 vs Q5-1500 policies', () => {
    expect(Q5_1000_VS_1500_POLICIES).toEqual([
      { id: 'E', label: 'minConfidence10_margin0.50', minConfidence: 10, minMargin: 0.5 },
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
      gamesPerRival: 2,
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
      combinations: Array<{
        table: string
        aggregate: { games: number }
        byRival: Record<string, { games: number }>
      }>
    }

    expect(before).toBe(after)
    expect(summary.qTableChangedDuringEvaluation).toBe(false)
    expect(summary.protocol.epsilon).toBe(0)
    expect(summary.protocol.learnsDuringEvaluation).toBe(false)
    expect(summary.protocol.qTableFrozen).toBe(true)
    expect(summary.protocol.alphaUpdates).toBe(false)
    expect(summary.protocol.gamesPerRival).toBe(2)
    expect(summary.protocol.gamesPerColor).toBe(1)
    expect(result.results).toHaveLength(12)
    for (const combination of summary.combinations) {
      expect(combination.aggregate.games).toBe(4)
      expect(combination.byRival.random.games).toBe(2)
      expect(combination.byRival.heuristic.games).toBe(2)
    }
    expect(existsSync(path.join(outputDir, 'policy_comparison_summary.json'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'policy_comparison_results.csv'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'policy_comparison_detailed.json'))).toBe(true)
  }, 60000)

  it('compares two frozen tables across two policies with shared pairings and custom output names', async () => {
    const tempDir = makeTempDir()
    const qTablePathA = path.join(tempDir, 'qtable_a.json')
    const qTablePathB = path.join(tempDir, 'qtable_b.json')
    const outputDir = path.join(tempDir, 'q5_1000_vs_1500')
    writeFileSync(qTablePathA, '{}\n', 'utf8')
    writeFileSync(qTablePathB, '{}\n', 'utf8')

    const result = await evaluateQ5PolicyComparison({
      outputDir,
      outputFilePrefix: 'q5_1000_vs_1500',
      gamesPerRival: 2,
      seedBase: 920000,
      policies: Q5_1000_VS_1500_POLICIES,
      tableConfigs: [
        { label: 'q5_1000', qTablePath: qTablePathA, qUpdateLogPath: [] },
        { label: 'q5_1500', qTablePath: qTablePathB, qUpdateLogPath: [] },
      ],
    })
    const summary = result.summary as {
      qTableChangedDuringEvaluation: boolean
      qTables: Array<{ label: string; qTableChangedDuringEvaluation: boolean }>
      combinations: Array<{ table: string; policy: { label: string }; aggregate: { games: number } }>
    }

    expect(summary.qTableChangedDuringEvaluation).toBe(false)
    expect(summary.qTables.map((table) => table.label)).toEqual(['q5_1000', 'q5_1500'])
    expect(summary.qTables.every((table) => table.qTableChangedDuringEvaluation === false)).toBe(true)
    expect(result.results).toHaveLength(16)
    expect(summary.combinations).toHaveLength(4)
    for (const combination of summary.combinations) {
      expect(combination.aggregate.games).toBe(4)
    }
    const seedsByCombination = new Map<string, string>()
    for (const table of ['q5_1000', 'q5_1500']) {
      for (const policy of Q5_1000_VS_1500_POLICIES) {
        const seeds = result.results
          .filter((row) => row.table === table && row.policy === policy.label)
          .map((row) => row.seed)
          .join(',')
        seedsByCombination.set(`${table}:${policy.label}`, seeds)
      }
    }
    expect(new Set(seedsByCombination.values()).size).toBe(1)
    expect(existsSync(path.join(outputDir, 'q5_1000_vs_1500_summary.json'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'q5_1000_vs_1500_results.csv'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'q5_1000_vs_1500_detailed.json'))).toBe(true)
  }, 60000)

  it('compares three frozen tables with the conservative alpha policy and requested output names', async () => {
    const tempDir = makeTempDir()
    const qTablePath1000 = path.join(tempDir, 'qtable_1000.json')
    const qTablePath1500 = path.join(tempDir, 'qtable_1500.json')
    const qTablePathConservative = path.join(tempDir, 'qtable_1500_conservative.json')
    const outputDir = path.join(tempDir, 'conservative_alpha')
    writeFileSync(qTablePath1000, '{}\n', 'utf8')
    writeFileSync(qTablePath1500, '{}\n', 'utf8')
    writeFileSync(qTablePathConservative, '{}\n', 'utf8')

    const result = await evaluateQ5PolicyComparison({
      outputDir,
      outputFilePrefix: 'conservative_alpha_comparison',
      gamesPerRival: 2,
      seedBase: 902000,
      policies: Q5_CONSERVATIVE_ALPHA_COMPARISON_POLICIES,
      tableConfigs: [
        { label: 'q5_1000', qTablePath: qTablePath1000, qUpdateLogPath: [] },
        { label: 'q5_1500', qTablePath: qTablePath1500, qUpdateLogPath: [] },
        { label: 'q5_1500_conservative_alpha', qTablePath: qTablePathConservative, qUpdateLogPath: [] },
      ],
    })
    const summary = result.summary as {
      qTableChangedDuringEvaluation: boolean
      qTables: Array<{ label: string; qTableChangedDuringEvaluation: boolean }>
      combinations: Array<{ table: string; policy: { label: string }; aggregate: { games: number } }>
    }

    expect(summary.qTableChangedDuringEvaluation).toBe(false)
    expect(summary.qTables.map((table) => table.label)).toEqual([
      'q5_1000',
      'q5_1500',
      'q5_1500_conservative_alpha',
    ])
    expect(summary.qTables.every((table) => table.qTableChangedDuringEvaluation === false)).toBe(true)
    expect(result.results).toHaveLength(12)
    expect(summary.combinations).toHaveLength(3)
    for (const combination of summary.combinations) {
      expect(combination.policy.label).toBe('minConfidence5_margin0.25')
      expect(combination.aggregate.games).toBe(4)
    }
    const seedsByTable = new Map<string, string>()
    for (const table of ['q5_1000', 'q5_1500', 'q5_1500_conservative_alpha']) {
      const seeds = result.results
        .filter((row) => row.table === table)
        .map((row) => row.seed)
        .join(',')
      seedsByTable.set(table, seeds)
    }
    expect(new Set(seedsByTable.values()).size).toBe(1)
    expect(existsSync(path.join(outputDir, 'conservative_alpha_comparison_summary.json'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'conservative_alpha_comparison_results.csv'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'conservative_alpha_comparison_detailed.json'))).toBe(true)
  }, 60000)
})
