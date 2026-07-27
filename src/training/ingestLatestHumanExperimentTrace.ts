import { ingestLatestHumanExperimentTrace } from '@/experiments/humanExperimentIngestion'

const [participantId, gameNumberText, explicitTracePath] = process.argv.slice(2)
if (!participantId || !gameNumberText)
  throw new Error(
    'Usage: ingestLatestHumanExperimentTrace <participantId> <gameNumber> [explicitTracePath]',
  )
const result = await ingestLatestHumanExperimentTrace({
  experimentDirectory: 'data/human-experiment/final-2026',
  participantId,
  gameNumber: Number(gameNumberText),
  explicitTracePath,
})
console.log(`${result.participantId} game ${result.gameNumber} registered`)
console.log(`Source: ${result.source}`)
console.log(`Destination: ${result.destination}`)
console.log(`Human: ${result.humanColor}`)
console.log(`AI: ${result.aiColor}`)
console.log(`Winner: ${result.winner}`)
console.log(`Territory: ${result.humanTerritory}-${result.aiTerritory}`)
console.log(`Turns: ${result.turnCount}`)
console.log(`Duration: ${result.durationMs} ms`)
console.log(`Registry: ${result.participantCount} participants, ${result.gameCount} games`)
console.log('Validation: OK')
