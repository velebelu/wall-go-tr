import { describe, expect, it, vi } from 'vitest'
import { applyRecordedPlayerAction } from './atomicPlayerTransition'
import { makeInitialState } from '@/store/gameState'
import type { PlayerAction } from '@/lib/types'
import {
  captureTransitionMismatch,
  prepareTransitionMismatchArtifact,
  verifyCommittedTransition,
} from './humanExperimentTransitionDiagnostics'
import { createHumanMCTSTrace } from '@/utils/humanMCTSTrace'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'

function trace() {
  const initialState = makeInitialState()
  return createHumanMCTSTrace({
    experimentId: 'WGTR-HUMAN-FINAL-2026-V3',
    participantId: 'P01',
    gameNumber: 2,
    sessionType: 'official',
    sessionId: 'diagnostic-session',
    projectCommit: 'a'.repeat(40),
    implementationCommit: 'b'.repeat(40),
    experimentPreparationCommit: 'b'.repeat(40),
    codeFreezeBindingCommit: 'c'.repeat(40),
    humanColor: 'B',
    mctsColor: 'R',
    seed: 7,
    mctsConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
    finalHumanChallengeConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
    initialState,
  })
}

describe('transition mismatch diagnostics', () => {
  it('captures all essential values synchronously and identifies the divergent field', async () => {
    const stateBefore = makeInitialState()
    const action: PlayerAction = { type: 'place', pos: { x: 0, y: 0 } }
    const expectedState = applyRecordedPlayerAction(stateBefore, action)
    const committedState = structuredClone(expectedState)
    committedState.legal = new Set(expectedState.legal)
    committedState.turn = 'R'
    const sourceTrace = trace()

    const captured = captureTransitionMismatch({
      stateBefore,
      action,
      expectedState,
      committedState,
      trace: sourceTrace,
      capturedAt: '2026-07-30T00:00:00.000Z',
    })
    stateBefore.board[0][0].stone = 'B'
    action.pos.x = 6
    committedState.turn = 'B'
    sourceTrace.metadata.sessionId = 'mutated'

    expect(captured).toMatchObject({
      sessionId: 'diagnostic-session',
      participantId: 'P01',
      gameNumber: 2,
      turnNumber: 0,
      activePlayer: 'R',
      action: { type: 'place', pos: { x: 0, y: 0 } },
    })
    expect(captured.stateBefore.board[0][0].stone).toBe(null)
    expect(captured.expectedState).toBeDefined()
    expect(captured.committedState).toBeDefined()
    expect(captured.fieldDiff).toEqual([{ path: 'turn', expected: 'B', committed: 'R' }])

    const prepared = await prepareTransitionMismatchArtifact(captured)
    expect(prepared.artifact).toMatchObject({
      schema: 'HumanExperimentTransitionMismatchV1',
      official: false,
      registrationAllowed: false,
      error: 'committed-state-mismatch',
      validity: 'invalid',
    })
    expect(prepared.artifact.artifactHashes.mismatchPayloadSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(prepared.artifact.artifactHashes.partialTraceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(prepared.artifact.artifactHashes.proposedManifestSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('throws immediately while persistence remains pending', () => {
    const state = makeInitialState()
    const persist = vi.fn(() => new Promise<void>(() => undefined))

    expect(() =>
      verifyCommittedTransition(
        {
          stateBefore: state,
          action: { type: 'place', pos: { x: 0, y: 0 } },
          expectedState: applyRecordedPlayerAction(state, {
            type: 'place',
            pos: { x: 0, y: 0 },
          }),
          committedState: state,
          trace: trace(),
        },
        persist,
      ),
    ).toThrow('Official session stopped: the committed state does not match the engine transition.')
    expect(persist).toHaveBeenCalledOnce()
  })

  it('keeps the original error when persistence rejects and only logs the failure', async () => {
    const state = makeInitialState()
    const failure = new Error('download blocked')
    const persist = vi.fn(async () => {
      throw failure
    })
    const logger = { error: vi.fn() }

    expect(() =>
      verifyCommittedTransition(
        {
          stateBefore: state,
          action: { type: 'place', pos: { x: 0, y: 0 } },
          expectedState: applyRecordedPlayerAction(state, {
            type: 'place',
            pos: { x: 0, y: 0 },
          }),
          committedState: state,
          trace: trace(),
        },
        persist,
        logger,
      ),
    ).toThrow('Official session stopped: the committed state does not match the engine transition.')
    await Promise.resolve()
    expect(logger.error).toHaveBeenCalledWith(
      '[Game] No se pudo persistir el diagnóstico de transición:',
      failure,
    )
  })

  it('does nothing when the expected and committed snapshots coincide', () => {
    const before = makeInitialState()
    const expected = applyRecordedPlayerAction(before, {
      type: 'place',
      pos: { x: 1, y: 1 },
    })
    const committed = structuredClone(expected)
    committed.legal = new Set(expected.legal)
    const persist = vi.fn()
    const onDecision = vi.fn()
    const mcts = { getAction: vi.fn() }
    const applyAction = vi.fn(() => committed)

    const applied = applyAction()
    verifyCommittedTransition(
      {
        stateBefore: before,
        action: { type: 'place', pos: { x: 1, y: 1 } },
        expectedState: expected,
        committedState: applied,
        trace: trace(),
      },
      persist,
    )
    onDecision({ stateAfter: applied })

    expect(persist).not.toHaveBeenCalled()
    expect(applyAction).toHaveBeenCalledOnce()
    expect(onDecision).toHaveBeenCalledOnce()
    expect(mcts.getAction).not.toHaveBeenCalled()
    expect(committed).toEqual(expected)
  })
})
