import { registerParticipantFromFiles } from '@/experiments/humanExperimentRegistration'

const experimentDirectory = process.argv[2]
const participantJsonPath = process.argv[3]
if (!experimentDirectory || !participantJsonPath)
  throw new Error(
    'Usage: registerHumanExperimentParticipant <experiment-directory> <participant.json>',
  )
const result = await registerParticipantFromFiles({ experimentDirectory, participantJsonPath })
console.log(`Registered participant ${result.participantId} in ${result.registryPath}`)
