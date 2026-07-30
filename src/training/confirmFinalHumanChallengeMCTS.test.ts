import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TOTAL_GAMES,
  aggregateMatches,
  aggregateTimings,
  buildBaselinePairs,
  buildFinalConfirmationPlan,
  classifyFinalCandidate,
  confirmFinalHumanChallengeMCTS,
  loadFinalProgress,
  percentile,
  validateFinalConfirmationPlan,
  type ConfirmationMatch,
  type ConfirmationPlanRow,
} from './confirmFinalHumanChallengeMCTS'

function match(plan: ConfirmationPlanRow): ConfirmationMatch {
  return {
    ...plan,
    outcome: 'win',
    winner: plan.candidateColor,
    territoryCandidate: 20,
    territoryRival: 10,
    territoryDiff: 10,
    decisions: 20,
    terminal: true,
    reachedSafetyLimit: false,
    durationMs: 100,
  }
}

describe('confirmFinalHumanChallengeMCTS', () => {
  it('crea exactamente 150 partidas, balancea colores y empareja baseline', () => {
    const plan = buildFinalConfirmationPlan()
    expect(plan).toHaveLength(TOTAL_GAMES)
    expect(() => validateFinalConfirmationPlan(plan)).not.toThrow()
    expect(
      plan.filter((row) => row.rival === 'heuristic' && row.candidateColor === 'R'),
    ).toHaveLength(50)
    expect(
      plan.filter((row) => row.rival === 'baseline' && row.candidateColor === 'B'),
    ).toHaveLength(25)
    expect(
      new Set(plan.filter((row) => row.rival === 'baseline').map((row) => row.pairSeed)).size,
    ).toBe(25)
  })

  it('calcula percentiles por nearest-rank', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.9)).toBe(5)
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3)
  })

  it('clasifica de forma estable los criterios de adopción', () => {
    const plan = buildFinalConfirmationPlan()
    const heuristic = aggregateMatches(plan.slice(0, 100).map(match))
    const baseline = aggregateMatches(plan.slice(100).map(match))
    const timings = aggregateTimings([
      {
        gameId: 'g',
        rival: 'heuristic',
        seed: 1,
        candidateColor: 'R',
        decisionIndex: 0,
        elapsedMs: 2_000,
        simulations: 250,
        finishedAt250: true,
        expandedTo500: false,
        stoppedByTimeLimit: false,
        tacticalChanged: false,
      },
    ])
    expect(
      classifyFinalCandidate({
        heuristic,
        baseline,
        timings,
        complete: true,
        technicalValid: true,
      }),
    ).toBe('adopt')
    expect(
      classifyFinalCandidate({
        heuristic,
        baseline,
        timings: { ...timings, p95Ms: 5_400 },
        complete: true,
        technicalValid: true,
      }),
    ).toBe('adopt-with-documented-latency')
  })

  it('construye la comparación emparejada reproducible', () => {
    const rows = buildFinalConfirmationPlan().slice(100, 104).map(match)
    const paired = buildBaselinePairs(rows)
    expect(paired.pairs).toHaveLength(2)
    expect(paired.summary.averageTerritoryDiff).toBe(10)
    expect(paired.summary.bootstrapMeanCI95.low).toBe(10)
  })

  it('persiste cada partida, reanuda y no duplica resultados', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'final-confirmation-'))
    const plan = buildFinalConfirmationPlan()
    const calls: string[] = []
    const runGame = async (row: ConfirmationPlanRow) => {
      calls.push(row.id)
      return { match: match(row), timings: [] }
    }
    await confirmFinalHumanChallengeMCTS({ outputDir, plan, runGame, now: () => 100 })
    expect(calls).toHaveLength(150)
    await confirmFinalHumanChallengeMCTS({ outputDir, plan, runGame, now: () => 100 })
    expect(calls).toHaveLength(150)
    expect(loadFinalProgress(outputDir, plan).matches).toHaveLength(150)
  })

  it('conserva persistencia parcial y rechaza duplicados', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'final-confirmation-partial-'))
    const plan = buildFinalConfirmationPlan()
    let stop = false
    await confirmFinalHumanChallengeMCTS({
      outputDir,
      plan,
      runGame: async (row) => ({ match: match(row), timings: [] }),
      now: () => 100,
      onProgress: () => {
        stop = true
      },
      shouldAbort: () => stop,
    })
    const progressPath = path.join(outputDir, 'progress.json')
    expect(JSON.parse(readFileSync(progressPath, 'utf8')).matches).toHaveLength(1)
    const progress = JSON.parse(readFileSync(progressPath, 'utf8'))
    progress.matches.push(progress.matches[0])
    const duplicateDir = mkdtempSync(path.join(tmpdir(), 'final-confirmation-duplicate-'))
    const duplicatePath = path.join(duplicateDir, 'progress.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(duplicatePath, JSON.stringify(progress))
    expect(() => loadFinalProgress(duplicateDir, plan)).toThrow('duplicate')
  })

  it('fija el solucionador como desactivado en metadatos', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'final-confirmation-solver-'))
    let stop = false
    await confirmFinalHumanChallengeMCTS({
      outputDir,
      runGame: async (row) => ({ match: match(row), timings: [] }),
      now: () => 100,
      onProgress: () => {
        stop = true
      },
      shouldAbort: () => stop,
    })
    expect(
      JSON.parse(readFileSync(path.join(outputDir, 'metadata.json'), 'utf8'))
        .candidateSolverEnabled,
    ).toBe(false)
  })
})
