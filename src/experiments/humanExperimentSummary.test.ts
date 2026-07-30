import { describe, expect, it } from 'vitest'
import type { HumanExperimentGame, HumanExperimentParticipant } from './humanExperimentTypes'
import { summarizeHumanExperiment } from './humanExperimentSummary'

const participants = [
  { participantId: 'P1', experienceGroup: 'none' },
  { participantId: 'P2', experienceGroup: 'basic' },
] as HumanExperimentParticipant[]
const games = [
  {
    participantId: 'P1',
    gameNumber: 1,
    humanColor: 'R',
    winner: 'human',
    humanTerritory: 12,
    aiTerritory: 8,
    territoryDiffHuman: 4,
    turnCount: 10,
    durationMs: 100,
  },
  {
    participantId: 'P1',
    gameNumber: 2,
    humanColor: 'B',
    winner: 'ai',
    humanTerritory: 8,
    aiTerritory: 12,
    territoryDiffHuman: -4,
    turnCount: 12,
    durationMs: 200,
  },
  {
    participantId: 'P2',
    gameNumber: 1,
    humanColor: 'B',
    winner: 'draw',
    humanTerritory: 10,
    aiTerritory: 10,
    territoryDiffHuman: 0,
    turnCount: 11,
    durationMs: 300,
  },
] as HumanExperimentGame[]

describe('human experiment summary', () => {
  it('calculates global and grouped descriptive statistics', () => {
    const result = summarizeHumanExperiment(participants, games)
    expect(result).toMatchObject({
      totalGames: 3,
      humanWins: 1,
      aiWins: 1,
      draws: 1,
      meanHumanTerritory: 10,
      meanAiTerritory: 10,
      medianTerritoryDiffHuman: 0,
      meanTurnCount: 11,
      meanDurationMs: 200,
    })
    expect(result.byHumanColor.humanAsRed.games).toBe(1)
    expect(result.byHumanColor.humanAsBlue.games).toBe(2)
    expect(result.byExperience.none.games).toBe(2)
    expect(result.byGameNumber.game2.aiWins).toBe(1)
  })
  it('uses null aggregates for empty groups', () => {
    expect(summarizeHumanExperiment(participants, games).byExperience.experienced).toMatchObject({
      games: 0,
      meanHumanTerritory: null,
      meanAiTerritory: null,
    })
  })
})
