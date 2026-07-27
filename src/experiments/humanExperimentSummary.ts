import type {
  ExperienceGroup,
  HumanExperimentGame,
  HumanExperimentParticipant,
} from './humanExperimentTypes'

interface Aggregate {
  games: number
  humanWins: number
  aiWins: number
  draws: number
  meanHumanTerritory: number | null
  meanAiTerritory: number | null
  meanTerritoryDiffHuman: number | null
}

export function summarizeHumanExperiment(
  participants: HumanExperimentParticipant[],
  games: HumanExperimentGame[],
) {
  const global = aggregate(games)
  const diffs = games.map((game) => game.territoryDiffHuman).sort((a, b) => a - b)
  return {
    totalGames: games.length,
    humanWins: global.humanWins,
    aiWins: global.aiWins,
    draws: global.draws,
    humanWinRate: rate(global.humanWins, games.length),
    aiWinRate: rate(global.aiWins, games.length),
    meanHumanTerritory: global.meanHumanTerritory,
    meanAiTerritory: global.meanAiTerritory,
    meanTerritoryDiffHuman: global.meanTerritoryDiffHuman,
    medianTerritoryDiffHuman: median(diffs),
    meanTurnCount: mean(games.map((game) => game.turnCount)),
    meanDurationMs: mean(games.map((game) => game.durationMs)),
    byHumanColor: {
      humanAsRed: aggregate(games.filter((game) => game.humanColor === 'R')),
      humanAsBlue: aggregate(games.filter((game) => game.humanColor === 'B')),
    },
    byExperience: Object.fromEntries(
      (['none', 'basic', 'experienced'] satisfies ExperienceGroup[]).map((group) => {
        const ids = new Set(
          participants
            .filter((participant) => participant.experienceGroup === group)
            .map((p) => p.participantId),
        )
        return [group, aggregate(games.filter((game) => ids.has(game.participantId)))]
      }),
    ),
    byGameNumber: {
      game1: aggregate(games.filter((game) => game.gameNumber === 1)),
      game2: aggregate(games.filter((game) => game.gameNumber === 2)),
    },
  }
}

function aggregate(games: HumanExperimentGame[]): Aggregate {
  return {
    games: games.length,
    humanWins: games.filter((game) => game.winner === 'human').length,
    aiWins: games.filter((game) => game.winner === 'ai').length,
    draws: games.filter((game) => game.winner === 'draw').length,
    meanHumanTerritory: mean(games.map((game) => game.humanTerritory)),
    meanAiTerritory: mean(games.map((game) => game.aiTerritory)),
    meanTerritoryDiffHuman: mean(games.map((game) => game.territoryDiffHuman)),
  }
}
function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}
function rate(count: number, total: number): number | null {
  return total ? count / total : null
}
function median(values: number[]): number | null {
  if (!values.length) return null
  const middle = Math.floor(values.length / 2)
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
}
