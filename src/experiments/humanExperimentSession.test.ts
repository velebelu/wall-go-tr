import { describe, expect, it } from 'vitest'
import { sessionContextFromEnvironment } from './humanExperimentSession'

const base = {
  VITE_EXPERIMENT_ID: 'EXP',
  VITE_SESSION_TYPE: 'official',
  VITE_SESSION_ID: 'session-1',
  VITE_PARTICIPANT_ID: 'P01',
  VITE_GAME_NUMBER: '2',
  VITE_HUMAN_COLOR: 'B',
  VITE_AI_COLOR: 'R',
  VITE_GIT_COMMIT: 'a'.repeat(40),
  VITE_IMPLEMENTATION_COMMIT: 'b'.repeat(40),
  VITE_EXPERIMENT_PREPARATION_COMMIT: 'c'.repeat(40),
  VITE_CODE_FREEZE_BINDING_COMMIT: 'd'.repeat(40),
}

describe('human experiment session context', () => {
  it('requires complete official attribution', () => {
    expect(sessionContextFromEnvironment(base)).toMatchObject({
      participantId: 'P01',
      gameNumber: 2,
      humanColor: 'B',
      aiColor: 'R',
      sessionType: 'official',
      implementationCommit: 'b'.repeat(40),
      experimentPreparationCommit: 'c'.repeat(40),
      codeFreezeBindingCommit: 'd'.repeat(40),
    })
  })

  it.each(['VITE_PARTICIPANT_ID', 'VITE_GAME_NUMBER', 'VITE_HUMAN_COLOR'] as const)(
    'rejects an official session without %s',
    (field) =>
      expect(() => sessionContextFromEnvironment({ ...base, [field]: undefined })).toThrow(),
  )

  it('attributes practice without assigning an official game number', () => {
    const context = sessionContextFromEnvironment({
      ...base,
      VITE_SESSION_TYPE: 'practice',
      VITE_GAME_NUMBER: undefined,
    })
    expect(context).toMatchObject({ participantId: 'P01', sessionType: 'practice' })
    expect(context.gameNumber).toBeUndefined()
  })
})
