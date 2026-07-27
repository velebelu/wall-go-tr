import { setupHumanExperimentParticipant } from '@/experiments/humanExperimentParticipantSetup'

const [participantId, experienceGroup, previousGamesText, notes] = process.argv.slice(2)
if (!participantId || !experienceGroup || previousGamesText === undefined)
  throw new Error(
    'Usage: setupHumanExperimentParticipant <participantId> <experienceGroup> <previousWallGoGames> [notes]',
  )
const result = await setupHumanExperimentParticipant({
  experimentDirectory: 'data/human-experiment/final-2026',
  participantId,
  experienceGroup,
  previousWallGoGames: Number(previousGamesText),
  notes,
})
const [first, second] = result.participant.colorOrder
console.log(`Participant ${participantId} registered`)
console.log(`Experience: ${result.participant.experienceGroup}`)
console.log(`Previous games: ${result.participant.previousWallGoGames}`)
console.log(`Game 1: human ${first} / AI ${first === 'R' ? 'B' : 'R'}`)
console.log(`Game 2: human ${second} / AI ${second === 'R' ? 'B' : 'R'}`)
console.log(
  `Registry: ${result.registry.participants.length} participants, ${result.registry.games.length} games`,
)
