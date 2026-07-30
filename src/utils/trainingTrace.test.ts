import { describe, expect, it } from 'vitest'
import { makeInitialState } from '@/store/gameState'
import { getTrainingTraceActionKey, getTrainingTraceStateKey } from '@/utils/trainingTrace'

describe('training trace serialization', () => {
  it('creates stable state and action keys for equivalent states and actions', () => {
    const initialStateA = makeInitialState()
    const initialStateB = makeInitialState()

    expect(getTrainingTraceStateKey(initialStateA)).toBe(getTrainingTraceStateKey(initialStateB))

    const action = {
      type: 'wall' as const,
      pos: { x: 3, y: 3 },
      dir: 'top' as const,
    }

    expect(getTrainingTraceActionKey(action)).toBe('wall|3|3|top')
  })
})
