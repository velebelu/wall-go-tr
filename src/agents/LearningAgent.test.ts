import { describe, expect, it } from 'vitest'
import { calculateFinalReward } from './LearningAgent'

describe('calculateFinalReward', () => {
  it('combines the game result with the territory difference', () => {
    expect(calculateFinalReward('win', 30, 19)).toBeCloseTo(1 + 11 / 49, 6)
  })

  it('keeps the reward within the expected bounds', () => {
    expect(calculateFinalReward('loss', 10, 39)).toBe(-1.5)
  })
})
