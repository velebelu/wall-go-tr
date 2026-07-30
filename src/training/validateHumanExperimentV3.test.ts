import { describe, expect, it } from 'vitest'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import type {
  HumanExperimentGame,
  HumanExperimentParticipant,
} from '@/experiments/humanExperimentTypes'
import {
  type HumanExperimentV3State,
  validateHumanExperimentV3State,
} from './validateHumanExperimentV3'

const experimentId = 'WGTR-HUMAN-FINAL-2026-V3'
const implementation = 'd24414802111390f0d4cffc5cb87b0de56932904'

function participant(index: number): HumanExperimentParticipant {
  const participantId = `P0${index}`
  return {
    schema: 'HumanExperimentParticipantV1',
    experimentId,
    participantId,
    experienceGroup: 'experienced',
    previousWallGoGames: index,
    practiceGames: 1,
    colorOrder: index % 2 === 1 ? ['R', 'B'] : ['B', 'R'],
    notes: '',
  }
}

function game(
  participantId = 'P01',
  gameNumber: 1 | 2 = 1,
  gameId = `${participantId}-game-${gameNumber}`,
): HumanExperimentGame {
  const humanColor = participant(Number(participantId.slice(1))).colorOrder[gameNumber - 1]
  const aiColor = humanColor === 'R' ? 'B' : 'R'
  return {
    schema: 'HumanExperimentGameV1',
    experimentId,
    participantId,
    gameId,
    gameNumber,
    humanColor,
    aiColor,
    winner: 'human',
    humanTerritory: 10,
    aiTerritory: 8,
    territoryDiffHuman: 2,
    turnCount: 20,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60_000,
    terminalReason: 'game-result',
    traceId: `trace-${gameId}`,
    tracePath: `participants/${participantId}/traces/game-${gameNumber}.json`,
    traceSha256: 'a'.repeat(64),
    seed: 42,
    effectiveConfig: structuredClone(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG),
    effectiveConfigSha256: 'b'.repeat(64),
    sourceCommit: implementation,
    recordedAt: '2026-01-01T00:02:00.000Z',
    incidents: [],
  }
}

function validState(): HumanExperimentV3State {
  const templates = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => {
      const template = participant(index + 1)
      return [template.participantId, template]
    }),
  )
  const gameFiles = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) =>
      [1, 2].map((gameNumber) => [
        `P0${index + 1}/${gameNumber}`,
        {
          schema: 'HumanExperimentGameInputV1',
          experimentId,
          participantId: `P0${index + 1}`,
          gameNumber,
        },
      ]),
    ).flat(),
  )
  return {
    metadata: {
      schema: 'HumanExperimentMetadataV2',
      experimentId,
      gameCount: 0,
      aiPolicy: {
        securedTerritoryPolicy: false,
        status: 'rejected',
        accepted: false,
        reason: 'negative-counterfactual-effect',
      },
      codeFreeze: {
        status: 'frozen',
        implementationCommit: implementation,
        experimentPreparationCommit: implementation,
      },
    },
    registry: {
      schema: 'HumanExperimentRegistryV1',
      experimentId,
      participants: [],
      games: [],
    },
    templates,
    gameFiles,
    officialTracePaths: [],
    invalidSessions: [],
  }
}

function register(state: HumanExperimentV3State, ...ids: string[]): void {
  state.registry.participants = ids.map((id) =>
    structuredClone(state.templates[id]),
  ) as HumanExperimentParticipant[]
}

function registerGame(state: HumanExperimentV3State, value: HumanExperimentGame): void {
  state.registry.games.push(value)
  state.metadata.gameCount = state.registry.games.length
  state.gameFiles[`${value.participantId}/${value.gameNumber}`] = structuredClone(value)
  state.officialTracePaths.push(value.tracePath)
}

function expectInvalid(state: HumanExperimentV3State, message: string): void {
  expect(() => validateHumanExperimentV3State(state)).toThrow(message)
}

describe('validateHumanExperimentV3State', () => {
  it('accepts the initial V3 state with zero participants', () => {
    expect(() => validateHumanExperimentV3State(validState())).not.toThrow()
  })

  it('accepts P01 registered with zero games', () => {
    const state = validState()
    register(state, 'P01')
    expect(() => validateHumanExperimentV3State(state)).not.toThrow()
  })

  it('accepts multiple valid participants with zero games', () => {
    const state = validState()
    register(state, 'P01', 'P02', 'P03')
    expect(() => validateHumanExperimentV3State(state)).not.toThrow()
  })

  it('accepts P01 with a valid first game and matching trace inventory', () => {
    const state = validState()
    register(state, 'P01')
    registerGame(state, game())
    expect(() => validateHumanExperimentV3State(state)).not.toThrow()
  })

  it('rejects game 2 without game 1', () => {
    const state = validState()
    register(state, 'P01')
    registerGame(state, game('P01', 2))
    expectInvalid(state, 'Game 2 exists without game 1')
  })

  it('rejects an inconsistent metadata gameCount', () => {
    const state = validState()
    state.metadata.gameCount = 1
    expectInvalid(state, 'metadata.gameCount mismatch')
  })

  it('rejects a duplicated participant', () => {
    const state = validState()
    register(state, 'P01', 'P01')
    expectInvalid(state, 'Duplicate')
  })

  it('rejects an incorrect color order', () => {
    const state = validState()
    state.templates.P01 = { ...state.templates.P01, colorOrder: ['B', 'R'] }
    expectInvalid(state, 'Invalid color order')
  })

  it('rejects an official trace without a registered game', () => {
    const state = validState()
    state.officialTracePaths.push('participants/P01/traces/game-1.json')
    expectInvalid(state, 'trace inventory')
  })

  it('accepts an invalid session only in invalid-sessions-v3', () => {
    const state = validState()
    register(state, 'P01')
    state.invalidSessions.push(invalidManifest())
    expect(() => validateHumanExperimentV3State(state)).not.toThrow()
  })

  it('rejects an invalid session introduced into the official sample', () => {
    const state = validState()
    register(state, 'P01')
    state.invalidSessions.push(invalidManifest())
    registerGame(state, game('P01', 1, 'g_6254dc20'))
    expectInvalid(state, 'Invalid session was introduced')
  })

  it('rejects an unknown participant', () => {
    const state = validState()
    const unknown = { ...participant(1), participantId: 'P09' }
    state.registry.participants.push(unknown)
    expectInvalid(state, 'Unknown participant')
  })
})

function invalidManifest() {
  return {
    status: 'quarantined',
    validity: 'invalid-trace-mismatch',
    registration: 'rejected',
    repeatRequired: true,
    gameId: 'g_6254dc20',
    participantId: 'P01',
    intendedGameNumber: 1,
    runtimeCommit: '299246b327a211f002cf2fc4d8fa5b82a1b8f453',
    traceSha256: '5bdcf52057a1f9b3724f49b36ab5a32ff025554fe88bbb2241e8e87499115d33',
    reason: 'first replay divergence at turn 1, state-after',
  }
}
