import { validateHumanExperimentV3Directory } from './validateHumanExperimentV3'

const state = await validateHumanExperimentV3Directory(undefined, { bindingMode: 'archive' })

console.log(
  `Valid archived V3 state: ${state.registry.participants.length} registered participants, ` +
    `${state.registry.games.length} registered games, ` +
    `${state.invalidSessions.length} documented invalid sessions. ` +
    'Archive validation does not authorize new V3 sessions.',
)
