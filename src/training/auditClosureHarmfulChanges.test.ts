import { describe, expect, it } from 'vitest'
import { actionKey, harmfulCompetitiveChanges, pairedMatch } from './auditClosureHarmfulChanges'

describe('closure harmful-change audit helpers', () => {
  it('selects only harmful competitive changes', () => {
    const action = { type: 'wall', pos: { x: 0, y: 0 }, dir: 'top' } as const
    const rows = [
      {
        scope: 'competitive',
        quality: 'harmful',
        gameId: 'a',
        turnIndex: 1,
        player: 'R' as const,
        originalAction: action,
        finalAction: action,
      },
      {
        scope: 'normal',
        quality: 'harmful',
        gameId: 'b',
        turnIndex: 1,
        player: 'R' as const,
        originalAction: action,
        finalAction: action,
      },
    ]
    expect(harmfulCompetitiveChanges(rows)).toEqual([rows[0]])
  })

  it('pairs variants by rival and seed', () => {
    const rows = [
      {
        id: 'closure',
        variant: 'closure' as const,
        seed: 7,
        rival: 'baseline' as const,
        territoryDiff: -2,
        outcome: 'loss',
        winner: 'B',
      },
      {
        id: 'frozen',
        variant: 'frozen' as const,
        seed: 7,
        rival: 'baseline' as const,
        territoryDiff: 3,
        outcome: 'win',
        winner: 'R',
      },
    ]
    expect(pairedMatch(rows, rows[0]!)).toBe(rows[1])
  })

  it('uses canonical JSON action identity', () => {
    const action = { type: 'wall', pos: { x: 1, y: 2 }, dir: 'left' } as const
    expect(actionKey(action)).toBe(JSON.stringify(action))
  })
})
