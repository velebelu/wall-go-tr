import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GameSnapshot } from '@/lib/types'
import {
  analyzeStrategicTempoDecision,
  chooseStrategicProgressTiebreak,
  strategicProgressSignal,
} from './strategicTempoDiagnostics'

const fixturePaths = [
  'trace-2-turn-33.fixture.json',
  'trace-14-turn-39.fixture.json',
  'trace-16-turn-43.fixture.json',
  'trace-30-turn-51.fixture.json',
]

describe('strategic tempo diagnostics', () => {
  it.each(fixturePaths)('classifies %s without changing the frozen decision', async (name) => {
    const fixture = JSON.parse(
      await readFile(
        resolve('data/diagnostics/secured-territory-behaviour/fixtures', name),
        'utf8',
      ),
    )
    const before = JSON.stringify(fixture)
    const result = analyzeStrategicTempoDecision({
      stateBefore: fixture.stateBefore as GameSnapshot,
      stateAfter: fixture.stateAfter as GameSnapshot,
      legalActions: fixture.legalActions,
      action: fixture.action,
      endedGame: fixture.stateAfter.phase === 'finished',
      mcts: fixture.mcts,
    })
    expect(result.suspicious).toBe(true)
    expect(result.classification).toMatch(
      /^(productive|strategic-repositioning|defensive|mobility-improving|future-wall-preparation|redundant|ambiguous)$/,
    )
    expect(result.maxDepthReached).toBeNull()
    expect(result.rolloutOutcomes).toBeNull()
    expect(JSON.stringify(fixture)).toBe(before)
  })

  it('does not label a case redundant without a future window', async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve('data/diagnostics/secured-territory-behaviour/fixtures', fixturePaths[0]),
        'utf8',
      ),
    )
    const result = analyzeStrategicTempoDecision({
      stateBefore: fixture.stateBefore as GameSnapshot,
      stateAfter: fixture.stateAfter as GameSnapshot,
      legalActions: fixture.legalActions,
      action: fixture.action,
      endedGame: false,
      mcts: fixture.mcts,
    })
    expect(result.classification).not.toBe('redundant')
  })

  it('keeps a clearly superior MCTS action outside every conservative tie margin', async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve('data/diagnostics/secured-territory-behaviour/fixtures', fixturePaths[0]),
        'utf8',
      ),
    )
    const state = fixture.stateBefore as GameSnapshot
    const original = fixture.action
    const alternative = fixture.legalActions.find(
      (action: typeof original) => JSON.stringify(action) !== JSON.stringify(original),
    )!
    const candidates = [
      { action: original, visits: 100, value: 0.8 },
      { action: alternative, visits: 20, value: 0.6 },
    ]
    for (const variant of [
      'exact-value',
      'value-0.01',
      'value-0.025',
      'value-0.05',
      'value-0.025-visits-0.15',
      'saturated-equal',
    ] as const) {
      const result = chooseStrategicProgressTiebreak({ state, original, candidates, variant })
      expect(result.changed).toBe(false)
    }
  })

  it('returns a decomposed progress signal without changing the state', async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve('data/diagnostics/secured-territory-behaviour/fixtures', fixturePaths[1]),
        'utf8',
      ),
    )
    const before = JSON.stringify(fixture.stateBefore)
    const signal = strategicProgressSignal(fixture.stateBefore as GameSnapshot, fixture.action)
    expect(signal.orderingKey).toHaveLength(4)
    expect(signal).toHaveProperty('immediateConfirmed')
    expect(signal).toHaveProperty('mobility')
    expect(signal).toHaveProperty('potential')
    expect(JSON.stringify(fixture.stateBefore)).toBe(before)
  })
})
