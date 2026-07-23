import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import { getLegalActions } from '@/utils/ai'
import {
  PLAYABLE_MCTS_BASELINE_CONFIG,
  PLAYABLE_MCTS_EVALUATION_SEED,
  aggregatePlayableMCTSResults,
  buildPlayableMCTSSchedule,
  evaluatePlayableMCTS,
  getPlayableDecisionSeed,
  pairedCsv,
  runPlayableMCTSGame,
  type PlayableMCTSGameResult,
} from './evaluatePlayableMCTS'

const onePairPlan = Object.freeze({
  heuristic: 1,
  random: 1,
  'baseline-mcts': 1,
})

function syntheticResult(overrides: Partial<PlayableMCTSGameResult> = {}): PlayableMCTSGameResult {
  return {
    evaluatorVersion: 'playable-mcts-final-v1',
    gameId: 'heuristic-001-R',
    pairId: 'heuristic-001',
    pairIndex: 0,
    rival: 'heuristic',
    finalColor: 'R',
    scenarioSeed: 941_000,
    subjectBaseSeed: 941_000,
    opponentBaseSeed: 2_655_376_769,
    winner: 'R',
    outcome: 'win',
    territoryRed: 20,
    territoryBlue: 10,
    territoryFinal: 20,
    territoryRival: 10,
    territoryDiff: 10,
    turns: 40,
    reachedTurnLimit: false,
    durationMs: 100,
    mctsDecisions: 10,
    mctsDecisionTimeMs: 50,
    averageDecisionMs: 5,
    allMCTSActionsLegal: true,
    ...overrides,
  }
}

describe('playable MCTS evaluation schedule and protocol', () => {
  it('creates two colors with shared scenario seeds and agent-bound base seeds', () => {
    const schedule = buildPlayableMCTSSchedule(onePairPlan)
    expect(schedule).toHaveLength(6)
    for (let index = 0; index < schedule.length; index += 2) {
      const red = schedule[index]!
      const blue = schedule[index + 1]!
      expect([red.finalColor, blue.finalColor]).toEqual(['R', 'B'])
      expect(blue.scenarioSeed).toBe(red.scenarioSeed)
      expect(blue.subjectBaseSeed).toBe(red.subjectBaseSeed)
      expect(blue.opponentBaseSeed).toBe(red.opponentBaseSeed)
    }
    expect(schedule[0]!.scenarioSeed).toBe(PLAYABLE_MCTS_EVALUATION_SEED)
  })

  it('derives decision seeds as baseSeed + decisionIndex with uint32 wrapping', () => {
    expect(getPlayableDecisionSeed(0x12345678, 0)).toBe(0x12345678)
    expect(getPlayableDecisionSeed(0x12345678, 2)).toBe(0x1234567a)
    expect(getPlayableDecisionSeed(0xffffffff, 1)).toBe(0)
  })

  it('freezes a baseline differing only in tacticalVerification and keeps Q5 disabled', () => {
    expect(PLAYABLE_MCTS_BASELINE_CONFIG).toEqual({
      ...FINAL_MCTS_CONFIG,
      tacticalVerification: false,
    })
    expect(PLAYABLE_MCTS_BASELINE_CONFIG.qPriorWeight).toBe(0)
    expect(FINAL_MCTS_CONFIG.qPriorWeight).toBe(0)
    expect(FINAL_MCTS_CONFIG.tacticalCandidateCount).toBe(2)
  })

  it('delegates every MCTS action and restarts the decision counter for each game', async () => {
    const item = buildPlayableMCTSSchedule(onePairPlan)[2]!
    const seeds: number[] = []
    const chooseMCTS = vi.fn(
      (
        request: Parameters<
          typeof import('@/agents/mctsWorkerDecision').choosePlayableMCTSAction
        >[0],
      ) => {
        seeds.push(request.seed)
        expect(request).not.toHaveProperty('qPriorSource')
        return getLegalActions({
          ...request.gameState,
          legal: new Set(request.gameState.legal),
        })[0]!
      },
    )
    await runPlayableMCTSGame(item, { chooseMCTS, maxTurns: 4 })
    await runPlayableMCTSGame(item, { chooseMCTS, maxTurns: 4 })
    expect(chooseMCTS).toHaveBeenCalled()
    const firstGameCalls = seeds.length / 2
    expect(seeds[firstGameCalls]).toBe(seeds[0])
    expect(seeds[0]).toBe(item.subjectBaseSeed)
  })

  it('rejects an illegal MCTS action with complete diagnostics', async () => {
    const item = buildPlayableMCTSSchedule(onePairPlan)[0]!
    await expect(
      runPlayableMCTSGame(item, {
        maxTurns: 1,
        chooseMCTS: () => ({ type: 'place', pos: { x: -1, y: -1 } }),
      }),
    ).rejects.toThrow(/rival=heuristic.*game=heuristic-001-R.*seed=941000.*agent=final.*decision=0/)
  })
})

describe('playable MCTS metrics and output protection', () => {
  it('serializes 250 valid results as 125 complete red-blue pairs', () => {
    const results = buildPlayableMCTSSchedule().map((item) =>
      syntheticResult({
        ...item,
        gameId: item.gameId,
        finalColor: item.finalColor,
        territoryDiff: item.finalColor === 'R' ? 3 : -2,
      }),
    )
    const csv = pairedCsv(results)
    const lines = csv.split('\n')
    expect(results).toHaveLength(250)
    expect(new Set(results.map((row) => row.pairId)).size).toBe(125)
    expect(lines).toHaveLength(126)
    for (const pairId of new Set(results.map((row) => row.pairId))) {
      const pair = results.filter((row) => row.pairId === pairId)
      expect(pair.map((row) => row.finalColor).sort()).toEqual(['B', 'R'])
    }
  })

  it('rejects incomplete and duplicated color pairs', () => {
    const red = syntheticResult()
    const blue = syntheticResult({
      gameId: 'heuristic-001-B',
      finalColor: 'B',
      winner: 'B',
    })
    expect(() => pairedCsv([red])).toThrow(/Incomplete color pair/)
    expect(() => pairedCsv([red, red])).toThrow(/Duplicate color/)
    expect(() => pairedCsv([red, blue, blue])).toThrow(/Duplicate color pair/)
  })

  it('aggregates outcomes, territories, timings and Wilson with ties as non-wins', () => {
    const aggregate = aggregatePlayableMCTSResults([
      syntheticResult(),
      syntheticResult({
        gameId: 'heuristic-001-B',
        finalColor: 'B',
        winner: 'tie',
        outcome: 'tie',
        territoryFinal: 15,
        territoryRival: 15,
        territoryDiff: 0,
        turns: 60,
        mctsDecisions: 20,
        mctsDecisionTimeMs: 150,
      }),
    ])
    expect(aggregate).toMatchObject({
      games: 2,
      wins: 1,
      losses: 0,
      ties: 1,
      winRate: 50,
      averageTerritoryFinal: 17.5,
      averageTerritoryRival: 12.5,
      averageTerritoryDiff: 5,
      averageTurns: 50,
      averageDecisionMs: 6.6667,
      mctsActions: 30,
      illegalMCTSActions: 0,
    })
    expect(aggregate.winRateCI95).toEqual({ low: 9.4531, high: 90.5469 })
  })

  it('refuses to overwrite a non-empty output directory', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'playable-mcts-protection-'))
    try {
      writeFileSync(path.join(outputDir, 'existing.txt'), 'keep', 'utf8')
      await expect(
        evaluatePlayableMCTS({
          outputDir,
          plan: onePairPlan,
          maxTurns: 0,
          chooseMCTS: () => {
            throw new Error('should not run')
          },
        }),
      ).rejects.toThrow(/already exists and is not empty/)
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('completes the six-game smoke schedule with legal MCTS actions in a temporary directory', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'playable-mcts-test-smoke-'))
    try {
      const evaluation = await evaluatePlayableMCTS({
        smoke: true,
        outputDir,
        maxTurns: 2,
        overwrite: true,
        chooseMCTS: (request) =>
          getLegalActions({
            ...request.gameState,
            legal: new Set(request.gameState.legal),
          })[0]!,
      })
      expect(evaluation.results).toHaveLength(6)
      expect(evaluation.results.every((row) => row.allMCTSActionsLegal)).toBe(true)
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })
})
