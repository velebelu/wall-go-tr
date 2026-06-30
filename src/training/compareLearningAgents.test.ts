import { describe, expect, it } from 'vitest'
import {
  calculateMetricsBlock,
  calculateWins,
  groupResultsByBlocksOf10,
  summarizeExperiment,
  type GameComparisonResult,
} from './compareLearningAgents'

function makeResult(
  game: number,
  winner: GameComparisonResult['winner'],
  territoryR: number,
  territoryB: number,
  turns: number,
): GameComparisonResult {
  return {
    experiment: 'test',
    game,
    players: { R: 'learning-empty', B: 'random' },
    winner,
    wins: { R: winner === 'R' ? 1 : 0, B: winner === 'B' ? 1 : 0 },
    territory: { R: territoryR, B: territoryB },
    territoryDiff: territoryR - territoryB,
    turns,
  }
}

describe('calculateWins', () => {
  it('counts red, blue and tied games', () => {
    expect(
      calculateWins([
        makeResult(1, 'R', 20, 10, 12),
        makeResult(2, 'B', 12, 18, 14),
        makeResult(3, 'tie', 15, 15, 16),
      ]),
    ).toEqual({ R: 1, B: 1, tie: 1 })
  })
})

describe('calculateMetricsBlock', () => {
  it('calculates averages and win rates', () => {
    const metrics = calculateMetricsBlock(
      [makeResult(1, 'R', 20, 10, 12), makeResult(2, 'R', 30, 15, 18)],
      1,
    )

    expect(metrics.games).toBe(2)
    expect(metrics.winRates).toEqual({ R: 100, B: 0, tie: 0 })
    expect(metrics.averageTerritory).toEqual({ R: 25, B: 12.5 })
    expect(metrics.averageTerritoryDiff).toBe(12.5)
    expect(metrics.averageTurns).toBe(15)
  })
})

describe('groupResultsByBlocksOf10', () => {
  it('groups results into blocks of at most 10 games', () => {
    const results = Array.from({ length: 23 }, (_, index) =>
      makeResult(index + 1, index % 2 === 0 ? 'R' : 'B', 20, 10, 10 + index),
    )

    const blocks = groupResultsByBlocksOf10(results)

    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ block: 1, fromGame: 1, toGame: 10, games: 10 })
    expect(blocks[1]).toMatchObject({ block: 2, fromGame: 11, toGame: 20, games: 10 })
    expect(blocks[2]).toMatchObject({ block: 3, fromGame: 21, toGame: 23, games: 3 })
  })
})

describe('summarizeExperiment', () => {
  it('includes required experiment summary fields', () => {
    const summary = summarizeExperiment(
      'test',
      { R: 'learning-pretrained', B: 'heuristic' },
      [makeResult(1, 'B', 10, 25, 20)],
      42,
    )

    expect(summary).toMatchObject({
      name: 'test',
      games: 1,
      players: { R: 'learning-pretrained', B: 'heuristic' },
      wins: { R: 0, B: 1, tie: 0 },
      pretrainedQTableEntries: 42,
    })
    expect(summary.blocksOf10).toHaveLength(1)
  })
})
