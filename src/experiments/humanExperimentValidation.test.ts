import { describe, expect, it } from 'vitest'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import type { HumanMCTSTraceV1 } from '@/utils/humanMCTSTrace'
import { canonicalStringify, sha256Canonical } from './humanExperimentCanonical'
import { HumanExperimentError } from './humanExperimentErrors'
import type { HumanExperimentGameInput, HumanExperimentParticipant } from './humanExperimentTypes'
import {
  addGame,
  addParticipant,
  deriveGameFromTrace,
  emptyRegistry,
  validateParticipant,
} from './humanExperimentValidation'

const participant: HumanExperimentParticipant = {
  schema: 'HumanExperimentParticipantV1',
  experimentId: 'PILOT',
  participantId: 'PILOT-001',
  experienceGroup: 'basic',
  previousWallGoGames: 2,
  practiceGames: 1,
  colorOrder: ['R', 'B'],
}

function trace(humanColor: 'R' | 'B' = 'R'): HumanMCTSTraceV1 {
  const aiColor = humanColor === 'R' ? 'B' : 'R'
  const state = {
    board: [],
    turn: humanColor,
    legal: [],
    stepsTaken: 0,
    phase: 'finished',
    players: ['R', 'B'],
    stonesLimit: 4,
    stonesPlaced: { R: 2, B: 2 },
    result: { finished: true, winner: humanColor, score: { R: 12, B: 8 } },
  } as unknown as HumanMCTSTraceV1['metadata']['initialState']
  return {
    schema: 'HumanMCTSTraceV1',
    schemaVersion: 1,
    metadata: {
      gameId: 'historical',
      createdAt: '2026-01-01T10:00:00.000Z',
      startedAt: '2026-01-01T10:00:00.000Z',
      finishedAt: '2026-01-01T10:01:00.000Z',
      durationMs: 60_000,
      projectCommit: 'abcdef123456',
      boardSize: 0,
      humanColor,
      mctsColor: aiColor,
      seed: 42,
      mctsConfig: structuredClone(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts),
      finalHumanChallengeConfig: structuredClone(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG),
      initialState: state,
    },
    decisions: [],
    final: {
      state,
      result: { finished: true, winner: humanColor, score: { R: 12, B: 8 } },
      territory: { R: 12, B: 8 },
      totalTurns: 0,
      finishReason: 'game-result',
    },
  }
}

function input(gameNumber: 1 | 2 = 1): HumanExperimentGameInput {
  return {
    schema: 'HumanExperimentGameInputV1',
    experimentId: 'PILOT',
    participantId: 'PILOT-001',
    gameNumber,
    gameId: `game-${gameNumber}`,
    traceId: `trace-${gameNumber}`,
    sourceCommit: 'abcdef123456',
    recordedAt: '2026-01-01T10:02:00.000Z',
  }
}

describe('participant validation', () => {
  it('accepts a valid pseudonymous participant', () =>
    expect(() => validateParticipant(participant)).not.toThrow())
  it.each([
    [{ ...participant, participantId: '' }, 'participantId'],
    [{ ...participant, previousWallGoGames: -1 }, 'non-negative'],
    [{ ...participant, colorOrder: ['R', 'R'] }, 'colorOrder'],
    [{ ...participant, participantId: 'person@example.com' }, 'pseudonym'],
  ])('rejects invalid participant data', (value, message) =>
    expect(() => validateParticipant(value as HumanExperimentParticipant)).toThrow(message),
  )
  it('rejects duplicate IDs', () => {
    const registry = addParticipant(emptyRegistry('PILOT'), participant)
    expect(() => addParticipant(registry, participant)).toThrow('Duplicate')
  })
})

describe('canonical hashing', () => {
  it('ignores object key order and preserves array order', async () => {
    expect(canonicalStringify({ b: 2, a: [1, 2] })).toBe(canonicalStringify({ a: [1, 2], b: 2 }))
    expect(await sha256Canonical({ a: [1, 2] })).not.toBe(await sha256Canonical({ a: [2, 1] }))
  })
  it('changes for a real configuration change', async () => {
    const changed = structuredClone(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG)
    changed.budget.base++
    expect(await sha256Canonical(changed)).not.toBe(
      await sha256Canonical(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG),
    )
  })
})

describe('game derivation and registry validation', () => {
  it('derives trusted fields and accepts two opposite colors', async () => {
    let registry = addParticipant(emptyRegistry('PILOT'), participant)
    const first = await deriveGameFromTrace({
      registry,
      input: input(1),
      traceJson: JSON.stringify(trace('R')),
      tracePath: 'traces/one.json',
    })
    expect(first).toMatchObject({
      humanColor: 'R',
      aiColor: 'B',
      winner: 'human',
      durationMs: 60_000,
    })
    registry = addGame(registry, first)
    const secondTrace = trace('B')
    secondTrace.final!.result.winner = 'B'
    const second = await deriveGameFromTrace({
      registry,
      input: input(2),
      traceJson: JSON.stringify(secondTrace),
      tracePath: 'traces/two.json',
    })
    registry = addGame(registry, second)
    expect(registry.games).toHaveLength(2)
    expect(() =>
      addGame(registry, { ...second, gameId: 'third', traceId: 'third', tracePath: 'third' }),
    ).toThrow('two games')
  })

  it.each([
    ['missing participant', { participantId: 'UNKNOWN' }, trace('R'), 'Participant'],
    ['wrong color', {}, trace('B'), 'color order'],
    ['missing commit', { sourceCommit: '' }, trace('R'), 'sourceCommit'],
    ['bad duration', { durationMs: 1 }, trace('R'), 'durationMs'],
    ['bad trace hash', { traceSha256: 'bad' }, trace('R'), 'SHA-256'],
  ])('rejects %s', async (_label, patch, value, message) => {
    const registry = addParticipant(emptyRegistry('PILOT'), participant)
    await expect(
      deriveGameFromTrace({
        registry,
        input: { ...input(1), ...patch },
        traceJson: JSON.stringify(value),
        tracePath: 'traces/test.json',
      }),
    ).rejects.toThrow(message)
  })

  it('rejects altered final configuration', async () => {
    const changed = trace('R')
    changed.metadata.finalHumanChallengeConfig!.budget.base++
    await expect(
      deriveGameFromTrace({
        registry: addParticipant(emptyRegistry('PILOT'), participant),
        input: input(1),
        traceJson: JSON.stringify(changed),
        tracePath: 'traces/test.json',
      }),
    ).rejects.toThrow('configuration')
  })

  it('rejects duplicate game, trace, path, hash, and game number', async () => {
    let registry = addParticipant(emptyRegistry('PILOT'), participant)
    const game = await deriveGameFromTrace({
      registry,
      input: input(1),
      traceJson: JSON.stringify(trace()),
      tracePath: 'traces/test.json',
    })
    registry = addGame(registry, game)
    const otherIds = { gameId: 'x', traceId: 'x', tracePath: 'x' }
    expect(() => addGame(registry, game)).toThrow('Duplicate gameId')
    expect(() => addGame(registry, { ...game, gameId: 'x' })).toThrow('Duplicate traceId')
    expect(() => addGame(registry, { ...game, gameId: 'x', traceId: 'x' })).toThrow('Trace path')
    // Identificadores todos distintos, mismo contenido: el registro sigue rechazándolo.
    expect(() => addGame(registry, { ...game, ...otherIds })).toThrow('Duplicate traceSha256')
    expect(() => addGame(registry, { ...game, ...otherIds, traceSha256: 'f'.repeat(64) })).toThrow(
      'Duplicate gameNumber',
    )
  })

  it('classifies duplicate registrations as ALREADY_REGISTERED', async () => {
    let registry = addParticipant(emptyRegistry('PILOT'), participant)
    const game = await deriveGameFromTrace({
      registry,
      input: input(1),
      traceJson: JSON.stringify(trace()),
      tracePath: 'traces/test.json',
    })
    registry = addGame(registry, game)
    try {
      addGame(registry, { ...game, gameId: 'x', traceId: 'x', tracePath: 'x' })
      expect.unreachable('the duplicated trace should have been rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(HumanExperimentError)
      expect((error as HumanExperimentError).code).toBe('ALREADY_REGISTERED')
      expect((error as HumanExperimentError).retry).toBe('final')
    }
  })
})
