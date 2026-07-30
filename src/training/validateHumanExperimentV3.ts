import { access, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  CURRENT_HUMAN_EXPERIMENT_DIRECTORY,
  CURRENT_HUMAN_EXPERIMENT_ID,
} from '@/experiments/humanExperimentConfig'
import { readRegistry } from '@/experiments/humanExperimentExport'
import { validateRegistry } from '@/experiments/humanExperimentValidation'

const root = resolve(CURRENT_HUMAN_EXPERIMENT_DIRECTORY)
const registry = await readRegistry(resolve(root, 'registry.json'))
const metadata = JSON.parse(await readFile(resolve(root, 'metadata.json'), 'utf8'))
validateRegistry(registry)

if (registry.experimentId !== CURRENT_HUMAN_EXPERIMENT_ID) fail('registry experimentId mismatch')
if (metadata.experimentId !== CURRENT_HUMAN_EXPERIMENT_ID) fail('metadata experimentId mismatch')
if (registry.participants.length !== 0) fail('V3 must start with 0 registered participants')
if (registry.games.length !== 0 || metadata.gameCount !== 0) fail('V3 must start with 0 games')
if (
  metadata.aiPolicy?.status !== 'rejected' ||
  metadata.aiPolicy?.accepted !== false ||
  metadata.aiPolicy?.reason !== 'negative-counterfactual-effect' ||
  metadata.aiPolicy?.securedTerritoryPolicy !== false
)
  fail('securedTerritoryPolicy rejection metadata mismatch')

const participantDirectories = (await readdir(resolve(root, 'participants'))).sort()
if (participantDirectories.length !== 8) fail('V3 must contain 8 participant templates')
let redGames = 0
let blueGames = 0
for (let index = 0; index < participantDirectories.length; index++) {
  const participantId = `P0${index + 1}`
  if (participantDirectories[index] !== participantId) fail('Unexpected participant template')
  const directory = resolve(root, 'participants', participantId)
  const template = JSON.parse(await readFile(resolve(directory, 'participant.json'), 'utf8'))
  const expected = index % 2 === 0 ? ['R', 'B'] : ['B', 'R']
  if (JSON.stringify(template.colorOrder) !== JSON.stringify(expected))
    fail(`Invalid color order for ${participantId}`)
  if (template.practiceGames !== 1) fail(`Invalid practice count for ${participantId}`)
  redGames += template.colorOrder.filter((color: string) => color === 'R').length
  blueGames += template.colorOrder.filter((color: string) => color === 'B').length
  for (const gameNumber of [1, 2]) {
    await access(resolve(directory, `game-${gameNumber}.json`))
    await access(resolve(directory, 'auxiliary', `game-${gameNumber}`))
  }
  await access(resolve(directory, 'checklist.md'))
  await access(resolve(directory, 'traces'))
}
if (redGames !== 8 || blueGames !== 8) fail('V3 color totals must be 8 R and 8 B')

console.log(
  'Valid V3: 8 templates, 0 registered participants, 0 games, 0 official traces, 8 R and 8 B games, rejected policy disabled, current directory points to V3',
)

function fail(message: string): never {
  throw new Error(message)
}
